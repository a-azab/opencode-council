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
