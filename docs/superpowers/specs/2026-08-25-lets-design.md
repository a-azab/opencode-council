# `/lets` — the rename

**Date:** 2026-08-25 · **Status:** proposed (rev 2, after spec review) · **Sub-project 2a of 3**

---

## 1. Why this is its own sub-project

Rev 1 tried to land a rename, four new commands, a tracker, two gates, a compaction hook and
a model-filter fix in one plan. The review measured the rename alone at **262 occurrences
across 20 source files**, and rev 1's own risk table already called it the top risk.

So this spec is **the mechanical rename and nothing else.** Its definition of done is that
the suite still shows **178 green** and behaviour is byte-for-byte identical. Every new
behaviour — the session spine, beads, the ADR and docs gates, the compaction hook — moves to
sub-project 2b, which gets its own spec once this lands (§7, which also records five design
problems the review already found there, so they are not rediscovered later).

**The reason for the rename:** sub-project 3 makes `crew` an orchestrator that runs several
`lets`. Two things cannot both be called crew. The pipeline that exists today — intake,
worktree, implement, verify, acceptance judge, commit, PR, escalation, termination floors —
is a **single-task attended workflow**, which is what `lets` means.

---

## 2. The governing rule

Two categories, and conflating them is how a rename breaks things silently.

| category | rule | why |
|---|---|---|
| **Persisted formats** — things already written to disk by earlier runs | **read both names, write the new one** | a repo's config, a worktree branch, an approved plan on disk. Renaming hard makes existing state invisible, and the failure is silent: the tool reports "no config" rather than "your config is in the old format" |
| **In-process strings** — nothing outside the process depends on them | **rename hard** | the tool name, the permission deny rule, module paths. Leaving the old name is dead weight, and in one case a security hole |

---

## 3. What changes

### 3.1 Hard renames

| from | to |
|---|---|
| `src/crew.ts` | `src/lets.ts` |
| `src/crew.test.ts` | `src/lets.test.ts` |
| tool `crew` | tool `lets` |
| modes `init \| plan \| run \| status` | **unchanged** — `run` stays `run`; sub-project 2b adds `start`/`commit`/`done`/`end` |
| `command/crew:{init,plan,execute,status}.md` | `command/lets:{init,plan,execute,status}.md` |
| `agent/crew-{cpo,cto,dev}.md` | `agent/lets-{cpo,cto,dev}.md` |
| `CREW_MODELS` | `LETS_MODELS` |
| `readCrewConfig`, `parseCrewBlock`, `renderCrewBlock`, `CrewConfig` | `readLetsConfig`, `parseLetsBlock`, `renderLetsBlock`, `LetsConfig` |

**`engine.ts:241` is the one that matters.** It carries
`{ permission: "crew", pattern: "*", action: "deny" }` — the rule that stops a spawned
worker re-entering the tool and recursing. If the tool becomes `lets` and that string stays
`"crew"`, **the deny rule silently stops matching and the confinement lapses.** It must
become `"lets"`, and §5 tests it directly. This is precisely the "documented as true while
being false" failure this codebase has already shipped once.

Agent names inside prompts (`agent: "crew-dev"` at the `ask()` call sites) rename with the
files, or the worker loads no agent at all.

### 3.2 Persisted formats — read both, write new

| format | today | after |
|---|---|---|
| **AGENTS.md fence** | ` ```crew ` | `FENCE` accepts ` ```crew ` **or** ` ```lets `; `renderLetsBlock` writes ` ```lets ` |
| **worktree branch** | `crew/<stamp>` | new worktrees use `lets/<stamp>`; `listWorktrees`' `refs/heads/` scan matches **both**, so worktrees created before the rename stay visible and removable |
| **artifact dirs** | `<stamp>-crew-plan`, `<stamp>-crew-run` | new runs write `-lets-plan` / `-lets-run`; `latestArtifact` looks for **both**, so a plan approved before the rename is still executable |

Without the read-both half, each of these fails silently and in the worst direction: a repo
with a ` ```crew ` block would be told "this repo has no lets config yet", a stranded
worktree would vanish from `lets:status` while still occupying disk, and an approved plan
would become unrunnable with no error.

The old names stay readable indefinitely. This costs one regex alternation each and is not
worth a migration command.

### 3.3 Files with value imports — fatal if missed

There is **no build step**; node strips types without checking. A stale
`from "./crew.ts"` is a runtime module-not-found, not a compile error:

- `src/mcp.test.ts:8` — `parseCrewBlock, renderCrewBlock, trackerFor, availableTrackers`
- `src/linear.test.ts:5` — `linearTracker`
- `src/tool.test.ts:211` — a **dynamic** `await import("./crew.ts")`, which a grep for
  static imports will not catch
- `src/mcp.ts:15` — type-only import; harmless at runtime, wrong nonetheless

---

## 4. Interfaces — every file touched

Measured: 262 occurrences across 20 files (excluding `docs/`).

| file | what changes |
|---|---|
| `src/crew.ts` → `src/lets.ts` | the module itself; internal symbols per §3.1; `FENCE`, branch prefix, `listWorktrees` scan per §3.2 |
| `src/index.ts` | tool key `crew` → `lets`; artifact kinds; `experimental.primary_tools` list; the "no config" message; agent/command loading is by directory so it follows the file renames |
| `src/engine.ts` | **`permission: "crew"` → `"lets"`** (§3.1) |
| `src/schema.ts` | `WORKITEMS_SCHEMA` and any crew-named schema constants |
| `src/roster.ts` | the `crew`-referencing comment at `:92` |
| `src/mcp.ts` | type import path |
| `src/mcp.test.ts`, `src/linear.test.ts`, `src/tool.test.ts` | value imports (§3.3) |
| `src/index.test.ts` | tool keys at `:26,:40`; agent names `crew-{cpo,cto,dev}` at `:47-62`; command names at `:67`; **reads `src/crew.ts` by path at `:168`** |
| `src/tool.test.ts` | tool key at `:19`; the `/No live crew worktrees/` assertions at `:126,:138` |
| `src/crew.test.ts` → `src/lets.test.ts` | renamed; internal references |
| `command/crew:*.md` → `command/lets:*.md` | renamed; **plus cross-references inside them** — `command/crew:execute.md` alone holds 5 |
| `agent/crew-*.md` → `agent/lets-*.md` | renamed |
| `README.md`, `AGENTS.md` | the whole surface; this repo's own AGENTS.md carries a ` ```crew ` block at `:5-9` |
| `~/.config/opencode/command/workflow.md` | **outside the repo** — routes to council commands only, so it needs no change here, but confirm |

