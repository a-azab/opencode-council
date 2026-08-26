# `/lets` — design spec

**Date:** 2026-08-25 · **Status:** proposed · **Sub-project 2 of 3** (council → **lets** → crew)

---

## 1. Where this sits

| namespace | owns | attention | state |
|---|---|---|---|
| `/council:*` | advisory — every model on one question, debate, verified findings | you ask, they answer | **shipped** 2026-08-25 |
| `/lets:*` | **one task, end to end** — start → plan → execute → audit → commit → done → end | yours, at the gates | this spec |
| `/crew:*` | a directive — decompose, schedule, run N lets, integrate, report | none, autonomous | sub-project 3 |

**The core fact this spec turns on:** the pipeline currently called `crew` — intake, worktree,
implement, verify, acceptance judge, commit, PR, escalation, termination floors — **is
already `lets`.** It is a single-task attended workflow wearing the wrong name. Sub-project 3
then builds the real `crew` (an orchestrator of several lets) on top of it.

So this sub-project is: **a rename, plus the spine that was never built.**

| | |
|---|---|
| **rename** | `crew:{plan,execute,status,init}` → `lets:{plan,execute,status,init}`, `src/crew.ts` → `src/lets.ts`, the `crew` tool → `lets` |
| **new spine** | `lets:start`, `lets:commit`, `lets:done`, `lets:end` |
| **new state** | beads as a tracker implementation |
| **new gates** | ADR per plan, docs per behaviour change |
| **new hook** | context survives compaction |

---

## 2. Problem

1. **No session spine.** There is no `start` (restore context, pick a task, cut a branch), no
   `end` (snapshot), no `commit`/`done` for work the human wrote by hand. The pipeline can
   only commit code *it* wrote. The human's own `~/.config/opencode/command/workflow.md`
   implements `start/status/note/end` in shell as a stopgap — that file is a bug report.
2. **No task identity.** A run's plan lands in `council-artifacts/<stamp>-crew-plan/plan.json`
   and is found again by "newest directory on disk wins". Nothing ties a run to a unit of
   work that outlives it.
3. **Beads is the human's real tracker and the crew ignores it.** `bd` is installed
   (`/root/.nix-profile/bin/bd`), `.beads/` exists in two repos, `oci-infrastructure` has 6
   open issues, and the git log is full of `bd:` commits. PLAN.md §2 excluded beads on the
   stated premise "Not installed" — that premise was false or went stale, and was never
   rechecked. Meanwhile a Linear client was built (~300 lines) that has never run once.
4. **Nothing survives compaction.** opencode exposes an
   `experimental.session.compacting` plugin hook. The plugin uses zero hooks, so a long
   session loses which task it is on.
5. **The name is taken.** `crew` cannot mean both "one task" and "an organisation running
   many tasks".

---

## 3. Design

### 3.1 Command surface

| command | what it does | today |
|---|---|---|
| `/lets:init` | detect and record config (verify, base, lanes, tracker) | `crew:init`, renamed |
| `/lets:start` | restore last session, list open beads, take one, cut `feature/<id>-<slug>` | **new** |
| `/lets:plan <directive>` | multi-model intake → work items → ADR draft → gate | `crew:plan`, + ADR |
| `/lets:execute` | implement in a worktree, verify, audit, commit per item, PR | `crew:execute`, + gates |
| `/lets:commit` | conventional commit for hand-written work, linked to the bead | **new** |
| `/lets:done` | push, open the PR, close the bead | **new** |
| `/lets:end` | write a session snapshot | **new** |
| `/lets:status` | branch, bead, worktrees, where you left off | `crew:status`, + bead |

`src/crew.ts` becomes `src/lets.ts`; the `crew` tool becomes `lets`; `agent/crew-*.md`
become `agent/lets-*.md`. The rename is mechanical and follows exactly the pattern that
worked for council in sub-project 1 — including a grep test that fails on any surviving
pre-rename reference, matching **exact command names** rather than a prefix.

### 3.2 Beads is a tracker, not a second system

The tracker seam already built (`Tracker` interface, `stdoutTracker`, `guarded()`,
`fanout()`, `availableTrackers()`, `trackerFor()`) takes a new implementation:

```
tracker: beads
```

