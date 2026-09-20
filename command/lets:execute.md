---
description: Execute the last approved lets plan in an isolated worktree — implement, verify, commit per item, open a PR. Never touches your working tree.
---

Call the `lets` tool with `mode: "run"`.

This executes **the plan the user already approved**, read back from the last `/lets:plan` run.
It does not re-plan. If the user wants something different, they re-run `/lets:plan` with a
corrected directive and approve that instead.

Only run this after the user has seen a plan and approved it. If they have not, stop and
show them `/lets:plan <directive>` first — the gate exists so nothing gets built from a
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

## The harness gate

When this repo has a harness scorer configured, each item passes **two** deterministic
gates: `verify` (nothing broke) and the scorecard (the repo is not measurably worse). An
item whose state is `harness-regressed` passed the project's own checks — the code is
fine, the repo got worse — and was retried with the regressed categories and the scorer's
file paths as the brief.

Report the `## Harness` section as given. Three states, and they must not be blurred:

- **a delta with no regression** — the gate ran and held
- **`not comparable`** — ECC's rubric version changed between the two measurements, so no
  delta is claimed. This is not a pass and not a failure; it is an unmeasurable interval.
- **the scorer did not run cleanly** — nobody looked. Never report this as the gate holding.

If an item is stuck on `harness-regressed`, the fix is to restore what the change removed,
never to lower `harness-floor` or weaken a check to make the number go up. If the user
wants the gate off, that is `harness: none` via `/lets:init`, as a deliberate decision.
