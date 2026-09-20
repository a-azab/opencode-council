import { test } from "node:test"
import assert from "node:assert/strict"
import {
  validateReport,
  runLoop,
  roundPrompt,
  renderLoop,
  handoffFor,
  MAX_HANDOFF_CHARS,
  type RoundReport,
} from "./ralph.ts"

const ok = (over: Partial<RoundReport> = {}): RoundReport => ({
  status: "continue",
  summary: "did a thing",
  evidence: [],
  next_steps: ["do the next thing"],
  blocker: "",
  ...over,
})

const complete = (over: Partial<RoundReport> = {}): RoundReport =>
  ok({ status: "complete", evidence: ["src/a.ts changed", "npm test passed"], next_steps: [], ...over })

// ------------------------------------------------------------------ the contract

test("a complete report must cite evidence, not assert success", () => {
  // THE rule. Without it, "complete" is a model's opinion of its own work — exactly what
  // this plugin refuses to accept anywhere else. A schema can require an array of
  // strings; only a cross-field rule can require that it not be empty here.
  const v = validateReport(complete({ evidence: [] }))
  assert.equal(v.ok, false)
  assert.match((v as { ok: false; reason: string }).reason, /evidence/)
})

test("a complete report cannot leave next steps outstanding", () => {
  // "Done, and here is what is left to do" is not done. Allowing it would make the
  // terminal status unreliable, and the loop stops on it.
  const v = validateReport(complete({ next_steps: ["still to do"] }))
  assert.equal(v.ok, false)
})

test("a continuing report must say what comes next", () => {
  // A worker that continues without a next step has stopped thinking but not stopped
  // running — the most expensive failure the loop can have.
  assert.equal(validateReport(ok({ next_steps: [] })).ok, false)
})

test("a continuing report cannot also carry a blocker", () => {
  assert.equal(validateReport(ok({ blocker: "something is wrong" })).ok, false)
})

test("a blocked report must name a concrete blocker", () => {
  assert.equal(validateReport(ok({ status: "blocked", blocker: "" })).ok, false)
  assert.equal(validateReport(ok({ status: "blocked", blocker: "needs prod credentials" })).ok, true)
})

test("valid reports of every status pass", () => {
  assert.equal(validateReport(ok()).ok, true)
  assert.equal(validateReport(complete()).ok, true)
  assert.equal(validateReport(ok({ status: "blocked", blocker: "no API key", next_steps: [] })).ok, true)
})

test("a malformed report is an outcome, never a throw", () => {
  // The loop turns a bad report into feedback for the next round. Throwing would make a
  // worker's bad answer indistinguishable from a bug in the loop itself.
  for (const bad of [null, undefined, "a string", [], 42, {}, { status: "done" }])
    assert.doesNotThrow(() => validateReport(bad))
  assert.equal(validateReport(null).ok, false)
  assert.equal(validateReport({ ...ok(), status: "finished" }).ok, false)
})

test("untrimmed or empty strings are rejected", () => {
  assert.equal(validateReport(ok({ summary: "  " })).ok, false)
  assert.equal(validateReport(ok({ next_steps: ["ok", ""] })).ok, false)
  assert.equal(validateReport(ok({ next_steps: ["  padded  "] })).ok, false)
})

test("an oversized report is refused rather than truncated into the next round", () => {
  // The handoff is fed to the next worker verbatim. Silently truncating would corrupt
  // the one thing that crosses rounds; refusing tells the worker to summarise.
  const huge = ok({ summary: "x".repeat(MAX_HANDOFF_CHARS + 100) })
  const v = validateReport(huge)
  assert.equal(v.ok, false)
  assert.match((v as { ok: false; reason: string }).reason, /handoff limit/)
})

// ------------------------------------------------------------------ the loop

test("the loop stops the moment a worker reports complete", () => {
  return runLoop({
    objective: "o",
    maxRounds: 10,
    runRound: async (_p, round) => (round === 2 ? complete() : ok()),
  }).then((r) => {
    assert.equal(r.status, "complete")
    assert.equal(r.rounds, 2, "it must not keep spending rounds after completion")
    assert.equal(r.history.length, 2)
  })
})

test("the loop stops on blocked rather than burning its budget", () => {
  return runLoop({
    objective: "o",
    maxRounds: 10,
    runRound: async () => ok({ status: "blocked", blocker: "needs a human", next_steps: [] }),
  }).then((r) => {
    assert.equal(r.status, "blocked")
    assert.equal(r.rounds, 1)
  })
})

test("running out of rounds is distinct from failing", () => {
  // Opposite instructions to the human: one says "give it more time", the other says
  // "this is not working". Collapsing them would hide which.
  return runLoop({ objective: "o", maxRounds: 3, runRound: async () => ok() }).then((r) => {
    assert.equal(r.status, "out-of-rounds")
    assert.equal(r.rounds, 3)
    assert.ok(r.report, "the last good report survives, so the work is not lost")
  })
})

