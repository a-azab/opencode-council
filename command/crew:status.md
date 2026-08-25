---
description: List this repo's live crew worktrees — branch, age, and the command to remove each. Read-only; writes nothing.
---

Call the `crew` tool with `mode: "status"` and no other arguments.

Show the result to the user as-is. It is already a finished table — one row per live crew
worktree with its branch and age, and the `git worktree remove` line for each. Do not
summarise it, and do not remove anything yourself; the removal commands are there for the
user to run once they have looked at what is in them.

This works in any git repo, including one with no crew config — a repo whose config was
never written, or was removed, is precisely where a worktree gets stranded and forgotten.
