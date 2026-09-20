---
description: Take a directive through intake to an approved plan — CPO outcomes, CTO work items grounded in the codebase graph. Stops at the gate; writes no code.
---

Call the `lets` tool with `mode: "plan"` and `directive` set to what the user asked for,
verbatim. Do not paraphrase the directive or resolve its ambiguities yourself — the CPO
lane is built to surface them, and pre-resolving robs the user of the chance to correct.

## Then the architect writes the ADR

After the plan comes back and **before you show the gate**, write
`docs/adr/YYYY-MM-DD-<slug>.md` — the architect's job, because the
architect owns the design decision and therefore its record. **Date-slug, never a sequential
number**: `0007-` allocates a number, and two tasks writing decisions at the same time
allocate the same one. Read an existing file in `docs/adr/` and match its shape.

Scaled to what `/lets` is: the directive as understood, the design decision, the
alternatives rejected, and any sources you consulted. `/crew` has no gate and so refuses
without an ADR; here a human is about to approve the plan, so this is not a refusal — but
the plan they approve should arrive with its reasoning, not just its task list. A plan whose
ADR is hard to write is usually a plan that has not been decided yet.

Skip it for a change too small to have a design decision. Say that you skipped it.

## The gate

Show the returned gate to the user as-is.

Then stop. **Nothing has been written and nothing will be until the user approves.** If the
plan is wrong, they say so and you re-run `plan` with a corrected directive.

Things worth pointing out if the gate shows them:

- **A lane that did not answer** — the plan is missing that lane's judgement. Say the plan
  is incomplete, not that it is simple.
- **An item with no predicted files** — usually means the item is too vague to implement,
  or the knowledge graph is missing. Worth fixing before approving.
- **A stale or missing graph** — offer `graphify extract . --code-only --max-workers 16`.
  It is local tree-sitter AST, no LLM calls, and takes seconds. Planning against a stale
  graph is worse than planning against none: it is confidently wrong.
- **Which gates the plan will face** — the footer says whether the harness scorecard runs
  and what floor applies. The user is approving a plan; the checks it must pass are part
  of what they are approving, and finding out at the first failure is too late.

## Acceptance criteria are evals

Each item's `acceptance` is read later by a model that did not write the diff, and judged
against exactly that text. That makes it an eval, and the eval-driven framing is the useful
one when reviewing a plan before approving it:

- **Capability** — what this item makes possible that was not possible before. That is what
  `acceptance` states, and it must be checkable by someone who did not write the item.
  "Handles errors" is not checkable; "a duplicate submit returns the first result rather
  than creating a second record" is.
- **Regression** — what must still work afterwards. `verify` covers this for anything the
  suite already tests; the harness scorecard covers the repo's own checks and guardrails.
  If an item puts something at risk that **neither** covers, say so at the gate — that is a
  gap in the evidence, and it is cheaper to name now than to discover in review.

The run's retry budget is the reliability bound: 2 attempts then 3 escalations per item,
and an item that lands on attempt 3 is a weaker result than one that landed first time even
though both report `done`. The run output gives the attempt count per item; do not average
it away when you summarise.

If the repo has no lets config, the tool says so — run `/lets:init` first.