test("a round that answers nothing ends the loop as round-failed", () => {
  return runLoop({ objective: "o", maxRounds: 5, runRound: async () => null }).then((r) => {
    assert.equal(r.status, "round-failed")
    assert.equal(r.rounds, 1)
  })
})

test("a rejected report costs a round and is told to the next worker", () => {
  // Otherwise the loop silently repeats a mistake nobody was informed of: the worker
  // never learns its answer was thrown away, so it answers the same way again.
  const prompts: string[] = []
  return runLoop({
    objective: "o",
    maxRounds: 4,
    runRound: async (p, round) => {
      prompts.push(p)
      return round === 1 ? complete({ evidence: [] }) : complete()
    },
  }).then((r) => {
    assert.equal(r.status, "complete")
    assert.equal(r.rounds, 2, "the invalid round was spent, not silently retried")
    assert.match(prompts[1], /REJECTED/, "the next worker must be told why")
    assert.equal(r.history.length, 1, "an invalid report never enters the history")
  })
})

test("an invalid report never becomes the handoff", () => {
  // Passing an invalid report forward would let one malformed round poison every later
  // one.
  const prompts: string[] = []
  return runLoop({
    objective: "o",
    maxRounds: 3,
    runRound: async (p, round) => {
      prompts.push(p)
      if (round === 1) return ok({ summary: "POISON", next_steps: [] }) // invalid: continue with no next step
      return complete()
    },
  }).then(() => {
    assert.doesNotMatch(prompts[1], /POISON/, "the rejected content must not cross to the next round")
  })
})

test("each round gets the previous round's report, and the objective unchanged", () => {
  const prompts: string[] = []
  return runLoop({
    objective: "SHIP THE THING",
    maxRounds: 3,
    runRound: async (p, round) => {
      prompts.push(p)
      return round < 3 ? ok({ summary: `round ${round} did work` }) : complete()
    },
  }).then(() => {
    // The objective is the one thing that must not drift.
    for (const p of prompts) assert.match(p, /SHIP THE THING/)
    assert.doesNotMatch(prompts[0], /round 1 did work/, "round 1 has no predecessor")
    assert.match(prompts[1], /round 1 did work/)
    assert.match(prompts[2], /round 2 did work/)
  })
})

test("the deadline stops the loop between rounds, never mid-round", () => {
  // Killing a worker part-way through an edit leaves a tree the next round has to
  // diagnose, which costs more than the round would have.
  let started = 0
  return runLoop({
    objective: "o",
    maxRounds: 50,
    deadline: Date.now() - 1,
    runRound: async () => {
      started++
      return ok()
    },
  }).then((r) => {
    assert.equal(started, 0, "no round may start after the deadline")
    assert.equal(r.status, "out-of-rounds")
  })
})

// ------------------------------------------------------------------ prompt and report

test("the prompt names the working tree as the source of truth and the handoff as a claim", () => {
  const p = roundPrompt({ objective: "o", round: 2, maxRounds: 5, previous: ok() })
  assert.match(p, /working tree/i)
  assert.match(p, /CLAIM/)
  assert.match(p, /Round 2 of 5/)
})

test("the prompt tells a first-round worker it has no predecessor", () => {
  assert.match(roundPrompt({ objective: "o", round: 1, maxRounds: 3 }), /first round/)
})

test("repo instructions ride on every round when supplied", () => {
  const p = roundPrompt({ objective: "o", round: 1, maxRounds: 1, instructions: "HOUSE RULE: no globals" })
  assert.match(p, /HOUSE RULE/)
})

test("a completion is rendered as a report, never as verification", () => {
  // The caller's verify command and acceptance judge do the checking. Wording that reads
  // like a guarantee would relocate the guarantee to the one place that cannot give it.
  const out = renderLoop({ status: "complete", rounds: 2, report: complete(), history: [complete()] })
  assert.match(out, /reported complete/i)
  assert.match(out, /not independent verification/i)
})

test("the rendered result carries evidence, outstanding work and blockers", () => {
  const out = renderLoop({
    status: "out-of-rounds",
    rounds: 3,
    report: ok({ next_steps: ["wire the handler"] }),
    history: [ok(), ok(), ok({ next_steps: ["wire the handler"] })],
  })
  assert.match(out, /Out of rounds/)
  assert.match(out, /wire the handler/)
  assert.match(out, /## Rounds/)
})

test("handoffFor truncates only when it must, and says so", () => {
  const small = handoffFor(ok())
  assert.doesNotMatch(small, /truncated/)
  assert.match(handoffFor(ok({ summary: "y".repeat(500) }), 200), /truncated/)
})
