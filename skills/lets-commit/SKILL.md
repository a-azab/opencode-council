---
name: lets-commit
description: Commit reviewed changes with a conventional message linked to the active lets task. Invoked by /lets:commit, and preferred over any generic commit skill in a lets repo. Never stages with `git add -A` or `git add .`; always confirms before committing.
---

# Commit

Stage what was reviewed, write a message this repo would recognise, link the active task,
and **confirm before committing**.

A bare `git commit` skips all four. This skill is the one place that does them, so an
explicit `/lets:commit` and a plain "commit this" produce the same commit.

## Step 1: What changed

```bash
git status --short
git diff --stat
```

Nothing changed → say so and stop. There is no empty commit to make here.

## Step 2: The active task

Invoke `skill(name: "lets-detect-task")`.

- **One id** → link it.
- **Several candidates** → ask which, offering **None** as an option. Do not pick for them.
- **None** → **commit without a link.** This is a correct outcome, not a failure: an ad-hoc
  `chore:` commit does not need a task and must not be blocked waiting for one.

## Step 3: Read the diff

```bash
git diff              # unstaged
git diff --staged     # already curated, if anything is
```

Summarise per file: what changed, and why. That summary is what the user is about to
approve, so it has to describe the actual diff rather than the intent you started with.

## Step 4: Match this repo's convention — do not impose one

```bash
git log -20 --format='%s'
```

**Read them and match the dominant shape.** Conventional `<type>: <description>` is the
floor; *where the task id goes* is a per-repo fact, and the log is the only place it is
recorded:

- this repo puts the subsystem in the scope and no id — `feat(lets): the session spine`
- `oci-infrastructure` puts the id in the subject as a trailing tag —
  `fix: pin config_file_profile in all remaining root modules (bd 50o)`
- LETS's own default is a task-id scope plus a `Task:` footer — `feat(lets-abc): ...`

All three are right in their own repo. Pick the one the log shows and put the task id in
**that** position. A commit that announces a new convention is noise in `git log --oneline`
forever.

> **This is the port's one deliberate divergence.** LETS hardcodes `<type>($TASK_ID): <desc>`
> plus a `Task:` footer because it ships alongside its own repo conventions. This plugin gets
> dropped into repos that already have one, so the log wins over the template.

**Types:** `feat` `fix` `refactor` `docs` `chore` `test`.

Subject under ~50 chars, imperative mood ("Add", not "Added"). The body explains **why** —
the diff already shows what. Bad subjects: `update stuff`, `fix bug`, `WIP`.

## Step 5: Confirm — never skip this

Present the proposal as plain text, **not** inside a code block (a fenced block reads as
something to copy, not something to approve):

`<type>: <description>`
- {file} — {what changed}
- {file} — {what changed}

Then call the **`question`** tool:

- question: `Commit with this message?`
- options: **Commit** — "Stage the reviewed files (or keep the staged set) and commit" /
  **Cancel** — "Don't commit, leave the working tree exactly as it is"

Handle the answer:

- **Commit** → Step 6.
- **Cancel** → stop, and change nothing. Do not stage "so it's ready" — that is a state the
  user did not ask for and did not see.
- **Free text** → treat it as an **edited commit message** and go to Step 6 with it. They
  rewrote the subject instead of picking an option; that is approval with a correction
  attached, not a refusal.

> The confirmation is the contract, not a formality. Never commit on an inferred yes.

## Step 6: Stage, and only what was reviewed

**NEVER `git add -A`. NEVER `git add .`.** Both sweep in whatever else happens to be in the
tree — unrelated edits, build output, untracked cruft, `.env` files and private keys — and
both **clobber a staged set someone curated on purpose**. There is no case in this skill
where either is the right command.

The already-staged set wins:

```bash
git diff --staged --quiet && echo NOTHING_STAGED || echo STAGED_OK
```

- **`STAGED_OK`** → someone curated this. Do **not** run `git add`. Commit exactly what is
  staged, nothing more.
- **`NOTHING_STAGED`** → stage the files reviewed in Step 3, **by name**:

  ```bash
  git add <reviewed-file-1> <reviewed-file-2>
  ```

Then verify, commit, verify:

```bash
git status          # is the staged set exactly what was approved?
git commit -m "<subject in the shape Step 4 found>"
git status          # clean now?
```

A multi-paragraph body goes to a file and commits with `git commit -F <file>` rather than
stacked `-m` flags — same reason `/lets:note` submits with `--file`: the markdown survives.

## Step 7: What is left

With an active task **and** a beads tracker:

```bash
bd show <task-id> --json
```

Compare what just landed against the task's description. Two or three lines, no more:

```
Committed: {what this commit covers}
Remaining: {what is left, or "nothing — task scope complete"}
```

**No task, or tracker `none`:** skip this step entirely. Do not render an empty `Remaining:`
line, and do not infer the task's scope from the diff you just wrote.

## Step 8: Report

```
Committed `{short-sha}` {subject}
  {X} file(s) changed, {Y} insertion(s), {Z} deletion(s)
  Task: {`{id}` linked | none — ad-hoc commit}
```

---

## Response Footer

- **Task scope complete** → `/lets:done` to push, open the PR, and close the task.
- **Work remains, clean tree** → `/lets:note` to record a decision, or `/council:check` for a
  fast review pass.
- **Files still uncommitted** (a deliberate partial commit) → `/lets:commit` again for the rest.
- **No active task** → `/lets:start`.

`/lets:end` is **not** the move after a commit — it ends a session, not a task. Session end
fires when the user says so.

## Rules

- **Never commit without confirmation.**
- **Never `git add -A` or `git add .`.**
- `git status` before **and** after — the second one is how you know the commit took.
- A missing task is not an error. Commit without the link and say so in the report.
- Any id crossing a `bd` verb must match `^[A-Za-z0-9._-]+$` and must not start with `-`, or
  `bd` reads it as an option (`src/beads.ts:safeId` enforces the same rule at the call site).
- Respond in the user's language.

## Not ported

- **`.claude/rules/git.md`** — LETS cites it for the staging rule. There is no equivalent
  file here, so Step 6 writes the rule out rather than pointing at something that does not
  exist.
- **`/lets:check`** — LETS's Cancel path and its "work remains" box both name it. It is not
  in this plugin; the footer points at `/council:check`, which is this plugin's fast review
  pass.
