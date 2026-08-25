# Council — design spec

**Date:** 2026-08-25 · **Status:** proposed (rev 4, after three spec reviews) · **Sub-project 1 of 3** (council → lets → crew)

---

## 1. System context

Three namespaces, one hierarchy. This spec covers only the first; it records the shared
context because the other two depend on names and policies fixed here.

```
        you (CEO) ──directive──▶ /crew ──────────────▶ final report + PRs
                                   │
                    ┌──────────────┴───────────────┐
                    │  recruit → schedule (graph)  │   loop until shipped
                    └──────────────┬───────────────┘
                      ┌────────────┼────────────┐
                   /lets         /lets        /lets      ← parallel iff files disjoint
                      └────────────┼────────────┘
                                /council                 ← consulted at plan and at review
```

| namespace | owns | attention | state today |
|---|---|---|---|
| `/council:*` | advisory. Every model on one question, debate rounds, verified findings. | you ask, they answer | **exists** as `/council-*` + `/check` |
| `/lets:*` | one task end to end: plan → execute → audit → commit → done | yours, at the gates | **does not exist**; today's crew pipeline is its body |
| `/crew:*` | a directive: decompose, schedule, run N lets, integrate, report | none — autonomous | **exists but is misnamed** — see §1.1 |

### 1.1 What already exists

`command/crew:{init,plan,execute,status}.md` are live, `src/crew.ts` is ~82KB, and the
`crew` tool is registered with modes `init|plan|run|status`. That pipeline — intake,
worktree, implement, verify, acceptance judge, commit, PR, escalation, termination floors —
**is the single-task workflow that sub-project 2 renames to `lets`.** Sub-project 3 then
builds a thin `crew` on top of it. Neither is in scope here; where this spec touches
foundations they need (§3.5, §3.6), it says so.

**Model policy** (fixed by the human, 2026-08-25):

| stage | who | verified |
|---|---|---|
| council | every model, together, with debate | — |
| plan (lets/crew) | multi-model panel + recruited specialists | — |
| execute (lets/crew) | `deepseek/deepseek-v4-pro` | yes — drove bash, exact marker, 9.5s |
| audit (lets/crew) | multi-model, the recruited panel | — |

**Shared conventions:**

- ADRs at `docs/adr/YYYY-MM-DD-slug.md`, one file per decision. No sequential numbers —
  `0007-` allocation races when parallel lets write decisions concurrently.
- Research is browser-backed. `webfetch` works from spawned sessions (verified). MCP
  browser servers (playwright, chrome-devtools, puppeteer) are reachable from spawned
  sessions (verified). `websearch` is a valid permission key but **no such tool exists on
  this machine** — a spawned session reports `NO-TOOL` (verified).
- Anything learned online is cited in its ADR with the source URL.

---

## 2. Problem

1. **Namespace is inconsistent.** `council-review`, `check` — kebab and bare, while
   `crew:*` is already colon.
2. **Routing is wrong for an advisory body.** `selectRoles()` wakes only the lanes a diff's
   filenames implicate — right for lets/crew, wrong for "my council".
3. **Debate is off.** `DEFAULT_MAX_ROUNDS = 0` (`engine.ts:566`), disabled after measuring
   one round, six re-judgements, **zero changed positions**. The human wants it on.
4. **No `council:task`.** No way to hand the council a task and get one converged answer.
5. **Missing specialists.** The recruiting planner (sub-projects 2/3) must be able to
   recruit an architect and an infrastructure reviewer. Neither role exists.
6. **deepseek is excluded on false grounds** (`README.md:409`). Verified: the direct route
   drives tools; the recommended remedy `opencode-go/deepseek-v4-pro` is dead. The real
   limit is forced `tool_choice`.

---

## 3. Design

### 3.1 Command surface

| today | becomes |
|---|---|
| `/council-review` | `/council:review` |
| `/council-fix` | `/council:fix` |
| `/council-plan` | `/council:plan` |
| `/council-independent` | `/council:independent` |
| `/check` | `/council:check` |
| — | `/council:task` (new) |

One name per thing; no aliases. `command/crew:plan.md` already proves colon names register.

**Rename blast radius** — live surfaces, with §5's grep as the backstop:

