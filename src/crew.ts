// Crew: a human directive taken through intake, an approved plan, implementation,
// verification and review, to a PR. See PLAN.md §9.
//
// This file is Phase 1a: everything `/crew init` needs to work out what a repo is and
// write that down. No model calls live here - it is deliberately all deterministic, which
// is why it is the part that gets tests.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { selectRoles, bySlug, type Role } from "./roster.ts"
import { ask, type Ctx, type NodeState } from "./engine.ts"
import { WORKITEMS_SCHEMA } from "./schema.ts"

/**
 * What `/crew init` writes and every later phase reads.
 *
 * ponytail: `verify` is an ordered list of whole commands, not a path->command map. The
 * narrowing a monorepo needs is better done by the build tool that already computes it
 * (`nx affected`, `turbo --filter`) than by a scope table we maintain by hand. If a repo
 * turns up that has neither, add the map then.
 */
export type CrewConfig = {
  /** run in order; all must pass. */
  verify: string[]
  /** PR target. */
  base: string
  /** review lanes on this repo's payroll. */
  lanes: Role[]
}

// ------------------------------------------------------------------ AGENTS.md block

const FENCE = /^```crew[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/m

/**
 * Flat `key: value` inside a ```crew fence. Same shape as the agent-file frontmatter
 * parser in index.ts, and flat for the same reason: nothing here needs nesting, and
 * needing a YAML dependency to read four keys would be the tail wagging the dog.
 */
export function parseCrewBlock(markdown: string): Partial<CrewConfig> {
  const m = FENCE.exec(markdown)
  if (!m) return {}
  const raw: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":")
    if (i === -1 || line.trimStart().startsWith("#")) continue
    raw[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  const list = (s?: string) =>
    (s ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)

  const out: Partial<CrewConfig> = {}
  if (raw.verify) out.verify = list(raw.verify)
  if (raw.base) out.base = raw.base
  if (raw.lanes) out.lanes = list(raw.lanes) as Role[]
  return out
}

export function renderCrewBlock(cfg: CrewConfig): string {
  return [
    "```crew",
    `verify: ${cfg.verify.join(", ")}`,
    `base: ${cfg.base}`,
    `lanes: ${cfg.lanes.join(", ")}`,
    "```",
  ].join("\n")
}

const HEADING = "## Crew"

/**
 * Replace the crew block in place, or append a section if there is none.
 *
 * Idempotent and surgical on purpose: AGENTS.md is a file the user wrote and their team
 * reviews. Rewriting anything outside our own fence would be the single most annoying
 * thing this tool could do.
 */
export function upsertCrewBlock(markdown: string, cfg: CrewConfig): string {
  const block = renderCrewBlock(cfg)
  if (FENCE.test(markdown)) return markdown.replace(FENCE, block)
  const body = markdown.trimEnd()
  const section = `${HEADING}\n\nConfig for \`/crew\`. Edit freely - it is read, not regenerated.\n\n${block}\n`
  return body ? `${body}\n\n${section}` : section
}

// ------------------------------------------------------------------ scope

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim()

export type Scope =
  | { kind: "ok"; root: string; branch: string; dirty: string[] }
  | { kind: "notrepo" }

/**
 * The repo is wherever the session is standing (PLAN.md C1). Dirty files are returned
 * rather than judged - refusing is the caller's decision, and it needs the list to offer
 * a stash (C9).
 */
export function resolveScope(cwd: string): Scope {
  try {
    const root = git(cwd, ["rev-parse", "--show-toplevel"])
    const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
    const dirty = git(root, ["status", "--porcelain"])
      .split("\n")
      .map((l) => l.slice(3).trim())
      .filter(Boolean)
    return { kind: "ok", root, branch, dirty }
  } catch {
    return { kind: "notrepo" }
  }
}

// ------------------------------------------------------------------ detection

