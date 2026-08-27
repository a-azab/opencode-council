# `/crew` — the autonomous delivery org

**Date:** 2026-08-26 · **Status:** proposed (rev 2, after spec review) · **Sub-project 3 of 3**

---

## 1. What crew is, in the human's words

> *"research and design the best way and the best architecture and execute to deliver what I
> instruct them, with a minimum human interaction. They might ask for clarification to
> finalise or collect all the requirements from me to finalise the plan before the
> execution, but they execute on themselves."*
>
> *"They have their own decisions and they are recorded like normal employees who can work,
> validate and test everything without my permission."*

The distinguishing axis is **not** "one task vs many" — it is **where the human sits**:

| | requirements | planning | execution | your involvement |
|---|---|---|---|---|
| **`/lets`** | you state them | **you approve the plan** | unattended | a gate before work starts |
| **`/crew`** | **it interviews you** | decides for itself | unattended | answer questions, then read the record |

## 2. The record is the whole safety story

With no approval gate, the only thing between the human and a bad decision is whether the
report honestly says what happened. Crew adds almost no new honesty machinery — it inherits
it, and its job is to **not undermine it**: acceptance judged by a different model than the
implementer, unjudged items labelled as such, `not-attempted` counted against the whole
plan, termination floors reported in prose, stand-ins named, an ADR per decision.

---

## 3. Three sub-projects, and why

Rev 1 was one plan. Review measured it as three, and located the risk precisely: **if
disjointness cannot be computed reliably, the entire parallel design collapses to a
sequential fallback.** So the risky part is built first, and it is the part that needs no
model calls at all.

| | scope | why this order |
|---|---|---|
| **3a — the scheduler** *(this spec)* | a file-edge index over `graph.json`, and the wave scheduler over it. **Pure functions. Zero model calls.** | it is the load-bearing claim, and it is fully testable in isolation. If it does not hold, 3b and 3c are not worth building |
| **3b — enabling changes to lets** | five additive changes (§7) | mechanical, but each was found by review rather than by reading; they are recorded so they are not rediscovered |
| **3c — the org** | interview, recruitment, integration, CEO report | depends on both, and is where the cost lives |

---

## 4. What the graph can and cannot tell us

Verified against `graphify-out/graph.json` on 2026-08-26:

```
directed: false · 264 nodes · 565 links
node keys: _origin, community, community_name, file_type, id, label,
           norm_label, source_file, source_location
```

Three corrections to rev 1, each of which changes the design:

1. **Nothing in the repo parses this file.** `graphContext()` (`lets.ts:482`) returns a
   **prose string for LLM prompts** — `graphify query` output plus a God Nodes excerpt.
   `graphState()` only stats the file's mtime. The file-edge index is **new code**, not a
   use of something existing.
2. **The graph is undirected.** "A task editing an *importer* of `a.ts`" is **not
   answerable** — direction is not recorded. What is answerable is *neighbours*, which is a
   conservative superset: it will call some independent tasks conflicting, and will never
   call a conflicting pair independent. For a safety gate that is the correct direction to
   err, and the spec says so rather than claiming precision it does not have.
3. **A new file has no node.** An item creating `src/new.ts` has no graph presence, so its
   disjointness falls back to literal path comparison. That is sound — a file nothing
   references yet cannot conflict through the graph — but it must be explicit, because the
   scheduler's guarantee is otherwise silently weaker for exactly the items most likely to
   be added.

**The checked-in graph is stale**: `graphify-out/manifest.json` still names `src/crew.ts`,
from before the rename. So the degradation path in §5.3 fires on this repo *today*, which
makes it the default case rather than an edge case.

---

## 5. Design — 3a, the scheduler

### 5.1 The file-edge index

```ts
/** Files that touch each other, per the graph. Undirected: neighbours, not importers. */
export function fileEdges(graphPath: string): Map<string, Set<string>>
```

Built by grouping nodes by `source_file`, then, for each link, joining the `source_file` of
its endpoints. Node ids that carry no `source_file` (a package, a community label) are
skipped rather than guessed at.

Pure, synchronous, and given a path rather than reading a fixed location — so it is testable
against a fixture graph with no repo, no network and no models.

### 5.2 Conflict

```ts
/** Do these two file sets touch, directly or through one graph hop? */
export function conflicts(a: string[], b: string[], edges: Map<string, Set<string>>): boolean
```

True when the sets share a path, **or** when any file in `a` is a graph neighbour of any
file in `b`. **One hop, not transitive closure** — at two hops a codebase of any density
becomes a single connected blob and every task conflicts with every other, which is a
sequential schedule wearing a graph's costume. One hop is the honest middle: it catches
"these two edit things that reference each other" without collapsing.

### 5.3 Waves

```ts
export function schedule(tasks: Task[], edges: Map<string, Set<string>>): Task[][]
```

Greedy: walk tasks in plan order; place each in the earliest wave containing nothing it
conflicts with; open a new wave when none fits. Plan order is preserved as far as
conflicts allow, because a plan's order carries intent the scheduler cannot see.

**Degradation is a first-class path, not an error.** When the graph is missing, stale, or
unparseable, `schedule` returns **one wave per task, in order** — a sequential schedule —
and the caller reports which of the three it was. Guessing at disjointness without the graph
is the exact failure the gate exists to prevent, and a stale graph is *this repo's current
state*.

