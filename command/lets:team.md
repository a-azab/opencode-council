---
description: Parallel implementation across worktrees. That orchestrator is /crew — use /crew:plan then /crew:execute, or /lets:plan for one task with an approval gate.
---

LETS's `team` spawns teammates into isolated worktrees to implement independent tasks in
parallel. In this plugin that orchestrator is **`/crew`**, and it exists.

`crew` was the old name for the single-task pipeline, which is now `lets` — the rename
happened precisely so the name would be free for the multi-run orchestrator. It has since
been built on it.

## Which namespace you want

The three namespaces differ by **where the human sits**, not by what they can do:

| | requirements | planning | execution |
|---|---|---|---|
| `/lets` | you state them | **you approve the plan** | unattended |
| `/crew` | **it interviews you** | it decides | unattended |
| `/council` | — | — | analysis only, writes no code |

So:

- **You know what you want and want to sign off the plan** → `/lets:plan`, then
  `/lets:execute`. One task, one worktree, one PR, and a gate before any of it runs.
- **You have a goal rather than a task list, and you do not want to approve each step** →
  `/crew:plan`, then `/crew:execute`. It interviews you, researches, designs, decomposes,
  and runs the independent tasks concurrently.

## What parallel actually buys you here

`/crew:execute` runs tasks concurrently **only where the dependency graph proves their file
sets disjoint**. Two tasks whose files touch — or whose files the graph has never seen — run
in separate waves, one after the other. That is deliberate: a file absent from the graph is
the absence of evidence, not evidence of independence.

The practical consequence: **on a stale graph, crew degrades toward sequential.** It will
say so in its report rather than quietly taking longer. `/crew:status` shows you the wave
schedule before you pay for a run, so check there first if speed is the point.

There is also no per-task pull request. Task branches are merged into one integration
branch, which is verified and reviewed as a whole and left local for you to push.

## What still needs you

`/crew` removes the approval gate; it does not remove your judgement. Nobody signs off the
plan, so the report at the end is the only account of what happened — read the
`What it could not do` and `What needs you` sections rather than the first line alone.

If the tasks are genuinely independent and you would rather drive them yourself, separate
sessions in separate worktrees still work: `/lets:worktree` lists what is live and gives you
the command to remove each.

## What does exist for parallel analysis

Fan-out in `/council` is **analysis**, not implementation. `/lets:review`, `/lets:opinion`
and `/lets:ask` all run many models at once and are the right tool when the question is
*what should be done*. None of them writes code to a branch.

---

## Response Footer

- **A goal, unattended** → `/crew:plan`, then `/crew:execute`.
- **One task, with a gate** → `/lets:plan`, then `/lets:execute`.
- **See the waves before paying for a run** → `/crew:status`.
- **Several tasks, and you want them ordered** → `/lets:backlog`.
- **Something stranded from an earlier attempt** → `/lets:worktree`.

## Rules

- Do not simulate a team. Sequential runs reported as parallel is a lie about what happened.
- Do not spawn implementation subagents from here; the run loop belongs to `/crew:execute`
  and `/lets:execute`.
- Respond in the user's language.
