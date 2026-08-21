import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, basename } from "node:path"
import { execFileSync } from "node:child_process"
import { z } from "zod"
import { runReview, runFix, runPlan, runIndependent } from "./engine.ts"
import { renderReport, renderSummary, renderPatches, renderPlan, renderTakesIndex } from "./report.ts"

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Flat `key: value` frontmatter only.
 * ponytail: nested YAML would need a real parser dependency; nothing here needs it.
 * Agent permissions are set in code (AGENT_DEFAULTS) precisely so the files stay flat.
 * If a field ever genuinely needs nesting, add the dependency then, not now.
 */
function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!m) return { data: {}, body: raw }
  const data: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":")
    if (i === -1 || line.trimStart().startsWith("#")) continue
    data[line.slice(0, i).trim()] = line
      .slice(i + 1)
      .trim()
      .replace(/^["']|["']$/g, "")
  }
  return { data, body: raw.slice(m[0].length) }
}

function readMarkdownDir(dir: string): Array<{ name: string; data: Record<string, string>; body: string }> {
  const path = join(PKG, dir)
  if (!existsSync(path)) return []
  return readdirSync(path)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({
      name: basename(f, ".md"),
      ...parseFrontmatter(readFileSync(join(path, f), "utf8")),
    }))
}

/**
 * Role agents must be `mode: all`, never `subagent`.
 * Measured: `opencode run --agent <subagent>` prints a warning, falls back to `build`,
 * and still exits 0 — you would get a review from the wrong agent and never know.
 */
const AGENT_DEFAULTS = {
  mode: "all" as const,
  // Council roles analyse and propose patches as text. They never touch the workspace;
  // the only writer is `git apply`, run by the human after the gate. (D5)
  permission: { edit: "deny", bash: "deny" } as Record<string, string>,
}

function gitDiff(cwd: string, base: string) {
  const run = (args: string[]) => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    } catch {
      return ""
    }
  }
  const diff = run(["diff", base])
  return {
    diff,
    files: run(["diff", "--name-only", base]).split("\n").filter(Boolean),
    changedLines: diff.split("\n").filter((l) => /^[+-][^+-]/.test(l)).length,
  }
}

