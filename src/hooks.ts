// A preventive gate for the one model in this plugin that holds `edit` and `bash`.
//
// `docs/adr/2026-09-20-runtime-hooks-for-the-implementer.md` proposed this and measured
// that the mechanism works: opencode runs `tool.execute.before` ahead of the tool, a throw
// blocks it, the refusal reaches the model as a readable tool result, and it applies to
// sessions spawned over HTTP - which is how `lets` drives its implementer. Nothing was
// built at the time. This is that gate.
//
// What it is NOT: a sandbox. A determined model can obfuscate a command past any pattern
// match, and a guard that claimed otherwise would be worse than none because it invites
// trust it cannot carry. Confinement (`external_directory: deny`) answers *where* and the
// server enforces it; this answers *what*, for the specific destructive actions that
// defeat the run's own gates.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** A refusal: what was caught, and why it is refused. */
export type Refusal = { pattern: string; reason: string }

/**
 * Commands refused for the implementer, with the reason the model is told.
 *
 * Each entry exists because it defeats a gate this harness depends on, not because it is
 * broadly dangerous. `rm -rf /` is catastrophic but the worktree confinement already makes
 * it local; `git commit --no-verify` is mundane and skips the exact hook chain the repo
 * relies on to keep itself honest.
 */
export const REFUSED: { test: RegExp; pattern: string; reason: string }[] = [
  {
    // Two separate alternatives, each anchored on `git commit`, because a single greedy
    // `[^\n]*` before the flag consumes the very flag it is looking for: the long form
    // `--no-verify` was silently ALLOWED while the short `-n` matched, which is the worst
    // of both - a guard that reports working while passing the common case straight
    // through. `-n` is matched only as its own token so `-m` and `--name-only` are safe.
    test: /\bgit\s+commit\b(?=[^\n]*\s--no-verify\b)|\bgit\s+commit\b(?=[^\n]*\s-[a-zA-Z]*n[a-zA-Z]*(?:\s|$))/,
    pattern: "git commit --no-verify",
    reason:
      "committing with --no-verify skips the repo's own pre-commit checks. If a check is failing, fix the cause or report it as a blocker - do not bypass the gate.",
  },
  {
    test: /\bgit\s+push\b[^\n]*(--force\b(?!-with-lease)|(?:^|\s)-f(?:\s|$))/,
    pattern: "git push --force",
    reason:
      "a force push discards commits that are not yours to discard. crew and lets integrate locally and leave pushing to a human.",
  },
  {
    test: /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f)/,
    pattern: "git reset --hard / git clean -f",
    reason:
      "this destroys uncommitted work in the worktree, including work you have not reported yet. If you need a clean state, say what is in the way instead.",
  },
  {
    test: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/,
    pattern: "rm -rf",
    reason:
      "recursive force delete. Remove specific files you can name, or explain what needs removing and why.",
  },
  {
    test: /\.github\/workflows\/|\.github\\workflows\\/,
    pattern: "editing .github/workflows/",
    reason:
      "CI workflows are a gate on this repo, and a worker that edits the gate it is being judged by has removed the judge. If CI is wrong, report it.",
  },
  {
    test: /\bgit\s+checkout\b[^\n]*\s(master|main)\b|\bgit\s+switch\s+(master|main)\b/,
    pattern: "switching to master/main",
    reason:
      "you work in an isolated worktree on your own branch. Switching to the base branch takes your changes somewhere nobody is looking for them.",
  },
]

/**
 * Why this command is refused, or null to allow it.
 *
 * Deliberately a denylist over an allowlist. An allowlist of safe commands sounds stricter
 * and is unusable: the implementer legitimately runs arbitrary build, test and inspection
 * commands that nobody can enumerate in advance, so an allowlist would refuse real work
 * every day and be switched off within a week. A denylist refuses less and survives.
 */
export function refusalFor(command: string, extra: typeof REFUSED = []): Refusal | null {
  const cmd = String(command ?? "")
  if (!cmd.trim()) return null
  for (const r of [...REFUSED, ...extra]) if (r.test.test(cmd)) return { pattern: r.pattern, reason: r.reason }
  return null
}

/** Project-local guard configuration, as read from `.claude/settings.json`. */
export type GuardSettings = {
  /** Off entirely. Present so a repo can opt out without deleting the file that documents the policy. */
  enabled: boolean
  /** Extra refusals this project wants, as `{ pattern, reason }` with `pattern` a regex source. */
  refuse: { test: RegExp; pattern: string; reason: string }[]
  /** Where the settings came from, for an honest report. */
  source: string
}

