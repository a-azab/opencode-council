import { test } from "node:test"
import assert from "node:assert/strict"
import { tally, TIE_MARGIN, type Score } from "./decide.ts"

const s = (proposal: string, scorer: string, v: number, over: Partial<Score> = {}): Score => ({
  proposal,
  scorer,
  correctness: v,
  simplicity: v,
  risk: v,
  completeness: v,
  reason: "r",
  ...over,
})

test("the highest mean wins", () => {
  const r = tally([s("a", "x", 5), s("a", "y", 5), s("b", "x", 2), s("b", "y", 2)])
  assert.equal(r.winner?.proposal, "a")
  assert.equal(r.winner?.mean, 20)
  assert.equal(r.ranked[0].proposal, "a")
})

test("a model scoring its own proposal is discarded", () => {
  // 'a' rates itself perfect; without the guard that self-score would carry it
  const r = tally([s("a", "a", 5), s("a", "x", 1), s("b", "x", 3), s("b", "y", 3)])
  assert.equal(r.winner?.proposal, "b")
  const a = r.ranked.find((t) => t.proposal === "a")!
  assert.equal(a.scores, 1, "only the non-self score should count")
})

test("a near-tie escalates instead of picking a winner", () => {
  // means 16 vs 15.9 - inside the margin, so no winner is declared
  const r = tally([
    s("a", "x", 4),
    s("b", "x", 4, { correctness: 3.9 as unknown as number }),
  ])
  assert.equal(r.winner, null)
  assert.equal(r.tied.length, 2)
})

test("a gap wider than the margin does produce a winner", () => {
  const r = tally([s("a", "x", 5), s("b", "x", 4)])
  assert.ok(r.winner, "a 4-point mean gap should not read as a tie")
  assert.equal(r.winner?.proposal, "a")
  assert.equal(r.tied.length, 0)
})

test("mean is used, so a proposal is not rewarded for being scored more often", () => {
  const r = tally([s("a", "x", 4), s("a", "y", 4), s("a", "z", 4), s("b", "x", 5)])
  assert.equal(r.winner?.proposal, "b", "b has one score but a higher mean")
})

test("no usable scores yields no winner rather than an arbitrary one", () => {
  assert.equal(tally([]).winner, null)
  assert.equal(tally([s("a", "a", 5)]).winner, null, "only a self-score is no evidence")
})

test("TIE_MARGIN is exported so the threshold is inspectable, not buried", () => {
  assert.equal(typeof TIE_MARGIN, "number")
})
