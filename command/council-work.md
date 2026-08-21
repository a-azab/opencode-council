---
description: Implement a goal autonomously in an isolated git worktree, looping until the project's own test command passes. Never touches your working tree.
---

Call the `council` tool with `mode: "work"` and `goal` set to what the user wants built.

If the user gave no goal, ask. Do not infer one.

**If the tool comes back asking which verify command to use, relay that question to the
user and wait.** Do not pick one yourself. A verify command that passes trivially would
make the loop report finished work that was never done — that is the single worst failure
this mode can have, and it is why the tool refuses to guess.

When it returns:

- **Report the branch and the counts. Nothing has been merged.** The work is in a separate
  worktree; the user reviews `git diff <branch>` and decides.
- **If it came back INCOMPLETE, say so plainly and name the item that stopped it.** Do not
  present partial work as success. The report includes the failing check output.
- Remind them to `git worktree remove` when finished, so worktrees don't accumulate.

Do not re-run it hoping for a better outcome. If an item failed twice against the project's
own tests, the third attempt is not the answer — read the failure with the user.
