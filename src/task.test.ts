import { test } from "node:test"
import assert from "node:assert/strict"
import { scorersFor } from "./engine.ts"
import { TASK_PROPOSAL_SCHEMA, TASK_SCORE_SCHEMA } from "./schema.ts"

test("scorer assignment is deterministic, never self, and survives a thin panel", () => {
  const p = (n: number) => Array.from({ length: n }, (_, i) => ({ slug: `m${i}` }))
  for (const n of [1, 2, 3, 4, 16]) {
    const map = scorersFor(p(n))
    if (n === 1) { assert.equal(map.get("m0")!.length, 0, "one proposal has no scorer"); continue }
    for (const [proposal, scorers] of map) {
      assert.equal(scorers.length, Math.min(3, n - 1), `k = min(3, N-1) at N=${n}`)
      assert.ok(!scorers.includes(proposal), "a model never scores its own answer")
      assert.equal(new Set(scorers).size, scorers.length, "no scorer twice")
    }
  }
  assert.deepEqual(scorersFor(p(16)), scorersFor(p(16)), "same input, same assignment")
})

test("the task score keeps Score's four dimensions so tally() stays usable", () => {
  // A 1-10 scalar would make tally()'s four-term sum NaN; NaN compares falsy, so its sort
  // falls through to alphabetical-by-slug and still reports a confident winner. That is a
  // false consensus - precisely what council:task exists to prevent.
  const props = TASK_SCORE_SCHEMA.properties
  for (const dim of ["correctness", "simplicity", "risk", "completeness"])
    assert.ok(props[dim], `tally() sums ${dim}; the task score must carry it`)
  assert.ok(props.objection, "dissent needs its own field: `reason` is praise when the score is high")
  assert.ok(TASK_PROPOSAL_SCHEMA.properties.confidence, "confidence is printed beside each answer")
})
