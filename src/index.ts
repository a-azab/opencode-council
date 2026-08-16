import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, basename } from "node:path"
import { execFileSync } from "node:child_process"
import { z } from "zod"
import { runReview, runFix } from "./engine.ts"
import { renderReport, renderSummary, renderPatches } from "./report.ts"

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

export const CouncilPlugin = async (input: any) => ({
  tool: {
    council: {
      description:
        "Multi-model code review: fans out across role x model, debates disputed findings " +
        "to a computed fixed point, verifies each one with independent skeptics that did " +
        "not raise it, and aggregates deterministically. mode:'fix' turns the last " +
        "review's findings into patches for you to review. Use /check for a fast pass.",
      args: {
        mode: z
          .enum(["review", "fix"])
          .default("review")
          .describe("review = the full graph; fix = propose patches for the last review's findings"),
        base: z.string().default("HEAD").describe("git ref to diff against (HEAD, main, a sha)"),
      },
      async execute(args: { mode?: "review" | "fix"; base?: string }, context: any) {
        const t0 = Date.now()
        const cwd = context?.directory ?? input?.directory ?? process.cwd()
        const base = args?.base ?? "HEAD"
        const { diff, files, changedLines } = gitDiff(cwd, base)
        if (!diff.trim()) return `Nothing to do - no diff against ${base}.`

        const user = process.env.OPENCODE_SERVER_USERNAME
        const pass = process.env.OPENCODE_SERVER_PASSWORD
        const ctx = {
          serverUrl: String(input?.serverUrl ?? "http://127.0.0.1:4096"),
          auth: user && pass ? "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") : undefined,
        }
        const root = join(cwd, "council-artifacts")

        if (args?.mode === "fix") {
          const prev = existsSync(root)
            ? readdirSync(root)
                .filter((d) => existsSync(join(root, d, "findings.json")))
                .sort()
                .pop()
            : undefined
          if (!prev) return "No previous review found. Run council() first."
          const dir = join(root, prev)
          const kept = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8")).kept ?? []
          if (!kept.length) return `Nothing to fix - the last review kept no findings (${dir}).`

          const patches = await runFix(ctx, { findings: kept, diff })
          const out = join(dir, "patches.md")
          writeFileSync(out, renderPatches(patches))
          const ready = patches.filter((p) => p.state === "ok" && p.confident && p.patch.trim()).length
          const stuck = patches.length - ready
          return [
            `${ready} patch(es) ready, ${stuck} need a decision. NOTHING HAS BEEN APPLIED.`,
            `Review then apply what you accept: ${out}`,
          ].join("\n")
        }

        const review = await runReview(ctx, { diff, files, changedLines })
        const dir = join(root, new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19))
        mkdirSync(dir, { recursive: true })
        const reportPath = join(dir, "report.md")
        writeFileSync(reportPath, renderReport(review, { files, ms: Date.now() - t0 }))
        writeFileSync(join(dir, "findings.json"), JSON.stringify(review, null, 2))
        return renderSummary(review, reportPath)
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
