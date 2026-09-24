---
name: Feature request
about: Propose a new capability or a change to how a command behaves
title: '[feat] '
labels: enhancement
assignees: ''
---

## The problem

<!-- What are you actually trying to do, and where does the current tooling stop
     you? Describe the situation, not your proposed solution. -->

## Why the current commands do not cover it

<!-- Which command did you reach for, and what did it do instead? -->

## Proposed behaviour

<!-- What should happen. Be concrete: name the command, the flags, and the
     output you would expect. -->

Surface this belongs to:

- [ ] `lets` — session lifecycle (init / plan / run / status)
- [ ] `crew` — spawned sessions and orchestration
- [ ] `council` — role x model fan-out, aggregation, convergence
- [ ] New namespace / cross-cutting
- [ ] Docs, agents, commands, or skills definitions

Sketch of the interaction:

```
$ <command you would run>
<output you would expect>
```

## Safety and determinism

This is an agentic harness that writes to real repositories. Address these:

- Does it write to the repo, and if so what is the human confirmation step?
- Can it be undone, and how?
- Does it affect aggregation or ranking? If so, is it still deterministic —
  same inputs, same ordering, no answer or dissent silently dropped?
- Should it refuse in any state (dirty tree, non-git directory, no approved
  plan, unknown tracker)?

## Scope

- [ ] Additive — existing commands and artifact shapes keep working unchanged
- [ ] Changes existing behaviour (describe the migration below)

<!-- If it changes behaviour, what breaks for people mid-session? -->

## Alternatives considered

<!-- Including doing it manually outside the plugin. Why is that not enough? -->

## How we would know it works

<!-- What test would fail today and pass once this exists? -->

## Anything else

<!-- Prior art in other harnesses, links to related issues, willingness to
     implement it yourself. -->