- **Available when** `bd` resolves on `PATH` **and** the repo has a `.beads/` directory.
  Both are cheap to check and both must hold — `bd` without a `.beads/` means the repo is
  not tracked, and offering it would create a database uninvited.
- **Everything already guaranteed by the seam still holds:** a tracker cannot break a run
  (`guarded()` turns any throw into one warning line), and `fanout()` means the terminal
  still reports even when beads is on.

**Beads would be the first tracker actually usable on this machine** — Linear needs a token
nobody has, and the configured MCP servers are a browser, a k8s client and Chrome DevTools.

**Interface, verified 2026-08-25:**

| need | command |
|---|---|
| list open work | `bd list --json` |
| read one | `bd show <id> --json` |
| create | `bd create --description --acceptance --design --deps 'blocks:<id>'` |
| progress | `bd note <id>` |
| take / release | `bd update <id> --status in_progress` |
| finish | `bd close <id>` |

`--json` exists on `list` and `show`, so state is parsed, never scraped.

### 3.3 One bead per task — not one per work item

`lets:start` takes or creates **exactly one** bead: the task. Work items from `lets:plan`
stay in `plan.json` and appear on the bead as notes.

Rationale, and it is a YAGNI call worth stating: `bd create --deps 'blocks:<id>'` makes a
child-bead-per-work-item tempting, and `WorkItem {title, detail, files, acceptance}` maps
almost exactly onto `bd create --description --acceptance`. But work items are *execution
detail* — they change on re-plan, they are meaningless a week later, and filling someone's
tracker with them is noise. A task is the unit a human tracks across sessions; a work item
is not.

Sub-project 3 is where child beads earn their place: `crew` decomposes a directive into
several **lets**, and those are real, parallel, and need a dependency graph. The `--deps`
capability is noted here and deliberately left unused.

### 3.4 The session spine

**`lets:start`**
1. Read the last snapshot, if any (§3.6), and say what it was.
2. `bd list --json` → show open beads, ready ones first.
3. The human picks one, or gives a title to create one.
4. `bd update <id> --status in_progress`.
5. Cut `feature/<id>-<slug>` from the configured base.
6. Print what to do next.

**`lets:commit`** — for work the human wrote by hand. Reviews the diff, writes a
conventional commit, and links it to the bead. The repo's existing convention is followed,
not invented: `fix: pin config_file_profile in all remaining root modules (bd 50o)`. Read
the last 20 subjects and match the dominant shape rather than imposing one.

**`lets:done`** — push, open the PR, `bd close <id>`. In a repo with no remote the branch
stays local and the report says so plainly, which is already how `renderRun` handles a
failed push.

**`lets:end`** — write the snapshot (§3.6) and stop.

### 3.5 ADR and docs as gates, not requests

The hard lesson of this codebase is that a sentence in a prompt is not a guarantee — the
worker's confinement was documented as true for a week while being false. So:

| gate | enforcement |
|---|---|
| **ADR per plan** | `lets:plan` writes `docs/adr/YYYY-MM-DD-<slug>.md` — context, decision, alternatives rejected, and **the URLs any research consulted**. `lets:execute` refuses to start without it on disk. |
| **Docs per behaviour change** | an item whose diff changes behaviour must touch docs; the acceptance judge fails it otherwise. An item may opt out — and the opt-out is **printed in the report**, never silent. |

ADR filenames are date-slug, never sequential: `0007-` allocation races the moment
sub-project 3 runs several lets at once. This convention is already established by
`docs/adr/2026-08-25-council-namespace-and-dynamic-roster.md`.

**Research** uses `webfetch` (verified working from spawned sessions) and the configured
browser MCP servers — playwright, chrome-devtools and puppeteer are all reachable from a
spawned session (verified). `websearch` is a valid permission key but **no such tool exists
on this machine**; a spawned session reports `NO-TOOL`.

### 3.6 Surviving compaction

Two mechanisms, and they are different:

- **`experimental.session.compacting`** — the plugin hook opencode documents. On compaction
  it pushes the current task line into the continuation context: bead id and title, branch,
  the plan's item count and how many have landed, the worktree path.
- **A snapshot file** at `.opencode/lets/sessions/<stamp>-<branch>.md`, written by
  `lets:end` and read by `lets:start`. This is what survives a *new conversation*, which
  the hook cannot reach.

