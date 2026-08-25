# Council — design spec

**Date:** 2026-08-25 · **Status:** proposed (rev 9 — reviewed 5×, then tiers and dynamic roster) · **Sub-project 1 of 3** (council → lets → crew)

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
| — | `/council:models` (new, §3.7.4) |

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

`council:review` passes `ALL_ROLES`, so every lane runs regardless of which files changed.

**`council:task` reaches every model by a different mechanism and takes no `roles`.**
`runTask(ctx, {goal, context?})` has no lanes: it proposes from *every schema-capable
member* (§3.4) rather than selecting nodes per role. Both commands honour "all models"; only
one of them does it through `selectNodes`. Conflating the two would hand `runTask` arguments
it cannot accept.

The other three have no lanes to set, and saying otherwise would send an implementer looking
for a parameter that does not exist:

- `council:fix` — `runFix(ctx, {findings, diff, cwd})` (`engine.ts:1039`) takes no `roles`
  and never calls `selectRoles`/`selectNodes`. Its fixer is `bySlug(f.model)` — whoever
  raised the finding (`engine.ts:798-800`) — and its verifier comes from `skepticPool`. It
  **inherits** full-panel coverage from the review it replays.
- `council:independent` — already every model by construction.
- `council:check` — dispatches no subagents and makes no engine call (`check.md:78`).

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

/** Provenance exactly as `Proposal` (engine.ts:910) carries it, with the task fields. */
export type TaskProposal = {
  slug: string            // required: tally() is slug-keyed, and the answer is mapped back by it
  role: string
  model: string
  answer: string
  reasoning: string
  confidence: "high" | "medium" | "low"
  state: NodeState
  detail?: string
}

export type TaskResult = {
  goal: string
  proposals: TaskProposal[]      // every proposer; failures carry state + detail
  scores: TaskScore[]
  ranked: Tally[]                // as `Plan` carries it, so renderTask can show the means
  winner: TaskProposal | null
  tied: TaskProposal[]
  runnerUp: TaskProposal | null
  objections: { scorer: string; proposal: string; objection: string }[]
  unscored: boolean
}

/** Pure, so the assignment rule is testable without a server.
 *  Keyed by PROPOSAL slug → the slugs of the members that score it. */
export function scorersFor(live: TaskProposal[]): Map<string, string[]>

/** Pure. What each council mode passes to the engine, so §5 can assert the cost split
 *  without a live fan-out. `index.ts` reads this rather than inlining the values. */
