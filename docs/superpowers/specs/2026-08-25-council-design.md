# Council — design spec

**Date:** 2026-08-25 · **Status:** proposed (rev 2, after spec review) · **Sub-project 1 of 3** (council → lets → crew)

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

### 1.1 What already exists (so no one plans against a blank slate)

`command/crew:{init,plan,execute,status}.md` are live, `src/crew.ts` is ~82KB, and the
`crew` tool is registered with modes `init|plan|run|status`. That pipeline — intake,
worktree, implement, verify, acceptance judge, commit, PR, escalation, termination floors —
**is the single-task workflow that sub-project 2 renames to `lets`.** Sub-project 3 then
builds a genuinely new, thin `crew` on top of it. Neither is in scope here; §3.5 and §3.6
touch shared foundations they will need, and say so where they do.

**Model policy** (fixed by the human, 2026-08-25):

| stage | who | verified |
|---|---|---|
| council | every model, together, with debate | — |
| plan (lets/crew) | multi-model panel + recruited specialists | — |
| execute (lets/crew) | `deepseek/deepseek-v4-pro` | yes — drove bash, returned exact marker, 9.5s |
| audit (lets/crew) | multi-model, the recruited panel | — |

**Shared conventions** (apply to all three):

- ADRs at `docs/adr/YYYY-MM-DD-slug.md`, one file per decision. No sequential numbers —
  `0007-` allocation races when parallel lets write decisions concurrently.
- Research is browser-backed. `webfetch` works from spawned sessions (verified). MCP
  browser servers (playwright, chrome-devtools, puppeteer) are reachable from spawned
  sessions (verified). `websearch` is a valid permission key but **no such tool exists on
  this machine** — a spawned session reports `NO-TOOL` (verified).
- Anything learned online is cited in the ADR with its source URL.

---

## 2. Problem

1. **Namespace is inconsistent.** `council-review`, `check` — kebab and bare, while
   `crew:*` is already colon. Three conventions on one surface.
2. **Routing is wrong for an advisory body.** `selectRoles()` wakes only the lanes a diff's
   filenames implicate — correct cost control for lets/crew, wrong for "my council".
3. **Debate is off.** `DEFAULT_MAX_ROUNDS = 0` (`engine.ts:566`), disabled after measuring
   one round, six re-judgements, **zero changed positions**. The human wants it on.
4. **No `council:task`.** No way to hand the council a task and get one converged answer.
   `independent` returns unmerged takes; `plan` scores competing approaches.
5. **Missing specialists.** The recruiting planner (sub-projects 2/3) must be able to
   recruit an architect and an infrastructure reviewer. Neither role exists.
6. **deepseek is excluded on false grounds** (`README.md:409`). Verified 2026-08-25: the
   direct route drives tools correctly; the recommended remedy `opencode-go/deepseek-v4-pro`
   is dead ("only available hosted in China, requires explicit opt-in"). The real limit is
   forced `tool_choice`, which an implementer never uses.

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

One name per thing; no aliases. Command names derive from the filename
(`command/<name>.md` → `/<name>`); `command/crew:plan.md` in this repo already proves colon
names register.

**Rename blast radius — every site, not just the obvious one:**

| file | sites |
|---|---|
| `command/check.md` | lines 24, 44, 73, 75, 85 — including its whole "Consistency contract with `/council-review`" section |
| `command/council-fix.md` | line 20 |
| `src/index.ts` | line 355 |
| `README.md` | ~10 sites |
| `~/.config/opencode/command/workflow.md` (**outside this repo**) | lines 19–20, 112, 116 — the human's LETS stopgap routes to `/council-plan` and `/council-review` |

A dangling cross-reference is the likely failure here, not a missing file, so §5 tests for
it directly.

### 3.2 Full panel by default

`council:*` selects **all lanes, and guarantees every capable model appears at least once.**

Mechanism — no new plumbing: `runReview` already accepts `roles?: Role[]`, and its own
comment (`engine.ts:576-583`) anticipates callers passing `ALL_ROLES`. Council call sites
pass it.

Per-role caps (`MODELS_PER_ROLE` security:3, `DEFAULT_MODELS_PER_ROLE` 2) are **unchanged**.
Caps alone do not guarantee "all models on one task" — a model whose every role is already
filled can be left out entirely. So `selectNodes` gains one option:

```ts
selectNodes(roles, { everyModel: true })   // council paths only
```

After normal selection, any schema-capable roster member with no node is appended to a role
it carries (or `reviewer` if none is free). Deterministic, ~5 lines, and it makes "turn on
all the models" literally true rather than approximately true.

