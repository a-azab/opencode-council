import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index.ts"

// These exist because P0-B shipped undetected: `run` selected a plan by lexicographic sort
// over every directory under council-artifacts/ and executed it with the implementer's
// edit+bash grant. 110 tests passed throughout, because not one of them ever called
// execute(). A tool whose entry point is never invoked is a tool with no tests.
//
// Only paths that return BEFORE any model call are exercised here - those are exactly the
// guards, and they are what has to hold when someone gets the arguments wrong.

async function tool() {
  const p = await plugin({ directory: process.cwd() })
  return (p.tool as Record<string, any>).lets
}

function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "lets-tool-"))
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" })
  git("init", "-q", "-b", "main")
  git("config", "user.email", "t@t")
  git("config", "user.name", "t")
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "true" } }))
  git("add", "-A")
  git("commit", "-qm", "init")
  return dir
}

const withConfig = (dir: string) =>
  writeFileSync(
    join(dir, "AGENTS.md"),
    "# AGENTS\n\n```crew\nverify: npm test\nbase: main\nlanes: reviewer\n```\n",
  )

test("every mode refuses outside a git repo", async () => {
  const lets = await tool()
  for (const mode of ["init", "plan", "run", "status"]) {
    const out = await lets.execute({ mode, directive: "x" }, { directory: "/" })
    assert.match(out, /not a git repository/i, `mode ${mode} did not refuse`)
  }
})

