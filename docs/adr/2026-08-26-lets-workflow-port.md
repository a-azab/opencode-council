# lets: the rename, and the LETS workflow port

**Date:** 2026-08-26 · **Status:** accepted · **Scope:** `src/lets.ts`, `src/beads.ts`,
`src/index.ts`, `src/engine.ts`, `command/`, `skills/`, `README.md`

## Context

The single-task pipeline was called `crew`. It has only ever been one attended workflow: one
directive, one plan, one run, one branch, with a human at the gate. Sub-project 3 makes
`crew` an **orchestrator that runs several of these**, and two things cannot both be called
crew. `crew` is the right name for the orchestrator and never was for a single attended
run, so the pipeline is the one that gives it up.

Separately, [restarter/lets-workflow](https://github.com/restarter/lets-workflow) (LETS)
carries what this repo had none of: a session you start and end, a work loop that commits
and closes tasks honestly, and a task tracker. The pipeline could plan and build; it could
not tell you where you were, and nothing survived the window closing.

Design spec: [`docs/superpowers/specs/2026-08-25-lets-design.md`](../superpowers/specs/2026-08-25-lets-design.md).

## Decision

1. **Rename the pipeline `crew` → `lets`, hard.** Module, tool key, commands, agents,
   symbols, and — the part with teeth — **both confinement controls keyed on the tool
   name**.
2. **Read both names, write the new one**, for the three formats that are persisted in
   someone's repo: the config fence, the worktree branch prefix, and the artifact
   directories.
3. **Port the session spine** — `/lets:start`, `/lets:status`, `/lets:end`, `/lets:note` —
   with the shared halves in `skills/`, registered by the plugin via `config.skills.paths`
   so there is nothing to install separately.
4. **Port the work loop** — `/lets:commit`, `/lets:done`, `/lets:backlog` — closing the
   cycle `init → start → plan → execute → commit → done → end`.
5. **beads becomes a tracker**, behind the neutral `Tracker` interface `mcp` and `linear`
   already implement. Availability is `bd` on PATH **and** `.beads/` in the repo.
6. **The issue ref is chosen per tracker**, not resolved once and shared.
7. **What could not be ported is degraded and labelled, never faked.**

## The measurements and discoveries this rests on

### The rename's real risk was two controls that fail silently

Everything else about a rename fails loudly: a stale `./crew.ts` import is a runtime
module-not-found, a missing command file is a missing command. Two things do not.

- **`engine.ts`'s per-tool permission deny rule.** A worker session created directly
  inherits no deny rules, so `engine.ts` denies each tool **by name** to stop a spawned
  worker re-entering it and recursing. Rename the tool, miss the string, and the rule still
  parses, still applies, and matches nothing. It guards nothing, and every test stays green.
- **`experimental.primary_tools`**, keyed the same way.

Neither would have produced an error. The deny rule is now pinned by a source-level test
that asserts both live tool names are denied *and* that a rule for the dead name is absent —
**mutation-verified: reverting the string to `crew` fails that test and nothing else.**

### Read both, write new — because the failure is silent and in the worst direction

Three formats outlive the code that wrote them, because they live in the user's repo rather
than in this one:

| format | pre-rename | if it were not read |
|---|---|---|
| config fence | ` ```crew ` | a configured repo is told it has **no config** |
| worktree branch prefix | `crew/<slug>` | a stranded worktree becomes invisible to the command that lists strays |
| artifact directory | `<stamp>-crew-plan` | an approved plan stops being runnable |

The first is the one that decided it. "You have no config" is not an error a user reads as a
bug — it is exactly what a fresh repo says. The tool would have offered to initialise over
the top of a working setup, and been thanked for it.

All three paths keep a regression test, and each carries a comment saying the old name is
**deliberate** — `lets.test.ts:64` for the fence ("this is the compatibility path"),
`lets.test.ts:393` for a `crew/legacy` worktree that must still list, and `tool.test.ts:119`
for a `-crew-plan` directory that must still be found. Without those comments the next
tidy-up reads them as stragglers and removes the only coverage the compatibility path has.

One detail inside it is load-bearing: the worktree lister **captures** the branch from
`git worktree list --porcelain` rather than rebuilding it as `crew/${slug}`. Rebuilding
would report a `lets/foo` worktree under a branch name that does not exist, and the removal
command printed beside it would fail.

### beads ids are random base36, so the plausible heuristic is wrong a third of the time

`feature/<id>-<slug>` cannot be split without knowing where the id ends, and a beads prefix
contains dashes of its own (`oci-infrastructure-73k`). The obvious heuristic — **the id ends
at the first segment carrying a digit** — matches `73k` and `5o2`, and then fails on the
first two ids sampled from real databases:

```
oci-infrastructure-ovb
bdsmoke-etx
```

`bd`'s suffixes are random base36, so **roughly a third of all ids carry no digit at all**
and would have resolved to null. Silently: a null id is indistinguishable from "no task on
this branch", which is a supported state.

So the parser reads the prefix from `.beads/issues.jsonl` — **`bd`'s own export**, where
every line carries an id, so the first one settles the prefix exactly. A fact the database
already knows beats a rule inferred about it.

### `issueIdentifierIn` is Linear-shaped, and no beads id can pass it

`ISSUE_IDENTIFIER` is `/^[A-Z][A-Z0-9]*-\d+$/`. Every beads id is lowercase with dashes in
the prefix, so scraping the directive returned null on **every single run**, and a configured
beads tracker would have taken the `issueRef: null` branch and degraded to terminal-only
without ever saying why.

Widening the regex would have been the wrong repair, and not because it is hard: **prose was
never the place to look.** The run already knows its task, because `/lets:start` wrote it to
the pointer file. `activeTaskId()` reads that.

**The ref is therefore chosen per tracker rather than resolved once.** Resolving beads-first
for everything hands Linear a beads id in a repo that has both `.beads/` and
`tracker: linear` — `findIssue` misses, the tracker prints `not found — continuing without
it`, and **a mirror that used to work quietly stops.** beads reads the pointer file;
everything else keeps scraping the directive, resolving exactly as before.

### The pointer file outranks the branch

A branch is frozen at the moment it is cut, so it records only the task it was *created*
for. A worktree can then host several tasks in sequence. Reading the branch first resumes
the wrong task — silently, and with a plausible-looking id, so nothing looks wrong until the
notes land on last week's bead.

Both sources are read before either is chosen, so this is a comparison rather than a
fall-through: the branch is the fallback, never the first answer. LETS's own detect-task
makes the same call for the same reason.

### Two bugs came from trusting the LETS text, and execution caught both

Neither was a porting mistake. Both were correct-looking prose that this `bd` does not
honour:

- **`done.md` says beads exposes `type`. This `bd` returns `issue_type`** (confirmed against
  `bd list --json`). The epic guard read `.type`, got `undefined`, never fired — and
  **would have closed epics silently.** Epics outlive their children; closing one is not a
  recoverable mistake on a shared board.
- **`bd close` with no id closes the last-touched issue rather than erroring.** So do `show`
  and `comment`. An absent id **retargets** the command instead of failing it, which is the
  worst available behaviour: it succeeds, on the wrong thing. The id rule now covers
  omission as well as shape, and a pointer file hand-edited to `--claim` dies at validation
  rather than arriving as a flag on a second argv.

The general lesson is the one worth keeping: a ported document describes the tool the author
had. It is a hypothesis about this machine, not a specification of it.

### The beads tracker is sparse on purpose, and never closes the bead

One note at run start, one per work item, one at finish — **`N + 2` `bd` invocations for `N`
items, and never one on `step()`.** A `bd` note is append-only into the user's real database,
unlike Linear's progress activity which is ephemeral and replaces itself, so a per-step note
would bury the bead's history under a run's stdout.

`step()` is a no-op for a second reason as well. It is the one hook that is both sync and
unprotected: `guarded()` swallows a `step()` throw with **no warning line**, so a shell-out
there would be slow *and* invisible when it failed. The terminal line comes from the stdout
tracker fanned out beside it.

`finish()` reports and **does not touch the bead's status**. `/lets:done` owns that
transition, because a run finishing is not a task finishing: a run can stop `item-stuck`
with half the work undone, and even a clean one only means the branch is ready.

### What could not be ported, and was degraded rather than faked

| LETS has | opencode has | what this does instead |
|---|---|---|
| `$CLAUDE_CODE_SESSION_ID` | no equivalent env var | entropy per session, with the same `:-$$` fallback the original already carries |
| the transcript path in the snapshot | no transcript to reopen | the block is omitted; recovery is from the snapshot's own content |
| SessionStart / PreCompact hooks | no hook wired | the session boundary is written only by an explicit `/lets:start` |

The third has a visible consequence, and it is deliberate: an `/lets:end` with no `/lets:start`
before it reports **`boundary unknown (no /lets:start this session)`** rather than guessing a
commit range. An unknown boundary is not an error — it means the session did not begin here.
A guessed range would be a number, which is worse than an admission, because a number gets
believed.

## Alternatives rejected

**Keeping `crew` as an alias.** An alias is a second name to keep true, and this rename
exists precisely so the name can mean something else. An alias that resolves to the old
pipeline while sub-project 3 ships the orchestrator is not back-compat; it is two tools
answering to one name.

**Widening `ISSUE_IDENTIFIER` to admit beads ids.** It would have worked and it would have
been wrong. The regex scrapes the *directive* — user prose — and the run already knows its
task from a file the tool itself wrote. Widening it also makes the Linear shape looser for
every Linear user, to fix a lookup that should not have been a lookup.

**Resolving the issue ref beads-first for every tracker.** The one-line version. It loses a
working Linear mirror in any repo that also has `.beads/`, and loses it quietly — the failure
is a "continuing without it" line in the middle of a run's output. Guarded by a source-level
test, mutation-verified: collapsing it back to the `??` form fails that test and nothing
else.

**Guessing the beads prefix from the branch string.** Covered above: wrong on about a third
of real ids, and wrong by returning null rather than by raising.

**Putting the beads adapter in `lets.ts`.** `lets.ts` is already 2000 lines and this would
have been its fourth tracker. `mcp.ts` set the precedent by holding `mcpTracker`; `beads.ts`
already held `safeId` and the `bd` transport.

**A beads note per `step()`.** Rejected on the append-only property above. It is also the
version that looks more thorough in a demo and is worse in the database a month later.

**Rewriting `PLAN.md` to the new name.** It is a dated journal of decisions as they were
made. Rewriting it would make the record lie about what was known when. It keeps its
original wording behind a header note.

**Creating `.beads/` when `bd` is present.** The binary says the tool is installed; the
directory says *this repo* opted in. Treating the binary as sufficient would make every repo
on the machine tracked, and the first write would create a database in a project that never
asked for one. That is not ours to do, so a repo without `.beads/` gets tracker `none` — a
supported, fully-rendered state rather than an error.

## Consequences

- **A repo configured before the rename keeps working**, and pays for it with a permanently
  wider fence regex, a wider branch regex, and a two-entry artifact-kind lookup. Each of the
  three has a regression test that says in a comment why the old name is there.
- **Two confinement controls now have explicit source-level coverage.** Both are asserted by
  reading the source text rather than by a live call, following the precedent already in
  `tool.test.ts` — a live check would need a server the suite refuses to call.
- **The command surface is eleven `lets` commands**, up from four. The daily cycle is
  `init → start → plan → execute → commit → done → end`, with `status`, `note`, `backlog`
  and `worktree` in between, none of which mutates a task.
- **Shared command logic lives in `skills/`, not duplicated across command files.**
  `/lets:status` and `/lets:start` cannot drift into rendering the same snapshot two ways.
  `lets-commit` is deliberately reachable from conversation as well, so "commit this" and
  `/lets:commit` produce the same commit; the other four are command-invoked only.
- **beads is the only tracker that reads a file rather than the directive**, which is a real
  asymmetry in the seam. It is documented at `trackerFor` rather than smoothed over, because
  the smoothing is what broke Linear.
- **`src/beads.ts` is no longer dead code** — `index.ts` and `lets.ts` both import it.
- **A session that did not start with `/lets:start` reports an unknown boundary forever.**
  There is no hook to recover it from, and no plan to guess it.
