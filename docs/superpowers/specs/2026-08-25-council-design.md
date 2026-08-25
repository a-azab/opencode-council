# Council — design spec

**Date:** 2026-08-25 · **Status:** proposed (rev 3, after two spec reviews) · **Sub-project 1 of 3** (council → lets → crew)

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

**Rename blast radius** — complete as of rev 3, with §5's grep as the backstop:

| file | sites |
|---|---|
| `command/check.md` | 24, 44, 73, 75, 85 (`/council-review` refs, incl. the "Consistency contract" section) **and 23, 78, 80** (`/check` self-references) |
| `command/council-fix.md` | 20 |
| `src/index.ts` | 355 (`"Use /check for a fast inline pass instead."`) |
| `README.md` | ~10 sites |
| `~/.config/opencode/command/workflow.md` (**outside this repo**) | 19–20, 112, 116 — the human's LETS stopgap |

### 3.2 Full panel by default

`council:*` passes `ALL_ROLES`, so every lane runs regardless of which files changed.

Mechanism — no new plumbing: `runReview` already accepts `roles?: Role[]` (`engine.ts:584`)
and its comment (576–583) names `ALL_ROLES` as the intended value. Council call sites pass
it.

Per-role caps (`MODELS_PER_ROLE` security:3, default 2) are **unchanged**, and no
`everyModel` option is added. Tracing `selectNodes(ALL_ROLES)` against the current roster
shows all 14 members already receive ≥1 node (a member passed over for one role arrives via
another), and that holds with the two new roles. An option guarding a condition that never
fires is dead code; the guarantee is enforced as a **roster invariant test** in §5 instead,
which fails loudly if a future roster change breaks it.

Cost, stated plainly: 19 nodes today, 23 with the new roles, × up to 2 debate rounds.
`council:check` remains the cheap inline path.

### 3.3 Debate and iterations

`DEFAULT_MAX_ROUNDS` stays **0**. Council call sites pass `maxRounds: 2` explicitly.

This matters: `crew.ts:1584` calls `runReview` **without** `maxRounds` and inherits the
default. Editing the constant would silently give every crew branch-review 2 rounds. The
split lives at the call site or it is not a split.

**Debate reporting already exists.** `report.ts:92-103` prints a `## Convergence` block —
rounds, the computed convergence reason, and per round `N re-judgements, M changed position:
model→tier`, or `(positions held)`. No new work; the implementation task is to **verify it
renders** with rounds > 0, since it has never run with the loop enabled.

Debate was disabled on evidence. Turning it on without watching that block would mean never
learning whether it earns its cost.

### 3.4 `council:task` (new)

Hand the council a task; every model works it, and one answer comes back with its dissent
intact.

**It does not reuse the debate loop.** `debateRound` (`engine.ts:495`), `applyRevisions`
and `converged` (`decide.ts:245`) are defined over `Group[]` of tiered `Finding`s — a
`Revision` is `model→tier`. A free-form answer has no tier. No prose-convergence algorithm
is invented here.

**It does not reuse `runPlan` either** — that was rev 2's error. `runPlan` picks proposers
from `PLANNING_ROLES`, one member per role, first match wins (`engine.ts:977-983`), so it
yields at most 5 proposers, and it scores all-pairs (`engine.ts:1012`). Both are wrong here.

**New engine export:**

```ts
export async function runTask(
  ctx: Ctx,
  input: { goal: string; context?: string },
): Promise<TaskResult>
```

```
every schema-capable member proposes an answer        (N proposals)
        ↓
each proposal scored by k = min(3, N-1) others        (N × k scores)
        ↓
highest mean score wins → one answer + dissent preserved verbatim
```

- **Proposers:** every member whose `capability` includes `"schema"` (§3.6) — this is a
  council command, so §3.2's "all models" applies. Each answers under
  `agent: council-${member.roles[0]}`, so it has a prompt in a voice it owns.
