// The beads adapter, as much of it as the lets session spine needs and no more.
//
// Shaped like linear.ts: hand-rolled, thin, one file to repair when the upstream changes.
// The difference is the transport - beads is a local cli (`bd`), not a GraphQL endpoint -
// so every call here is an execFileSync, never a network round trip. That is what lets the
// orient snapshot stay fast enough to sit on the hot path of four commands.
//
// The exported names are LETS's NEUTRAL VERBS (show / listByStatus / ready / stats /
// commentAdd), not bd's own vocabulary, because the caller is tracker-universal: it asks
// for "the ready ones" and either beads answers or the tracker is `none` and the section is
// omitted. A second adapter slots in here without a single command file changing.
//
// Parsing is deliberately separated from execution. The parsers are pure and asserted
// against captured `bd --json` output in beads.test.ts; nothing in the test suite shells
// out to a real database.

import { execFileSync } from "node:child_process"
import { existsSync, accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { summaryOf } from "./mcp.ts"
import type { ItemOutcome, Tracker, WorkItem, RunResult } from "./lets.ts"

export class BeadsError extends Error {}

export type Task = {
  id: string
  title: string
  status: string
  priority?: number
  description?: string
}

export type Stats = { open: number; inProgress: number; closed: number; total: number }

/** First executable named `cmd` on PATH. No dependency: this is the whole of `which`. */
function which(cmd: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue
    try {
      accessSync(join(dir, cmd), constants.X_OK)
      return join(dir, cmd)
    } catch {
      /* not in this segment */
    }
  }
  return null
}

/**
 * BOTH conditions, and the second is the one with teeth.
 *
 * `bd` on PATH says the tool is installed; `.beads/` says THIS repo opted into it. Treating
 * the binary alone as sufficient would make every repo on the machine "tracked", and the
 * first `bd` write would create a database in a project that never asked for one. Creating
 * that uninvited is not ours to do - so a repo without `.beads/` gets tracker `none`, which
 * is a supported, fully-rendered state rather than an error.
 */
export function beadsAvailable(root: string): boolean {
  return existsSync(join(root, ".beads")) && Boolean(which("bd"))
}

/**
 * Half of the rule above, on its own, so init can tell the two failures apart.
 *
 * "`bd` is not installed" and "`bd` is installed, this repo never opted in" want different
 * things from the human - one is a download, the other is one `bd init` they may not want
 * at all. Collapsing both into "beads unavailable" would hide the actionable one.
 */
export const bdInstalled = () => Boolean(which("bd"))

// Ids reach a second argv here, and `--claim` is a perfectly good match for [A-Za-z0-9._-]+.
// This is not about shell quoting (execFileSync spawns no shell) - it is that bd would parse
// a leading dash as OPTIONS. detect-task states the rule: any id must clear the character
// class before it crosses a tracker verb, whatever its origin.
const ID_SHAPE = /^[A-Za-z0-9._-]+$/

export function safeId(id: string): string {
  if (!id || !ID_SHAPE.test(id) || id.startsWith("-"))
    throw new BeadsError(`unusable task id: ${JSON.stringify(id).slice(0, 60)}`)
  return id
}

/**
 * A tracker read must never be able to take down the snapshot that displays it.
 *
 * orient degrades section-by-section - a missing capability drops ITS section and the rest
 * of the snapshot still renders. That contract is only keepable if a malformed or empty
 * `bd` response parses to "no tasks" instead of throwing.
 */
export function parseTasks(raw: string): Task[] {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  return data
    .filter((t: any) => t && typeof t === "object" && typeof t.id === "string")
    .map((t: any) => ({
      id: t.id,
      title: typeof t.title === "string" ? t.title : "(untitled)",
      status: typeof t.status === "string" ? t.status : "unknown",
      ...(typeof t.priority === "number" ? { priority: t.priority } : {}),
      ...(typeof t.description === "string" ? { description: t.description } : {}),
    }))
}

/** `bd stats --json` nests its counts under `summary`, beside keys orient does not use. */
export function parseStats(raw: string): Stats | null {
  let data: any
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  const s = data?.summary
  if (!s || typeof s !== "object" || Array.isArray(s)) return null
  const n = (v: unknown) => (typeof v === "number" ? v : 0)
  return {
    open: n(s.open_issues),
    inProgress: n(s.in_progress_issues),
    closed: n(s.closed_issues),
    total: n(s.total_issues),
  }
}

