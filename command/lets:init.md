---
description: Inspect this repo and record its lets config — verify command, PR base, review lanes. Run once per repo before /lets:plan.
---

Call the `lets` tool with `mode: "init"` and no other arguments.

Show the proposal to the user verbatim. It is a proposal, not a decision — do not write
anything yet.

Then resolve, in this order, asking only about what is genuinely ambiguous:

1. **Verify** — if exactly one candidate was found, say you are taking it. If several, ask
   which. If none, you must ask; a lets run with no verify command has no way to know when the
   work is done, and guessing one that passes trivially is the worst outcome available.
2. **Base** — if more than one candidate came back, ask. `origin/HEAD` frequently disagrees
   with the branch a team actually merges to, and a wrong base makes every PR wrong.
3. **Lanes** — state the proposal and invite edits. Do not interrogate; the list is
   derived from the repo's own file mix and is usually right.
4. **Graph** — if it is missing or stale, offer to run
   `graphify extract . --code-only --max-workers 16` (local tree-sitter AST, no LLM calls,
   seconds even on a large repo). Do not plan against a stale graph.

5. **Tracking** — if the proposal says it is not recorded, ask once whether runs should be
   mirrored anywhere. Offer only what the proposal lists as available; do not offer Linear
   if it is not there, since that needs `LINEAR_API_TOKEN`. If the user says no, record
   `none` — that is a real answer and stops the question coming back. Never enable a
   tracker they did not ask for: creating issues in someone's workspace uninvited is worse
   than one question.

Once the user has confirmed, call `lets` again with `write: true` and the confirmed
`verify`, `base`, `lanes` and `tracker`.

Report which files changed. Only two ever do: the `lets` fenced block in `AGENTS.md`, and
`.git/info/exclude` — which is per-clone and never committed, so nothing here reaches the
user's team.