- **Scorer assignment — deterministic, stated in full.** Order proposals by their member's
  index in `ROSTER` (the roster's own order; not `ms`, which changes when re-measured).
  For proposal `i` of `N`, scorers are `(i+1) … (i+k) mod N` where `k = min(3, N-1)`.
  Cyclic-next can never select the author, since `k ≤ N-1`, and the `k = min(…)` clamp keeps
  it satisfiable when most nodes fail and `live` is small (`runPlan` filters to `live` at
  `engine.ts:1009`; `runTask` does the same). At N=1 there are no scorers and the single
  proposal is returned as the answer, flagged unscored.
- **Cost:** N=14 → 14 proposals + 42 scores = 56 calls. All-pairs would be 182.
- **Dissent:** the runner-up proposal and each scorer's `objection` are reproduced
  **verbatim** beneath the chosen answer. A converged answer that hides its dissent is a
  false consensus, which is the failure this command exists to prevent.
- **New schemas** (declared in §4, since `Score.reason` — "one sentence, the deciding
  factor" — is praise when the score is high, not an objection):

  ```
  TASK_PROPOSAL_SCHEMA  { answer, reasoning, confidence: high|medium|low }
  TASK_SCORE_SCHEMA     { score: 1-10, reason, objection }   // objection: "" when none
  ```

  `tally()` (`decide.ts:213`) is reused for the mean and already drops self-scores.
- **Artifact:** `council-artifacts/<stamp>-task/`.

### 3.5 New roles: `architect`, `infrastructure`

Both extend the `Role` union (`roster.ts:7-9`) and join `ALL_ROLES`. Foundation for
sub-projects 2/3's recruiting planner as well as council's own panel — stated so it does
not read as scope leak.

**Carriers** — a role no member carries is a silently empty lane:

| role | members | rationale |
|---|---|---|
| `architect` | `opus5`, `gpt55` | boundaries and sequencing; the two members that reported 4/4 across every review round |
| `infrastructure` | `glm52`, `grok45` | Terraform/cloud/network; spreads load off the architect carriers and across providers |

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
`*.tf` would not match `envs/prod/main.tf`. Verified flat: a `*.tf` diff yields
reviewer+infrastructure+security = 7 nodes, exactly as reviewer+ops+security does today.

**Blast radius into existing crew:** `crew.ts:38` defines
`KNOWN_ROLES = [...ALL_ROLES, "skeptic"]`, validating `lanes:` in a repo's crew block.
Adding two roles **widens** what is accepted — existing configs stay valid, `lanes: architect`
becomes newly legal. Benign, but it is a change to shipped behaviour.

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

**Where the filter goes — the rule is "wherever a schema is passed to `ask()`", not
everywhere:**

| site | passes a schema? | filter |
|---|---|---|
| `selectNodes` (`roster.ts:118`) | yes — `FINDINGS_SCHEMA` | **required** |
| `skepticPool` (`roster.ts:135`) | yes — skeptic schema | **required** |
| `substitutesFor` (`engine.ts:400`) | yes — feeds the schema fan-out | **required** |
| `runPlan` proposers (`engine.ts:978`) | yes — `PROPOSAL_SCHEMA` | **required** |
| `runTask` proposers (new, §3.4) | yes | **required** |
| `runIndependent` (`engine.ts:889`) | **no** — `ask<string>`, prose read from message parts | **none** — and deepseek *should* answer here |
| `diagnose` (`crew.ts:1322`) | **no** — `ask<string>`; also role-filtered | none |

That distinction is the whole point: deepseek's limitation is structured output, not
inference, so `/council:independent` gains its take rather than losing it.

`README.md:409`'s exclusion table is corrected: the direct route works for agentic work; the
`opencode-go` remedy it recommends is dead.

---

## 4. Interfaces

- **Tool:** `council` gains `mode: "task"` (args: existing `goal`, optional `context`).
- **Engine:** **new export** `runTask(ctx, {goal, context?}) → TaskResult`. No signature
  changes to `runReview`/`runPlan`/`runIndependent`.
- **Schemas:** **new** `TASK_PROPOSAL_SCHEMA`, `TASK_SCORE_SCHEMA` (§3.4). Existing
  `PROPOSAL_SCHEMA`/`SCORE_SCHEMA` untouched, so `/council:plan` is unaffected.
- **Roster:** `Role` union +2; `Member.capability?: ("schema"|"agentic")[]`; new `deepseek`
  member; `ROUTES` edits per §3.5.
- **Commands:** five renamed files, one new, under `command/`.
- **Agents:** two new files `agent/council-{architect,infrastructure}.md`. Both must carry
  the default `edit: deny` / `bash: deny` — `index.test.ts:50-54` asserts that for every
  registered agent except `crew-dev`.
- **Config:** nothing new. No migration.

---

## 5. Testing

| what | why |
|---|---|
| every `council:*` command registers under its colon name | a typo'd filename is a silently missing command |
| no **`/council-`** or **`/check`** reference survives in `command/`, `src/`, `README.md` | dangling cross-references are the likely rename failure. The leading slash is required: bare `council-` matches the 12 unchanged `agent/council-*.md` files and the `council-${role}` literals at `engine.ts:505,990`, and would fail on correct code |
| council paths select all roles | the "all models" requirement, which routing would otherwise quietly undo |
| **roster invariant:** every schema-capable member gets ≥1 node under `ALL_ROLES` | replaces the dead `everyModel` option; fails loudly if a roster change ever leaves a model unused |
| `crew`'s existing `runReview` call still gets 0 rounds and glob routing | a shared default would make every crew run cost a council run |
| `council:task` preserves runner-up and objections verbatim | the false-consensus failure it exists to prevent |
| `council:task` assigns `min(3, N-1)` scorers, never the author, deterministic for a given roster order | cost bound, self-scoring rule, and reproducibility |
| `council:task` with N=1 returns the sole proposal flagged unscored | the degenerate case is reachable when most nodes fail |
| `architect` and `infrastructure` each resolve to ≥1 model | a role no model carries never runs |
| a `*.tf` diff routes to `infrastructure` and yields the same node count as today | the ops→infrastructure swap is a swap, not an addition |
| `selectNodes`, `skepticPool`, `substitutesFor`, `runPlan` never return an `agentic`-only member | deepseek in a schema lane fails every call |
| `runIndependent` **does** include the agentic-only member | the filter must not over-apply; prose is not structured output |
| `KNOWN_ROLES` accepts `architect`, and every previously valid crew block still parses | widening must not break existing repos |
| both new agent files register with `edit: deny`, `bash: deny` | `index.test.ts` asserts it for all but `crew-dev` |

---

## 6. Risks

| risk | mitigation |
|---|---|
| Full panel × every model × 2 rounds is now the most expensive path in the system | intended; `council:check` stays cheap and the cost is stated, not hidden |
| Debate may again change nothing | the existing Convergence block makes it measurable; retire on data |
| `council:task` at 56 calls is a long run | bounded by `k=3`; artifact written so a slow run is recoverable |
| Rename breaks the human's `/workflow` command outside this repo | §3.1 enumerates it; update in the same change |
| More roles = more nodes = more malformed-output failures | failover already substitutes benched models; new roles inherit it |

---

## 7. Out of scope

`/lets:*` (sub-project 2) — renaming today's crew pipeline, the session spine
(`start`/`end`/`commit`/`done`), beads task state, the compaction hook, ADR and docs gates.

`/crew:*` (sub-project 3) — the recruiting planner, graph-gated parallelism across multiple
lets, integration, the CEO report.

Foundations laid here for them — the two roles, the capability set, the implementer
designation — are marked as such where they appear.
