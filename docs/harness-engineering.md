# Harness engineering and planning

How to run a code project across many models without letting any one of them decide.

Every number here is cited to source. If the code changes and this file does not, the
citation is the bug — fix the doc against `src/`, never the other way round.

---

## The one rule

**Multi-model where a _judgement_ happens. Single-model where _work_ happens.**

Planning and review are judgements — reasonable models disagree, and the disagreement is
the signal. Writing the code is not a judgement; it is execution against a decision already
made. Fanning out execution costs N× and buys nothing, because you still have to pick one
diff.

Corollary: **the orchestrator must not be a model.** If a model reconciles other models,
you have re-created the single point of failure you paid N× to remove.

---

## Who decides what

| layer | who | what it decides |
|---|---|---|
| 1 | you | which tool to call, and whether to merge |
| 2 | plugin code | which lanes run, how findings group, how waves schedule |
| 3 | `src/decide.ts` | the verdict — **zero network calls** |

`decide.ts` is arithmetic over structured findings: `decide()`, `tally()`, `converged()`.
From its own header:

> Convergence is COMPUTED, never declared by a model.

That is the property that makes the whole thing worth running. Protect it.

---

## Staffing: two models per role, three on security

```ts
// src/roster.ts:262
export const MODELS_PER_ROLE: Partial<Record<Role, number>> = { security: 3 }
export const DEFAULT_MODELS_PER_ROLE = 2
```

Members are chosen least-loaded first, then fastest, and the roster deliberately spreads
vendors. A change to `src/auth/session.ts` staffs **9 lanes**:

```
security    3 members: fable + glm53 + kimik3     (3 vendors)
reviewer    2 members: gpt56terra + gpt56luna
code        2 members: kimik3go + gemini36
ciso        2 members: minimax + mimo
```

Roster: **18 models across 8 vendors**.

### Why vendor spread, not just model spread

A model holding both `security` and `ciso` writes the governance finding in the same voice
that just wrote the attack — the one outcome the second lane was bought to avoid. Diversity
is by **vendor**, because two models from one lab share training data, refusal behaviour and
blind spots.

---

## Planning: five lenses, five different models

```ts
// src/engine.ts:1262
export const PLANNING_ROLES = ["systems", "pragmatist", "security", "reviewer", "product"]
```

`planPanel` enforces `!used.has(x.slug)` — no model takes two lenses.

This is **five perspectives, not five opinions on one question**. Each lane proposes from
its own vantage; the merge is code, not a model.

If you want N models answering the *same* question and cross-scoring each other, that is
`council mode:'task'`, not `mode:'plan'`. Know which one you want:

- *"How should we do this?"* → `mode:'plan'` (lenses)
- *"Is this the right call?"* → `mode:'task'` (opinions, cross-scored)

---

## Debate rounds are OFF, and that is a finding

```ts
// src/engine.ts:877
export const DEFAULT_MAX_ROUNDS = 0
```

`debateRound` exists and works: members who disagree on severity see each other's positions
and re-judge, with an explicit instruction not to converge socially —

> Changing your mind when someone has a better argument is the point of this round, not a
> concession — and so is holding your position when they do not. Do not converge just to agree.

It is off by default because it did not pay:

- Huang et al. (ICLR 2024), matched budget: debate 83.2 vs self-consistency 85.3; round 2
  is *worse* than round 1.
- Measured here: **1 round, 6 re-judgements, 0 changed positions**, 74s → 212s.

`/council:*` passes `maxRounds: 2` explicitly, so the experiment keeps running where you can
see it. **Staffing is on regardless** — you lose re-judgement, not disagreement visibility.

Do not turn debate on globally until a second measurement shows positions actually move.

---

## Gates: distinguish "it held" from "nobody looked"

The single most important reliability property in this repo.

| gate | when it cannot run | why |
|---|---|---|
| harness scorecard | `unavailable` | absence of a checker is not a pass |
| `judgePanel` | `unjudged` | no judge answered ≠ approved |
| CI harness gate | exit 0 `unavailable` — but **exit 1** with no recorded floor | a missing checker is tolerable; a missing standard is not |

A panel of one is not a unanimous panel. When judges are asked and stay silent, say so:

```
1 of 1 judges confirm the objective is met (2 of 3 judge(s) did not answer)
```

Fail-open or fail-closed is decided **per gate**, never globally:

