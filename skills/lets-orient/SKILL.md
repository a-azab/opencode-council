---
name: lets-orient
description: Internal skill for commands. Render the shared lets orientation snapshot - where you are, what's in flight, what's next - degrading cleanly when no task tracker is present. Invoked by /lets:status and /lets:start - not by user conversation.
---

# Orient Snapshot

Render the shared "where am I / what's in flight / what's next" snapshot. Consumed by
`/lets:status` (snapshot, then stop) and `/lets:start` (snapshot, then pick and claim), so
the two can never drift.

> **Invoked by commands, not by conversation.**

> **This skill ONLY gathers and renders.** It does NOT select, claim, mutate, or advise.
> **The caller owns follow-through.** `/lets:status` stops after it; `/lets:start` drives
> task selection from it. Read-only is the whole contract — if you find yourself about to
> claim a task here, that belongs to the caller.

## Step 1: Which tracker

```bash
LETS_PROJECT_ROOT=$(git rev-parse --show-toplevel)
if command -v bd >/dev/null 2>&1 && [ -d "$LETS_PROJECT_ROOT/.beads" ]; then
  TRACKER=beads
else
  TRACKER=none
fi
echo "TRACKER=$TRACKER"
```

**Both conditions are required.** `bd` on PATH means the tool is installed; `.beads/` means
*this repo* opted in. A repo with the binary but no database is not tracked, and creating
one uninvited is not ours to do. (`beadsAvailable()` in `src/beads.ts` is the same rule,
encoded for the TypeScript side; the verbs below match its exported names.)

`TRACKER=none` is a **supported state, not a failure** — see Step 6.

## Step 2: Active task

Invoke `skill(name: "lets-detect-task")` → an id, or None.

When it yields an id and the tracker is beads, get its title:

```bash
bd show <id> --json     # an ARRAY wrapping one issue; read [0].title and [0].status
```

If the nested skill call is unavailable, do **not** re-derive the id from a partial copy of
the branch-parsing ladder — it would rot the moment the format changes. Drop the active-task
reference, note that it degraded in one line, and continue; Step 4 still surfaces anything
in progress. `lets-detect-task` stays the single source of branch-format truth.

## Step 3: Git state

```bash
git branch --show-current
git status --short          # empty = clean; otherwise count the lines
git rev-parse --git-dir     # contains `worktrees/` when this is a linked worktree
```

Add one compact context line only when it applies: worktree, or on the configured base
branch with no task.

## Step 4: In flight  *(beads only)*

```bash
bd list --status in_progress --json
```

Mark the Step 2 task with ` <- active`. Empty output (`[]`) renders "Nothing in flight." —
that is data, not an error.

## Step 5: Next up  *(beads only)*

```bash
bd ready --limit 5 --json
```

`bd ready` already computes readiness from the dependency graph, open tasks with the ready
ones first. **Use it; do not re-implement it** from `bd list` and a hand-rolled filter.
Priority-ordered, not grouped by label. If more are ready than shown, note `(+N more ready)`.

## Step 6: Project counts  *(beads only)*

```bash
bd stats --json         # counts live under .summary, beside keys this does not use
```

Read `summary.open_issues`, `summary.in_progress_issues`, `summary.closed_issues`. Do not
hand-roll per-status counts over task JSON — that is the fragile path this replaces. If
`stats` fails or has no `summary`, **omit the `## Project` section** rather than render an
empty one.

## Step 7: Render

```
## Where you are
Branch: `{branch}`  -  {Task: **{title}** (`{id}`) | no active task}  -  {clean | {N} uncommitted}
{context line: worktree / base-branch - only if applicable}
{Tracker: none - task tracking off        - only when TRACKER=none}

## In flight
- **{title}** (`{id}`){ <- active}
{if none: "Nothing in flight."}

## Next up
  P{n}  **{title}** (`{id}`)
  (+{N} more ready)
{if none: "No ready tasks."}

## Project
{open} open - {wip} in progress - {closed} closed
```

**On `TRACKER=none`:** In flight / Next up / Project have no data source. **Omit all three
sections entirely** — never render them empty or broken. Show `## Where you are` with the
`Tracker: none - task tracking off` line, and nothing else. The branch, the task-pointer
file and the dirty-file count still work without any tracker, which is exactly why that
section survives.

## Rules

- **Read-only. Never mutate, never claim, never advise** — the caller owns follow-through.
- Every task reference renders as **`**Title** (`id`)`** — never a bare id. An id alone
  makes the reader go look it up.
- **Degrade section-by-section**: a missing capability drops its section, never the whole
  snapshot.
- Respond in the user's language.

## Not ported

LETS also lists open GitHub PRs in `## In flight` when its PR flow is set to github. That is
omitted here: this plugin has no equivalent configured PR-flow setting to gate it on, and
running `gh` unconditionally would fail noisily in every repo without it. Adding it is a
one-line `gh pr list` once such a setting exists.
