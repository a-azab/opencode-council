# opencode-council

Multi-model code review for [opencode](https://opencode.ai), and the workflows that do the
building — three tools, `council`, `lets` and `crew`, shipped as one plugin.

Fifteen models review your diff in parallel, each in the role it is assigned. Every finding
is then challenged by independent skeptics that did not raise it, and what survives is
decided by arithmetic — not by asking a model to summarise.

**No single model decides anything.** Dedupe, dispute detection, convergence, and
keep/downgrade/drop are all computed in code you can read and test.

## Three namespaces, differing by where you sit

|  | requirements | planning | execution |
|---|---|---|---|
| **`/council:*`** | — | advisory only: every model on one question, disputes debated, findings verified | — writes no code |
| **`/lets:*`** | you state them | **you approve the plan** | unattended, one task |
| **`/crew:*`** | **it interviews you** | it decides for itself | unattended, N tasks in waves |

Largely the same machinery, with the human standing in a different place. `/lets` puts you
at a planning gate. `/crew` removes that gate and puts an **audit trail** where it was: an
ADR written *before* the run, recording what it asked you and what it decided, and a report
afterwards that is the only account of what happened. That swap is what the rest of crew's
design is in service of — with nobody approving the plan, the record is the whole safety
story.

---

## Why

Two existing approaches, each missing what the other has:

|  | [lets-workflow](https://github.com/restarter/lets-workflow) | typical multi-model council |
|---|---|---|
| axis | 15 **roles**, one model | N **models**, one shared prompt |
| loop | none — fixed-depth pipeline | usually none |
| aggregation | a moderator model's judgement | a moderator model's judgement |
| verifies a fix | never | never |

This is the synthesis: **role × model**, with a bounded convergence loop, deterministic
aggregation, and a fix loop that produces reviewable patches.

The specific thing that motivated it: aggregation-by-model-judgement means a review's
conclusions depend on one model's summary of other models' prose. Structured output makes
that unnecessary — findings arrive as data, so the aggregation can be a function.

---

## Install

Requires opencode ≥ 1.18 (developed against 1.18.13). The plugin itself runs on opencode's
bundled runtime; node is only needed for the test suite, and must be ≥ 23.6 since the
TypeScript is run unbuilt (node 24 recommended).

```bash
git clone <this-repo> /root/code/opencode-council
cd /root/code/opencode-council && npm install
```

Add the absolute path to your `opencode.json`:

```json
{
  "plugin": ["/root/code/opencode-council"]
}
```

**Restart opencode.** Plugins load once at startup and there is no hot reload. If the
plugin fails to load, opencode starts anyway and swallows the error — check
`~/.local/share/opencode/log/opencode.log`.

Verify:

```bash
opencode agent list | grep -E '^council-.* \(all\)'   # expect 15 agents
```

(Match on `(all)`. A plain `grep council-` will also catch any older model-named council
agents you may still have, which are unrelated to this plugin.)

---

## Use

### `/council:check` — fast, inline, no subagents

Six lenses (bug, security, performance, quality, compliance, docs), max 5 findings, ~30s.
It never asks a question and never moves HEAD, so it is safe to fire mid-edit.

```
/council:check
```

### `/council:review` — the full graph

```
/council:review
```

Or call the tool directly for a different base:

```
council({ base: "main" })
```

The commands are thin wrappers over one tool:

| call | does |
|---|---|
| `council({ mode: "review", base: "HEAD" })` | the full graph (default) |
| `council({ mode: "fix" })` | patches for the last review's findings |
| `council({ mode: "plan", goal: "..." })` | propose and vote on an approach |
| `council({ mode: "task", goal: "..." })` | every model does the task; one answer, dissent attached |
| `council({ mode: "independent", goal: "..." })` | every model answers alone, nothing merged |
| `council({ mode: "models" })` | what this server offers that the roster does not pin |

`goal` is required for `plan` and `task`, and ignored by `review`, `fix` and `models`.
`context` passes supporting material — file contents, output, a spec — to `task` and
`independent` as data rather than instructions. `base` accepts any git ref.

To **build** something rather than judge it, use the `lets` tool — see below.

### `/council:fix` — patches, verified, behind your gate

```
/council:fix
```

Takes the last review's findings and writes a patch for each. **Applies nothing.**

Every patch goes through three checks before you see it:

1. **The fixer returns the full file, not a diff.** git computes the patch. Models are
   reliably bad at `@@` hunk arithmetic and there is no reason to make them try.
2. **`git apply --check`.** A patch git will not take is not a patch, however confident the
   model was.
3. **An independent model re-checks the finding against the patched content** — never the
   model that wrote the fix. If it says the problem is still there, its reason becomes the
   next attempt's instruction. Two attempts, then it escalates to you.

Results are sorted into four buckets that never merge:

| bucket | meaning |
|---|---|
| **verified** | an independent model confirmed the finding is gone |
| **unverified** | the patch applies, but the check could not run — treat as unreviewed |
| **needs a decision** | the fixer set `confident: false`; the right fix depends on intent it wasn't told |
| **unresolved** | re-checked twice and a reviewer still sees the problem |

The distinction matters: a patch nobody checked is not done, and presenting it beside a
verified one would make the guarantee meaningless.

## lets — a directive to a PR

The council judges work. **lets** does it.

Seventeen commands. Seven of them are the loop, in this order:

```
/lets:init                                         # once per repo
/lets:start                                        # restore context, claim a task, cut its branch
/lets:plan add a --json flag to the export command # plan it, and stop
/lets:execute                                      # build the plan you approved
/lets:commit                                       # stage what was reviewed, message linked to the task
/lets:done                                         # push, PR, and close only if it landed
/lets:end                                          # snapshot, so the next session can resume
```

| command | does | when |
|---|---|---|
| `/lets:init` | detects the stack, the verify command, the PR base and the review lanes, and records them in the `lets` block | once per repo, before `/lets:plan` |
| `/lets:start` | reads the last snapshots back, orients, then claims a task and cuts `feature/<id>-<slug>` | opening a session; `--continue` resumes the one in progress |
| `/lets:plan` | CPO outcomes → CTO work items, then stops at a gate | you have a directive and no approved plan |
| `/lets:execute` | runs the approved plan in a throwaway worktree, item by item, to a PR | after you have read a plan and approved it |
| `/lets:commit` | conventional message matched to this repo's own log, linked to the active task, confirmed before it writes | committing by hand rather than through `execute` |
| `/lets:done` | verifies the work is committed, pushes, opens a PR when there is a remote, and closes the task **only if it landed** | a task is finished — not a session |
| `/lets:end` | writes a recovery-grade `## RESUME` snapshot to `.lets/sessions/` | closing a window, or before a compact |
| `/lets:status` | read-only orientation — where you are, what's in flight, what's next | any time; argless, mutates nothing |
| `/lets:note` | appends a note to the active task, or to the session trail when nothing is tracked | a decision, a finding, a blocker |
| `/lets:backlog` | what is ready to work on, in dependency order, then hands the pick to `/lets:start` | choosing what to do next |
| `/lets:worktree` | lists live lets worktrees with branch, age, and the command to remove each | something got stranded |

`status`, `note`, `backlog` and `worktree` are the ones you reach for in between. None of
the four mutates a task.

### The delegating six

LETS's quality commands and this plugin's council solve the same problem, and the council is
further along. These six carry the LETS name and framing, and hand the work to the engine
that already exists rather than to a second copy of it:

| command | delegates to | why you would run it |
|---|---|---|
| `/lets:check` | `/council:check` | the 30-second pre-commit pass — six lenses, inline, no subagents |
| `/lets:review` | `/council:review` | the full pass: skeptics that did not raise a finding verify it, ties are computed, a failed node is substituted and then reported |
| `/lets:opinion` | `/council:plan` | competing approaches, scored by cross-model vote instead of by a summariser |
| `/lets:ask` | `/council:task` or `/council:independent` | one converged answer with its dissent attached, or the unmerged takes — the command's main content is choosing between them |
| `/lets:research` | `webfetch` and the browser MCP servers | reading sources you name. **There is no search tool on this machine** — see below |
| `/lets:team` | `/crew:plan`, then `/crew:execute` | LETS's autonomous-agents command. That orchestrator is `/crew` and it is now built, so this routes you to it — and explains which namespace you actually want — rather than simulating a team |

**`/lets:research` cannot search.** `webfetch` works and the playwright, chrome-devtools and
puppeteer MCP servers are reachable, including from spawned sessions. `websearch` is a valid
permission key with no tool behind it — a spawned session reaches for it and reports
`NO-TOOL`. So the command asks for a URL or a starting page rather than implying it can find
one, and its findings are meant to land in an ADR with their source URLs attached. All three
states verified 2026-08-25 (`docs/superpowers/specs/2026-08-25-council-design.md`).

### Deliberately absent

Six of LETS's 22 commands are not here and are not planned. Each is a decision, not a gap:

- **`review-round`** and **`review-handoff`** — council internals. `/council:review` already
  runs its own debate rounds and passes findings to skeptics; exposing the round mechanics as
  user commands would be two ways to drive one loop.
- **`plan-workflow`**, **`update`** and **`statusline`** — LETS-plugin machinery with no
  opencode equivalent. The first drives Claude Code's Dynamic Workflows tool, the second
  updates the LETS plugin itself, and the third renders Claude Code's status line.
- **`github-pr`** — 1,225 lines, and it needs a repo with a remote to develop honestly
  against. This one has none, so any port would be written blind and tested never.

### `/lets:init` — hire for this repo

Detects the stack, the command that proves the project still works, the branch PRs target,
and which review lanes this repo needs. Proposes all of it, and **asks about what is
genuinely ambiguous** rather than picking. On a monorepo it offers `nx affected` ahead of
the whole-workspace command — running 900 files of tests to check a one-file change is how
a run becomes an hour.

The answers land in a fenced `lets` block in your `AGENTS.md`. Editing it by hand is the
intended way to change your mind; re-running init only ever rewrites that block, never
prose you wrote.

### `/lets:plan <directive>` — intake, then a gate

Two lanes, in sequence, handing an artifact to each other:

- **CPO** turns the directive into outcomes and *checkable* acceptance criteria. "Handles
  errors" is not a criterion; "a duplicate submit returns the first result rather than
  creating a second record" is.
- **CTO** turns those into an ordered work item list, grounded in a
  [graphify](https://github.com/Graphify-Labs/graphify) knowledge graph of your codebase —
  real node locations and call edges, so `files` are cited rather than guessed.

**Then the architect writes an ADR** to `docs/adr/YYYY-MM-DD-<slug>.md` — after the plan
comes back and *before* the gate, so the plan you approve arrives with its reasoning and not
just its task list. Scaled to what `/lets` is: the directive as understood, the design
decision, the alternatives rejected, and any sources consulted. Unlike `/crew:plan`, which
**refuses** without one because it has no gate at all, here it is expected rather than
enforced — a human is about to read the plan. A change too small to have a design decision
skips it, and says that it skipped. A plan whose ADR is hard to write is usually a plan that
has not been decided yet.

Then it **stops**. Nothing is written until you approve. If a lane failed to answer, the
gate says so — a thin plan is never presented as a simple one.

### `/lets:execute` — build it

Runs **the plan you approved**, not a fresh one. Re-planning here would build something
other than what you read.

Each item, in order, in a throwaway worktree: implement → run your check → have a model
that *didn't write it* judge the diff against the item's acceptance criteria → commit.

**Green tests are not evidence the item was delivered.** A suite that never covered rate
limiting stays green whether or not you added it. That is why acceptance is judged
separately, and by someone else.

When an item gets stuck, lets escalates instead of giving up: a lane that isn't the
implementer reads the failure and writes the brief for the next attempt. When all items
land, the council reviews the branch and any **blocker** becomes another item. Suggestions
and nits go in the PR body — looping on taste spends the budget a real defect needs.

Every loop has a floor: 2 attempts, 3 escalations, 3 review cycles, 60 minutes. Whichever
trips first stops the run **and says so in prose**. A run that never ends is
indistinguishable from one that is working.

The worker gets `edit` and `bash`, **confined to the worktree by a runtime rule** —
`external_directory: deny`, enforced by the server, not a prompt sentence. It reads the
surrounding code, greps callers, runs the failing test; a path outside the worktree is
refused, not merely discouraged. Your own checkout is never touched; a bad run costs
`git worktree remove`, not a recovery.

**`deepseek` is the worker**, at the head of a six-model fallback chain — the cheapest model
that drives tools, on the highest-volume paid call lets makes. That chain is not the one
intake uses, and the difference is load-bearing: see [the two model
chains](#the-two-model-chains).

An incomplete run reports as incomplete, in the terminal and in the PR body. Items that
never ran are listed as `not-attempted` with the reason — a plan that stopped at item 2 of
6 reports "1/6", not "1/2". An item that passed its checks without an independent judge
says **"NOT independently judged — checks only"**. That is enforced by tests, because the
one lie that would matter is the report that hides what happened.

### The work loop — `/lets:commit`, `/lets:done`, `/lets:backlog`

`execute` commits per item on its own. These three are the same loop run by hand: pick the
next thing, commit what you wrote, then close it out honestly.

**`/lets:commit`** stages what was reviewed and writes a message this repo would recognise.
It **never** stages with `git add -A` or `git add .` — both sweep in unrelated edits,
untracked cruft or secrets, and clobber a set you curated. An already-staged set wins as-is.
The conventional format is matched against this repo's own last 20 subjects rather than
imposed, and nothing is written until you confirm. The rules live in the `lets-commit` skill,
not in the command file, so an explicit `/lets:commit` and a plain "commit this" in a lets
repo produce the same commit.

**`/lets:done`** finishes a *task*, and detects its mode rather than reading config:

| remote | `gh` | mode | push | PR | task |
|---|---|---|---|---|---|
| yes | ok | **github** | yes | yes | **stays open** until the PR merges |
| yes | no | **push-only** | yes | no | **stays open** — nothing merged it |
| no | — | **local** | nothing to push | no | **closed**, after the local merge |

A task closed while its PR sits unreviewed is a lie told to everyone reading the board, so
the close only happens where something actually landed. It also refuses to close an **epic**
— epics outlive their children — and never pushes, merges or closes without your answer.

**`/lets:backlog`** shows what is ready, in dependency order, and hands the pick to
`/lets:start`. It reads and asks: it creates nothing, claims nothing, closes nothing. The
order is `bd ready`'s own — computed from the dependency graph, open issues with no unmet
blockers first — and is deliberately not re-sorted, because re-sorting throws away the
dependency information that made it a ready list. With no tracker it says so in one line
rather than rendering an empty list, and it does not offer to run `bd init`. Triage that
wants several opinions is pointed at `/council:*` rather than reimplementing fan-out here.

### `/lets:worktree` — what's still lying around

Lists live lets worktrees with their branch, age, and the exact command to remove each.
Works in any git repo, including one with no lets config — that's precisely where a
worktree gets stranded and forgotten.

lets wrote this one.

### The session spine — `/lets:start`, `/lets:status`, `/lets:end`, `/lets:note`

The pipeline above is the *work*. This is the *continuity*: a session you start and end,
with context that survives the window closing.

| command | does |
|---|---|
| `/lets:start` | reads the last snapshots back, orients, then claims a task and cuts `feature/<id>-<slug>`. Takes a task id, or `--continue` to resume the one in progress. |
| `/lets:status` | read-only orientation — where you are, what's in flight, what's next. Argless, mutates nothing. |
| `/lets:end` | writes a recovery-grade `## RESUME` snapshot to `.lets/sessions/`. `--pre-compact` writes the same file without ending anything. |
| `/lets:note` | appends a note to the active task, or to the session trail when nothing is tracked. |

The shared logic lives in `skills/` (below), so `/lets:status` and `/lets:start` cannot
drift into rendering the same snapshot two different ways.

**The snapshot is file-primary.** It always lands in `.lets/sessions/`, task or no task; a
tracked task gets a one-line pointer to it and nothing more. The file is the record, so
losing the tracker never loses the session.

**Task tracking is optional.** [beads](https://github.com/steveyegge/beads) is used when `bd`
is on PATH *and* the repo has a `.beads/` directory — both, for the reason under
[Tracking](#tracking--optional-and-off-by-default) below. Without both, the tracker is
`none`: `/lets:status` still tells you the branch, the task pointer and the dirty-file
count, and simply omits the sections that have no data source.

### Skills — the shared halves of the commands

Five skills live in `skills/`, and the plugin registers the directory itself via
`config.skills.paths` — there is nothing to install separately.

| skill | for |
|---|---|
| `lets-orient` | renders the shared "where am I / what's in flight / what's next" snapshot, degrading section by section when there is no tracker |
| `lets-detect-task` | resolves the active task id — explicit argument, then the per-branch pointer file, then the branch — or `None` |
| `lets-artifact-path` | resolves a collision-safe path for a session artifact under `.lets/sessions/` |
| `lets-session-snapshot` | writes the recovery-grade snapshot file, plus a one-line task pointer only when a task is unambiguously active |
| `lets-commit` | the commit rules: staging, the repo's own convention, the task link, the confirmation gate |

**The first four are invoked by the commands, not by conversation** — each says so in its own
description, and a user turn should not trigger them. They exist because two commands doing
the same thing in two places is two things to keep true: `/lets:status` and `/lets:start`
share one snapshot renderer, `/lets:end` and `/lets:note --pre-compact` share one snapshot
writer.

`lets-commit` is the deliberate exception. It is written to be preferred over any generic
commit skill in a lets repo, so a plain "commit this" and an explicit `/lets:commit` land
the same commit rather than two different ones.

### Tracking — optional, and off by default

Runs report to your terminal. If you want them mirrored somewhere, `/lets:init` asks once
and records the answer in the `lets` block.

| `tracker:` | behaviour |
|---|---|
| absent | init never asked — it will ask once, and offer to record your answer |
| `none` | you declined. It won't ask again. |
| `mcp` | mirrored through any MCP server configured in opencode.json — Jira, GitHub Issues, Plane, … |
| `linear` | mirrored into a Linear agent session (native fast path) |
| `beads` | mirrored as notes onto the bead the run belongs to, via the local `bd` cli |

**`none` and absent are different on purpose.** Creating issues in someone's workspace
uninvited is worse than asking one question, so lets never guesses.

Each is offered only where it would actually work, so init can never record a tracker that
silently mirrors nothing: `linear` needs `LINEAR_API_TOKEN`, `mcp` needs at least one local
MCP server in opencode.json, and `beads` needs **`bd` on PATH *and* a `.beads/` directory in
the repo**. Both, for beads, and the second is the one with teeth — the binary alone would
make every repo on the machine "tracked", and the first write would create a database in a
project that never asked for one. That is not the plugin's call, so a repo without `.beads/`
gets `none`, which is a fully-rendered state rather than an error. (`availableTrackers` in
`src/lets.ts` also treats an unknown repo root as "not available" rather than guessing at
the cwd.)

With `mcp`, the tracker is whatever you already run: name one of your opencode.json
`mcpServers` entries and map the run's moments to that server's tools. Argument names are
the server's, not ours — a small template adapts them:

```lets
tracker: mcp
mcp-server: jira
mcp-start: create_issue
mcp-step: add_comment
mcp-finish: transition_issue
mcp-args: {"issueKey": "${issue}", "comment": "${text}"}
```

`${issue}` (matched from the directive, e.g. `fix ENG-123`), `${directive}`, `${branch}`,
`${text}` and `${state}` substitute into template values. Every tool is optional — a
tracker that only posts the final summary is valid. Local (stdio) servers only, resolved
from opencode.json so lets adds no server configuration of its own.

With `linear`, lets registers as a real workspace member and streams into a native
agent session: a live plan checklist, one entry per item, and the PR link attached when it
opens. Outbound only — no webhook, no public endpoint, no daemon. Needs `LINEAR_API_TOKEN`
from an OAuth app installed with `actor=app` (workspace admin required). Without the token
it isn't offered at all. It is an implementation of the same seam, not a privileged one.

With `beads`, a run's progress lands as notes on the bead it belongs to. **Exactly one note
at run start, one per work item, and one at finish — never on `step()`.** For a run of `N`
items that is `N + 2` `bd` invocations, and no more. The sparseness is the point: a `bd` note
is append-only into your real database, unlike Linear's progress activity which is ephemeral
and replaces itself, so a per-step note would bury the bead's own history under a run's
stdout. `step()` is a deliberate no-op for a second reason as well — it is the one sync,
unprotected hook, so a shell-out there would be slow *and* invisible when it failed; the
terminal line you see comes from the stdout tracker fanned out beside it.

**It never closes the bead.** `/lets:done` owns that transition: a run finishing is not a
task finishing, since the run can stop `item-stuck` with half the work undone, and even a
clean run only means the branch is ready — not that the task was accepted. The bead it
writes to is the one `/lets:start` recorded in the pointer file, not one scraped out of the
directive.

**A tracker can never break a run.** An outage, an expired token, or a preview-API change
costs you a warning line. The work is real; the mirror is not.

## crew — a directive to a merged branch

`lets` builds one task you approved. **crew** takes a goal, works out the tasks itself, and
runs them concurrently. Three commands:

```
/crew:plan add structured logging across the API   # interview → research → architect writes the ADR → decompose
/crew:execute                                      # waves → integrate → verify → review → report
/crew:status                                       # read-only: what would run, what's stranded
```

| command | does | writes |
|---|---|---|
| `/crew:plan <directive>` | interviews you, reads the repo, researches, then the **architect** writes the ADR, and only then decomposes | the ADR, and the plan artifact. **No approval gate** |
| `/crew:execute` | schedules the recorded plan into waves, runs them in isolated worktrees, integrates, verifies and reviews | task branches and one integration branch, all **local and unpushed** |
| `/crew:status` | the last plan, the waves it would produce against today's graph, and live worktrees | nothing — it starts, writes and removes nothing |

crew has no init command of its own. It reuses the `lets` block in your `AGENTS.md` for
`verify`, `base` and `lanes`, so `/lets:init` remains the one-time setup for both.

### The interview is the gate

`/lets` gates on the plan, after you have stated the requirements. crew moves that gate
**earlier**: it interviews you for the requirements, and then decides the plan itself. What
`/crew:plan` writes is what `/crew:execute` runs, unread.

**It reads the repo before it asks anything** — the dependency graph, the detected stack,
`AGENTS.md`, `README.md`, `git log --oneline -30`, and any spec or ADR already covering the
ground. A question whose answer is in the repo wastes your turn and teaches you the
interview is theatre. It says in one line what it learned, then asks only what the repo
could not tell it.

**The bounds are hard: at most two rounds, at most four questions per round.** Round 1 asks
what changes the shape of the work — what "done" looks like in checkable terms, what is out
of scope, constraints not visible in the code, and the ambiguities it actually hit while
reading. Round 2 exists only to close gaps round 1 opened.

**If it has not converged after two rounds it stops**, names the questions still open, and
does not plan. It does not "proceed with reasonable assumptions" — an unattended run built
on a guessed requirement is exactly the failure this namespace has no gate to catch.

**Every question and answer goes into the ADR, verbatim.** That is the requirements record,
and paraphrasing it away destroys the only evidence of what you asked for. The tool enforces
this rather than trusting it: `crew:plan` **refuses without an `adr` path**, and the ADR is
written *before* execution — a record written afterwards records outcomes, not requirements.

**The architect writes it, and is recruited unconditionally.** The architect owns the design
decision, so it owns the record of it; a decision written up by whoever happened to be free
is a summary, not a record. The role used to be keyword-triggered — woken by a regex over
the directive that matched "new service", "migrate", "rewrite" and the like. That left a
document the tool *refuses to run without* with a conditional author: any directive the
regex missed produced a mandatory ADR and nobody assigned to write it. `recruitFloor` now
adds `architect` to every crew run (`src/crew-org.ts`). The regex survives, but it only
marks structural work for the prompt's benefit; it no longer decides whether the ADR has an
owner.

**It is written after research and before decomposition**, in that order. A record written
after the tasks exist is a justification for them; written before, it is the decision the
tasks come out of. Anything that cannot be justified in the ADR should not become a task.

### Waves, gated by the graph

`src/schedule.ts`. Two tasks share a wave **only where the graph proves their file sets
disjoint**. Everything else is one task per wave.

Two file sets conflict if they share a path, **or if any file in one is a graph neighbour of
a file in the other**. Three properties, all deliberate:

- **One hop, never transitive.** At two hops a codebase of any density collapses into a
  single connected blob where every task conflicts with every other — a sequential schedule
  wearing a graph's costume. One hop is the honest middle.
- **The graph is undirected**, so these are *neighbours*, not importers. That makes the test
  a conservative **superset** of "really interferes": it will call some independent pairs
  conflicting, and will never call a conflicting pair independent. For a safety gate that is
  the correct direction to err.
- **Bounded.** `MAX_WAVE_WIDTH` is **4** — each slot costs a checkout, a model run and a
  review. `MAX_TASKS` is **12**, and past it the tool **refuses rather than truncates**:
  quietly dropping the tail would let the run report success over work that never happened.

Plan order is preserved. The scheduler walks the tasks as given and takes the earliest wave
that fits, rather than bin-packing for width — plan order carries intent it cannot see.

### The degradation is honest, and it is load-bearing

**A file the graph has never seen is scheduled alone.** A file with no entry and a file with
an empty entry both read as "no neighbours", but they mean opposite things: one is evidence
of independence, the other is the *absence* of evidence. "This file is new, so nothing
references it" and "the graph is stale and never saw this existing, heavily-referenced file"
are indistinguishable from inside the scheduler, and only one of them is safe.

So the result carries a `mode`, and the report names the files:

| mode | means |
|---|---|
| `graph` | every task's files are known. Concurrency is proven |
| `partial` | some files are absent from the graph. **Their tasks run alone, and the absent files are listed** |
| `sequential` | no readable graph at all. Nothing can be proven, so everything runs alone |

**Measured on this repo, today: 11 of 29 `src/*.ts` files are absent from
`graphify-out/graph.json`, and the graph still names two files that no longer exist**
(`src/crew.ts`, carrying 9 neighbours, and `src/crew.test.ts`). So crew **on this repo
degrades toward sequential right now**, and will until the graph is rebuilt. That is the
intended behaviour rather than a defect — but it means the parallelism is not currently
there to be had, and `/crew:status` will tell you so before you pay for a run.

### Integration stops at the first conflict

Task branches are merged in order into a fresh integration branch, in a throwaway worktree —
an unattended tool has no business moving the branch you are standing on. It refuses to
reuse an existing branch name rather than clobber one you made.

At the **first conflict** it stops: it reads the unmerged paths, aborts the merge, and
returns the branch that conflicted and the files that did. Reading before aborting is the
whole reason the files can be named — `merge --abort` clears the index that `--diff-filter=U`
reads.

**It never auto-resolves.** A conflict is evidence that the scheduler was wrong — it put two
tasks in one wave after judging their file sets disjoint — and resolving it unattended would
destroy exactly the evidence that the concurrency gate needs fixing. The partial integration
branch survives with whatever merged cleanly, because partial progress is evidence too. The
fix is to correct the `files` on those tasks, or rerun the conflicting task on top of the
integration branch.

`files` is therefore load-bearing in the plan. A task that under-declares its files gets
scheduled beside work it actually touches, and the first evidence of that is a merge
conflict.

### The report is the review

With nobody approving the plan, the report is the only thing between you and a bad decision,
so it inherits every honesty rule from `renderRun` and adds the scheduling ones. An
incomplete run says **INCOMPLETE** in the first line — never "done with caveats". A task
that never ran is listed **with its reason**. An acceptance no independent model judged says
`NOT independently judged` rather than passing quietly. A suppressed PR says it was
suppressed, so the absence is not read as a failed push. And the schedule's `mode` and
ungraphed files are printed, because "it ran sequentially" is otherwise an unexplained cost
you cannot act on.

Nothing is pushed. The integration branch is yours to read and push. The plan, the run
record, the review and a tailable step log land in
`council-artifacts/<timestamp>-crew-org-{plan,run}/` — a tool call returns once, at the end,
so tail the log if you want to watch a long run rather than guess whether it has hung.

### Cost, honestly

crew runs up to `MAX_WAVE_WIDTH` concurrent `lets` executions, so the per-task cost is a
`lets` run's, multiplied by N — plus **one** council, on the integrated branch, with the
recruited lanes.

Tasks pass `review: false`, so a task does **not** also run a council on its own branch.
That is deliberate and it is the largest saving in the design: reviewing both would be
structurally **N+1 councils**, roughly doubling a 3-task run. Nothing is lost from the
per-task signal — `verify` and the acceptance judge (a different model than the implementer)
both still run inside every task, and neither depended on the branch review.

For **3 tasks × 2 items**: intake and implementation ~30, the integrated review ~18, so on
the order of **50–60 model calls**, against 115–130 had each task reviewed its own branch
too. Wave width caps how much runs at once; it does not change the total.

The cheap way to sanity-check a run before paying for it is `/crew:status`, which computes
the wave schedule fresh against the current graph and makes no model calls at all.

### `/council:independent` — the raw takes, unmerged

```
/council:independent what's the biggest risk of an in-memory rate limiter?
```

Every model in the roster answers **alone** — all seventeen, including the two
implementer-class members that hold no lane, since this mode sends no schema and their
limit is structured output rather than inference. No routing, no dedupe, no debate, no
verification, no synthesis. One file per model in
`council-artifacts/<timestamp>-independent/`, plus an index.

This is deliberately the only mode that does **not** aggregate. Everything else here exists
to turn many opinions into one answer; aggregation is lossy by design, and sometimes what
you want is to read the disagreement yourself before any machinery decides what mattered.

It is also the only mode that sends **no schema** — the output is prose for a human, and
forcing a tool call to carry free text costs models that can't do it for no benefit
(measured on the then 11-member roster: 7/11 with a one-field schema, 11/11 without).

### `/council:plan` — pick an approach by vote

```
/council:plan add rate limiting without adding Redis
```

Five lanes propose an approach. Every model then scores every proposal **except its own**
on correctness, simplicity, risk and completeness. The winner is the highest mean —
arithmetic, not a model's preference.

**Ties come to you.** Two proposals within `TIE_MARGIN` are not meaningfully ranked, so no
winner is declared; picking one would be false precision the numbers don't support.

### `/council:task` — one answer, the dissent still attached

```
/council:task write the retry policy for the payment webhook
```

Where `plan` asks five lanes *how they would approach* a goal, `task` asks every model to
actually do the thing. All fifteen schema-capable members answer, then each answer is
scored by three others — never its own author — on the same four dimensions `plan` uses.
The highest mean is returned as the answer.

What comes back with it is the point:

- **The runner-up, and every scorer's objection, verbatim.** A winning answer's score is an
  average, and an average erases the one scorer who spotted the flaw. An answer delivered
  without its dissent is a summary of the vote, not the result of it.
- **A tie is reported as a tie.** Within `TIE_MARGIN` no winner is declared and both
  answers are shown side by side. At three scorers the means land on thirds, so exact ties
  are common rather than hypothetical — manufacturing a winner from one would be the same
  false consensus this command exists to prevent.
- **"Unranked" is a third state, not a tie.** If answers arrived but every scoring call
  failed, nothing was compared; the report says so and prints every answer. A council that
  never voted is not a close call.
- **An answer whose own scorers all failed is still printed**, under "answered, but
  unscored". Nothing that came back is dropped for lacking a number.

`context` passes material the models should read — file contents, output, a spec.

### `/council:models` — discover, measure, propose

```
/council:models
```

Reads the server's live catalogue, keeps the entries on providers the roster already uses,
probes the ones it has budget for with a single structured-output call, and writes a
proposal to `council-artifacts/<timestamp>-models/models.md`.

**It never writes the roster.** Model identity changes what the council *is* — swap a
member and every verdict afterwards comes from a different panel. A later version number is
not a measurement: `google/gemini-3.7-flash` times out at 90s on the probe `3.6-flash`
answers in 9s, so an updater chasing "latest" would have adopted it, cost a lane, and
reported the loss as an upgrade. Discovery is worth automating. Adoption is not.

Probes are capped per run, so a candidate can come back unmeasured. That is reported as
unknown, not as probably-fine.

Artifacts land in `council-artifacts/<timestamp>-<kind>/` — `report.md` + `findings.json`,
`patches.md`, `plan.md` + `plan.json`, `task.md` + `task.json`, or `models.md`.

---

## How it works

```
 diff ──▶ route ──▶ fan-out (parallel, one node per role x model)
                    [security] [systems] [code] [qa] ...
                    a model dies → substitute (see below), never drop
                         │
                         ▼
                     dedupe ──────────────────────── file + category + line window
                         │
              disputed? ─no──────────────────┐
                         │yes                │
                         ▼                   │
                      debate — 2 rounds on `/council:*`, off elsewhere (see below);
                         │                   only ever wakes for disputed findings,
                         │                   and only the models that disagree
                         ▼                   ▼
                     verify ── skeptics: 3 per BLOCKER, 2 per SUGGESTION
                         │      never the model that raised it
                         ▼
                     decide() ─────────────── keep │ downgrade │ drop
                         ▼
                      report
```

**Routing** wakes only the roles a change implicates. A docs typo costs one node; a
migration wakes systems and security. `reviewer` always runs.

**`/council:review` opts out of routing** and passes every lane, because routing is a cost
control that is right for lets and wrong for "my council" — you asked the whole body, so
the whole body answers. Routing still governs every call that does *not* ask for all lanes,
lets's branch review above all. The split lives at the call site, in `councilArgs()`, and is
pinned by a test: moving it into a shared default would silently put every lets run on the
expensive path.

**Substitution — a lane never drops while a usable model remains.** When a node fails,
it walks a substitute list: an unassigned model carrying the role, then any unassigned
model, then a model already working another lane. That third tier matters most: on a full
panel every model is already assigned, so restricting substitutes to unassigned ones
offers zero stand-ins at exactly the moment coverage is being lost. Failures that are the
*model's* fault for the whole run bench it everywhere — `malformed` (cannot emit a forced
tool call), quota, auth. A timeout is not benchable; it may just be a large diff. The
report names every stand-in and flags one that reused a busy model, because two lanes
answered by one model are correlated, not independent — which is the thing a multi-model
panel buys its way out of.

**Debate runs on `/council:*` and nowhere else.** `DEFAULT_MAX_ROUNDS` is still `0`;
`councilArgs()` passes `maxRounds: 2`.

The evidence that turned it off has not been overturned — Huang et al. (ICLR 2024) found
multi-agent debate *losing* to self-consistency at matched budget with round 2 worse than
round 1, and our own measurement agreed: one round re-judged six findings and changed zero
positions while wall time went 74s → 212s. It is being **re-tested where it can be seen**,
at the human's explicit request. Every report prints a `## Convergence` block giving, per
round, the re-judgement count and each position that actually moved. So the next several
reviews either produce the positive result the rounds have never had, or retire them on a
second measurement rather than on a preference.

**Verification** exists because multi-model review generates false positives, and a
fabricated BLOCKER costs a human real time to disprove. Skeptics are drawn from models that
did not raise the finding — self-verification is not verification.

### What is deterministic

| decision | mechanism |
|---|---|
| duplicate findings | same file + category, lines within a window |
| consensus vs disputed | tier spread across reporters |
| who debates what | the models that disagree on X debate X |
| convergence | no tier moved, or no disputes left, or round limit |
| keep / downgrade / drop | `decide()` over skeptic votes |
| the report | template-filled from data |
| a fix is resolved | an independent model's verdict on the patched content, not the fixer's |
| which plan or task answer wins | mean of cross-scores; ties escalate rather than resolve |
| who scores whose task answer | cyclic over roster order — every member scores exactly 3, never its own |

A model may summarise the report, but cannot add, remove, or re-tier a finding.

### `decide()` — two deliberate asymmetries

```
no votes                                  → keep      (absent evidence is not refutation)
BLOCKER: all-false or majority-high-false → drop
BLOCKER: majority-false                   → downgrade
other:   majority-false                   → drop

category == security: dropping requires UNANIMOUS high-confidence refutation
```

Zero votes keeps the finding because "verification did not run" and "the finding was
refuted" are different facts, and conflating them is how a real bug disappears silently.

Security gets a higher bar to drop. That protection belongs to the *category* and is
applied by code — no model or role holds a veto.

---

## Roster

Seventeen members: fifteen carry council lanes, two are implementer-class and carry none
(see below). `ms` is measured latency on a trivial structured task — for setting timeouts,
**not a quality signal and never a tier**. Every member is smoke-tested on joining.

| slug | model | roles | tier | capability | ms |
|---|---|---|---|---|---|
| `opus5` | anthropic/claude-opus-5 | reviewer, security, architect | | schema, agentic | 4263 |
| `fable` | anthropic/claude-fable-5 | security, skeptic | | schema | 6704 |
| `kimik3` | kimi-for-coding/k3 | code | | schema | 21151 |
| `kimik3go` | opencode-go/kimi-k3 | code | | schema | 6782 |
| `gemini36` | google/gemini-3.6-flash | breadth, docs, techwriter | | schema | 9028 |
| `grok45` | opencode-go/grok-4.5 | systems, skeptic, infrastructure | | schema | 7146 |
| `mimo` | opencode-go/mimo-v2.5-pro | pragmatist, skeptic | | schema | 7027 |
| `minimax` | opencode-go/minimax-m3 | reviewer, skeptic | | schema | 4532 |
| `nemoultra` | opencode/nemotron-3-ultra-free | reviewer, systems, breadth | | schema | 7307 · free |
| `nemolight` | opencode/nemotron-3.5-lightning-free | skeptic, qa, ops | | schema | 4672 · free |
| `hy3` | opencode-go/hy3 | qa, ops | | schema | 6117 |
| `gpt56sol` | openai/gpt-5.6-sol | security, systems, architect | **deep** | schema, agentic | 3696 |
| `gpt56terra` | openai/gpt-5.6-terra | product, reviewer, docs, techwriter | **standard** | schema, agentic | 2664 |
| `gpt56luna` | openai/gpt-5.6-luna | reviewer, qa, skeptic | **fast** | schema, agentic | 4228 |
| `glm53` | zai-coding-plan/glm-5.3 | systems, reviewer, infrastructure | | schema, agentic | 6007 |
| `musespark` | opencode/muse-spark-1.2-contributor-free | *no lane* | | agentic | 8000 · free |
| `deepseek` | deepseek/deepseek-v4-pro | *no lane* — **leads the implementer chain** | | agentic | 9459 |

**`capability` is measured, never read off a catalogue flag.** `schema` means the model can
emit forced-tool-call structured output — every council lane needs it. `agentic` means it
can drive tools in a session — an implementer needs only that. A member with `agentic`
alone gets no lane, and every role-based selector excludes it twice over: by capability and
by its empty `roles`.

**The `roles` column is council lanes, not workload.** `no lane` means the member is never
recruited to review a diff; it does not mean the member is idle. `deepseek` carries no lane
and is nonetheless the model that writes the code — it **leads `LETS_IMPLEMENT_MODELS`**, so
it runs on every item of every `/lets:execute` and every `/crew:execute` task. See [the two
model chains](#the-two-model-chains) below.

**The `gpt-5.6` three are tiers, not variants** — Sol is peak reasoning (slowest, dearest),
Terra the balanced production default, Luna the fast high-volume budget tier. Note what the
`ms` column does *not* say: Luna, the tier built for speed, measured **slowest of the
three**. A one-call probe ranks queue noise, not capability, which is why `tier` records the
vendor's class and is never derived from latency.

`gpt56luna` carries `skeptic` deliberately. `skepticPool` filters on that role and then
*slices*, so the ordering there decides who actually runs — without the role, the fast tier
would be unreachable from the highest-volume loop in the system. The `council:task` scoring
pass gets no such lever: its assignment is cyclic, so every member scores exactly three
regardless of order, and sorting it moves no volume.

`kimik3go` exists as the `code` lane's billing-cycle fallback: when kimi-for-coding's
quota trips, the lane substitutes to it first (same role, same model, other provider).

**`techwriter` authors documentation; `docs` reviews it.** They are different jobs and the
roster keeps them apart. `docs` is a review lane — it reads a diff and names the statements
that diff has made untrue. `techwriter` writes and repairs the documentation a change left
behind, as part of the work (`/crew:execute`), and it is not a second opinion on a markdown
file. It is carried by `gemini36` and `gpt56terra`, the two members already carrying `docs`,
because the roster's existing statement about who the prose models are should not be
relitigated by a new role.

It is **appended** to those members' `roles`, never prepended: `roles[0]` is the voice a
model answers in, so prepending would quietly re-cast an existing member as the tech writer.
A test pins that.

And it is **deliberately absent from `ROUTES`**, where it would look natural beside `docs` on
the markdown globs. `ROUTES` wakes *review* lanes on a diff, and adding `techwriter` there
would put two prose models on every documentation change saying close to the same thing —
the per-change cost routing exists to hold down. It reaches a panel through `ALL_ROLES`,
which is the whole-council case rather than the per-diff one.

Model diversity earns its keep in the **skeptic pool**: three votes from one model are
correlated and near-worthless; three from different models are evidence.

Edit `src/roster.ts` to change it. **Smoke-test anything you add** — `models.json`'s
`structured_output` flag is unreliable in both directions, and several catalogued models
are not actually served. `/council:models` does the discovery and the measuring for you,
and stops short of the edit.

### Implementer-class, not excluded

Two members chat and drive tools perfectly well, and 400 on a *named* tool call. Their
errors name the cause:

```
deepseek/deepseek-v4-pro
  400  Thinking mode does not support this tool_choice

opencode/muse-spark-1.2-contributor-free
  400  only "auto" is supported for tool_choice; "none", "required", and named
       function choices are not currently supported
```

That is a capability class, not a quirk of one model, and it falls exactly on the boundary
between an implementer and a council lane: `tool_choice: auto` works, a forced named call
does not. Both are in the roster with `capability: ["agentic"]` and no roles.
`deepseek/deepseek-v4-pro` is verified agentic — drove bash, returned an exact marker,
9459ms — and is the designated implementer for build work.

They still answer `/council:independent`, which sends no schema. The limit is structured
output, not inference.

`opencode-go/muse-spark-1.2-contributor` is a third case again: **gated, not broken.** It
requires a data-collection opt-in at `opencode.ai/workspace/.../go` — consent that is the
human's to give, so it is not pinned here.

### The two model chains

`lets` drives two model chains directly, each tried in order, first to answer wins. They are
lists rather than single picks for the reason `WORKERS` is a list: one hardcoded model is one
single point of failure, and a run that dies at intake has produced nothing at all.

| chain | members | the call site passes | the constraint |
|---|---|---|---|
| `LETS_INTAKE_MODELS` | `opus5`, `gpt56terra`, `glm53`, `minimax`, `kimik3` | a **schema** — a forced tool call | every member must be `canSchema` |
| `LETS_IMPLEMENT_MODELS` | **`deepseek`**, then the intake five unchanged | `allow: ["edit", "bash"]` and **no schema** | the **lead** must be `canAgentic` |

**deepseek leads the implementer chain because it is the cheapest model that drives tools**,
and implementing is the highest-volume paid call lets makes — every item, every attempt,
every escalation. It cannot appear in the intake chain at all: it 400s on a forced
`tool_choice`, which is exactly what intake sends.

**They were one list, and the split is not tidiness.** The obvious alternative — keep one
list and filter it per call site — cannot work, because the two sites need *opposite*
capabilities. Intake needs `canSchema`, which excludes deepseek. The implementer needs
`canAgentic`, which is the one thing deepseek has. A single list can be filtered down but
never filtered *up*: no predicate over one list produces a chain that both starts with
deepseek and excludes it.

**The implementer's tail is deliberately unfiltered, and this is the part most likely to be
"fixed".** Filtering the tail on `canAgentic` would drop `minimax` and `kimik3`, whose
`capability` is **unset** — which `canAgentic` reads as false, since it defaults to
`["schema"]`. Unset means *never measured* for tool driving, not measured and failed; the two
members that genuinely fail are flagged explicitly, because the roster records measurements
rather than assumptions. Both have been implementing here all along. Filtering on an absent
measurement would silently cut the fallback from **five models to three** — and the run that
needed those two would be the one where deepseek was already down.

`src/lets.test.ts` checks each list against `canSchema`/`canAgentic` in the roster rather
than trusting the slugs, so a roster edit that invalidates a chain fails a test instead of a
run.

### Excluded, with cause

| model | cause | remedy |
|---|---|---|
| `opencode-go/qwen3.{7,8}-max` | deterministic timeouts (120s, 150s, 240s) | none found |
| `opencode/hy3-free` | `malformed` 3/3 — the free route, not the model | use `opencode-go/hy3`, which holds the schema at 6117ms |
| `google/gemini-3.7-flash` | times out at 90s where `3.6-flash` answers in 9s | stay on `3.6-flash`; a higher version number is not a measurement |

There is no text-JSON fallback by design. A model either passes the smoke test or gets no
schema lane; a second parse path for two models is complexity for marginal diversity.

---

## Known limits

- **`/council:review` is now the most expensive path in the system.** That is the intended
  trade, so here it is in numbers: a full panel is **25 nodes**, each subject to **up to 2
  debate rounds**, before verification adds 3 skeptic calls per BLOCKER and 2 per
  SUGGESTION. `/council:task` is **15 proposals + 45 scoring calls** (all-pairs would have
  been 210). Rounds are sequential and each is bounded by its slowest member, so wall time
  scales with both. The ~1–3 minutes measured previously was on the routed, debate-off
  path — it still describes lets's branch review, which inherits both defaults, and it is a
  floor rather than a forecast for a full panel. **`/council:check` is the cheap option**
  and did not change: six lenses, inline, no subagents.
- **`anthropic/*` models only work in your main opencode process.** They route through a
  local proxy that a second server cannot reach.
- **Nodes fail, and the report says so.** Failed nodes substitute first (see above); one
  that still did not run is listed with its cause and the verdict is marked provisional.
  This is deliberate: a node that failed must never be indistinguishable from one that
  found nothing.
- Findings are grounded in the diff only. There is no repo-wide index.
- **`/crew:execute`'s orchestration has never run end to end.** No test in this suite may
  call a model, so everything past the guards — the wave loop, the concurrent `runExecute`
  calls, and the hand-off into integration, verify and review — is exercised only by its
  refusals. `schedule`, `integrate`, `recruitFloor` and `renderCrewReport` are each tested
  directly and hard; the wiring between them is not tested at all.
- **This repo's own dependency graph is stale**, so crew here schedules close to
  sequentially. `/crew:status` reports it; rebuilding the graph is what fixes it.

---

## Development

```bash
npm test        # node --test, no framework, no build step
```

`src/decide.ts` is the deterministic core and carries the most test weight — if you change
it, the two asymmetries above are the things most likely to be "simplified" into bugs.

| file | role |
|---|---|
| `src/decide.ts` | pure judgement: dedupe, disputes, convergence, `decide`, `tally` |
| `src/roster.ts` | models, routing table, node and skeptic selection |
| `src/engine.ts` | fan-out, debate, verification, fix, plan, task — moves data, holds no judgement |
| `src/catalog.ts` | the live catalogue, the measured capability cache, and the probe budget |
| `src/schema.ts` | JSON Schemas enforced by the runtime as forced tool calls |
| `src/report.ts` | report, patch, plan and task rendering |
| `src/lets.ts` | the lets pipeline: config, worktrees, plan, run, the tracker seam |
| `src/mcp.ts` | the generic MCP tracker, and the run summary both mirrors share |
| `src/linear.ts` | the Linear agent-session tracker |
| `src/beads.ts` | the `bd` transport, the active-task resolver, and the beads tracker |
| `src/schedule.ts` | pure scheduling: file edges from the graph, one-hop conflicts, waves, and the `graph`/`partial`/`sequential` degradation. No model, no I/O beyond reading the graph |
| `src/crew-org.ts` | crew's testable core: the deterministic lane floor, branch integration, and the CEO report |
| `src/index.ts` | plugin entry: registers agents, commands, the `skills/` path, and the `council`, `lets` and `crew` tools |
| `agent/*.md` | 18 agent prompts — 15 council (14 roles plus the fixer) and 3 lets (`cpo`, `cto`, `dev`); expertise and tier calibration only |
| `src/*.test.ts` | 289 tests: `decide`, `roster`, `tally`, task states, catalog, patch classification, the lets config and worktree paths, the beads parsers, the wave scheduler, and crew's recruiting, integration and report |

The rule the whole design rests on: **anything that decides an outcome lives in
`decide.ts` and is tested.** `engine.ts` may move data and call models, but if you find
yourself writing a judgement there, it belongs one file over.

**[PLAN.md](./PLAN.md)** carries the design decisions with rationale, the measured spike
results, and 18 opencode runtime gotchas that cost real time to discover. Read it before
changing the architecture.

**[docs/adr/](./docs/adr/)** carries one file per decision, named `YYYY-MM-DD-slug.md` —
dates and slugs rather than sequential numbers, because `0007-` has to be allocated and two
workers deciding concurrently both allocate the same one.

## License

MIT
