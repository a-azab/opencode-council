# Resuming an interrupted crew run

**Date:** 2026-08-28 · **Status:** accepted · **Scope:** `src/index.ts`, `src/crew-org.ts`,
`src/lets.ts`, `command/crew:execute.md`, `command/crew:status.md`, `README.md`

## Context

`/crew:execute` is the longest unattended operation this plugin performs: waves of concurrent
tasks, each with its own worktree, model run and acceptance judge, then integration, verify,
and one council review on the integrated branch.

A run was interrupted, and the user could not make it continue. That was the reported bug, and
the report was accurate.

The work was never actually lost. Every finished task had already committed to its own branch,
and a branch outlives the process that made it. What was missing was any way to *say so*: each
invocation minted a fresh `runId`, from which every task's slug and branch name are derived, so
a rerun built the whole plan from scratch and the finished branches sat there unreferenced. The
user paid a second time for work already on disk.

So the question this ADR answers is not "should a crew run be resumable" but **what a rerun is
allowed to assume**, given that both available assumptions are wrong some of the time.

## Decision

1. **A checkpoint after every task.** `state.json` is written into the run's artifact directory
   — `council-artifacts/<stamp>-crew-org-run/state.json`, holding `{ plan, runId, tasks }` —
   after each task settles, **not** per wave and **not** at the end.
2. **A rerun that finds a checkpoint refuses, and names both ways out.** Two boolean args on
   the `crew` tool: `resume` carries the finished branches forward and runs only what is left;
   `fresh` ignores them and runs the whole plan again. **Neither is a default.**
3. **The branch is the evidence, never the record alone.** A checkpointed task whose branch no
   longer exists is not resumable and runs again.
4. **Only the same plan may be resumed** — the checkpoint's `plan` must match the newest
   recorded plan directory.
5. **The offer fires on `landed.length` alone**, not `landed && remaining`, in both
   `/crew:execute` and `/crew:status`.
6. **A resumed task is labelled in the report** — `CrewTask.resumed`, rendered as
   `· **carried forward from an earlier run**`.
7. **`resolveScope` no longer counts this tool's own output as the human's uncommitted work.**

## What this rests on

### Refusing is the decision, not a failure to decide

A checkpoint admits exactly two readings, and each is right about half the time:

| assume | right when | wrong when |
|---|---|---|
| resume | the branches are the work they claim to be | the human wanted a clean run, and work is silently skipped |
| fresh | something about the earlier run was suspect | N tasks are paid for twice — the original bug |

There is no third reading available from inside the tool, because the missing input is the
human's intent about work that already exists. So the tool asks. Both answers are one word,
and naming them is the entire fix for "I could not make it continue" — the earlier behaviour
was not that resuming was hard, it was that nobody was told it was possible.

This is the same shape as the scheduler's `partial` mode: where the evidence does not decide,
say so and name the options, rather than picking the one that looks like progress.

### Per task, because per wave loses a wave and the end loses everything

A checkpoint at the end of the run records nothing about the run that needed it. A checkpoint
per wave is better and still throws away up to `MAX_WAVE_WIDTH` finished tasks — an
interruption mid-wave loses every task in that wave, which is exactly the concurrency the
design exists to buy.

Each task's record registers itself as it settles and checkpoints immediately, including on
the crash path, so the file on disk is current mid-wave rather than between waves.

### `landed.length` alone, because the all-done case is the expensive one

The natural guard is `landed.length && remaining.length` — "some done, some left". It misses
the case worth the most.

A run interrupted during integration, verify or review has **every task finished and nothing
remaining**. That is the longest unattended stretch in a crew run, and every task branch in it
is complete and paid for. Guarding on `remaining` would drop the checkpoint on the floor there
and rebuild all N tasks.

**This was got wrong once and caught by documentation.** `/crew:execute` was widened to
`landed.length` while `/crew:status` kept the narrow gate, so the most expensive case to repeat
was resumable by execute and invisible in the read-only view whose entire purpose is
advertising that resuming is possible. No test covered it; it was found by the tech writer
checking the prose against source, and fixed rather than documented as a limitation.

### A record that outlives what it describes

A checkpoint names branches. Branches are the human's, in the human's repo, and can be deleted
between the interruption and the retry — plausibly *because* the run failed and they tidied up.

Resuming on the record alone would then merge nothing for that task while the report, built
from the same record, marked it done and carried forward. That is a report claiming work that
does not exist, in a namespace where the report is the only thing standing in for an approval
gate. So `branchExists` is checked per task at resume time.

The plan-identity check is the same argument one level up: `latestArtifact` returns the newest
checkpoint on disk, and newest is not the same as *this plan's*. Branches from another
directive answer a different question, and merging them because their file happened to sort
last is the silent wrong answer this design exists to avoid.

### The tool's own debris was being counted as the human's work

`resolveScope` reads `git status --porcelain`; `/lets` and `/crew` both refuse to run with a
dirty tree, because a worktree branches from the configured base and uncommitted work would be
invisible to the run.

