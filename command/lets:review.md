---
description: Full review. Delegates to /council:review — role x model fan-out, skeptic verification, deterministic aggregation.
---

LETS's `review` dispatches expert agents and has one model write up what they said.
**`/council:review` answers the same question with different machinery**, so this command
delegates rather than porting it.

Call the `council` tool with `mode: "review"`. If `$ARGUMENTS` names a git ref — a branch,
tag, or sha — pass it as `base`; otherwise omit `base` and it reviews all uncommitted work
against `HEAD`.

Present the summary **exactly as returned**. Do not re-tier, re-word, add or drop findings.
The aggregation already happened deterministically, and re-deciding it in prose puts back
the single-model judgement the design removes.

## What this one adds over the LETS version

| | LETS `review` | `/council:review` |
|---|---|---|
| who checks a finding | the agent that raised it, and the summariser | **skeptics that did not raise it** — `skepticPool` excludes the raiser by slug, because self-verification is not verification |
| ties and disagreements | asserted in prose by the writer-up | **computed** — `tally()` against a fixed `TIE_MARGIN`, and `disputes()` reads the spread rather than being told about it |
| an agent that fails | its lane quietly does not appear | **substituted, then reported** — a failed model is benched, the most-diverse available model takes the lane, and the report names both the stand-in and the count of nodes that failed |

Zero skeptic votes **keeps** a finding. "Verification did not run" and "the finding was
refuted" are different facts, and collapsing them is how a real bug disappears quietly.

## When the report is incomplete, say so

If it names failed nodes, repeat that plainly: coverage was partial and the verdict is
provisional. If it reports an essential reviewer missing from a lane, that is not noise —
a stand-in makes the lane read `ok` while the reviewer that was required to be there never
ran.

Then point at the full report path, and offer — without doing it — `council({mode:"fix"})`
to turn findings into patches.

---

## Response Footer

- **Blockers** → `council({mode:"fix"})`, or fix by hand and re-run.
- **Clean** → `/lets:commit`, then `/lets:done`.
- **Only wanted a fast pass** → `/lets:check` next time; it is inline and ~30s.

## Rules

- Present the aggregate as given. Never re-rank it.
- Never hide a failed node or a missing essential reviewer.
- Respond in the user's language.
