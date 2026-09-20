# A harness scorecard beside verify: measuring the repo, not the code

**Date:** 2026-09-19 · **Status:** accepted · **Scope:** `src/harness.ts`, `src/lets.ts`,
`src/crew-org.ts`, `src/index.ts`, `command/lets:{init,plan,execute}.md`,
`command/crew:{plan,execute}.md`, `README.md`

## Context

`verify` is the only gate a `lets` item passes. It is the project's own test suite and it
answers exactly one question — *did I break anything?* — well, and nothing else at all.

That leaves a blind spot with a specific shape. An unattended run can leave every test
green and still hand the next session a worse repo: a CI workflow deleted because it was
in the way, a hook or guardrail dropped, `AGENTS.md` left describing the previous design,
a security check quietly disabled to make an item pass. None of that fails `npm test`.
None of it is visible in a diff review that is looking at the feature. And `/crew` has no
approval gate at all, so nobody is positioned to notice.

ECC (`/root/code/AI/ECC`) already solves the measurement half. `scripts/harness-audit.js`
scores a repo across 12 fixed categories — of which 7 always apply, the rest gated on
marker files — from explicit file and rule checks, versioned by rubric
(`rubric_version: 2026-05-19`) and reproducible for the same commit. It auto-detects
whether its target is the ECC repo itself or a consumer project, and it runs standalone
against any path:

```
node /root/code/AI/ECC/scripts/harness-audit.js repo --format json --root <repo>
→ {"target_mode":"consumer","rubric_version":"2026-05-19","overall_score":9,"max_score":39,…}
```

That is the same shape of thing this plugin already argues for everywhere else: a decision
computed from data rather than a model's opinion of it. The question this ADR answers is
not whether the signal is worth having — it is **what it is allowed to do**, because a
second gate that fires wrongly is worse than no second gate.

## Decision

**1. Shell out to ECC's scorer; never reimplement the rubric.** `src/harness.ts` runs
`harness-audit.js` as a child process and parses its JSON. A second copy of someone else's
rubric drifts from theirs silently, and the entire value of the number is that it is not
our judgement.

