# Who reviews security, and who covers for them

**Date:** 2026-08-28 · **Status:** accepted · **Scope:** `src/roster.ts`, `src/engine.ts`, `src/lets.ts`

## Decision

The `security` lane is held by **`fable`, `kimik3` and `glm53`** — the security-minded
models — rather than by whichever generalists measured most reliable. `opus5` and
`gpt56sol` come off the lane.

Failover gains **named understudies**: `Member.fallback` names the model that covers a
lane when its holder drops, and `substitutesFor` offers it ahead of the availability tiers.
`fable` → `opus5`, `kimik3` → `kimik3go`, `kimik3go` → `gpt56sol`.

## Why the panel changed

The owner's call, and the reasoning is about fit rather than reliability: a security review
is specialist work, and the lane should go to models chosen for it. `fable` was already
pinned `essential` to the lane, so it can never be crowded out by a roster change.

## Why named covers, when failover already worked

The existing tiers rank by availability — free before busy, carries-the-role before not.
That is the right default when nobody has an opinion and the wrong answer when someone does.

The measurement made the case better than the argument: with `fable`'s cover removed, its
security lane falls to **`kimik3go` — a model already in that round holding two lanes**. The
availability sort had no way to prefer a chosen model over a stretched one. The named cover
replaces a doubled model with a deliberate one.

Three properties, each deliberate:

- **It leads even when busy.** A chosen cover holding two lanes in an already-degraded round
  beats the lane going to a model nobody picked, and the report names stand-ins that were
  answering elsewhere, so the correlation stays visible.
- **It is a preference, not a dependency.** If the specialist *and* its understudy are both
  down, the lane fills from the ordinary tiers. Losing a lane because the second choice also
  failed would be worse than the default it replaced.
- **The list is deduped.** A named cover also qualifies for its availability tier; a repeat
  would burn a `MAX_SUBSTITUTIONS` attempt retrying a model that had just failed.

## Why two lanes gained a third carrier

Putting `glm53` and `kimik3` on `security` created double-assignment, measured before the
fix: `glm53 = security + infrastructure` on a terraform diff, `kimik3go = security + code`
on auth code. One model producing two "independent" opinions, on exactly the paths where
security matters most.

The cause is structural rather than about the picks. **A lane whose carrier count equals its
cap runs all of them, every time** — so any model holding such a lane plus security was
guaranteed to hold both. `infrastructure` and `code` each had two carriers against a cap of
two. Giving them a third (`gpt56sol`, `gemini36`) lets the least-used sort route around
whoever security already took. Verified clean across `.tf`, migrations, auth, `.env` and
ordinary source; the guard is mutation-checked.

## Why the kimi routing is what it is

`kimi-for-coding/k3` and `opencode-go/kimi-k3` are one model behind two billing routes, so
a spent quota should fall through to the same model on a route with budget, not to a
different vendor. `kimik3go` therefore sits directly behind `kimik3` in both
`LETS_INTAKE_MODELS` and `LETS_IMPLEMENT_MODELS`, which previously ended at the coding plan
and simply ran out when its quota tripped.

**The coding plan does not hold the `code` lane, and cannot.** `kimik3` is the slowest member
of the roster at 21151ms, and `selectNodes` sorts carriers by latency — so on any lane with
more carriers than its cap it is never selected. It holds `security` only because that lane
has exactly three carriers against a cap of three, so all three run regardless of speed.

Making the go route fallback-only *would* put the coding plan on `code` — and would then
have `kimik3` holding both `code` and `security`, reviewing auth files twice. That trade was
put to the owner explicitly and declined: one opinion presented as two is worse than the go
route doing code review.

## Consequences

- The two models that reported 4/4 in every review round no longer review security. Some
  reliability traded for fit; `fable`'s essential pin bounds the risk.
- `kimik3` was at its weekly limit when last measured (2026-08-28). The first security-path
  review will exercise the fallback for real, and the substitution will be **named in the
  report** rather than passed off silently.
- `gemini36` joins `code` and `gpt56sol` joins `infrastructure` purely to break the
  carriers-equals-cap lock. Neither was chosen for the lane on merit, and both should be
  revisited if a better carrier appears.
