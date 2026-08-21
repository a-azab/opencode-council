---
description: Inspect this repo and record its crew config — verify command, PR base, review lanes. Run once per repo before /crew.
---

Call the `crew` tool with `mode: "init"` and no other arguments.

Show the proposal to the user verbatim. It is a proposal, not a decision — do not write
anything yet.

Then resolve, in this order, asking only about what is genuinely ambiguous:

1. **Verify** — if exactly one candidate was found, say you are taking it. If several, ask
   which. If none, you must ask; a crew with no verify command has no way to know when the
   work is done, and guessing one that passes trivially is the worst outcome available.
2. **Base** — if more than one candidate came back, ask. `origin/HEAD` frequently disagrees
   with the branch a team actually merges to, and a wrong base makes every PR wrong.
3. **Lanes** — state the proposal and invite edits. Do not interrogate; the list is
   derived from the repo's own file mix and is usually right.
4. **Graph** — if it is missing or stale, offer to run
   `graphify extract . --code-only --max-workers 16` (local tree-sitter AST, no LLM calls,
   seconds even on a large repo). Do not plan against a stale graph.

Once the user has confirmed, call `crew` again with `write: true` and the confirmed
`verify`, `base` and `lanes`.

Report which files changed. Only two ever do: the `crew` fenced block in `AGENTS.md`, and
`.git/info/exclude` — which is per-clone and never committed, so nothing here reaches the
user's team.