export function councilArgs(): { roles: Role[]; maxRounds: number }
```

**Three terminal states, exhaustive and disjoint** — the rev 4 draft had a reachable hole
where `unscored` meant only `N === 1`:

| state | when | `winner` | `tied` | `runnerUp` | `unscored` |
|---|---|---|---|---|---|
| **decided** | ≥1 usable score, one clear leader | the leader | `[]` | `ranked[1] ?? null` | `false` |
| **tied** | ≥1 usable score, leaders within `TIE_MARGIN` | `null` | every tied proposal | `null` | `false` |
| **unranked** | **no usable score at all** | `null` | `[]` | `null` | `true` |

`unranked` covers both `N === 1` (no scorer is possible) **and** N ≥ 2 where every scorer
call failed — `tally([])` returns `{ranked: [], winner: null, tied: []}`, which would
otherwise be indistinguishable from a tie and would have `renderTask` announce "did not
converge" while showing an empty list. `runPlan`'s caller already separates this case
(`index.ts:392`, `"no usable proposals"`). In `unranked`, every live answer is printed
unranked and the report says why there is no ranking.

`dropped` is not a field: failed proposers are `proposals.filter(p => p.state !== "ok")`,
matching how `Plan.dropped` is a filter rather than a second shape.

**Every live answer appears in the report, ranked or not.** `tally()` builds `ranked` only
from scores it actually received, so in the `decided` and `tied` states a proposal whose `k`
scorer calls all failed is in `ranked`, `winner`, `tied` and `runnerUp` *nowhere* — and
because `unscored` is `false`, the `unranked` path that prints everything never fires. The
answer would silently disappear. `renderTask` therefore prints a final **"answered, but
unscored"** section listing every `state === "ok"` proposal absent from `ranked`, with the
reason its scorers failed. Reachable whenever any scorer call fails, which the failure model
assumes they do.

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
  live proposals as `runPlan` does at `engine.ts:1009`). Exposed as the pure `scorersFor`
  so the rule is testable without a server. Scorers prefer a `fast`-tier member when one is
  available (§3.7.6) — 42 shallow, repetitive calls is precisely what that tier is for.
- **Ties are not resolved.** `tally()` returns `winner: null` within `TIE_MARGIN` by design
  — ties go to the human (`decide.ts:196`). At k=3 the means land on thirds, so exact ties
  are common and must be handled, not assumed away. Every tied answer is presented side by
  side and the report says the council did not converge. Manufacturing a winner from a tie
  would be the same false consensus in a different costume.
- **Cost:** N=14 → 14 proposals + 42 scores = 56 calls. All-pairs would be 182.
- **Dissent:** the runner-up and each scorer's `objection` are reproduced **verbatim**
  beneath the chosen answer.
- **Rendering:** new `renderTask(result)` in `report.ts` (§4) — no existing renderer covers
  this shape. It prints: the answer (or the tied answers, or all answers unranked), each
  one's `confidence` beside it, the ranked means, the runner-up and objections verbatim, and
  the "answered, but unscored" section. `confidence` has no effect on ranking; it is
  solicited so the human can weigh an answer the models themselves were unsure of, and this
  is its only consumer.
- **Artifact:** `council-artifacts/<stamp>-task/`.

### 3.5 New roles: `architect`, `infrastructure`

Both extend the `Role` union (`roster.ts:7-9`) and join `ALL_ROLES`. Foundation for
sub-projects 2/3's recruiting planner as well as council's own panel.

**Carriers** — a role no member carries is a silently empty lane:

| role | members | rationale |
|---|---|---|
| `architect` | `opus5`, `gpt56sol` | boundaries and sequencing. `opus5` reported 4/4 across every review round; `gpt56sol` is the `deep` tier, which is what an architecture judgement needs (§3.7.5) |
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
tier?: "deep" | "standard" | "fast"     // default "standard"
```

- `schema` — can emit forced-tool-call structured output.
- `agentic` — can drive tools in a session.

**`capability` is a real class, not a deepseek exception.** Two models now fail the same
way, and their errors name the cause exactly:

```
deepseek/deepseek-v4-pro                 400  Thinking mode does not support this tool_choice
opencode/muse-spark-1.2-contributor-free 400  only "auto" is supported for tool_choice.
                                              "none", "required", and named function
                                              choices are not currently supported
```

Both drive tools correctly under `tool_choice: auto`; both refuse a *named* function call.
That is the exact boundary between an implementer and a council lane.

**`tier` records the vendor's own capability/cost class** — for `gpt-5.6`: Sol is the peak
(deepest reasoning, slowest, dearest), Terra the balanced production default, Luna the fast
high-volume budget tier.

**`ms` must never be used to choose a tier.** It is documented as "for timeouts, not
quality", and this spec previously violated that: rev 7 selected Terra over Sol and Luna
because Terra returned a trivial probe fastest (2.7s vs 3.7s / 4.2s). Those numbers are
queue noise — **Luna, the tier explicitly built for speed, measured slowest of the three.**
A one-call probe cannot rank capability, and no future roster change may use it to try.

A set, not a single value: most members are both, and a single value would force demoting a
model out of council lanes to make it eligible as an implementer.

| member | roles | capability | basis |
|---|---|---|---|
| `deepseek` (`deepseek/deepseek-v4-pro`, **new**) | `[]` | `["agentic"]` | verified: drives bash, exact marker, 9.5s; fails forced `tool_choice` |
| `opus5`, `glm52` | unchanged | `["schema","agentic"]` | already used as crew implementers in live runs |
| `gpt56{sol,terra,luna}` | per §3.7.5 | `["schema","agentic"]` | schema verified today; agentic inherited from `gpt-5.5`'s live implementer use |
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

