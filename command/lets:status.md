---
description: Read-only orientation snapshot — where you are, what's in flight, what's next. Argless; mutates nothing.
---

A fast, read-only orientation: where you are, what is in flight, what is next. No menu, no
dialog, no mutation. Argless.

To claim a task and start working, `/lets:start`. To list stranded lets worktrees,
`/lets:worktree`.

## Step 1: Render

Invoke `skill(name: "lets-orient")`. It renders `## Where you are` / `## In flight` /
`## Next up` / `## Project`, degrading section-by-section: with no task tracker it shows
`## Where you are` and a `Tracker: none — task tracking off` line, and omits the other three
entirely rather than rendering them empty.

Show it as-is. If an argument was passed, ignore it and note once that status is a single
snapshot and takes none.

## Step 2: Footer, then stop

Then the footer below, and nothing else. **This command never claims, never mutates, and
never advises on the work itself** — it tells you where you are and names the next command.

---

## Response Footer

- **Uncommitted changes** → `/lets:commit`.
- **Active task, clean tree** → `/lets:note` to record something, or `/council:check` for a
  fast review pass.
- **No active task** → `/lets:start`.

## Rules

- Read-only — never mutate or claim from here.
- Respond in the user's language.
