---
description: Read-only — the last crew plan, the waves it would run, and any live worktrees. Changes nothing.
---

`/crew:status` answers "what would run, and what is still lying around". It is **read-only**:
it starts nothing, writes no artifact, and removes no worktree.

```
Call the `crew` tool with mode: "status"
```

## What comes back

- **The last recorded plan** — its directive, its task count, and the ADR path. No plan
  recorded means `/crew:plan` has not run here.
- **The wave schedule** those tasks would produce against today's dependency graph, with the
  mode:
  - `graph` — every task's files are known, so concurrency is proven.
  - `partial` — some files are absent from the graph. Their tasks cannot be proven
    independent, so they run alone. The absent files are listed. **Rebuild the graph and
    the run parallelises.**
  - `sequential` — no readable graph at all; everything runs alone.
- **Live worktrees**, each with the exact command to remove it.

The schedule is computed fresh each time you ask, against the graph as it is now — so this
is also how you check whether rebuilding the graph actually bought you anything, before
paying for a run to find out.

## Worktrees

A crew run leaves one worktree per task while it works and cleans up after itself. Anything
still listed after a run finished is a leftover from a run that crashed or was interrupted.
The removal command is printed next to each; run it yourself. This command will not remove
anything for you — deleting a worktree that still holds unmerged work is not a decision to
make automatically.

## Response Footer

- **Nothing planned yet** → `/crew:plan <directive>`
- **A plan you are happy with** → `/crew:execute`
- **Worktrees from the single-task pipeline too** → `/lets:worktree`

## Rules

- Read-only. Never start, resume, or clean up anything from this command.
- Report the scheduling mode plainly. `partial` and `sequential` are the two states that
  cost the user real time, and they are actionable.
- Respond in the user's language.
