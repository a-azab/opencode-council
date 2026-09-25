# SOUL

How development is done in this project. Any coding agent working here reads this first.

**Only the PROJECT block below needs editing.** Everything under it is universal — copy it
between repos unchanged.

---

## PROJECT

```
name:          opencode-council
repo:          /root/code/opencode-council
base branch:   master
verify:        npm test
harness floor: 39/39
weakest:       — (at ceiling)
stakes:        an orchestration plugin; a bad merge silently corrupts other projects' reviews
```

To fill this for a new repo, measure — never guess:

```bash
# the floor
node /root/code/AI/ECC/scripts/harness-audit.js repo --format json --root . \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['overall_score'],'/',d['max_score'])"

# the verify command — read package.json scripts. If none exists, say so and stop.
# Inventing a verify command that runs nothing is worse than admitting there is none.
```

Set `harness floor` to the **measured** number. It is a ratchet: it may rise, it may never
fall. A floor above the current score fails every run; a floor below it gates nothing.

---

## The one rule

**Multi-model where a judgement happens. Single-model where work happens.**

Planning and review are judgements — competent people disagree, and the disagreement is the
signal. Writing the code is not a judgement; it is execution against a decision already made.
Fanning out execution costs N× and buys nothing, because one diff still has to be chosen.

**Corollary: the decider must not be a model.** If a model reconciles other models, the
single point of failure you paid N× to remove is back, wearing a hat. Reconciliation is
arithmetic over structured findings, or it is a human.

---

## The loop

| stage | who | how many |
|---|---|---|
| plan | several models, different **vendors** | 3–5 |
| build | one model | 1 |
| review | roles staffed 2 deep, security 3 deep | 2–3 per role |
| verify | the command in the PROJECT block | — |
| merge | a human | 1 |

Vendor diversity, not model diversity. Two models from one lab share training data, refusal
behaviour and blind spots — that is one opinion billed twice.

A model that holds both `security` and `governance` writes the governance finding in the
same voice that just wrote the attack. Split the lanes across vendors, or the second lane
is decoration.

---

## Definition of done

A change is done when **all** of these hold. Not most.

1. `verify` passes — real output, pasted, not remembered.
2. Harness score ≥ floor, compared **per category** (see below).
3. Reviewed by models from ≥2 vendors, and their dissent is recorded even where overruled.
4. A human merged it.

Anything short of that is in progress, and gets reported as in progress.

---

## Gate semantics

**Every gate must distinguish "it held" from "nobody looked."**

| situation | correct verdict | never |
|---|---|---|
| the checker could not run | `unavailable` | `pass` |
| no reviewer answered | `unjudged` | `accepted` |
| 2 of 3 reviewers silent | `1 of 1 confirm (2 of 3 did not answer)` | `unanimous` |

A panel of one is not a unanimous panel.

Fail-open or fail-closed is decided **per gate**, never globally:

- reviewer outage → **open** (an outage is not a verdict)
- required evidence missing → **closed**
- no recorded floor to compare against → **closed**

### Comparing harness scores

- **Per category, never the total.** The maximum moves when a category becomes applicable —
  adding a deploy config scores a new category at 0, so the total drops while nothing broke.
- **Never subtract across rubric versions.** Render "not comparable" instead.
- **A new category is not a regression.**
- **A floor of 0 is falsy.** Check `typeof x === "number"`, never `if (x)`.

---

## Non-negotiables

- Never `git commit --no-verify`, `git commit -n`, or force-push the base branch.
- Never edit CI workflow files to make a failing gate pass.
- Never read, print, or commit `.env` or credential files.
- Destructive or irreversible operations need explicit human approval first.
- Never fabricate output. If a command could not run, say it could not run. A reported
  blocker is always better than an invented result.
- Fix the root cause. If a gate blocks you, the gate is probably right; removing it is not a
  fix, and neither is narrowing the task until it passes.

---

## Evidence standard

Every load-bearing claim needs a handle someone else can check: a commit SHA, a session ID,
a CI run number, a `path:line`, or a command with its real output.

> "Tests pass" is not evidence. `536 pass / 0 fail` from a run you just did is.

A subagent's summary is a **self-report, not a fact**. For anything with an external side
effect — a push, an upload, a deploy — verify the handle yourself before reporting success.

### Verification discipline

Six rules, each bought with a real failure in this repo:

1. **Drive the real thing, not a helper.** A guard proven by unit test was a no-op in
   production: its registry was module-level state, written in one process and read in
   another. All 526 tests passed because they ran both halves in one process — the only case
   that was never broken.
2. **Mutation-verify every load-bearing rule.** Revert the fix, confirm *exactly* the right
   test fails, restore it. A rule no test defends is decoration.
3. **Check your own mutation.** A mutation that edits a variable the code does not use proves
   nothing. Once reported as "these tests are worthless"; the tests were fine, the check was
   the bug.
4. **A declared parameter that is never fed is dead code.** Deleting the line that *records*
   a value left every test green and the value permanently undefined. Assert the wiring, not
   just the function.
5. **Absent ≠ configured-off.** A missing key and an explicit `none` mean different things.
6. **Report incomplete runs as incomplete.** Two of three production runs passing is not
   "it works".

---

## When stuck

Say so, with what was tried and what it returned. Do not invent plausible output, do not
substitute a fabricated result for one you could not produce, and do not quietly shrink the
task until it succeeds.
