---
description: The 30-second pre-commit sanity pass. Delegates to /council:check — six lenses, inline, no subagents.
---

LETS's `check` is the fast pass you fire before committing: six perspectives, inline, no
agents, cheap enough to run after every few edits. **`/council:check` is the same idea**, so
this command does not re-implement it.

Run `/council:check`. It takes the same kind of target this does — a path to restrict to,
`--staged`, or nothing for all uncommitted work — so pass `$ARGUMENTS` straight through.

## When to reach for it

- **Before `/lets:commit`.** This is the main one. It reads the working tree, reports at
  most five issues, and moves nothing, so it costs a commit nothing to run first.
- Mid-edit, when you want a second look without waiting on a full review.

For anything deeper — a branch, a release, anything where a missed finding is expensive —
`/lets:review`. The difference is not thoroughness of prompt but of machinery:
`/council:check` dispatches no subagents at all, so nothing it reports has been verified by
a second model.

## What it will not do

It never asks you a question, never moves HEAD, and caps its output. Zero findings is a
common and valid result — it does not manufacture issues to look thorough.

---

## Response Footer

- **Findings you want fixed** → fix them, then re-run `/lets:check`.
- **Clean, and ready to land** → `/lets:commit`.
- **Diff too large, or the stakes are high** → `/lets:review`.

## Rules

- Delegate. Do not re-implement the six lenses here; `/council:check` owns them.
- Respond in the user's language.
