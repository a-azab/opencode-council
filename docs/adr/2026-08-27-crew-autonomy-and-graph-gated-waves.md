# Crew: moving the approval gate, and gating parallelism on the graph

**Date:** 2026-08-27 · **Status:** accepted · **Scope:** `src/schedule.ts`, `src/crew-org.ts`,
`src/index.ts`, `command/crew:plan.md`, `command/crew:execute.md`, `command/crew:status.md`,
`command/lets:team.md`

## Context

`/lets` stops at a planning gate: you state the requirements, you read the plan, and nothing
is built until you approve it. That gate is the whole reason the pipeline is safe to give
`edit` and `bash`.

A third namespace was wanted for the case the gate does not fit — a goal rather than a task
list, and no appetite to approve each step. The obvious way to build it is to delete the
gate. That is also the way to build something that quietly does the wrong thing for an hour.

So the question this ADR answers is not "should crew be unattended" but **what replaces the
gate**, and **what has to be true before two agents may write code at the same time.**

## Decision

1. **The gate moves rather than disappears.** `/crew:plan` **interviews** the human for the
   requirements — bounded at two rounds of at most four questions — and then decides the plan
   itself. The interview is the gate, earlier. The ADR and the run report are the review,
   later. The tool **refuses a plan with no ADR path**.
2. **Concurrency only where the dependency graph *proves* the file sets disjoint.** Two
   tasks share a wave when no file in one is a file or a **one-hop, undirected neighbour** of
   a file in the other. `MAX_WAVE_WIDTH` 4, `MAX_TASKS` 12, and past `MAX_TASKS` the
   scheduler **refuses rather than truncates**.
3. **A file the graph has never seen is scheduled alone**, and the result reports
   `mode: graph | partial | sequential` with the ungraphed files named.
4. **Integration stops at the first conflict** — names the branch and files, aborts the
   merge, keeps the partial integration branch, and never auto-resolves.

## The measurements and discoveries this rests on

### The gate had to be replaced, not removed, because nothing else was watching

Under `/lets`, a wrong plan is caught by a human reading it. Remove the gate and that
detection has to live somewhere, or it does not exist. It was split in two:

- **Before the run: the interview.** The requirements now come from questions crew asks
  rather than a directive the human wrote, so the record of *what was asked for* is the Q&A
  itself. It goes into the ADR **verbatim** — paraphrasing it away destroys the only evidence
  of what the user wanted, and the ADR is written **before** execution because a record
  written afterwards records outcomes, not requirements.
- **After the run: the report.** With nobody approving the plan, the report is the only thing
  between the user and a bad decision. `renderCrewReport` therefore inherits every honesty
  rule from `renderRun` and adds the scheduling ones — `INCOMPLETE` in the first line, tasks
  that never ran listed with their reason, unjudged acceptances named as unjudged, a
  suppressed PR named as suppressed, and the schedule's mode printed because "it ran
  sequentially" is otherwise an unexplained cost nobody can act on.

**The interview is allowed to fail, and that is the load-bearing part.** After two rounds
without convergence it stops, names the questions still open, and does not plan. An
unattended run built on a guessed requirement is exactly the failure mode this namespace has
no gate to catch, so "proceed with reasonable assumptions" is prohibited rather than
discouraged.

The bounds are two rounds and four questions because an interview with no ceiling becomes its
own approval gate — slower than the one it replaced, and without the property that made that
one useful.

### Parallel agents are the documented failure mode, so disjointness must be proven

MAST measured **41–86% failure rates across seven multi-agent frameworks**. The
straightforward reading is "do not run agents in parallel", and `runExecute` already takes
it — its items are sequential by design, share a worktree, and build on each other's commits.

Crew needs concurrency at the level above. The answer is not confidence but **proof**:
concurrency **only** where the graph shows the file sets cannot touch, and one task per wave
everywhere else. The graph is consulted as a **gate**, not as an optimiser.

**The undirected graph is what makes the test conservative by construction.** `fileEdges`
records every link both ways, so a "neighbour" is not "imports" — it is "touches, in either
direction". That over-reports: it will call some genuinely independent pairs conflicting. It
cannot under-report, and for a safety gate that asymmetry is the entire value. A directed
graph would be more precise and would fail in the direction that corrupts a merge.

### One hop, because two hops is a sequential schedule wearing a graph's costume

The conflict test walks exactly one edge and never a transitive closure. This is not a
performance shortcut, it is the only setting at which the graph carries information.

At two hops, a codebase of any realistic density becomes a **single connected blob**: every
file reaches every other file, every task conflicts with every task, and the scheduler
returns one task per wave for every input. That result is indistinguishable from having no
graph at all — except that it cost a graph parse to produce, and it *looks* like a considered
schedule. One hop is the honest middle: close enough to catch real interference, narrow
enough that "disjoint" still means something. `src/schedule.ts:46` says so at the call site,
and `schedule.test.ts` pins `a--b--c` leaving `a` and `c` compatible.

