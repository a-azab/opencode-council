import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, accessSync, constants } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beadsAvailable, parseTasks, parseStats, safeId, BeadsError } from "./beads.ts"

// beads is a LOCAL cli, so unlike linear.test.ts there is no server to stub - but the same
// rule from tool.test.ts:14 applies: nothing here calls a model, and nothing here mutates a
// real beads database. Execution is separated from parsing precisely so the parsers can be
// asserted against captured `bd --json` output without invoking `bd` at all.

/** `which bd`, without adding a dependency for it. */
function which(cmd: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue
    try {
      accessSync(join(dir, cmd), constants.X_OK)
      return join(dir, cmd)
    } catch {
      /* not here, keep looking */
    }
  }
  return null
}

test("beads is offered only when bd resolves AND the repo is tracked", () => {
  // A repo without .beads/ is not tracked; creating a database uninvited is not ours to do.
  const dir = mkdtempSync(join(tmpdir(), "beads-"))
  try {
    assert.equal(beadsAvailable(dir), false, "no .beads/ means not tracked")
    mkdirSync(join(dir, ".beads"))
    assert.equal(beadsAvailable(dir), Boolean(which("bd")), "with .beads/, it follows bd on PATH")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a single issue comes back wrapped in an array, and is still one task", () => {
  // Measured 2026-08-26: `bd show <id> --json` returns [ {...} ], NOT a bare object. A
  // parser that assumed an object would read `undefined` for every field and report the
  // task as untitled rather than failing.
  const raw = JSON.stringify([
    { id: "oci-infrastructure-73k", title: "Entra ID federation", status: "open", priority: 1 },
  ])
  const tasks = parseTasks(raw)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].id, "oci-infrastructure-73k")
  assert.equal(tasks[0].title, "Entra ID federation")
  assert.equal(tasks[0].status, "open")
  assert.equal(tasks[0].priority, 1)
})

test("no matching issues is an empty list, never an error", () => {
  // `bd list --status in_progress --json` on a board with nothing in flight prints `[]`.
  // orient renders "Nothing in flight." from this; throwing here would drop the section.
  assert.deepEqual(parseTasks("[]"), [])
})

test("unparseable bd output yields no tasks rather than crashing the snapshot", () => {
  // orient degrades section-by-section: a broken tracker read drops its section, never the
  // whole snapshot. That is only possible if the parser refuses to throw.
  for (const junk of ["", "not json", "null", '{"unexpected":"object"}'])
    assert.deepEqual(parseTasks(junk), [], `junk input: ${junk || "(empty)"}`)
})

test("stats reads the counts orient renders, from the nested summary", () => {
  // Measured: bd nests them under `summary`, alongside keys orient does not use.
  const raw = JSON.stringify({
    schema_version: 1,
    summary: { open_issues: 6, in_progress_issues: 0, closed_issues: 7, total_issues: 13 },
  })
  assert.deepEqual(parseStats(raw), { open: 6, inProgress: 0, closed: 7, total: 13 })
})

test("stats without a summary is absent, so orient omits the Project section", () => {
  for (const junk of ["", "not json", "[]", "{}"]) assert.equal(parseStats(junk), null, junk || "(empty)")
})

test("an id that could be read as a flag never reaches the bd command line", () => {
  // detect-task's rule, ported: any id crossing a tracker verb must clear the character
  // class first. execFileSync takes no shell, so this is not about quoting - it is that
  // `bd show --force-something` would be parsed by bd as OPTIONS, not as an id.
  assert.equal(safeId("oci-infrastructure-73k"), "oci-infrastructure-73k")
  assert.equal(safeId("lets-abc.1"), "lets-abc.1")
  for (const bad of ["--claim", "-s", "a b", "a;b", "a$(x)", "", "a`b`", "a|b", "../etc"])
    assert.throws(() => safeId(bad), BeadsError, `must refuse: ${bad}`)
})