### 3.7 Dynamic roster: live catalog, measured capability, outage recruitment

The roster is fourteen hardcoded pins. Models move underneath them, and today's
measurements show both failure directions:

| measured 2026-08-25 | consequence |
|---|---|
| `openai/gpt-5.5` → `gpt-5.6-{luna,sol,terra}` all pass (2.7–4.2s) | the pin is a version behind |
| `google/gemini-3.7-flash` **times out at 90s**; `3.6-flash` answers in 9s | **"latest" is not "better"** — auto-upgrading would have silently degraded the panel |
| `opencode/hy3-free` fails schema 3/3; **`opencode-go/hy3` passes in 6.1s** | availability is not capability; the *route* was the problem |
| `opencode-go/muse-spark-1.2-contributor` → "collects data used to improve its quality" | gated behind consent only the human can give |

So: **discovery is automatic, capability is measured, adoption is human-gated.**

#### 3.7.1 Catalog — what exists right now

`GET /config/providers` returns every provider and model the server can currently reach
(verified: 9 providers, ~114 models). Fetched once per run, held in memory. This is the
difference between "in our list" and "actually reachable today".

#### 3.7.2 Capability cache — what a model can actually do

```
~/.cache/opencode-council/capability.json
{ "<provider>/<model>": { "schema": {ok, ms, at}, "agentic": {ok, at} } }
```

Measured by the same one-call smoke probe used throughout this session, never inferred:
`models.json`'s `structured_output` flag is already recorded in the README as unreliable in
both directions, and §3.6's whole existence is a case of a model that advertises one thing
and does another.

- A cache entry is authoritative until a call to that model fails in a way that contradicts
  it (`malformed`, `failed`), which invalidates the entry and forces a re-probe.
- An unknown model is probed **once**, immediately before first use, and the result is
  persisted. A failed probe is cached as failed — a dead model is not retried every run.
- `~/.cache` and not the repo: this is machine- and account-specific. A teammate's quota is
  not a fact about the code.

#### 3.7.3 Outage recruitment — requirement 2

`substitutesFor` (§3.6) keeps its existing three tiers over the roster, then gains a fourth:

```
1-3. roster: free-same-role → free-any-role → busy-same-role     (today)
4.   catalog ∩ capability[schema].ok, not benched                (new)
```

Tier 4 means a lane can be filled by a model **that is not in the roster at all** — the
`gpt-5.6-luna` and `-sol` siblings become live understudies for `terra` rather than three
correlated lanes. Preference inside tier 4: same provider family first (a sibling is the
nearest substitute), then any verified model, ordered by measured `ms`.

Bounded: **at most 3 probes per run**, so a bad day cannot turn one review into a
capability survey. When the budget is spent, tier 4 offers only already-verified models.

**`substitutesFor` stays pure — the pool is injected, never fetched.**

```ts
substitutesFor(node, round, bench, tried, extra: Member[] = [])   // tier 4 = `extra`
```

The caller resolves catalog ∩ capability and passes it in. Two reasons, and the second is
load-bearing:

1. `failover.test.ts:43` asserts that a fully-benched roster returns `[]` — "with nothing
   alive the lane is honestly lost, not faked". If `substitutesFor` fetched a catalog
   itself, that assertion would depend on live network state and the test would pass or fail
   by weather. With an injected pool, `extra: []` preserves today's exact semantics and
   tier 4 is tested by passing a fixture.
2. It keeps the one function that decides "who covers this lane" free of I/O.

`failover.test.ts:39,43` also hardcode the slug `gpt55`, which §3.7.5 splits into three.
**That is the one existing test this spec changes**, and it changes it by name only.

#### 3.7.4 `council:models` — requirement 1 and 3, human-gated

A new mode that discovers, measures, and **proposes**:

```
catalog → diff against roster → probe the candidates → table of measurements → you choose
```

