---
description: Parallel implementation across worktrees. The orchestrator this needs — /crew — does not exist in this plugin; use /lets:plan then /lets:execute, one task at a time.
---

LETS's `team` spawns teammates into isolated worktrees to implement independent tasks in
parallel. In this plugin that orchestrator is **`/crew`**, and it is worth being blunt about
its status:

> **`/crew` has not been implemented.** There is no command, no tool mode, and nothing
> behind this file that will run tasks in parallel. Nothing here does what LETS's `/lets:team
> run` does today.

`crew` was the old name for the single-task pipeline, which is now `lets` — the rename
happened precisely so the name would be free for the multi-run orchestrator. The name is
free. The orchestrator is still ahead of us.

## What to do instead, today

**One task at a time, through the attended loop:**

```
/lets:plan <the first task>     # plan it, stop at the gate
/lets:execute                   # build the plan you approved
/lets:commit                    # then /lets:done
```

Then the next task. `/lets:execute` already runs in a throwaway worktree, so the isolation
LETS's `team` provides per teammate is there — what is missing is running several of them
at once, and the human gate that would sequence them.

If the tasks really are independent and the wait is the problem, split them across
**separate sessions in separate worktrees** yourself: `/lets:worktree` lists what is live
and gives you the command to remove each when you are done. That is manual, and it is the
honest answer.

## What does exist for parallel work

Fan-out here is **analysis**, not implementation. `/lets:review`, `/lets:opinion` and
`/lets:ask` all run many models at once and are the right tool when the question is *what
should be done*. None of them writes code to a branch.

---

## Response Footer

- **One task, now** → `/lets:plan`, then `/lets:execute`.
- **Several tasks, and you want them ordered** → `/lets:backlog`.
- **Something stranded from an earlier attempt** → `/lets:worktree`.

## Rules

- Do not simulate a team. Sequential runs reported as parallel is a lie about what happened.
- Do not spawn implementation subagents from here; `/lets:execute` owns the run loop.
- Respond in the user's language.