- judge outage → **open** (an outage is not a verdict)
- framework evidence missing → **closed**
- no recorded floor → **closed**

---

## The floor ratchet

```
harness-floor: 39
```

in `AGENTS.md`, enforced by `scripts/harness-gate.mjs` in CI. Score may rise; it may not
fall. A floor nothing enforces is a wish.

---

## Loop shape follows the item

`shapeFor(item, lanes)` in `src/lets.ts` — today's constants are a **floor**, risk only
escalates:

| item | attempts | judges | timeout |
|---|---|---|---|
| risky (auth, migration, k8s, payment) | 4 | 5 | 20m |
| broad (≥5 files) | 3 | 4 | 15m |
| trivial single-file cosmetic | 1 | 3 | 10m |
| default | 2 | 3 | 10m |

Two asymmetries that are deliberate:

1. **Triviality reduces attempts only, never the panel** — floor of 3 judges. "It was only a
   rename" is exactly the reasoning that lands bad work.
2. **Trivial items keep the full clock.** Halving it was tried and reverted: 90s is not
   enough to read code, edit it and run the tests (2026-08-29 incident).

Every shape carries a mandatory `why`, so the log reads *"4 attempts: touches migrations."*

---

## Recommended workflow

| stage | tool | models |
|---|---|---|
| plan | `council mode:'plan'` | 5 lenses, 5 models |
| decide a hard question | `council mode:'task'` | N, cross-scored |
| build | ECC skills + opencode `build` | 1 — execution is not a judgement |
| review | `council mode:'review'` | staffed roles, security on 3 vendors |
| gate | you | 1 human |

**ECC** supplies skills, hooks and execution. **council** supplies every multi-model
judgement. They do not overlap: ECC's agents are single-model by construction, and its
`multi-*` commands make one model the reconciler.

`lets` and `crew` are the weak parts — 1 of 6 recorded crew runs produced a commit. Prefer
`council` until that ratio improves.

---

## Verification discipline

Rules that were learned the hard way here, each from a real failure:

1. **Drive the real export, not a helper.** A guard proven by unit test was a no-op in
   production: the session registry was a module-level `Set`, registration happened in one
   process and the hook read an empty set in another. 526 tests passed because they ran both
   halves in one process — the only case never broken.
2. **Mutation-verify every load-bearing rule.** Revert the fix, confirm *exactly* the right
   test fails, restore. A rule no test defends is decoration.
3. **Check your own mutation.** A mutation that edits `return out` when the variable is
   `roots` proves nothing. Once reported as "the tests are worthless"; the tests were fine,
   the check was the bug.
4. **A declared parameter that is never fed is the same class of bug as dead code.** Deleting
   the line that *records* a failure reason left all tests green and the value permanently
   `undefined`. Assert the wiring, not just the function.
5. **Absent ≠ configured-off.** `tracker` absent and `tracker: none` mean different things.
6. **Report incomplete runs as incomplete.** Three production loops ran; two passed, one
   failed. Reporting after two was premature even though the two were real.

---

## Cost control

Fan-out is the expensive axis. Control it with routing, not by weakening panels:

- `selectRoles(files)` picks lanes from changed paths — a docs-only change does not staff
  security.
- `requiresIndependentAcceptance()` escalates on security/auth/migration/k8s/payment
  vocabulary.
- `shapeFor()` escalates attempts and judges on risk and breadth.

Escalate automatically on the risk signal, and **name the tier in the output** so the cost is
never silent.

---

## ccg-workflow

Installed at `~/.claude/bin/codeagent-wrapper` with role prompts for 7 backends including
`opencode`. Routes a task to an external CLI backend and returns a unified diff —
**read-only sandbox, no filesystem writes**.

Verified working:

```
codeagent-wrapper --lite --backend opencode "…" "$PWD"
→ WRAPPER_OK opencode-council
```

Useful for a second opinion from codex/gemini/grok/kimi. Note its shape: the calling model
reconciles the advisors' output, so it is **advisory input to a decision**, not a decision
procedure. When you need no-single-decider, use `council`.

**Removed on install:** `skills/ccg/tools/override-refusal` — a `/hi` command that rewrites
session JSONL on disk to fake model consent. Beyond the safety framing, anything that edits
transcripts retroactively destroys the audit trail every claim in this repo depends on. If
you reinstall or update ccg-workflow, delete it again:

```sh
rm -rf ~/.claude/skills/ccg/tools/override-refusal
```
