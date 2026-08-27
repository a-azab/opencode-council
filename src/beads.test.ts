import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, accessSync, constants } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  beadsAvailable,
  parseTasks,
  parseStats,
  safeId,
  activeTaskId,
  beadsTracker,
  BeadsError,
  type BdRunner,
} from "./beads.ts"
import { availableTrackers, type RunResult, type WorkItem } from "./lets.ts"
import { issueIdentifierIn } from "./linear.ts"

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

// ------------------------------------------------------------------ the active task

/**
 * A scratch repo, never the user's real database.
 *
 * `/root/code/FundMe/oci-infrastructure` has real issues in it; every test below either
 * works on a temp dir or drives the tracker through an injected runner that records argv
 * instead of spawning `bd`. Nothing here writes to a `.beads/` anywhere.
 */
function repo(branch: string, task?: string, prefix?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "beads-task-"))
  execFileSync("git", ["init", "-q", "-b", branch], { cwd: dir })
  if (prefix) {
    // One line of bd's own export, which is where the id prefix is read from. `ovb` is
    // shaped like the real suffixes: random base36, and in this case digit-free.
    mkdirSync(join(dir, ".beads"), { recursive: true })
    writeFileSync(join(dir, ".beads", "issues.jsonl"), `{"_type":"issue","id":"${prefix}-ovb","title":"x"}\n`)
  }
  if (task !== undefined) {
    mkdirSync(join(dir, ".lets", "sessions"), { recursive: true })
    // The exact bytes /lets:start writes — `printf 'task: %s\nstart: %s\n'`.
    writeFileSync(
      join(dir, ".lets", "sessions", `.task-${branch.replace(/\//g, "-")}`),
      `task: ${task}\nstart: 0f1e2d3\n`,
    )
  }
  return dir
}

const clean = (...dirs: string[]) => dirs.forEach((d) => rmSync(d, { recursive: true, force: true }))

test("a beads id resolves where the Linear-shaped regex fails", () => {
  // oci-infrastructure-73k is a real id from the user's database. issueIdentifierIn's
  // /^[A-Z][A-Z0-9]*-\d+$/ rejects it, which is why the run reads the pointer file instead.
  // Before this, `tracker: beads` would take the issueRef: null branch on EVERY run and
  // degrade to terminal-only without ever saying why.
  assert.equal(issueIdentifierIn("oci-infrastructure-73k"), null, "fixture: the old path cannot see it")
  const dir = repo("feature/oci-infrastructure-73k-entra-federation", "oci-infrastructure-73k")
  try {
    assert.equal(activeTaskId(dir), "oci-infrastructure-73k")
  } finally {
    clean(dir)
  }
})

test("the pointer file outranks the branch", () => {
  // A branch is frozen when cut; a worktree can host several tasks in sequence. Branch-first
  // resumes the wrong task silently — and with a plausible-looking id, so nothing looks off
  // until the notes land on last week's bead.
  const dir = repo("feature/oci-infrastructure-73k-entra-federation", "oci-infrastructure-5o2", "oci-infrastructure")
  const branchOnly = repo("feature/oci-infrastructure-73k-entra-federation", undefined, "oci-infrastructure")
  try {
    // Without this the test would pass for the wrong reason: prove the branch really does
    // resolve, and to something ELSE, before claiming the file outranks it.
    assert.equal(activeTaskId(branchOnly), "oci-infrastructure-73k", "fixture: the branch is readable on its own")
    assert.equal(activeTaskId(dir), "oci-infrastructure-5o2", "the file says which task is CURRENT")
  } finally {
    clean(dir, branchOnly)
  }
})

