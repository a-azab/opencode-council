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
2. **Pointer file** — `.lets/sessions/.task-<branch-slug>`, written when a task is taken.
3. **Branch name** — `feature/<id>-<slug>`.
4. Otherwise **None**. None is a correct answer.

> **The file outranks the branch, and that ordering is load-bearing.** A branch is frozen at
> the moment it is cut, so it records only the task it was *created* for. A worktree can then
> host several tasks in sequence, and the file is the one that says which is current. Reading
> the branch first would resume the wrong task — silently, and with a plausible-looking id.
>
> This matches the Claude Code LETS plugin, whose `detect-task` Step 1.5 makes the same call
> for the same reason.

**The id's shape is tracker-dependent.** Do not apply a beads-style `<prefix>-<alphanum>`
pattern on a repo whose tracker is not beads: on `feature/48647-lifecycle-test` it captures
`lifecycle-test` rather than the numeric id `48647`. Match against the active tracker's id
shape, and when the branch is ambiguous prefer the pointer file over a branch-name guess.

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

When the branch does not start with `feature/`, or the parse is ambiguous, do **not** guess.

**Resolve:** the pointer file wins whenever it has a value. Use the branch-parsed id only
when the file is absent or empty. Step 1 reads both so this is a comparison, not a
fall-through — the branch is the *fallback*, never the first answer.

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
