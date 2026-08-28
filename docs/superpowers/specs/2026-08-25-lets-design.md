# `/lets` — the rename

**Date:** 2026-08-25 · **Status:** proposed (rev 3, after two spec reviews) · **Sub-project 2a of 3**

---

## 1. Why this is its own sub-project

Rev 1 tried to land a rename, four new commands, a tracker, two gates, a compaction hook and
a model-filter fix in one plan. Measured, the rename alone is **336 `crew` lines across 24
files**, and rev 1's own risk table already called it the top risk.

So this spec is **the rename and nothing else.** Everything new — the session spine, beads,
the ADR and docs gates, the compaction hook, the implementer model policy — moves to
sub-project 2b, which gets its own spec once this lands (§8, which also records six design
problems the reviews already found there, so they are not rediscovered).

**Why rename at all:** sub-project 3 makes `crew` an orchestrator that runs several `lets`.
Two things cannot both be called crew. What exists today — intake, worktree, implement,
verify, acceptance judge, commit, PR, escalation, termination floors — is a **single-task
attended workflow**, which is what `lets` means.

**Acceptance:** the suite is green and the three read-both behaviours in §3.2 are covered.
This is *not* "byte-for-byte identical" — §3.2 deliberately adds three small reader changes,
and claiming otherwise would misdescribe the work.

---

## 2. The governing rule

Two categories. Conflating them is how a rename breaks things silently.

| category | rule | why |
|---|---|---|
| **Persisted formats** — already written to disk by earlier runs | **read both names, write the new one** | a repo's config, a worktree branch, an approved plan. Renaming hard makes existing state invisible, and it fails in the worst direction: the tool says "no config" rather than "your config is in the old format" |
| **In-process strings** — nothing outside the process depends on them | **rename hard** | the tool key, the permission rules, module paths. Leaving the old name is dead weight, and in two cases a security hole |

---

## 3. What changes

### 3.1 Hard renames

| from | to |
|---|---|
| `src/crew.ts` | `src/lets.ts` |
| `src/crew.test.ts` | `src/lets.test.ts` |
| tool key `crew` | tool key `lets` |
| modes `init \| plan \| run \| status` | **unchanged** — `run` stays `run`; 2b adds the rest |
| `command/crew:{init,plan,execute,status}.md` | `command/lets:{…}.md` |
| `agent/crew-{cpo,cto,dev}.md` | `agent/lets-{cpo,cto,dev}.md` |
| `CREW_MODELS` | `LETS_MODELS` |
| `readCrewConfig`, `parseCrewBlock`, `renderCrewBlock`, `CrewConfig` | `readLetsConfig`, `parseLetsBlock`, `renderLetsBlock`, `LetsConfig` |

**Two confinement controls are keyed on the tool name, and both fail silently if missed:**

1. `engine.ts:241` — `{ permission: "crew", pattern: "*", action: "deny" }`. This is what
   stops a spawned worker re-entering the tool and recursing. Leave it as `"crew"` and it
   stops matching anything: **the deny lapses with no error.**
2. `index.ts:559-560` — `experimental.primary_tools` pins `["council", "crew"]`. Its own
   comment (`:556-557`) names it as the control keeping the tool out of task-tool subagents.

Both must name `lets`. Each gets its own test row (§6). This codebase has already shipped a
confinement that was documented as true while being false; these are the same shape.

**Agent names inside prompts** (`agent: "crew-dev"` at the `ask()` call sites) rename with
the files, or the worker loads no agent at all.

### 3.2 Persisted formats — read both, write new

#### The AGENTS.md fence

