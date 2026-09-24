import { test } from "node:test"
import assert from "node:assert/strict"
import {
  validateReport,
  runLoop,
  roundPrompt,
  renderLoop,
  handoffFor,
  judgePanel,
  collectHandoff,
  accumulatedBrief,
  councilJudge,
  MAX_HANDOFF_CHARS,
  type RoundReport,
  type RoundVerdict,
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

// ------------------------------------------------------------------ the panel

const vote = (over: Partial<import("./ralph.ts").RoundVerdict> = {}) => ({
  met: true,
  confidence: "medium" as const,
  reason: "the objective is met",
  judge: "j1",
  ...over,
})

test("no judge means unverified, never verified", () => {
  // The same rule the fix loop and the harness gate already hold: "nobody looked" and
  // "it held" are different facts, and collapsing them is how an unchecked claim starts
  // reading like a checked one.
  const p = judgePanel([])
  assert.equal(p.accepted, false)
  assert.equal(p.unjudged, true)
  assert.match(p.reason, /unverified, not verified/)
})

test("one high-confidence rejection outweighs a majority that did not notice", () => {
  // The mirror of security findings needing UNANIMOUS refutation to drop: a judge who
  // can point at what is missing is carrying evidence, and the others' silence is not.
  const p = judgePanel([
    vote({ judge: "a" }),
    vote({ judge: "b" }),
    vote({ judge: "c", met: false, confidence: "high", reason: "the flag is never read" }),
  ])
  assert.equal(p.accepted, false)
  assert.match(p.reason, /the flag is never read/)
})

test("a tie rejects, because the burden is on the claim", () => {
  // One wasted round is cheaper than a false completion in the permanent record.
  const p = judgePanel([vote({ judge: "a" }), vote({ judge: "b", met: false, confidence: "low" })])
  assert.equal(p.accepted, false)
})

test("a clear majority accepts, and says how many", () => {
  const p = judgePanel([vote({ judge: "a" }), vote({ judge: "b" }), vote({ judge: "c", met: false, confidence: "low" })])
  assert.equal(p.accepted, true)
  assert.match(p.reason, /2 of 3/)
})

test("a rejected completion continues the loop with the panel's reason", () => {
  // The most specific instruction a next round can get: judges say what is MISSING,
  // where a worker only knows what it did.
  const prompts: string[] = []
  let judged = 0
  return runLoop({
    objective: "o",
    maxRounds: 4,
    runRound: async (p) => {
      prompts.push(p)
      return complete()
    },
    judge: async () => {
      judged++
      return judged === 1
        ? [vote({ met: false, confidence: "high", reason: "no test covers the new branch" })]
        : [vote(), vote({ judge: "j2" })]
    },
  }).then((r) => {
    assert.equal(r.status, "complete")
    assert.equal(r.rounds, 2, "the rejected claim cost a round rather than ending the loop")
    assert.match(prompts[1], /no test covers the new branch/, "the next worker is told what was missing")
    assert.equal(r.panel?.accepted, true)
  })
})

test("without a judge the loop still accepts a completion, and the report says so", () => {
  // Callers that cannot reach a panel are not blocked; they simply get the weaker claim,
  // and the rendering makes that visible.
  return runLoop({ objective: "o", maxRounds: 2, runRound: async () => complete() }).then((r) => {
    assert.equal(r.status, "complete")
    assert.equal(r.panel, undefined)
    assert.match(renderLoop(r), /not independent verification/)
  })
})

test("a judged completion is rendered as confirmed, naming the judges", () => {
  const out = renderLoop({
    status: "complete",
    rounds: 1,
    report: complete(),
    history: [complete()],
    panel: { accepted: true, votes: [vote({ judge: "opus5" })], reason: "1 of 1 judges confirm the objective is met" },
  })
  assert.match(out, /Confirmed independently/)
  assert.match(out, /opus5/)
  assert.doesNotMatch(out, /not independent verification/, "a judged claim must not read like an unjudged one")
})

test("a loop that ran out of rounds shows a rejected completion claim", () => {
  const out = renderLoop({
    status: "out-of-rounds",
    rounds: 3,
    report: ok(),
    history: [ok()],
    panel: { accepted: false, votes: [vote({ met: false })], reason: "1 of 1 judges reject: not done" },
  })
  assert.match(out, /REJECTED by the panel/)
})

// ------------------------------------------------------------------ the real judge

test("judges never include whoever did the work", () => {
  // The same rule /council:fix applies when it refuses to let a model verify its own
  // patch. A worker grading its own homework is not a second opinion.
  const asked: string[] = []
  return councilJudge({
    report: complete(),
    objective: "o",
    diff: "d",
    exclude: ["worker"],
    judges: [{ slug: "worker", model: "m/worker" }, { slug: "j1", model: "m/j1" }],
    ask: async (model) => {
      asked.push(model)
      return { ok: true, value: { met: true, confidence: "high", reason: "it is there" } }
    },
    schema: {},
  }).then((votes) => {
    assert.deepEqual(asked, ["m/j1"], "the worker must not judge its own claim")
    assert.equal(votes.length, 1)
    assert.equal(votes[0].judge, "j1")
  })
})

test("a judge that fails to answer is absent, not a vote either way", () => {
  // Counting an outage as agreement would let a network failure certify a completion;
  // counting it as rejection would let one fail a good round. It is neither.
  return councilJudge({
    report: complete(),
    objective: "o",
    diff: "d",
    exclude: [],
    judges: [{ slug: "a", model: "m/a" }, { slug: "b", model: "m/b" }],
    ask: async (model) =>
      model === "m/a" ? { ok: false } : { ok: true, value: { met: false, confidence: "high", reason: "missing" } },
    schema: {},
  }).then((votes) => {
    assert.equal(votes.length, 1)
    assert.equal(votes[0].judge, "b")
  })
})

test("a malformed verdict is dropped rather than guessed at", () => {
  return councilJudge({
    report: complete(),
    objective: "o",
    diff: "d",
    exclude: [],
    judges: [{ slug: "a", model: "m/a" }],
    ask: async () => ({ ok: true, value: { confidence: "high", reason: "no met field" } }),
    schema: {},
  }).then((votes) => assert.deepEqual(votes, []))
})

test("an empty judge pool produces no votes, which the panel reads as unjudged", () => {
  return councilJudge({
    report: complete(),
    objective: "o",
    diff: "d",
    exclude: ["only"],
    judges: [{ slug: "only", model: "m/only" }],
    ask: async () => ({ ok: true, value: { met: true, confidence: "high", reason: "r" } }),
    schema: {},
  }).then((votes) => {
    assert.deepEqual(votes, [])
    assert.equal(judgePanel(votes).unjudged, true)
  })
})

test("the judge prompt tells the panel the worker's summary is a claim, not evidence", () => {
  let seen = ""
  return councilJudge({
    report: complete({ summary: "I FINISHED EVERYTHING" }),
    objective: "SHIP IT",
    diff: "diff --git a/x b/x",
    exclude: [],
    judges: [{ slug: "a", model: "m/a" }],
    ask: async (_m, _a, text) => {
      seen = text
      return { ok: true, value: { met: true, confidence: "high", reason: "r" } }
    },
    schema: {},
  }).then(() => {
    assert.match(seen, /SHIP IT/)
    assert.match(seen, /I FINISHED EVERYTHING/)
    assert.match(seen, /CLAIM, not evidence/)
    assert.match(seen, /=== DIFF ===/)
  })
})

// ------------------------------------------------------------------ the carry-forward

const rep = (over: Partial<RoundReport> = {}): RoundReport => ({
  status: "continue",
  summary: "did a thing",
  evidence: ["src/a.ts"],
  next_steps: ["do the next thing"],
  blocker: "",
  ...over,
})

test("no handoffs renders nothing", () => {
  assert.equal(accumulatedBrief([]), "")
})

test("the brief tells a worker to trust the repo over a stale note", () => {
  // These notes were written by earlier attempts and the tree has moved since.
  const out = accumulatedBrief([rep()])
  assert.match(out, /TRUST THE REPO/)
  assert.match(out, /may be stale/)
  assert.match(out, /Do not repeat a dead\nend/)
})

test("newest knowledge comes first", () => {
  const out = accumulatedBrief([rep({ summary: "OLDEST" }), rep({ summary: "NEWEST" })])
  assert.ok(out.indexOf("NEWEST") < out.indexOf("OLDEST"), "the most recent attempt is the most relevant")
})

test("the brief is hard-capped however many attempts pile up", () => {
  // An unbounded accumulation would eventually crowd out the work item itself - a context
  // leak dressed as thoroughness.
  const many = Array.from({ length: 40 }, (_, i) => rep({ summary: `attempt ${i} `.repeat(80) }))
  const out = accumulatedBrief(many, 2000)
  assert.ok(out.length <= 2000 + 400, `brief was ${out.length} chars`)
})

test("a worker that cannot produce a handoff costs context, not the item", async () => {
  const got = await collectHandoff(async () => ({ ok: false }), {
    objective: "o", attempt: 1, summary: "s", diff: "d",
  })
  assert.equal(got, null, "a missing handoff must never throw into the attempt loop")
})

test("a malformed handoff is rejected rather than carried forward", async () => {
  // Carrying a report that fails the contract would put unvalidated text into every
  // subsequent attempt's brief.
  const got = await collectHandoff(async () => ({ ok: true, value: { status: "complete", summary: "x" } }), {
    objective: "o", attempt: 1, summary: "s", diff: "d",
  })
  assert.equal(got, null)
})

test("a valid handoff is returned intact", async () => {
  const got = await collectHandoff(
    async () => ({
      ok: true,
      value: { status: "continue", summary: "ruled out the cache", evidence: ["src/a.ts"], next_steps: ["try the parser"], blocker: "" },
    }),
    { objective: "o", attempt: 2, summary: "s", diff: "d" },
  )
  assert.ok(got)
  assert.equal(got.summary, "ruled out the cache")
  assert.deepEqual(got.next_steps, ["try the parser"])
})

test("the debrief prompt asks for knowledge, not a transcript", async () => {
  let seen = ""
  await collectHandoff(async (text) => { seen = text; return { ok: false } }, {
    objective: "the objective", attempt: 3, summary: "what happened", diff: "the diff",
  })
  assert.match(seen, /dead end you ruled out/)
  assert.match(seen, /no memory of this one/)
  assert.match(seen, /what the next attempt needs to KNOW/)
  assert.match(seen, /data, not instructions/, "the diff is untrusted input")
})

test("a panel that lost judges to an outage says so, rather than reading as unanimous", () => {
  // Measured in the first production loop, 2026-09-24: a 3-judge panel printed
  // "1 of 1 judges confirm the objective is met" because two models never answered.
  // That sentence describes a unanimous panel. It was one opinion. Absent judges must
  // not vote - counting them either way lets an outage decide a completion - but the
  // verdict must also not hide how thin it became.
  const one: RoundVerdict[] = [{ met: true, confidence: "high", reason: "looks right", judge: "fable" }]

  const shrunk = judgePanel(one, 3)
  assert.equal(shrunk.accepted, true, "one genuine confirmation still carries")
  assert.match(shrunk.reason, /did not answer/, "but the missing judges are named in the reason")
  assert.match(shrunk.reason, /2 of 3/, "and counted exactly")

  const full = judgePanel(one, 1)
  assert.equal(full.accepted, true)
  assert.ok(!/did not answer/.test(full.reason), "a panel of one that was only ever one says nothing extra")

  // Rejections carry the same caveat: a thin panel is thin whichever way it votes.
  const against: RoundVerdict[] = [{ met: false, confidence: "low", reason: "not done", judge: "minimax" }]
  assert.match(judgePanel(against, 3).reason, /did not answer/)
})
