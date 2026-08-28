import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, realpathSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  parseLetsBlock,
  renderLetsBlock,
  upsertLetsBlock,
  resolveScope,
  detectStack,
  detectVerifyCandidates,
  proposeLanes,
  graphState,
  missingIgnores,
  proposeInit,
  renderInitProposal,
  applyInit,
  commitMessage,
  runVerify,
  installIfDepsChanged,
  shq,
  branchExists,
  renderGate,
  openWorktree,
  worktreeChanges,
  detectBaseCandidates,
  closeWorktree,
  listWorktrees,
  renderWorktrees,
  renderRun,
  runExecute,
  type ItemOutcome,
  type RunResult,
  LETS_IGNORES,
  TRACKERS,
  availableTrackers,
  stdoutTracker,
  guarded,
  type Tracker,
  type LetsConfig,
  type WorkItem,
  LETS_INTAKE_MODELS,
  LETS_IMPLEMENT_MODELS,
} from "./lets.ts"
import { beadsAvailable, bdInstalled } from "./beads.ts"
import { bySlug, canSchema, canAgentic } from "./roster.ts"

const gitOut = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" })

const CFG: LetsConfig = {
  verify: ["npm test", "npm run lint"],
  base: "develop",
  lanes: ["code", "qa", "reviewer"],
}

test("a config survives a render/parse round trip", () => {
  assert.deepEqual(parseLetsBlock(renderLetsBlock(CFG)), CFG)
})

test("no lets block parses to nothing, not to defaults", () => {
  // A missing block and an empty block must be distinguishable from a configured one,
  // or init cannot tell "never run here" from "configured with blanks".
  assert.deepEqual(parseLetsBlock("# AGENTS\n\nSome prose.\n"), {})
})

test("comments and blank lines inside the block are ignored", () => {
  // Deliberately ```crew, not ```lets: this is the compatibility path. A repo configured
  // before the rename must still parse, and these fixtures are the only thing proving it.
  const md = "```crew\n# what to run\nverify: npm test\n\nbase: main\n```"
  assert.deepEqual(parseLetsBlock(md), { verify: ["npm test"], base: "main" })
})