### "New file" and "file the graph missed" are indistinguishable, and only one is safe

An earlier draft of the scheduler compared a file absent from the graph by literal path only,
on the premise that a file nothing references must be **new**, and therefore safe to run
beside anything.

**That premise is false.** A file with no graph entry and a file with an empty graph entry
both read as "no neighbours" from inside `conflicts()`, but they mean opposite things:

| the file is | absence means |
|---|---|
| genuinely new | nothing references it — evidence of independence |
| existing, and the graph is stale | the graph never saw it — **the absence of evidence** |

The second is not hypothetical, it is the common case. Measured on this repo when the fix
landed: **9 of 27 `src/*.ts` files were absent from its own graph.** Re-measured today
through `fileEdges`: **11 of 29**, and the graph additionally names **two files that no
longer exist**. The stale reading was the majority reading.

`ungraphed()` therefore exists as a separate predicate from `conflicts()`, and every known
file is a key in the edge map even with no neighbours — so "in the graph and isolated" stays
distinguishable from "absent". An unprovable task shares a wave with nothing.

**Three existing tests failed when this was fixed, and that is the finding.** They scheduled
files their own fixture graph never contained, and passed — because they had encoded the
unsafe reading as the expectation. One of them, `a task creating a new file is placed on
literal path comparison alone`, asserted precisely the premise being retracted; it now
asserts the opposite. The fixture gained six isolated-but-present modules, which is the
realistic shape of "provably independent". A test suite that agrees with a bug is the reason
the bug survived review.

### Near-miss 1: `crew-plan` is `/lets:run`'s pre-rename alias

`crew` was the original name of the single-task pipeline, which is now `lets`. The rename
left a compatibility alias: `index.ts:242` reads
`latestArtifact(root, ["lets-plan", "crew-plan"], "plan.json")` so a plan approved before the
rename is still executable.

The obvious artifact kind for a crew plan is therefore `crew-plan` — and writing one there
would have made **`/lets:run` find it and execute it with `edit` and `bash`, despite no human
having approved it.** The one property that separates the two namespaces — `/lets` runs only
what you approved — would have been destroyed by a naming coincidence, silently, in the
direction of executing unapproved work.

The kinds are `crew-org-plan` and `crew-org-run`, and a test asserts `lets run` cannot see a
crew plan.

### Near-miss 2: `src/crew.ts` is a poisoned filename

The natural filename for crew's core is `src/crew.ts`. The graph still carries the **deleted**
pre-rename pipeline at exactly that path, with **9 neighbours**, while `src/lets.ts` — the
module that replaced it — is **absent entirely**.

A new module written to `src/crew.ts` would have been judged against a dead module's edges:
`ungraphed()` would call it provable and `conflicts()` would compare it to 9 stale
neighbours. That is the precise failure `schedule.ts` exists to prevent — absence of evidence
dressed as evidence — reintroduced through a filename. The module is `src/crew-org.ts`.

The commit message for the merge records this as "the only stale entry". **That is not quite
right, and the correction is worth keeping:** `fileEdges` reports **two** ghost entries,
`src/crew.ts` (9 neighbours) and `src/crew.test.ts` (1). The substance is unaffected — both
ghosts are the same deleted pipeline, and taking either name would have made a stale entry
look fresh — but `schedule.test.ts`'s staleness assertion covers a pair, not a singleton.

### Concurrent worktree creation needs no serialisation — measured

`openWorktree` runs `git worktree prune` and then `git worktree add` against the shared
parent repo, and a prune racing a half-created worktree is the plausible hazard. Assuming it
was unsafe would have meant serialising the one step the whole design exists to parallelise.

Tested on **git 2.51.2** with `packed-refs` forced: **16 concurrent prune-then-add pairs, 16
worktrees, 16 branches, zero failures.** Distinct branch names take distinct loose-ref locks,
each worktree gets its own index, and git writes a `locked` file during `add` precisely so a
concurrent prune cannot reap an in-flight worktree.

**The only real requirement is distinct slugs**, and that guarantee cannot live inside
`runExecute`: its own derivation is a check-then-act with nothing held between `taken()` and
`openWorktree`, which is safe for one caller and a race for N. Only the caller that knows all
N can supply distinctness, so crew derives the slug from run id, wave and task index, and
`runExecute` takes a supplied slug at its word rather than second-guessing it.

### What is not tested, stated plainly

