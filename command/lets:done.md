---
description: Finish a task — verify it is committed, push, open a PR when there is a remote, and close the task only when the work actually landed. Not session end; that is /lets:end.
---

Finish a **task**: get the committed work out of this checkout and close the loop honestly.

**This is not session end.** `/lets:end` ends a session and closes nothing. This closes a
task — and only when the work actually landed somewhere.

## Step 1: The tree must be clean

```bash
git status --short
```

**Anything listed → stop.** Name the files and point at `/lets:commit`:

> {N} uncommitted file(s): {list}. `/lets:done` pushes and closes what is *committed*, so
> these would be left behind on this machine while the task was marked done. Commit them
> with `/lets:commit`, or stash them, then re-run.

Refusing is the point of this step, not an inconvenience — see **Not ported**.

Then require something to finish:

```bash
git rev-parse --verify --quiet HEAD >/dev/null || echo NO_COMMITS
```

`NO_COMMITS` → nothing to push and nothing to close. Say so and stop.

## Step 2: The active task

Invoke `skill(name: "lets-detect-task")`.

**None** → ask which task this finishes, offering "no task — just push". A push with no task
is a valid finish; a *close* with no id is not.

**Epic guard.** With a beads tracker, read the type before going any further:

```bash
bd show <task-id> --json      # read [0].issue_type
```

`epic` → **do not close it.** Epics outlive their children. Say so and offer to close a
specific child instead.

> The field is **`issue_type`**, not `type`. LETS's `done.md` says "beads exposes `type`";
> the `bd` here returns `issue_type` (verified against `bd list --json`). Reading `.type`
> yields `undefined`, so the guard never fires and an epic closes silently — do not "correct"
> this back to match the LETS text.

## Step 3: What is being finished

Read the base from the `base:` line in the ```lets block of `AGENTS.md`.

```bash
BASE=<base from AGENTS.md>
BRANCH=$(git branch --show-current)
LETS_PROJECT_ROOT=$(git rev-parse --show-toplevel)
BRANCH_SLUG=$(echo "$BRANCH" | tr '/' '-')

START=$(sed -n 's/^start: //p' "$LETS_PROJECT_ROOT/.lets/sessions/.task-${BRANCH_SLUG}" 2>/dev/null | head -1)
case "$START" in *[!0-9a-f]*) START="" ;; esac
[ -n "$START" ] && ! git merge-base --is-ancestor "$START" HEAD 2>/dev/null && START=""

if [ "$BRANCH" != "$BASE" ]; then RANGE="${BASE}..HEAD"
elif [ -n "$START" ];        then RANGE="${START}..HEAD"
else                              RANGE=""
fi
[ -n "$RANGE" ] && git log $RANGE --oneline && git diff --stat $RANGE
```

`start:` is written by `/lets:start` and read-only here. It is blanked when it is not an
ancestor of HEAD, because a rebase or reset leaves a stale SHA behind and a stale range
silently reports the wrong commits. Non-hex is blanked before it reaches a git range for the
same reason `/lets:end` does it — the file is hand-editable.

**Empty `RANGE`** (on the base branch, no recorded boundary): `{BASE}..HEAD` is empty when
HEAD *is* the base, so the range cannot be inferred. Say that and ask for it. Do not report
zero commits as though nothing was done.

### Scope check

With a beads tracker, compare the task's description against what actually changed:

```
- [x] {requirement} — {file}
- [ ] {requirement} — NOT FOUND
```

Anything unchecked → ask before continuing, via the **`question`** tool: **Fix first** (stop,
go back to the work) / **PR only, keep open** (finish, but never close) / **Scope is right**
(the description was broader than this task).

## Step 4: Which mode this repo is in

Not configured — **detected**. This plugin's ```lets config has `verify:`, `base:` and
`lanes:`, and no `pr_flow` key, so the repo itself is the source of truth:

```bash
git remote                                    # empty output = no remote
gh auth status >/dev/null 2>&1 && echo GH_OK || echo GH_NO
```

