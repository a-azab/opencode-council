// Loop guards, ported from DeepSeek Harness (dsh) as mechanisms rather than code.
//
// dsh's `guard/` group is two plugins totalling ~314 lines against its own cordis event
// bus. Neither is adoptable here - they hook `tools/post-execute` and `agent/pre-step`,
// events this runtime does not have - but both encode a lesson worth keeping, and the
// lessons transfer even though the code cannot:
//
//   repeat-tool-reminder: a loop is not an error. Nothing throws, no check fails, and no
//     deadline fires - the agent simply stops making progress while looking productive.
//     Detection has to be structural (identity of successive actions), because no
//     individual action is wrong.
//
//   timeout-policy: whose timeout fired is part of the fact. dsh scopes its deadline to
//     its own code so an outer timer that fired first is not misreported as this one's.
//
// The dsh choices kept:
//   - canonical identity, so argument key ORDER cannot disguise a repeat
//   - escalating thresholds: nudge, then name it explicitly
//   - a bounded preview of the repeated payload, because the thing being repeated in a
//     loop is often exactly the large one
//   - reset on genuinely new input, since repetition across a change of context is not a
//     loop
//
// The dsh choice deliberately NOT kept: dsh's guard is advisory and never vetoes. That
// is right for a chat agent a human is watching, and wrong for an unattended run - the
// whole problem here is that nobody is reading the transcript. So `exhausted()` ends the
// item, and the caller reports why.

import { createHash } from "node:crypto"

/**
 * Attempt counts that earn a reminder, then a stop.
 *
 * Ported from dsh's `[3, 5, 8]` but much tighter, because the unit is different: dsh
 * counts TOOL CALLS inside one agent turn, where three identical greps cost seconds.
 * Here the unit is a full attempt - a model call, a verify run, and a judge panel - so
 * three identical ones is already several minutes and several paid calls spent going
 * nowhere.
 */
export const NUDGE_AT = 2
export const STOP_AT = 3

/** Characters of the repeated payload quoted back. Bounds the message, never the detection. */
export const PREVIEW_CHARS = 400

export type Repeat = {
  /** identity of the last observed action */
  key: string
  /** how many times in a row it has now been seen */
  count: number
  /** what was repeated, for the message */
  sample: string
}

/**
 * Deep key-sort so two payloads differing only in property order canonicalize identically.
 *
 * Straight from dsh's `sortJsonValue`. Without it a worker that emits the same edit with
 * its JSON keys in a different order reads as making progress, which is the failure mode
 * this whole file exists to catch.
 */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === "object") {
    const rec = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(rec).sort()) out[k] = sortValue(rec[k])
    return out
  }
  return value
}

/** Canonical string form of any payload: deep key-sort, then stringify. */
export function canonical(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(sortValue(value)) ?? ""
  } catch {
    // A cycle or a bigint cannot come from the paths that feed this, but a throw here
    // would fail a run over a diagnostic, which is never the right trade.
    return String(value)
  }
}

/**
 * Identity of an action: what was done, and to what.
 *
 * Hashed rather than kept whole because these are diffs - holding several full ones per
 * item to compare them is how a guard against waste becomes the waste.
 */
export function actionKey(kind: string, payload: unknown): string {
  return `${kind}:${createHash("sha256").update(canonical(payload)).digest("hex")}`
}

/**
 * Fold one observed action into the running chain.
 *
 * Pure: takes the previous state and returns the next, so the caller owns the storage and
 * this stays trivially testable. dsh keeps a WeakMap keyed by agent; here the chain
 * belongs to an item and lives in the attempt loop.
 */
export function observe(prev: Repeat | undefined, kind: string, payload: unknown): Repeat {
  const key = actionKey(kind, payload)
  const sample = canonical(payload)
  if (prev && prev.key === key) return { key, count: prev.count + 1, sample }
  return { key, count: 1, sample }
}

/**
 * Repetition across genuinely new input is not a loop.
 *
 * dsh resets its chain when a user message appears. The equivalent here is any new
 * information reaching the worker - judge feedback, a different check failure, an
 * escalation brief. Without this, a worker correctly re-applying the same fix after being
 * told something new would be stopped for looping.
 */
export function reset(): Repeat | undefined {
  return undefined
}

/** Whether this chain has earned a nudge (but not yet a stop). */
export const shouldNudge = (r: Repeat | undefined): boolean =>
  r !== undefined && r.count >= NUDGE_AT && r.count < STOP_AT

/** Whether this chain has run out of rope. */
export const exhausted = (r: Repeat | undefined): boolean => r !== undefined && r.count >= STOP_AT

function preview(sample: string): string {
  return sample.length <= PREVIEW_CHARS
    ? sample
    : `${sample.slice(0, PREVIEW_CHARS)}… (+${sample.length - PREVIEW_CHARS} more chars)`
}

/**
 * The nudge, in the second person, naming what is being repeated.
 *
 * dsh escalates gentle then detailed; with only one nudge tier before the stop, this is
 * the detailed one. Vague encouragement ("try something different") is what a model
 * already believes it is doing.
 */
export function nudge(r: Repeat, what: string): string {
  return [
    `You have now produced the same ${what} ${r.count} times in a row.`,
    "",
    "It is not working, and repeating it again will end this item with nothing landed.",
    "Do not try a variation of the same approach. Before you act:",
    "  1. State what you expected to happen, and what actually happened.",
    "  2. Name the assumption those two disagree about.",
    "  3. Verify that assumption against the repo - read the file, run the check - before",
    "     changing anything.",
    "",
    `What you repeated:\n${preview(r.sample)}`,
  ].join("\n")
}

/**
 * The stop reason, for the outcome record.
 *
 * Phrased as an observation rather than a verdict on the worker. The measured case is an
 * unsatisfiable acceptance criterion where the worker wrote the correct file every time
 * and the judge could not see the evidence it needed - blaming the worker there pointed
 * maintainers at entirely the wrong thing.
 */
export function stopReason(r: Repeat, what: string): string {
  return (
    `stopped after ${r.count} identical ${what}s — the attempts stopped differing, so more ` +
    `of them would cost models and change nothing. Either the approach is wrong, or the ` +
    `acceptance criteria are not checkable from what the worker can see.`
  )
}
