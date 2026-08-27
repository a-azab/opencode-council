import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, basename } from "node:path"
import { execFileSync } from "node:child_process"
import { z } from "zod"
import { runReview, runFix, runPlan, runIndependent, runTask, councilArgs } from "./engine.ts"
import { localMcpServers } from "./mcp.ts"
import { activeTaskId } from "./beads.ts"
import {
  resolveScope,
  proposeInit,
  renderInitProposal,
  applyInit,
  readLetsConfig,
  readInstructions,
  runIntake,
  renderGate,
  runExecute,
  renderRun,
  trackerFor,
  availableTrackers,
  listWorktrees,
  renderWorktrees,
  type LetsConfig,
} from "./lets.ts"
import { detectStack, closeWorktree } from "./lets.ts"
import { fileEdges, schedule, MAX_TASKS, MAX_WAVE_WIDTH } from "./schedule.ts"
import { recruitFloor, integrate, renderCrewReport, type CrewResult, type CrewTask } from "./crew-org.ts"
import { ROSTER, type Role } from "./roster.ts"
import { catalog, probe, probeBudget, upgradeCandidates, type Result } from "./catalog.ts"
import {
  renderReport,
  renderSummary,
  renderPatches,
  renderPlan,
  renderTakesIndex,
  renderTask,
  renderModelsProposal,
} from "./report.ts"

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
  // The lets implementer is the one exception and it opts in explicitly via `tools:` in
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
 * Using the session cwd meant `/lets:plan` run from `apps/api/` wrote its plan somewhere `run`
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
function latestArtifact(repoRoot: string, kind: string | string[], file: string): { dir: string; path: string } | null {
  const root = artifactRoot(repoRoot)
  if (!existsSync(root)) return null
  // A list, so a plan approved before the rename is still found. Alternation goes INSIDE the
  // anchored template rather than loosening it: `<stamp>-lets-plan-extra` must still lose.
  const kinds = (Array.isArray(kind) ? kind : [kind]).join("|")
  const shape = new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(?:${kinds})$`)
  const dir = readdirSync(root)
    .filter((d) => shape.test(d) && existsSync(join(root, d, file)))
    .sort()
    .pop()
  return dir ? { dir, path: join(root, dir, file) } : null
}

/**
 * Every task carries the union of its items' files, because that is what `schedule()` reasons
 * over. Derived rather than trusted from the plan: a decomposition that under-declares its
 * files would be judged independent of work it actually touches, and the scheduler would put
 * the two in one wave. An explicit `files` on the task is honoured as a superset.
 */
const withFiles = (tasks: any[]): any[] =>
  tasks.map((t) => ({
    ...t,
    files: [...new Set([...(t.files ?? []), ...(t.items ?? []).flatMap((i: any) => i.files ?? [])])],
  }))

export const CouncilPlugin = async (input: any) => ({
  tool: {
    lets: {
      description:
        "lets: take a directive from intake through an approved plan, implementation, " +
        "verification and review, to a PR. mode:'init' inspects the repo and proposes its " +
        "config (verify command, PR base, review lanes), then writes it to AGENTS.md once " +
        "you confirm. Run init once per repo before anything else.",
      args: {
        mode: z
          .enum(["init", "plan", "run", "status"])
          .default("plan")
          .describe(
            "init = detect and record this repo's lets config; plan = intake a directive into an ordered work item list and stop at the approval gate; run = execute the last approved plan in an isolated worktree and open a PR; status = list this repo's live lets worktrees and how to remove them",
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
          return `${cwd} is not a git repository. The lets scope is the repo you are standing in, so there is nothing to configure here.`

        // Before the config lookup below, deliberately: a repo whose lets config was never
        // written or has been removed is exactly where worktrees get stranded, and a
        // read-only query has no reason to demand config. Writes no artifact directory.
        if (args?.mode === "status") return renderWorktrees(listWorktrees(scope.root))

        if (args?.mode === "plan" || args?.mode === "run") {
          const cfg = readLetsConfig(scope.root)
          if (!cfg) return `This repo has no lets config yet. Run \`/lets:init\` first.`

          if (args.mode === "run") {
            // Execute the plan the human actually read. Re-running intake here would
            // produce a DIFFERENT list - intake is nondeterministic - so what they approved
            // and what gets built would not correspond. Same reason `fix` replays the last
            // review instead of running a fresh one.
            const found = latestArtifact(scope.root, ["lets-plan", "crew-plan"], "plan.json")
            if (!found) return "No approved plan found. Run `/lets:plan <directive>` first and approve the plan."
            const saved = JSON.parse(readFileSync(found.path, "utf8"))
            if (!saved.items?.length) return `The last plan (${found.dir}) had no items — nothing to run.`
            // A tool call returns once, at the end, so a 20-minute run would otherwise be
            // completely silent - indistinguishable from a hang. Progress is appended to a
            // file as it happens so it can be tailed while the run is still going.
            const dir = artifactDir(scope.root, "lets-run")
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
                // The run's own task first — /lets:start recorded it, and it is the only
                // source that can name a beads id. Falling back to the directive scrape
                // keeps linear and mcp resolving exactly as they did.
                // Which ref a tracker wants depends on which tracker it is, so ask per
                // tracker rather than picking one winner. beads learns the task from the
                // pointer file `/lets:start` wrote - its ids are lowercase and dash-heavy
                // (`oci-infrastructure-ovb`), so `issueIdentifierIn`'s Linear-shaped regex
                // rejects every one of them. Linear and MCP keep scraping the directive.
                //
                // Resolving beads-first for ALL trackers would hand Linear a beads id in a
                // repo that has both: findIssue misses, the tracker prints "not found" and
                // no-ops, and a mirror that used to work quietly stops.
                issueRef:
                  cfg.tracker === "beads"
                    ? activeTaskId(scope.root)
                    : issueIdentifierIn(saved.directive ?? ""),
                repoRoot: scope.root,
                mcp: cfg.mcp,
              }),
            })
            writeFileSync(join(dir, "run.json"), JSON.stringify(result, null, 2))
            return `${renderRun(result, cfg)}\n\nStep log: ${logPath}`
          }

          const directive = (args.directive ?? "").trim()
          if (!directive) return "No directive given. `plan` needs one — say what you want built or changed."

          // A worktree branches from HEAD, so uncommitted work is invisible to lets: it
          // would plan against a repo state that is not the one on your screen, and its PR
          // would then collide with your edits. Cheaper to stop here. (C9)
          if (scope.dirty.length)
            return [
              `${scope.dirty.length} uncommitted file(s):`,
              ...scope.dirty.slice(0, 10).map((f) => `  • ${f}`),
              scope.dirty.length > 10 ? `  … and ${scope.dirty.length - 10} more` : "",
              "",
              "lets branches from HEAD, so it would plan against a state that is not what you",
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
          const dir = artifactDir(scope.root, "lets-plan")
          writeFileSync(join(dir, "plan.json"), JSON.stringify({ directive, ...intake }, null, 2))
          return renderGate(intake, cfg, scope)
        }

        if (!args?.write) return renderInitProposal(proposeInit(scope.root, scope.branch))

        // The write path takes only what the human confirmed. Defaulting a verify command
        // would reintroduce the failure detection deliberately refuses to make: a command
        // that passes trivially, letting lets report unfinished work as done.
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
          return `Unknown or unavailable tracker \`${tracker}\`. Available here: ${availableTrackers(process.env, scope.root).join(", ")}. \`mcp\` needs a local \`mcpServers\` entry in opencode.json; \`linear\` needs LINEAR_API_TOKEN; \`beads\` needs \`bd\` on PATH and a \`.beads/\` in this repo.`
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
        const cfg: LetsConfig = {
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

    crew: {
      description:
        "crew: one directive, interviewed rather than stated, taken to a merged branch with NO approval gate. " +
        "mode:'plan' records the interview, the ADR and the task decomposition; mode:'execute' runs the tasks " +
        "concurrently in isolated worktrees, integrates them, verifies and reviews the result; mode:'status' is a " +
        "read-only view of the last plan and any live worktrees. Where /lets asks you to approve a plan, crew " +
        "hands you an audit trail afterwards instead.",
      args: {
        mode: z
          .enum(["plan", "execute", "status"])
          .default("plan")
          .describe(
            "plan = record the interviewed directive, its ADR and its decomposition, with no approval gate; execute = schedule the last crew plan into waves, run them concurrently, integrate, verify and review; status = read-only view of the last plan's waves and this repo's live worktrees",
          ),
        directive: z.string().default("").describe("what the crew is being asked to deliver (plan only)"),
        tasks: z
          .string()
          .default("")
          .describe(
            "JSON array of {title, items:[{title,detail,files,acceptance}]} — the decomposition the interview produced (plan only)",
          ),
        adr: z
          .string()
          .default("")
          .describe("path to the ADR holding the interview Q&A, the research and the design (plan only)"),
      },
      async execute(
        args: { mode?: "plan" | "execute" | "status"; directive?: string; tasks?: string; adr?: string },
        context: any,
      ) {
        const cwd = context?.directory ?? input?.directory ?? process.cwd()
        const scope = resolveScope(cwd)
        if (scope.kind === "notrepo")
          return `${cwd} is not a git repository. The crew scope is the repo you are standing in, so there is nothing to run here.`

        // Read-only, and before the config lookup: a repo whose config was never written is
        // exactly where a worktree gets stranded, and a query has no business demanding config.
        if (args?.mode === "status") {
          const last = latestArtifact(scope.root, "crew-org-plan", "plan.json")
          const out: string[] = []
          if (!last) out.push("No crew plan recorded. Run `/crew:plan <directive>` first.")
          else {
            const saved = JSON.parse(readFileSync(last.path, "utf8"))
            const tasks = saved.tasks ?? []
            const edges = fileEdges(join(scope.root, "graphify-out", "graph.json"))
            const sched = tasks.length <= MAX_TASKS ? schedule(withFiles(tasks), edges) : null
            out.push(`Plan ${last.dir}: ${String(saved.directive ?? "(none)").slice(0, 120)}`)
            out.push(`${tasks.length} task(s), ADR ${saved.adr ?? "(none recorded)"}`)
            if (!sched) out.push(`Too many tasks to schedule (max ${MAX_TASKS}).`)
            else {
              out.push(`Schedule: ${sched.mode}, ${sched.waves.length} wave(s), max width ${MAX_WAVE_WIDTH}`)
              sched.waves.forEach((w, i) => out.push(`  wave ${i + 1}: ${w.map((t: any) => t.title).join(", ")}`))
              if (sched.ungraphed.length)
                out.push(
                  `  ${sched.ungraphed.length} file(s) absent from the graph, so their tasks run alone: ${sched.ungraphed.slice(0, 8).join(", ")}`,
                )
            }
          }
          out.push("", renderWorktrees(listWorktrees(scope.root)))
          return out.join("\n")
        }

        const cfg = readLetsConfig(scope.root)
        if (!cfg)
          return "This repo has no config yet. Run `/lets:init` first — crew reuses the same block (verify, base, lanes)."

        // A worktree branches from the configured base, so uncommitted work is invisible to
        // crew and its integration branch would collide with your edits. Same gate as lets.
        if (scope.dirty.length)
          return [
            `${scope.dirty.length} uncommitted file(s):`,
            ...scope.dirty.slice(0, 10).map((f) => `  • ${f}`),
            "",
            "crew runs unattended across several worktrees. Commit or stash first.",
          ].join("\n")

        if (args?.mode === "plan") {
          const directive = (args.directive ?? "").trim()
          if (!directive) return "No directive given. `plan` needs one — say what the crew should deliver."
          // The ADR is not paperwork here. With no approval gate it is the ONLY record of what
          // was asked for and why, so a plan without one cannot be audited afterwards.
          const adr = (args.adr ?? "").trim()
          if (!adr)
            return "crew:plan needs `adr` — the path to the ADR holding the interview, the research and the design. With no approval gate that record is the only trace of what you asked for; write it before planning."
          let tasks: any
          try {
            tasks = JSON.parse(args.tasks || "[]")
          } catch {
            return `tasks is not valid JSON: ${(args.tasks ?? "").slice(0, 80)}`
          }
          if (!Array.isArray(tasks) || !tasks.length)
            return "crew:plan needs `tasks` — the decomposition, as a JSON array of {title, items:[...]}. The interview and decomposition happen in the command; this mode records them."
          if (tasks.length > MAX_TASKS)
            return `${tasks.length} tasks exceeds MAX_TASKS=${MAX_TASKS}. Decompose the directive further, or split it into two crews.`
          const bad = tasks.findIndex((t: any) => !t?.title || !Array.isArray(t?.items) || !t.items.length)
          if (bad !== -1) return `task ${bad + 1} has no title or no items — every task needs both.`

          const roles = recruitFloor(directive, detectStack(scope.root))
          const dir = artifactDir(scope.root, "crew-org-plan")
          writeFileSync(
            join(dir, "plan.json"),
            JSON.stringify({ directive, adr, roles, tasks: withFiles(tasks) }, null, 2),
          )
          const edges = fileEdges(join(scope.root, "graphify-out", "graph.json"))
          const sched = schedule(withFiles(tasks), edges)
          return [
            `Recorded ${tasks.length} task(s) in ${dir}. No approval gate — \`/crew:execute\` will run this as-is.`,
            `ADR: ${adr}`,
            `Lanes (floor): ${roles.join(", ")}`,
            `Schedule: ${sched.mode}, ${sched.waves.length} wave(s)`,
            ...sched.waves.map((w, i) => `  wave ${i + 1}: ${w.map((t: any) => t.title).join(", ")}`),
            sched.mode !== "graph"
              ? `Note: ${sched.mode === "sequential" ? "no readable dependency graph" : `${sched.ungraphed.length} file(s) absent from the graph`}, so tasks that cannot be PROVEN independent will run alone. Rebuild the graph and this parallelises.`
              : "",
          ]
            .filter(Boolean)
            .join("\n")
        }

        // ---- execute
        const found = latestArtifact(scope.root, "crew-org-plan", "plan.json")
        if (!found) return "No crew plan found. Run `/crew:plan <directive>` first."
        const saved = JSON.parse(readFileSync(found.path, "utf8"))
        const planned = withFiles(saved.tasks ?? [])
        if (!planned.length) return `The last crew plan (${found.dir}) had no tasks — nothing to run.`

        const dir = artifactDir(scope.root, "crew-org-run")
        const logPath = join(dir, "run.log")
        const say = (m: string) => {
          try {
            appendFileSync(logPath, `${m}\n`)
          } catch {
            /* a progress line is never worth failing the run over */
          }
        }
        say(`plan ${found.dir}: ${String(saved.directive ?? "(no directive recorded)").slice(0, 120)}`)

        const edges = fileEdges(join(scope.root, "graphify-out", "graph.json"))
        let sched
        try {
          sched = schedule(planned, edges)
        } catch (e: any) {
          return String(e?.message ?? e)
        }
        say(`schedule: ${sched.mode}, ${sched.waves.length} wave(s)`)

        const roles = [
          ...new Set<Role>([...(saved.roles ?? []), ...recruitFloor(saved.directive ?? "", detectStack(scope.root))]),
        ]
        const runId = Date.now().toString(36)
        const tasks: CrewTask[] = []
        let abandon = ""

        for (const [wi, wave] of sched.waves.entries()) {
          if (abandon) {
            for (const t of wave) tasks.push({ title: t.title, slug: "", wave: wi + 1, skipped: abandon })
            continue
          }
          say(`wave ${wi + 1}/${sched.waves.length}: ${wave.map((t: any) => t.title).join(", ")}`)
          const settled = await Promise.all(
            wave.map(async (t: any, ti: number): Promise<CrewTask> => {
              // Distinct per task AND per run: runExecute's slug derivation is a race for N
              // callers, so the caller that knows all N owns distinctness. The run id keeps a
              // rerun from colliding with a branch a previous run already created.
              const slug = `crew-${runId}-${wi + 1}${ti + 1}-${String(t.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24)}`
              try {
                const run = await runExecute(ctxFor(input), {
                  root: scope.root,
                  items: t.items,
                  cfg,
                  instructions: readInstructions(scope.root).text,
                  directive: t.title,
                  slug,
                  // N tasks must not open N competing PRs before anything is integrated.
                  openPr: false,
                  // ONE council, on the integrated branch below - not one per task as well.
                  // Reviewing both is structurally N+1 full councils and the largest single
                  // cost line in a crew run. `verify` and the acceptance judge still run per
                  // task, so the per-task signal survives.
                  review: false,
                  label: t.title,
                  onStep: say,
                  // One Tracker per run, never shared: guarded() refuses a second start, and a
                  // shared instance would close the issue at the first finish, reporting done
                  // over live work.
                  tracker: trackerFor(cfg.tracker, say, {
                    issueRef: cfg.tracker === "beads" ? activeTaskId(scope.root) : undefined,
                    repoRoot: scope.root,
                    mcp: cfg.mcp,
                  }),
                })
                return { title: t.title, slug, wave: wi + 1, run }
              } catch (e: any) {
                // One task crashing must not lose the record of the others in its wave.
                return {
                  title: t.title,
                  slug,
                  wave: wi + 1,
                  skipped: `crashed: ${String(e?.message ?? e).slice(0, 200)}`,
                }
              }
            }),
          )
          tasks.push(...settled)
          // A wave where nothing landed means the next wave builds on nothing. Stop and say so
          // rather than run work whose premise is already false.
          if (settled.every((t) => !t.run)) abandon = `wave ${wi + 1} produced no branch, so later waves were abandoned`
        }

        const result: CrewResult = {
          directive: saved.directive ?? "",
          roles,
          scheduling: { mode: sched.mode, ungraphed: sched.ungraphed, waves: sched.waves.length },
          tasks,
          adr: saved.adr,
        }

        const branches = tasks.filter((t) => t.run).map((t) => t.run!.branch)
        if (branches.length) {
          try {
            result.integration = integrate(scope.root, cfg.base || "HEAD", branches, `crew/int-${runId}`)
            say(`integrate: ${result.integration.ok ? "clean" : `stopped at ${result.integration.conflicted}`}`)
          } catch (e: any) {
            result.error = `integration could not start: ${String(e?.message ?? e).slice(0, 200)}`
          }
        }

        // Verify the branches COMBINED. Each task already verified alone; this is the only
        // check that sees them together, which is the whole reason integration exists.
        if (result.integration?.ok && cfg.verify.length) {
          const vpath = join(scope.root, ".worktrees", `verify-${runId}`)
          try {
            execFileSync("git", ["worktree", "add", vpath, result.integration.branch], {
              cwd: scope.root,
              stdio: "ignore",
            })
            const deps = join(scope.root, "node_modules")
            if (existsSync(deps) && !existsSync(join(vpath, "node_modules"))) {
              try {
                execFileSync("ln", ["-s", deps, join(vpath, "node_modules")], { stdio: "ignore" })
              } catch {
                /* best effort, same ceiling as openWorktree's symlink */
              }
            }
            let output = ""
            let ok = true
            for (const cmd of cfg.verify) {
              try {
                output += execFileSync(cmd, { cwd: vpath, shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
              } catch (e: any) {
                ok = false
                output += String(e?.stdout ?? "") + String(e?.stderr ?? e?.message ?? e)
                break
              }
            }
            result.verify = { ok, output }
            say(`verify: ${ok ? "passed" : "FAILED"}`)
            const { diff, files, changedLines } = gitDiff(vpath, cfg.base)
            if (diff.trim()) {
              const review = await runReview(ctxFor(input), { diff, files, changedLines, roles })
              result.review = {
                blockers: review.verdictCounts.blockers,
                suggestions: review.verdictCounts.suggestions,
                nits: review.verdictCounts.nits,
                convergence: review.convergence,
                dropped: review.dropped.length,
              }
              writeFileSync(join(dir, "review.json"), JSON.stringify(review, null, 2))
            }
          } catch (e: any) {
            result.error = `verify/review could not run: ${String(e?.message ?? e).slice(0, 200)}`
          } finally {
            closeWorktree(scope.root, vpath)
          }
        }

        writeFileSync(join(dir, "run.json"), JSON.stringify(result, null, 2))
        return `${renderCrewReport(result)}\n\nStep log: ${logPath}`
      },
    },

    council: {
      description:
        "Multi-model code REVIEW and planning: fans out across role x model, debates disputed findings to a " +
        "computed fixed point, verifies with independent models, and aggregates " +
        "deterministically. mode:'review' reviews a diff, mode:'fix' turns the last review's " +
        "findings into independently-verified patches, mode:'plan' runs a proposal-and-score " +
        "vote on a goal, mode:'task' has every model answer a task and returns the one that " +
        "scored best with its dissent attached. Use /council:check for a fast inline pass instead.",
      args: {
        mode: z
          .enum(["review", "fix", "plan", "independent", "task", "models"])
          .default("review")
          .describe(
            "review = the graph; fix = verified patches; plan = proposal vote; " +
              "task = one answer, cross-scored, dissent kept; " +
              "independent = every model answers alone, unmerged; " +
              "models = what this server offers that the roster does not pin, measured and proposed, never adopted. " +
              "To BUILD something, use the `lets` tool.",
          ),
        base: z.string().default("HEAD").describe("git ref to diff against (review/fix only)"),
        goal: z.string().default("").describe("what to plan / answer (plan, task, independent)"),
        context: z
          .string()
          .default("")
          .describe("supporting material the models should read as data (task, independent)"),
      },
      async execute(
        args: {
          mode?: "review" | "fix" | "plan" | "independent" | "task" | "models"
          base?: string
          goal?: string
          context?: string
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

        // A task is not a diff either, so this resolves above the diff guard too.
        if (args?.mode === "task") {
          const goal = (args.goal ?? "").trim()
          if (!goal) return "No goal given. `task` needs one — that is the thing being answered."
          const result = await runTask(ctx, { goal, context: args.context })
          const dir = artifactDir(cwd, "task")
          const path = join(dir, "task.md")
          writeFileSync(path, renderTask(result))
          writeFileSync(join(dir, "task.json"), JSON.stringify(result, null, 2))
          const live = result.proposals.filter((p) => p.state === "ok")
          const head = result.winner
            ? `answer: ${result.winner.slug}`
            : result.unscored
              ? "unranked — answers came back, but no score did"
              : `no winner — ${result.tied.map((t) => t.slug).join(" and ")} are within the tie margin, your call`
          return [
            `${live.length}/${result.proposals.length} answered · ${result.scores.length} cross-scores`,
            head,
            result.objections.length
              ? `${result.objections.length} objection(s) kept verbatim in the report`
              : "",
            ``,
            `Full answer: ${path}`,
          ]
            .filter(Boolean)
            .join("\n")
        }

        // Discovery is not a diff either, so it resolves above the diff guard with the
        // other non-review modes.
        if (args?.mode === "models") {
          const offered = await catalog(ctx)
          if (!offered.length)
            return [
              "The server offered no catalog, so there is nothing to compare the roster against.",
              "Discovery is an optimisation over a roster that still works — this costs you a",
              "proposal, not a review.",
            ].join("\n")

          const candidates = upgradeCandidates(ROSTER, offered)

          // Measured here, never inside the renderer: probing is the one expensive thing
          // this mode does, and a report function that reaches for the network cannot be
          // asserted without one. Budgeted at 3 for the same reason recruitment is — each
          // probe is a full model call, and a provider that just published twenty variants
          // is exactly where an unbudgeted loop spends the afternoon.
          const budget = probeBudget(3)
          const probes: Record<string, Result | undefined> = {}
          for (const id of candidates) {
            if (!budget.take()) break
            probes[id] = await probe(ctx, id)
          }

          const dir = artifactDir(cwd, "models")
          const path = join(dir, "models.md")
          // Two things get written and neither is the roster: this artifact, and the
          // capability cache `probe` records into - a fact about this machine, which is why
          // it lives under ~/.cache and not the repo. The roster is a source file and stays
          // one: `google/gemini-3.7-flash` times out at 90s where 3.6 answers in 9s, so a
          // tool that adopted the newer id on its own would have cost a lane and called it
          // an upgrade.
          writeFileSync(path, renderModelsProposal({ roster: ROSTER, catalog: offered, probes }))
          const measured = Object.values(probes).filter(Boolean).length
          const usable = Object.values(probes).filter((r) => r?.ok).length
          return [
            `${offered.length} models offered · ${candidates.length} unpinned on providers already in use · ` +
              `${measured} measured, ${usable} answered`,
            "Nothing has been written to the roster. Read the proposal and decide.",
            ``,
            `Proposal: ${path}`,
          ].join("\n")
        }

        // Independent mode answers a task, not a diff, so it runs before the diff guard.
        if (args?.mode === "independent") {
          if (!args?.goal?.trim())
            return "mode:'independent' needs a `goal` — what should each model answer?"
          const takes = await runIndependent(ctx, { task: args.goal, context: args.context })
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
      ...new Set([...(config.experimental.primary_tools ?? []), "council", "crew", "lets"]),
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

    // The session spine's shared logic lives in skills/, not in the command files, so that
    // orient renders identically from /lets:status and /lets:start and cannot drift between
    // them. Registered as a PATH rather than read here: skills are prompt documents with
    // their own directory-per-skill layout, and opencode owns loading them.
    config.skills ??= {}
    config.skills.paths = [...new Set([...(config.skills.paths ?? []), join(PKG, "skills")])]

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
