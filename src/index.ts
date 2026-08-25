import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, basename } from "node:path"
import { execFileSync } from "node:child_process"
import { z } from "zod"
import { runReview, runFix, runPlan, runIndependent, councilArgs } from "./engine.ts"
import { localMcpServers } from "./mcp.ts"
import {
  resolveScope,
  proposeInit,
  renderInitProposal,
  applyInit,
  readCrewConfig,
  readInstructions,
  runIntake,
  renderGate,
  runExecute,
  renderRun,
  trackerFor,
  availableTrackers,
  listWorktrees,
  renderWorktrees,
  type CrewConfig,
} from "./crew.ts"
import { type Role } from "./roster.ts"
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
  //
  // The crew implementer is the one exception and it opts in explicitly via `tools:` in
  // its frontmatter. That is safe only because its session is pinned to a worktree
  // (`directory` on AskOpts) - the grant applies there, never to the user's checkout.
  // Deny stays the default so a new agent file is read-only unless it says otherwise.
  permission: { edit: "deny", bash: "deny" } as Record<string, string>,
}

/** `tools: edit, bash` in an agent file's frontmatter, as a permission map. */
function permissionsFor(tools?: string): Record<string, string> {
  const granted = new Set((tools ?? "").split(",").map((t) => t.trim()).filter(Boolean))
  return {
    edit: granted.has("edit") ? "allow" : "deny",
    bash: granted.has("bash") ? "allow" : "deny",
  }
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

/** Where the engine sends model calls, and how it authenticates if the server wants it. */
function ctxFor(input: any) {
  const user = process.env.OPENCODE_SERVER_USERNAME
  const pass = process.env.OPENCODE_SERVER_PASSWORD
  return {
    serverUrl: String(input?.serverUrl ?? "http://127.0.0.1:4096"),
    auth: user && pass ? "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") : undefined,
  }
}

/**
 * Artifacts belong to the repo, not to wherever the session happens to be standing.
 *
 * Using the session cwd meant `/crew:plan` run from `apps/api/` wrote its plan somewhere `run`
 * would never look, and — worse — that any directory the user happened to be in became a
 * place plans could be read from.
 */
function artifactRoot(repoRoot: string): string {
  return join(repoRoot, "council-artifacts")
}

function artifactDir(repoRoot: string, kind: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const dir = join(artifactRoot(repoRoot), `${stamp}-${kind}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * The most recent artifact of a kind, by the timestamp WE wrote into its name.
 *
 * `.sort().pop()` over every directory name was the bug: it took the lexicographic maximum
 * of arbitrary strings, so a committed or hand-made `council-artifacts/zzz/plan.json` won
 * over every real run — and `run` executes that plan with the implementer's edit+bash
 * grant. Restricting to our own `<stamp>-<kind>` shape means only something this tool
 * wrote can be selected.
 */
function latestArtifact(repoRoot: string, kind: string, file: string): { dir: string; path: string } | null {
  const root = artifactRoot(repoRoot)
  if (!existsSync(root)) return null
  const shape = new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-${kind}$`)
  const dir = readdirSync(root)
    .filter((d) => shape.test(d) && existsSync(join(root, d, file)))
    .sort()
    .pop()
  return dir ? { dir, path: join(root, dir, file) } : null
}