Cost, stated plainly: ~19 nodes today, ~23 with the two new roles, every member present,
times up to 2 debate rounds. `council:check` remains the cheap inline path.

### 3.3 Debate and iterations

`DEFAULT_MAX_ROUNDS` stays **0**. Council call sites pass `maxRounds: 2` explicitly.

This matters: `crew.ts:1584` calls `runReview` **without** `maxRounds` and inherits the
default. Editing the constant would silently give every crew branch-review 2 rounds —
contradicting the cost split and the §5 test. The split lives at the call site or it is not
a split.

**Debate reporting already exists.** `report.ts:93-101` prints a `## Convergence` block —
rounds, the computed convergence reason, and per round `N re-judgements, M changed
position: model→tier`. No new work; the requirement is already satisfied. The
implementation task is to **verify it renders** once rounds > 0, since it has never run in
anger with the loop enabled.

Debate was disabled on evidence. Turning it on without watching that block would mean never
learning whether it earns its cost; with it, the next ten runs either justify the rounds or
retire them with data.

### 3.4 `council:task` (new)

Hand the council a task; every model works it, and one answer comes back.

**It does not reuse the debate loop, because that loop does not fit this data.**
`debateRound` (`engine.ts:495`), `applyRevisions`, and `converged` (`decide.ts:245`) are all
defined over `Group[]` of tiered `Finding`s — a `Revision` is `model→tier`. A free-form
answer has no tier, so there is nothing to converge. Inventing a prose-convergence
algorithm is out of scope and not required.

**It reuses the `runPlan` machinery instead**, which is already proposal-and-score:

```
every schema-capable model proposes an answer
        ↓
each proposal scored by k=3 other models   (never its own author; tally() drops self-scores)
        ↓
highest mean score wins → one answer, with dissent preserved verbatim
```

- **Interface:** `council` tool gains `mode: "task"`, taking the existing `goal` arg
  (`index.ts:382,406`) plus optional `context`. Command: `/council:task <what to work out>`.
- **Who runs it:** every schema-capable member proposes — this is a council command, so
  §3.2's "all models" applies. Roles come from the member's own first role, so each model
  answers in a voice it has a prompt for.
- **Why k=3 and not all-pairs:** `runPlan` scores every proposal by every other proposer.
  At 14 proposers that is 182 scoring calls. Each proposal is instead scored by 3 others,
  assigned round-robin so every model scores exactly 3 — 42 calls, deterministic, no
  sampling randomness.
- **Dissent is preserved, not summarised**: the runner-up proposal and every scorer's stated
  objection are reproduced verbatim under the chosen answer. A converged answer that hides
  its dissent is a false consensus, which is the failure this command exists to avoid.
- **Artifact:** `council-artifacts/<stamp>-task/`, matching the existing kinds.

### 3.5 New roles: `architect`, `infrastructure`

Both extend the `Role` union (`roster.ts:7-9`) and join `ALL_ROLES`. Foundation for
sub-projects 2/3 (the recruiting planner) as well as council's own panel — stated so it
does not read as scope leak.

**Carriers** — a role no member carries is a silently empty lane, so both are assigned:

| role | members | rationale |
|---|---|---|
| `architect` | `opus5`, `gpt55` | boundaries and sequencing; the two members that reported 4/4 across every review round |
| `infrastructure` | `glm52`, `grok45` | Terraform/cloud/network; spreads load off the architect carriers and across providers |

**Routing.** `architect` gets **no glob route** — it is recruited or full-panel only, since
no file extension implies "needs an architect". `infrastructure` replaces `ops` on the
routes where infrastructure is the more specific role, which keeps node count flat instead
of doubling it:

| glob | today | becomes |
|---|---|---|
| `**/{Dockerfile,docker-compose*,Makefile,*.tf}` | `ops, security` | `infrastructure, security` |
| `**/*.tfvars` · `**/k8s/**` · `**/{terraform,infra,infrastructure}/**` | *(unrouted)* | `infrastructure, security` (new entries) |
| `**/.github/workflows/**` | `ops, security` | unchanged — CI is ops |
| `**/*.{yml,yaml,toml,ini,conf}` · `**/.env*` | `ops, security` | unchanged |

Patterns keep the `**/`-prefix that `path.matchesGlob` requires against repo-relative paths;
a bare `*.tf` would not match `envs/prod/main.tf`.

