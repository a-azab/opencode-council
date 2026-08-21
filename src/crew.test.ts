import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, realpathSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  parseCrewBlock,
  renderCrewBlock,
  upsertCrewBlock,
  resolveScope,
  detectStack,
  detectVerifyCandidates,
  proposeLanes,
  graphState,
  missingIgnores,
  proposeInit,
  applyInit,
  commitMessage,
  runVerify,
  installIfDepsChanged,
  openWorktree,
  worktreeChanges,
  closeWorktree,
  listWorktrees,
  renderWorktrees,
  renderRun,
  type ItemOutcome,
  type RunResult,
  CREW_IGNORES,
  type CrewConfig,
  type WorkItem,
} from "./crew.ts"

const CFG: CrewConfig = {
  verify: ["npm test", "npm run lint"],
  base: "develop",
  lanes: ["code", "qa", "reviewer"],
}

test("a config survives a render/parse round trip", () => {
  assert.deepEqual(parseCrewBlock(renderCrewBlock(CFG)), CFG)
})

test("no crew block parses to nothing, not to defaults", () => {
  // A missing block and an empty block must be distinguishable from a configured one,
  // or init cannot tell "never run here" from "configured with blanks".
  assert.deepEqual(parseCrewBlock("# AGENTS\n\nSome prose.\n"), {})
})

test("comments and blank lines inside the block are ignored", () => {
  const md = "```crew\n# what to run\nverify: npm test\n\nbase: main\n```"
  assert.deepEqual(parseCrewBlock(md), { verify: ["npm test"], base: "main" })
})

test("upsert appends a section when the file has none", () => {
  const out = upsertCrewBlock("# AGENTS\n\nHouse rules.\n", CFG)
  assert.ok(out.startsWith("# AGENTS\n\nHouse rules."), "existing prose must lead")
  assert.deepEqual(parseCrewBlock(out), CFG)
})

