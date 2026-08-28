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

test("a specialist's lane is covered by the model named for it, not by whoever is idle", () => {
  // The owner's call: fable holds security because it is the security specialist, so when
  // it drops the cover is opus5 - not whichever carrier the availability sort happens to
  // reach first. Same for kimi and gpt56sol. Without a named cover the lane still gets
  // filled, but by a model nobody chose for it.
  const securityNode = round.find((n) => n.role === "security" && n.slug === "fable")!
  const bench: Bench = new Map([["fable", "dead"]])
  assert.equal(substitutesFor(securityNode, round, bench, new Set())[0].slug, "opus5",
    "fable's named cover must lead, ahead of the availability tiers")

  const kimiNode = round.find((n) => n.slug === "kimik3go")!
  assert.equal(
    substitutesFor(kimiNode, round, new Map([["kimik3go", "dead"]]), new Set())[0].slug,
    "gpt56sol",
    "kimi's named cover must lead",
  )
})

test("a named cover that is itself dead does not block the lane", () => {
  // The cover is a preference, not a dependency. If both the specialist and its understudy
  // are down the lane still fills from the ordinary tiers - losing a lane because the
  // second choice also failed would be worse than the default it replaced.
  const securityNode = round.find((n) => n.role === "security" && n.slug === "fable")!
  const both: Bench = new Map([["fable", "dead"], ["opus5", "dead"]])
  const subs = substitutesFor(securityNode, round, both, new Set())
  assert.ok(subs.length > 0, "the lane must still be coverable")
  assert.ok(!subs.some((m) => m.slug === "opus5"), "and never offers the benched cover")
})

test("the substitute list never repeats a model", () => {
  // The named cover also qualifies for whichever availability tier it belongs to, so
  // without a dedupe it would appear twice and MAX_SUBSTITUTIONS would burn an attempt
  // re-trying a model that had already failed.
  const securityNode = round.find((n) => n.role === "security" && n.slug === "fable")!
  const subs = substitutesFor(securityNode, round, new Map([["fable", "dead"]]), new Set())
  const slugs = subs.map((m) => m.slug)
  assert.equal(new Set(slugs).size, slugs.length, `duplicate in: ${slugs.join(", ")}`)
})

test("a spent kimi quota falls through to the other kimi route, not to a different model", () => {
  // kimi-for-coding/k3 and opencode-go/kimi-k3 are the same model behind two billing
  // routes, so the quota escape should stay within kimi rather than handing the lane to a
  // different vendor. Measured 2026-08-28: the coding plan answered "you have reached your
  // weekly (7-day) usage", which is exactly the case this covers.
  const node = round.find((n) => n.slug === "kimik3" && n.role === "security")!
  const spent: Bench = new Map([["kimik3", "quota"]])
  assert.equal(substitutesFor(node, round, spent, new Set())[0].slug, "kimik3go")

  // And when both routes are out, the lane still fills rather than being lost.
  const bothOut: Bench = new Map([["kimik3", "quota"], ["kimik3go", "quota"]])
  const subs = substitutesFor(node, round, bothOut, new Set())
  assert.ok(subs.length > 0, "the lane must still be coverable")
  assert.ok(!subs.some((m) => m.slug.startsWith("kimi")), "and must not offer a spent route")
})
