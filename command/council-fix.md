---
description: Turn the last council review's findings into reviewable patches. Generates diffs only — applies nothing.
---

Call the `council` tool with `mode: "fix"`.

This proposes patches for the findings the last review kept. Each is produced by the model
that raised the finding, since it already has the context.

**Nothing is applied.** The tool writes `patches.md` and stops. That is deliberate: the
only writer is the user, via `git apply` on hunks they have read (D5).

When it returns:

- Report how many patches are ready and how many need a decision.
- Do **not** apply anything, and do not offer to apply everything at once. Ask which the
  user wants, and apply only those.
- Patches marked as needing a decision are not failures — the fixer declined to guess where
  the right fix depends on intent it was not given. Surface the question, don't paper over it.
- After applying anything, suggest re-running `/council-review` to confirm the finding is
  gone and nothing regressed. Verification of a fix is a fresh review, not a claim.
