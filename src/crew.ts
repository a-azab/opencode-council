// Crew: a human directive taken through intake, an approved plan, implementation,
// verification and review, to a PR. See PLAN.md §9.
//
// This file is Phase 1a: everything `/crew init` needs to work out what a repo is and
// write that down. No model calls live here - it is deliberately all deterministic, which
// is why it is the part that gets tests.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { selectRoles, type Role } from "./roster.ts"

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