`FENCE` (`crew.ts:81`) is confirmed the only matcher — used at `:92` and `:196`. It accepts
` ```crew ` **or** ` ```lets `; `renderLetsBlock` writes ` ```lets `.

Two more strings are written into the user's AGENTS.md and drift cosmetically if ignored:
`HEADING = "## Crew"` (`crew.ts:182`) and the section prose `` Config for `/crew`. ``
(`crew.ts:198`). This repo's own `AGENTS.md:3` already reads "Config for `/crew:plan`", so
the written prose has drifted from `:198` once already.

#### The worktree branch prefix

**Three sites, not one** — rev 2 named only the middle pair:

| site | role |
|---|---|
| `crew.ts:1064` | **writes** — `openWorktree` creates `` `crew/${slug}` `` |
| `crew.ts:1116`, `:1120` | **reads** — `listWorktrees` scans `refs/heads/crew/` and rebuilds the name |
| `crew.ts:1631` | **reads** — `branchExists(root, \`crew/${slug}\`)` in `runExecute`'s collision loop |

Miss `:1631` and the collision guard checks a namespace nothing writes to any more; then
`git worktree add -b` throws on the exact collision the comment at `:1626-1629` exists to
prevent.

**The prefix must be captured, not reconstructed.** `:1120` currently rebuilds the branch as
`` `crew/${slug}` `` from the captured slug. Widening only the regex to
`refs/heads/(?:crew|lets)/(.+)` leaves it reporting a `lets/foo` worktree as branch
`crew/foo` — a name that does not exist, printed in the removal command a human will run.

#### Artifact directories

`latestArtifact` (`index.ts:150`) is confirmed the only reader (called at `:223`), but it is
**shared with the council path** (`:522` `review`, `:529` `fix`), so a signature change
reaches modes this sub-project otherwise does not touch. Prefer accepting `kind: string[]`
or making two calls over an alternation interpolated into the existing anchored template,
which breaks the anchors unless the group is non-capturing.

Note the tiebreak: selection is `.sort().pop()` over directory names, so at an identical
timestamp `lets-plan` sorts after `crew-plan` and wins. That is the correct preference; it
is worth stating because it is accidental rather than designed.

### 3.3 Value imports — fatal if missed, no build step

A stale `from "./crew.ts"` is a runtime module-not-found, not a compile error:

- `src/index.ts:24` — the plugin entry point's own import
- `src/crew.test.ts:42`
- `src/mcp.test.ts:8` — `parseCrewBlock, renderCrewBlock, trackerFor, availableTrackers`
- `src/linear.test.ts:5` — `linearTracker`
- `src/tool.test.ts:211` — a **dynamic** `await import("./crew.ts")`, invisible to a
  static-import grep
- `src/mcp.ts:15` — type-only; harmless at runtime, wrong nonetheless

### 3.4 What must NOT be renamed

**Ten existing tests feed ` ```crew ` as input**, and they are the read-both regression
suite for free — but only if left alone. A find/replace converts them to ` ```lets ` and
deletes the only coverage of the compatibility path §3.2 exists to provide:

`crew.test.ts:64, 238, 239, 615, 617, 625, 626` · `mcp.test.ts:177, 180` · `tool.test.ts:37`

These fixtures stay `crew` **deliberately**, and want a comment saying so, or the next
tidy-up removes them.

---

## 4. Interfaces — every file touched

Measured: **336 `crew` lines across 24 files.**

| file | what changes |
|---|---|
| `src/crew.ts` → `src/lets.ts` | the module; symbols per §3.1; `FENCE`, `HEADING`, prose, all three branch sites, per §3.2 |
| `src/index.ts` | value import `:24`; tool key; artifact kinds; `primary_tools` `:559-560`; the "no config" message |
| `src/engine.ts` | **`permission: "crew"` → `"lets"`** (§3.1) |
| `src/roster.ts` | the `crew`-referencing comment at `:92` |
| `src/linear.ts` | `:1`, `:8` — prose/comment references |
| `src/mcp.ts` | type import `:15`; **and `:239`**, which emits `` `crew run ${r.stoppedBy}…` `` into the user's real issue tracker at runtime |
| `src/mcp.test.ts`, `src/linear.test.ts`, `src/tool.test.ts` | value imports (§3.3) |
| `src/index.test.ts` | tool keys `:26,:40`; agents `:47-62` **plus the `crew-dev` special-cases at `:56` and `:63-68`**; command names `:67`; modes `:71`; **reads `src/crew.ts` by path at `:168`** |
| `src/tool.test.ts` | tool key `:19`; `/No live crew worktrees/` `:126,:138`; `/crew:init/` `:139` |
| `src/roster.test.ts:131`, `src/failover.test.ts:6` | references |
| `src/crew.test.ts` → `src/lets.test.ts` | renamed; internal references **except the §3.4 fixtures** |
| `command/crew:*.md` → `command/lets:*.md` | renamed, **and the bare tool invocation inside each** — see §6 |
| `agent/crew-*.md` → `agent/lets-*.md` | renamed |
| `README.md`, `AGENTS.md` | the surface; this repo's own AGENTS.md carries a ` ```crew ` block at `:5-9` |
| `PLAN.md` | **30 lines**, including `:724`, `:727`, `:760` documenting the fenced block as spec-of-record. It is a dated journal: leave the history, but these three describe current behaviour |

**Not touched:** `src/schema.ts` — verified **zero** `crew` occurrences; rev 2 listed it in
error. `~/.config/opencode/command/workflow.md` — verified: it routes to `/council:*` only
and needs no change.

**Assertions whose value must change** (not mechanical, easy to mistake for it):
`crew.test.ts:99, 219, 371, 471, 475` · `index.test.ts:26, 40, 47, 56, 63, 67, 71, 168` ·
`tool.test.ts:19, 126, 138, 139`.

---

## 5. The guard that rev 2 would have missed

Every command file invokes the tool by **bare name, with no colon**:

```
command/crew:init.md:5     Call the `crew` tool with `mode: "init"` and no other arguments.
command/crew:plan.md:5     Call the `crew` tool with `mode: "plan"` and `directive` set to …
command/crew:execute.md:5  Call the `crew` tool with `mode: "run"`.
command/crew:status.md:5   Call the `crew` tool with `mode: "status"` and no other arguments.
```

A guard matching `crew:` command names sails past all four. Rename the tool and miss these,
and **every command instructs the model to call a tool that does not exist** — which is a
silent no-op, never an error. This needs its own guard, matching the bare backticked tool
name inside `command/`.

---

## 6. Testing

Most rows **extend tests that already exist** rather than adding new ones, so the count
moves little: `index.test.ts:38-41` (primary_tools), `:67-69` (command registration),
`:71-72` (modes) already assert these things under the old names.

| what | new or extended |
|---|---|
| no `from "./crew.ts"` or `import("./crew.ts")` survives in `src/` — **the guard must exclude its own file**, or it matches the string it searches for | new |
| no ``` `crew` ``` bare tool invocation survives in `command/` (§5) | new |
| no pre-rename `crew:` command name survives in `command/`, `src/`, `README.md` — note **test titles** trip this: `"crew:init with tracker mcp writes wiring…"`, `"commands are registered for every crew entry point"`, `"status answers in a repo with no crew config"` | new |
| every `lets:*` command registers under its colon name | extends `:67-69` |
| **the spawned-worker deny rule names `lets`** — source-text assertion, following the existing precedent at `index.test.ts:164-174` which `readFileSync`s `src/engine.ts` and regexes it | new |
| `primary_tools` contains `lets` | extends `:38-41` |
| the four modes still parse | extends `:71-72` |
| a ` ```crew ` block still parses **and** a ` ```lets ` block parses | §3.4's fixtures cover the first for free; the second is new |
| `renderLetsBlock` writes ` ```lets ` | extends an existing render assertion |
| `listWorktrees` sees a `crew/<stamp>` branch **and** a `lets/<stamp>` branch, and **reports each with its own prefix** | new. Post-rename `openWorktree` only produces `lets/`, so the legacy branch must be built by hand — `crew.test.ts:702` already shows the pattern (`execFileSync("git", ["branch", "crew/…"])`) |
| `latestArtifact` finds a `-crew-plan` directory **and** a `-lets-plan` directory | new |

---

## 7. Risks

| risk | mitigation |
|---|---|
| 336 lines across 24 files | it is mechanical apart from §3.2's three readers; a green suite plus §6's guards is the acceptance test |
| Two confinement controls fail silently if missed | one test row each, and both are called out twice in this spec |
| A find/replace destroys §3.4's compatibility fixtures | §3.4 names all ten lines |
| The dynamic import at `tool.test.ts:211` evades a static grep | §6's guard greps the string, catching both forms |
| `latestArtifact`'s signature is shared with council modes | prefer an additive `kind: string[]` over rewriting the template |

---

## 8. Sub-project 2b — deferred, with what the reviews already found

Not here: `lets:start`, `lets:commit`, `lets:done`, `lets:end`; beads as a tracker; the ADR
and docs gates; the compaction hook; the implementer model policy.

> **Status, 2026-08-28.** All of the above shipped except the compaction hook, which was
> **cancelled rather than deferred.** The human turned auto-compaction off entirely
> (`compaction: { auto: false }` in the global config) and chose `/lets:end` as the session
> boundary instead: snapshot deliberately, start fresh, resume from the `## RESUME` file.
>
> That makes the hook moot. Its whole purpose was to keep a few facts alive *through* a
> compaction, and there are now no compactions to survive. Building it would add a code path
> that never runs — and one whose only trigger the human has disabled on purpose.
>
> The trade is real and was accepted knowingly: with `auto: false` there is no graceful
> degradation at the context limit, so the discipline replaces the safety net. `/lets:end`
> earns its keep here rather than being a nicety — it is now the only thing standing between
> a long session and losing its own thread.

1. **A beads tracker cannot receive its id through the existing seam.** `trackerFor`'s
   `issueRef` is the only channel, produced by `issueIdentifierIn`, whose regex is
   `/^[A-Z][A-Z0-9]*-\d+$/`. Beads ids (`oci-infrastructure-5o2`, `bd-a3f8e9`) all fail it,
   so a beads tracker falls back to terminal-only on every run. The seam needs a real change.
2. **`Tracker.step()` is sync, and `guarded()` swallows its throws with no warning line** —
   unlike `start`/`itemDone`/`finish`. It also catches only synchronous throws, so a
   fire-and-forget shell-out escapes it entirely (`linearTracker` handles this with an
   explicit `.catch`). Per-item progress belongs on `itemDone`, which is async and properly
   guarded. Note too that linear's progress line is *ephemeral and replaces itself*, whereas
   `bd note` appends into the human's real database.
3. **`lets:start`'s branch would be discarded.** `runExecute` computes its own slug and cuts
   `crew/<stamp>` off `cfg.base`, with no parameter for an existing branch.
4. **The ADR gate has nothing to check against.** `plan.json` carries no ADR path and
   `runExecute` receives none, so the gate degrades to "some file exists in `docs/adr/`" —
   already true, so it would pass on day one having enforced nothing.
5. **The docs gate would inherit a fail-open judge.** `checkAcceptance` is not exported (so
   untestable as written) and returns `met: true` both when no judge is available and when
   the judge did not run. A deterministic path check is feasible — it already has the diff.
   The opt-out has nowhere to live: `WorkItem` has exactly four fields, `WORKITEMS_SCHEMA`
   requires exactly those, and `ItemOutcome` has no such field.
6. **The model filter is the wrong one.** `LETS_MODELS` has two call sites: `runIntake`
   (`:735`) passes a schema — deepseek 400s — and `runItem` (`:1442`) does not — deepseek
   works. Adding deepseek breaks **intake**, and `canAgentic` passes deepseek so prevents
   nothing. It needs `canSchema` at the intake site and `canAgentic` at the implementer site.

Verified `bd` facts for 2b: `--json` is a **global** flag, so `bd create --json` returns the
new id rather than needing stdout scraped; `bd ready` already means "open beads, ready
first"; `bd update <id> --claim` is atomic, sets the assignee, is idempotent, and is the
convention the human's own `oci-infrastructure/AGENTS.md` documents; beads persists via Dolt
(`bd dolt push`) and whose job that is remains undecided.
