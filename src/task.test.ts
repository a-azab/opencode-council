import { test } from "node:test"
import assert from "node:assert/strict"
import { scorersFor } from "./engine.ts"

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