/** Manifests and workspace markers, for the intake prompt and for verify detection. */
export function detectStack(root: string): string[] {
  const hits: string[] = []
  const seen: [string, string][] = [
    ["package.json", "node"],
    ["nx.json", "nx"],
    ["pnpm-workspace.yaml", "pnpm-workspace"],
    ["turbo.json", "turbo"],
    ["go.mod", "go"],
    ["Cargo.toml", "rust"],
    ["pyproject.toml", "python"],
    ["pom.xml", "maven"],
    ["Gemfile", "ruby"],
    ["Dockerfile", "docker"],
    ["flake.nix", "nix"],
  ]
  for (const [file, name] of seen) if (existsSync(join(root, file))) hits.push(name)
  for (const dir of ["apps", "libs", "packages", "services"])
    if (existsSync(join(root, dir))) hits.push(`dir:${dir}`)
  return hits
}

export type VerifyCandidate = { command: string; why: string }

/**
 * Verify candidates, monorepo-aware.
 *
 * Extends work.ts's `detectVerify` in one way that matters: when the repo has a build tool
 * that already knows how to narrow work to what changed (`nx affected`), prefer that over
 * the whole-workspace command. Running 900 files of tests to check a one-file item is how
 * a crew run becomes an hour.
 *
 * Like `detectVerify`, never collapses to a guess - the caller shows candidates and asks.
 */
export function detectVerifyCandidates(root: string, base = "main"): VerifyCandidate[] {
  const out: VerifyCandidate[] = []
  const pkgPath = join(root, "package.json")
  const scripts: Record<string, string> = existsSync(pkgPath)
    ? (() => {
        try {
          return JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {}
        } catch {
          return {}
        }
      })()
    : {}

  if (existsSync(join(root, "nx.json"))) {
    out.push({
      command: `npx nx affected -t lint test --base=${base}`,
      why: "nx.json - nx computes the affected projects itself",
    })
    out.push({ command: "npx nx run-many -t lint test", why: "nx.json - whole workspace" })
  }
  if (existsSync(join(root, "turbo.json")))
    out.push({ command: "npx turbo run lint test", why: "turbo.json" })

  for (const name of ["test", "check", "ci", "lint", "typecheck"])
    if (scripts[name]) out.push({ command: `npm run ${name}`, why: `package.json scripts.${name}` })

  if (existsSync(join(root, "Makefile"))) {
    const mk = readFileSync(join(root, "Makefile"), "utf8")
    for (const t of ["test", "check"])
      if (new RegExp(`^${t}:`, "m").test(mk)) out.push({ command: `make ${t}`, why: `Makefile ${t} target` })
  }
  if (existsSync(join(root, "Cargo.toml"))) out.push({ command: "cargo test", why: "Cargo.toml" })
  if (existsSync(join(root, "go.mod"))) out.push({ command: "go test ./...", why: "go.mod" })
  for (const f of ["pytest.ini", "pyproject.toml", "tox.ini"])
    if (existsSync(join(root, f))) out.push({ command: "pytest", why: f })

  return out
}

/**
 * Base-branch candidates, most likely first.
 *
 * `origin/HEAD` is the obvious answer and is regularly wrong: it says `main` while the team
 * merges to `develop`. So this returns candidates and init asks, rather than picking.
 */
export function detectBaseCandidates(root: string): string[] {
  const out: string[] = []
  try {
    const head = git(root, ["symbolic-ref", "refs/remotes/origin/HEAD"])
    const name = head.split("/").pop()
    if (name) out.push(name)
  } catch {
    /* no origin/HEAD is normal in a fresh or local-only repo */
  }
  for (const guess of ["develop", "main", "master"]) {
    try {
      git(root, ["rev-parse", "--verify", `refs/heads/${guess}`])
      if (!out.includes(guess)) out.push(guess)
    } catch {
      /* branch does not exist */
    }
  }
  return out
}

/**
 * Propose the lane roster from what is actually in the repo.
 *
 * Reuses `selectRoles`, the same glob table review already routes on, so a repo's lanes and
 * its per-diff routing cannot disagree. Init exists to make that table visible and editable
 * - routing alone has no way to say "always security here" or "never docs".
 */
export function proposeLanes(root: string): Role[] {
  let files: string[] = []
  try {
    files = git(root, ["ls-files"]).split("\n").filter(Boolean)
  } catch {
    return ["reviewer"]
  }
  return selectRoles(files).sort()
}

// ------------------------------------------------------------------ graphify

