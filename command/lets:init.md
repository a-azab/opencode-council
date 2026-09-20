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

5. **Tracking** — if the proposal says it is not recorded, **ask**, via the **`question`**
   tool. Do not infer an answer and do not skip it:

   - question: `Mirror runs into a tracker?`
   - options: one per tracker the proposal listed, **in the order it listed them** — the
     recommended one is first and its description says so. Always include **none**.
     - **beads** — "Recommended. Local task database, already set up in this repo — no
       token, no server, nothing leaves the machine."
     - **none** — "Runs report to the terminal only. A real answer, and it stops the
       question coming back."
     - **mcp** / **linear** — as the proposal described them.

   Offer only what the proposal lists as available: it has already checked the token, the
   server and the `.beads/` directory, so anything it left out cannot be honoured and
   offering it would promise mirroring that silently never happens.

   If the proposal says `beads` is not on offer because `bd` is installed but this repo has
   no `.beads/`, pass that on — including that `bd init` is theirs to run. **Do not run
   `bd init`.** Creating a task database in someone's repo uninvited is the same overreach
   as creating issues in their workspace: worse than one question.

   Never enable a tracker they did not ask for.

6. **Harness scorecard** — the proposal reports whether an ECC checkout was found (via the
   `harness:` key, then `$ECC_HOME`, then the default path) and, if so, this repo's score
   right now with its weakest categories and the scorer's own top actions.

   - If a score came back, it proposes **today's percentage as the floor**. State it and
     invite a correction. It is a floor, not a target: nothing has to improve, but a run
     that drops a category below where it started fails that item and retries it with the
     scorer's named findings as the brief. This is a second deterministic gate alongside
     `verify` — `verify` says nothing broke, this says the repo is not measurably worse to
     hand to the next unattended session.
   - If the user does not want it, pass `harness: "none"`. That is a recorded decision and
     is never re-asked, exactly like `tracker: none`.
   - If no checkout was found, say so plainly and move on. Verify-only is a real answer,
     not a degraded one. Do not go looking for ECC or offer to install it.
   - **Never propose a floor from a score that could not be measured.** If the audit failed
     to run, the proposal says why; carry that through rather than guessing a number.

Once the user has confirmed, call `lets` again with `write: true` and the confirmed
`verify`, `base`, `lanes`, `tracker`, and — when they accepted one — `harness` and
`harnessFloor`.

Report which files changed. Only two ever do: the `lets` fenced block in `AGENTS.md`, and
`.git/info/exclude` — which is per-clone and never committed, so nothing here reaches the
user's team.
