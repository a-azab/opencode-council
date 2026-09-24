---
name: Bug report
about: A command misbehaves, refuses wrongly, writes the wrong thing, or crashes
title: '[bug] '
labels: bug
assignees: ''
---

## What happened

<!-- One or two sentences describing the wrong behaviour. -->

## What you expected instead

<!-- The behaviour you believed was correct, and why. -->

## Which surface

- [ ] `lets` — session lifecycle (init / plan / run / status)
- [ ] `crew` — spawned sessions and orchestration
- [ ] `council` — role x model fan-out, aggregation, convergence
- [ ] Installation / plugin loading
- [ ] Not sure

Command you ran:

```
# e.g. lets:plan, council:run ...
```

## Reproduction

Steps, starting from a known state:

1.
2.
3.

Repo state when it happened:

- [ ] Clean git tree
- [ ] Dirty git tree (uncommitted changes)
- [ ] Not a git repository
- [ ] Freshly initialised (`lets:init` had not been run / had just been run)

## Output

<!-- Paste the actual terminal output or error. Redact tokens, API keys, and
     anything client-confidential before pasting. -->

```
```

If it produced artifacts, say which and what was wrong with them
(e.g. `council-artifacts/<run>/report.md` dropped a dissent, ranking was
non-deterministic across two identical runs, files landed in the session
directory instead of the repo root):

```
```

## Severity

- [ ] Data loss — wrote, overwrote, or deleted files without confirmation
- [ ] Wrong result — ran and produced an incorrect report or plan
- [ ] Wrong refusal — blocked something that should have been allowed
- [ ] Crash or hang
- [ ] Cosmetic / wording

## Environment

- opencode-council version or commit:
- opencode version:
- Node version (`node -v`):
- OS:
- Models involved (if a `council` run):

## Anything else

<!-- Does it reproduce every time or intermittently? Did it work before a
     particular change? Any workaround you found? -->