test("the branch is the fallback, and None is a correct answer", () => {
  // detect-task's ladder, minus the explicit-argument rung the caller owns. The split needs
  // the database's own prefix: `oci-infrastructure` has dashes in it, so a naive "first two
  // fields" read returns `oci-infrastructure`, which is not an id at all.
  const digity = repo("feature/oci-infrastructure-73k-entra-federation", undefined, "oci-infrastructure")
  const digitless = repo("feature/oci-infrastructure-ovb-nat-gateway", undefined, "oci-infrastructure")
  const untracked = repo("feature/48647-lifecycle-test")
  const plain = repo("main", undefined, "oci-infrastructure")
  const empty = repo("feature/oci-infrastructure-5o2-thing", "", "oci-infrastructure")
  try {
    assert.equal(activeTaskId(digity), "oci-infrastructure-73k")
    // Both suffixes sampled from real databases — oci-infrastructure-ovb, bdsmoke-etx —
    // turned out to be digit-free. bd's suffixes are random base36, so "the id ends at the
    // first segment carrying a digit" silently resolves roughly a third of all ids to None.
    assert.equal(activeTaskId(digitless), "oci-infrastructure-ovb", "a digit-free suffix is an ordinary id")
    assert.equal(activeTaskId(plain), null, "not a feature/ branch: None")
    // detect-task: do not apply a beads-shaped pattern to a repo whose tracker is not beads.
    // On `feature/48647-lifecycle-test` that would capture `lifecycle-test`, not `48647`.
    // No .beads/ means no prefix means no guess — and index.ts then falls back to
    // issueIdentifierIn, which is exactly how linear resolved before any of this.
    assert.equal(activeTaskId(untracked), null, "an untracked repo yields nothing from the branch")
    assert.equal(activeTaskId(empty), "oci-infrastructure-5o2", "an empty pointer falls through, it does not win")
  } finally {
    clean(digity, digitless, untracked, plain, empty)
  }
})

test("an id that reads as a flag never escapes activeTaskId", () => {
  // `bd close` with no id closes the LAST-TOUCHED issue rather than erroring, so a pointer
  // file containing `--claim` must resolve to None here, not travel to a second argv.
  const dir = repo("main", "--claim")
  try {
    assert.equal(activeTaskId(dir), null)
  } finally {
    clean(dir)
  }
})

test("beads is offered only when bd resolves and the repo is tracked", () => {
  const dir = mkdtempSync(join(tmpdir(), "beads-avail-"))
  const env = {} as NodeJS.ProcessEnv
  try {
    assert.equal(availableTrackers(env, dir).includes("beads"), false, "no .beads/ means not tracked")
    mkdirSync(join(dir, ".beads"))
    assert.equal(availableTrackers(env, dir).includes("beads"), Boolean(which("bd")), "then it follows bd on PATH")
    // repoRoot is optional on this signature, and beads cannot be available without one:
    // there is no repo to check for .beads/, and assuming the cwd would offer a tracker
    // that writes into whichever database happened to be underfoot.
    assert.equal(availableTrackers(env).includes("beads"), false, "no repoRoot: not available, honestly")
  } finally {
    clean(dir)
  }
})

// ------------------------------------------------------------------ the tracker

/** Records argv instead of spawning `bd`, and reads back whatever body was handed to --file. */
function fakeBd(): { calls: { args: string[]; body: string }[]; run: BdRunner } {
  const calls: { args: string[]; body: string }[] = []
  return {
    calls,
    run: (_root, args) => {
      const i = args.indexOf("--file")
      calls.push({ args, body: i === -1 ? "" : readFileSync(args[i + 1], "utf8") })
      return ""
    },
  }
}

const workItem = (title: string): WorkItem => ({ title, detail: "d", files: ["a.ts"], acceptance: "it works" })

const runResult = (over: Partial<RunResult> = {}): RunResult => ({
  branch: "feature/oci-infrastructure-73k-entra-federation",
  worktree: "/tmp/wt",
  outcomes: [
    { item: workItem("wire the federation"), state: "done", attempts: 1, commit: "abc1234" },
    { item: workItem("document it"), state: "unmet", attempts: 2, detail: "acceptance not met" },
  ],
  cycles: [],
  pushed: true,
  seconds: 91,
  stoppedBy: "item-stuck",
  ...over,
})

