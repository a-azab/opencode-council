---
description: Full multi-model council review — role x model fan-out, debate to convergence, independent skeptic verification, deterministic aggregation. ~1-3 min.
---

Call the `council` tool with `mode: "review"`.

If `$ARGUMENTS` names a git ref (a branch, tag, or sha), pass it as `base`. Otherwise omit
`base` so it defaults to `HEAD` (all uncommitted work).

When it returns:

- Present the summary **exactly as given**. Do not re-tier, re-word, add, or drop findings.
  Aggregation already happened deterministically; re-deciding it in prose is precisely the
  single-model judgement this design removes.
- If it reports failed nodes, say so plainly. Coverage was incomplete and the verdict is
  provisional — that is not a detail to smooth over.
- Point the user at the full report path for the attack scenarios and fixes.

Then offer, without doing it: `council({mode:"fix"})` to turn the findings into patches.