/** `--json` is a global flag on bd, so it appends to any subcommand. */
function bdJson(root: string, args: string[]): string {
  try {
    return execFileSync("bd", [...args, "--json"], {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch (e: any) {
    throw new BeadsError(`bd ${args.join(" ")}: ${String(e?.stderr || e?.message).slice(0, 200)}`)
  }
}

/**
 * How a write reaches `bd`, injectable for exactly one reason: the tests must not be able
 * to touch a real database. A fake runner records argv and returns "" — which is also how
 * "the tracker never closes the bead" and "step never shells out" are asserted, since both
 * are claims about what argv is produced, not about what bd does with it.
 */
export type BdRunner = (root: string, args: string[]) => string

function bdRun(root: string, args: string[]): string {
  try {
    return execFileSync("bd", args, { cwd: root, encoding: "utf8", timeout: 15_000 })
  } catch (e: any) {
    throw new BeadsError(`bd ${args[0]}: ${String(e?.stderr || e?.message).slice(0, 200)}`)
  }
}

// --- neutral verbs -----------------------------------------------------------------

/**
 * `bd ready` already computes readiness from the dependency graph - open issues with no
 * unmet blockers, ready ones first. Re-deriving that from `list` would be a worse copy of
 * a correct thing, so the limit is the only thing applied on top.
 */
export function ready(root: string, limit = 5): Task[] {
  return parseTasks(bdJson(root, ["ready", "--limit", String(limit)])).slice(0, limit)
}

export function listByStatus(root: string, status: string): Task[] {
  return parseTasks(bdJson(root, ["list", "--status", safeId(status)]))
}

/** One issue, which bd still returns wrapped in an array. */
export function show(root: string, id: string): Task | null {
  return parseTasks(bdJson(root, ["show", safeId(id)]))[0] ?? null
}

export function stats(root: string): Stats | null {
  return parseStats(bdJson(root, ["stats"]))
}

/**
 * Atomic, sets the assignee, idempotent when it is already yours - which is why this is
 * `--claim` and not `--status in_progress`. Two sessions racing for one task get one
 * winner rather than two claims that both look successful.
 */
export function claim(root: string, id: string): string {
  return bdRun(root, ["update", safeId(id), "--claim"])
}

/** LETS submits bodies as `body-file=`; `--file` is the same idea - markdown survives intact. */
export function noteAdd(root: string, id: string, bodyFile: string, run: BdRunner = bdRun): string {
  return run(root, ["note", safeId(id), "--file", bodyFile])
}

export function commentAdd(root: string, id: string, bodyFile: string): string {
  return bdRun(root, ["comment", safeId(id), "--file", bodyFile])
}

// --- the active task ---------------------------------------------------------------

/**
 * The id prefix THIS database uses, read from its own issues.
 *
 * Needed because `feature/<id>-<slug>` cannot be split without it: a beads prefix contains
 * dashes of its own (`oci-infrastructure-73k`), so nothing about the branch string says
 * where the id stops. Guessing is not an option either — the obvious heuristic, "the id
 * ends at the first segment carrying a digit", looked right against `73k` and `5o2` and
 * then fell over on the very first two ids sampled from real databases,
 * `oci-infrastructure-ovb` and `bdsmoke-etx`. The suffixes are random base36, so roughly a
 * third of all ids have no digit at all and would have silently resolved to None.
 *
 * `issues.jsonl` is bd's own export and every line carries an id, so the first one settles
 * the prefix exactly. Greedy `[A-Za-z0-9._-]+` followed by a dash-free segment lands the
 * split on the LAST dash, which is the one that matters.
 */
function beadsPrefix(root: string): string | null {
  const jsonl = join(root, ".beads", "issues.jsonl")
  if (!existsSync(jsonl)) return null
  // 42KB in the largest database to hand, read once per run. Streaming the first line would
  // be three more moving parts to save a millisecond.
  return readFileSync(jsonl, "utf8").match(/"id":"([A-Za-z0-9._-]+)-[A-Za-z0-9.]+"/)?.[1] ?? null
}

/** `feature/<prefix>-<suffix>-<slug>` → `<prefix>-<suffix>`. No prefix, no guess. */
function branchTask(root: string, branch: string): string | null {
  const prefix = beadsPrefix(root)
  if (!prefix) return null
  const head = `feature/${prefix}-`
  if (!branch.startsWith(head)) return null
  // The id's own segment ends at the next dash, which is where the slug starts.
  const suffix = branch.slice(head.length).split("-")[0]
  return suffix ? `${prefix}-${suffix}` : null
}

/** Empty on a detached HEAD or outside a repo, which is a correct "no answer". */
function currentBranch(root: string): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
  } catch {
    return ""
  }
}

/**
 * The task this run belongs to: the pointer file first, then the branch.
 *
 * **The ordering is load-bearing.** A branch is frozen at the moment it is cut, so it
 * records only the task it was *created* for; a worktree can then host several tasks in
 * sequence and `.lets/sessions/.task-<branch-slug>` is the one that says which is current.
 * Reading the branch first resumes the wrong task — silently, and with a plausible-looking
 * id, so nothing looks wrong until the notes land on last week's bead.
 * (skills/lets-detect-task/SKILL.md, rungs 2 and 3. Rung 1, an explicit id argument, stays
 * with the caller: whoever was handed one never needs to ask.)
 *
 * This exists because `issueIdentifierIn` cannot answer it. Its `/^[A-Z][A-Z0-9]*-\d+$/` is
 * a Linear shape and every beads id fails it, so scraping the directive returned null on
 * every single run. Widening that regex would have been the wrong repair anyway — the run
 * already knows its task, and prose was never the place to look.
 */
export function activeTaskId(root: string): string | null {
  const branch = currentBranch(root)
  // Both sources read before either is chosen, so this is a comparison rather than a
  // fall-through — the branch is the fallback, never the first answer.
  const pointer = join(root, ".lets", "sessions", `.task-${branch.replace(/\//g, "-")}`)
  const fromFile =
    branch && existsSync(pointer)
      ? (readFileSync(pointer, "utf8").match(/^task:[ \t]*(\S+)/m)?.[1] ?? null)
      : null
  const id = fromFile ?? branchTask(root, branch)
  if (!id) return null
  // An id that fails validation is None. `bd close` with no id closes the LAST-TOUCHED
  // issue instead of erroring, so a pointer file someone hand-edited to `--claim` must die
  // here rather than become a flag on a second argv.
  try {
    return safeId(id)
  } catch {
    return null
  }
}

// --- the tracker -------------------------------------------------------------------

/** `bd note --file` wants a path; a run has a string. One temp file, removed either way. */
function note(root: string, id: string, body: string, run: BdRunner): void {
  const dir = mkdtempSync(join(tmpdir(), "lets-note-"))
  try {
    const file = join(dir, "note.md")
    writeFileSync(file, body.endsWith("\n") ? body : `${body}\n`)
    noteAdd(root, id, file, run)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Mirrors a run onto the bead it belongs to.
 *
 * **Sparse on purpose.** A beads note is append-only into the user's real database, unlike
 * Linear's progress activity which is ephemeral and replaces itself. So this is one note
 * per lifecycle event — start, each item, finish — and never one per step. A per-step note
 * would bury the bead's history under a run's stdout.
 *
 * **It never closes the bead.** `/lets:done` owns that transition, and a run finishing is
 * not a task finishing: the run can end `item-stuck` with half the work undone, and even a
 * clean run only means the branch is ready, not that the task is accepted.
 */
export function beadsTracker(
  root: string,
  id: string,
  onStep: (m: string) => void,
  run: BdRunner = bdRun,
): Tracker {
  return {
    name: "beads",

    async start({ directive, items, branch }: { directive: string; items: WorkItem[]; branch: string }) {
      note(
        root,
        id,
        [`**lets run started** on \`${branch}\``, "", directive, "", `${items.length} item(s) planned.`].join("\n"),
        run,
      )
      onStep(`  tracker(beads): mirroring onto ${id}`)
    },

    /**
     * Deliberately does nothing. `bd` is a shell-out, and this is the one hook that is both
     * sync and unprotected: `guarded()` swallows a step() throw with NO warning line, so a
     * failure here would be invisible as well as slow. The terminal still gets the line —
     * `trackerFor` fans this tracker out alongside a `stdoutTracker` that already prints it.
     */
    step(_message: string) {},

    async itemDone(o: ItemOutcome) {
      note(
        root,
        id,
        [
          `**${o.item.title}** — ${o.state}`,
          o.commit ? `commit \`${o.commit}\`` : "",
          o.detail ? o.detail : "",
        ]
          .filter(Boolean)
          .join("\n"),
        run,
      )
    },

    async finish(result: RunResult) {
      // summaryOf is the mcp tracker's — outcome counts, why it stopped, the PR link.
      // Shared rather than re-rendered so the two trackers cannot drift into disagreeing
      // about the same run. Note what happened; do NOT touch the bead's status.
      note(root, id, summaryOf(result), run)
    },
  }
}
