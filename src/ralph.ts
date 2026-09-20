// A fresh-agent loop: one objective, a new worker per round, a bounded handoff between.
//
// The problem this solves is stamina. `runItem` gives an item five attempts, and every
// attempt is a cold session that knows only the item and the last error string - so a
// worker on attempt 4 cannot tell what attempts 1-3 tried, and the run's own directive
// never reaches it at all. Attempts do not accumulate understanding; they repeat.
//
// The fix is not memory. It is a CONTRACT. Each round starts a genuinely fresh worker,
// because a long conversation is the thing that decays, and carries forward exactly two
// things: the immutable objective, and the previous round's structured report. The
// working tree is the long-term memory - it is what actually survives, and a worker that
// reads it is reading facts rather than a model's recollection of facts.
//
// Adapted from DeepSeek Harness's `tool-ralph` (packages/workflow/tool-ralph/src/index.ts,
// read 2026-09-20). Its schema and cross-field rules are reproduced closely; the loop is
// rewritten against this plugin's ask()/worktree seams. Three of its decisions are load-
// bearing and are kept verbatim in spirit:
//
//   1. The loop is OURS, not the model's. A worker supplies a report; it cannot change
//      the rounds, the schema, or the validation.
//   2. Validation is cross-field and refuses on violation. "complete" without evidence is
//      not a completion, it is a claim - and the whole point is to stop taking claims.
//   3. The result says the worker REPORTED completion. Nothing here verifies the work;
//      the caller's verify command and acceptance judge do that. Presenting a self-report
//      as certification is exactly the lie the rest of this plugin refuses to tell.
import { ROUND_REPORT_SCHEMA } from "./schema.ts"

/** Terminal states of one round, as the worker reports them. */
export type RoundStatus = "continue" | "complete" | "blocked"

export type RoundReport = {
  status: RoundStatus
  summary: string
  evidence: string[]
  next_steps: string[]
  blocker: string
}

/**
 * How a loop ended. Four outcomes, deliberately distinct:
 *
 * - `complete`   a worker reported the objective met, with evidence
 * - `blocked`    a worker named something a human has to resolve
 * - `out-of-rounds` the budget ran out with work still outstanding
 * - `round-failed`  a worker produced nothing usable
 *
 * Collapsing the last two into one would hide the difference between "this needs more
 * time" and "this is not working", which are opposite instructions to the human reading
 * the report.
 */
export type LoopStatus = "complete" | "blocked" | "out-of-rounds" | "round-failed"

export type LoopResult = {
  status: LoopStatus
  /** how many rounds actually started, not how many were budgeted */
  rounds: number
  /** the last VALID report, absent when round 1 produced nothing usable */
  report?: RoundReport
  /** why a round was rejected, when that is how the loop ended */
  detail?: string
  /** every round's report, in order - the run's own account of itself */
  history: RoundReport[]
}

export const MAX_HANDOFF_CHARS = 16_384

/** The schema a round worker must satisfy. Re-exported so callers need one import. */
export const ROUND_SCHEMA = ROUND_REPORT_SCHEMA

const normalized = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v === v.trim()
const normalizedList = (v: unknown): v is string[] => Array.isArray(v) && v.every(normalized)

/**
 * Validate one report against the contract.
 *
 * Returns a reason rather than throwing: a malformed report is an OUTCOME of the round,
 * and the loop turns it into feedback for the next one. Throwing would make a worker's
 * bad answer indistinguishable from a bug in the loop.
 *
 * The cross-field rules are the entire value of this function. A schema can say
 * `evidence` is an array of strings; only these rules can say that claiming completion
 * with an empty one is not a completion.
 */
