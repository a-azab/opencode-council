# `/crew` — the autonomous delivery org

**Date:** 2026-08-26 · **Status:** proposed · **Sub-project 3 of 3** (council → lets → **crew**)

---

## 1. What crew is, in the human's words

> *"research and design the best way and the best architecture and execute to deliver what I
> instruct them, with a minimum human interaction. They might ask for clarification to
> finalise or collect all the requirements from me to finalise the plan before the
> execution, but they execute on themselves."*
>
> *"They have their own decisions and they are recorded like normal employees who can work,
> validate and test everything without my permission."*
>
> *"I would be the CEO and give the task to organizations and they come back with the final
> output."*

So the distinguishing axis is **not** "one task vs many". It is **where the human sits**:

| | requirements | planning | execution | your involvement |
|---|---|---|---|---|
| **`/lets`** | you state them | **you approve the plan** | unattended | a gate before work starts |
| **`/crew`** | **it interviews you** | decides for itself | unattended | answer questions, then read the record |

`/lets` already ships and is correct for its role. Crew moves the single human touchpoint
*earlier* — from approving a plan to answering questions — and replaces the approval gate
with an **audit trail**.

## 2. The record is the whole safety story

If nobody approves the plan, the only thing between the human and a bad decision is whether
the report honestly says what happened. Every honesty property already built becomes
load-bearing rather than decorative:

- acceptance judged by a **different model** than the implementer, and items nothing judged
  print **"NOT independently judged"** rather than looking clean
- items that never ran report `not-attempted` **against the whole plan**, so a run that
  stopped at task 2 of 6 cannot look like a success
- termination floors that stop and **say why in prose**
- failed lanes substituted and **named as stand-ins**, with correlation flagged when a
  stand-in was already answering another lane
- an ADR per decision, recording alternatives rejected and **the sources research consulted**

An employee you do not supervise is only safe if the write-up is trustworthy. That is why
this sub-project adds almost no new honesty machinery — it inherits it, and its job is to
not undermine it.

---

## 3. Design

### 3.1 Commands

| command | what it does |
|---|---|
| `/crew:plan <directive>` | interview → research → design → decompose → ADR → `plan.json`. **No approval gate.** |
| `/crew:execute` | run the tasks, integrate, review, report |
| `/crew:status` | which waves ran, which are running, where the worktrees are |

### 3.2 The interview — the one human touchpoint

`crew:plan` opens by **asking**, using the `question` tool (the convention
`skills/lets-commit/SKILL.md` and `command/lets:done.md` already establish).

It asks only what it cannot determine itself. Before asking anything it reads the repo:
`graphContext()`, the stack detection `proposeInit` already does, `AGENTS.md`, and the git
log. A question whose answer is in the repo is a question that wastes the human's turn.

**Bounded:** at most **two rounds** of questions, at most **four** questions per round.
An interview that cannot converge in two rounds is a directive too vague to execute, and
the honest response is to say so and stop — not to keep asking, and not to guess.

**Recorded:** every question and answer lands in the ADR. That is the requirements record,
and it is what makes "it decided for itself" reviewable afterwards.

### 3.3 Research and design, with recruited specialists

After requirements are pinned:

1. **Research** — `webfetch` and the browser MCP servers (playwright, chrome-devtools,
   puppeteer are all reachable from spawned sessions; **`websearch` does not exist on this
   machine** and a spawned session reports `NO-TOOL`). Every fact learned online is cited in
   the ADR with its URL.
2. **Recruit** — the panel is chosen for *this* directive, not fixed. A deterministic floor
   from the repo's stack and the directive's keywords (`*.tf` → `infrastructure`; auth,
   secrets, crypto → `security`), plus model-proposed additions each carrying a stated
   reason, capped. `architect` and `infrastructure` roles exist for exactly this.
3. **Design** — the recruited panel produces the architecture. Competing approaches are
   scored by `runPlan`'s existing cross-model vote rather than a new mechanism.
4. **ADR** — `docs/adr/YYYY-MM-DD-<slug>.md`: the interview, the decision, the alternatives
   rejected, the research sources. Written **before** execution starts, because a decision
   recorded after the fact is a justification, not a record.

### 3.4 Decompose into tasks, then schedule by the graph

The plan is a list of **tasks**, each of which is a `lets`-shaped unit: a set of
`WorkItem`s with `files` and `acceptance`.

**Scheduling is graph-gated**, which is the human's explicit choice: two tasks may run
concurrently **only when their file sets are provably disjoint**. Disjointness is computed
from `item.files` unioned with the graph's neighbours for those files — a task that edits
`a.ts` conflicts with one that edits `a.ts`'s importers, even though the filenames differ.

Tasks are grouped into **waves**. Everything in a wave runs concurrently; waves run in
order. A task whose files overlap anything earlier lands in a later wave.

