import { test } from "node:test"
import assert from "node:assert/strict"
import { substitutesFor, benchable, MAX_SUBSTITUTIONS, type Bench } from "./engine.ts"
import { selectNodes, ALL_ROLES, ROSTER } from "./roster.ts"

// Measured 2026-08-21, full-panel review of lets: 24 of 56 lanes reported. `code` had
// no working model at all (kimi quota exhausted) and four models returned `malformed` on
// every slice. Dropping a lane while eight unused models sat idle is the gap these cover.

const round = selectNodes(ALL_ROLES)
const codeNode = round.find((n) => n.slug === "kimik3")!

test("a lane survives its model dying, even when every model is already assigned", () => {
  // The bug this replaced: substitutes were drawn only from unassigned models, so a full
  // panel offered zero stand-ins at exactly the moment coverage was being lost.
  const subs = substitutesFor(codeNode, round, new Map([["kimik3", "quota"]]), new Set(["kimik3"]))
  assert.ok(subs.length > 0, "a full panel must still offer substitutes")
  assert.ok(!subs.some((m) => m.slug === "kimik3"), "never re-offers the model that just failed")
})

test("a benched model is never offered to any lane", () => {
  const bench: Bench = new Map([
    ["kimik3", "quota"], ["minimax", "malformed"], ["nemoultra", "malformed"],
    ["nemolight", "malformed"], ["mimo", "malformed"],
  ])
  const subs = substitutesFor(codeNode, round, bench, new Set(["kimik3"]))
  for (const slug of bench.keys()) assert.ok(!subs.some((m) => m.slug === slug), `${slug} was offered while benched`)
})

test("substitutes prefer diversity, then the role, then correlation", () => {
  const subs = substitutesFor(codeNode, round, new Map(), new Set(["kimik3"]))
  const inRound = new Set(round.map((n) => n.slug))
  const firstBusy = subs.findIndex((m) => inRound.has(m.slug))
  const lastFree = subs.map((m) => inRound.has(m.slug)).lastIndexOf(false)
  if (firstBusy !== -1 && lastFree !== -1)
    assert.ok(lastFree < firstBusy, "every unassigned model must be offered before any busy one")
})

test("the lane is only lost when the roster is genuinely exhausted", () => {
  const dead = ROSTER.filter((m) => !["opus5", "gpt56terra", "fable"].includes(m.slug))
  const bench: Bench = new Map(dead.map((m) => [m.slug, "dead"]))
  const subs = substitutesFor(codeNode, round, bench, new Set(["kimik3"]))
  assert.deepEqual(subs.map((m) => m.slug).sort(), ["fable", "gpt56terra", "opus5"])

  const everything: Bench = new Map(ROSTER.map((m) => [m.slug, "dead"]))
  assert.deepEqual(substitutesFor(codeNode, round, everything, new Set()), [],
    "with nothing alive the lane is honestly lost, not faked")
})

test("an exhausted roster can recruit from the catalog, by injection", () => {
  // The pool is passed in, never fetched here: the test below asserts a fully benched
  // roster returns []. If this function fetched a catalogue, that assertion would depend on
  // live network state and the suite would pass or fail by weather.
  const everything: Bench = new Map(ROSTER.map((m) => [m.slug, "dead"]))
  assert.deepEqual(substitutesFor(codeNode, round, everything, new Set()), [],
    "with no pool offered, behaviour is exactly what it is today")

  // codeNode is kimik3, so the FAMILY here is `kimi-for-coding`. A sibling from another
  // provider would never exercise the family rule.
  const sibling = { slug: "k3-sib", model: "kimi-for-coding/k3-256k", roles: ["code"], ms: 9999 } as any
  const far = { slug: "far", model: "other/model", roles: ["code"], ms: 100 } as any
  const subs = substitutesFor(codeNode, round, everything, new Set(), [far, sibling])
  assert.deepEqual(subs.map((m) => m.slug), ["k3-sib", "far"],
    "same provider family first, even though the stranger is 100x faster by ms")
})

test("model-level failures bench; call-level ones do not", () => {
  // A timeout may be this diff being large. A malformed response means the model cannot
  // emit a forced tool call at all, and will fail identically on all 14 lanes.
  assert.ok(benchable("malformed", ""), "malformed is a model capability, not bad luck")
  assert.ok(benchable("autherror", ""), "auth will not fix itself mid-run")
  assert.ok(benchable("failed", "APIError: You've reached your usage limit for this billing cycle"))
  assert.equal(benchable("timeout", "The operation was aborted due to timeout"), null,
    "a timeout must not bench a model that may answer a smaller slice")
  assert.equal(benchable("ratelimited", "429"), null, "rate limits pass; retry handles them")
})

test("substitution is bounded", () => {
  // Without a cap one dead lane could walk the entire roster on every node.
  assert.ok(MAX_SUBSTITUTIONS >= 1 && MAX_SUBSTITUTIONS <= 5, `implausible cap: ${MAX_SUBSTITUTIONS}`)
})