export function validateReport(raw: unknown, maxHandoffChars = MAX_HANDOFF_CHARS): { ok: true; report: RoundReport } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, reason: "the round returned no structured report" }
  const r = raw as Record<string, unknown>

  if (!normalized(r.summary)) return { ok: false, reason: "summary must be a non-empty, trimmed string" }
  if (!normalizedList(r.evidence)) return { ok: false, reason: "evidence must contain only non-empty, trimmed strings" }
  if (!normalizedList(r.next_steps)) return { ok: false, reason: "next_steps must contain only non-empty, trimmed strings" }
  if (typeof r.blocker !== "string" || r.blocker !== r.blocker.trim())
    return { ok: false, reason: "blocker must be a trimmed string" }

  switch (r.status) {
    case "continue":
      // Continuing without a next step is a worker that has stopped thinking but not
      // stopped running - the most expensive failure mode in the loop.
      if (r.next_steps.length === 0) return { ok: false, reason: "a continuing round must say what comes next" }
      if (r.blocker !== "") return { ok: false, reason: "a continuing round cannot also carry a blocker" }
      break
    case "complete":
      // The rule that makes the whole contract worth having. Without it, "complete" is a
      // model's opinion of its own work, which is precisely what this plugin never accepts
      // anywhere else.
      if (r.evidence.length === 0) return { ok: false, reason: "a complete round must cite evidence, not assert success" }
      if (r.next_steps.length !== 0) return { ok: false, reason: "a complete round cannot leave next steps outstanding" }
      if (r.blocker !== "") return { ok: false, reason: "a complete round cannot also carry a blocker" }
      break
    case "blocked":
      if (!normalized(r.blocker)) return { ok: false, reason: "a blocked round must name a concrete blocker" }
      break
    default:
      return { ok: false, reason: `unknown status ${JSON.stringify(r.status)}` }
  }

  const report = {
    status: r.status as RoundStatus,
    summary: r.summary,
    evidence: r.evidence,
    next_steps: r.next_steps,
    blocker: r.blocker,
  }
  // Bounded because it is fed to the NEXT round verbatim. An unbounded handoff turns a
  // fresh worker's clean context into the same accumulation the loop exists to avoid.
  const size = JSON.stringify(report).length
  if (size > maxHandoffChars)
    return { ok: false, reason: `the report is ${size} chars, over the ${maxHandoffChars} handoff limit - summarise it` }
  return { ok: true, report }
}

/** Trim a handoff that is valid but large, so it can still cross to the next round. */
export const handoffFor = (report: RoundReport, max = MAX_HANDOFF_CHARS): string => {
  const full = JSON.stringify(report, null, 1)
  return full.length <= max ? full : `${full.slice(0, max - 20)}\n… (truncated)`
}

/**
 * The prompt for one round.
 *
 * Pure, and exported, so what a worker is told is a testable artifact rather than a
 * string buried in a loop. Three things it must always do:
 *
 *   - state the objective UNCHANGED every round (it is the one thing that cannot drift)
 *   - name the round number and the budget, so a worker can judge how much to attempt
 *   - point at the working tree as the source of truth, and say the handoff is a claim
 *     to be confirmed rather than a fact to be trusted
 */
export function roundPrompt(input: {
  objective: string
  round: number
  maxRounds: number
  previous?: RoundReport
  /** repo instructions, house rules, anything the caller wants every round to carry */
  instructions?: string
  /** appended verbatim - the caller's own rules for what a round may do */
  extra?: string
}): string {
  const prior = input.previous
    ? handoffFor(input.previous)
    : "(none — this is the first round)"
  return [
    ...(input.instructions ? [input.instructions, ""] : []),
    "You are one worker in a fresh-agent loop. You have no memory of earlier rounds and no",
    "parent conversation: everything you know is in this message and in the working tree.",
    "",
    `OBJECTIVE (unchanged every round):\n${input.objective}`,
    "",
    `Round ${input.round} of ${input.maxRounds}.`,
    "",
    "The working tree is the long-term memory and the source of truth. Read it before you",
    "act. The previous round's report below is a CLAIM about that tree, not a fact — confirm",
    "anything you rely on. Preserve work that is already there; you are continuing it, not",
    "restarting it.",
    "",
    `PREVIOUS ROUND'S HANDOFF:\n${prior}`,
    ...(input.extra ? ["", input.extra] : []),
    "",
    "Do concrete work, then report:",
    "  - `continue` while useful work remains — say what comes next, and leave blocker empty.",
    "  - `complete` ONLY with evidence someone else could check (a path you changed, a command",
    "    you ran and what it printed) and no next steps outstanding. Do not claim completion",
    "    you cannot point at.",
    "  - `blocked` only when no progress is possible without a human or an external change,",
    "    and name the blocker concretely.",
  ].join("\n")
}

/**
 * Run the loop.
 *
 * `runRound` is injected rather than imported: the loop's rules are arithmetic over
 * reports, and keeping the model call outside makes every rule above testable without a
 * network. It returns the raw structured value, or null when the round produced nothing.
 *
 * `onRound` reports progress. A loop that prints nothing for five rounds is
 * indistinguishable from one that has hung, which is the observability failure this
 * codebase already knows it has.
 */