| Remote | `gh` | Mode | Push | PR | Task |
|---|---|---|---|---|---|
| yes | ok | **github** | yes | yes | **stays open** until the PR merges |
| yes | no | **push-only** | yes | no | **stays open** — nothing merged it |
| no | — | **local** | nothing to push | no | **closed**, after the local merge |

And one override: **HEAD is already the base branch** → no PR is possible, because a PR from
a branch to itself is not a PR. Push if there is a remote, then treat it as **local** for the
close.

> **The close rule is LETS's, not an invention.** `done.md` Rules: *"If PR flow: task stays
> open, user closes after merge. If local merge: task closes immediately."* A task closed
> while its PR sits unreviewed is a lie told to everyone reading the board.

## Step 5: Confirm

Via the **`question`** tool, worded for the detected mode:

- **github** — **Finish**: "Push `{branch}` and open a PR to `{base}`. The task stays open until it merges."
- **push-only** — **Finish**: "Push `{branch}` to origin. No PR — `gh` is unavailable. The task stays open."
- **local** — **Finish**: "Merge `{branch}` into `{base}` locally and close the task. No remote, so nothing is pushed."
- every mode — **Keep working**: "Not done — go back to the task."

**Never push, open a PR, merge, or close without this answer.**

## Step 6: Record the work on the task

Before the push, so the record survives a push that fails:

```bash
LETS_PROJECT_ROOT=$(git rev-parse --show-toplevel); mkdir -p "$LETS_PROJECT_ROOT/.lets/cache"
cat > "$LETS_PROJECT_ROOT/.lets/cache/done-<task-id>.md" <<EOF
## Completed $(date +%Y-%m-%d)

### Commits
$(git log $RANGE --oneline)

### Summary
{1-2 sentences: what this task actually did}

### Key decisions
- {choices the diff does not explain}

### Files changed
$(git diff --stat $RANGE)
EOF
bd comment <task-id> --file "$LETS_PROJECT_ROOT/.lets/cache/done-<task-id>.md"
```

**No task, or tracker `none`:** skip this step entirely. Do not write the file, and do not
report that a comment was added.

## Step 7: Finish

### github

```bash
git push -u origin "$BRANCH"
gh pr create --base "$BASE" --title "<type>: {task title}" --body "$(cat <<'EOF'
## Summary
{task description}

## Changes
{git log $RANGE --oneline}

## Task
{task-id}: {title}
EOF
)"
```

Then record the URL on the task and **leave it open** (`bd comment <task-id> --file <file
containing "PR opened: {url}">`).

Push succeeded but `gh pr create` failed → say exactly that: the branch **is** on the remote,
the PR is **not** open, open it yourself. Do not retry silently and never report a PR that
does not exist.

> Beads has no `in_review` status, so LETS's "advance the task to in_review" step is skipped
> rather than faked. The task stays `in_progress`, which is true.

### push-only

```bash
git push -u origin "$BRANCH"
```

No PR. Task stays open. Report the branch, and that opening the PR is a human's next move.

### local

No remote, so nothing leaves this machine. Merge, then close.

```bash
git checkout "$BASE" && git merge --no-ff "$BRANCH" && git branch -d "$BRANCH"
```

`-d`, never `-D`: it refuses to delete a branch that did not merge, so a failed merge cannot
also lose the branch.

**In a worktree** you cannot check out the base — it is checked out elsewhere. Operate on the
main repo, and do not delete the branch or the worktree from in here:

```bash
MAIN_ROOT=$(cd "$(git rev-parse --git-common-dir)/.." && pwd)
git -C "$MAIN_ROOT" checkout "$BASE"
git -C "$MAIN_ROOT" merge --no-ff "$BRANCH"
```

`/lets:worktree` handles worktree cleanup, from the main checkout.

Merge conflicts → stop, leave them in place, say where they are. **Do not close a task whose
merge did not complete.**

Only after the merge actually succeeded:

```bash
bd close <task-id>          # the id is NOT optional here — see below
```