| file | sites |
|---|---|
| `command/check.md` | 24, 44, 73, 75, 85 (`/council-review` refs, incl. the "Consistency contract" section) and 23, 78, 80 (`/check` self-references) |
| `command/council-fix.md` | 20 |
| `src/index.ts` | 355 (`"Use /check for a fast inline pass instead."`) |
| `README.md` | 10 sites |
| `~/.config/opencode/command/workflow.md` (**outside this repo**) | 19–20, 112, 116 — the human's LETS stopgap |

**`PLAN.md` is deliberately left alone.** It holds ~15 references to the old names and is a
*historical record* — a dated journal of decisions and what was true when each was made.
Rewriting history to match a later rename would make the journal lie about itself. It is
excluded from §5's grep for the same reason.

### 3.2 Full panel by default

`council:review`, `council:fix` and `council:task` pass `ALL_ROLES`, so every lane runs
regardless of which files changed. (`council:check` dispatches no subagents and makes no
engine call — `check.md:78` — and `council:independent` is already every model by
construction.)

Mechanism — no new plumbing: `runReview` already accepts `roles?: Role[]` (`engine.ts:584`)
and its comment (576–583) names `ALL_ROLES` as the intended value.

Per-role caps (`MODELS_PER_ROLE` security:3, default 2) are **unchanged**, and no
`everyModel` option is added. Tracing `selectNodes(ALL_ROLES)` against the current roster
gives 19 nodes with all 14 members receiving ≥1 (`glm52` is the near miss — passed over for
`systems` on `ms`, arriving via `reviewer`), and that holds at 23 nodes with the new roles.
An option guarding a condition that never fires is dead code; the guarantee becomes a
**roster invariant test** (§5) that fails loudly if a future roster change breaks it.

Cost, stated plainly: 19 nodes today, 23 with the new roles, × up to 2 debate rounds.

### 3.3 Debate and iterations

`DEFAULT_MAX_ROUNDS` stays **0**. Council call sites pass `maxRounds: 2` explicitly.

This matters: `crew.ts:1584` calls `runReview` with neither `maxRounds` nor `roles`, so it
inherits both defaults. Editing the constant would silently give every crew branch-review 2
rounds. The split lives at the call site or it is not a split.

**Debate reporting already exists.** `report.ts:92-103` prints a `## Convergence` block —
rounds, the computed convergence reason, and per round `N re-judgements, M changed position:
model→tier`, or `(positions held)`. No new work; the task is to **verify it renders** with
rounds > 0, since it has never run with the loop enabled.

### 3.4 `council:task` (new)

Hand the council a task; every model works it, and one answer comes back with its dissent
intact.

**It does not reuse the debate loop.** `debateRound` (`engine.ts:495`), `applyRevisions`
and `converged` (`decide.ts:245`) are defined over `Group[]` of tiered `Finding`s — a
`Revision` is `model→tier`. A free-form answer has no tier. No prose-convergence algorithm
is invented here.

**It does not reuse `runPlan`** — that was rev 2's error. `runPlan` picks proposers from
`PLANNING_ROLES`, one member per role, first match wins (`engine.ts:977-983`), yielding at
most 5 proposers, and scores all-pairs (`engine.ts:1012`).

**It does reuse `tally()` — and that constrains the score shape.** `tally()` sums exactly
four dimensions (`decide.ts:215`: `correctness + simplicity + risk + completeness`) and
`TIE_MARGIN = 0.25` is calibrated against that 4–20 scale. A one-dimensional `score: 1-10`
would make every term `undefined`, every mean `NaN`, every `NaN` comparison falsy — and the
sort would fall through to alphabetical-by-slug while still reporting a confident winner.
That is a silent false consensus, the precise failure this command exists to prevent. So
the task score **reuses `Score`'s four dimensions verbatim** and adds one field:

```
TASK_PROPOSAL_SCHEMA  { answer, reasoning, confidence: high|medium|low }
TASK_SCORE_SCHEMA     { correctness, simplicity, risk, completeness,   // 1-5, as Score
                        reason,                                        // deciding factor
                        objection }                                    // "" when none
```

`TaskScore` is structurally a `Score` plus `objection`, so `tally()` is reused **unchanged**
and `TIE_MARGIN` keeps its calibration. `decide.ts` is not modified.

**New engine export:**

