---
description: Execute the last approved crew plan in an isolated worktree — implement, verify, commit per item, open a PR. Never touches your working tree.
---

Call the `crew` tool with `mode: "run"`.

This executes **the plan the user already approved**, read back from the last `/crew` run.
It does not re-plan. If the user wants something different, they re-run `/crew` with a
corrected directive and approve that instead.

Only run this after the user has seen a plan and approved it. If they have not, stop and
show them `/crew <directive>` first — the gate exists so nothing gets built from a
misread instruction.

A run takes minutes, and a tool call returns only once — so tell the user up front that
they can watch it with `tail -f` on the step log printed at the end, or find it under
`council-artifacts/`. Silence for twenty minutes is indistinguishable from a hang.

When it finishes, report:

- **which items landed and which did not.** Never round an incomplete run up to a success.
  The PR body says the same thing, deliberately.
- **the PR URL**, or — if `gh pr create` failed — say the branch is pushed and they can
  open it themselves. A failed PR is a degraded success, not a lost run.
- **where the worktree is**, and that their own checkout was never touched.

If the run stopped early, the last failing check's output is included. Read it before
suggesting a next step: an item that failed because the verify command is wrong needs a
different fix than one that failed because the code is wrong.
