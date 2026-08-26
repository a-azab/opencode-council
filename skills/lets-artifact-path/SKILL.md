---
name: lets-artifact-path
description: Internal skill for commands. Resolve a unique, collision-safe path for a session artifact under .lets/sessions/ and echo it. Invoked by the lets session commands before they write - not by user conversation.
---

# Artifact Path

Name a session artifact and guarantee the path is free. This is the single place that does
it.

> **Invoked by commands, not by conversation.**

**Contract:** args `kind=<snapshot|snapshot-precompact> [task=<task-id>]`. Output: ONE
echoed line `ARTIFACT_FILE=<absolute path>`. The caller writes to that path **verbatim** —
never recomputes the stamp, never strips a `-vN` suffix, never writes anywhere else.

## Why the echo is the contract

`.lets/` is ONE directory shared by every worktree of the repo. Two sessions writing the
same artifact kind in the same minute would otherwise overwrite each other. The `-vN` loop
below is the guard.

The echo matters just as much: **a caller that recomputes the timestamp drifts off the file
that was actually written.** `date +%H%M` a second later can land in the next minute, and
then the pointer written into the task or the report shown to the user names a file that
does not exist. Capture the echoed line once; reuse it everywhere.

## Name shape

```
.lets/sessions/{YYYY-MM-DD}-{HHMM}-{task-id | branch-slug-6hex}-snapshot[-precompact][-vN].md
```

`ID` is the **task id whenever one is active** — same rule as `feature/<task-id>-...`
branches. With no task it is `{branch-slug}-{6hex}`, so two taskless sessions on the same
branch still get distinct names.

## Step 1: Resolve the task id

If the caller passed `task=`, use it. Otherwise invoke `skill(name: "lets-detect-task")`
and use its result, which may be None. A taskless snapshot is normal and must stay silent —
never prompt from here.

## Step 2: Compute the path

```bash
LETS_PROJECT_ROOT=$(git rev-parse --show-toplevel)
KIND="{kind}"; TASK_ID="{task-id or empty}"
case "$KIND" in
  snapshot|snapshot-precompact) DIR=sessions ;;
  *) echo "artifact-path: unknown kind '$KIND'"; exit 1 ;;
esac
mkdir -p "$LETS_PROJECT_ROOT/.lets/$DIR"
STAMP=$(date +%Y-%m-%d-%H%M)
if [ -n "$TASK_ID" ]; then
  ID="$TASK_ID"
else
  # 6 hex of entropy per session. LETS uses $CLAUDE_CODE_SESSION_ID here; opencode exposes
  # no equivalent, so this uses the shell PID - which is exactly the fallback the LETS
  # original already carries (`${CLAUDE_CODE_SESSION_ID:-$$}`). Distinct per session, which
  # is all this needs to be.
  HEX=$(printf '%06x' "$$" | tail -c 6)
  ID="$(git branch --show-current | tr '/' '-')-${HEX}"
fi
BASE="$LETS_PROJECT_ROOT/.lets/$DIR/${STAMP}-${ID}-${KIND}"
ARTIFACT_FILE="${BASE}.md"; N=2
while [ -e "$ARTIFACT_FILE" ]; do ARTIFACT_FILE="${BASE}-v${N}.md"; N=$((N+1)); done
echo "ARTIFACT_FILE=$ARTIFACT_FILE"
```

## Return

Return the echoed `ARTIFACT_FILE`. If the echo is missing or `exit 1` fired, the caller
**must not write anything** — surface the error instead.

## Rules

- NEVER overwrite: the `-vN` loop is the guard; the caller never "fixes" a path by hand.
- NEVER compute a second `date` in the caller — the stamp is captured here, once.
- Task id in the name is mandatory when a task is active.
- No tracker calls here beyond `lets-detect-task`.

## Scope

Only session artifacts. LETS also routes `plan` and `review-*` kinds through this skill;
here those are already owned by the `council`/`lets` tools, which write under
`council-artifacts/<stamp>-<kind>/` from `src/index.ts`. The two trails coexist on purpose
— `.lets/sessions/` is the session spine's, written by commands; `council-artifacts/` is
the pipeline's, written by tools. Do not cross them.
