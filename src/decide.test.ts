// The one test. decide() is the deterministic core everything else rests on, so this file
// pins its behaviour - especially the two asymmetries, which are easy to "simplify" into
// bugs later. Run: node --test src/
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  decide,
  applyOutcome,
  dedupe,
  disputes,
  converged,
  applyRevisions,
  signature,
  type Finding,
  type Verdict,
  type Tier,
} from "./decide.ts"

const f = (over: Partial<Finding> = {}): Finding => ({
  tier: "BLOCKER",
  category: "correctness",
  file: "src/a.ts",
  line: 10,
  issue: "i",
  why: "w",
  fix: "x",
  confidence: "high",
  ...over,
})

const no = (c: Verdict["confidence"] = "high"): Verdict => ({ real: false, confidence: c, reason: "r" })
const yes = (c: Verdict["confidence"] = "high"): Verdict => ({ real: true, confidence: c, reason: "r" })

// --- decide: absent evidence -------------------------------------------------

test("no votes keeps the finding - absent evidence is not refutation", () => {
  assert.equal(decide(f(), []), "keep")
  assert.equal(decide(f({ category: "security" }), []), "keep")
  assert.equal(decide(f({ tier: "NIT" }), []), "keep")
})

// --- decide: ordinary categories ---------------------------------------------

test("BLOCKER dropped when every skeptic refutes it", () => {
  assert.equal(decide(f(), [no(), no(), no()]), "drop")
})

test("BLOCKER dropped on a high-confidence majority", () => {
  assert.equal(decide(f(), [no("high"), no("high"), yes()]), "drop")
})

test("BLOCKER only downgraded when the refuting majority is not high-confidence", () => {
  assert.equal(decide(f(), [no("medium"), no("low"), yes()]), "downgrade")
})

test("BLOCKER kept when refuters are a minority", () => {
  assert.equal(decide(f(), [no(), yes(), yes()]), "keep")
})

test("non-BLOCKER dropped on a simple majority, kept otherwise", () => {
  assert.equal(decide(f({ tier: "SUGGESTION" }), [no("low"), no("low"), yes()]), "drop")
  assert.equal(decide(f({ tier: "SUGGESTION" }), [no(), yes(), yes()]), "keep")
})

// --- decide: the security asymmetry ------------------------------------------

test("security BLOCKER survives unanimous refutation unless it is all high-confidence", () => {
  // every vote false, but not all high => must NOT drop
  assert.equal(decide(f({ category: "security" }), [no("high"), no("medium")]), "downgrade")
})

test("security finding drops only on unanimous high-confidence refutation", () => {
  assert.equal(decide(f({ category: "security" }), [no("high"), no("high"), no("high")]), "drop")
})

test("security SUGGESTION is kept where an ordinary one would be dropped", () => {
  const votes = [no("medium"), no("low"), yes()] // simple majority false
  assert.equal(decide(f({ tier: "SUGGESTION" }), votes), "drop")
  assert.equal(decide(f({ tier: "SUGGESTION", category: "security" }), votes), "keep")
})

// --- applyOutcome -------------------------------------------------------------

test("applyOutcome maps outcomes to findings", () => {
  assert.equal(applyOutcome(f(), "drop"), null)
  assert.equal(applyOutcome(f(), "keep")!.tier, "BLOCKER")
  assert.equal(applyOutcome(f(), "downgrade")!.tier, "SUGGESTION")
  assert.equal(applyOutcome(f({ tier: "SUGGESTION" }), "downgrade")!.tier, "NIT")
})

// --- dedupe -------------------------------------------------------------------

test("dedupe merges same file+category within the line window, keeping the highest tier", () => {
  const groups = dedupe([
    f({ line: 10, tier: "SUGGESTION", role: "code", model: "kimik3" }),
    f({ line: 12, tier: "BLOCKER", role: "security", model: "fable" }),
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].finding.tier, "BLOCKER")
  assert.equal(groups[0].reports.length, 2)
})

test("dedupe keeps findings apart across the window and across categories", () => {
  assert.equal(dedupe([f({ line: 10 }), f({ line: 40 })]).length, 2)
  assert.equal(dedupe([f({ line: 10 }), f({ line: 10, category: "security" })]).length, 2)
  assert.equal(dedupe([f({ file: "a.ts" }), f({ file: "b.ts" })]).length, 2)
})

// --- disputes -----------------------------------------------------------------

