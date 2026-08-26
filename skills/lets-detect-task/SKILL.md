---
name: lets-detect-task
description: Internal skill for commands. Resolve the active lets task id from the git branch or the per-branch pointer file, or None. Invoked by /lets:start, /lets:status, /lets:end and /lets:note - not by user conversation.
---

# Detect Active Task

Resolve the active task id, or **None**. Every command that needs to know "which task is
this branch about" asks here.

> **Invoked by commands, not by conversation.** Do not trigger this on a user turn; a
> command calls it when it needs the id.

## Why this is the only place that parses a branch

Four commands need the active task. This skill is the **single source of truth for
branch-format parsing** — nothing else may re-derive it. When the branch format changes it
changes here, once. A command that re-implements a partial copy of the ladder below is a
bug waiting for the next format change.

## Precedence

1. **Explicit id** — the calling command was invoked with a `<task-id>` argument. Authoritative; stop, do not parse anything.
2. **Branch name** — `feature/<id>-<slug>`.
3. **Pointer file** — `.lets/sessions/.task-<branch-slug>`, which fills the gap when the branch carries no id.
4. Otherwise **None**. None is a correct answer.

> Divergence from the Claude Code LETS plugin, deliberate: there the pointer file outranks
> the branch name, because its `take-task` can host several tasks in sequence on one frozen
> worktree branch. This spine has no such flow — `/lets:start` cuts the branch from the id —
> so the branch is the stronger signal and the file covers the id-less cases.

## Step 1: Read both sources

```bash
LETS_PROJECT_ROOT=$(git rev-parse --show-toplevel)
BRANCH=$(git branch --show-current)
BRANCH_SLUG=$(echo "$BRANCH" | tr '/' '-')
echo "BRANCH=$BRANCH  BRANCH_SLUG=$BRANCH_SLUG"

# The pointer file, written by /lets:start.
sed -n 's/^task: //p' "$LETS_PROJECT_ROOT/.lets/sessions/.task-${BRANCH_SLUG}" 2>/dev/null | head -1
```

## Step 2: Parse the branch

The id sits immediately after `feature/`, up to the `-<slug>` boundary. Its shape is
**tracker-dependent**:

- **beads**: `<prefix>-<alphanum>[.<number>]` — `oci-infrastructure-73k`, `lets-abc.1`.
  Note the prefix itself contains dashes, so the id is *greedy up to the slug*, and on a
  branch like `feature/oci-infrastructure-73k-entra-federation` a naive
  "first two dash-separated fields" split returns the wrong thing.
- **tracker `none`**: there is no id shape. Skip this step; go to the pointer file.

When the branch does not start with `feature/`, or the parse is ambiguous, do **not** guess
— fall through to the pointer file.

## Step 3: Validate before returning

Any id crossing a tracker verb must match `^[A-Za-z0-9._-]+$` **and not start with `-`**.
`bd` reads a leading dash as options, so `--claim` is a perfectly valid-looking "id" that
would silently become a flag. `src/beads.ts` enforces the same rule at the call site
(`safeId`); enforce it here too so a bad id never gets as far as a command.

An id that fails validation is **None**, and say so in one line.

## Output

- The task id (string), or
- **None** — the caller decides what to do. `/lets:status` renders "no active task";
  `/lets:note` says there is nothing to note against and falls back to the snapshot trail.

## Not ported

The LETS original ends its ladder with a `search`-and-confirm fallback that asks the user to
confirm a task matched from the branch slug. That is omitted here: every caller in this
spine is a read/orient surface which LETS itself lists as **no-picker** (it returns None
rather than asking), so the fallback would never fire. It is not a silent drop — if a
picker-driven command (`/lets:commit`, `/lets:done`) is added later, that is when the
fallback earns its place.
