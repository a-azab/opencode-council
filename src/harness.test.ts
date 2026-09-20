import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  findHarness,
  parseAudit,
  percent,
  comparable,
  regressions,
  belowFloor,
  judge,
  renderDelta,
  renderAudit,
  regressionFeedback,
  planContext,
  auditLine,
  runAudit,
  ECC_DEFAULT,
  type HarnessAudit,
} from "./harness.ts"

// A scorer JSON in the shape ECC's harness-audit.js actually emits. Verified against a
// live run of /root/code/AI/ECC/scripts/harness-audit.js on 2026-09-19; the fields asserted
// here are the ones parseAudit reads, and nothing else is relied on.
const RAW = JSON.stringify({
  scope: "repo",
  root_dir: "/repo",
  target_mode: "consumer",
  deterministic: true,
  rubric_version: "2026-05-19",
  overall_score: 9,
  max_score: 39,
  categories: {
    "Tool Coverage": { score: 0, earned: 0, max: 7 },
    "Quality Gates": { score: 6, earned: 4, max: 7 },
    "Vercel Integration": { score: 3, earned: 1, max: 4 },
  },
  applicable_categories: ["Tool Coverage", "Quality Gates"],
  category_count: 2,
  checks: [],
  top_actions: [
    { action: "Add a CI workflow", path: ".github/workflows/", category: "Quality Gates", points: 3 },
  ],
})

const audit = (over: Partial<HarnessAudit> = {}): HarnessAudit => ({
  target: "/repo",
  rubric: "2026-05-19",
  mode: "consumer",
  score: 20,
  max: 40,
  categories: { A: 8, B: 6 },
  actions: [],
  ...over,
})

// ------------------------------------------------------------------ locating

test("an explicit `none` declines the scorer and stops the probe", () => {
  // The same distinction `tracker` draws. Probing after an explicit decline would
  // re-impose a gate the human deliberately turned off, and they would have no way to
  // keep it off short of deleting ECC.
  assert.equal(findHarness("none", { ECC_HOME: ECC_DEFAULT }), null)
})

