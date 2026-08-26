---
name: lets-session-snapshot
description: Internal skill for commands. Write a recovery-grade session snapshot file under .lets/sessions/, always, plus a one-line task pointer only when a task is unambiguously active. Invoked by /lets:end and /lets:note --pre-compact - not by user conversation.
---

# Session Snapshot

The shared snapshot primitive. `/lets:end` and `/lets:note --pre-compact` both delegate here
so the template and the file/pointer behaviour never drift.

> **Invoked by commands, not by conversation.**

Goal: ONE recovery-grade `## RESUME` snapshot that is **file-primary** — it **ALWAYS lands
in a `.lets/sessions/` file regardless of task state**, because that file is the single
trail `/lets:start` reads back. The task gets only a one-line *pointer* to it, and only when
a task is unambiguously active.

> **Contract — this skill ONLY writes the snapshot (file + optional pointer).** It does not
> end the session, commit, push, merge, or close anything. The caller decides what else to do.

## Arguments

Space-separated `key=value`. Put a value containing spaces LAST.

- `kind` = `precompact` (default) | `end` — selects the artifact kind. Step 3 owns the filename; never build it here.
- `pointer` = `off` (default) | `auto` — whether to write the one-line task pointer. `off` is the safe default: a caller that forgets never double-writes.
- `task-id` (optional) — a pre-resolved active task from the caller.
- `range` (optional) — e.g. `session: <ref>..HEAD (3 commits)`. Include the `### Range` block **only** when provided.

## Step 1: Active task

If the caller passed `task-id`, use it. Otherwise invoke `skill(name: "lets-detect-task")`.

"Unambiguously active" = exactly one task resolved. No task, or ambiguity → **file only, no
pointer, no prompt.** A taskless session must still get its snapshot; that is the whole
point of file-primary.

## Step 2: Gather state

```bash
git branch --show-current
git rev-parse --short HEAD
git log --oneline -5
git status --short            # uncommitted / untracked
```

## Step 3: Write the FILE (always)

Resolve the path via `skill(name: "lets-artifact-path")` with `kind=snapshot` (for
`kind=end`) or `kind=snapshot-precompact` (for `kind=precompact`), passing `task=<id>` when
one is resolved.

The echoed `ARTIFACT_FILE` is `$SNAP_FILE`. **Reuse it and its basename verbatim** in Step 4
and in the Return — never recompute the timestamp, or the pointer drifts off the file that
was actually written.

Write `$SNAP_FILE` with the template below. English; one continuous line per paragraph, no
hard wrapping. **For any section with nothing to record write a single `- (none)` stub,
never a blank block** — except `### Range`, which is omitted entirely unless the caller
passed `range`, in which case it sits between `### Remaining + NEXT STEP` and
`### Compaction`.

    ## RESUME {YYYY-MM-DD HH:MM} - {short label}

    ### Where things live
    - repo / branch: {branch} @ {short-sha}; key paths touched: {file:line, ...}
    - external sources: {PR #, links, other-project paths, recovery commands}

    ### State
    - committed: {...}; uncommitted/untracked: {git status}; frozen artifacts + SHAs: {...}

    ### Decided (do NOT re-litigate)
    - {decision -> reasoning}
    - verified vs code: {claim -> file:line}

    ### Remaining + NEXT STEP
    - {open items}
    - NEXT: {the single concrete next action + how to resume it}

    ### Compaction
    - {precompact: snapshot written before compacting; resume with /lets:start, which reads this file}
      {end: session-end snapshot}

**The `NEXT:` line is a single concrete next action** — a command to run or an edit to make,
not a topic. "Continue the work" is a failed snapshot. If an approved plan exists and has
not been executed, `NEXT:` is the command that executes it, never "implement item 3": a
resumed session re-reads the plan, and the plan says the same thing.

## Step 4: One-line task pointer (conditional)

Only when `pointer=auto` **and** a task is unambiguously active **and** the tracker is beads:

```bash
LETS_PROJECT_ROOT=$(git rev-parse --show-toplevel); mkdir -p "$LETS_PROJECT_ROOT/.lets/cache"
cat > "$LETS_PROJECT_ROOT/.lets/cache/pointer-<task-id>.md" <<EOF
## RESUME $(date +%Y-%m-%d) - snapshot: .lets/sessions/<SNAP_BASENAME from Step 3>
EOF
bd comment <task-id> --file "$LETS_PROJECT_ROOT/.lets/cache/pointer-<task-id>.md"
```

Otherwise write nothing to the task — **the file is the record.** With `TRACKER=none` there
is nowhere to put a pointer and nothing is lost, because the file was never the fallback.

## Return

Report to the caller: the snapshot file path (the `SNAP_FILE` echoed in Step 3), and the
task id if a pointer was written. The caller handles all further output.

## Not ported

LETS opens this template with a `### Claude Session` block recording
`$CLAUDE_CODE_SESSION_ID` and the transcript path, so a resumed session can reopen the exact
transcript. **opencode exposes no equivalent session-id environment variable**, so the block
is dropped rather than filled with a plausible-looking wrong value. The cost is real and
worth naming: recovery is from the snapshot's own content, not from a transcript you can
re-open. Everything the `## RESUME` sections capture is unaffected — which is why they are
written to be recovery-grade on their own.