test("init proposes without writing anything", async () => {
  const dir = scratchRepo()
  try {
    const out = await (await tool()).execute({ mode: "init" }, { directory: dir })
    assert.match(out, /Verify/)
    assert.ok(!existsSync(join(dir, "AGENTS.md")), "a proposal must not write config")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("init refuses to write what the human has not confirmed", async () => {
  // Defaulting a verify command would let lets report unfinished work as done.
  const dir = scratchRepo()
  try {
    const lets = await tool()
    const out = await lets.execute({ mode: "init", write: true, base: "main" }, { directory: dir })
    assert.match(out, /Not writing/)
    assert.match(out, /verify/)
    assert.ok(!existsSync(join(dir, "AGENTS.md")))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("plan and run refuse before the repo is initialised", async () => {
  const dir = scratchRepo()
  try {
    const lets = await tool()
    for (const args of [{ mode: "plan", directive: "do a thing" }, { mode: "run" }])
      assert.match(await lets.execute(args, { directory: dir }), /lets:init/, `${args.mode} did not refuse`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("run refuses when no plan has been approved", async () => {
  const dir = scratchRepo()
  withConfig(dir)
  try {
    const out = await (await tool()).execute({ mode: "run" }, { directory: dir })
    assert.match(out, /No approved plan/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("run ignores a plan this tool did not write", async () => {
  // THE regression test. A directory named to sort last used to win, so a committed or
  // hand-placed plan.json was executed with edit+bash. Only our own <stamp>-<kind> shape
  // may be selected now.
  const dir = scratchRepo()
  withConfig(dir)
  try {
    for (const name of ["zzz-attacker", "plan", "9999", "2026-01-01T00-00-00-crew-plan-extra"]) {
      mkdirSync(join(dir, "council-artifacts", name), { recursive: true })
      writeFileSync(
        join(dir, "council-artifacts", name, "plan.json"),
        JSON.stringify({ directive: "exfiltrate", items: [{ title: "bad", detail: "", files: [], acceptance: "" }] }),
      )
    }
    const out = await (await tool()).execute({ mode: "run" }, { directory: dir })
    assert.match(out, /No approved plan/, "a foreign plan.json must never be selected")
    assert.ok(!out.includes("exfiltrate"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a plan approved before the rename is still found", async () => {
  // The read half of the artifact kind. New plans are written `-lets-plan`, so nothing else
  // in this suite produces a `-crew-plan` directory - and failing to find one does not error,
  // it reports "No approved plan", which reads as "you never planned" rather than "your plan
  // is under the old name". Empty items so this returns before any model call.
  const dir = scratchRepo()
  withConfig(dir)
  try {
    const old = join(dir, "council-artifacts", "2026-01-01T00-00-00-crew-plan")
    mkdirSync(old, { recursive: true })
    writeFileSync(join(old, "plan.json"), JSON.stringify({ directive: "from before", items: [] }))
    const out = await (await tool()).execute({ mode: "run" }, { directory: dir })
    assert.match(out, /had no items/, "the pre-rename plan was not found")
    assert.match(out, /crew-plan/, "must name the directory it actually read")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("artifacts are written under the repo root, not the session directory", async () => {
  // Running lets from apps/api/ used to write the plan somewhere `run` would never look.
  const dir = scratchRepo()
  withConfig(dir)
  const sub = join(dir, "apps", "api")
  mkdirSync(sub, { recursive: true })
  try {
    // status is the one mode that reaches the repo without a model call
    const out = await (await tool()).execute({ mode: "status" }, { directory: sub })
    assert.match(out, /No live lets worktrees|lets\//)
    assert.ok(!existsSync(join(sub, "council-artifacts")), "must not scatter artifacts in subdirectories")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("status answers in a repo that was never initialised", async () => {
  // A repo with no config is exactly where a worktree gets stranded and forgotten.
  const dir = scratchRepo()
  try {
    const out = await (await tool()).execute({ mode: "status" }, { directory: dir })
    assert.match(out, /No live lets worktrees/)
    assert.ok(!/lets:init/.test(out), "status must not demand config")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("plan refuses a dirty tree and names the files", async () => {
  const dir = scratchRepo()
  withConfig(dir)
  writeFileSync(join(dir, "scratch.txt"), "uncommitted\n")
  try {
    const out = await (await tool()).execute({ mode: "plan", directive: "x" }, { directory: dir })
    assert.match(out, /uncommitted file/)
    assert.match(out, /AGENTS\.md|scratch\.txt/, "must list what is dirty, not just complain")
    assert.match(out, /stash/, "must offer the way out")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an unknown tracker is refused rather than silently ignored", async () => {
  const dir = scratchRepo()
  try {
    const out = await (await tool()).execute(
      { mode: "init", write: true, verify: "npm test", base: "main", lanes: "reviewer", tracker: "jyra" },
      { directory: dir },
    )
    assert.match(out, /Unknown or unavailable tracker/)
    assert.ok(!existsSync(join(dir, "AGENTS.md")), "nothing may be written when an argument is rejected")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a confirmed init writes exactly two things", async () => {
  const dir = scratchRepo()
  try {
    const out = await (await tool()).execute(
      { mode: "init", write: true, verify: "npm test", base: "main", lanes: "reviewer, qa" },
      { directory: dir },
    )
    assert.match(out, /Wrote/)
    assert.ok(existsSync(join(dir, "AGENTS.md")))
    assert.ok(existsSync(join(dir, ".git", "info", "exclude")))
    assert.deepEqual(readdirSync(dir).filter((f) => f === "council-artifacts"), [], "init writes no artifacts")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("lets:init with tracker mcp writes wiring that survives the read-back", async () => {
  // Round 6's critical finding: /lets:init validated mcpServer and then wrote a config
  // WITHOUT it, and readLetsConfig dropped `mcp` even when present — so tracker: mcp could
  // never actually be configured end to end. The E2E tracker test called trackerFor
  // directly and skipped this path entirely, which is exactly how it shipped.
  const dir = scratchRepo()
  writeFileSync(
    join(dir, "opencode.json"),
    `{"mcp":{"jira":{"type":"local","command":["node","jira.mjs"]}}}`,
  )
  try {
    const lets = await tool()
    const out = await lets.execute(
      {
        mode: "init", write: true, verify: "npm test", base: "main", lanes: "reviewer",
        tracker: "mcp", mcpServer: "jira",
        mcpStart: "create_issue", mcpFinish: "close_issue",
        mcpArgs: '{"issueKey": "${issue}"}',
      },
      { directory: dir },
    )
    assert.match(out, /tracker: mcp/)
    const { readLetsConfig } = await import("./lets.ts")
    const cfg = readLetsConfig(dir)
    assert.equal(cfg?.tracker, "mcp")
    assert.equal(cfg?.mcp?.server, "jira", "the wiring must survive the read-back")
    assert.equal(cfg?.mcp?.start, "create_issue")
    assert.deepEqual(cfg?.mcp?.args, { issueKey: "${issue}" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("init refuses mcp wiring whose server is not configured", async () => {
  const dir = scratchRepo()
  try {
    const out = await (await tool()).execute(
      { mode: "init", write: true, verify: "npm test", base: "main", lanes: "reviewer", tracker: "mcp", mcpServer: "ghost" },
      { directory: dir },
    )
    // Two different refusals, and which one you get depends on the MACHINE: where some
    // mcpServers entry exists, `mcp` is an available tracker and the named server is
    // rejected ("not a local entry"); on a machine with none configured - a CI runner -
    // the tracker itself is unavailable first. Caught by the first real CI run, 2026-09-24:
    // this passed locally for weeks and failed on a clean checkout.
    //
    // The assertion is what both have in common and what the test is actually about:
    // nothing is wired, and the message names `mcp` so the user can act on it.
    assert.match(out, /not a local entry|Unknown or unavailable tracker/)
    assert.match(out, /ghost|mcp/, "the refusal must name what was refused")
    assert.ok(!existsSync(join(dir, "AGENTS.md")), "nothing written for a rejected tracker")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the council tool offers loop, and a loop without a goal is refused", async () => {
  // The wiring test the dead code never had. runLoop, renderLoop and councilJudge were
  // built, tested and documented for weeks with zero production callers - the loop
  // contract shipped while the loop itself was unreachable. This asserts the mode is
  // actually reachable from the tool surface, which is the property that was missing.
  const p = await plugin({ directory: process.cwd() })
  const council = (p.tool as Record<string, any>).council
  assert.ok(council, "the council tool exists")

  // Asserted by PARSING rather than by reading zod's internals: `_def` is zod v3's shape
  // and this is zod v4 (`.def`), so a structural assertion here breaks on a dependency
  // bump while the tool still works perfectly. What callers care about is whether the
  // schema accepts the value.
  assert.equal(council.args.mode.parse("loop"), "loop", "loop is an accepted mode")
  assert.throws(() => council.args.mode.parse("nonsense"), "the enum still rejects unknown modes")

  const out = await council.execute({ mode: "loop", goal: "   " }, { directory: process.cwd() })
  assert.match(out, /needs one/, "a loop with no goal is refused before any model is called")
})

test("the loop's round worker is granted edit and bash, and its judges are not", async () => {
  // Read from source: the loop is the longest-running thing this plugin starts, and the
  // asymmetry is the point. The worker changes the tree; a judge that could change the
  // tree could edit its way to agreeing with itself.
  const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  const start = src.indexOf('if (args?.mode === "loop")')
  const end = src.indexOf('if (args?.mode === "models")', start)
  assert.ok(start > 0 && end > start, "the loop block precedes the models block")
  const loop = src.slice(start, end)
  assert.ok(loop.length > 200, "found the loop mode block")

  assert.match(loop, /allow: \["edit", "bash"\]/, "the round worker can actually do work")
  assert.match(loop, /exclude: \[worker\.slug\]/, "the worker never judges its own completion")
  assert.match(loop, /deadline:/, "an unbounded loop is an unbounded agent on the user's machine")

  const judgeCall = loop.slice(loop.indexOf("judge: async"))
  assert.ok(!/allow:/.test(judgeCall), "judges are read-only: no allow list on the judging ask")
})