```ts
export async function runTask(
  ctx: Ctx,
  input: { goal: string; context?: string },
): Promise<TaskResult>

export type TaskResult = {
  goal: string
  proposals: TaskProposal[]   // every proposer, failures carried with state + detail
  scores: TaskScore[]
  winner: TaskProposal | null // null when tally() reports a tie inside TIE_MARGIN
  tied: TaskProposal[]        // populated exactly when winner is null
  runnerUp: TaskProposal | null
  objections: { scorer: string; proposal: string; objection: string }[]
  unscored: boolean           // true when N === 1: no scorer is possible
  dropped: { slug: string; state: NodeState; detail: string }[]
}
```

```
every schema-capable member proposes an answer        (N proposals)
        ↓
each proposal scored by k = min(3, N-1) others        (N × k scores)
        ↓
tally() → winner, or a tie that goes to the human
```

- **Proposers:** every member whose `capability` includes `"schema"` (§3.6). Each answers
  under `agent: council-${member.roles[0]}`, so it has a prompt in a voice it owns.
- **Scorer assignment — deterministic, stated in full.** Order live proposals by their
  member's index in `ROSTER` (the roster's own order; not `ms`, which changes when
  re-measured). For proposal `i` of `N`, scorers are `(i+1) … (i+k) mod N`, where
  `k = min(3, N-1)`. Cyclic-next can never select the author because `k ≤ N-1`, and the
  clamp keeps it satisfiable when most nodes fail and `live` is small (`runTask` filters to
  live proposals as `runPlan` does at `engine.ts:1009`). At `N === 1` there are no scorers:
  the sole proposal is returned with `unscored: true`.
- **Ties are not resolved.** `tally()` returns `winner: null` within `TIE_MARGIN` by design
  — ties go to the human (`decide.ts:196`). At k=3 the means land on thirds, so exact ties
  are common and must be handled, not assumed away. When `winner` is null, every tied answer
  is presented side by side and the report says the council did not converge. Manufacturing
  a winner from a tie would be the same false consensus in a different costume.
- **Cost:** N=14 → 14 proposals + 42 scores = 56 calls. All-pairs would be 182.
- **Dissent:** the runner-up and each scorer's `objection` are reproduced **verbatim**
  beneath the chosen answer.
- **Rendering:** new `renderTask(result)` in `report.ts` (§4). No existing renderer covers
  this shape.
- **Artifact:** `council-artifacts/<stamp>-task/`.

### 3.5 New roles: `architect`, `infrastructure`

Both extend the `Role` union (`roster.ts:7-9`) and join `ALL_ROLES`. Foundation for
sub-projects 2/3's recruiting planner as well as council's own panel.

**Carriers** — a role no member carries is a silently empty lane:

| role | members | rationale |
|---|---|---|
| `architect` | `opus5`, `gpt55` | boundaries and sequencing; the two members that reported 4/4 across every review round |
| `infrastructure` | `glm52`, `grok45` | Terraform/cloud/network; spreads load off the architect carriers and across providers |

**Append, never prepend.** `roles[0]` is load-bearing: §3.4 keys a proposer's agent off it,
so prepending `architect` to `opus5` would silently switch its voice from `council-reviewer`
to `council-architect`. `selectNodes` uses `includes`, so position is otherwise irrelevant.

**Routing.** `architect` gets **no glob route** — no file extension implies "needs an
architect"; it is full-panel and recruited only. `infrastructure` *replaces* `ops` where it
is the more specific role, keeping node count flat rather than doubling it:

| glob | today | becomes |
|---|---|---|
| `**/{Dockerfile,docker-compose*,Makefile,*.tf}` | `ops, security` | `infrastructure, security` |
| `**/*.tfvars` · `**/k8s/**` · `**/{terraform,infra,infrastructure}/**` | *(unrouted)* | `infrastructure, security` (new) |
| `**/.github/workflows/**` | `ops, security` | unchanged — CI is ops |
| `**/*.{yml,yaml,toml,ini,conf}` | `ops, security` | unchanged |
| `**/.env*` | `security, ops` | unchanged |

Patterns keep the `**/` prefix `path.matchesGlob` needs against repo-relative paths; a bare
`*.tf` would not match `envs/prod/main.tf`. Flat node count verified for the `.tf` case: a
`*.tf` diff yields 7 nodes before and after (3 security + 2 reviewer + 2 ops|infrastructure).
Note the directory route is deliberately broad — `infra/README.md` wakes
`infrastructure, security` **in addition to** `docs`. That is intended (a doc describing
infrastructure deserves an infrastructure reader), and it means the flat-count guarantee is
specific to the `.tf` case measured, not universal.