**2. Two config keys, with the `tracker` semantics.** `harness: <path|none>` and
`harness-floor: <0-100>` in the ` ```lets ` fence. Absent means init never asked; `none`
means the human declined and is never re-asked. A malformed floor fails the whole parse,
like an unknown lane — a typo that silently disables a safety gate is worse than one that
refuses to load. Resolution order is config → `$ECC_HOME` → a known default path.

**3. Compare per category, never the total.** `max_score` moves when a category becomes
applicable: adding a `fly.toml` makes Fly Integration applicable at 0/10, which lowers the
total while improving nothing and breaking nothing. Only per-category comparison survives
that — and it is also the only form that can *name* what got worse, which is what the
retry needs.

**4. Never subtract across rubric versions.** ECC rescores categories between versions, so
a drop measured across an upgrade is a measurement artefact. `comparable()` gates every
delta on `rubric_version` equality, and the report says "not comparable" rather than
producing a number it cannot stand behind.

**5. An unavailable audit is its own verdict, never a pass.** `judge()` returns
`unavailable` distinctly from `pass`. "The harness held" and "nobody looked" must stay
distinguishable — this is the same rule `/council:fix` applies when it refuses to present
an unverified patch beside a verified one.

**6. A regression fails the item, as its own state.** `harness-regressed`, not
`failed-check`. The two point at different things: `failed-check` means the code is
broken, this means the code is fine and the repo is worse. Collapsing them hides a whole
class of damage behind a label that reads as "tests failed". The retry receives the named
categories, both scores, and the scorer's own `top_actions` with their file paths — plus
an explicit instruction not to weaken a check to raise the number.

**7. Findings reach the planner as background, never as scope.** `planContext()` is
appended to the same slot as the dependency graph and says, in the prompt, not to create
work items from it. A planner that quietly expands scope to chase a score has turned the
gate into a source of unrequested work.

**8. Crew measures the integrated branch.** Per-item gating only ever sees one attempt
against the shared baseline; two tasks can each hold their ground and still add up to a
loss. Crew takes a baseline before wave 1, scores the integrated tree in the same worktree
`verify` runs in, and a regression puts **INCOMPLETE** on the report's first line. With no
approval gate, a finding further down is a finding nobody reads.

## Alternatives rejected

**Porting ECC's cross-harness portability model.** `docs/architecture/cross-harness.md` and
the adapter-compliance matrix exist so one `SKILL.md` can run on Claude, Codex, Cursor and
OpenCode. This plugin targets one harness. Porting would be cost with no corresponding
benefit, and the matrix's operating rules are aimed at a problem we do not have.

**A `/harness-audit` slash command.** Two ways to drive one thing. The same reasoning that
keeps `review-round` and `review-handoff` out of this plugin: council internals do not
become user commands just because they exist.

**Gating on the overall score alone.** Simplest to implement and wrong for the reason in
decision 3 — it fails items for becoming *more* measurable.

**Report-only, never blocking.** Considered, and rejected on the same grounds as an
unjudged acceptance: a signal nobody has to act on is a signal that gets skimmed. The
escape hatch is `harness: none`, which is a decision someone makes deliberately and once.

**Copying ECC's `eval-harness` skill as machinery.** Its concepts already exist here under
different names — capability evals are `WorkItem.acceptance`, pass@k is `MAX_ATTEMPTS`,
pass^k is the `MAX_REVIEW_CYCLES` loop. Only the vocabulary was worth adopting, so it went
into `command/lets:plan.md` as framing for reviewing acceptance criteria, and no new code.

## Risks

- **The scorer is an external checkout.** If ECC moves or breaks, every audit returns
  `unavailable`. Mitigated by design — that degrades to verify-only and says so — but a
  run can silently become less gated than the config implies. The run report always states
  which of the three states applied.
- **ECC's rubric is not ours.** A future rubric could add a category this plugin's repos
  systematically score 0 on, making the floor unreachable. The floor is per-repo and
  human-set, and rubric changes suppress deltas rather than producing false regressions.
- **Cost.** Two extra audits per run plus one per item attempt. They are filesystem checks,
  not model calls — seconds, with a 60s timeout — and the baseline is lazy so a run that
  never reaches an item never pays for it.
- **Gaming.** A worker can raise a score by weakening what is measured. The retry prompt
  forbids it explicitly, and the acceptance judge still reads the diff; neither is a
  guarantee, and this is the residual risk.

## What would make this the wrong call

If ECC's rubric turns out to change often enough that `not comparable` is the usual
outcome, the gate is measuring nothing and should be reduced to a reported number. If
`harness-regressed` retries are observed mostly re-failing rather than fixing, the
feedback is not actionable enough and the gate should stop blocking. Either would be
visible in the run reports before it needed arguing about.

## Evidence

- Unit tests: `src/harness.test.ts`, 28 tests over the parse, comparison, verdict and
  rendering rules — every rule above has a test named after the failure it prevents.
- Config round-trip and read-back: `src/lets.test.ts` (round trip, `none` vs absent, a
  floor of `0` surviving a falsy check, a nonsense floor failing the parse).
- Report honesty: `src/crew-org.test.ts` (shipped-but-degraded reads INCOMPLETE, a rubric
  change never reads as a regression, an unavailable audit is never omitted).
- End-to-end against the real scorer, 2026-09-19: a scratch repo scored 10/39, its
  `.github/` deleted, rescored 4/39 → verdict `regressed`, naming
  `Quality Gates 10→6` and `GitHub Integration 3→0`.
- That live run also found a defect: the retry feedback fell back to the scorer's overall
  `top_actions` under a heading claiming they explained the regression, when they were for
  unrelated categories. Fixed, and covered by a test.
- Full suite: 372 pass, 0 fail; `tsc --noEmit` clean.