test("the tracker never closes the bead", async () => {
  // finish() reports; /lets:done closes. A run finishing is not a task finishing — and
  // `bd close` is irreversible-ish in a way a mirror has no business being.
  const { calls, run } = fakeBd()
  const t = beadsTracker("/tmp/nowhere", "oci-infrastructure-73k", () => {}, run)
  await t.start({ directive: "add a dark mode toggle", items: [workItem("wire the federation")], branch: "feature/x" })
  await t.itemDone(runResult().outcomes[0])
  await t.finish(runResult())

  assert.ok(calls.length > 0, "it must actually mirror something")
  for (const c of calls) {
    assert.equal(c.args[0], "note", `notes only, got: bd ${c.args.join(" ")}`)
    for (const verb of ["close", "update", "--claim", "--status"])
      assert.ok(!c.args.includes(verb), `must never reach bd: ${verb}`)
  }
})

test("one note per lifecycle event, never one per step", async () => {
  // Notes are append-only into a real database, unlike Linear's progress line which is
  // ephemeral and replaces itself. Sparse is the whole discipline here.
  const { calls, run } = fakeBd()
  const t = beadsTracker("/tmp/nowhere", "oci-infrastructure-73k", () => {}, run)
  const r = runResult({ prUrl: "https://github.com/o/r/pull/7" })

  await t.start({ directive: "wire Entra federation", items: r.outcomes.map((o) => o.item), branch: r.branch })
  for (const o of r.outcomes) await t.itemDone(o)
  await t.finish(r)

  assert.equal(calls.length, 4, "start + 2 items + finish, and nothing else")
  for (const c of calls) assert.equal(c.args[1], "oci-infrastructure-73k", "every note lands on the bead")

  assert.match(calls[0].body, /wire Entra federation/, "start carries the directive")
  assert.match(calls[0].body, /entra-federation/, "…the branch")
  assert.match(calls[0].body, /2/, "…and the item count")

  assert.match(calls[1].body, /wire the federation/, "itemDone carries the title")
  assert.match(calls[1].body, /done/, "…the state")
  assert.match(calls[1].body, /abc1234/, "…and the commit sha")
  assert.match(calls[2].body, /unmet/, "a stuck item reports as stuck, not as silence")

  assert.match(calls[3].body, /1\/2/, "finish carries the outcome counts")
  assert.match(calls[3].body, /item-stuck/, "…why it stopped")
  assert.match(calls[3].body, /pull\/7/, "…and the PR link")
})

test("step never shells out", async () => {
  // step() is sync and guarded() swallows its throws with no warning line, so a shell-out
  // there is both slow and silently fragile. The terminal line for a step comes from the
  // stdoutTracker that trackerFor fans out alongside this one.
  const { calls, run } = fakeBd()
  const t = beadsTracker("/tmp/nowhere", "oci-infrastructure-73k", () => {}, run)
  for (let i = 0; i < 50; i++) t.step(`step ${i}`)
  assert.equal(calls.length, 0, "50 steps, zero bd invocations")
})

test("a linear repo keeps scraping the directive, even when .beads/ exists", () => {
  // Resolving beads-first for every tracker would hand Linear a beads id in a repo that has
  // both: findIssue misses, linearTracker prints "not found - continuing without it", and a
  // mirror that used to work quietly stops. The ref is chosen per tracker, so this is a
  // source-level guard on that branch surviving.
  const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  const at = src.indexOf("issueRef:")
  assert.ok(at > -1, "the issueRef resolution must still exist")
  const block = src.slice(at, at + 220)
  assert.match(block, /tracker === "beads"/, "beads must be the condition, not the default")
  assert.match(block, /issueIdentifierIn/, "every other tracker must keep the directive scrape")
})