---

## 5. Testing

The suite must show **178 green, unchanged**. New tests are guards, not new behaviour.

| what | why |
|---|---|
| **no `from "./crew.ts"` or `import("./crew.ts")` survives anywhere in `src/`** | the highest-value guard: with no build step this is a runtime module-not-found. rev 1's grep matched command names only and would have missed every one |
| no pre-rename `crew:` **command name** survives in `command/`, `src/`, `README.md` | dangling cross-references; same technique that worked in sub-project 1, matching exact names rather than the bare prefix |
| every `lets:*` command registers under its colon name | a misnamed command file is silently absent, never an error |
| **the spawned-worker deny rule names the tool that actually exists** | assert `engine.ts` denies `"lets"`. If this regresses, a worker can re-enter the tool and recurse — the confinement lapses silently |
| `experimental.primary_tools` contains `lets` | otherwise the tool is registered but not surfaced |
| a ` ```crew ` block still parses, and a ` ```lets ` block parses | existing repos must not silently lose their config |
| `renderLetsBlock` writes ` ```lets ` | new writes use the new name |
| `listWorktrees` sees a `crew/<stamp>` branch **and** a `lets/<stamp>` branch | a pre-rename worktree must stay visible, or it is stranded on disk with no way to find it |
| `latestArtifact` finds a `-crew-plan` directory **and** a `-lets-plan` directory | an approved plan must not become unrunnable |
| the four `lets` tool modes still parse (`init`, `plan`, `run`, `status`) | the mode enum is separate from the tool key and easy to miss |

---

## 6. Risks

| risk | mitigation |
|---|---|
| 262 references is a large mechanical change | it is *only* mechanical — no behaviour changes, and 178 green is the acceptance test |
| A stale dynamic import (`tool.test.ts:211`) evades a static grep | §5's guard greps the string, which catches both forms |
| The deny-rule string is easy to miss and fails silently | it has its own test row, and it is called out twice in this spec |
| Renaming persisted formats strands existing state | §2's read-both rule, with a test row per format |

---

## 7. Sub-project 2b — deferred, with what the review already found

Not in this spec: `lets:start`, `lets:commit`, `lets:done`, `lets:end`; beads as a tracker;
the ADR and docs gates; the compaction hook; the implementer model policy.

Five design problems the rev-1 review surfaced, recorded so 2b starts from them rather than
rediscovering them:

1. **A beads tracker cannot receive its id through the existing seam.** `trackerFor`'s
   `issueRef` is the only channel, and it is produced by `issueIdentifierIn`, whose regex is
   `/^[A-Z][A-Z0-9]*-\d+$/`. Beads ids (`oci-infrastructure-5o2`, `bd-a3f8e9`) fail it, so a
   beads tracker would fall back to terminal-only on every run. The seam needs a real change,
   not just a new implementation.
2. **`lets:start`'s branch is discarded.** `runExecute` computes its own timestamp slug and
   cuts `crew/<stamp>` off `cfg.base`; it has no parameter for an existing branch. A spine
   that starts on `feature/<id>-<slug>` and an execute that works elsewhere are two different
   branches, and `lets:done` would have two candidates to push.
3. **The ADR gate has nothing to check against.** `plan.json` carries no ADR path and
   `runExecute` receives none, so "refuses to start without an ADR" degrades to "some file
   exists in `docs/adr/`" — already true, so it would pass on day one having enforced nothing.
4. **The docs gate would inherit a fail-open judge.** `checkAcceptance` is **not exported**
   (so untestable as written), and it returns `met: true` both when no judge is available and
   when the judge did not run. A gate routed through it is the "sentence in a prompt" the gate
   exists to replace. A deterministic path check is feasible — it already has the diff. And
   the opt-out has nowhere to live: `WorkItem` has exactly four fields, `WORKITEMS_SCHEMA`
   requires exactly those, and `ItemOutcome` has no such field.
5. **The model filter is the wrong one.** `LETS_MODELS` has two call sites: `runIntake`
   passes a schema (deepseek 400s) and `runItem` does not (deepseek works). Adding deepseek
   breaks **intake**, and `canAgentic` — which rev 1 named — passes deepseek and so prevents
   nothing. It needs `canSchema` at the intake site **and** `canAgentic` at the implementer
   site: one list, two filters.

Verified `bd` facts for 2b, so they are not re-derived: `--json` is a **global** flag (so
`bd create --json` returns the new id rather than needing stdout scraped); `bd ready` already
means "open beads, ready first"; `bd update <id> --claim` is atomic, sets the assignee, is
idempotent, and is the convention the human's own `oci-infrastructure/AGENTS.md` documents;
beads persists via Dolt (`bd dolt push`), and whose job that is remains undecided.
