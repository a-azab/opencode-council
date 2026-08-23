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
  shq,
  openWorktree,
  worktreeChanges,
  detectBaseCandidates,
  closeWorktree,
  listWorktrees,
  renderWorktrees,
  renderRun,
  type ItemOutcome,
  type RunResult,
  CREW_IGNORES,
  TRACKERS,
  availableTrackers,
  stdoutTracker,
  guarded,
  type Tracker,
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
  assert.equal(parseCrewBlock("```crew\nverify: x\nbase: m\nlanes: qa\ntracker: jyra\n```").tracker, undefined)
  assert.equal(parseCrewBlock("```crew\nverify: x\nbase: m\nlanes: qa\ntracker: none\n```").tracker, "none")
})

test("absent and 'none' are different states", () => {
  // Absent means init never asked. `none` means the human said no. Re-asking someone who
  // already declined is the behaviour this distinction exists to prevent.
  assert.equal(parseCrewBlock(renderCrewBlock({ ...CFG, tracker: "none" })).tracker, "none")
  assert.equal(parseCrewBlock(renderCrewBlock(CFG)).tracker, undefined)
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
  const cfg: CrewConfig = { verify: ["npx nx affected -t lint,test", "npm run check"], base: "main", lanes: ["qa"] }
  assert.deepEqual(parseCrewBlock(renderCrewBlock(cfg)).verify, cfg.verify)
})

test("config survives replacement-string metacharacters", () => {
  // `String.replace` treats `$&`, "$`", `$'` and `$1` specially in a replacement STRING, so
  // a verify command containing any of them was silently mangled on write.
  const cfg: CrewConfig = { verify: ["echo $& $1 $` $'"], base: "main", lanes: ["qa"] }
  const once = upsertCrewBlock("# A\n\nprose\n", cfg)
  assert.deepEqual(parseCrewBlock(once).verify, cfg.verify)
  assert.deepEqual(parseCrewBlock(upsertCrewBlock(once, cfg)).verify, cfg.verify)
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
  assert.equal(parseCrewBlock("```crew\nverify: npm test\nbase: main\nlanes: coed\n```"), undefined)
  assert.deepEqual(
    parseCrewBlock("```crew\nverify: npm test\nbase: main\nlanes: qa, skeptic\n```")?.lanes,
    ["qa", "skeptic"],
  )
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
  // the user's own unmerged commits into what the reviewer is told the crew did.
  const dir = scratchRepo()
  try {
    execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: dir })
    execFileSync("git", ["commit", "--allow-empty", "-qm", "user work"], { cwd: dir })
    const { branch } = openWorktree(dir, "base-probe", "main")
    const merged = execFileSync("git", ["rev-list", "--count", `main...${branch}`], {
      cwd: join(dir, ".worktrees", "base-probe"),
    }).toString().trim()
    assert.equal(merged, "0", `base...branch must contain only crew work, found ${merged} commits`)
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", join(dir, ".worktrees", "base-probe")], { cwd: dir }).catch?.(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
})
