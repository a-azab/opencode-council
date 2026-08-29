---
description: Run the last crew plan — concurrent waves in isolated worktrees, then integrate, verify, review and update the docs. Unattended, and reports honestly.
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

## When a previous run was interrupted

A crew run is long and unattended, which makes it the thing that gets interrupted — a
timeout, a dropped connection, a closed laptop. Every task that finished has already left
its branch behind, so the work survives even when the run does not. The tool checkpoints to
`state.json` after **every task**, not per wave and not at the end, because the end is
exactly what an interrupted run never reaches.

So a rerun of a plan that has a checkpoint **does not run**. It comes back naming the
finished tasks, their branches, and what is still to do:

```
A previous run of this plan stopped part-way. 1 of 2 task(s) finished, and their branches
are still here:
  ✓ First — `lets/done-one`
  · Second — not done

`resume: true` keeps the finished branches and runs only what is left.
`fresh: true` ignores them and runs the whole plan again.
```

**Show that to the user and ask which they want. Do not pick for them.** The two answers cost
different things — `resume` skips work, `fresh` pays for it again — and the tool refuses
precisely because neither is safe to assume on someone's behalf. Then call it again with the
answer, `mode: "execute"` plus `resume: true` or `fresh: true`.

A run interrupted *after* the last task — during integration, verify or review — refuses the
same way with different wording: it "finished all N task(s) and then stopped", and `resume`
goes straight to integrating, verifying and reviewing. That is the longest unattended stretch
in a run, and the one most worth not repeating.

Three things it will not do:

- **Trust the record over the branch.** A finished task whose branch has since been deleted
  runs again. The alternative is an integration that quietly misses that task's work while
  the report calls it done.
- **Resume across plans.** A checkpoint from a different `/crew:plan` is ignored — those
  branches answer a different question, and being the newest file on disk is not evidence.
- **Hide a carried-forward task.** Resumed branches are integrated with the rest and marked
  in the report as **carried forward from an earlier run**. The record stands in for the
  approval gate, so it must not claim a span of work this run did not perform.

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

## Then the tech writer updates the docs

The work has landed on the integration branch. Before you hand the report over, bring in the
**tech writer** for the docs this change affects — the README section that describes the
behaviour that just changed, the ADR whose decision the implementation walked away from, the
config sample with the old default in it, the doc comment above a rewritten function.

Give it the integrated diff and let it check its claims against the merged source rather
than against the plan or the commit messages. Crew decided this plan itself, so "what the
change was supposed to do" is the least reliable description of what it did.

**This is a team member's job, not a gate.** It does not block the report, nothing is
reverted because a doc lagged, and a change with no documentation surface needs no
documentation. What it does mean is that shipping code and leaving the docs describing the
previous version is an unfinished piece of work, not a tidy-up for later — say in the report
what was updated, and what is still stale and why.

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

- Never choose `resume` or `fresh` for the user. The tool refused because both answers are
  wrong some of the time; picking one silently is the whole failure it exists to prevent.

- Never re-plan here. Execute the recorded plan or report why you could not.
- Never resolve an integration conflict on the user's behalf in this command.
- Never report a run as successful when the tool reported it incomplete, and never soften
  the wording. Sequential runs reported as parallel, or partial runs reported as done, are
  lies about what happened.
- Respond in the user's language.