### 5.4 Bounds — stated, because rev 1 claimed "bounded" without a number

| bound | value | why |
|---|---|---|
| `MAX_WAVE_WIDTH` | 4 | concurrent runs multiply spend; a wave of 12 is a bill, not a schedule |
| `MAX_TASKS` | 12 | past this the directive wants decomposing by a human first |

A wave wider than `MAX_WAVE_WIDTH` is split into consecutive waves. Both are exported
constants, so a test pins them and a reader finds them.

---

## 6. Testing — 3a

Every row is a pure-function test. No models, no network, no repo.

| what | why |
|---|---|
| two tasks touching the same file land in different waves | the core claim |
| two tasks touching unrelated files share a wave | otherwise it is sequential with extra steps |
| two tasks whose files are graph **neighbours** land in different waves | the reason the graph is consulted at all |
| conflict is **one hop**, not transitive | at two hops everything conflicts and the schedule silently degenerates |
| a task creating a **new** file (no graph node) is compared by literal path | the guarantee is weaker there and must be deliberate |
| a **missing** graph yields one wave per task, and the caller can tell it degraded | this repo's graph is stale today, so this is the default path |
| an **unparseable** graph degrades the same way rather than throwing | a scheduler that crashes on a bad graph is worse than one that runs sequentially |
| plan order is preserved where conflicts allow | the plan's order carries intent |
| a wave never exceeds `MAX_WAVE_WIDTH` | the cost bound |
| nodes without `source_file` are skipped, not guessed | a community label is not a file |

---

## 7. Sub-project 3b — the enabling changes, all found by review

Five additive changes to `lets`/`engine`, none of them optional:

1. **`runExecute` must accept a caller-supplied slug.** Its stamp is millisecond-resolution
   (`lets.ts:1672`), so rev 1's "same second" framing was wrong — the real defect is
   **TOCTOU**: `taken()` checks at `:1679-1682`, `openWorktree` acts at `:1686`, and nothing
   holds between. A caller-supplied slug is still the right fix; the reasoning changes.
2. **`runExecute` must be able to suppress push and PR.** It calls `openPr` unconditionally
   whenever any item landed (`:1775-1784`), which pushes and runs `gh pr create`. N
   concurrent tasks would open **N pull requests before integration has run at all**.
3. **Each task needs its own tracker.** `linearTracker` holds `let sessionId` and `let plan`
   per closure (`:889-890`); sharing one across concurrent runs means the first `finish()`
   closes the session while other tasks are still working — the precise "done vs still
   working" confusion §2 exists to prevent.
4. **`onStep` output must be task-prefixed.** N runs write `[1/2] <title>` to one stdout
   (`:1724`) with no task label. For a design whose safety story *is* the record,
   unlabelled interleaved output is a defect.
5. **`runPlan` needs a `roles?: Role[]` parameter** if it is to score a *recruited* design.
   It currently picks internally from `PLANNING_ROLES` (`engine.ts:993`), which excludes
   `architect` and `infrastructure` — the two roles recruitment exists to use.
   (`runReview` already takes `roles`, so the recruited-panel *review* needs no change.)

Also: **`reviewBranch` is not exported** (`lets.ts:1623`). 3c should call `runReview`, which
is exported and role-parameterised.

And `artifactDir` (`index.ts:135`) uses a **second**-resolution stamp with no suffix, so two
same-kind artifacts in one second silently share a directory. `runExecute` writes no
artifacts so it is unaffected today, but crew's per-task artifacts would hit it.

## 8. Sub-project 3c — the org

Interview (bounded: two rounds, four questions each, every Q&A recorded in the ADR),
research (browser MCP; `websearch` does not exist here), recruitment (deterministic floor
from stack and keywords, plus capped model-proposed additions), design + ADR **written
before execution**, integration (new code — nothing merges branches today; conflicts stop
the run rather than being auto-resolved, because a conflict is evidence the scheduler was
wrong), verify on the **integrated** branch, then one review and the CEO report.

**Cost, measured rather than asserted** — for 3 tasks × 2 items: interview ~3, `runPlan` ~20
(5 proposals + 15 cross-scores), 3 × ~25 per task, final review ~18 → **~115–130 calls
minimum, 250+ worst case.** Review is structurally **N+1 full councils**: each task runs one
inside `runExecute`, then the integrated branch runs another.

**Therefore 3c should drop the per-task council review** and keep `verify` plus acceptance
judging as the per-task signal, with one council on the integrated result. That is the
single largest line, and the two reviews are largely redundant.

---

## 9. Risks

| risk | mitigation |
|---|---|
| Parallel agents are the documented failure mode (MAST: 41–86% across 7 frameworks) | concurrency **only** where the graph proves disjointness, never speculative — and the graph is undirected, so the test errs toward "conflicting" |
| The graph is stale on this repo right now | degradation to sequential is a designed path with its own test, not an error |
| A wrong disjointness call corrupts a merge | conflicts stop integration and report; the scheduler is then wrong and visibly so |
| No approval gate | the interview is the gate moved earlier; the ADR and report are the review moved later |
| Cost multiplies with wave width | `MAX_WAVE_WIDTH` 4, `MAX_TASKS` 12, and 3c drops the redundant per-task review |