The snapshot is deliberately the same shape the human's `workflow.md` stopgap already
writes, so `/lets:start` can read the snapshots that file has been producing, and the
stopgap can be deleted rather than stranded.

### 3.7 Model policy — unchanged from the agreed architecture

| stage | who | evidence |
|---|---|---|
| plan | multi-model panel, never a single model | human's directive |
| execute | **`deepseek/deepseek-v4-pro`** | verified: drove bash, exact marker, 9459ms |
| audit | multi-model | human's directive |

deepseek is already in the roster as `capability: ["agentic"]` with `roles: []`. This
sub-project adds it to the implementer pool — `CREW_MODELS` (to be renamed `LETS_MODELS`)
is slug-based, so it must be added there **behind a `canAgentic` filter**, which
sub-project 1 deliberately left undone.

---

## 4. Interfaces — every file touched

| file | change |
|---|---|
| `src/crew.ts` → `src/lets.ts` | renamed; `KNOWN_ROLES` already moved out to `roster.ts` |
| `src/lets.ts` | `+ startSession`, `+ commitWork`, `+ finishTask`, `+ snapshot`; beads tracker; ADR/docs gates; `CREW_MODELS` → `LETS_MODELS` behind `canAgentic` |
| `src/beads.ts` | **new** — `bdAvailable(root)`, `list`, `show`, `create`, `note`, `take`, `close`. Shells out to `bd`, parses `--json`. One file, mirroring `src/linear.ts`'s shape |
| `src/index.ts` | `crew` tool → `lets`; new modes `start`/`commit`/`done`/`end`; the compaction hook |
| `command/crew:*.md` → `command/lets:*.md` | renamed, plus four new command files |
| `agent/crew-*.md` → `agent/lets-*.md` | renamed |
| `src/beads.test.ts` | **new** |
| `src/lets.test.ts` | renamed from `crew.test.ts` |
| `README.md`, `AGENTS.md` | the crew block's `tracker:` gains `beads`; the whole `/lets` surface |
| `~/.config/opencode/command/workflow.md` | **deleted** once `/lets:start` reads its snapshots — it is the stopgap this replaces |

---

## 5. Testing

| what | why |
|---|---|
| no pre-rename `crew:` command name survives in `command/`, `src/`, `README.md` | the rename's real failure mode is a dangling reference, exactly as in sub-project 1 |
| every `lets:*` command registers under its colon name | a misnamed command file is silently absent, never an error |
| `beads` is offered only when `bd` resolves **and** `.beads/` exists | offering it otherwise would create a database uninvited |
| a beads tracker failure costs a warning line, never the run | `guarded()` already guarantees this; the test pins that beads goes through it |
| `bd` output is parsed from `--json`, never from the table format | the human-facing table is not an interface and will change |
| `lets:execute` refuses to start when the plan's ADR is absent | a gate that can be skipped is a request |
| an item that changes behaviour without touching docs fails acceptance, **and** an opt-out is printed | the opt-out must never be silent |
| the compaction hook emits the bead id, branch and item counts | the one thing that must survive is which task this is |
| `lets:start` reads a snapshot written by the old `workflow.md` format | the stopgap is replaced, not stranded |
| the implementer pool selects deepseek and never a schema-only model for the agentic role | the model policy, and the filter sub-project 1 left undone |

---

## 6. Risks

| risk | mitigation |
|---|---|
| The rename is large and touches an 82KB file | it is mechanical, and sub-project 1 proved the grep-test approach on the same shape |
| `bd` may behave differently across versions | parse `--json` only; treat any non-zero exit as "tracker unavailable", which `guarded()` already degrades safely |
| ADR gate blocks a trivial fix | the opt-out exists and is reported; the gate is on *behaviour* change, not on every diff |
| Beads writes to a real database the human owns | only ever on an explicit `lets:*` action, never on plan; `bd create` is the only write that invents anything, and it happens at `start` with the human choosing |

---

## 7. Out of scope

`/crew:*` (sub-project 3) — the recruiting planner, graph-gated parallel lets, integration,
the CEO report, and the child-bead dependency graph §3.3 leaves deliberately unused.
