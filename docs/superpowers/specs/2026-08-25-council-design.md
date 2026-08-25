# Council — design spec

**Date:** 2026-08-25 · **Status:** proposed · **Sub-project 1 of 3** (council → lets → crew)

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

| namespace | owns | attention |
|---|---|---|
| `/council:*` | advisory. Every model on one question, debate rounds, verified findings. | you ask, they answer |
| `/lets:*` | one task end to end: plan → execute → audit → commit → done | yours, at the gates |
| `/crew:*` | a directive: decompose, schedule, run N lets, integrate, report | none — autonomous |

**Model policy** (fixed by the human, 2026-08-25):

| stage | who | verified |
|---|---|---|
| council | every model, together, with debate | — |
| plan (lets/crew) | multi-model panel + recruited specialists | — |
| execute (lets/crew) | `deepseek/deepseek-v4-pro` | yes — drove bash, returned exact marker, 9.5s |
| audit (lets/crew) | multi-model, the recruited panel | — |

**Shared conventions** (apply to all three):

- ADRs at `docs/adr/YYYY-MM-DD-slug.md`, one file per decision. No sequential numbers —
  `0007-` allocation races when parallel lets write decisions concurrently. Date-slug
  matches the convention already in the human's repos.
- Research is browser-backed. `webfetch` works from spawned sessions (verified), MCP
  browser servers (playwright, chrome-devtools, puppeteer) are reachable from spawned
  sessions (verified). `websearch` is a valid permission key but **no such tool exists on
  this machine** (verified: a spawned session reports `NO-TOOL`).
- Anything learned online is cited in the ADR with its source URL.

---

## 2. Problem

What is wrong with the council as it stands:

1. **Namespace is inconsistent.** `council-review`, `check` — kebab and bare, while lets
   and crew will be colon-namespaced. Three conventions on one surface.
2. **Routing is wrong for an advisory body.** `selectRoles()` wakes only the lanes a
   diff's filenames implicate. That is correct cost control for lets and crew, and wrong
   for "my council", where the human wants every model on the question.
3. **Debate is built but off.** `DEFAULT_MAX_ROUNDS = 0`. It was disabled after measuring
   one round with six re-judgements and **zero changed positions**. The human wants
   iteration and debate on.
4. **No `council:task`.** There is no way to hand the council a task and get one converged
   answer. `independent` returns unmerged takes; `plan` votes between approaches.
5. **Missing specialists.** The recruiting planner (sub-project 2/3) must be able to
   recruit an architect and an infrastructure reviewer. Neither role exists.
6. **deepseek is excluded on false grounds.** README lists `deepseek/*` as excluded and
   recommends `opencode-go/deepseek-v4-pro` as the remedy. Verified 2026-08-25: the direct
   route drives tools correctly and the recommended remedy is dead ("only available hosted
   in China, requires explicit opt-in"). The real limitation is forced `tool_choice`
   (structured output), which an implementer never uses.

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
(`command/<name>.md` → `/<name>`), and colon names are proven to work in this build —
`kubernetes:cluster-health-check` is live.

**Migration hazard:** the human's global `~/.config/opencode/command/workflow.md` routes to
`/council-plan` and `/council-review`. Renaming breaks it. That file must be updated in the
same change, or the LETS stopgap silently points at commands that no longer exist.

### 3.2 Full panel by default

`council:*` commands select **all roles × all capable models**, ignoring glob routing.
`selectRoles()` stays in the codebase — lets and crew keep using it for cost control.

Consequence, stated plainly: a `council:review` becomes the most expensive operation in the
system (~19 nodes today, more with the new roles). That is what "turn on all models" means
and it is the intent, not an accident.

### 3.3 Debate and iterations

- `MAX_ROUNDS` becomes **2 for council paths**, staying **0** for lets/crew.
- The report gains a **debate effect** line: how many findings changed tier, and which.
  This is non-negotiable. Debate was disabled on evidence; turning it back on without
  measuring its effect would mean never learning whether it earns its cost. With the line,
  the next ten runs either justify it or retire it with data.

### 3.4 `council:task` (new)

Hand the council a task; every model works it **together**.

```
fan-out (all models, same task) → debate rounds → converge → one answer + recorded dissent
```

- Distinct from `independent` (raw takes, deliberately unmerged) and `plan` (scores
  competing approaches).
- Output is a single answer with **minority positions preserved verbatim**. A converged
  answer that hides its dissent is a false consensus.
- Convergence is computed, never declared: no position moved, or no disagreement remains,
  or the round cap trips — the same rule the review pipeline already uses.

### 3.5 New roles: `architect`, `infrastructure`

| role | owns | routing globs |
|---|---|---|
| `architect` | boundaries, sequencing, trade-offs, what not to build | (recruited, not glob-routed) |
| `infrastructure` | Terraform, cloud topology, network, IAM, blast radius | `*.tf`, `*.tfvars`, `k8s/**`, `Dockerfile`, `*.yaml` under infra paths |

Both get agent files under `agent/`, both join `ALL_ROLES`, and both are recruitable by the
lets/crew planner in sub-projects 2 and 3.

### 3.6 Roster: capability classes

The roster gains a capability field, because "is in the roster" currently conflates two
different abilities:

```ts
capability: "schema" | "agentic"   // default "schema"
```

- `schema` — can emit forced-tool-call structured output. Required for council lanes.
- `agentic` — can drive tools in a session. Required for the implementer.

`deepseek/deepseek-v4-pro` joins as `agentic`. It is barred from council lanes (it fails
the only thing they need) and is the designated implementer for lets and crew. The README's
exclusion table is corrected: the direct route works for agentic work; the `opencode-go`
route is dead.

---

## 4. Interfaces

- **Tool:** the `council` tool gains `mode: "task"`. Existing modes unchanged.
- **Commands:** five renamed files, one new file, under `command/`.
- **Config:** nothing new. No config migration.
- **Artifacts:** `council-artifacts/<stamp>-task/` for `council:task`, matching the
  existing kinds.

---

## 5. Testing

| what | why |
|---|---|
| every `council:*` command file registers under its colon name | the rename is the change; a typo'd filename is a silently missing command |
| council modes select all roles, ignoring globs | the "all models" requirement, which routing would otherwise quietly undo |
| lets/crew paths still route by glob and still use 0 rounds | the cost split is the point; a shared default would make every crew run cost a council run |
| `council:task` preserves dissent when models disagree | a converged answer that drops dissent is the failure mode this command exists to avoid |
| `architect` and `infrastructure` are answerable by ≥1 model | a role no model carries is a lane that silently never runs |
| a `schema`-only lane never selects an `agentic`-only model | deepseek in a council lane would fail every call |
| the implementer selects deepseek | the human's explicit policy |

---

## 6. Risks

| risk | mitigation |
|---|---|
| Full panel × 2 debate rounds on every council call is the most expensive path in the system | intended; `council:check` stays the cheap inline option |
| Debate may again change nothing | the debate-effect line makes it measurable rather than assumed |
| Rename breaks the human's `/workflow` command | update it in the same change; called out in §3.1 |
| More roles = more nodes = more malformed-output failures | failover already substitutes benched models; new roles inherit it |

---

## 7. Out of scope

`/lets:*` (sub-project 2) and `/crew:*` (sub-project 3): the session spine, beads task
state, the compaction hook, the recruiting planner, graph-gated parallelism, ADR and docs
gates. Each gets its own spec.
