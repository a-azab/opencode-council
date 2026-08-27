---
description: Run the last crew plan — concurrent waves in isolated worktrees, then integrate, verify and review. Unattended, and reports honestly.
---

`/crew:execute` runs the plan `/crew:plan` recorded. Nobody approved that plan, so the
report at the end is the only thing between the user and a bad decision. Everything below
exists to keep that report true.

## What it does

```
Call the `crew` tool with mode: "execute"
```

That is the whole invocation — the plan, the ADR, the lanes and the task list all come from
the recorded artifact, not from you. Re-deriving any of it here would mean running something
other than what was planned and recorded.

In order, the tool:

1. **Schedules** the tasks into waves using the dependency graph. Two tasks share a wave only
   when their file sets are *provably* disjoint. A file the graph has never seen is not
   evidence of independence, so its task runs alone.
2. **Runs each wave concurrently** — one isolated worktree per task, its own branch, its own
   tracker session, and no pull request. Each task verifies and judges its own acceptance as
   it goes.
3. **Integrates** the task branches in order into one integration branch, stopping at the
   first conflict.
4. **Verifies** the integrated branch — the only check that sees the tasks combined.
5. **Reviews** it once, with the recruited lanes.
6. **Reports.**

## What you do while it runs

Nothing. It is unattended by design. Progress is appended to the run log as it happens, so
tail that if you want to watch; a tool call returns once, at the end, and a long silent run
is otherwise indistinguishable from a hang.

## Reading the result

The report is a CEO report: what shipped, what it decided, what it could not do, what needs
you. Pass it on as-is. In particular, **do not summarise away**:

- **`INCOMPLETE`** — if the first line says incomplete, lead with that. Do not open with the
  tasks that did succeed and mention the failures later.
- **A task that never ran**, and its reason.
- **`NOT independently judged`** — the acceptance judge fails open so an unreachable model
  cannot block work. That line means nobody checked; it is not a pass.
- **An aborted integration.** A conflict is evidence the scheduler wrongly judged two tasks
  independent. The merge is deliberately **not** resolved, because resolving it unattended
  would destroy that evidence. The fix is to correct the `files` on those tasks in the plan,
  or rerun the conflicting task on top of the integration branch.
- **`sequential` or `partial` scheduling.** It means the graph could not prove independence
  and the run serialised. Tell the user to rebuild the graph.
- **No pull request was opened.** That is deliberate — N tasks must not open N competing PRs
  before anything is integrated — and it is not the same as a push that failed. The branches
  are local and unpushed.

## After

Nothing is pushed. The integration branch holds the combined work and is yours to review:

```
git log --oneline <base>..<integration branch>
git diff <base>...<integration branch>
```

Then push it, or `/lets:plan` the follow-up for whatever came back incomplete.

## Response Footer

- **Something came back incomplete** → fix the plan, then `/crew:plan` again
- **A stranded worktree** → `/crew:status`, or `/lets:worktree`
- **Review the combined diff harder** → `/council:review`

## Rules

- Never re-plan here. Execute the recorded plan or report why you could not.
- Never resolve an integration conflict on the user's behalf in this command.
- Never report a run as successful when the tool reported it incomplete, and never soften
  the wording. Sequential runs reported as parallel, or partial runs reported as done, are
  lies about what happened.
- Respond in the user's language.