test("upsert replaces the block in place and touches nothing else", () => {
  // The whole point of the fence. A regression here rewrites a file the user's team
  // reviews, which is the most damaging thing this tool could do.
  const before = `# AGENTS

Rules above.

## Crew

\`\`\`crew
verify: old command
base: master
lanes: reviewer
\`\`\`

## Something the user wrote after

Prose below that must survive.
`
  const after = upsertCrewBlock(before, CFG)
  assert.deepEqual(parseCrewBlock(after), CFG)
  assert.ok(after.includes("Rules above."))
  assert.ok(after.includes("Prose below that must survive."))
  assert.ok(after.includes("## Something the user wrote after"))
  assert.ok(!after.includes("old command"))
  assert.equal(after.match(/```crew/g)?.length, 1, "must not accumulate blocks")
})

test("upsert is idempotent", () => {
  const once = upsertCrewBlock("# AGENTS\n", CFG)
  assert.equal(upsertCrewBlock(once, CFG), once)
})

test("resolveScope reports a non-repo instead of throwing", () => {
  assert.deepEqual(resolveScope("/"), { kind: "notrepo" })
})

test("resolveScope finds the enclosing repo from a subdirectory", () => {
  // Asserted against git's own answer rather than a directory name. The name check that
  // was here failed inside a worktree (`.worktrees/probe`) — which is exactly where the
  // crew runs its own tests, so it would have failed on every run.
  const here = new URL(".", import.meta.url).pathname
  const scope = resolveScope(here)
  assert.equal(scope.kind, "ok")
  if (scope.kind !== "ok") return
  const expected = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: here, encoding: "utf8" }).trim()
  assert.equal(scope.root, expected)
  assert.ok(existsSync(join(scope.root, "package.json")))
  assert.ok(Array.isArray(scope.dirty))
})

test("detectStack recognises this repo as node", () => {
  const root = new URL("..", import.meta.url).pathname
  assert.ok(detectStack(root).includes("node"))
})

test("verify candidates carry a reason and never collapse to a guess", () => {
  const root = new URL("..", import.meta.url).pathname
  const found = detectVerifyCandidates(root)
  assert.ok(found.length >= 1, "this repo has a test script")
  for (const c of found) assert.ok(c.why.length > 0, `candidate without a reason: ${c.command}`)
})

test("a directory with no manifests yields no candidates", () => {
  assert.deepEqual(detectVerifyCandidates("/nonexistent"), [])
})

test("nx repos are offered the affected-only command first", () => {
  // The narrowing that keeps a monorepo run from taking an hour. Ordering matters: the
  // caller shows candidates in order and the first is the recommendation, so a whole-
  // workspace command winning here would silently cost an hour a run.
  const dir = mkdtempSync(join(tmpdir(), "crew-nx-"))
  try {
    writeFileSync(join(dir, "nx.json"), "{}")
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "jest" } }))
    const found = detectVerifyCandidates(dir, "develop")
    assert.match(found[0].command, /nx affected/, `first candidate was ${found[0].command}`)
    assert.match(found[0].command, /--base=develop/, "must target the configured base")
    assert.ok(
      found.some((c) => c.command === "npm run test"),
      "the whole-workspace fallbacks must still be offered",
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("proposeLanes always includes reviewer", () => {
  const root = new URL("..", import.meta.url).pathname
  const lanes = proposeLanes(root)
  assert.ok(lanes.includes("reviewer"), `${lanes}`)
})

test("proposeLanes degrades to reviewer outside a repo rather than throwing", () => {
  assert.deepEqual(proposeLanes("/nonexistent"), ["reviewer"])
})

test("graphState reports missing when there is no graph", () => {
  assert.deepEqual(graphState("/nonexistent"), { kind: "missing" })
})

test("missingIgnores lists everything when the exclude file is absent", () => {
  assert.deepEqual(missingIgnores("/nonexistent"), CREW_IGNORES)
})

/** A throwaway repo, so the write-path tests touch nothing real. */
function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "crew-repo-"))
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir })
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir })
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir })
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "true" } }))
  execFileSync("git", ["add", "-A"], { cwd: dir })
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir })
  return dir
}

test("applyInit writes both files and is idempotent", () => {
  const dir = scratchRepo()
  try {
    const cfg: CrewConfig = { verify: ["npm test"], base: "main", lanes: ["reviewer"] }

    const first = applyInit(dir, cfg)
    assert.deepEqual(first.sort(), [".git/info/exclude", "AGENTS.md"])
    assert.deepEqual(parseCrewBlock(readFileSync(join(dir, "AGENTS.md"), "utf8")), cfg)
    const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8")
    for (const line of CREW_IGNORES) assert.ok(exclude.includes(line), `missing ignore: ${line}`)

    // Re-init must be a no-op, not a duplicate append. Init is expected to be re-run.
    assert.deepEqual(applyInit(dir, cfg), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("applyInit preserves prose the user wrote in AGENTS.md", () => {
  const dir = scratchRepo()
  try {
    const prose = "# AGENTS\n\nNever commit to main. Money is integers.\n"
    writeFileSync(join(dir, "AGENTS.md"), prose)
    applyInit(dir, { verify: ["npm test"], base: "main", lanes: ["reviewer"] })
    applyInit(dir, { verify: ["npm run ci"], base: "develop", lanes: ["qa"] })
    const after = readFileSync(join(dir, "AGENTS.md"), "utf8")
    assert.ok(after.includes("Never commit to main. Money is integers."))
    assert.equal(after.match(/```crew/g)?.length, 1)
    assert.deepEqual(parseCrewBlock(after), { verify: ["npm run ci"], base: "develop", lanes: ["qa"] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- phase 2

const item = (over: Partial<WorkItem> = {}): WorkItem => ({
  title: "add rate limiting",
  detail: "",
  files: ["apps/partner-service/src/auth/guard.ts"],
  acceptance: "6 failed attempts in 60s returns 429",
  ...over,
})

test("commit scope comes from the item's directory, not its filename", () => {
  assert.equal(commitMessage(item()), "feat(auth): add rate limiting")
  // A root file has no component to name; `feat(README): ...` would read as though README
  // were one.
  assert.equal(commitMessage(item({ files: ["README.md"] })), "feat: add rate limiting")
  assert.equal(commitMessage(item({ files: [] })), "feat: add rate limiting")
})

test("an already-conventional title is not double-prefixed", () => {
  assert.equal(commitMessage(item({ title: "fix(auth): stop the leak" })), "feat(auth): stop the leak")
})

test("runVerify runs every command and names the one that broke", () => {
  assert.deepEqual(runVerify(tmpdir(), ["true", "true"]), { ok: true, output: "all 2 check(s) passed" })

  const r = runVerify(tmpdir(), ["true", "echo boom >&2; false", "echo never"])
  assert.equal(r.ok, false)
  assert.match(r.output, /echo boom/, "must name the failing command, not just fail")
  assert.match(r.output, /boom/, "must carry the command's own output as feedback")
  assert.ok(!r.output.includes("never"), "must stop at the first failure")
})

test("dependency install only fires when a manifest actually changed", () => {
  // The symlinked node_modules is a known, commented ceiling: an item that changes
  // dependencies verifies against the parent's versions and can pass for the wrong reason.
  // This guard is the thing that keeps that from being silent.
  assert.equal(installIfDepsChanged("/nonexistent", ["src/a.ts", "docs/b.md"]), null)
  assert.equal(installIfDepsChanged("/nonexistent", ["apps/api/src/deep/package.json"]), null,
    "no lockfile present means nothing to install")
})

test("the symlinked node_modules counts as neither a change nor work to commit", () => {
  // Measured before this guard existed: the symlink showed as untracked, `git add -A`
  // committed it, and the no-change check read it as real work — so a worker that changed
  // nothing was indistinguishable from one that did.
  const dir = scratchRepo()
  try {
    // openWorktree only symlinks node_modules when the parent has one.
    mkdirSync(join(dir, "node_modules"), { recursive: true })

    const { path: wt, branch } = openWorktree(dir, "excl")
    try {
      assert.match(
        execFileSync("git", ["status", "--porcelain"], { cwd: wt, encoding: "utf8" }),
        /node_modules/,
        "precondition: git does see the symlink",
      )
      assert.deepEqual(worktreeChanges(wt), [], "but the crew must not")

      writeFileSync(join(wt, "real.txt"), "work\n")
      assert.deepEqual(worktreeChanges(wt), ["?? real.txt"])

      execFileSync("git", ["add", "-A", "--", ".", ":(exclude)node_modules"], { cwd: wt })
      const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: wt, encoding: "utf8" })
        .split("\n")
        .filter(Boolean)
      assert.deepEqual(staged, ["real.txt"])
    } finally {
      closeWorktree(dir, wt)
      try {
        execFileSync("git", ["branch", "-D", branch], { cwd: dir, stdio: "ignore" })
      } catch {}
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("listWorktrees returns the crew's own worktrees and never the repo's main one", () => {
  const dir = scratchRepo()
  try {
    const alpha = openWorktree(dir, "alpha")
    const beta = openWorktree(dir, "beta")
    try {
      const live = listWorktrees(dir)
      assert.deepEqual(
        live.map((w) => w.slug).sort(),
        ["alpha", "beta"],
        "exactly the two worktrees openWorktree made",
      )
      assert.deepEqual(live.map((w) => w.branch).sort(), ["crew/alpha", "crew/beta"])
      for (const w of live) assert.ok(w.ageMs >= 0, `${w.slug} reported age ${w.ageMs}`)

      // The list drives deletion, so the working tree the human is standing in must be absent.
      const main = realpathSync(dir)
      assert.ok(!live.some((w) => realpathSync(w.path) === main), `main worktree ${main} was listed`)

      assert.match(renderWorktrees(live), /git worktree remove .*alpha --force/)
      assert.match(renderWorktrees([]), /No live crew worktrees/)
    } finally {
      closeWorktree(dir, alpha.path)
      closeWorktree(dir, beta.path)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- phase 3

const CFG3: CrewConfig = { verify: ["npm test"], base: "master", lanes: ["reviewer"] }
const run = (over: Partial<RunResult> = {}): RunResult => ({
  branch: "crew/x",
  worktree: "/w",
  outcomes: [],
  cycles: [],
  stoppedBy: "complete",
  seconds: 10,
  ...over,
})
const done = (t: string): ItemOutcome => ({ item: item({ title: t }), state: "done", attempts: 1, commit: "abc" })

test("a run is only 'Done' when nothing is outstanding", () => {
  // The honesty property. Reporting a partial run as done is the single most damaging
  // thing this can do: the human stops looking, and the gaps ship.
  assert.match(renderRun(run({ outcomes: [done("one")] }), CFG3), /\*\*Done\*\*/)

  for (const state of ["failed-check", "unmet", "no-change", "model-failed"] as const) {
    const out = renderRun(
      run({
        outcomes: [done("one"), { item: item({ title: "two" }), state, attempts: 2 }],
        stoppedBy: "item-stuck",
      }),
      CFG3,
    )
    assert.match(out, /\*\*Incomplete\*\* — 1\/2/, `state ${state} must not read as done`)
    assert.ok(!out.includes("**Done**"), `state ${state} rendered as Done`)
  }
})

test("an empty run is not 'Done' either", () => {
  assert.match(renderRun(run(), CFG3), /\*\*Incomplete\*\*/)
})

test("every stop reason is explained, none left as a bare enum", () => {
  for (const stoppedBy of ["complete", "item-stuck", "review-cycles", "wall-clock"] as const) {
    const out = renderRun(run({ outcomes: [done("one")], stoppedBy }), CFG3)
    assert.match(out, /Stopped because: \w[^.]+\./, `no explanation for ${stoppedBy}`)
    assert.ok(!out.includes(`Stopped because: ${stoppedBy}.`), `${stoppedBy} leaked the raw enum`)
  }
})

test("a failed PR is reported as a degraded success, not a lost run", () => {
  const out = renderRun(run({ outcomes: [done("one")], prError: "gh pr create failed: no upstream" }), CFG3)
  assert.match(out, /branch is pushed/, "the work is not lost and the report must say so")
  assert.match(out, /no upstream/, "must carry the real reason")
})

test("the report always says where the work is and that the tree was untouched", () => {
  const out = renderRun(run({ outcomes: [done("one")] }), CFG3)
  assert.match(out, /working tree was never touched/)
  assert.match(out, /git diff master\.\.\.crew\/x/)
  assert.match(out, /git worktree remove \/w/)
})

test("the acceptance judge is named, so the judgement is attributable", () => {
  const out = renderRun(run({ outcomes: [{ ...done("one"), judge: "fable" }] }), CFG3)
  assert.match(out, /accepted by fable/)
})

test("a worktree is created on its own branch and removed cleanly", () => {
  const dir = scratchRepo()
  try {
    const { path, branch } = openWorktree(dir, "test-run")
    assert.equal(branch, "crew/test-run")
    assert.ok(existsSync(path), "worktree directory must exist")
    assert.equal(
      execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: path, encoding: "utf8" }).trim(),
      "crew/test-run",
    )
    closeWorktree(dir, path)
    assert.ok(!existsSync(path), "worktree must be gone after close")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("proposeInit surfaces an existing config so re-init is not silent", () => {
  const dir = scratchRepo()
  try {
    const cfg: CrewConfig = { verify: ["npm test"], base: "main", lanes: ["reviewer"] }
    applyInit(dir, cfg)
    assert.deepEqual(proposeInit(dir, "main").existing, cfg)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
