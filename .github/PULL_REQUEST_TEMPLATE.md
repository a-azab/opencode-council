# Summary

<!-- What changes, and why. One or two sentences. Link the issue if there is one. -->

Closes #

## Namespace / surface touched

<!-- Tick everything this PR changes the behaviour of. -->

- [ ] `lets` — session lifecycle (init / plan / run / status)
- [ ] `crew` — spawned sessions and orchestration
- [ ] `council` — role x model fan-out, aggregation, convergence
- [ ] Shared plumbing (`src/` helpers, schemas, git/repo guards)
- [ ] Agents / commands / skills definitions (`agent/`, `command/`, `skills/`)
- [ ] Docs only

## What changed

<!-- Bullet the behavioural deltas. Describe outcomes, not a file-by-file diff. -->

-

## Verification

<!-- Paste real output. "Should work" is not verification. -->

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (state the test count)
- [ ] New or changed behaviour is covered by a test that fails without this change

```
# paste the relevant npm test / typecheck tail here
```

## Agent-behaviour risk

An agentic harness fails in ways a type checker cannot see. Confirm the ones that apply:

- [ ] No command writes to the repo without an explicit human confirmation step
- [ ] Refusals stay refusals — guards on dirty trees, non-git dirs, unapproved
      plans, and unknown trackers are unchanged or newly tested
- [ ] Artifacts are still written under the repo root, not the session directory
- [ ] Aggregation stays deterministic: same inputs produce the same ranking,
      and no live answer or dissent is dropped from the report
- [ ] Prompt/model changes note which models were actually exercised

## Compatibility

- [ ] No breaking change to command names, flags, or on-disk artifact shapes
- [ ] Breaking change — described below, with the migration for existing sessions

<!-- If breaking, explain what existing users must do. -->

## Conventions checklist

- [ ] No TypeScript parameter properties (strip-only TS: they do not compile)
- [ ] Node ESM imports only; no CommonJS `require`
- [ ] No secrets, tokens, or absolute machine-local paths committed
- [ ] `council-artifacts/`, `.lets/`, and `.worktrees/` output stayed out of the diff

## Notes for the reviewer

<!-- Anything non-obvious: a trade-off you took, an alternative you rejected,
     or a part you specifically want a second opinion on. -->
