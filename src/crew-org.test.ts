import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { recruitFloor, integrate, renderCrewReport, type CrewResult, type CrewTask } from "./crew-org.ts"

// ------------------------------------------------------------------ recruitFloor

test("recruitFloor wakes infrastructure and security for a terraform directive", () => {
  const roles = recruitFloor("provision the VPC subnets with terraform", ["node"])
  assert.ok(roles.includes("infrastructure"), `no infrastructure lane: ${roles.join(", ")}`)
  assert.ok(roles.includes("security"), `no security lane: ${roles.join(", ")}`)
})

test("recruitFloor wakes security on auth keywords alone", () => {
  for (const directive of [
    "rotate the jwt signing secret",
    "add oauth login to the dashboard",
    "stop logging the session token",
  ]) {
    const roles = recruitFloor(directive, ["node"])
    assert.ok(roles.includes("security"), `"${directive}" did not wake security: ${roles.join(", ")}`)
  }
})

test("recruitFloor always includes reviewer, even for a directive that routes nowhere", () => {
  // The floor's whole job: an unattended run has no human to notice an empty panel.
  const roles = recruitFloor("tidy up", [])
  assert.deepEqual(roles, ["reviewer"])
})

test("recruitFloor wakes qa for test work and architect for new structure", () => {
  assert.ok(recruitFloor("add tests for the parser", ["node"]).includes("qa"))
  assert.ok(recruitFloor("improve test coverage", []).includes("qa"))
  assert.ok(recruitFloor("extract a new service for billing", []).includes("architect"))
  assert.ok(recruitFloor("migrate the store to postgres", []).includes("architect"))
  // ...and does NOT invent an architect for ordinary work
  assert.ok(!recruitFloor("fix the typo in the readme", []).includes("architect"))
})

test("recruitFloor reads the detected stack, not just the directive", () => {
  // `docker` is what detectStack actually emits; ROUTES only knows `Dockerfile`.
  assert.ok(recruitFloor("speed up the build", ["node", "docker"]).includes("infrastructure"))
})

// ------------------------------------------------------------------ integrate

function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "crew-int-"))
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" })
  g("init", "-q", "-b", "main")
  g("config", "user.email", "t@t")
  g("config", "user.name", "t")
  writeFileSync(join(dir, "shared.txt"), "base\n")
  g("add", "-A")
  g("commit", "-qm", "init")
  return dir
}

/** A branch off main that writes `content` to `file`. */
function branchWith(dir: string, name: string, file: string, content: string) {
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" })
  g("checkout", "-q", "-b", name, "main")
  writeFileSync(join(dir, file), content)
  g("add", "-A")
  g("commit", "-qm", `${name}: ${file}`)
  g("checkout", "-q", "main")
}

const gitOut = (dir: string, ...a: string[]) =>
  execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim()