**`/crew:execute`'s orchestration past its guards has never run end to end.** No test in this
suite may call a model, so the wave loop, the concurrent `runExecute` calls, and the hand-off
into integration, verify and review are exercised only by their refusals — not a repo, no
config, a dirty tree, nothing planned, too many tasks.

What *is* tested is tested directly and hard: `fileEdges`, `conflicts`, `schedule` and
`ungraphed` against both a fixture and the real stale graph; `integrate` against real git
repos including the conflict, the abort and the refusal to clobber; `recruitFloor`; and every
honesty rule in `renderCrewReport`. **The wiring between them is not tested at all.** The
first true end-to-end crew run will be the first execution of that code path, and it should
be treated as such.

## Alternatives rejected

**Keeping the approval gate and calling it crew.** That is `/lets` with extra steps. The
namespace exists for the case where the human does not want to approve a plan; a gate that is
merely more convenient is not a different answer to the same question.

**Removing the gate with nothing in its place.** The version that is easy to ship and
impossible to audit. A run nobody approved and nobody can reconstruct afterwards is not
autonomy, it is an unattributed diff.

**Writing the ADR after the run.** Cheaper, and it records outcomes rather than requirements
— which is the one thing the ADR exists to hold. A record that can be written to match what
happened cannot be evidence about what was asked for.

**An unbounded interview.** More thorough, and it turns into the approval gate it replaced,
with the human answering questions instead of reading a plan. Bounding it at two rounds also
turns non-convergence into a **signal** — a directive that cannot be pinned down in eight
questions is one that should not run unattended.

**Speculative parallelism with conflict recovery.** Run everything concurrently, resolve
merge conflicts as they come. This is the shape MAST measured at 41–86% failure. It also
inverts the evidence: a conflict becomes routine noise to be cleaned up rather than a signal
that the scheduler was wrong.

**A directed graph, for precision.** Fewer false conflicts, and it errs toward calling
interfering tasks independent. For a gate, a false "safe" is the only expensive error.

**Transitive closure instead of one hop.** Strictly safer and completely useless: every task
conflicts with every task, the schedule is sequential, and it presents that as a graph
result.

**Trusting an absent file to be new.** What the code did before `c547646`, and what three
tests asserted. It is right whenever the graph is fresh and wrong whenever it is stale, which
on this repo is the common case.

**Auto-resolving integration conflicts.** Would raise the completion rate and destroy the
evidence. The scheduler judged those two tasks independent; the conflict is the measurement
that says it was wrong, and an unattended resolve deletes the measurement while leaving the
bug.

**Serialising worktree creation to be safe.** Rejected on the measurement above, and worth
noting as the general rule: the alternative to measuring was a permanent bottleneck at the
exact step the design exists to parallelise, justified by a hazard nobody had observed.

## Consequences

- **Crew's safety story is entirely documentary.** There is no gate to fall back on, so a
  regression in the report's honesty is a regression in safety. Every honesty rule in
  `renderCrewReport` is pinned by a test for that reason, and they are not negotiable.
- **On a stale graph, crew is slow rather than wrong.** This repo's own graph is stale today
  — 11 of 29 `src/*.ts` files absent — so crew here schedules close to sequentially. That is
  the designed degradation, it is reported rather than hidden, and rebuilding the graph is
  the entire fix. `/crew:status` shows the schedule before a run is paid for.
- **A merge conflict is now a bug report about the scheduler**, not a routine event. It stops
  integration, names the branch and files, and leaves the partial branch. The fix is the
  task's `files` list, which makes `files` load-bearing in every plan.
- **One council, on the integrated branch — and the gap that nearly shipped.** The spec
  concluded that crew "should drop the per-task council review", keeping `verify` plus
  acceptance judging as the per-task signal. When crew was built, `runExecute` called
  `reviewBranch` unconditionally and exposed **no way to opt out**, so the recommendation
  could not be honoured — and a commit message claimed it had been, which was true of what
  `index.ts` called and false of the run as a whole. Documentation review caught the
  divergence by reading the source rather than the message.
  `runExecute` now takes `review?: boolean`; crew passes `false`. The saving is the largest
  in the design: reviewing both task branches and the integrated one is structurally
  **N+1 councils**, roughly doubling a 3-task run to ~115–130 calls where ~50–60 suffice.
  Nothing weakens — `verify` and the acceptance judge still run per task.
- **`src/crew.ts` and `crew-plan` are permanently unavailable as names** until the graph is
  rebuilt and the `/lets:run` alias is retired. Both are currently load-bearing in the
  negative: `index.test.ts` guards that no module imports `./crew.ts` and that no non-crew
  command invokes the `crew` tool.
- **The first real `/crew:execute` run is an experiment.** Its orchestration has no test
  coverage and cannot get any while tests may not call models. Run it on a repo you can throw
  away.
