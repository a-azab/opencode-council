# evals/

Behavioural fixtures for the harness's own invariants.

## What an eval fixture is here

The unit tests in `src/*.test.ts` check that a function returns what it returns. These
fixtures record something narrower and longer-lived: the **invariants that must not be
refactored away**, as data, with the reason they exist.

Every invariant in this directory was paid for. Each one is either a failure that was
observed in a real run and then fixed, or an asymmetry that was chosen deliberately
because the two directions of being wrong cost different amounts. The fixture keeps the
*reason* attached to the *rule*, so that a future change that looks locally sensible —
"surely a panel with no votes is just a panel that agreed" — has to argue with the
recorded cost of that exact mistake before it lands.

They are plain JSON. No runner is required and none is wired into `npm test`: the fixtures
are not a second test suite, they are the specification the suite is checked against. They
are readable by a human, by a judge model asked whether a diff violates an invariant, and
by any future harness that wants to execute them.

**These files are deliberately not named `*.test.ts` or `*.test.js`.** `npm test` runs
`node --test src/*.test.ts`; naming a fixture into that glob would make the data
executable by accident.

## The invariants recorded here

| Fixture | Subject | The rule in one line |
|---|---|---|
| [`acceptance-panel-unjudged.eval.json`](acceptance-panel-unjudged.eval.json) | `judgePanel` (`src/ralph.ts`) | Nobody looked is never the same as verified. |
| [`capability-vs-moment.eval.json`](capability-vs-moment.eval.json) | `measuresCapability` (`src/catalog.ts`) | A provider 500 is a fact about the world, not about the model. |
| [`probe-timeout-measures-clock.eval.json`](probe-timeout-measures-clock.eval.json) | `probe` (`src/catalog.ts`) | A probe that hit the ceiling measured the clock. |
| [`judge-evidence-attachment.eval.json`](judge-evidence-attachment.eval.json) | `evidencePaths` (`src/lets.ts`) | A judge asked to prove a claim must be shown the material. |

The thread common to all four: **absence of evidence is never recorded as evidence of
absence.** A missing vote, a failed call, an expired clock, and an unshown file are all
moments where the system knows less than it appears to, and in every one of them the
harness is required to say so rather than round it into a verdict.

## Fixture shape

```jsonc
{
  "id": "kebab-case-id",              // unique; matches the filename stem
  "title": "One line, the rule itself",
  "subject": {
    "file": "src/ralph.ts",           // real path, real exported name
    "function": "judgePanel"
  },
  "invariant": "The rule, stated so a violation is decidable.",
  "why": "What it cost to learn. Dates and model names where they were measured.",
  "cases": [
    {
      "name": "what this case pins down",
      "given": { },                   // input, as the function actually takes it
      "expect": { },                  // the observable outcome, field by field
      "must_not": "the plausible wrong answer this case exists to forbid"
    }
  ],
  "regression_signature": "What a violating diff would look like."
}
```

## Adding one

1. **Start from a real failure or a real asymmetry.** If you cannot say what being wrong
   costs in each direction, it is a unit test, not an eval fixture — put it in
   `src/*.test.ts`.
2. **Read the function first.** `subject.file` and `subject.function` must name code that
   exists; `given` must be the shape the function actually accepts. A fixture that
   describes an imagined signature is worse than no fixture, because it will be believed.
3. **Write `must_not`.** The wrong answer is the point. An invariant nobody would
   plausibly violate does not need recording.
4. **Keep `why` specific.** "Safety" is not a reason. "Measured 2026-09-23: two models
   would have been permanently retired for a five-hour quota window" is.
5. Name it `<id>.eval.json` and add a row to the table above.

## Verifying a fixture still matches the code

The fixtures carry no runner, so they are checked by reading. Each `subject` names a real
exported function; the fastest confirmation is to read that function and the unit tests
that already cover it:

```sh
# the panel's zero-vote branch and the test that pins it
sed -n '98,130p' src/ralph.ts
node --test src/ralph.test.ts

# the capability/moment split
sed -n '317,376p' src/catalog.ts
node --test src/catalog.test.ts

# evidence attachment
sed -n '1658,1693p' src/lets.ts
node --test src/lets.test.ts
```

If a fixture and the code disagree, one of them is a bug. Decide which before changing
either — that decision is the whole value of writing the invariant down.