test("integrate merges clean branches in order and reports them", () => {
  const dir = scratchRepo()
  try {
    branchWith(dir, "lets/a", "a.txt", "a\n")
    branchWith(dir, "lets/b", "b.txt", "b\n")
    branchWith(dir, "lets/c", "c.txt", "c\n")
    const r = integrate(dir, "main", ["lets/a", "lets/b", "lets/c"], "crew/int-1")
    assert.equal(r.ok, true)
    assert.equal(r.branch, "crew/int-1")
    assert.deepEqual(r.merged, ["lets/a", "lets/b", "lets/c"], "must report them in the order merged")
    // the branch really carries all three
    const files = gitOut(dir, "ls-tree", "--name-only", "crew/int-1").split("\n")
    for (const f of ["a.txt", "b.txt", "c.txt"]) assert.ok(files.includes(f), `${f} not on the branch`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("integrate stops at the first conflict and names the branch and the files", () => {
  // A conflict is EVIDENCE the scheduler wrongly judged two tasks independent. Resolving it
  // unattended would destroy that evidence, so the only correct behaviour is to stop.
  const dir = scratchRepo()
  try {
    branchWith(dir, "lets/a", "a.txt", "a\n")
    branchWith(dir, "lets/b", "shared.txt", "from b\n")
    branchWith(dir, "lets/c", "shared.txt", "from c\n")
    branchWith(dir, "lets/d", "d.txt", "d\n")
    const r = integrate(dir, "main", ["lets/a", "lets/b", "lets/c", "lets/d"], "crew/int-2")
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.conflicted, "lets/c", "must name the branch that could not merge")
    assert.deepEqual(r.merged, ["lets/a", "lets/b"], "must report exactly what got in before the stop")
    assert.deepEqual(r.files, ["shared.txt"], "must name the conflicted files")
    // and it must NOT have carried on past the conflict
    assert.ok(!r.merged.includes("lets/d"), "merging continued past a conflict")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("integrate leaves no half-merged state behind after a conflict", () => {
  const dir = scratchRepo()
  try {
    branchWith(dir, "lets/b", "shared.txt", "from b\n")
    branchWith(dir, "lets/c", "shared.txt", "from c\n")
    const r = integrate(dir, "main", ["lets/b", "lets/c"], "crew/int-3")
    assert.equal(r.ok, false)
    assert.equal(gitOut(dir, "status", "--porcelain"), "", "the user's checkout must be clean")
    assert.ok(!existsSync(join(dir, ".git", "MERGE_HEAD")), "a merge is still in progress")
    assert.ok(!existsSync(join(dir, ".worktrees", "integrate-crew-int-3")), "the scratch worktree was left behind")
    // the partial branch survives: what merged cleanly is evidence too
    assert.equal(gitOut(dir, "rev-parse", "--verify", "refs/heads/crew/int-3").length, 40)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("integrate refuses to clobber an existing branch", () => {
  const dir = scratchRepo()
  try {
    branchWith(dir, "crew/taken", "x.txt", "x\n")
    assert.throws(() => integrate(dir, "main", [], "crew/taken"), /already exists/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ renderCrewReport

const run = (over: Partial<CrewTask["run"] & object> = {}): NonNullable<CrewTask["run"]> =>
  ({
    branch: "lets/one",
    worktree: "/tmp/wt",
    outcomes: [{ item: { title: "do it", detail: "", files: [], acceptance: "" }, state: "done", attempts: 1, judged: true }],
    cycles: [],
    pushed: false,
    prSkipped: true,
    seconds: 12,
    stoppedBy: "complete",
    ...over,
  }) as any

const base = (over: Partial<CrewResult> = {}): CrewResult => ({
  directive: "do the thing",
  roles: ["reviewer"],
  scheduling: { mode: "graph", ungraphed: [], waves: 1 },
  tasks: [{ title: "One", slug: "one", wave: 1, run: run() }],
  integration: { ok: true, branch: "crew/int", merged: ["lets/one"] },
  verify: { ok: true, output: "ok" },
  adr: "docs/adr/x.md",
  ...over,
})

test("renderCrewReport calls a complete run complete", () => {
  const out = renderCrewReport(base())
  assert.match(out, /\*\*Complete\.\*\*/)
  assert.doesNotMatch(out, /INCOMPLETE/)
})

test("renderCrewReport says INCOMPLETE when a task never ran, and says why", () => {
  // The property the whole design rests on: with no approval gate, the report is the only
  // thing between the user and a bad decision.
  const out = renderCrewReport(
    base({
      tasks: [
        { title: "One", slug: "one", wave: 1, run: run() },
        { title: "Two", slug: "two", wave: 2, skipped: "wave 1 conflicted, so wave 2 was abandoned" },
      ],
    }),
  )
  assert.match(out, /INCOMPLETE/)
  assert.match(out, /never ran/i)
  assert.match(out, /Two/)
  assert.match(out, /wave 1 conflicted, so wave 2 was abandoned/, "a skipped task must carry its reason")
})

test("renderCrewReport says INCOMPLETE when a task ran but missed acceptance", () => {
  const out = renderCrewReport(
    base({
      tasks: [
        {
          title: "One", slug: "one", wave: 1,
          run: run({
            stoppedBy: "item-stuck",
            outcomes: [{ item: { title: "do it", detail: "", files: [], acceptance: "" }, state: "failed-check", attempts: 2 }],
          }),
        },
      ],
    }),
  )
  assert.match(out, /INCOMPLETE/)
  assert.match(out, /failed-check/)
  assert.match(out, /item-stuck/)
})

test("renderCrewReport reports an unjudged acceptance rather than passing it quietly", () => {
  const out = renderCrewReport(
    base({
      tasks: [
        {
          title: "One", slug: "one", wave: 1,
          run: run({
            outcomes: [{ item: { title: "do it", detail: "", files: [], acceptance: "" }, state: "done", attempts: 1, judged: false }],
          }),
        },
      ],
    }),
  )
  assert.match(out, /NOT independently judged/)
})

test("renderCrewReport says a suppressed PR was suppressed, not failed", () => {
  const out = renderCrewReport(base())
  assert.match(out, /No pull request was opened/)
  assert.match(out, /none was attempted/, "must distinguish suppressed from a failed push")
})

test("renderCrewReport surfaces a partial schedule and names the ungraphed files", () => {
  // Otherwise the user never learns why an 8-task run took 8 waves.
  const out = renderCrewReport(
    base({ scheduling: { mode: "partial", ungraphed: ["src/crew.ts", "src/new.ts"], waves: 2 } }),
  )
  assert.match(out, /partial/)
  assert.match(out, /src\/crew\.ts/)
  assert.match(out, /src\/new\.ts/)
  assert.match(out, /parallelises/, "must tell the user rebuilding the graph fixes it")
})

test("renderCrewReport surfaces a sequential schedule and its cause", () => {
  const out = renderCrewReport(base({ scheduling: { mode: "sequential", ungraphed: [], waves: 3 } }))
  assert.match(out, /sequential/)
  assert.match(out, /graph/i)
  assert.match(out, /parallelises/)
})

test("renderCrewReport reports an aborted integration with the conflicting files", () => {
  const out = renderCrewReport(
    base({
      integration: { ok: false, branch: "crew/int", merged: ["lets/one"], conflicted: "lets/two", files: ["shared.txt"] },
      verify: undefined,
    }),
  )
  assert.match(out, /INCOMPLETE/)
  assert.match(out, /lets\/two/)
  assert.match(out, /shared\.txt/)
  assert.match(out, /ABORTED, not resolved/)
})

test("renderCrewReport does not claim success when nothing was verified", () => {
  const out = renderCrewReport(base({ verify: undefined }))
  assert.match(out, /INCOMPLETE/)
  assert.match(out, /never verified/)
})

test("renderCrewReport says so when no ADR was recorded", () => {
  // The ADR is the requirements record; with no approval gate it is the only trace of what
  // the user actually asked for.
  const out = renderCrewReport(base({ adr: undefined }))
  assert.match(out, /No ADR/)
})

