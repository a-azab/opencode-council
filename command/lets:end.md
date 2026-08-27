---
description: End a work session — write a recovery-grade snapshot to .lets/sessions/ so the next session can pick up where this one stopped. --pre-compact writes the same snapshot without ending anything.
---

End a session by writing down what a future session would otherwise have to reconstruct.

**This is not task completion.** It ends a SESSION, not a task. The task stays in progress
unless you close it yourself.

## Usage

```
/lets:end                  # session-end snapshot
/lets:end --pre-compact    # same snapshot, session continues — write this before compacting
```

## Step 1: Session range

```bash
LETS_PROJECT_ROOT=$(git rev-parse --show-toplevel)
BRANCH=$(git branch --show-current); BRANCH_SLUG=$(echo "$BRANCH" | tr '/' '-')
git status --short

START_REF=$(sed -n 's/^start: //p' "$LETS_PROJECT_ROOT/.lets/sessions/.task-${BRANCH_SLUG}" 2>/dev/null | head -1)
# The boundary is a plugin-written SHA. Blank anything non-hex before it expands into a git
# range, so a hand-edited state file cannot inject git option arguments.
case "$START_REF" in *[!0-9a-f]*) START_REF="" ;; esac

if [ -n "$START_REF" ]; then
  RANGE_DESC="session: ${START_REF}..HEAD ($(git rev-list --count ${START_REF}..HEAD) commits)"
else
  RANGE_DESC="boundary unknown (no /lets:start this session)"
fi
echo "RANGE_DESC=$RANGE_DESC"
```

An unknown boundary is not an error — it means this session did not begin with `/lets:start`.
Pass it through as-is; the snapshot says so rather than guessing a range.

**This command only ever READS the `start:` boundary. It never writes it.** `/lets:start`
owns that write. An end that moved the boundary would make the next end measure from the
wrong place.

## Step 2: Write the snapshot

Invoke the shared primitive — both modes go through it, so the template cannot drift:

- default: `skill(name: "lets-session-snapshot")` with `kind=end pointer=auto range={RANGE_DESC}`
- `--pre-compact`: `skill(name: "lets-session-snapshot")` with `kind=precompact pointer=auto`

The skill resolves the path, **always writes the file** whether or not a task is active, and
adds a one-line pointer to the task only when one is unambiguously active and the tracker is
beads. Take the returned path and report it **verbatim** — do not rebuild the filename, the
minute in it will not match.

Fill the template from the actual session: what was decided and why, what is committed
versus still dirty, and a `NEXT:` line naming **one concrete action**. A snapshot whose next
step is "continue the work" has failed at the only job it has.

## Step 3: Report, then stop

```
## Session End

Branch: {branch}
Git: {clean | N uncommitted}
Task: {**title** (`id`) | none}
Range: {RANGE_DESC}
Snapshot: {path returned by the skill}
```

For `--pre-compact`, the same block headed `## Pre-Compact Snapshot`, plus:

```
Safe to compact now — this session continues. Resume with /lets:start, which reads this file.
```

Then **stop**. This command does not commit, push, merge, or close anything. If there is
uncommitted work, the footer names it; settling it is the user's call, not this command's.

---

## Response Footer

- **Uncommitted changes** → `/lets:commit`.
- **Active task, clean tree** → `/lets:note`, or `/council:check` for a review pass.
- **No active task** → `/lets:start`.

## Rules

- **Always write the snapshot file**, task or no task. The file is the record; the task
  pointer is a convenience on top of it.
- **Never write the `start:` boundary here** — only read it.
- `--pre-compact` ends nothing. It writes and returns.
- Respond in the user's language.
