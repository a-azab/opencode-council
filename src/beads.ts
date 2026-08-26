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
import { existsSync, accessSync, constants } from "node:fs"
import { join } from "node:path"

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
export function noteAdd(root: string, id: string, bodyFile: string): string {
  return bdRun(root, ["note", safeId(id), "--file", bodyFile])
}

export function commentAdd(root: string, id: string, bodyFile: string): string {
  return bdRun(root, ["comment", safeId(id), "--file", bodyFile])
}
