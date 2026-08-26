---
description: Start a work session — restore context from the last snapshots, orient, then claim a task and cut its branch. Supports a task id, or --continue to resume the one in progress.
---

Restore context, then take a task. **No work starts without a selected task.**

## Usage

```
/lets:start                # full flow — recent snapshots, orient, pick a task
/lets:start <task-id>      # jump straight to a task
/lets:start --continue     # resume the single in_progress task
```

## Step 0: Arguments

**`<task-id>` given** — authoritative. Skip Steps 1 and 3. Run Step 2 briefly, read the task
in full (`bd show <id> --json`, and its comments — never truncate a description you are
about to work from), then go to Step 5.

**`--continue`** — run Step 1, it is the context recovery this flag exists for. Then
`bd list --status in_progress --json`. Exactly one → use it, skip Step 4. Several → show them
and ask. None → fall through to the full flow.

**No arguments** — the full flow below.

## Step 1: Previous session context

```bash
LETS_PROJECT_ROOT=$(git rev-parse --show-toplevel)
BRANCH=$(git branch --show-current); BRANCH_SLUG=$(echo "$BRANCH" | tr '/' '-')
mkdir -p "$LETS_PROJECT_ROOT/.lets/sessions"

TASK_ID=$(sed -n 's/^task: //p' "$LETS_PROJECT_ROOT/.lets/sessions/.task-${BRANCH_SLUG}" 2>/dev/null | head -1)
SESSIONS=""
[ -n "$TASK_ID" ] && SESSIONS=$(ls -t "$LETS_PROJECT_ROOT/.lets/sessions/"*"-${TASK_ID}-snapshot"*.md 2>/dev/null | head -3)
[ -z "$SESSIONS" ] && SESSIONS=$(ls -t "$LETS_PROJECT_ROOT/.lets/sessions/"*"-${BRANCH_SLUG}"*.md 2>/dev/null | head -3)
[ -z "$SESSIONS" ] && SESSIONS=$(ls -t "$LETS_PROJECT_ROOT/.lets/sessions/"*.md 2>/dev/null | head -3)
echo "$SESSIONS"
```

**Read each file found** (up to 3, in parallel). Summarise them compactly: what was done, what
was decided, what the `NEXT:` line said. This is the context that survived the last session —
it is the reason this command exists, so do not skip it because the list looks short.

Nothing found is normal on a first run. Say so in one line and continue.

## Step 2: Git state

```bash
git branch --show-current
git status --short
git rev-parse --verify --quiet HEAD >/dev/null && git log --oneline -3 || echo "(no commits yet — fresh repo)"
```

Report branch, uncommitted changes, recent commits. **A repo with no commits is fine** — say
so plainly, do not treat it as an error and do not send the user to `/lets:init` over it.

**If there are uncommitted changes, ask what to do with them before cutting a branch.** They
follow you across a checkout and end up in the wrong task's diff.

## Step 3: Orient

Invoke `skill(name: "lets-orient")`. It renders Where you are / In flight / Next up /
Project, degrading to just Where you are when no tracker is present. Show it as-is — do not
re-summarise In flight and Next up underneath it.

## Step 4: Pick the task

From the snapshot, offer the moves:

> - **Resume** the active task, if In flight shows one worth continuing.
> - **Pick** one from Next up.
> - **Create** one — describe the work and it becomes a task.

**Then wait.** The user selects, names, or describes. If they describe work instead of
picking ("just want to fix the proxy config"), create the task for them rather than making
them stop and file it:

```bash
bd create -d "Fix proxy config" --acceptance "<what proves it done>"
```

Tell them the id you created. That keeps traceability without turning it into paperwork.

**Tracker `none`:** there is no board to pick from. Ask what they are working on, take the
answer as the session's subject, and carry on branchless or on a branch they name. Say in one
line that nothing is being tracked, so the snapshot file is the only record.

## Step 5: Claim it and cut the branch

```bash
bd update <task-id> --claim
```

`--claim` is atomic and idempotent — it sets the assignee and moves the task to in_progress in
one step. Prefer it over `--status in_progress`, which two sessions can both "succeed" at.

Then cut the branch from the configured base (the `base:` line in the ```lets block of
`AGENTS.md`), unless already on the right branch:

```bash
git checkout <base> && git pull --ff-only 2>/dev/null
git checkout -b feature/<task-id>-<short-slug>
```

Slug: lowercase, dash-separated, the 2–4 most distinctive words of the title. **Every branch
maps to exactly one task.**

Record the pointer, so a branch whose name loses the id can still be resolved:

```bash
LETS_PROJECT_ROOT=$(git rev-parse --show-toplevel)
BRANCH_SLUG=$(git branch --show-current | tr '/' '-')
mkdir -p "$LETS_PROJECT_ROOT/.lets/sessions"
printf 'task: %s\nstart: %s\n' "<task-id>" "$(git rev-parse HEAD)" \
  > "$LETS_PROJECT_ROOT/.lets/sessions/.task-${BRANCH_SLUG}"
```

`start:` is the session boundary — the commit this session began at. `/lets:end` reads it to
count what happened; nothing else writes it.

## Step 6: Report

```
## Recent sessions
{1–2 line recovery, or "no previous snapshots"}

{the orient snapshot from Step 3}

**Working on:** **{task title}** (`{task-id}`) on `{branch}`
```

Then the footer.

---

## Response Footer

End by naming the next command, chosen by state:

- **Uncommitted changes** → `/lets:commit` — **not built yet in this plugin.** Say that
  outright and suggest `git add -p && git commit` instead. Never point at a command that
  does not exist.
- **Active task, clean tree** → `/lets:note` to record something, or `/council:check` for a
  fast review pass.
- **No active task** → `/lets:start`.

## Rules

- **Never start work without a selected task** — auto-creating one counts.
- If a previous session left work in progress, surface it rather than starting fresh over it.
- If the user is already on the correct feature branch, skip branch creation.
- Respond in the user's language.