**Blast radius into existing crew:** `crew.ts:38` defines
`KNOWN_ROLES = [...ALL_ROLES, "skeptic"]`, used to validate `lanes:` in a repo's crew block.
Adding two roles **widens** what is accepted. Existing configs stay valid; `lanes: architect`
becomes newly legal. Benign, but it is a change to shipped behaviour and is recorded here.

### 3.6 Roster: capability as a set

"In the roster" currently conflates two different abilities. The roster gains:

```ts
capability?: ("schema" | "agentic")[]   // default ["schema"]
```

- `schema` — can emit forced-tool-call structured output. Required for every council lane.
- `agentic` — can drive tools in a session. Required for the implementer.

A set, not a single value: most members are both, and a single value would force demoting a
model out of council lanes just to make it eligible as an implementer.

| member | capability | basis |
|---|---|---|
| `deepseek` (`deepseek/deepseek-v4-pro`, **new**) | `["agentic"]` | verified: drives bash, exact marker, 9.5s. Fails forced `tool_choice`. |
| `opus5`, `gpt55`, `glm52` | `["schema","agentic"]` | already used as crew implementers in live runs |
| all others | `["schema"]` (default) | agentic not verified; not claimed |

**Enforcement** — the field is inert unless something filters on it:

- `selectNodes` and `skepticPool` (`roster.ts:135`) select only members whose capability
  includes `"schema"`. Without this, deepseek lands in a council lane and fails every call.
- Implementer selection (sub-project 2) filters for `"agentic"`. Named here because §3.6
  exists to serve it; the selection itself is out of scope.

`README.md:409`'s exclusion table is corrected: the direct deepseek route works for agentic
work, and the `opencode-go` remedy it recommends is dead.

---

## 4. Interfaces

- **Tool:** `council` gains `mode: "task"` (args: `goal`, optional `context`). Existing
  modes unchanged.
- **Roster:** `Role` union +2; `Member.capability?: ("schema"|"agentic")[]`;
  `selectNodes(roles, opts?: { everyModel?: boolean })`.
- **Engine:** no signature changes — `runReview` already takes `roles` and `maxRounds`.
  Council call sites pass `ALL_ROLES` and `2`.
- **Commands:** five renamed files, one new, under `command/`; two new agent files under
  `agent/`.
- **Config:** nothing new. No migration.

---

## 5. Testing

| what | why |
|---|---|
| every `council:*` command registers under its colon name | a typo'd filename is a silently missing command |
| **no `/council-` or bare `/check` reference survives** in `command/`, `src/`, `README.md` | dangling cross-references are the likely rename failure, not missing files |
| council paths select all roles **and every capable model ≥ once** | the "all models" requirement, which caps would otherwise quietly undo |
| `crew`'s existing `runReview` call still gets 0 rounds and glob routing | a shared default would make every crew run cost a council run — the exact bug this design avoids |
| `council:task` preserves the runner-up and scorer objections verbatim | a converged answer that drops dissent is the failure mode it exists to prevent |
| `council:task` requests exactly 3 scorers per proposal, never the author | cost bound and the self-scoring rule |
| `architect` and `infrastructure` each resolve to ≥1 model | a role no model carries is a lane that silently never runs |
| a `*.tf` diff routes to `infrastructure`, and node count does not double | the ops→infrastructure swap, not an addition |
| `selectNodes` and `skepticPool` never return an `agentic`-only member | deepseek in a council lane fails every call |
| `KNOWN_ROLES` accepts `architect`, and every previously valid crew block still parses | widening must not break existing repos |

---

## 6. Risks

| risk | mitigation |
|---|---|
| Full panel × every model × 2 rounds is now the most expensive path in the system | intended; `council:check` stays the cheap option and the cost is stated, not hidden |
| Debate may again change nothing | the existing Convergence block makes it measurable; retire on data |
| `council:task` at 14 proposals + 42 scores is a long call | bounded by k=3; artifact written so a slow run is still recoverable |
| Rename breaks the human's `/workflow` command outside this repo | §3.1 enumerates it; update in the same change |
| More roles = more nodes = more malformed-output failures | failover already substitutes benched models; new roles inherit it |

---

## 7. Out of scope

`/lets:*` (sub-project 2) — renaming today's crew pipeline, the session spine
(`start`/`end`/`commit`/`done`), beads task state, the compaction hook, ADR and docs gates.

`/crew:*` (sub-project 3) — the recruiting planner, graph-gated parallelism across multiple
lets, integration, the CEO report.

Each gets its own spec. Foundations laid here for them — the two roles, the capability set —
are marked as such where they appear.