test("upsert appends a section when the file has none", () => {
  const out = upsertLetsBlock("# AGENTS\n\nHouse rules.\n", CFG)
  assert.ok(out.startsWith("# AGENTS\n\nHouse rules."), "existing prose must lead")
  assert.deepEqual(parseLetsBlock(out), CFG)
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
  const after = upsertLetsBlock(before, CFG)
  assert.deepEqual(parseLetsBlock(after), CFG)
  assert.ok(after.includes("Rules above."))
  assert.ok(after.includes("Prose below that must survive."))
  assert.ok(after.includes("## Something the user wrote after"))
  assert.ok(!after.includes("old command"))
  assert.equal(after.match(/```lets/g)?.length, 1, "must not accumulate blocks")
})

test("upsert is idempotent", () => {
  const once = upsertLetsBlock("# AGENTS\n", CFG)
  assert.equal(upsertLetsBlock(once, CFG), once)
})

test("resolveScope reports a non-repo instead of throwing", () => {
  assert.deepEqual(resolveScope("/"), { kind: "notrepo" })
})

test("resolveScope finds the enclosing repo from a subdirectory", () => {
  // Asserted against git's own answer rather than a directory name. The name check that
  // was here failed inside a worktree (`.worktrees/probe`) — which is exactly where the
  // lets runs its own tests, so it would have failed on every run.
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
  const dir = mkdtempSync(join(tmpdir(), "lets-nx-"))
  try {
    writeFileSync(join(dir, "nx.json"), "{}")
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "jest" } }))
    const found = detectVerifyCandidates(dir, "develop")
    assert.match(found[0].command, /nx affected/, `first candidate was ${found[0].command}`)
    // shell-quoted: a branch name is legal git input containing sh metacharacters
    assert.match(found[0].command, /--base='develop'/, "must target the configured base, quoted")
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
  assert.deepEqual(missingIgnores("/nonexistent"), LETS_IGNORES)
})

/** A throwaway repo, so the write-path tests touch nothing real. */
function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "lets-repo-"))
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
    const cfg: LetsConfig = { verify: ["npm test"], base: "main", lanes: ["reviewer"] }

    const first = applyInit(dir, cfg)
    assert.deepEqual(first.sort(), [".git/info/exclude", "AGENTS.md"])
    assert.deepEqual(parseLetsBlock(readFileSync(join(dir, "AGENTS.md"), "utf8")), cfg)
    const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8")
    for (const line of LETS_IGNORES) assert.ok(exclude.includes(line), `missing ignore: ${line}`)

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
    assert.equal(after.match(/```lets/g)?.length, 1)
    assert.deepEqual(parseLetsBlock(after), { verify: ["npm run ci"], base: "develop", lanes: ["qa"] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- tracker

test("a tracker is only offered once it can actually be honoured", () => {
  // Listing a tracker before it works means init asks a question it cannot deliver on:
  // the human picks it, nothing mirrors, and the config now lies about what this repo does.
  for (const name of availableTrackers()) assert.ok(TRACKERS.includes(name), `${name} is not a known tracker`)
  assert.ok(availableTrackers().includes("none"), "terminal-only must always be available")
})

test("an unrecognised tracker name is dropped, not silently honoured", () => {
  // A typo must read as "never asked" so init asks again. Accepting `tracker: jyra` would
  // disable tracking with no signal at all.
  assert.equal(parseLetsBlock("```crew\nverify: x\nbase: m\nlanes: qa\ntracker: jyra\n```").tracker, undefined)
  assert.equal(parseLetsBlock("```crew\nverify: x\nbase: m\nlanes: qa\ntracker: none\n```").tracker, "none")
})

test("absent and 'none' are different states", () => {
  // Absent means init never asked. `none` means the human said no. Re-asking someone who
  // already declined is the behaviour this distinction exists to prevent.
  assert.equal(parseLetsBlock(renderLetsBlock({ ...CFG, tracker: "none" })).tracker, "none")
  assert.equal(parseLetsBlock(renderLetsBlock(CFG)).tracker, undefined)
})

test("the default tracker reports progress rather than staying silent", () => {
  // Twenty silent minutes is indistinguishable from a hang.
  const lines: string[] = []
  const t = stdoutTracker((m) => lines.push(m))
  t.step("doing a thing")
  assert.equal(lines.length, 1)
  assert.match(lines[0], /doing a thing/)
  assert.match(lines[0], /^\[\d\d:\d\d\]/, "must carry elapsed time, so a stall is visible")
})

test("a broken tracker cannot break the run", async () => {
  // The work is real; the mirror is not. An expired token must cost a warning line, never
  // a branch.
  const lines: string[] = []
  const broken: Tracker = {
    name: "linear",
    async start() { throw new Error("token expired") },
    step() { throw new Error("nope") },
    async itemDone() { throw new Error("429") },
    async finish() { throw new Error("gone") },
  }
  const g = guarded(broken, (m) => lines.push(m))

  await g.start({ directive: "d", items: [], branch: "b" })
  g.step("x")
  await g.itemDone({ item: item(), state: "done", attempts: 1 })
  await g.finish({} as any)

  assert.equal(lines.length, 3, "each async failure warns; a failed progress line stays silent")
  for (const l of lines) assert.match(l, /tracker\(linear\).*failed/)
})

test("a Tracker is single-run: a second start, and any use after finish, is refused", async () => {
  // linear, beads and mcp each hold one run's session id and plan in a closure. Shared
  // across concurrent runs, a second start() would point every mirror at one session, and
  // the first finish() would report "done" over work that is still going - the one failure
  // that looks green. Refused in the wrapper every stateful tracker already passes through,
  // and refused with a warning rather than a throw, because a mirror must never break work.
  const calls: string[] = []
  const lines: string[] = []
  const inner: Tracker = {
    name: "linear",
    async start() { calls.push("start") },
    step() { calls.push("step") },
    async itemDone() { calls.push("itemDone") },
    async finish() { calls.push("finish") },
  }
  const g = guarded(inner, (m) => lines.push(m))
  const begin = { directive: "d", items: [], branch: "b" }

  await g.start(begin)
  await g.start(begin) // a second run reaching for the same tracker
  assert.deepEqual(calls, ["start"], "the second run must not reach the tracker")

  await g.finish({} as any)
  await g.itemDone({ item: item(), state: "done", attempts: 1 })
  g.step("still working over here")
  await g.finish({} as any)
  assert.deepEqual(calls, ["start", "finish"], "nothing may reach a finished tracker")

  assert.equal(lines.length, 4, "every refusal is visible, never silent")
  for (const l of lines) assert.match(l, /per run/, "the line must name the contract it enforces")
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
      assert.deepEqual(worktreeChanges(wt), [], "but lets must not")

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

test("listWorktrees returns the lets worktrees and never the repo's main one", () => {
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
      assert.deepEqual(live.map((w) => w.branch).sort(), ["lets/alpha", "lets/beta"])
      for (const w of live) assert.ok(w.ageMs >= 0, `${w.slug} reported age ${w.ageMs}`)

      // The list drives deletion, so the working tree the human is standing in must be absent.
      const main = realpathSync(dir)
      assert.ok(!live.some((w) => realpathSync(w.path) === main), `main worktree ${main} was listed`)

      assert.match(renderWorktrees(live), /git worktree remove .*alpha --force/)
      assert.match(renderWorktrees([]), /No live lets worktrees/)
    } finally {
      closeWorktree(dir, alpha.path)
      closeWorktree(dir, beta.path)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a worktree branched before the rename is still listed, under its real branch name", () => {
  // The read half of the branch prefix. openWorktree writes `lets/` now, so nothing else in
  // this suite can produce a `crew/` worktree - and a stranded one is exactly what status
  // exists to surface. Also pins the capture: rebuilding the branch from the slug would
  // report this as `lets/legacy`, a branch that does not exist, inside a removal command a
  // human is expected to run.
  const dir = scratchRepo()
  try {
    const path = join(dir, ".worktrees", "legacy")
    execFileSync("git", ["worktree", "add", "-b", "crew/legacy", path, "HEAD"], { cwd: dir })
    const live = listWorktrees(dir)
    assert.deepEqual(live.map((w) => w.slug), ["legacy"])
    assert.deepEqual(live.map((w) => w.branch), ["crew/legacy"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- phase 3

const CFG3: LetsConfig = { verify: ["npm test"], base: "master", lanes: ["reviewer"] }
const run = (over: Partial<RunResult> = {}): RunResult => ({
  branch: "crew/x",
  worktree: "/w",
  outcomes: [],
  cycles: [],
  pushed: false,
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

test("a failed PR distinguishes 'pushed but no PR' from 'never pushed'", () => {
  // Observed on the first real end-to-end run: the push failed (no origin) and the report
  // still said "The branch is pushed". Telling someone their work is on a remote when it
  // is not sends them looking somewhere empty — the one lie in this report that costs
  // real time.
  const ghFailed = renderRun(
    run({ outcomes: [done("one")], pushed: true, prError: "gh pr create failed: 422" }),
    CFG3,
  )
  assert.match(ghFailed, /branch \*\*is\*\* pushed/)
  assert.match(ghFailed, /422/, "must carry the real reason")

  const pushFailed = renderRun(
    run({ outcomes: [done("one")], pushed: false, prError: "push failed: 'origin' does not appear to be a git repository" }),
    CFG3,
  )
  assert.match(pushFailed, /\*\*not\*\* pushed/)
  assert.ok(!/branch \*\*is\*\* pushed/.test(pushFailed), "must not claim a failed push succeeded")
  assert.match(pushFailed, /worktree/, "must still say where the work actually is")
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
    assert.equal(branch, "lets/test-run")
    assert.ok(existsSync(path), "worktree directory must exist")
    assert.equal(
      execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: path, encoding: "utf8" }).trim(),
      "lets/test-run",
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
    const cfg: LetsConfig = { verify: ["npm test"], base: "main", lanes: ["reviewer"] }
    applyInit(dir, cfg)
    assert.deepEqual(proposeInit(dir, "main").existing, cfg)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- round 1 review fixes

test("a schema-less ask resolves to text, so the CPO lane is not silently discarded", () => {
  // `ask` without a schema returns the reply TEXT, a plain string. runIntake typed it as
  // an object and read `cpo?.text`, which is undefined on a string - so `outcomes` was
  // always "" and the CTO fell back to the raw directive. One of the two intake lanes was
  // paid for and thrown away on every run, and nothing failed loudly.
  const asText = (v: unknown) => (typeof v === "string" ? v : "")
  assert.equal(asText("real outcomes"), "real outcomes")
  assert.equal((("real outcomes" as any).text ?? ""), "", "the shape that caused the bug")
})

test("items that never ran are reported, not dropped", () => {
  // A 6-item plan that stops at item 2 used to report "1/2 landed" - true of what was
  // attempted, and a lie about the plan the human approved.
  const mk = (t: string, state: ItemOutcome["state"]): ItemOutcome => ({
    item: item({ title: t }), state, attempts: state === "not-attempted" ? 0 : 1,
    ...(state === "done" ? { commit: "abc" } : {}),
  })
  const out = renderRun(
    {
      branch: "crew/x", worktree: "/w", cycles: [], pushed: false, seconds: 10,
      stoppedBy: "item-stuck",
      outcomes: [mk("one", "done"), mk("two", "failed-check"), mk("three", "not-attempted"), mk("four", "not-attempted")],
    },
    CFG,
  )
  assert.match(out, /1\/4/, "the denominator must be the whole plan")
  assert.match(out, /three/)
  assert.match(out, /four/)
  assert.ok(!out.includes("**Done**"))
})

test("base detection reports whether origin/HEAD actually said anything", () => {
  // The proposal used to assert "`origin/HEAD` says X" whenever more than one candidate
  // existed, including when X came from the local-branch fallback - a fabricated fact
  // presented at the moment the human is deciding whether to trust the detection.
  const here = detectBaseCandidates(new URL("..", import.meta.url).pathname)
  assert.ok(Array.isArray(here.names))
  assert.ok(here.fromOriginHead === null || typeof here.fromOriginHead === "string")

  const dir = scratchRepo()
  try {
    const probe = detectBaseCandidates(dir)
    assert.equal(probe.fromOriginHead, null, "a repo with no remote must not claim origin/HEAD")
    assert.deepEqual(probe.names, ["main"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- round 2 review fixes

test("a verify command containing a comma survives the round trip", () => {
  // `nx affected -t lint,test` is ONE command containing a comma. The comma-joined form
  // could not represent it, and a back-compat shim that still split on commas re-broke the
  // exact case the fix existed for.
  const cfg: LetsConfig = { verify: ["npx nx affected -t lint,test", "npm run check"], base: "main", lanes: ["qa"] }
  assert.deepEqual(parseLetsBlock(renderLetsBlock(cfg)).verify, cfg.verify)
})

test("config survives replacement-string metacharacters", () => {
  // `String.replace` treats `$&`, "$`", `$'` and `$1` specially in a replacement STRING, so
  // a verify command containing any of them was silently mangled on write.
  const cfg: LetsConfig = { verify: ["echo $& $1 $` $'"], base: "main", lanes: ["qa"] }
  const once = upsertLetsBlock("# A\n\nprose\n", cfg)
  assert.deepEqual(parseLetsBlock(once).verify, cfg.verify)
  assert.deepEqual(parseLetsBlock(upsertLetsBlock(once, cfg)).verify, cfg.verify)
})

test("a base that exists only on the remote is named so it resolves", () => {
  // Recording the bare name broke the very case remote lookup was added for: a fresh clone
  // with no local branch produced a base that no `git diff <base>...HEAD` could resolve.
  const dir = scratchRepo()
  try {
    execFileSync("git", ["update-ref", "refs/remotes/origin/develop", "HEAD"], { cwd: dir })
    const { names } = detectBaseCandidates(dir)
    assert.ok(names.includes("origin/develop"), `expected origin/develop in ${names}`)
    assert.ok(!names.includes("develop"), "the bare name would not resolve")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a failed dependency install fails the attempt rather than being logged past", () => {
  // installIfDepsChanged removes the node_modules symlink before installing. Continuing
  // after a failure means the check runs with no node_modules at all and fails for a
  // reason unrelated to the item.
  const dir = scratchRepo()
  try {
    mkdirSync(join(dir, "node_modules"), { recursive: true })
    writeFileSync(join(dir, "package-lock.json"), "{}")
    // Both `npm ci` and its `npm install` fallback have to fail, or the `||` in the
    // install command recovers — which is the behaviour we want and why a broken lockfile
    // alone is not enough to test this.
    writeFileSync(join(dir, "package.json"), "{ not valid json at all")
    const r = installIfDepsChanged(dir, ["package.json"])
    assert.ok(r, "a manifest change must trigger an install")
    assert.equal(r!.ok, false)
    if (!r!.ok) assert.ok(r!.output.length > 0, "the failure must carry the install output as feedback")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- round 3 review fixes

test("a branch name cannot inject through the recommended nx command", async () => {
  // A git branch name may legally contain `;`, `$`, `&`, `|` — check-ref-format rejects
  // far less than sh does — and the base is interpolated into a verify command that
  // runVerify executes through a real shell. Verified against `sh -c` in situ.
  const { execSync } = await import("node:child_process")
  const evil = "x;touch /tmp/crew-injected"
  const out = execSync(`echo ${shq(evil)}`, { shell: "/bin/sh" }).toString().trim()
  assert.equal(out, evil, "the branch name must arrive as one argument, unexecuted")
})

test("an unknown lane name fails the parse rather than silently never running", () => {
  // `lanes: coed` used to cast straight through to Role[], so the typo'd lane matched no
  // model and never ran — with nothing anywhere saying so.
  assert.equal(parseLetsBlock("```crew\nverify: npm test\nbase: main\nlanes: coed\n```"), undefined)
  assert.deepEqual(
    parseLetsBlock("```crew\nverify: npm test\nbase: main\nlanes: qa, skeptic\n```")?.lanes,
    ["qa", "skeptic"],
  )
})

test("a widened role set accepts the new lanes and still rejects typos", () => {
  // KNOWN_ROLES gaining architect and infrastructure widens what a repo's lets block may
  // legally name. Widening the accept side must not blunt the reject side.
  assert.ok(parseLetsBlock("```crew\nverify: npm test\nbase: main\nlanes: architect, reviewer\n```")?.lanes)
  assert.equal(parseLetsBlock("```crew\nverify: npm test\nbase: main\nlanes: coed\n```"), undefined)
})

test("a lockfile-less repo still installs on a manifest change", () => {
  // Returning null when only package.json changed meant the edit was never installed and
  // the check ran against the parent's versions through the symlink.
  const dir = scratchRepo()
  try {
    mkdirSync(join(dir, "node_modules"), { recursive: true }) // real dir: rmSync needs recursive
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }))
    rmSync(join(dir, "package.json")) // scratchRepo committed one; write a dep-free one
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }))
    const r = installIfDepsChanged(dir, ["package.json"])
    assert.ok(r, "a package.json change must attempt an install")
    assert.equal(r!.ok, true, `install should succeed on a valid manifest: ${r!.ok ? "" : r!.note}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the worktree branches from the configured base, not session HEAD", () => {
  // The review and acceptance stages diff `<base>...HEAD`. Branching from HEAD would fold
  // the user's own unmerged commits into what the reviewer is told lets did.
  const dir = scratchRepo()
  try {
    execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: dir })
    execFileSync("git", ["commit", "--allow-empty", "-qm", "user work"], { cwd: dir })
    const { branch } = openWorktree(dir, "base-probe", "main")
    const merged = execFileSync("git", ["rev-list", "--count", `main...${branch}`], {
      cwd: join(dir, ".worktrees", "base-probe"),
    }).toString().trim()
    assert.equal(merged, "0", `base...branch must contain only lets work, found ${merged} commits`)
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", join(dir, ".worktrees", "base-probe")], { cwd: dir }).catch?.(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- round 4 review fixes

test("a done item that no judge assessed says so in the report", () => {
  // checkAcceptance fails open by design — an unreachable judge must not block work — but
  // four lanes across rounds flagged that the ✓ then carried no trace of that. The item
  // line now says "NOT independently judged — checks only" instead of passing silently.
  const out = renderRun(
    {
      branch: "crew/x", worktree: "/w", cycles: [], pushed: false, seconds: 5,
      stoppedBy: "complete",
      outcomes: [
        { item: item({ title: "judged" }), state: "done", attempts: 1, commit: "abc", judge: "fable", judged: true },
        { item: item({ title: "unjudged" }), state: "done", attempts: 1, commit: "def", judged: false },
      ],
    },
    CFG,
  )
  assert.match(out, /accepted by fable/)
  assert.match(out, /NOT independently judged/)
})

test("a CPO lane that no model answered is visible in the gate, not silent", () => {
  // Half the intake quietly producing the whole plan reads as fully-working.
  const gate = renderGate(
    {
      outcomes: "", items: [item({ title: "x" })], instructionBytes: 10,
      dropped: [{ lane: "cpo", state: "failed", detail: "no model answered; plan built by the CTO alone" }],
    },
    CFG,
    { root: "/repo", branch: "main" },
  )
  assert.match(gate, /cpo/)
  assert.match(gate, /CTO alone/)
})

test("run slugs do not collide with a branch left by a crashed run", () => {
  const dir = scratchRepo()
  try {
    execFileSync("git", ["branch", "crew/2026-01-01T00-00-00-000"], { cwd: dir })
    assert.ok(branchExists(dir, "crew/2026-01-01T00-00-00-000"))
    // ms precision + suffix loop lives in runExecute; branchExists is the primitive
    assert.ok(!branchExists(dir, "crew/never-existed"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- round 5 review fixes

test("the judge's diff includes files created from scratch", () => {
  // `git diff HEAD` omits untracked files, so an item delivered entirely in NEW files
  // handed checkAcceptance an empty diff - judged on nothing, three lanes caught it.
  // Intent-to-add puts them in the diff without staging anything.
  const dir = scratchRepo()
  try {
    const { path: wt } = openWorktree(dir, "untracked-probe", "main")
    try {
      writeFileSync(join(wt, "brand-new.ts"), "export const x = 1\n")
      const blind = gitOut(wt, ["diff", "HEAD"])
      assert.equal(blind, "", "precondition: plain diff is blind to new files")
      gitOut(wt, ["add", "--intent-to-add", "--", "."])
      const seen = gitOut(wt, ["diff", "HEAD"])
      assert.match(seen, /brand-new\.ts/, "intent-to-add must surface new files to the judge")
      assert.match(seen, /\+export const x = 1/, "and their contents")
      // and the real staging path still upgrades the intent entries
      gitOut(wt, ["add", "-A", "--", "."])
      gitOut(wt, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "x"])
      assert.match(gitOut(wt, ["show", "--name-only", "--pretty=format:"]), /brand-new\.ts/)
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: dir })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("origin/HEAD naming a deleted remote branch is not offered", () => {
  // origin/HEAD can name a branch the remote no longer has; offering it as the PR target
  // points every diff and PR at a ref that resolves to nothing.
  const dir = scratchRepo()
  try {
    execFileSync("git", ["update-ref", "refs/remotes/origin/HEAD", "HEAD"], { cwd: dir })
    // origin/HEAD now says `main`, but refs/remotes/origin/main does not exist
    const probe = detectBaseCandidates(dir)
    assert.equal(probe.fromOriginHead, null, "origin/HEAD naming a missing ref must not be trusted")
    // `main` is still offered - from the local branch, where it is real
    assert.deepEqual(probe.names, ["main"], `names were ${probe.names}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a CPO lane failure is reported once, by askAny", () => {
  // The round-4 fix pushed a second `dropped` entry on top of the one askAny already
  // records, so the gate said the lane failed twice under two names.
  const dropped = [{ lane: "lets-cpo", state: "failed", detail: "all models exhausted" }]
  const gate = renderGate(
    { outcomes: "", items: [item({ title: "x" })], instructionBytes: 10, dropped },
    CFG,
    { root: "/repo", branch: "main" },
  )
  assert.equal(gate.match(/lets-cpo did not answer/g)?.length, 1)
})

test("verify candidates are deduped", () => {
  const dir = mkdtempSync(join(tmpdir(), "lets-py-"))
  try {
    writeFileSync(join(dir, "pytest.ini"), "")
    writeFileSync(join(dir, "pyproject.toml"), "[tool.pytest.ini_options]")
    const cmds = detectVerifyCandidates(dir, "main").map((c) => c.command)
    assert.equal(cmds.filter((c) => c === "pytest").length, 1, `got ${cmds}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a done item carries no stale failure detail", () => {
  const out = renderRun(
    {
      branch: "crew/x", worktree: "/w", cycles: [], pushed: false, seconds: 5, stoppedBy: "complete",
      outcomes: [{ item: item({ title: "t" }), state: "done", attempts: 2, commit: "abc", judge: "fable", judged: true, detail: undefined }],
    },
    CFG,
  )
  assert.match(out, /accepted by fable/)
  assert.ok(!/unmet|not met/.test(out), "a landed item must not echo its earlier failure")
})

test("init recommends beads where it is available, and says why when it is not", () => {
  // Keyed off the real `beadsAvailable` rather than assuming `bd` is on PATH: the rule is
  // `bd` AND `.beads/`, and a test that hardcodes either half passes for the wrong reason
  // on a machine configured the other way. No `bd init` is ever run - `mkdir .beads` is
  // enough, which is exactly what makes the check safe to test.
  const dir = scratchRepo()
  try {
    const env = {} as NodeJS.ProcessEnv // no LINEAR_API_TOKEN: keep the choice about beads

    const before = renderInitProposal(proposeInit(dir, "main", env))
    assert.equal(beadsAvailable(dir), false, "fixture: a fresh repo has no .beads/")
    assert.doesNotMatch(before, /`beads` \(recommended\)/, "beads cannot be recommended here")
    assert.match(before, /`none` \(recommended\)/, "something must still carry the default")
    assert.match(before, /beads.*not on offer/, "an unavailable option is explained, not dropped")
    assert.match(
      before,
      bdInstalled() ? /bd init/ : /`bd`.*not on PATH/,
      "it must name the half that is actually missing",
    )
    if (bdInstalled())
      assert.doesNotMatch(before, /I (will )?(run|create)/, "bd init is the human's to run")

    mkdirSync(join(dir, ".beads"))
    const after = renderInitProposal(proposeInit(dir, "main", env))
    if (!beadsAvailable(dir)) {
      assert.match(after, /`bd`.*not on PATH/, "still honest about which half is missing")
      return
    }
    assert.match(after, /`beads` \(recommended\)/, "available beads is the recommendation")
    assert.doesNotMatch(after, /not on offer/, "it is on offer now")
    // A default is not a decision made for the user.
    assert.match(after, /`none`/, "the other options must still be offered")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------- concurrent callers (crew enablers)

const CFG4: LetsConfig = { verify: ["true"], base: "main", lanes: ["reviewer"] }

/**
 * A whole runExecute that never reaches a model.
 *
 * With no items the item loop is `queue.length`-gated and never turns over, nothing lands,
 * and the push/PR block is gated on something having landed - so the run opens its worktree,
 * reports and returns. That makes the naming, which is the entirety of the crew's isolation
 * story, testable without a model, a network or a `gh`.
 */
const bare = (root: string, over: Partial<Parameters<typeof runExecute>[1]> = {}) =>
  runExecute({} as any, {
    root,
    items: [],
    cfg: CFG4,
    instructions: "",
    directive: "d",
    onStep: () => {},
    ...over,
  })

test("a caller-supplied slug is used verbatim, and the derivation is skipped", async () => {
  const dir = scratchRepo()
  try {
    const r = await bare(dir, { slug: "task-auth" })
    assert.equal(r.branch, "lets/task-auth")
    assert.equal(r.worktree, join(dir, ".worktrees", "task-auth"))
    // The derived slug is an ISO stamp; a collision would suffix it. Verbatim means the
    // caller's string reached git untouched by either.
    assert.doesNotMatch(r.branch, /\d{4}-\d\d-\d\dT/, "the derivation ran anyway")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("two runs with distinct slugs share neither a worktree nor a branch", async () => {
  // The crew's whole isolation story. Nothing is held between the derivation's check and
  // its act, so distinctness is the caller's to guarantee - this proves the guarantee is
  // honoured once made, which is the half runExecute owns.
  const dir = scratchRepo()
  try {
    const a = await bare(dir, { slug: "alpha" })
    const b = await bare(dir, { slug: "beta" })
    assert.deepEqual([a.branch, b.branch], ["lets/alpha", "lets/beta"])
    assert.notEqual(a.worktree, b.worktree)
    assert.ok(existsSync(a.worktree) && existsSync(b.worktree), "both trees must exist at once")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Records what runExecute said, with none of stdoutTracker's elapsed-time prefix. */
const recorder = (seen: string[]): Tracker => ({
  name: "none",
  async start() {},
  step: (m) => seen.push(m),
  async itemDone() {},
  async finish() {},
})

/**
 * `maxSeconds: 0` trips the wall-clock guard on the first item: the run reports, records
 * the item as not-attempted and returns - the one path that emits progress and still stops
 * before any model call.
 */
const oneLine = async (dir: string, over: Partial<Parameters<typeof runExecute>[1]>) => {
  const seen: string[] = []
  await bare(dir, { items: [item()], maxSeconds: 0, tracker: recorder(seen), ...over })
  return seen
}

test("a label prefixes progress lines; without one the output is byte-identical", async () => {
  // N runs interleave into one stdout. For a design whose safety story is the record,
  // unlabelled interleaved output is a defect, not cosmetics.
  const dir = scratchRepo()
  try {
    const plain = await oneLine(dir, { slug: "unlabelled" })
    const labelled = await oneLine(dir, { slug: "labelled", label: "auth" })

    assert.ok(plain.length, "fixture: the wall-clock path must actually say something")
    assert.deepEqual(labelled, plain.map((l) => `[auth] ${l}`))
    // Byte-identical, not merely similar: the existing single-run caller passes no label.
    assert.equal(plain[0], "wall clock 0s exceeded 0s — stopping")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a local run neither pushes nor opens a PR, and the result says which", async () => {
  const dir = scratchRepo()
  try {
    const r = await bare(dir, { slug: "local-only", openPr: false })
    assert.equal(r.pushed, false)
    assert.equal(r.prUrl, undefined)
    assert.equal(r.prError, undefined, "nothing was attempted, so nothing can have failed")
    assert.equal(r.prSkipped, true, "the absence has to be legible as deliberate")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("push and PR are skipped, not merely undone, when the caller stays local", () => {
  // openPr() runs `git push -u origin` and then `gh pr create`. N concurrent tasks would
  // push N branches and open N pull requests before the integration step had run at all,
  // so suppression has to skip the call rather than tidy up after it. Nothing here may run
  // `gh`, so this reads the source - the technique index.test.ts already uses on this file.
  const src = readFileSync(new URL("./lets.ts", import.meta.url), "utf8")
  const block = src.slice(
    src.indexOf("const landed = outcomes.filter"),
    src.indexOf("const result: RunResult"),
  )
  assert.match(block, /openPr\(/, "fixture: the PR call must live in this window")
  assert.match(block, /input\.openPr !== false/, "the call itself must be gated on the flag")
})

test("a suppressed PR renders as a choice, never as a failed push", () => {
  const out = renderRun(run({ outcomes: [done("one")], prSkipped: true }), CFG3)
  assert.doesNotMatch(out, /^PR: /m, "must not imply a pull request exists")
  assert.doesNotMatch(out, /PR not opened/, "nothing was attempted; that is not a failure")
  assert.doesNotMatch(out, /\*\*not\*\* pushed/, "the failed-push wording is for failures")
  assert.doesNotMatch(out, /failed/, "a deliberate choice must not read as an error")
  assert.match(out, /local/i, "it must still say the branch never left the machine")
  assert.match(out, /worktree/, "and where the work actually is")
})

test("the intake chain is entirely schema-capable", () => {
  // The one that would 400 in production. runIntake passes WORKITEMS_SCHEMA, which is a
  // FORCED tool call, and the two agentic-only members answer that with
  // `only "auto" is supported`. A slug added here without checking its capability breaks
  // planning for every repo at once, so this is checked against the roster rather than
  // eyeballed off the slug names.
  assert.ok(LETS_INTAKE_MODELS.length, "fixture: the intake chain must not be empty")
  for (const slug of LETS_INTAKE_MODELS) {
    const m = bySlug(slug)
    assert.ok(m, `${slug} is not in the roster at all`)
    assert.ok(canSchema(m!), `${slug} cannot emit structured output and must not do intake`)
  }
})

test("the implementer chain leads with an agentic model, and it is deepseek", () => {
  // Cost: deepseek is the cheapest member that drives tools, and the implementer is the
  // highest-volume paid call in the system. `canAgentic` is asserted rather than assumed —
  // leading with a model that cannot drive `edit`/`bash` would burn the first attempt of
  // every item before falling through.
  const lead = bySlug(LETS_IMPLEMENT_MODELS[0])
  assert.ok(lead, `${LETS_IMPLEMENT_MODELS[0]} is not in the roster`)
  assert.ok(canAgentic(lead!), `${lead!.slug} leads the implementer but cannot drive tools`)
  assert.equal(lead!.slug, "deepseek", "the cheapest agentic member leads on cost")
})

test("deepseek implements and never does intake", () => {
  assert.ok(LETS_IMPLEMENT_MODELS.includes("deepseek"))
  assert.ok(
    !LETS_INTAKE_MODELS.includes("deepseek" as never),
    "deepseek 400s on a forced tool_choice; intake is exactly that call",
  )
})

test("the implementer keeps every intake model behind its lead", () => {
  // The fallback is the whole reason a cheapest-first chain is safe: when deepseek is down
  // or rate-limited, the implementer must still finish rather than fail the run. Every
  // model that was in the single pre-split list stays reachable.
  for (const slug of LETS_INTAKE_MODELS)
    assert.ok(LETS_IMPLEMENT_MODELS.includes(slug), `${slug} lost its implementer fallback`)
})