export type GraphState =
  | { kind: "missing" }
  | { kind: "stale"; builtAt: Date; lastCommitAt: Date }
  | { kind: "fresh"; builtAt: Date }

/**
 * A graph built before the last commit describes code that no longer exists, and planning
 * against it is worse than planning against nothing - it is confidently wrong. Init offers
 * a rebuild; it is 14s and free on a code-only corpus (PLAN.md C13).
 */
export function graphState(root: string): GraphState {
  const graph = join(root, "graphify-out", "graph.json")
  if (!existsSync(graph)) return { kind: "missing" }
  const builtAt = statSync(graph).mtime
  try {
    const lastCommitAt = new Date(Number(git(root, ["log", "-1", "--format=%ct"])) * 1000)
    if (lastCommitAt > builtAt) return { kind: "stale", builtAt, lastCommitAt }
  } catch {
    /* no commits yet - nothing to be stale against */
  }
  return { kind: "fresh", builtAt }
}

// ------------------------------------------------------------------ ignores

/** Crew scratch that must never reach the user's team. */
export const CREW_IGNORES = [".worktrees/", "council-artifacts/", "graphify-out/cost.json"]

/**
 * Lines missing from `.git/info/exclude`.
 *
 * `.git/info/exclude` rather than `.gitignore` on purpose: it is per-clone and never
 * committed, so the crew stays invisible in the team's diffs and review.
 */
export function missingIgnores(root: string): string[] {
  const path = join(root, ".git", "info", "exclude")
  const have = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/).map((l) => l.trim()) : []
  return CREW_IGNORES.filter((line) => !have.includes(line))
}

// ------------------------------------------------------------------ instructions

/**
 * The repo's own rules, prepended to every crew prompt (PLAN.md C11).
 *
 * Read here rather than relied upon from opencode's session injection: sessions the engine
 * creates over the HTTP API may or may not load them, and "may or may not" is not a
 * property you want on the file that says how this codebase must be written.
 *
 * ponytail: passed whole, not summarised. thiqwave-platform's AGENTS.md is 64KB (~16k
 * tokens) so this is real overhead across a run - which is why the run summary reports it.
 * Build a digest when a measurement says to, not before.
 */
export function readInstructions(root: string): { text: string; files: string[]; bytes: number } {
  const parts: string[] = []
  const files: string[] = []
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const path = join(root, name)
    if (!existsSync(path)) continue
    files.push(name)
    parts.push(`<instructions file="${name}">\n${readFileSync(path, "utf8")}\n</instructions>`)
  }
  const text = parts.join("\n\n")
  return { text, files, bytes: Buffer.byteLength(text) }
}

// ------------------------------------------------------------------ graphify

const GRAPH_BUDGET = 4000

function graphify(root: string, args: string[]): string | null {
  try {
    return execFileSync("graphify", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      // The query log is off for a reason: graphify's own docs disagree with themselves
      // about whether it defaults on, and this runs against private codebases.
      env: { ...process.env, GRAPHIFY_QUERY_LOG_DISABLE: "1" },
      timeout: 60_000,
    }).trim()
  } catch {
    return null
  }
}

export const graphQuery = (root: string, question: string, budget = GRAPH_BUDGET) =>
  graphify(root, ["query", question, "--budget", String(budget)])
export const graphPath = (root: string, from: string, to: string) => graphify(root, ["path", from, to])
export const graphExplain = (root: string, node: string) => graphify(root, ["explain", node])

/**
 * What the intake lanes get to see of the codebase.
 *
 * This is the answer to "the crew plans without reading the code". A persistent graph beats
 * re-exploring every run: measured on thiqwave-platform, 903 files map in 13.6s with zero
 * LLM calls, and a scoped query returns the relevant neighbourhood instead of a file tree.
 *
 * Degrades to an honest note. Planning with no graph is worse than planning with one, but
 * planning against a *stale* graph is worse than both - it is confidently wrong - so a
 * stale graph is reported as such rather than quietly used.
 */
