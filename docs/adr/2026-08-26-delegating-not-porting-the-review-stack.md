# Delegating LETS's review stack rather than porting it

**Date:** 2026-08-26 · **Status:** accepted · **Scope:** `command/lets:check.md`,
`command/lets:review.md`, `command/lets:opinion.md`, `command/lets:ask.md`,
`command/lets:research.md`, `command/lets:team.md`, `README.md`

## Context

[LETS](https://github.com/restarter/lets-workflow) ships 22 commands. The
[workflow port](2026-08-26-lets-workflow-port.md) brought over eleven — the session spine
and the work loop, the things this repo had none of. What remained was mostly LETS's
**quality** surface: `review`, `check`, `opinion`, `ask`, `research`, `team`.

Those are not a gap in the same sense. This plugin already answers the question they answer,
through `/council:*`, and the two implementations are not at the same stage. LETS's
`review.md` is **1,450 lines** of agent orchestration; with `check.md`, `opinion.md`,
`review-round.md` and `review-handoff.md` beside it the stack is **2,540 lines** of prompt
asking a model to fan out, collect, and write up what came back.

The council does that in `src/engine.ts` and `src/decide.ts`, in code, with the merge step
deterministic.

## Decision

1. **Delegate the overlapping five.** `/lets:check` → `/council:check`, `/lets:review` →
   `/council:review`, `/lets:opinion` → `/council:plan`, `/lets:ask` → `/council:task` or
   `/council:independent`, `/lets:research` → `webfetch` and the browser MCP servers. Each
   command file carries the LETS **framing** — what the command is for, when to reach for
   it — and none of them carries a second copy of the machinery.
2. **`/lets:team` reports that its orchestrator does not exist**, and names the sequential
   path instead. It does not simulate one.
3. **Six commands are not ported at all**, and each command file or the README says why.
4. **No new fan-out is written.** Anything that needs several models routes to the engine
   that already has one.

## The measurements and discoveries this rests on

### Three properties the port would have lost

These are not refinements of what LETS does. They are the parts a prompt cannot hold, and
each already has code behind it:

| property | where | what the ported version would have done instead |
|---|---|---|
| **a finding is verified by models that did not raise it** | `roster.ts:206` `skepticPool` filters `!excludeSlugs.includes(m.slug)` | the raiser, and the model writing the summary, judge the raiser's own finding |
| **convergence is computed** | `decide.ts:241` `converged()`, `decide.ts:129` `disputes()` reading tier spread against a fixed `TIE_MARGIN` | a moderator emits `VERDICT: CONVERGED` — *an opinion wearing a control-flow costume*, which is what the old council here actually did |
| **a failed model is substituted, then reported** | `engine.ts:401` `substitutesFor`, benching, catalog recruitment; `report.ts:63` names the stand-in and `report.ts:153` counts dropped nodes | the lane quietly does not appear, and coverage looks complete |

The third is the one that decides it. A review whose security lane silently did not run
reads exactly like a review whose security lane found nothing. That failure is invisible at
the point where it costs the most, and no amount of prompt engineering makes a subagent
report its own absence.

Zero skeptic votes **keeps** a finding, because "verification did not run" and "the finding
was refuted" are different facts. A prompt-level implementation has no place to put that
distinction.

### It would have been the third fan-out-and-merge in one plugin

`engine.ts` already holds two, and they are genuinely different shapes rather than
duplication:

- **`runReview`** — role × model fan-out, skeptic verification, deterministic aggregation.
- **`runTask`** — every schema-capable model answers, then cross-scores the others, and
  `tally()` ranks with dissent preserved.

`lets.ts` adds none: at `lets.ts:1632` it **calls `runReview`**, and at `1311`/`1370` it
draws judges from the shared `skepticPool`. That restraint is the precedent. A ported
`review.md` would have broken it — and `command/lets:backlog.md` had already settled the
principle in prose when it dropped LETS's Review mode: *a third implementation of
fan-out-and-merge is worse than a pointer to the one that exists.*

### `/lets:research` states a limitation instead of implying a capability

Verified on this machine 2026-08-25 and recorded in
[`docs/superpowers/specs/2026-08-25-council-design.md:52`](../superpowers/specs/2026-08-25-council-design.md):

- `webfetch` **works**, including from spawned sessions.
- playwright, chrome-devtools and puppeteer MCP servers are **reachable** from spawned
  sessions.
- **`websearch` is a valid permission key with no tool behind it.** A spawned session that
  reaches for it reports `NO-TOOL`.

The middle term is the trap: a valid permission key looks like a configured capability.
LETS's `research.md` opens by instructing the model that `WebSearch` "MUST" be called and
never skipped. Ported unchanged onto this machine, that instruction cannot be satisfied, and
the most likely outcome is not an error — it is a confident, uncited synthesis assembled from
model memory and presented as research. So the command asks for a URL or a starting page,
and says plainly that it cannot find one.

### `/lets:team` names an absence rather than approximating it

`/crew` is the multi-run orchestrator the rename in the
[port ADR](2026-08-26-lets-workflow-port.md) freed the name for. The name is free; the
orchestrator is not written. The command says so.

The available approximation — running the tasks in sequence through `/lets:plan` and
`/lets:execute` — is offered explicitly as the manual answer. What the command must not do
is run them sequentially and describe it as a team, because the value of `team` is
wall-clock parallelism and a sequential run reported as parallel is a lie about what
happened.

## What is deliberately not ported

| command | lines | why not |
|---|---|---|
| `review-round` | 112 | consumes a *received* review — triage, freeze the artifact, one edit pass. Council-internal in shape: `/council:review` already runs its own rounds (`councilArgs()` passes `maxRounds: 2`) and stops on computed convergence. Two ways to drive one loop. |
| `review-handoff` | 141 | produces a brief so an external agent can review. Same internals; the council's own report already is the artifact. |
| `plan-workflow` | 124 | a thin dispatcher for Claude Code's **Dynamic Workflows** tool — a research preview with no opencode equivalent. |
| `update` | 126 | syncs the LETS plugin and its Go binary against a LETS release. Plugin machinery for a plugin this is not. |
| `statusline` | 110 | renders and persists Claude Code's status line into `.claude/settings.local.json`. No opencode equivalent. |
| `github-pr` | 1,225 | the only one dropped for capacity rather than principle. It needs a repo **with a remote** to develop honestly against, and this repo has none — a port would be written blind and tested never. |

`plan-workflow`, `update` and `statusline` share a shape worth naming: all three are about
*the LETS plugin*, not about the work. They have no meaning here regardless of how good the
port would be.

## Alternatives rejected

**Porting `review.md` under a `lets:` prefix.** The full version. It produces a second
review command whose findings are unverified, whose convergence is a model's assertion, and
whose failed lanes are invisible — while sitting beside one that has none of those
properties. Users would reasonably assume the `lets:`-prefixed one is the one that belongs
to the workflow they are running.

**Porting it as a thin wrapper that reuses the council engine.** Closer, and still wrong: it
is what these delegating commands are, minus the honesty. If the engine is the council's,
the command should say so, because the day the two disagree the user needs to know which one
actually ran.

**Aliasing `/lets:review` directly to `/council:review` with no file of its own.** Loses the
framing, which is the entire remaining value of the LETS surface. A LETS user reaches for
`/lets:check` before a commit because that is the habit; a bare alias teaches them nothing
about what changed underneath.

**Writing `/lets:team` as a sequential loop over tasks.** Rejected above. The honest
version of "we cannot do this yet" is more useful than a slow imitation, because the
imitation gets trusted.

**Implementing `websearch` behind `/lets:research`** — by scraping a search engine through
the browser MCP servers. It would work until it did not, and its failures would be
rate-limits and layout changes surfacing as thin or empty research. A stated limitation is
stable; a fragile capability is not.

## Consequences

- **The `/lets:*` surface is seventeen commands**, of which six delegate and eleven do work
  of their own.
- **LETS users lose the exact prompts they know.** This is the real cost of the decision and
  it is not small: someone who has tuned their habits around `/lets:review --branch` will
  find different flags, different output, and different tiering. What they gain is
  verification they did not have — findings checked by models that did not raise them, and
  a report that names its own gaps.
- **Verification is per tier, not universal.** `SKEPTICS_PER_TIER` is `{ BLOCKER: 3,
  SUGGESTION: 2, NIT: 0 }` and `verifyGroup` returns early on zero, so **a NIT is one
  model's unchecked opinion**. `/lets:review` says so rather than letting the tier inherit
  the credibility of the ones above it.
- **A delegating command that names a missing target is now a test failure**, not a silent
  dead end. `index.test.ts` asserts each of the four named `council:*` targets is registered;
  mutation-verified by removing a command file, which fails that test and nothing else.
- **Six LETS commands will keep showing up in comparisons as missing.** They are recorded
  here and in the README as decisions so the next person does not re-derive them, and
  `github-pr` is the one to revisit first, once there is a remote to build it against.