**When the graph is stale or absent, the schedule degrades to a single sequential wave** and
says so. Guessing at disjointness without the graph is exactly the failure mode
`graph-gated` exists to avoid.

### 3.5 Running a wave

`runExecute` is already self-contained: it opens its own worktree, runs its items
sequentially, verifies, judges acceptance, commits, and returns a `RunResult`. **Crew
therefore parallelises by calling it N times concurrently with disjoint item sets** — no
restructuring of the pipeline.

Two concurrency hazards, both real:

- **`git worktree add` takes a repository lock.** Concurrent calls can fail. Worktree
  *creation* must be serialised even though the work is parallel.
- **Slug collision.** `runExecute` derives its slug from a timestamp with a collision loop;
  two runs starting in the same second can race that check. Crew passes an explicit,
  distinct slug per task rather than letting two runs compute the same one.

Both need the `runExecute` signature to accept a caller-supplied slug. That is the only
change to the lets pipeline this sub-project makes, and it is additive.

### 3.6 Integration

Each task returns its own branch. Crew then, in wave order:

1. creates an integration branch from `cfg.base`
2. merges each task branch into it, in a deterministic order
3. on a **conflict**, stops and reports — it does not resolve conflicts unattended. A
   conflict means the disjointness analysis was wrong, and silently resolving one would
   destroy the evidence that the scheduler needs fixing.
4. runs `verify` on the integrated result — because N individually-green branches can be
   collectively red, which is the whole reason integration is a step rather than an
   assumption

### 3.7 Review and report

- The integrated branch goes through `runReview` with the **recruited panel** — whoever
  designed the infrastructure change audits it.
- Blockers become new work items and re-enter execution, bounded by the existing
  `MAX_REVIEW_CYCLES`.
- The **CEO report** closes it: what shipped, what it decided and why (linking the ADR),
  what it could not do, what needs the human. It inherits `renderRun`'s honesty rules —
  incomplete is reported as incomplete, and a push that failed says the branch is local.

---

## 4. Interfaces

| file | change |
|---|---|
| `src/crew.ts` | **new** — interview, recruit, schedule (waves), run, integrate, report |
| `src/lets.ts` | `runExecute` accepts an optional caller-supplied `slug`; worktree creation serialised behind a lock |
| `src/index.ts` | new `crew` tool with modes `plan \| execute \| status`; artifact kinds `crew-plan` / `crew-run` |
| `command/crew:{plan,execute,status}.md` | **new** |
| `command/lets:team.md` | currently says crew does not exist — must be updated when it does |
| `src/crew.test.ts` | **new** |
| `README.md`, ADR | the third namespace |

---

## 5. Testing

| what | why |
|---|---|
| the scheduler puts overlapping tasks in different waves, and disjoint ones in the same wave | the core claim; wrong here means concurrent edits to one file |
| overlap is computed through the graph, not just literal filenames | a task editing an importer of `a.ts` conflicts with one editing `a.ts` |
| a stale or absent graph degrades to one sequential wave, and says so | guessing at disjointness is the failure this design exists to prevent |
| each task gets a distinct slug, even when two start in the same second | a collision silently puts two runs in one worktree |
| worktree creation is serialised | `git worktree add` takes a repo lock |
| a merge conflict stops integration and reports, never auto-resolves | a conflict is evidence the scheduler was wrong; resolving it destroys that evidence |
| `verify` runs on the **integrated** branch, not just per task | N green branches can be collectively red |
| the interview stops after two rounds and says the directive is too vague | an unbounded interview is a worse gate than the one it replaces |
| the ADR exists before execution begins | a record written afterwards is a justification |
| an incomplete run reports incomplete | inherited from `renderRun`, and the property the whole design rests on |

---

## 6. Risks

| risk | mitigation |
|---|---|
| Parallel agents are the documented failure mode (MAST: 41–86% failure across 7 frameworks) | the graph gate is the answer: concurrency **only** where files are provably disjoint, never speculative |
| A wrong disjointness call corrupts a merge | conflicts stop the run rather than being resolved; the scheduler is then wrong and visibly so |
| No approval gate means a bad plan executes | the interview is the gate, moved earlier; the ADR and the report are the review, moved later |
| Cost: N concurrent lets runs, each with intake, implementation and acceptance | waves are bounded; `MAX_RUN_SECONDS` already exists and applies per task |
| Integration of many branches is where multi-agent systems fail | integration is explicit, ordered, verified, and stops on conflict |

---

## 7. Out of scope

`github-pr` (needs a repo with a remote), `statusline`, and any autonomous *re-planning*
beyond the existing review-cycle bound. Crew asks once, executes, and reports; it does not
loop back to the human mid-run.