**Never run `bd close` bare.** With no id it closes *the last touched issue* — whatever the
most recent `create`, `update`, `show` or `close` happened to touch, which in this command is
usually the right task and occasionally someone else's. An id that failed the shape check is
**not** a reason to fall back to the bare form; it is a reason to stop.

Read what it returned. Closed → report closed. A different status → the board advanced the
task instead of closing it; report that and **do not describe the task as done**. The command
failed → report the failure and claim nothing.

**Tracker `none`:** there is no task to close. Merge, report the merge, and say plainly that
nothing was closed because nothing is tracking it. Never render an empty task line, and never
imply a close happened.

## Step 8: Report — say what actually happened

**github:**
```
Task: **{title}** (`{id}`) — open until the PR merges
Branch: `{branch}` → `{base}`
PR: {url}
```

**push-only:**
```
Task: **{title}** (`{id}`) — still open
Branch: `{branch}` pushed to origin. No PR — `gh` is not available here, so open it yourself.
```

**local:**
```
Task: **{title}** (`{id}`) — {closed | advanced to {status} | not closed — tracker none}
Merged: `{branch}` → `{base}`, locally.

No remote on this repo, so nothing was pushed and there is no PR. The work exists only in
this clone.
```

That last paragraph is not a caveat to bury at the bottom. A report that says "done" without
it reads as *shipped*, and the work is one `rm -rf` away from gone. `renderRun` in
`src/lets.ts` says the same thing about a branch it could not push — match that plainness.

---

## Response Footer

- **Task closed, clean tree** → `/lets:start` for the next task, or `/lets:end` to wrap up the session.
- **PR open, task still open** → `/lets:start` for the next one; come back and close this after it merges.
- **Stopped on a dirty tree** → `/lets:commit`.
- **Worktree still on disk** → `/lets:worktree`, from the main checkout.

## Rules

- **Never push, PR, merge or close without confirmation.**
- **Never close a task whose work did not land** — an open PR is not landed.
- Record on the task *before* pushing, so a failed push still leaves a record.
- Blank a `start:` that is non-hex or not an ancestor of HEAD before it reaches a git range.
- Any id crossing a `bd` verb must match `^[A-Za-z0-9._-]+$` and must not start with `-`, or
  `bd` reads it as an option. An **absent** id is the worse half of the same rule: `close`,
  `show` and `comment` all fall back to the last-touched issue rather than erroring, so a
  missing id retargets the command instead of failing it. No id → stop, never a bare verb.
- Respond in the user's language.

## Not ported

LETS's `done.md` is 768 lines, most of it branch handling. This is its spine. Dropped
deliberately, and each one is a real capability you are not getting:

- **"Skip" on uncommitted changes.** LETS lets you finish a task with a dirty tree. Here it
  is refused: this whole command is about getting work *out* of a checkout, and "skip" is
  precisely how work gets marked done and left behind on one machine.
- **Bitbucket (`bbb`) flow.** No `bbb` here. **push-only** covers "there is a remote but this
  tool cannot open the PR" without pretending to know the host.
- **Already-merged guard** (`gh pr list --state merged`). If the branch merged in a parallel
  session, `gh pr create` fails with "No commits between …" — a clear error, and Step 7
  already reports a failed PR honestly rather than crashing.
- **`in_review` status.** Beads has no such status. Skipped rather than faked.
- **CHANGELOG step.** LETS drafts an `[Unreleased]` entry before pushing. This repo has no
  `CHANGELOG.md`; in a repo that does, write it and `/lets:commit` it before running this.
- **`$CLAUDE_CODE_SESSION_ID`** in the completion comment. A Claude-Code-only env var with no
  opencode equivalent. The comment carries the date and the commit range instead — which
  identify the session better than a UUID nobody can look up.
- **`gh pr merge --squash`** as a follow-on option. Merging your own PR seconds after opening
  it defeats the review the PR exists for. Merge it where PRs get merged.
- **Trunk-mode's full routing.** Reduced to the one line that matters: HEAD == base means no
  PR is possible. The rest of LETS's trunk branching existed to keep the `start:` boundary
  correct, which Step 3 already handles uniformly.
