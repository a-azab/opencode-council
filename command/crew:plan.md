---
description: Take a directive through intake to an approved plan — CPO outcomes, CTO work items grounded in the codebase graph. Stops at the gate; writes no code.
---

Call the `crew` tool with `mode: "plan"` and `directive` set to what the user asked for,
verbatim. Do not paraphrase the directive or resolve its ambiguities yourself — the CPO
lane is built to surface them, and pre-resolving robs the user of the chance to correct.

Show the returned gate to the user as-is.

Then stop. **Nothing has been written and nothing will be until the user approves.** If the
plan is wrong, they say so and you re-run `plan` with a corrected directive.

Things worth pointing out if the gate shows them:

- **A lane that did not answer** — the plan is missing that lane's judgement. Say the plan
  is incomplete, not that it is simple.
- **An item with no predicted files** — usually means the item is too vague to implement,
  or the knowledge graph is missing. Worth fixing before approving.
- **A stale or missing graph** — offer `graphify extract . --code-only --max-workers 16`.
  It is local tree-sitter AST, no LLM calls, and takes seconds. Planning against a stale
  graph is worse than planning against none: it is confidently wrong.

If the repo has no crew config, the tool says so — run `/crew:init` first.
