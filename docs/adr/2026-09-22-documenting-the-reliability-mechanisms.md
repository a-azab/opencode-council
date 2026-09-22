# Documenting the reliability mechanisms in the README

**Date:** 2026-09-22 · **Status:** accepted · **Scope:** `README.md`

## The interview

**What do you want delivered?**
The README's `lets` section updated to describe the four reliability mechanisms added
on 2026-09-20/21, which it predates and does not mention.

**Why now?**
A first attempt at this went wrong in a way worth recording. The ADR for it asked
for a README to be *created*, without checking whether one existed. One did — 1222
lines, committed 2026-09-19. The crew run correctly reported `no-change`: the worker
found the file already present and adequate, and declined to invent work. The tool
behaved correctly and the plan was wrong.

The real gap is narrower. `README.md` describes acceptance as *"an independent
reviewer"* (singular) and says nothing about the loop guard, the carry-forward, or
the session cleanup — all of which now run on every item.

**What does done look like?**
The `lets` section of `README.md` describes, accurately:

1. **Acceptance panel** — three skeptics from three different vendors, asked
   concurrently, decided by arithmetic: any high-confidence rejection rejects, a tie
   rejects, zero votes is `unjudged` and never counts as accepted.
2. **Loop guard** — identical attempts are detected by a canonical hash chain; the
   second earns a nudge naming what was repeated, the third ends the item.
3. **Carry-forward** — a rejected attempt is debriefed by a skeptic into a bounded
   structured note, and later attempts inherit it newest-first.
4. **Session cleanup** — a successful model call deletes its session; a failed one
   keeps it, because a failed session is the only record of what went wrong.

**What is explicitly out of scope?**
No changes to `src/`. No new sections beyond the `lets` material. The README must
not claim `runLoop` is active — it exists in `src/ralph.ts` and has no caller.

## The research

Checked before writing, which is what the first attempt failed to do:

- `README.md:7` — "challenged by independent skeptics" describes the *council*, not
  `lets` acceptance.
- `grep -ci` over `README.md`: "acceptance panel" 0, "loop guard" 0, "wall clock" 0.
- `src/lets.ts` — `ACCEPTANCE_PANEL = 3`; `checkAcceptance` asks the panel
  concurrently and folds the result through `judgePanel`.
- `src/roster.ts` — `skepticPool` takes the best unused vendor per pass.
- `src/guard.ts` — `NUDGE_AT = 2`, `STOP_AT = 3`.
- `src/ralph.ts` — `collectHandoff`, `accumulatedBrief`.
- `src/engine.ts` — `disposeSession`, called only on success.

## The design

Edit the existing `lets` section in place. Every number in the new text must match
the constant in the source, because a README that drifts from the code is worse
than one that is silent — it is the document a reader trusts before they can verify
it.

## Consequences

The README stops describing a weaker system than the one that ships. The cost is
that four more numbers now have two homes, so a change to `ACCEPTANCE_PANEL`,
`NUDGE_AT` or `STOP_AT` has to be reflected here too.