/**
 * Read `.claude/settings.json`, tolerating every way it can be wrong.
 *
 * A malformed settings file must not take down the plugin: the guard degrades to its
 * built-in refusals and says where it got them. Failing closed here would mean a typo in
 * a config file stops all work, and failing silently would mean a project believes its
 * custom rules are live when they never parsed.
 */
export function readGuardSettings(repoRoot: string): GuardSettings {
  const path = join(repoRoot, ".claude", "settings.json")
  const fallback: GuardSettings = { enabled: true, refuse: [], source: "built-in defaults" }
  if (!existsSync(path)) return fallback
  let raw: any
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return { ...fallback, source: `${path} (unparseable - using built-in defaults)` }
  }
  const g = raw?.hooks?.guard ?? raw?.guard
  if (!g || typeof g !== "object") return { ...fallback, source: `${path} (no guard section)` }
  const refuse: GuardSettings["refuse"] = []
  for (const entry of Array.isArray(g.refuse) ? g.refuse : []) {
    if (!entry?.pattern || !entry?.reason) continue
    try {
      refuse.push({ test: new RegExp(String(entry.pattern)), pattern: String(entry.pattern), reason: String(entry.reason) })
    } catch {
      // An invalid regex is skipped, never thrown: one bad rule must not disable the rest.
    }
  }
  return { enabled: g.enabled !== false, refuse, source: path }
}

/**
 * Sessions this plugin spawned.
 *
 * The load-bearing detail, and ADR risk 1: `tool.execute.before` receives a `sessionID` but
 * no directory and no agent, so a hook cannot otherwise tell the implementer apart from the
 * human's own session on the same shared server. Guarding everything would mean this
 * plugin silently refusing the user's own `rm -rf`, in their own terminal, for a policy
 * they never opted into.
 *
 * So the plugin records the sessions it creates, and the guard applies to exactly those.
 *
 * ON DISK, not in a module-level Set. Measured 2026-09-24: a Set here is per-PROCESS, and
 * the two halves of this mechanism do not always share one. When `lets` runs inside the
 * opencode server they do; when anything drives `ask()` from another process - a script, a
 * test harness, a second server - the registration lands in one process and the hook reads
 * an empty Set in another, so `isPluginSession` is always false and the guard never fires.
 * A gate that silently does nothing is worse than no gate, because the ADR, the tests and
 * the commit message all say it is protecting you.
 *
 * The file lives in the OS temp dir because this is ephemeral coordination state between
 * two halves of one machine, not something a repo should carry or a user should clean up.
 */
const REGISTRY = join(tmpdir(), "opencode-council-sessions.json")

/** How long a registration is believed. A crashed run must not guard an id forever. */
export const REGISTRY_TTL_MS = 6 * 60 * 60 * 1000

function readRegistry(): Record<string, number> {
  try {
    const raw = JSON.parse(readFileSync(REGISTRY, "utf8"))
    return raw && typeof raw === "object" ? raw : {}
  } catch {
    return {}
  }
}

function writeRegistry(data: Record<string, number>): void {
  try {
    writeFileSync(REGISTRY, JSON.stringify(data))
  } catch {
    /* coordination is best-effort: a read-only tmp must not take the run down */
  }
}

export function rememberSession(id: string): void {
  if (!id) return
  const data = readRegistry()
  const cutoff = Date.now() - REGISTRY_TTL_MS
  // Expiry on write, so a crashed run's ids drain without anything running on a timer.
  for (const [k, at] of Object.entries(data)) if (typeof at !== "number" || at < cutoff) delete data[k]
  data[id] = Date.now()
  writeRegistry(data)
}

export function forgetSession(id: string): void {
  if (!id) return
  const data = readRegistry()
  if (!(id in data)) return
  delete data[id]
  writeRegistry(data)
}

export function isPluginSession(id: string): boolean {
  if (!id) return false
  const at = readRegistry()[id]
  return typeof at === "number" && Date.now() - at <= REGISTRY_TTL_MS
}

/** Test seam only. */
export const spawnedCount = (): number => Object.keys(readRegistry()).length
/** Test seam only: drop every registration. */
export const clearSessions = (): void => writeRegistry({})