export function graphContext(root: string, directive: string): string {
  const state = graphState(root)
  if (state.kind === "missing")
    return "<graph>none — no knowledge graph for this repo. Say so in your risks; you are working from file paths alone.</graph>"

  const stale =
    state.kind === "stale"
      ? `\n<warning>Graph built ${state.builtAt.toISOString()}, last commit ${state.lastCommitAt.toISOString()}. It may describe code that no longer exists. Treat node locations as hints, not facts.</warning>`
      : ""

  const scoped = graphQuery(root, directive)
  if (scoped === null)
    return `<graph>unavailable — the graphify command failed or is not installed.</graph>`

  const report = join(root, "graphify-out", "GRAPH_REPORT.md")
  const gods = existsSync(report)
    ? (readFileSync(report, "utf8").match(/## God Nodes[\s\S]*?(?=\n## )/) ?? [""])[0].slice(0, 1500)
    : ""

  return `<graph>${stale}\n${gods}\n\n<scoped-to-directive>\n${scoped}\n</scoped-to-directive>\n</graph>`
}

// ------------------------------------------------------------------ init

export type InitProposal = {
  root: string
  branch: string
  stack: string[]
  verify: VerifyCandidate[]
  bases: string[]
  lanes: Role[]
  graph: GraphState
  ignores: string[]
  /** what is already configured, if this is a re-init */
  existing: Partial<CrewConfig>
}

const AGENTS = "AGENTS.md"

/** Config as recorded by init, or null when this repo has never been initialised. */
export function readCrewConfig(root: string): CrewConfig | null {
  const path = join(root, AGENTS)
  if (!existsSync(path)) return null
  const c = parseCrewBlock(readFileSync(path, "utf8"))
  if (!c.verify?.length || !c.base || !c.lanes?.length) return null
  return { verify: c.verify, base: c.base, lanes: c.lanes }
}

export function proposeInit(root: string, branch: string): InitProposal {
  const bases = detectBaseCandidates(root)
  const agentsPath = join(root, AGENTS)
  return {
    root,
    branch,
    stack: detectStack(root),
    verify: detectVerifyCandidates(root, bases[0] ?? "main"),
    bases,
    lanes: proposeLanes(root),
    graph: graphState(root),
    ignores: missingIgnores(root),
    existing: existsSync(agentsPath) ? parseCrewBlock(readFileSync(agentsPath, "utf8")) : {},
  }
}

/** What the agent shows before writing anything. Init proposes; the human decides. */
export function renderInitProposal(p: InitProposal): string {
  const out: string[] = [
    `**${p.root}** on \`${p.branch}\``,
    `Stack: ${p.stack.join(", ") || "unrecognised"}`,
    "",
  ]

  if (Object.keys(p.existing).length)
    out.push(`Already configured: \`${JSON.stringify(p.existing)}\` — re-init replaces the crew block only.`, "")

  out.push("**Verify** — all must pass; first is the recommendation:")
  if (!p.verify.length)
    out.push(
      "  (none found) — without one there is no objective way to know the work is done.",
      "  You must supply one.",
    )
  else p.verify.forEach((c, i) => out.push(`  ${i + 1}. \`${c.command}\`  (${c.why})`))

  out.push("", "**Base branch** — the PR target:")
  if (p.bases.length > 1)
    out.push(
      `  candidates: ${p.bases.map((b) => `\`${b}\``).join(", ")}`,
      `  \`origin/HEAD\` says \`${p.bases[0]}\` but you are on \`${p.branch}\` — which do PRs target?`,
    )
  else out.push(`  \`${p.bases[0] ?? "main"}\``)

  out.push("", `**Lanes**: ${p.lanes.join(", ")}`, "  (from the repo's file mix; edit to force one on or off)")

  out.push("", "**Knowledge graph**:")
  if (p.graph.kind === "missing")
    out.push("  none — run `graphify extract . --code-only` (local AST, no LLM, seconds)")
  else if (p.graph.kind === "stale")
    out.push(
      `  stale — built ${p.graph.builtAt.toISOString()}, last commit ${p.graph.lastCommitAt.toISOString()}`,
      "  planning against it would be confidently wrong; rebuild with `graphify extract . --code-only`",
    )
  else out.push(`  fresh (${p.graph.builtAt.toISOString()})`)

  if (p.ignores.length)
    out.push("", `**.git/info/exclude** will gain: ${p.ignores.join(", ")}  (per-clone, never committed)`)

  out.push(
    "",
    "Confirm or correct, then I write the crew block to AGENTS.md.",
  )
  return out.join("\n")
}