**Blast radius into existing crew:** `crew.ts:38` defines
`KNOWN_ROLES = [...ALL_ROLES, "skeptic"]`, validating `lanes:` in a repo's crew block.
Adding two roles **widens** what is accepted — existing configs stay valid, `lanes: architect`
becomes newly legal.

### 3.6 Roster: capability as a set

```ts
capability?: ("schema" | "agentic")[]   // default ["schema"]
```

- `schema` — can emit forced-tool-call structured output.
- `agentic` — can drive tools in a session.

A set, not a single value: most members are both, and a single value would force demoting a
model out of council lanes to make it eligible as an implementer.

| member | roles | capability | basis |
|---|---|---|---|
| `deepseek` (`deepseek/deepseek-v4-pro`, **new**) | `[]` | `["agentic"]` | verified: drives bash, exact marker, 9.5s; fails forced `tool_choice` |
| `opus5`, `gpt55`, `glm52` | unchanged | `["schema","agentic"]` | already used as crew implementers in live runs |
| all others | unchanged | `["schema"]` (default) | agentic not verified, so not claimed |

**`roles: []` is deliberate defence in depth.** Every role-based selector
(`ROSTER.filter(m => m.roles.includes(...))`) then excludes deepseek automatically, so a
missed capability filter cannot put it in a lane.

**Insertion position matters.** `engine.ts:799` falls back to `ROSTER[0].model` and then
passes `PATCH_SCHEMA`. That is safe today only because `ROSTER[0]` is `opus5`. deepseek is
appended, never inserted at index 0.

**Where the filter goes — the rule is "wherever a schema is passed to `ask()`", not
everywhere:**

| site | passes a schema? | filter |
|---|---|---|
| `selectNodes` (`roster.ts:118`) | yes — `FINDINGS_SCHEMA` | **required** |
| `skepticPool` (`roster.ts:135`) | yes — skeptic schema | **required** |
| `substitutesFor` (`engine.ts:400`) | yes — feeds the schema fan-out | **required** |
| `runPlan` proposers (`engine.ts:978`) | yes — `PROPOSAL_SCHEMA` | **required** |
| `runTask` proposers (new, §3.4) | yes | **required** |
| `runIndependent` (`engine.ts:889`) | **no** — `ask<string>`, prose from message parts | **none** — and deepseek *should* answer here |
| `diagnose` (`crew.ts:1322`) | **no** — `ask<string>`; also role-filtered | none |

That distinction is the point: deepseek's limitation is structured output, not inference, so
`/council:independent` gains its take rather than losing it.

**`CREW_MODELS` (`crew.ts:645`) is slug-based**, so `roles: []` does not protect it. deepseek
must **not** be added to that list here; sub-project 2 adds it together with the `"agentic"`
filter that makes it correct.

`README.md:409`'s exclusion table is corrected: the direct route works for agentic work; the
`opencode-go` remedy it recommends is dead.

---

## 4. Interfaces — every file an implementer touches

| file | change |
|---|---|
| `src/roster.ts` | `Role` union +2; `Member.capability?`; new `deepseek` member (appended); `ROUTES` edits (§3.5); capability filter in `selectNodes`, `skepticPool` |
| `src/engine.ts` | **new** `runTask` + `TaskResult`; capability filter in `substitutesFor` and `runPlan` proposers; council call sites pass `ALL_ROLES` and `maxRounds: 2` |
| `src/schema.ts` | **new** `TASK_PROPOSAL_SCHEMA`, `TASK_SCORE_SCHEMA`. Existing `PROPOSAL_SCHEMA`/`SCORE_SCHEMA` untouched, so `/council:plan` is unaffected |
| `src/report.ts` | **new** `renderTask(result)` |
| `src/decide.ts` | **unchanged** — `tally()` is reused as-is, which is why §3.4 constrains the score shape |
| `src/index.ts` | `council` tool gains `mode: "task"` (args: existing `goal`, optional `context`); line 355 text |
| `command/` | 5 renames, 1 new file, cross-reference fixes per §3.1 |
| `agent/` | 2 new files, `council-{architect,infrastructure}.md`, both inheriting `edit: deny` / `bash: deny` (`index.test.ts:50-54` asserts it for every agent but `crew-dev`) |
| `README.md` | 10 command references; the deepseek exclusion table |
| `~/.config/opencode/command/workflow.md` | 4 references, outside the repo |

