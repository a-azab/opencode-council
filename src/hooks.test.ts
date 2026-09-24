import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import {
  refusalFor,
  readGuardSettings,
  rememberSession,
  forgetSession,
  isPluginSession,
  REFUSED,
  clearSessions,
} from "./hooks.ts"

test("the gate refuses the commands that defeat this harness's own gates", () => {
  // Each of these exists because it removes a check the run depends on, not because it is
  // broadly scary. A worker that can skip the gate it is judged by has removed the judge.
  for (const [cmd, want] of [
    ["git commit --no-verify -m x", "git commit --no-verify"],
    ["git push --force origin master", "git push --force"],
    ["git reset --hard HEAD~3", "git reset --hard / git clean -f"],
    ["rm -rf src", "rm -rf"],
    ["git checkout master", "switching to master/main"],
  ] as const) {
    const r = refusalFor(cmd)
    assert.equal(r?.pattern, want, `must refuse: ${cmd}`)
    assert.ok((r?.reason.length ?? 0) > 40, "a refusal the worker cannot understand is a silent stall")
  }
})

test("ordinary work is not refused", () => {
  // A guard that blocks real work gets switched off within a week, and then guards nothing.
  for (const cmd of [
    "npm test",
    "git commit -m 'feat: add the thing'",
    "git push origin my-branch",
    "rm build/output.js",
    "git checkout -b lets/my-item",
    "grep -rn foo src/",
  ]) {
    assert.equal(refusalFor(cmd), null, `must allow: ${cmd}`)
  }
})

test("--force-with-lease is allowed where --force is not", () => {
  // The distinction is the whole point: one discards other people's commits, the other
  // refuses to. Refusing both would teach the worker the rule is arbitrary.
  assert.equal(refusalFor("git push --force-with-lease origin br"), null)
  assert.ok(refusalFor("git push --force origin br"))
})

test("editing the CI workflow is refused", () => {
  // Detected on the path, not the command, so it catches the editor tool as well as bash.
  assert.ok(refusalFor(".github/workflows/ci.yml"))
  assert.equal(refusalFor("src/engine.ts"), null)
})

test("session registration survives a process boundary", () => {
  // The bug this pins, measured live 2026-09-24: with a module-level Set, the half that
  // REGISTERS a session and the half that READS it are not always the same process. lets
  // driven from a script registers in the script; the hook runs inside the opencode server
  // and saw an empty Set, so isPluginSession was always false and the guard never fired -
  // while the ADR, these tests and the commit message all said it was protecting you.
  // A gate that silently does nothing is worse than no gate.
  clearSessions()
  rememberSession("ses_crossproc")
  const seen = execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    `const m = await import(${JSON.stringify(new URL("./hooks.ts", import.meta.url).href)});` +
      `process.stdout.write(String(m.isPluginSession("ses_crossproc")))`,
  ], { encoding: "utf8" })
  assert.equal(seen, "true", "a separate process must see the registration")
  forgetSession("ses_crossproc")
})

test("the guard applies only to sessions this plugin spawned", () => {
  // tool.execute.before carries a sessionID and nothing else - no directory, no agent - so
  // without this the plugin would refuse the user's own commands in their own session on
  // the same shared server, under a policy they never opted into.
  assert.equal(isPluginSession("ses_theirs"), false)
  rememberSession("ses_ours")
  assert.equal(isPluginSession("ses_ours"), true)
  assert.equal(isPluginSession("ses_theirs"), false)
  forgetSession("ses_ours")
  assert.equal(isPluginSession("ses_ours"), false, "a disposed session must not stay guarded forever")
})

test("a malformed settings file degrades to the defaults and says so", () => {
  // Failing closed would let a typo stop all work; failing silently would let a project
  // believe its custom rules are live when they never parsed.
  const dir = mkdtempSync(join(tmpdir(), "guard-"))
  try {
    mkdirSync(join(dir, ".claude"))
    writeFileSync(join(dir, ".claude", "settings.json"), "{ not json")
    const s = readGuardSettings(dir)
    assert.equal(s.enabled, true, "still guarding")
    assert.deepEqual(s.refuse, [])
    assert.match(s.source, /unparseable/, "the report must name the problem")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a project can add its own refusals, and one bad regex does not kill the rest", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-"))
  try {
    mkdirSync(join(dir, ".claude"))
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({
      hooks: { guard: { enabled: true, refuse: [
        { pattern: "(unclosed", reason: "invalid regex - must be skipped" },
        { pattern: "\\bdeploy\\b", reason: "deploys are a human decision on this project" },
      ] } },
    }))
    const s = readGuardSettings(dir)
    assert.equal(s.refuse.length, 1, "the invalid rule is skipped, the valid one survives")
    assert.ok(refusalFor("./deploy staging", s.refuse), "the project's own rule is enforced")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a project can opt out without deleting the policy", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-"))
  try {
    mkdirSync(join(dir, ".claude"))
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ hooks: { guard: { enabled: false } } }))
    assert.equal(readGuardSettings(dir).enabled, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("this repo's own settings file parses and is enforceable", () => {
  // The file the rubric checks for must be the file the guard actually reads - a settings
  // file nothing consumes is decoration.
  const s = readGuardSettings(process.cwd())
  assert.equal(s.enabled, true)
  assert.match(s.source, /\.claude\/settings\.json$/)
  assert.ok(s.refuse.length >= 2, "this repo declares its own project-local refusals")
  assert.ok(refusalFor("git config core.hooksPath /dev/null", s.refuse), "and they are enforced")
})

test("every built-in refusal carries a reason a worker can act on", () => {
  for (const r of REFUSED) {
    assert.ok(r.reason.length > 40, `${r.pattern}: too terse to act on`)
    assert.doesNotMatch(r.reason, /^(no|not allowed|forbidden)\.?$/i, `${r.pattern}: states no alternative`)
  }
})