/**
 * Write the config. Only ever touches our own fence in AGENTS.md and the per-clone
 * exclude file - never the user's prose, never `.gitignore`.
 */
// ------------------------------------------------------------------ intake

/**
 * Intake lane models, in order of preference, first to answer wins.
 *
 * A list rather than one pick for the same reason `WORKERS` is a list: hardcoding a single
 * model makes it a single point of failure, and a run that dies at intake has produced
 * nothing at all.
 */
export const INTAKE_MODELS = ["opus5", "gpt55", "glm52", "minimax", "kimik3"] as const

export type WorkItem = { title: string; detail: string; files: string[]; acceptance: string }

export type Intake = {
  /** the CPO lane's outcomes, carried into the CTO prompt and shown at the gate */
  outcomes: string
  items: WorkItem[]
  /**
   * Lanes that could not be reached, and why.
   *
   * Carrying the reason is the point (PLAN.md §8): "no items" because every model was
   * rate-limited and "no items" because the directive was incoherent look identical to the
   * human otherwise, and they need opposite responses.
   */
  dropped: { lane: string; state: NodeState; detail: string }[]
  instructionBytes: number
  calls: number
}

const cpoPrompt = (directive: string, instructions: string) => `${instructions}

<directive>
${directive}
</directive>

You are the CPO lane. Turn this directive into outcomes, not tasks.

State, in plain prose:
- what a person can do after this ships that they cannot do now
- the acceptance criteria: how a reviewer would know each outcome is genuinely delivered.
  Be concrete and checkable. "Handles errors" is not a criterion. "A duplicate submit
  returns the first result rather than creating a second record" is.
- the states this must not forget: loading, empty, error, offline, partial, too-many
- anything in the directive that is genuinely ambiguous. Do not resolve it by guessing —
  name it, and say what you assumed so the human can correct it.

Do not propose files, architecture, or an implementation. That is the next lane's job.`

const ctoPrompt = (directive: string, outcomes: string, graph: string, instructions: string) =>
  `${instructions}

<directive>
${directive}
</directive>

<outcomes-from-cpo>
${outcomes}
</outcomes-from-cpo>

${graph}

You are the CTO lane. Turn the outcomes into an ordered list of work items.

The graph above is this codebase's actual structure — node locations, what calls what, and
which concepts everything routes through. Use it. An item whose \`files\` contradict the
graph is a guess, and a guess here costs an entire implementation round.

Rules:
- **Order matters.** Items run sequentially, each committed on top of the last. Put an item
  after anything it depends on.
- **\`files\` is a prediction, not a wish.** List the paths you expect to change, taken from
  the graph where possible. If you cannot name them, the item is too vague to implement.
- **\`acceptance\` is inherited from the CPO's criteria**, narrowed to this item. Something
  independent will later read this item's diff and judge it against exactly this text, so
  write it to be judged.
- **Smallest set of items that delivers the outcomes.** Do not invent scaffolding,
  migrations, abstractions or config that the directive did not ask for. An item you cannot
  justify from the outcomes should not exist.
- If an item touches a high-degree node from the graph, say so in \`detail\` — its blast
  radius is the risk.`

/**
 * CPO then CTO, sequentially — an artifact handoff, not a debate.
 *
 * Sequential because the CTO's job is to structure what the CPO decided; running them in
 * parallel would give two independent readings of the directive and no owner of the merge.
 * This is MetaGPT's `Code = SOP(Team)` shape, which is the part of that design the evidence
 * in §6b actually supports: roles producing artifacts for each other, not agents debating.
 */