export async function runLoop(input: {
  objective: string
  maxRounds: number
  runRound: (prompt: string, round: number) => Promise<unknown | null>
  instructions?: string
  extra?: string
  maxHandoffChars?: number
  onRound?: (round: number, report: RoundReport | null, reason?: string) => void
  /** epoch ms after which no further round STARTS. A round in flight is never cut off. */
  deadline?: number
}): Promise<LoopResult> {
  const say = input.onRound ?? (() => {})
  const history: RoundReport[] = []
  let previous: RoundReport | undefined
  let rejected: string | undefined

  for (let round = 1; round <= input.maxRounds; round++) {
    // Checked before starting, never mid-round: killing a worker that is part-way through
    // an edit leaves the tree in a state the next round has to diagnose, which costs more
    // than the round would have.
    if (input.deadline && Date.now() > input.deadline)
      return {
        status: "out-of-rounds",
        rounds: round - 1,
        ...(previous ? { report: previous } : {}),
        detail: "the loop's time budget ran out between rounds",
        history,
      }

    const prompt = roundPrompt({
      objective: input.objective,
      round,
      maxRounds: input.maxRounds,
      previous,
      instructions: input.instructions,
      // A rejected report is told to the NEXT worker. Otherwise the loop silently repeats
      // a mistake nobody was informed of - the worker never learns its answer was thrown
      // away, so it answers the same way again.
      extra: [input.extra, rejected ? `The previous round's report was REJECTED: ${rejected}\nDo not repeat that mistake.` : ""]
        .filter(Boolean)
        .join("\n\n"),
    })

    const raw = await input.runRound(prompt, round)
    if (raw === null || raw === undefined) {
      say(round, null, "no answer")
      return {
        status: "round-failed",
        rounds: round,
        ...(previous ? { report: previous } : {}),
        detail: "a round produced no usable answer",
        history,
      }
    }

    const v = validateReport(raw, input.maxHandoffChars)
    if (!v.ok) {
      say(round, null, v.reason)
      rejected = v.reason
      // A rejected report does not end the loop and does not become the handoff: passing
      // an invalid report forward would let a malformed round poison every later one.
      // It costs a round, which is the honest price of an unusable answer.
      continue
    }

    rejected = undefined
    history.push(v.report)
    say(round, v.report)
    if (v.report.status === "complete") return { status: "complete", rounds: round, report: v.report, history }
    if (v.report.status === "blocked") return { status: "blocked", rounds: round, report: v.report, history }
    previous = v.report
  }

  return {
    status: "out-of-rounds",
    rounds: input.maxRounds,
    ...(previous ? { report: previous } : {}),
    history,
  }
}

/**
 * The loop's result, for a human.
 *
 * Says "reported", never "verified". Nothing in this file checks the work — the caller's
 * verify command and acceptance judge do that, and a report that reads like a guarantee
 * would quietly relocate the guarantee to the one place that cannot provide it.
 */
export function renderLoop(r: LoopResult): string {
  const head: Record<LoopStatus, string> = {
    complete: `**Worker reported complete** after ${r.rounds} round(s).`,
    blocked: `**Blocked** after ${r.rounds} round(s) — a human is needed.`,
    "out-of-rounds": `**Out of rounds** — ${r.rounds} round(s) used, work still outstanding.`,
    "round-failed": `**A round failed** after ${r.rounds} round(s).`,
  }
  const out = [head[r.status]]
  if (r.status === "complete")
    out.push("", "That is the worker's own account. It is not independent verification.")
  if (r.detail) out.push("", r.detail)
  if (r.report) {
    out.push("", `Last summary: ${r.report.summary}`)
    if (r.report.evidence.length) out.push("", "Evidence cited:", ...r.report.evidence.map((e) => `  - ${e}`))
    if (r.report.next_steps.length) out.push("", "Still outstanding:", ...r.report.next_steps.map((s) => `  - ${s}`))
    if (r.report.blocker) out.push("", `Blocker: ${r.report.blocker}`)
  }
  if (r.history.length > 1) {
    out.push("", "## Rounds")
    r.history.forEach((h, i) => out.push(`${i + 1}. [${h.status}] ${h.summary}`))
  }
  return out.join("\n")
}