It never writes the roster on its own. Model identity changes what the council *is*: swap a
member and every verdict afterwards comes from a different panel. `gemini-3.7-flash` is the
proof — an auto-updater would have adopted it and quietly lost a lane to timeouts.

Same detect-and-confirm shape as `crew:init`, which already proposes verify/base and waits.

#### 3.7.5 Roster changes proposed by today's measurements

| member | from | to | why |
|---|---|---|---|
| `gpt55` | `openai/gpt-5.5` | **split into three tiered members** — see below | Sol/Terra/Luna are capability tiers, not variants |
| `glm52` | `zai-coding-plan/glm-5.2` | `zai-coding-plan/glm-5.3` | newer, measured working at 6.0s |
| `hy3` | `opencode/hy3-free` | `opencode-go/hy3` | free route fails schema 3/3; paid route passes at 6.1s |
| `gemini36` | `google/gemini-3.6-flash` | **unchanged** | 3.7 times out at 90s |
| `musespark` | `opencode/muse-spark-…-free` | **`capability: ["agentic"]`**, no lane | its 400 names the cause: only `tool_choice: auto`. An implementer candidate, not a lane |
| `musespark-paid` | — | `opencode-go/muse-spark-1.2-contributor` **once opted in** | gated on a data-collection consent at `opencode.ai/workspace/wrk_01KXFV2S0SAC9S1FD2MQDA77XX/go` — the human's to give, not the crew's |

**The `gpt-5.6` tiers are three members doing three different jobs**, not three candidates
for one slot:

| member | model | tier | job |
|---|---|---|---|
| `gpt56sol` | `openai/gpt-5.6-sol` | `deep` | the lanes whose value is depth — `security`, `architect`, `systems` — and escalation diagnosis, which is "work out why this failed twice" |
| `gpt56terra` | `openai/gpt-5.6-terra` | `standard` | the production default: `reviewer`, `product`, `docs` |
| `gpt56luna` | `openai/gpt-5.6-luna` | `fast` | the two high-volume loops (§3.7.6). **Carries `skeptic`** — otherwise `skepticPool`, which filters on that role, could never reach a fast member and the tier routing would be unreachable code |

#### 3.7.6 Tier routing — where `fast` actually pays

Two loops in this system are high-volume, repetitive and shallow, which is Luna's stated
sweet spot:

| loop | volume | lever |
|---|---|---|
| skeptic verification | 3 per BLOCKER, 2 per SUGGESTION | `skepticPool` **slices** to `count`, so ordering genuinely selects who runs — `preferFast` pays here |
| `council:task` scoring (§3.4) | 45 calls per run — `N × k` | **no lever, by construction** — see below |

`skepticPool` selects a `fast`-tier member when one is available, falling back to current
behaviour otherwise.

**Correction, 2026-08-25 (found in implementation).** An earlier revision claimed the task
scoring pass could be routed to the fast tier the same way. It cannot. `scorersFor` is a
*cyclic* assignment: model *j* scores proposals *j-1, j-2, j-3* mod N, so **every model
scores exactly `k`, under any ordering of the input**. Sorting the per-proposal scorer list
changes only the order in which parallel calls are constructed; it shifts no volume and
saves nothing. Verified against the live roster: per-model scoring load is uniformly 3.

The only real lever there would be biasing `scorersFor`'s assignment itself, which would
trade away the property that makes it defensible — that every answer is judged by the same
number of peers, and every peer carries the same load. Uniform assignment is worth more than
the saving, so the cost of `council:task` stands at 15 proposals + 45 scores. Lane selection (`selectNodes`) is unchanged — a lane's model follows
its role, and roles are assigned per the table above.

This is the cost lever for §6's "most expensive path in the system": the scoring pass is
three quarters of `council:task`'s calls, and it is exactly the work a fast tier exists for.
Depth stays where depth is the point.

---

## 4. Interfaces — every file an implementer touches