export const CouncilPlugin = async (input: any) => ({
  tool: {
    crew: {
      description:
        "The crew: take a directive from intake through an approved plan, implementation, " +
        "verification and review, to a PR. mode:'init' inspects the repo and proposes its " +
        "config (verify command, PR base, review lanes), then writes it to AGENTS.md once " +
        "you confirm. Run init once per repo before anything else.",
      args: {
        mode: z
          .enum(["init", "plan", "run", "status"])
          .default("plan")
          .describe(
            "init = detect and record this repo's crew config; plan = intake a directive into an ordered work item list and stop at the approval gate; run = execute the last approved plan in an isolated worktree and open a PR; status = list this repo's live crew worktrees and how to remove them",
          ),
        directive: z.string().default("").describe("what you want built or changed (plan only)"),
        write: z
          .boolean()
          .default(false)
          .describe("false proposes and returns; true writes. Never write before the human has seen the proposal."),
        verify: z
          .string()
          .default("")
          .describe("comma-separated commands, run in order, all must pass (write only)"),
        base: z.string().default("").describe("PR target branch (write only)"),
        lanes: z.string().default("").describe("comma-separated review lanes (write only)"),
        tracker: z
          .string()
          .default("")
          .describe("where to mirror runs: 'none', or 'linear' when LINEAR_API_TOKEN is set (write only)"),
      },
      async execute(
        args: {
          mode?: "init" | "plan" | "run" | "status"
          directive?: string
          write?: boolean
          verify?: string
          base?: string
          lanes?: string
          tracker?: string
        },
        context: any,
      ) {
        const cwd = context?.directory ?? input?.directory ?? process.cwd()
        const scope = resolveScope(cwd)
        if (scope.kind === "notrepo")
          return `${cwd} is not a git repository. The crew's scope is the repo you are standing in, so there is nothing to configure here.`

        // Before the config lookup below, deliberately: a repo whose crew config was never
        // written or has been removed is exactly where worktrees get stranded, and a
        // read-only query has no reason to demand config. Writes no artifact directory.
        if (args?.mode === "status") return renderWorktrees(listWorktrees(scope.root))

        if (args?.mode === "plan" || args?.mode === "run") {
          const cfg = readCrewConfig(scope.root)
          if (!cfg) return `This repo has no crew config yet. Run \`/crew:init\` first.`

          if (args.mode === "run") {
            // Execute the plan the human actually read. Re-running intake here would
            // produce a DIFFERENT list - intake is nondeterministic - so what they approved
            // and what gets built would not correspond. Same reason `fix` replays the last
            // review instead of running a fresh one.
            const found = latestArtifact(scope.root, "crew-plan", "plan.json")
            if (!found) return "No approved plan found. Run `/crew:plan <directive>` first and approve the plan."
            const saved = JSON.parse(readFileSync(found.path, "utf8"))
            if (!saved.items?.length) return `The last plan (${found.dir}) had no items — nothing to run.`
            // A tool call returns once, at the end, so a 20-minute run would otherwise be
            // completely silent - indistinguishable from a hang. Progress is appended to a
            // file as it happens so it can be tailed while the run is still going.
            const dir = artifactDir(scope.root, "crew-run")
            const logPath = join(dir, "run.log")
            const log: string[] = []
            const say = (m: string) => {
              log.push(m)
              try {
                appendFileSync(logPath, `${m}\n`)
              } catch {
                /* a progress line is never worth failing the run over */
              }
            }

            // This plan is about to be executed with edit+bash. Record which one and what
            // it says, so an unexpected directive is visible in the log from the first line
            // rather than inferred from the diff afterwards.
            say(`plan ${found.dir}: ${String(saved.directive ?? "(no directive recorded)").slice(0, 120)}`)

            const result = await runExecute(ctxFor(input), {
              root: scope.root,
              items: saved.items,
              cfg,
              instructions: readInstructions(scope.root).text,
              directive: saved.directive ?? "",
              tracker: trackerFor(cfg.tracker, say, {
                issueRef: issueIdentifierIn(saved.directive ?? ""),
                repoRoot: scope.root,
                mcp: cfg.mcp,
              }),
            })
            writeFileSync(join(dir, "run.json"), JSON.stringify(result, null, 2))
            return `${renderRun(result, cfg)}\n\nStep log: ${logPath}`
          }

          const directive = (args.directive ?? "").trim()
          if (!directive) return "No directive given. `plan` needs one — say what you want built or changed."

          // A worktree branches from HEAD, so uncommitted work is invisible to the crew: it
          // would plan against a repo state that is not the one on your screen, and its PR
          // would then collide with your edits. Cheaper to stop here. (C9)
          if (scope.dirty.length)
            return [
              `${scope.dirty.length} uncommitted file(s):`,
              ...scope.dirty.slice(0, 10).map((f) => `  • ${f}`),
              scope.dirty.length > 10 ? `  … and ${scope.dirty.length - 10} more` : "",
              "",
              "The crew branches from HEAD, so it would plan against a state that is not what you",
              "see, and its PR would collide with your edits. Commit them, or say the word and",
              "I'll stash them first.",
            ]
              .filter(Boolean)
              .join("\n")

          const instructions = readInstructions(scope.root)
          const intake = await runIntake(ctxFor(input), {
            root: scope.root,
            directive,
            instructions: instructions.text,
          })
          const dir = artifactDir(scope.root, "crew-plan")
          writeFileSync(join(dir, "plan.json"), JSON.stringify({ directive, ...intake }, null, 2))
          return renderGate(intake, cfg, scope)
        }

        if (!args?.write) return renderInitProposal(proposeInit(scope.root, scope.branch))

        // The write path takes only what the human confirmed. Defaulting a verify command
        // would reintroduce the failure detection deliberately refuses to make: a command
        // that passes trivially, letting the crew report unfinished work as done.
        const list = (s?: string) =>
          (s ?? "")
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
        const verify = list(args.verify)
        const lanes = list(args.lanes) as Role[]
        const base = (args.base ?? "").trim()

        const missing = [
          !verify.length && "verify (how this project proves it still works)",
          !base && "base (the PR target branch)",
          !lanes.length && "lanes (which review lanes run here)",
        ].filter(Boolean)
        if (missing.length)
          return `Not writing — still unconfirmed:\n${missing.map((m) => `  • ${m}`).join("\n")}`

        const tracker = (args.tracker ?? "").trim()
        if (tracker && !availableTrackers(process.env, scope.root).includes(tracker as any))
          return `Unknown or unavailable tracker \`${tracker}\`. Available here: ${availableTrackers(process.env, scope.root).join(", ")}. \`mcp\` needs a local \`mcpServers\` entry in opencode.json; \`linear\` needs LINEAR_API_TOKEN.`
        // tracker: mcp additionally needs to name a resolvable server
        if (tracker === "mcp") {
          const server = (args.mcpServer ?? "").trim()
          if (!server) return "`tracker: mcp` also needs `mcpServer` — which mcpServers entry from opencode.json?"
          if (!localMcpServers(scope.root).has(server))
            return `\`${server}\` is not a local entry in any opencode.json here. Found: ${[...localMcpServers(scope.root).keys()].map((n) => `\`${n}\``).join(", ") || "(none)"}.`
        }
        if (args.mcpArgs?.trim()) {
          try {
            JSON.parse(args.mcpArgs)
          } catch {
            return `mcpArgs is not valid JSON: ${args.mcpArgs.slice(0, 80)}`
          }
        }

        // The validated mcpServer lands in the config — validating it and then writing a
        // tracker that cannot run was the gap between the check and the write.
        const mcp =
          tracker === "mcp" && args.mcpServer?.trim()
            ? {
                server: args.mcpServer.trim(),
                ...(args.mcpStart?.trim() ? { start: args.mcpStart.trim() } : {}),
                ...(args.mcpStep?.trim() ? { step: args.mcpStep.trim() } : {}),
                ...(args.mcpItem?.trim() ? { item: args.mcpItem.trim() } : {}),
                ...(args.mcpFinish?.trim() ? { finish: args.mcpFinish.trim() } : {}),
                ...(args.mcpArgs?.trim() ? { args: JSON.parse(args.mcpArgs) } : {}),
              }
            : undefined
        const cfg: CrewConfig = {
          verify, base, lanes,
          ...(tracker ? { tracker: tracker as any } : {}),
          ...(mcp ? { mcp } : {}),
        }
        const written = applyInit(scope.root, cfg)
        return written.length
          ? `Wrote ${written.join(", ")}.\n\nverify: ${verify.join(", ")}\nbase: ${base}\nlanes: ${lanes.join(", ")}${tracker ? `\ntracker: ${tracker}` : ""}`
          : "Nothing to write — config already matches."
      },
    },

    council: {
      description:
        "Multi-model code REVIEW and planning: fans out across role x model, debates disputed findings to a " +
        "computed fixed point, verifies with independent models, and aggregates " +
        "deterministically. mode:'review' reviews a diff, mode:'fix' turns the last review's " +
        "findings into independently-verified patches, mode:'plan' runs a proposal-and-score " +
        "vote on a goal. Use /council:check for a fast inline pass instead.",
      args: {
        mode: z
          .enum(["review", "fix", "plan", "independent"])
          .default("review")
          .describe(
            "review = the graph; fix = verified patches; plan = proposal vote; " +
              "independent = every model answers alone, unmerged. To BUILD something, use the `crew` tool.",
          ),
        base: z.string().default("HEAD").describe("git ref to diff against (review/fix only)"),
        goal: z.string().default("").describe("what to plan / answer (plan, independent)"),
      },
      async execute(
        args: {
          mode?: "review" | "fix" | "plan" | "independent"
          base?: string
          goal?: string
        },
        context: any,
      ) {
        const t0 = Date.now()
        const cwd = context?.directory ?? input?.directory ?? process.cwd()
        const ctx = ctxFor(input)

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
          const found = latestArtifact(cwd, "review", "findings.json")
          if (!found) return "No previous review found. Run council({ mode: 'review' }) first."
          const kept = JSON.parse(readFileSync(found.path, "utf8")).kept ?? []
          if (!kept.length) return `The last review (${found.dir}) kept no findings — nothing to fix.`
          const prev = found.dir

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

        const review = await runReview(ctx, { diff, files, changedLines, ...councilArgs() })
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
      ...new Set([...(config.experimental.primary_tools ?? []), "council", "crew"]),
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
        ...(data.tools ? { permission: permissionsFor(data.tools) } : {}),
      }
    }
  },
})

export default CouncilPlugin
