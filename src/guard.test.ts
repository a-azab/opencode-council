import { test } from "node:test"
import assert from "node:assert/strict"
import {
  canonical,
  actionKey,
  observe,
  reset,
  shouldNudge,
  exhausted,
  nudge,
  stopReason,
  NUDGE_AT,
  STOP_AT,
  PREVIEW_CHARS,
  type Repeat,
} from "./guard.ts"

// ------------------------------------------------------------------ identity

test("key order cannot disguise a repeat", () => {
  // dsh's sortJsonValue, and the reason it exists: without a deep key-sort, a worker
  // emitting the same edit with its JSON keys in a different order reads as progress.
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }))
  assert.equal(actionKey("diff", { a: 1, b: [{ x: 1, y: 2 }] }), actionKey("diff", { b: [{ y: 2, x: 1 }] , a: 1 }))
})

test("different payloads are different actions", () => {
  assert.notEqual(actionKey("diff", "a"), actionKey("diff", "b"))
})

test("the same payload under a different kind is a different action", () => {
  assert.notEqual(actionKey("diff", "x"), actionKey("command", "x"))
})

test("an uncanonicalizable payload does not throw", () => {
  // A throw here would fail a run over a diagnostic, which is never the right trade.
  const cyclic: any = {}
  cyclic.self = cyclic
  assert.doesNotThrow(() => actionKey("diff", cyclic))
})

// ------------------------------------------------------------------ the chain

test("consecutive identical actions accumulate", () => {
  let c: Repeat | undefined
  c = observe(c, "diff", "same")
  assert.equal(c.count, 1)
  c = observe(c, "diff", "same")
  assert.equal(c.count, 2)
  c = observe(c, "diff", "same")
  assert.equal(c.count, 3)
})

test("a different action restarts the count", () => {
  let c: Repeat | undefined
  c = observe(c, "diff", "a")
  c = observe(c, "diff", "a")
  assert.equal(c.count, 2)
  c = observe(c, "diff", "b")
  assert.equal(c.count, 1, "a genuinely different attempt is not part of the chain")
})

test("new information clears the chain", () => {
  // dsh resets on a user message; here the equivalent is judge feedback or a check
  // failure. Without this a worker correctly re-applying a fix after being told
  // something new would be stopped for looping.
  let c: Repeat | undefined = observe(observe(undefined, "diff", "x"), "diff", "x")
  assert.equal(c.count, 2)
  c = reset()
  assert.equal(c, undefined)
  c = observe(c, "diff", "x")
  assert.equal(c.count, 1)
})

// ------------------------------------------------------------------ thresholds

test("one attempt is never a loop", () => {
  const c = observe(undefined, "diff", "x")
  assert.equal(shouldNudge(c), false)
  assert.equal(exhausted(c), false)
})

test("the nudge fires before the stop, not with it", () => {
  let c: Repeat | undefined
  for (let i = 0; i < NUDGE_AT; i++) c = observe(c, "diff", "x")
  assert.equal(shouldNudge(c), true, "a worker must be told before it is stopped")
  assert.equal(exhausted(c), false)
})

test("the stop fires at the threshold", () => {
  let c: Repeat | undefined
  for (let i = 0; i < STOP_AT; i++) c = observe(c, "diff", "x")
  assert.equal(exhausted(c), true)
  assert.equal(shouldNudge(c), false, "past the stop it is no longer merely a nudge")
})

test("an absent chain is neither nudged nor exhausted", () => {
  assert.equal(shouldNudge(undefined), false)
  assert.equal(exhausted(undefined), false)
})

test("thresholds are tighter than dsh's, deliberately", () => {
  // dsh counts tool calls inside a turn, where three identical greps cost seconds. Here
  // the unit is a full attempt - model call, verify run, judge panel.
  assert.ok(STOP_AT <= 3, "an attempt is expensive; three identical ones is already waste")
  assert.ok(NUDGE_AT < STOP_AT, "there must be room to warn before stopping")
})

// ------------------------------------------------------------------ the messages

test("the nudge names what was repeated and demands a diagnosis", () => {
  const c = observe(observe(undefined, "diff", "the repeated thing"), "diff", "the repeated thing")
  const text = nudge(c, "diff")
  assert.match(text, /2 times in a row/)
  assert.match(text, /the repeated thing/, "quote it back - vague advice is what it already believes it is following")
  assert.match(text, /expected to happen/)
  assert.match(text, /assumption/)
  assert.doesNotMatch(text, /try something different/i, "that is advice, not a procedure")
})

test("a large repeated payload is previewed, not pasted", () => {
  // The thing being repeated in a loop is often exactly the large one.
  const big = "x".repeat(PREVIEW_CHARS * 4)
  const c = observe(observe(undefined, "diff", big), "diff", big)
  const text = nudge(c, "diff")
  assert.ok(text.length < big.length, "the reminder must not itself blow the context")
  assert.match(text, /more chars/, "and it must say how much was omitted")
})

test("detection uses the full payload even when the preview is truncated", () => {
  // dsh's rule: the cap bounds the message, never the chain key.
  const a = "y".repeat(PREVIEW_CHARS) + "TAIL-A"
  const b = "y".repeat(PREVIEW_CHARS) + "TAIL-B"
  const c = observe(observe(undefined, "diff", a), "diff", b)
  assert.equal(c.count, 1, "payloads differing only past the preview cap are still different")
})

test("the stop reason does not blame the worker", () => {
  // Measured: an unsatisfiable acceptance criterion where the worker wrote the correct
  // file every time and the judge could not see the evidence it needed. Blaming the
  // worker there pointed maintainers at entirely the wrong thing.
  const c = observe(observe(observe(undefined, "diff", "x"), "diff", "x"), "diff", "x")
  const text = stopReason(c, "attempt")
  assert.match(text, /acceptance criteria are not checkable/)
  assert.doesNotMatch(text, /the worker (failed|is wrong|did not)/i)
})
