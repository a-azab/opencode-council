---
description: Show what is ready to work on, in dependency order, and hand the pick off to /lets:start. Read-only — claims nothing.
---

What is ready to work on, in priority order. Pick one and this hands off to `/lets:start`.

This command **reads and asks**. It creates nothing, claims nothing, closes nothing —
`/lets:start` does the claiming and cuts the branch.

## Step 1: Is there a board?

```bash
LETS_PROJECT_ROOT=$(git rev-parse --show-toplevel)
if command -v bd >/dev/null 2>&1 && [ -d "$LETS_PROJECT_ROOT/.beads" ]; then
  echo TRACKER=beads
else
  echo TRACKER=none
fi
```

**Both conditions**, the same rule as `lets-orient` and `beadsAvailable()` in `src/beads.ts`:
`bd` on PATH means the tool is installed, `.beads/` means *this repo* opted in. Creating a
database in a project that never asked for one is not ours to do.

**`TRACKER=none`** → there is no backlog to read. Say it in one line and stop:

> No task tracker in this repo, so there is no backlog to show. `/lets:start` still works —
> describe the work and it becomes the session's subject.

Do not render an empty list, and do not offer to run `bd init`.

## Step 2: Ready work

```bash
bd ready --limit 10 --json
```

`bd ready` already computes readiness from the dependency graph — open issues with no unmet
blockers, ready ones first. **Use its order; do not re-sort it**, and do not rebuild it from
`bd list` plus a hand-rolled filter. Re-sorting throws away the dependency information that
is the only reason this list beats "all open tasks".

For context, not for re-ranking:

```bash
bd list --status in_progress --json
bd stats --json
```

## Step 3: Show it

```
## Ready

1. **{title}** (`{id}`) · P{priority} — {one line from the description}
2. …

## In flight
- **{title}** (`{id}`) — already claimed

{N} open · {M} in progress · {K} closed
```

`ready` empty but open tasks exist → every open task is blocked. Say that, and show what they
are blocked on rather than printing an empty list.

Nothing anywhere → the backlog is empty. Say so; that is a fine state, not an error.

## Step 4: Pick

Ask which one via the **`question`** tool — the top few by title and id, plus **Something
else**.

- **A task** → `/lets:start <id>`. Hand off. Do not claim it here and do not cut a branch:
  `/lets:start` reads the previous sessions' snapshots first, and that recovered context is
  the entire reason it exists.
- **Something else / free text** → they are describing work that is not on the board.
  `/lets:start` creates the task and claims it in one step; send them there with the
  description rather than filing it here.

## Step 5: Say when something is already in flight

If Step 2 found an `in_progress` task, name it **before** they pick a new one:

> **{title}** (`{id}`) is already in progress. `/lets:start --continue` resumes it.

Two tasks claimed at once is how one of them gets silently abandoned.

---

## Response Footer

- **Picked a task** → `/lets:start <id>`.
- **Something already in flight** → `/lets:start --continue`.
- **Backlog empty, or tracker `none`** → `/lets:start`, and describe the work.

## Rules

- Read-only. Never claim, create, close or reprioritise from here.
- Never re-sort `bd ready`.
- Any id crossing a `bd` verb must match `^[A-Za-z0-9._-]+$` and must not start with `-`, or
  `bd` reads the id as an option.
- Respond in the user's language.

## Not ported

LETS's `backlog.md` is 648 lines across three modes. This is the useful core — the "what
should I work on next" question people actually run it for. Dropped:

- **Review mode.** An explorer subagent scouts the project, up to ten domain agents ideate
  over the backlog in parallel, and a clustering pass merges their output. **`/council:*` is
  already this plugin's multi-model analysis** — with a deterministic aggregator, cross-model
  scoring and a preserved dissent record that a re-implementation here would not have. A
  third implementation of fan-out-and-merge is worse than a pointer to the one that exists:
  `/council:plan` for what to build, `/council:task` for a decision, `/council:independent`
  for unmerged takes.
- **`--workflow`.** Claude Code's Dynamic Workflows tool — a research preview with no
  opencode equivalent. It only ever moved Review's fan-out off-context, and Review is gone.
- **Cleanup mode.** Interactive triage that closes, relabels and reprioritises tasks in a
  loop. It is a bulk-mutation surface and this command is deliberately read-only; `bd` does
  each of those directly and does not need a wrapper around it.