function artifactDir(cwd: string, kind: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const dir = join(cwd, "council-artifacts", `${stamp}-${kind}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

export const CouncilPlugin = async (input: any) => ({
  tool: {
    council: {
      description:
        "Multi-model code work: fans out across role x model, debates disputed findings to a " +
        "computed fixed point, verifies with independent models, and aggregates " +
        "deterministically. mode:'review' reviews a diff, mode:'fix' turns the last review's " +
        "findings into independently-verified patches, mode:'plan' runs a proposal-and-score " +
        "vote on a goal. Use /check for a fast inline pass instead.",
      args: {
        mode: z
          .enum(["review", "fix", "plan", "independent"])
          .default("review")
          .describe("review = the graph; fix = verified patches; plan = proposal vote on a goal"),
        base: z.string().default("HEAD").describe("git ref to diff against (review/fix only)"),
        goal: z.string().default("").describe("what to plan (plan mode only)"),
      },
      async execute(
        args: { mode?: "review" | "fix" | "plan" | "independent"; base?: string; goal?: string },
        context: any,
      ) {
        const t0 = Date.now()
        const cwd = context?.directory ?? input?.directory ?? process.cwd()
        const user = process.env.OPENCODE_SERVER_USERNAME
        const pass = process.env.OPENCODE_SERVER_PASSWORD
        const ctx = {
          serverUrl: String(input?.serverUrl ?? "http://127.0.0.1:4096"),
          auth: user && pass ? "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") : undefined,
        }

        // Planning has no diff, so it must resolve before the diff guard below.
        if (args?.mode === "plan") {
          const goal = (args.goal ?? "").trim()
          if (!goal) return "No goal given. `plan` needs one — five models guessing at different problems is not a vote."
          const plan = await runPlan(ctx, { goal })
          const dir = artifactDir(cwd, "plan")
          const path = join(dir, "plan.md")
          writeFileSync(path, renderPlan(plan))
          writeFileSync(join(dir, "plan.json"), JSON.stringify(plan, null, 2))
          const head = plan.winner
            ? `winner: ${plan.winner.proposal} (${plan.winner.mean.toFixed(2)})`
            : plan.tied.length > 1
              ? `no winner — ${plan.tied.map((t) => t.proposal).join(" and ")} are within the tie margin, your call`
              : "no usable proposals"
          return [
            `${plan.proposals.filter((p) => p.state === "ok").length} proposals · ${plan.scores.length} cross-scores`,
            head,
            plan.dropped.length ? `${plan.dropped.length} lane(s) missing — comparison is incomplete` : "",
            ``,
            `Full plan: ${path}`,
          ]
            .filter(Boolean)
            .join("\n")
        }

        // Independent mode answers a task, not a diff, so it runs before the diff guard.
        if (args?.mode === "independent") {
          if (!args?.goal?.trim())
            return "mode:'independent' needs a `goal` — what should each model answer?"
          const takes = await runIndependent(ctx, { task: args.goal })
          const dir = artifactDir(cwd, "independent")
          for (const t of takes.filter((x) => x.state === "ok"))
            writeFileSync(join(dir, `${t.slug}.md`), `# ${t.slug} (${t.model})\n\n${t.response}\n`)
          const index = join(dir, "index.md")
          writeFileSync(index, renderTakesIndex(takes, args.goal))
          const ok = takes.filter((t) => t.state === "ok").length
          return [
            `${ok}/${takes.length} models answered independently. Nothing was merged.`,
            `Takes: ${dir}`,
            `Index: ${index}`,
          ].join("\n")
        }

        const base = args?.base ?? "HEAD"
        const { diff, files, changedLines } = gitDiff(cwd, base)
        if (!diff.trim()) return `Nothing to do — no diff against ${base}.`

        if (args?.mode === "fix") {
          // Patch the findings the user actually read. Running a fresh review here would
          // produce a DIFFERENT set - reviews are nondeterministic, models time out - so
          // the report they approved and the patches they get back would not correspond.
          // It also pays for a second full review nobody asked for.
          const root = join(cwd, "council-artifacts")
          const prev = existsSync(root)
            ? readdirSync(root)
                .filter((d) => existsSync(join(root, d, "findings.json")))
                .sort()
                .pop()
            : undefined
          if (!prev) return "No previous review found. Run council({ mode: 'review' }) first."
          const kept = JSON.parse(readFileSync(join(root, prev, "findings.json"), "utf8")).kept ?? []
          if (!kept.length) return `The last review (${prev}) kept no findings — nothing to fix.`

          const patches = await runFix(ctx, { findings: kept, diff, cwd })
          const dir = artifactDir(cwd, "fix")
          const path = join(dir, "patches.md")
          writeFileSync(path, renderPatches(patches))
          writeFileSync(join(dir, "patches.json"), JSON.stringify(patches, null, 2))
          const verified = patches.filter((p) => p.verified).length
          const unresolved = patches.filter((p) => p.state === "unresolved").length
          return [
            `${verified}/${patches.length} patches independently verified` +
              (unresolved ? ` · ${unresolved} still unresolved after retries` : ""),
            `Nothing applied. Review and apply what you accept.`,
            ``,
            `Patches: ${path}`,
            `From review: ${prev}`,
          ].join("\n")
        }

        const review = await runReview(ctx, { diff, files, changedLines })
        const dir = artifactDir(cwd, "review")
        const path = join(dir, "report.md")
        writeFileSync(path, renderReport(review, { files, ms: Date.now() - t0 }))
        writeFileSync(join(dir, "findings.json"), JSON.stringify(review, null, 2))
        return renderSummary(review, path)
      },
    },
  },

  config: async (config: any) => {
    // Keep council() out of task-tool subagents. Sessions the engine creates itself carry
    // their own deny list (engine.ts) because self-created children inherit nothing.
    config.experimental ??= {}
    config.experimental.primary_tools = [
      ...new Set([...(config.experimental.primary_tools ?? []), "council"]),
    ]

    config.command ??= {}
    for (const { name, data, body } of readMarkdownDir("command")) {
      config.command[name] = {
        description: data.description ?? `council: ${name}`,
        template: body,
        ...(data.agent ? { agent: data.agent } : {}),
        ...(data.model ? { model: data.model } : {}),
      }
    }

    config.agent ??= {}
    for (const { name, data, body } of readMarkdownDir("agent")) {
      config.agent[name] = {
        ...AGENT_DEFAULTS,
        description: data.description ?? `council role: ${name}`,
        prompt: body,
      }
    }
  },
})

export default CouncilPlugin
