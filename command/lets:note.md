---
description: Append a note to the active task — progress, a decision, a finding, a blocker. Falls back to the session snapshot trail when no tracker is present.
---

Record something against the active task that would otherwise only exist in this
conversation.

This is a utility, not a pipeline step. Use it for the things the other commands do not
capture: a decision and its reasoning, a finding, a blocker, context for whoever picks this
up next.

## Usage

```
/lets:note                  # infer the note from the conversation, confirm before writing
/lets:note <free text>      # use the text as the note
/lets:note --pre-compact    # a full session snapshot instead — identical to /lets:end --pre-compact
```

## Step 0: --pre-compact

If `--pre-compact` was passed, do **not** run the steps below. Delegate to
`skill(name: "lets-session-snapshot")` with `kind=precompact pointer=auto`, report the
returned path, and stop. This path is deliberately identical to `/lets:end --pre-compact` —
one primitive, so the two can never produce different snapshots.

## Step 1: Find the task

Invoke `skill(name: "lets-detect-task")`.

**No task** → go to Step 4. A note with nowhere to go still has somewhere to go.

## Step 2: Read before writing

```bash
bd show <task-id> --json
```

Read the description and existing notes. **Do not restate what is already recorded** — a
task whose notes repeat each other is one nobody reads.

## Step 3: Write the note

Compose the body to a file and submit it with `--file`, so markdown and newlines survive
intact rather than being flattened through shell quoting:

```bash
LETS_PROJECT_ROOT=$(git rev-parse --show-toplevel); mkdir -p "$LETS_PROJECT_ROOT/.lets/cache"
cat > "$LETS_PROJECT_ROOT/.lets/cache/note-<task-id>.md" <<'EOF'
## {Progress|Decision|Research|Blocker} {YYYY-MM-DD}

{body, per the shapes below}
EOF
bd note <task-id> --file "$LETS_PROJECT_ROOT/.lets/cache/note-<task-id>.md"
```

If the note type is not obvious from the conversation, ask which it is and wait for the
answer — do not pick one and write it.

**Progress** — `### Done` / `### Remaining`.
**Decision** — `**Chose:**` / `**Over:**` / `**Because:**`.
**Research** — `### Findings` / `### Recommendation`.
**Blocker** — `**Issue:**` / `**Impact:**` / `**Options:**`.

If the scope or the understanding of the task changed materially, record that as its own
note prefixed `[scope-change]`. **Never rewrite the task description** — the description is
what was asked for; notes are what was learned.

## Step 4: No task — the snapshot trail

With no active task, or tracker `none`, there is no board to write to. Append the note to
the session trail instead, which is the record `/lets:start` reads back:

```bash
LETS_PROJECT_ROOT=$(git rev-parse --show-toplevel)
LATEST=$(ls -t "$LETS_PROJECT_ROOT/.lets/sessions/"*.md 2>/dev/null | head -1)
echo "$LATEST"
```

Append a dated `## Note` section to that file. If there is no snapshot yet, write one first
via `skill(name: "lets-session-snapshot")` with `kind=end pointer=off`, then append to the
file it returns. Tell the user the note went to the file and not to a task, and why.

## Step 5: Report

```
Note added to **{task title}** (`{task-id}`)
```

or, for Step 4:

```
Note appended to {path} — no active task, so the snapshot trail is the record.
```

---

## Response Footer

- **Uncommitted changes** → `/lets:commit` — **not built yet in this plugin.** Say so and
  suggest `git add -p && git commit`. Never point at a command that does not exist.
- **Active task, clean tree** → `/lets:note`, or `/council:check` for a review pass.
- **No active task** → `/lets:start`.

## Rules

- **Be specific.** "Fixed bug" is worthless; "fixed the null check in PaymentService.process"
  is worth writing down.
- **Record decisions with their reasoning** — the reasoning is the part that does not survive
  in the diff.
- Respond in the user's language.
