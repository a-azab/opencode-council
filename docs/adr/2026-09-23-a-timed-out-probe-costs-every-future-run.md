# A probe that timed out is never recorded, so every run pays for it again

## Status

Proposed — 2026-09-23

## Context

`e1c869a` stopped `probe()` writing its own 60-second ceiling to the capability
cache as `ok: false`. That fix is right: a timeout measures the clock, not the
model, and a recorded `ok: false` is permanent in the sense that nothing
re-probes an entry the cache has already decided about.

It left a gap behind. `probe()` now records nothing at all when a candidate
times out, so `resolvePins` has no memory of having tried. The measured cost,
from this repo's own cache before it was cleaned:

    opencode-go/mimo-v2.6-pro    ok=false    60283ms

That entry was the 60s ceiling. Under the new rule it would not be written —
and the next run, and every run after it, spends another 60 seconds discovering
the same slowness before falling through to the next candidate. The probe
budget (3 per run) is consumed by a candidate we already know is too slow to be
worth a lane.

Both behaviours are defensible on their own and wrong together:

- recording `ok: false` retires a model that may be perfectly capable
- recording nothing re-pays the full timeout on every future run

## Decision

Record a timeout as what it is: an observation about latency, not about
capability. The cache gains a way to remember "this candidate was too slow to
finish a trivial probe" that is *separate* from "this model cannot emit a
schema", and `resolvePins` skips a candidate with a recent slow observation
instead of probing it again.

The distinction that must survive review: a slow observation must never make a
model look incapable. It bounds what we spend looking, nothing more.

## Consequences

A slow candidate costs one 60s probe per expiry window instead of one per run.
A model that was merely having a bad minute still gets another chance, because
the slow record expires like any other. The `ok`/`not ok` capability signal
keeps meaning exactly what it means today.