A crew run writes `council-artifacts/` and `.worktrees/` into the repo it is running in. So an
interrupted run left its own debris behind, the debris made the tree dirty, and the retry was
refused with **"commit or stash first"** — including the resume of the very run that wrote
them. The feature would have been unreachable in exactly the situation it was built for.

**`/lets:init` does add both to `.git/info/exclude`, and that is not sufficient — for a reason
that generalises well past this bug.** `.git/info/exclude` is per-clone and is never committed.
The `lets` config block lives in `AGENTS.md`, which is. So the two travel differently: a fresh
clone of a configured repo has the configuration and **not** the exclusion. "This repo is set
up" and "this checkout ignores our output" are separate facts, and only one survives `git
clone`.

A regex — `OURS`, in `src/lets.ts` — now filters both paths out of `scope.dirty` at the source.
Filtering there rather than at each call site means it does not depend on a file that may not
have travelled, and it fixes `/lets`, which had the same latent trap.

### What is still not tested

Unchanged from the crew autonomy ADR: **no test in this suite may call a model**, so
`/crew:execute`'s orchestration past its guards is still exercised only by its refusals. The
resume path is tested at exactly that boundary — the refusal and its wording for both cases,
the deleted branch, the foreign plan, `fresh` going past a checkpoint, both `/crew:status`
surfaces, and the report's carried-forward label rendered from a hand-built `CrewResult`.

The checkpoint fixtures are written by hand, because producing one for real needs model calls.
The tests therefore pin the shapes `latestArtifact` matches and `resume` reads, **not** that
the running code writes that shape. A change to what `checkpoint()` serialises would not fail
them. The one thing binding the two is that both name `state.json` and the `crew-org-run` kind.

## Alternatives rejected

**Resuming silently when a checkpoint is found.** The obvious version, and it fails in the
direction nobody can see: work is skipped on the strength of a file, and the report says
complete. If the checkpoint is stale, the evidence that anything was skipped is the absence of
a task nobody is looking for.

**Starting fresh silently and treating the checkpoint as advisory.** This was the behaviour,
and it is the bug. It is also the *safe-looking* option, which is what makes it worth naming:
it never produces a wrong merge, it just charges for the same work twice and calls it a run.

**A `--force`-style single flag.** One flag with an inverted meaning is a coin toss at the call
site. Two named booleans that both have to be typed cost one extra word and cannot be confused
for each other.

**Keying the checkpoint on `runId` and resuming the same id.** Tempting, since `runId` already
derives the slugs, and it would let a resumed run reuse its original branch names. But the run
id is what makes a rerun's branches distinct from a previous run's, and reusing it means the
second attempt at a task collides with the first attempt's branch — the failure `runId` was
introduced to prevent. Resumed runs get a new id; carried-forward tasks keep their original
branches in the record.

**Trusting the record of a finished task without checking the branch.** Cheaper by one git call
per task, and it makes the report capable of stating that work landed when nothing did.

**Adding the two paths to `.gitignore` instead of filtering in `resolveScope`.** It travels
with the repo, unlike `.git/info/exclude` — but it writes the plugin's implementation details
into a file the team owns and reviews, and it is still a file that has to be present and
correct in a repo the tool did not set up. Filtering at the point of the read depends on
nothing.

**Fixing the dirty-tree trap only on the crew path.** The report named `/crew`, and the same
`resolveScope` gates `/lets`. One filter in the shared function is a smaller change than a
guard at each caller, and patching only the path the report named would have left `/lets`
broken for the identical reason.

## Consequences

- **`.git/info/exclude` cannot carry anything a fresh clone needs, and this is general.** It is
  per-clone and never committed, while `AGENTS.md` config is committed — so any behaviour split
  across the two is correct on the machine that ran `/lets:init` and broken on every clone
  after. Anything that must hold wherever the repo is checked out belongs in committed
  configuration or in code. `/lets:init` still writes the exclusion; it is now a convenience
  rather than the mechanism.
- **A crew run now leaves state that a later run reads.** `council-artifacts/` was append-only
  output nothing consumed; `state.json` is an input. Deleting artifact directories to reclaim
  space now silently removes the ability to resume, and the resume path reads the *newest*
  checkpoint, so a partial cleanup can change which run is offered.
- **The dirty-tree gate no longer sees two specific paths.** Someone who genuinely has
  uncommitted work under `council-artifacts/` or `.worktrees/` — by committing artifacts, or by
  working inside a worktree directory — will not be warned about it. That is the accepted cost,
  and it is why the pattern is anchored at the start of the path rather than matched loosely.
- **`PLAN.md` is now wrong about resume.** C17 records "No resume — process-level death leaves
  the commits on the branch; re-run", and §6c carries an unchecked "P1-A — Append-only event log
  + resume" whose `resume(runId)` design is superseded by the plan-keyed checkpoint that
  shipped. PLAN.md is a dated journal and is left as written, but the claim no longer describes
  `/crew`.
- **The resume tests are the reason two of them make no model calls.** Disabling the refusal
  does not merely fail assertions; it falls through into the real execute path. Anything that
  weakens the guard is visible as a suite that suddenly wants a network — measured at 43s and
  20s for the two tests when the guard was mutated out.
