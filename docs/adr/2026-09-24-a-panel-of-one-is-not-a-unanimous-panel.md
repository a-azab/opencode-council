# A panel of one is not a unanimous panel

**Date:** 2026-09-24 · **Status:** accepted

## Context

The first production run of `council mode:'loop'` completed, was judged, and reported:

    Confirmed independently: 1 of 1 judges confirm the objective is met

Three judges were selected. `skepticPool` returned `gpt56luna, minimax, fable`. Two never
answered, and `councilJudge` drops a judge that fails to answer - deliberately, because
counting a silent model as a vote either way would let an outage decide a completion.

But `judgePanel` could only see the votes that came BACK. "1 of 1" is arithmetically true
and reads as a unanimous panel. It was one opinion, and nothing in the artifact said so.

## Decision

`judgePanel(votes, asked)` takes how many judges were ASKED, and names the gap:

    1 of 1 judges confirm the objective is met (2 of 3 judge(s) did not answer)

Two separate rules, both kept:

- an absent judge does not vote - an outage must not decide a completion
- an absent judge is REPORTED - an outage must not silently decide how much the verdict
  is worth either

The caveat rides on rejections too. A thin panel is thin whichever way it votes.

## Consequences

`runLoop` gains `judgeCount`. Absent, it defaults to `votes.length` and the output is
unchanged - the honest reading when a caller genuinely cannot say how many it asked.

This is the same distinction the rest of the plugin already draws in three other places:
the harness reports `unavailable` rather than pass, `judgePanel` returns `unjudged` rather
than accept, and `checkAcceptance` refuses to name a judge when none ran. Every gate must
distinguish "it held" from "nobody looked" - and now also from "fewer looked than I asked".

Found only by running the thing in production. 535 tests passed with the bug present.
