import { test } from "node:test"
import assert from "node:assert/strict"
import { scorersFor, decideTask, type TaskProposal, type TaskScore } from "./engine.ts"
import { TASK_PROPOSAL_SCHEMA, TASK_SCORE_SCHEMA } from "./schema.ts"
import { renderTask } from "./report.ts"

const prop = (slug: string): TaskProposal => ({
  slug, role: "reviewer", model: `test/${slug}`,
  answer: `answer from ${slug}`, reasoning: "because", confidence: "medium", state: "ok",
})
const fixtureProposals = (n: number) => Array.from({ length: n }, (_, i) => prop(`m${i}`))

/** Four dimensions, exactly as `Score` - tally() sums these and nothing else. */
const score = (proposal: string, scorer: string, v: number, objection = ""): TaskScore =>
  ({ proposal, scorer, correctness: v, simplicity: v, risk: v, completeness: v,
     reason: "fixture", objection })

/** Everyone scores 2s except `favoured`, who scores 5s. */
const fixtureScoresFavouring = (favoured: string, props = fixtureProposals(3)) =>
  props.flatMap((p) => props.filter((q) => q.slug !== p.slug)
    .map((q) => score(p.slug, q.slug, p.slug === favoured ? 5 : 2)))

/** Identical scores => identical means => inside TIE_MARGIN. */
const fixtureScoresTied = (props = fixtureProposals(2)) =>
  props.flatMap((p) => props.filter((q) => q.slug !== p.slug).map((q) => score(p.slug, q.slug, 4)))

/** m0 and m1 are scored; m2 answered but every scorer call for it failed. */
const fixtureOrphanedAnswer = () => {
  const props = fixtureProposals(3)
  const scores = ["m0", "m1"].flatMap((s) =>
    props.filter((q) => q.slug !== s).map((q) => score(s, q.slug, 3)))
  return decideTask(props, scores)
}

const fixtureWithObjection = (text: string) =>
  decideTask(fixtureProposals(2), [score("m0", "m1", 5, text), score("m1", "m0", 2, "")])

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
    assert.ok(props[dim as keyof typeof props], `tally() sums ${dim}; the task score must carry it`)
  assert.ok(props.objection, "dissent needs its own field: `reason` is praise when the score is high")
  assert.ok(TASK_PROPOSAL_SCHEMA.properties.confidence, "confidence is printed beside each answer")
})

test("the winner is the highest mean, not the alphabetically first", () => {
  // Guards the NaN-sort failure directly: the LAST proposal by slug gets the best scores.
  const r = decideTask(fixtureProposals(3), fixtureScoresFavouring("m2"))
  assert.equal(r.winner?.slug, "m2")
  assert.equal(r.unscored, false)
})

test("a tie is reported as a tie, never resolved into a winner", () => {
  const r = decideTask(fixtureProposals(2), fixtureScoresTied())
  assert.equal(r.winner, null)
  assert.equal(r.tied.length, 2)
  assert.equal(r.runnerUp, null)
})

test("live answers with no usable score are unranked, not tied", () => {
  const r = decideTask(fixtureProposals(3), [])
  assert.equal(r.unscored, true)
  assert.equal(r.tied.length, 0)
  assert.equal(r.proposals.filter((p) => p.state === "ok").length, 3)
})

test("no live answer disappears from the report", () => {
  // tally() ranks only what it received scores for, so a proposal whose scorers all failed
  // is in ranked/winner/tied/runnerUp nowhere - and `unscored` is false, so the unranked
  // path never fires. Without an explicit section it vanishes while the report looks clean.
  const out = renderTask({ ...fixtureOrphanedAnswer(), goal: "a goal" })
  assert.match(out, /answered, but unscored/i)
  assert.match(out, /answer from m2/, "the orphaned answer must still be printed")
})

test("dissent survives into the report verbatim", () => {
  const out = renderTask({ ...fixtureWithObjection("this ignores the retry budget"), goal: "a goal" })
  assert.match(out, /this ignores the retry budget/)
})