| file | change |
|---|---|
| `src/roster.ts` | `Role` union +2; `Member.capability?`; new `deepseek` member (appended); `ROUTES` edits (§3.5); capability filter in `selectNodes`, `skepticPool` |
| `src/engine.ts` | **new** `runTask`, `TaskResult`, `TaskProposal`, `scorersFor`, `councilArgs`; capability filter in `substitutesFor` and in `runPlan`'s proposer pick; `substitutesFor` gains tier 4 over the catalog (§3.7.3) |
| `src/schema.ts` | **new** `TASK_PROPOSAL_SCHEMA`, `TASK_SCORE_SCHEMA`. Existing `PROPOSAL_SCHEMA`/`SCORE_SCHEMA` untouched, so `/council:plan` is unaffected |
| `src/report.ts` | **new** `renderTask(result)` |
| `src/decide.ts` | **unchanged** — `tally()` is reused as-is, which is why §3.4 constrains the score shape |
| `src/index.ts` | **the review/task call sites live here, not in engine.ts** — `:454` passes `roles: ALL_ROLES` and `maxRounds: 2`. Also: **`"task"` and `"models"`** added to the zod `mode` enum **and** to the inline `args:` TS union at `:369`; **`context` is a new zod field** — today's schema is `{mode, base, goal}` (`:356-366`), so only `goal` is reusable as-is; `runTask` and `council:models` dispatch + artifacts; line 355 text. Wire `context` through to `runIndependent` too, which has accepted it since `engine.ts:878` and has never been passed it (`:408`) |
| `src/catalog.ts` | **new file** (§3.7) — `catalog()` over `GET /config/providers`, plus the capability cache: read/write `~/.cache/opencode-council/capability.json`, `probe(model, kind)`, invalidate-on-contradiction, and the per-run probe budget. One file because discovery and capability answer the same question: what can actually be used right now |
| `src/catalog.test.ts` | **new file** — catalog parsing, cache round-trip and invalidation, probe budget, tier-4 substitution ordering |
| `command/council:models.md` | **new file** (§3.7.4) |
| `src/crew.ts` | **unchanged — deliberately.** Three claims rest on that: `KNOWN_ROLES` widens for free (§3.5), its `runReview` call must keep **both** defaults (§3.3), and deepseek must **not** be added to `CREW_MODELS` (§3.6). An implementer "helpfully" adding it there breaks the crew implementer path before sub-project 2 wires the `agentic` filter |
| `src/roster.test.ts` | role coverage derived from `KNOWN_ROLES` (§5); the `*.tf` routing and node-count test; the capability-filter assertions for `selectNodes`/`skepticPool` |
| `src/index.test.ts` | colon-name command registration (it already owns the identical crew test at `:65-73`); the five-old-names grep; `councilArgs` assertions |
| `src/crew.test.ts` | `KNOWN_ROLES` accepts `architect`, and every previously valid crew block still parses (it owns the `lanes: coed` rejection at `:615`) |
| `src/task.test.ts` | **new file** — `runTask` states and `scorersFor`. Must live in `src/`: `npm test` is `node --test src/*.test.ts` |
| `command/council-independent.md` | a **content** edit, not a rename: its closing paragraph steers "one answer rather than several" to `mode: "plan"`, which is stale once `council:task` exists; plus passing `context` |
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
| **`councilArgs()` returns `ALL_ROLES` and `maxRounds: 2`, and `council:review` reads it** | the "all models" requirement and the cost split — §3.3's entire rationale. Asserted through the pure `councilArgs` seam because the real call sites are unreachable without a live fan-out: `runReview` is a static import (`index.ts:6`) called inside `council.execute` (`:454`) and inside crew's non-exported `reviewBranch` (`crew.ts:1584`), the suite mocks nothing, and `tool.test.ts:14-15` states the rule — "Only paths that return BEFORE any model call are exercised here." `fix` is excluded deliberately: it has no lanes (§3.2) |
| **roster invariant:** every schema-capable member gets ≥1 node under `ALL_ROLES` | replaces the dead `everyModel` option; fails loudly if a roster change leaves a model unused |
| `DEFAULT_MAX_ROUNDS` is still `0`, and `crew.ts`'s `runReview` call still passes neither `maxRounds` nor `roles` | a source-text assertion, for the same absent-seam reason as the row above. A shared default would give every crew branch-review 2 rounds |
| **every `state === "ok"` proposal absent from `ranked` is printed under "answered, but unscored"** | otherwise a live answer whose scorers all failed vanishes from `decided`/`tied` reports entirely — silent omission, the class this command exists to prevent |
| `council:task` preserves runner-up and objections verbatim | the false-consensus failure it exists to prevent |
| **`council:task` returns the highest-mean proposal** — not the alphabetically first | the exact silent failure a mis-shaped score schema causes; asserts `tally()` is actually summing |
| `council:task` with a tie inside `TIE_MARGIN` returns `winner: null` and every tied answer | manufacturing a winner from a tie is false consensus |
| `council:task` assigns `min(3, N-1)` scorers, never the author, deterministic for a given roster order | cost bound, self-scoring rule, reproducibility |
| `council:task` with N=1 returns the sole proposal `unranked` | no scorer is possible |
| **`council:task` with N≥2 live answers but every scorer call failed returns `unranked`, not `tied`** | `tally([])` gives `winner: null, tied: []`, which is otherwise indistinguishable from a tie — the report would claim "did not converge" and show an empty list while N real answers exist |
| `architect` and `infrastructure` each resolve to ≥1 model — **by extending `roster.test.ts:70-72` to derive from `KNOWN_ROLES`** (`[...ALL_ROLES, "skeptic"]`, `crew.ts:38`) rather than adding a parallel test | that test hardcodes an 11-role list, so it would silently not cover the new roles and its name would lie about its coverage. It must **not** derive from `ALL_ROLES` alone: that set deliberately excludes `skeptic` (`roster.ts:59-62`), so doing so would delete the only assertion that any model carries the role `skepticPool`, `verifyGroup` and `fixOne`'s verifier all depend on |
| a `*.tf` diff routes to `infrastructure` and yields the same node count as today | the ops→infrastructure swap is a swap, not an addition |
| `selectNodes`, `skepticPool`, `substitutesFor`, `runPlan` never return an `agentic`-only member | deepseek in a schema lane fails every call |
| `runIndependent` **does** include the agentic-only member | the filter must not over-apply; prose is not structured output |
| `KNOWN_ROLES` accepts `architect`, and every previously valid crew block still parses | widening must not break existing repos |
| both new agent files register with `edit: deny`, `bash: deny` | `index.test.ts` asserts it for all but `crew-dev` |
| **§3.7** the capability cache round-trips, and an entry is invalidated by a contradicting `malformed`/`failed` result | a stale "works" entry would keep routing lanes into a model that stopped working |
| **§3.7** a failed probe is cached as failed and the model is not re-probed next run | a dead model must not cost a probe every run |
| **§3.7** substitution reaches tier 4 only after the roster tiers are exhausted, prefers the same provider family, then orders by measured `ms` | the roster stays the default panel; the catalog is the understudy bench, not a replacement |
| **§3.7** the probe budget caps at 3 per run | a bad day must not turn one review into a capability survey |
| **§3.7** `council:task` scoring and `skepticPool` select a `fast`-tier member when one exists, and fall back to today's behaviour when none does | the cost lever: scoring is 3/4 of `council:task`'s calls |
| **§3.7** `substitutesFor` with `extra: []` returns exactly what it returns today, including `[]` for a fully-benched roster | tier 4 must not make `failover.test.ts:43` depend on live network state |
| **§3.7** `council:models` writes nothing without confirmation | `gemini-3.7-flash` timing out at 90s is the standing proof that auto-adopting "latest" degrades the panel |

**No existing test is expected to break.** Checked: `failover.test.ts:10` (module-scope
`selectNodes(ALL_ROLES)`; the exhaustion assertion names members by slug and **must be
updated** when `gpt55` splits into the three tiers — the one existing test this spec
changes, whether
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