test("a group is disputed only when reporters disagree on tier", () => {
  const disagree = dedupe([
    f({ line: 10, tier: "BLOCKER", model: "opus5" }),
    f({ line: 10, tier: "NIT", model: "mimo" }),
  ])
  assert.equal(disputes(disagree).length, 1)

  const agree = dedupe([
    f({ line: 10, tier: "BLOCKER", model: "opus5" }),
    f({ line: 10, tier: "BLOCKER", model: "mimo" }),
  ])
  assert.equal(disputes(agree).length, 0)
})

test("a model filing two tiers at the same spot is not a dispute with itself", () => {
  // Observed in the first end-to-end run: minimax reported auth.js:8 as both BLOCKER and
  // SUGGESTION, which registered as a disagreement and would have dispatched minimax to
  // debate its own finding.
  const selfOnly = dedupe([
    f({ line: 8, tier: "BLOCKER", model: "minimax" }),
    f({ line: 8, tier: "SUGGESTION", model: "minimax" }),
  ])
  assert.equal(disputes(selfOnly).length, 0)

  // but a genuine cross-model disagreement still registers, even alongside a self-double
  const mixed = dedupe([
    f({ line: 8, tier: "BLOCKER", model: "minimax" }),
    f({ line: 8, tier: "SUGGESTION", model: "minimax" }),
    f({ line: 8, tier: "NIT", model: "kimik3" }),
  ])
  assert.equal(disputes(mixed).length, 1)
})

// --- converged ----------------------------------------------------------------

const disputed = () =>
  dedupe([f({ line: 10, tier: "BLOCKER", model: "a" }), f({ line: 10, tier: "NIT", model: "b" })])

test("converged when nothing is disputed", () => {
  const settled = dedupe([f({ model: "a" }), f({ model: "b" })])
  assert.equal(converged(null, settled, 1, 3).done, true)
})

test("converged at the round limit even with disputes outstanding", () => {
  const r = converged(null, disputed(), 3, 3)
  assert.equal(r.done, true)
  assert.match(r.reason, /round limit/)
})

test("converged when no tier moved since the previous round", () => {
  const a = disputed()
  const b = disputed()
  assert.equal(signature(a), signature(b))
  assert.equal(converged(a, b, 1, 3).done, true)
})

test("not converged while disputes remain and tiers are still moving", () => {
  const prev = dedupe([f({ line: 10, tier: "BLOCKER", model: "a" }), f({ line: 10, tier: "NIT", model: "b" })])
  const cur = dedupe([
    f({ line: 10, tier: "SUGGESTION", model: "a" }),
    f({ line: 10, tier: "NIT", model: "b" }),
  ])
  assert.equal(converged(prev, cur, 1, 3).done, false)
})

// --- applyRevisions (the debate fold) -----------------------------------------

const twoReports = () =>
  dedupe([
    f({ line: 10, tier: "BLOCKER", model: "a" }),
    f({ line: 10, tier: "NIT", model: "b" }),
  ])

test("a revision updates that reporter's tier and nobody else's", () => {
  const [g] = applyRevisions(twoReports(), [{ key: twoReports()[0].key, model: "b", tier: "BLOCKER" }])
  assert.deepEqual(
    g.reports.map((r) => [r.model, r.tier]).sort(),
    [["a", "BLOCKER"], ["b", "BLOCKER"]],
  )
})

test("WITHDRAW removes only that reporter", () => {
  const groups = twoReports()
  const [g] = applyRevisions(groups, [{ key: groups[0].key, model: "a", tier: "WITHDRAW" }])
  assert.equal(g.reports.length, 1)
  assert.equal(g.reports[0].model, "b")
})

test("a group whose every reporter withdraws disappears", () => {
  const groups = twoReports()
  const out = applyRevisions(groups, [
    { key: groups[0].key, model: "a", tier: "WITHDRAW" },
    { key: groups[0].key, model: "b", tier: "WITHDRAW" },
  ])
  assert.equal(out.length, 0)
})

test("the representative tier cannot outlive the argument for it", () => {
  // 'a' raised BLOCKER and now withdraws; the group must fall to what 'b' still argues
  const groups = twoReports()
  assert.equal(groups[0].finding.tier, "BLOCKER")
  const [g] = applyRevisions(groups, [{ key: groups[0].key, model: "a", tier: "WITHDRAW" }])
  assert.equal(g.finding.tier, "NIT")
})

test("an oscillating debate still terminates via the signature check", () => {
  // two rounds that swap tiers back and forth would never clear disputes on their own
  const roundA = twoReports()
  const roundB = applyRevisions(roundA, [{ key: roundA[0].key, model: "b", tier: "NIT" }])
  assert.equal(signature(roundA), signature(roundB)) // nothing actually moved
  assert.equal(converged(roundA, roundB, 1, 99).done, true)
})