export async function runIntake(
  ctx: Ctx,
  input: { root: string; directive: string; instructions: string },
): Promise<Intake> {
  const dropped: Intake["dropped"] = []
  let calls = 0

  const askAny = async <T>(agent: string, text: string, schema?: unknown): Promise<T | null> => {
    let last = { state: "failed" as NodeState, detail: "no model in INTAKE_MODELS resolved" }
    for (const slug of INTAKE_MODELS) {
      const member = bySlug(slug)
      if (!member) continue
      calls++
      const r = await ask<T>(ctx, { model: member.model, agent, text, schema })
      if (r.ok) return r.value
      last = { state: r.state, detail: `${member.model}: ${r.detail}` }
      // An auth failure is the server rejecting us, not this model failing. Every other
      // model will fail identically, so walking the rest of the roster just multiplies one
      // misconfiguration into five identical errors and hides the real cause.
      if (r.state === "autherror") break
    }
    dropped.push({ lane: agent, ...last })
    return null
  }

  const cpo = await askAny<{ text: string }>("crew-cpo", cpoPrompt(input.directive, input.instructions))
  // The CTO can still work from the raw directive, but the plan will be weaker and the
  // gate must show that rather than present a confident-looking list.
  const outcomes = cpo?.text ?? ""

  const graph = graphContext(input.root, input.directive)
  const plan = await askAny<{ items: WorkItem[] }>(
    "crew-cto",
    ctoPrompt(input.directive, outcomes || input.directive, graph, input.instructions),
    WORKITEMS_SCHEMA,
  )

  return {
    outcomes,
    items: plan?.items ?? [],
    dropped,
    instructionBytes: Buffer.byteLength(input.instructions),
    calls,
  }
}

/**
 * Instruction overhead is reported so it stays visible (C16 buys no spend cap, so the
 * number is the only feedback). Rounding 195 bytes to "0KB" would report the opposite of
 * the truth on a small repo, which is worse than not reporting it.
 */
const humanBytes = (n: number) => (n < 1024 ? `${n}B` : `${(n / 1024).toFixed(0)}KB`)

/** The gate. Nothing has been written when this is shown (PLAN.md C3). */
export function renderGate(intake: Intake, cfg: CrewConfig, scope: { root: string; branch: string }): string {
  const out: string[] = []

  if (intake.dropped.length) {
    out.push(
      `**${intake.dropped.map((d) => d.lane).join(", ")} did not answer.** The plan below is missing that lane's judgement — treat it as incomplete, not as simple.`,
      "",
    )
    for (const d of intake.dropped) out.push(`- \`${d.lane}\` — ${d.state}: ${d.detail}`)
    if (intake.dropped.some((d) => d.state === "autherror"))
      out.push(
        "",
        "An auth error means the crew could not reach the opencode server, not that the work is hard.",
        "Check `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD`.",
      )
    out.push("")
  }

  if (intake.outcomes) out.push("## Outcomes", "", intake.outcomes, "")

  out.push(`## Plan — ${intake.items.length} item(s), run in order`, "")
  if (!intake.items.length) out.push("_No items produced. Nothing to approve._", "")
  intake.items.forEach((it, i) => {
    out.push(
      `**${i + 1}. ${it.title}**`,
      `${it.detail}`,
      `- files: ${it.files.length ? it.files.map((f) => `\`${f}\``).join(", ") : "_none predicted — this item may be too vague to implement_"}`,
      `- done when: ${it.acceptance}`,
      "",
    )
  })

  out.push(
    "---",
    `Repo \`${scope.root}\` on \`${scope.branch}\` → PR into \`${cfg.base}\``,
    `Verify: ${cfg.verify.map((v) => `\`${v}\``).join(" && ")}`,
    `Intake cost: ${intake.calls} call(s), ${humanBytes(intake.instructionBytes)} of repo instructions per prompt`,
    "",
    "**Nothing has been written.** Approve to start, or tell me what to change.",
  )
  return out.join("\n")
}

export function applyInit(root: string, cfg: CrewConfig): string[] {
  const written: string[] = []

  const agentsPath = join(root, AGENTS)
  const before = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : ""
  const after = upsertCrewBlock(before, cfg)
  if (after !== before) {
    writeFileSync(agentsPath, after)
    written.push(AGENTS)
  }

  const missing = missingIgnores(root)
  if (missing.length) {
    const path = join(root, ".git", "info", "exclude")
    const prev = existsSync(path) ? readFileSync(path, "utf8") : ""
    const body = prev && !prev.endsWith("\n") ? prev + "\n" : prev
    writeFileSync(path, `${body}# opencode crew\n${missing.join("\n")}\n`)
    written.push(".git/info/exclude")
  }

  return written
}