No config migration.

---

## 5. Testing

| what | why |
|---|---|
| every `council:*` command registers under its colon name | a typo'd filename is a silently missing command |
| **the five old names** (`/council-review`, `/council-fix`, `/council-plan`, `/council-independent`, `/check`) appear nowhere in `command/`, `src/`, `README.md` | dangling cross-references are the likely rename failure. Matching the five exact names, not the prefix `/council-`: the prefix also matches the legitimate `"the /council-work command still exists"` message at `index.test.ts:102`, plus the 12 `agent/council-*.md` files and the `council-${role}` literals at `engine.ts:505,990`. `PLAN.md` is excluded as a historical record (§3.1) |
| `council:review`/`fix`/`task` select all roles; `crew`'s call still routes by glob | the "all models" requirement, and the cost split that keeps a crew run from costing a council run |
| **roster invariant:** every schema-capable member gets ≥1 node under `ALL_ROLES` | replaces the dead `everyModel` option; fails loudly if a roster change leaves a model unused |
| `crew`'s existing `runReview` call still gets 0 rounds | a shared default would give every crew branch-review 2 rounds |
| `council:task` preserves runner-up and objections verbatim | the false-consensus failure it exists to prevent |
| **`council:task` returns the highest-mean proposal** — not the alphabetically first | the exact silent failure a mis-shaped score schema causes; asserts `tally()` is actually summing |
| `council:task` with a tie inside `TIE_MARGIN` returns `winner: null` and every tied answer | manufacturing a winner from a tie is false consensus |
| `council:task` assigns `min(3, N-1)` scorers, never the author, deterministic for a given roster order | cost bound, self-scoring rule, reproducibility |
| `council:task` with N=1 returns the sole proposal with `unscored: true` | reachable whenever most nodes fail |
| `architect` and `infrastructure` each resolve to ≥1 model — **by extending `roster.test.ts:70-72` to derive from `ALL_ROLES`** rather than adding a parallel test | that test hardcodes an 11-role list, so it would silently not cover the new roles and its name would lie about its coverage |
| a `*.tf` diff routes to `infrastructure` and yields the same node count as today | the ops→infrastructure swap is a swap, not an addition |
| `selectNodes`, `skepticPool`, `substitutesFor`, `runPlan` never return an `agentic`-only member | deepseek in a schema lane fails every call |
| `runIndependent` **does** include the agentic-only member | the filter must not over-apply; prose is not structured output |
| `KNOWN_ROLES` accepts `architect`, and every previously valid crew block still parses | widening must not break existing repos |
| both new agent files register with `edit: deny`, `bash: deny` | `index.test.ts` asserts it for all but `crew-dev` |

**No existing test is expected to break.** Checked: `failover.test.ts:10` (module-scope
`selectNodes(ALL_ROLES)`; exhaustion still yields `["fable","gpt55","opus5"]` whether
deepseek is excluded by bench or by capability), `crew.test.ts:615` (`lanes: coed` rejection
is unaffected by widening), `roster.test.ts:80-86` (skeptic pool sizes hold — deepseek's
`roles: []` keeps it out), `index.test.ts:50-54`.

---

## 6. Risks

| risk | mitigation |
|---|---|
| Full panel × every model × 2 rounds is now the most expensive path in the system | intended; `council:check` stays cheap and the cost is stated, not hidden |
| Debate may again change nothing | the existing Convergence block makes it measurable; retire on data |
| `council:task` at 56 calls is a long run | bounded by `k=3`; artifact written so a slow run is recoverable |
| Rename breaks the human's `/workflow` command outside this repo | §3.1 and §4 enumerate it; update in the same change |
| More roles = more nodes = more malformed-output failures | failover already substitutes benched models; new roles inherit it |

---

## 7. Out of scope

`/lets:*` (sub-project 2) — renaming today's crew pipeline, the session spine
(`start`/`end`/`commit`/`done`), beads task state, the compaction hook, ADR and docs gates,
adding deepseek to `CREW_MODELS` behind an `"agentic"` filter.

`/crew:*` (sub-project 3) — the recruiting planner, graph-gated parallelism across multiple
lets, integration, the CEO report.

Foundations laid here for them — the two roles, the capability set, the implementer
designation — are marked as such where they appear.
