---
description: Fast 6-lens sanity check on your working changes. Inline, no subagents, ~30s. Cheap enough to fire after every few edits.
---

# check

Review the changes below through six lenses. Report at most 5 issues. Be fast.

## Target

Arguments (optional): `$ARGUMENTS` — a path to restrict to, or `--staged`, or empty for
all uncommitted work.

Changed files:
!`git diff --stat HEAD 2>/dev/null | tail -40 || echo "(no git repo or no changes)"`

Diff:
!`git diff HEAD 2>/dev/null | head -1200 || true`

If the diff is empty, say `Nothing to check — working tree is clean.` and stop. Do not
invent something to review.

If the diff was truncated at 1200 lines, say so once, and add: `too large for /check —
use /council-review`.

## The six lenses

Evaluate the diff against each, in this order:

| lens | looking for |
|---|---|
| `[Bug]` | logic errors, off-by-one, null/undefined paths, unhandled rejections, wrong operator, inverted condition, resource leaks |
| `[Sec]` | injection, missing authz check, secrets in code, unsafe deserialization, path traversal, unvalidated input crossing a trust boundary |
| `[Perf]` | N+1 queries, unbounded loops over network calls, sync I/O on a hot path, accidental O(n²), missing index on a new query |
| `[Quality]` | dead code, duplicated logic that already exists in this repo, misleading names, swallowed errors |
| `[Compliance]` | violations of this repo's `AGENTS.md` / `CLAUDE.md`, and of conventions visible in surrounding code |
| `[Docs]` | public surface changed without its doc/comment updated, stale README or changelog claim |

## Rules

- **Report only `[BLOCKER]` and `[SUGGESTION]`.** No `[NIT]`. If it wouldn't survive a
  real code review, it isn't worth your token budget or the user's attention.
- **Maximum 5 issues.** If there are more, report the 5 highest-severity and add
  `+N more — run /council-review`.
- **Zero issues is a valid and common result.** Say `No issues found.` Do not manufacture
  findings to look thorough. A fabricated finding is worse than a missed one because it
  costs the user real time to disprove.
- **Never ask the user a question.** If something is ambiguous, flag it as a finding and
  keep going. This command gets fired mid-edit; a prompt that blocks is a prompt that
  gets stopped being used.
- **Never move HEAD.** No checkout, no stash, no commit, no branch switch. Read-only
  against the working tree.
- **Do not dispatch subagents.** Not the `task` tool, not `@`-mentions, not `council()`.
  This runs inline in the current session, by design.
- Ground every finding in a real line of the diff. Cite `file:line`.

## Output

```
[BLOCKER] [Sec] src/auth/session.ts:42
  Token compared with == instead of a constant-time compare — timing oracle.
  Fix: use crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))

[SUGGESTION] [Bug] src/api/list.ts:88
  `items` can be undefined when the upstream returns 204; `.length` will throw.
  Fix: `const items = res.items ?? []`
```

Then one line: `N blockers, M suggestions.`

---

## Consistency contract with `/council-review`

Every difference between `/check` and `/council-review` must be derivable from exactly
these two facts:

1. **`/check` dispatches no subagents.** So: no skeptic verification, no cross-model
   debate, no adversarial pass, and nothing that needs more than one perspective.
2. **`/check` is fired repeatedly while writing code.** So: it never asks a question, it
   never moves HEAD, it caps output hard, and it prefers a fast miss over a slow catch.

Anything else that differs between the two is drift, not design. If you find yourself
adding a rule here that doesn't follow from (1) or (2), it belongs in
`/council-review` instead — or nowhere.