test("a configured path that has no scorer falls through rather than being trusted", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-"))
  try {
    // Returning the configured location anyway would mean every audit fails at exec time
    // instead of the config being reported as wrong once. Asserted as "not this dir"
    // rather than "null", because the default probe may legitimately find a real ECC on
    // the machine running the tests — which is itself the correct fall-through.
    const found = findHarness(dir, { ECC_HOME: "/nonexistent-ecc" })
    assert.notEqual(found?.root, dir)
    assert.ok(found === null || found.from === "probe")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("config beats $ECC_HOME beats the default probe", () => {
  const a = mkdtempSync(join(tmpdir(), "ecc-a-"))
  const b = mkdtempSync(join(tmpdir(), "ecc-b-"))
  try {
    for (const d of [a, b]) {
      mkdirSync(join(d, "scripts"), { recursive: true })
      writeFileSync(join(d, "scripts", "harness-audit.js"), "")
    }
    assert.equal(findHarness(a, { ECC_HOME: b })?.root, a)
    assert.equal(findHarness(a, { ECC_HOME: b })?.from, "config")
    assert.equal(findHarness(undefined, { ECC_HOME: b })?.root, b)
    assert.equal(findHarness(undefined, { ECC_HOME: b })?.from, "env")
  } finally {
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ parsing

test("the scorer's JSON parses to the fields the gate actually uses", () => {
  const r = parseAudit(RAW, "/repo")
  assert.ok(r.ok)
  assert.equal(r.audit.score, 9)
  assert.equal(r.audit.max, 39)
  assert.equal(r.audit.rubric, "2026-05-19")
  assert.equal(r.audit.mode, "consumer")
  assert.equal(r.audit.actions[0].path, ".github/workflows/")
})

test("only applicable categories are scored", () => {
  // ECC reports deploy-target categories only when a marker file is present, but its
  // `categories` map can still carry one. Scoring a category this repo does not have
  // would invent a regression out of a missing vercel.json.
  const r = parseAudit(RAW, "/repo")
  assert.ok(r.ok)
  assert.deepEqual(Object.keys(r.audit.categories).sort(), ["Quality Gates", "Tool Coverage"])
  assert.equal(r.audit.categories["Vercel Integration"], undefined)
})

test("output that is not JSON is a missing signal, not a crash", () => {
  const r = parseAudit("Error: cannot find module\n", "/repo")
  assert.equal(r.ok, false)
  assert.match((r as { ok: false; reason: string }).reason, /not JSON/)
})

test("JSON without a score is rejected rather than read as zero", () => {
  // A zero here would look exactly like a catastrophic regression and fail every item on
  // the run. Absent is absent.
  const r = parseAudit(JSON.stringify({ rubric_version: "x" }), "/repo")
  assert.equal(r.ok, false)
})

test("an audit that cannot run returns a reason instead of throwing", () => {
  const r = runAudit({ root: "/nonexistent", script: "/nonexistent/x.js", from: "config" }, "/tmp", 5000)
  assert.equal(r.ok, false)
  assert.match((r as { ok: false; reason: string }).reason, /did not run/)
})

// ------------------------------------------------------------------ comparison

test("scores from different rubrics are never subtracted", () => {
  // ECC rescores categories between rubric versions, so a drop measured across an upgrade
  // is a measurement artefact. Failing an item for it would punish work that did nothing.
  const before = audit({ rubric: "2026-01-01", categories: { A: 10 } })
  const after = audit({ rubric: "2026-05-19", categories: { A: 2 } })
  assert.equal(comparable(before, after), false)
  assert.deepEqual(regressions(before, after), [])
  assert.match(renderDelta(before, after), /not comparable/)
})

test("a category that regressed is named, with both numbers", () => {
  const drops = regressions(audit({ categories: { A: 8, B: 6 } }), audit({ categories: { A: 3, B: 6 } }))
  assert.deepEqual(drops, [{ category: "A", before: 8, after: 3 }])
})

test("a newly applicable category is not a regression", () => {
  // Adding a fly.toml makes Fly Integration applicable and it scores 0 on day one. That
  // is new information about the repo, not damage done by the run.
  const drops = regressions(audit({ categories: { A: 8 } }), audit({ categories: { A: 8, Fly: 0 } }))
  assert.deepEqual(drops, [])
})

test("a lower total with no category drop is not a regression", () => {
  // max_score moves when a category becomes applicable, so the overall score can fall
  // while nothing got worse. This is exactly why the gate compares per category.
  const before = audit({ score: 20, max: 20, categories: { A: 10 } })
  const after = audit({ score: 20, max: 30, categories: { A: 10, New: 0 } })
  assert.deepEqual(regressions(before, after), [])
  assert.equal(judge(before, { ok: true, audit: after }).kind, "pass")
})

test("regressions are ordered worst drop first", () => {
  const drops = regressions(
    audit({ categories: { small: 5, big: 10 } }),
    audit({ categories: { small: 4, big: 2 } }),
  )
  assert.deepEqual(drops.map((d) => d.category), ["big", "small"])
})

// ------------------------------------------------------------------ the floor

test("the floor is a percentage of the applicable max, not a raw score", () => {
  assert.equal(percent(audit({ score: 9, max: 39 })), 23)
  assert.equal(belowFloor(audit({ score: 9, max: 39 }), 23), null)
  assert.deepEqual(belowFloor(audit({ score: 9, max: 39 }), 24), { floor: 24, actual: 23 })
})

test("no recorded floor means the floor never fires", () => {
  assert.equal(belowFloor(audit({ score: 0, max: 40 }), undefined), null)
  assert.equal(judge(null, { ok: true, audit: audit({ score: 0, max: 40 }) }).kind, "pass")
})

test("a zero max does not divide by zero", () => {
  assert.equal(percent(audit({ score: 0, max: 0 })), 0)
})

// ------------------------------------------------------------------ the verdict

test("an unavailable audit is its own verdict, never a pass", () => {
  // "the harness held" and "nobody looked" must stay distinguishable. Collapsing them
  // into pass is the unverified-presented-as-verified move /council:fix refuses.
  const v = judge(audit(), { ok: false, reason: "ENOENT" })
  assert.equal(v.kind, "unavailable")
})

test("a regression wins over a floor breach in the verdict, and still reports both", () => {
  const before = audit({ categories: { A: 8 } })
  const after = audit({ score: 1, max: 40, categories: { A: 1 } })
  const v = judge(before, { ok: true, audit: after }, 50)
  assert.equal(v.kind, "regressed")
  assert.ok(v.kind === "regressed" && v.breach)
})

test("with no baseline the floor still gates", () => {
  // A baseline that could not be taken must not silently disable the absolute check —
  // the floor is not relative and does not need one.
  const v = judge(null, { ok: true, audit: audit({ score: 1, max: 40 }) }, 50)
  assert.equal(v.kind, "below-floor")
})

// ------------------------------------------------------------------ feedback

test("the retry feedback names the categories and the scorer's own paths", () => {
  const after = audit({
    categories: { "Quality Gates": 2 },
    actions: [
      { action: "Add a CI workflow", path: ".github/workflows/", category: "Quality Gates", points: 3 },
      { action: "Unrelated", path: "elsewhere/", category: "Cost Efficiency", points: 1 },
    ],
  })
  const v = judge(audit({ categories: { "Quality Gates": 7 } }), { ok: true, audit: after })
  const text = regressionFeedback(v, after)
  assert.match(text, /Quality Gates: 7\/10 → 2\/10/)
  assert.match(text, /\.github\/workflows\//)
  // Actions for categories that did not regress are noise in a retry prompt.
  assert.doesNotMatch(text, /Unrelated/)
  // A worker told only that a number fell will raise the number the cheap way.
  assert.match(text, /do not weaken the check/i)
})

test("a passing verdict produces no feedback", () => {
  assert.equal(regressionFeedback({ kind: "pass" }, audit()), "")
})

test("unrelated actions are never presented as the cause of the regression", () => {
  // Live-run finding: the scorer's top_actions are its highest-value fixes overall and
  // frequently exclude the category that just regressed. Listing them under "actions for
  // these" points the retry at unrelated work while claiming to explain the failure.
  const after = audit({
    categories: { "Quality Gates": 2 },
    actions: [{ action: "Install the plugin", path: "~/.claude/", category: "Tool Coverage", points: 4 }],
  })
  const v = judge(audit({ categories: { "Quality Gates": 7 } }), { ok: true, audit: after })
  const text = regressionFeedback(v, after)
  assert.match(text, /no recommended action for these categories/)
  assert.match(text, /NOT the regression/)
})

// ------------------------------------------------------------------ rendering

test("the delta says so plainly when there is nothing to compare", () => {
  assert.match(renderDelta(null, null), /never audited/)
  assert.match(renderDelta(audit(), null), /not after/)
  assert.match(renderDelta(null, audit()), /no pre-run baseline/)
})

test("a clean delta says no category regressed rather than staying silent", () => {
  assert.match(renderDelta(audit(), audit()), /no category regressed/)
})

test("the audit line carries the rubric, so a stale comparison is visible", () => {
  assert.match(auditLine(audit()), /rubric 2026-05-19/)
})

test("the init block shows the weakest categories and the scorer's next actions", () => {
  const text = renderAudit(
    audit({
      categories: { Weak: 1, Strong: 10, Middling: 5 },
      actions: [{ action: "Do the thing", path: "here/", category: "Weak", points: 2 }],
    }),
  )
  assert.match(text, /Weak: 1\/10/)
  assert.match(text, /Middling: 5\/10/)
  // A category already at 10 is not a finding.
  assert.doesNotMatch(text, /Strong/)
  assert.match(text, /Do the thing/)
})

test("planning context is labelled as background, not as work", () => {
  // The planner must not expand scope to chase a score. A gate that generates unrequested
  // work items is worse than no gate.
  const text = planContext(audit({ actions: [{ action: "X", path: "p", category: "C", points: 1 }] }))
  assert.match(text, /do NOT add work items/i)
})

test("no actions means no planning context at all", () => {
  assert.equal(planContext(audit()), "")
})
