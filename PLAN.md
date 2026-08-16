# opencode-council

A multi-model code workflow for opencode, shipped as a single plugin package.

Ports the useful IP from [restarter/lets-workflow](https://github.com/restarter/lets-workflow)
(a Claude Code plugin) onto opencode, folded into the existing `council-*` multi-model
commands. Replaces both.

**Status:** Phase 0 (spike). Nothing built yet.

---

## 1. Why this exists

Two source systems, each missing what the other has:

| | lets-workflow | existing council commands |
|---|---|---|
| axis | 15 **roles**, 1 model | 10 **models**, 1 generic prompt |
| loop | none — fixed-depth pipeline | one conditional round 3 |
| aggregation | model judgment (prose) | model judgment (prose) |
| verifies a fix | never | never |

This project is the synthesis: **role × model, with a bounded loop and arithmetic
aggregation.**

### Findings that motivated the rewrite

- **The current `council-*` commands never load the `council-*` agents.** All eight
  `agent/*.md` role prompts (10-category rubrics, Fable's security veto, GLM's moderator
  instructions) are dead config. Execution is `opencode run --agent build -m <model>`
  subprocesses with an inline heredoc. Ten models share one generic prompt.
- **Three registries disagree** on model strings — `opencode.json`, `agent/*.md`, and the
  `MODELS` heredocs. Only the heredocs execute.
- **`prune` substring-matches `'error:'` / `'timeout'` / `'429'` against response bodies.**
  A review that quotes an error string is silently dropped.
- **The ~90-line bash helper is copy-pasted verbatim into all four commands.**
- **lets-workflow has no convergence loop anywhere.** Its headline "dynamic agent
  selection" is a lookup table plus one bias rule (`Default is INCLUDE. Only skip if
  clearly irrelevant`).
- `council-fable` — the security specialist holding veto power — is in no roster and no
  config. The security lane silently does not exist.
- `council-qwen.md` points at `nvidia/qwen/qwen3.5-122b-a10b`; there are no nvidia
  credentials. That agent cannot run as written.

---

## 2. Locked decisions

Do not re-litigate these. Each was decided deliberately; the rationale is recorded so a
future session doesn't reopen it.

| # | Decision | Rationale |
|---|---|---|
| D1 | **Ship as one plugin package**, not loose files in `~/.config/opencode/` | Config dir gains one line instead of 20 files. Versioned, publishable, own pinned deps. |
| D2 | **TypeScript + SDK executor.** No bash, no `.run-model.sh` | Doing bash-now-plugin-later guarantees two implementations of the same aggregation logic — the exact "Keep in sync" duplication tax that lets-workflow admits is a standing bug source. |
| D3 | **No single model decides anything** | Every decision is arithmetic over structured findings. The moderator role is deleted. Also removes a single point of failure: every council flow currently routes decisions through Opus 5 → the local proxy on `127.0.0.1:3456`. |
| D4 | **Closed fix loop, human gate before any write** | The novel capability. Neither source system verifies a fix. |
| D5 | **Fixes are emitted as patch artefacts, applied by `git apply` after approval** | Reuses the pattern already in `council-task.md`. No agent needs write permission; the only writer is the human. |
| D6 | **Agents are named by ROLE; model is runtime data** | The current model-named agents are the root cause of the three-registry drift. `session.prompt({agent, model})` takes both as typed fields. |
| D7 | **nemotron via opencode Zen free tier** | User choice. Needs `opencode auth login`. Free tier + fan-out ⇒ `serial` flag required. |
| D8 | **qwen via `opencode-go/qwen3.8-max`** | `nvidia/*` has no credentials. |
| D9 | **`git init` `/root/.config/opencode` before deleting anything there** | It is not under version control. No undo exists today. |
| D10 | **No SDK dependency — plain `fetch` against the injected `serverUrl`** | Sidesteps the v1/v2 client split entirely (the v1 client can't carry `format`). Proven in the Phase 0 spike. Zero deps, no build step, no version trap. |
| D11 | **No text-JSON fallback for models that can't do structured output** | 11 models work natively. A second parse path for 2 models is complexity for marginal diversity. A model either passes the smoke test or is not in the roster. |

### Explicitly NOT porting

- The Go CLI — statusline, init, update, worktree, notify, cmux/tmux. opencode has its
  own; `git worktree` exists; superpowers has `using-git-worktrees`.
- **beads / task tracking.** Not installed. opencode persists sessions in SQLite.
- `hooks.json` rules injection — `AGENTS.md` is auto-loaded, and
  `experimental.chat.system.transform` is already used by two plugins.
- The `*.workflow.js` layer — a Claude Code research preview, and a second implementation
  of logic that also exists in prose.
- 14 of 15 lets agents — ponytail *is* the pragmatist agent; superpowers covers
  planning/QA/debugging.

---

## 3. Architecture

```
 diff ──▶ route ──▶ fan-out (parallel child sessions, one per model×role)
                    [security] [systems] [code] [qa] ...
                         │ join
                         ▼
                     verify ── skeptic ×3/BLOCKER, ×2/SUGGESTION
                         │      never the model that raised the finding
                         ▼
                     decide() ─────────────────────────── DETERMINISTIC
                         │
              disputes? ─no──────────────────────┐
                         │yes                    │
                         ▼                       │
                      debate (only disputing models, only disputed findings)
                         │                       │
              converged? ─no & round<MAX─▶ recompute  ⟲   LOOP 1
                         │yes                    │
                         ▼                       ▼
                     ┌────────── report ─────────┘
                     │  ██ HUMAN GATE ██
                     ▼
                    patch ──▶ git apply ──▶ re-verify changed hunks only,
                         │                  by a model that is not the finder
                         │                  + project test command must pass
                         └── unresolved & attempts<2 ──⟲   LOOP 2
                                    │
                              escalate to human
```

### Everything that used to be a model decision is now arithmetic

| decision | mechanism |
|---|---|
| dedupe | key = file + overlapping line range + category |
| CONSENSUS vs DISPUTED | tier variance among models that saw the same region |
| assign debaters | the models that disagree on finding X debate X |
| convergence | tier deltas == 0 since last round, or no disputes left, or round == MAX |
| keep / downgrade / drop | `decide()` over skeptic votes |
| final report | template filled from JSON. A prose pass may summarize but **cannot add, remove, or re-tier a finding.** |

### `decide()` — ported from lets-workflow, asymmetric on purpose

```
votes = 0                                    → keep       (never drop on absent evidence)
BLOCKER: all-false OR majority-high-false    → drop
BLOCKER: majority-false                      → downgrade
other:   majority-false                      → drop
otherwise                                    → keep

category == security: drop requires UNANIMOUS high-confidence false.
```

The security asymmetry attaches to the finding's **category** and is applied by code — no
model or role holds a veto. Whichever model happens to run the security role gets no
special standing.

### Planning (`/council-plan`) — no diff to compute against

Every model proposes → every model scores every proposal **except its own** against a
fixed rubric → arithmetic tally → ties escalate to the human, never to a tiebreaker model.
(The self-exclusion generalizes lets-workflow's rule that the architect cannot evaluate
its own design.)

---

## 4. Runtime gotchas — verified against opencode 1.18.13

Hard-won. Do not rediscover these.

1. **Do not use an SDK client at all — use `fetch` against the injected `serverUrl`.**
   The plugin's injected `client` is v1, whose `SessionPromptData` type has no `format`
   field, so structured output is unavailable (or silently dropped) through it. Rather
   than pull in a second SDK version and inherit the v1/v2 split, issue plain HTTP —
   proven working in the Phase 0 spike:
   ```ts
   await fetch(`${serverUrl}session/${id}/message`, {
     method: "POST",
     headers: { "content-type": "application/json", authorization: basicAuth },
     body: JSON.stringify({ model: { providerID, modelID }, agent, parts, format }),
   })
   ```
   Zero dependencies, no version trap, no build step. (**D10**)
2. **`session.create({parentID})` bypasses `subagent_depth` AND the task tool's
   auto-deny.** Those denies are injected *by the task tool*, not inherent to child
   sessions. A self-created worker inherits **no** deny rules — `council()` can recurse
   into itself. Replicate the deny explicitly.
3. **Errors do not throw.** They arrive as `data.info.error` on a **200** response. The
   success check is `info.structured !== undefined`, never try/catch.
4. **The error union has 8 members and none are named what you'd guess:**
   | intent | actual |
   |---|---|
   | auth failure | `ProviderAuthError` |
   | malformed output | `StructuredOutputError` |
   | rate limited | `APIError` with `statusCode === 429` (+ `isRetryable`, `Retry-After` in `responseHeaders`) |
   | timeout | **no distinct type** — indistinguishable from a user abort. Tag it client-side with your own `AbortSignal.timeout`. |
   | others | `ContextOverflowError`, `ContentFilterError`, `MessageOutputLengthError`, `MessageAbortedError` |
5. **Structured output is implemented as a forced tool call** (`toolChoice: "required"`).
   Models that can't do forced tool calls will fail 100% of the time → hence the roster's
   `structured` flag and the text-JSON fallback.
6. **Parallelism**: the busy guard is per-`sessionID` (HTTP 409). `Promise.all` over
   *distinct child sessions* is genuinely concurrent; over one session it is not. No
   global concurrency cap exists — provider rate limits are the real ceiling.
7. **Use blocking `session.prompt`, not `prompt_async`.** `prompt_async` returns 204 with
   nothing, forcing out-of-band collection. The blocking call returns `info.structured`
   directly and parallelizes fine via `Promise.all`.
8. **Tool results truncate at 2000 lines / 51200 bytes** (full text spills to
   `<data>/tool-output/`, 7-day retention). `council()` returns a compact verdict; the
   long report is written to `council-artifacts/<slug>/`.
9. **Version trap:** `/root/.config/opencode/node_modules` is pinned at **1.17.11** while
   the CLI is **1.18.13**. Develop in this repo with its own pinned deps.
10. **Plugin loading:** absolute paths and `./`, `../` work in `"plugin": [...]`;
    `file:` with one slash does **not**. No hot reload — restart required. Load errors are
    logged then swallowed, so a broken plugin starts silently: check
    `~/.local/share/opencode/log/opencode.log`.
11. `config.skills` is real at runtime but **absent from the local `.d.ts`** — needs
    `@ts-expect-error` or a local widening.
12. Do **not** build on the v2 plugin API (`define({id, setup})`). It exists and is more
    capable, but every call site in the binary is an internal plugin and it is unconfirmed
    whether an external package can export one.
13. **`opencode run --agent <name>` silently falls back to `build` if the agent is
    `mode: subagent`.** It prints a warning and **exits 0** — so you would get a review
    from the wrong agent and never know. Role agents must be `mode: all`. (Measured; this
    only affects the CLI path, but the silent-success failure mode is the dangerous part.)
14. **`format` lives on the legacy `POST /session/{id}/message`**, *not* on
    `POST /api/session/{id}/prompt` — the `/api/` v2 prompt body is
    `{delivery, id, prompt, resume}` and has no `format`. Easy to get backwards.
15. **`models.json`'s `structured_output` flag is unreliable in both directions.**
    `deepseek-v4-pro` declares `true` and fails 100%; `mimo`/`minimax` declare `null` and
    work. Never trust the catalogue — smoke-test.
16. **Catalogue presence ≠ availability.** Five `opencode/*-free` models are listed in
    `models.json` but return `ProviderModelNotFoundError` at runtime. The error surfaces
    as an opaque HTTP 500 `UnknownError` with a `ref`; the real cause is only in
    `~/.local/share/opencode/log/opencode.log`. Grep the ref.
17. **The local server requires basic auth** — `OPENCODE_SERVER_USERNAME` /
    `OPENCODE_SERVER_PASSWORD` from the environment. Unauthenticated requests get a bare
    `401` with no body.
18. **`Promise.all` joins on the slowest node.** A round costs its slowest member, so
    per-node `AbortSignal.timeout` is what bounds a round, not the average. Use
    `allSettled` so one timeout doesn't discard the other ten results.

---

## 5. Roster

**Measured 2026-08-16.** Every model below is confirmed to produce schema-valid structured
output. `ms` is the observed latency on a trivial structured task — use it to set timeouts,
not as a quality signal.

```
slug        model                                  roles                 ms
opus5       anthropic/claude-opus-5                reviewer,security      4263
fable       anthropic/claude-fable-5               security,skeptic       6704
gpt55       openai/gpt-5.5                         product,reviewer       4369
glm52       zai-coding-plan/glm-5.2                systems,reviewer       8403
kimik3      kimi-for-coding/k3                     code                  21151
gemini36    google/gemini-3.6-flash                breadth,docs           9028
grok45      opencode-go/grok-4.5                   systems,skeptic        7146
mimo        opencode-go/mimo-v2.5-pro              pragmatist,skeptic     7027
minimax     opencode-go/minimax-m3                 reviewer,skeptic       4532
nemoultra   opencode/nemotron-3-ultra-free         reviewer,systems       7307   FREE
nemolight   opencode/nemotron-3.5-lightning-free   skeptic,qa             4672   FREE
```

11 models, all roles covered. `fixer` takes no roster slot — by design the *finder* fixes,
so the fixer agent runs on whichever model raised the finding.

**Model diversity earns its keep in the skeptic pool.** Three votes from one model are
correlated and near-worthless; three from different models are real evidence. Fable, Grok,
MiMo, MiniMax and nemolight exist here primarily as cheap independent verifiers — and two
of them are free.

`kimik3` at 21s is 2.3× slower than anything else. Set the per-node timeout off it, or
drop it to a role that isn't on the critical path.

### Excluded, with cause — all deterministic, each reproduced 2×

| model | cause | remedy |
|---|---|---|
| `deepseek/deepseek-v4-pro`, `deepseek-v4-flash` | `400 Thinking mode does not support this tool_choice` | none found. `variant: none` does **not** suppress it despite `reasoning_options: [{type:"toggle"}]` in the catalogue. Provider-level incompatibility with forced tool calls. |
| `opencode-go/deepseek-v4-pro` | `403` — China-hosted, needs explicit opt-in | **user action**: opt in at `opencode.ai/workspace/.../go`, then re-probe |
| `opencode-go/qwen3.8-max`, `qwen3.7-max` | timeout — 240s, 150s, 120s, all exceeded | none found. Provider-side; other `opencode-go` models return in 4–7s. |
| `opencode/{nemotron-3-super,glm-5,kimi-k2.5,minimax-m3,qwen3.6-plus}-free` | `Model not found` | none — catalogued but not served |

**No text-JSON fallback will be built.** Adding a second parse path to accommodate two
models, when eleven work natively, is complexity for marginal diversity. One code path.
If deepseek is wanted back, the opt-in above is the cheaper fix.

### Role → agent file

| role | migrated from | note |
|---|---|---|
| security | `council-fable.md` | OWASP/CWE, attack scenarios |
| systems | `council-qwen.md` | contracts, compat, cross-cutting |
| code | `council-kimi.md` | before/after precision |
| pragmatist | `council-deepseek.md` | real vs theoretical, ROI |
| product | `council-codex.md` | user impact, states, PII |
| breadth | `council-gemini.md` | cross-file relationships |
| reviewer | `council-claude-opus.md` | generic deep review |
| ~~moderator~~ | `council-glm.md` | **deleted** — D3 |
| qa | new | |
| docs | new | |
| skeptic | new | verdict schema: `{real, confidence, reason}` |
| fixer | new | emits a unified diff, never edits |

Migration is not a rename: each body currently says *"you are GLM 5.2 in a council of 8
named models"*, and `council-glm.md` describes a roster that no longer exists. Strip the
model-identity paragraphs, keep the expertise sections.

---

## 6. Phases

### Phase 0 — spike — **DONE, GO** (2026-08-16)

- [x] `git init` `/root/.config/opencode`, commit baseline (D9) — 19 files, commit `0c02c55`
- [x] **Q1** `config.agent[id]` registers an agent — CONFIRMED, incl. role×model
- [x] **Q2** `format` → `info.structured` — CONFIRMED
- [x] **Q3** structured-output support — 11/13, causes identified
- [x] **Q4** free-tier ceiling — 6/6 concurrent, no 429
- [x] Results recorded in §5 and §7

Spike artefacts in `/tmp/opencode/spike-{q1,fmt}/` (throwaway, not part of the package).

> **Status 2026-08-16:** Phases 1, 2 and 3 are done and verified. Phase 4a (fan-out →
> verify → decide → report) is done and proven end-to-end against a planted-bug fixture.
> Remaining: 4b debate loop, 4c fix loop, 4d command wiring, then cleanup.
>
> Verified end-to-end: 6/6 nodes, 19 raw findings → 6 after dedupe and skeptic
> verification, 74s. Both planted bugs found, plus two the fixture author did not intend.

### Phase 1 — `/check` — **DONE**

Verified against a fixture with planted bugs: found all three plus an undefined
reference left in by accident, capped at 5, correct tiers, asked nothing.

### Phase 2 — plugin skeleton — **DONE**

`config.agent` / `config.command` registration verified in a fresh process (12 role agents
show as `mode: all`; `check` present in `GET /command`). `council()` tool registered with a
zod arg schema. Recursion guarded twice: `experimental.primary_tools` for task-tool
children, and an explicit deny list on every session the engine creates itself.

### Phase 3 — deterministic core + roster — **DONE**

`decide.ts` (29 tests), `roster.ts` (11 measured members, routing, selection), 12 role
agents migrated. Two bugs the tests caught that review would not have:
`MODELS_PER_ROLE.security = 3` while only two members carried the role, and a model
disputing itself.

### Phase 4a — fan-out, verify, aggregate, report — **DONE**

End-to-end on the fixture: 6/6 nodes ok, 19 raw findings → 6 after dedupe and skeptic
verification, 73.8s. Report names every node that failed and marks the verdict provisional
when coverage is incomplete.

### Phase 4b/4c — debate loop, fix loop — **NOT STARTED**

The disputes list that drives the debate round is computed and rendering correctly; the
loop that consumes it is not built. Same for the patch → gate → `git apply` → scoped
re-verify cycle. `council-fixer` and `PATCH_SCHEMA` exist and are unused.

### (original Phase 1 spec, for reference)
- [ ] `command/check.md` — 6 lenses inline, no subagents, max 5 issues,
      BLOCKER/SUGGESTION only, never asks a question, never moves HEAD
- [ ] Consistency contract in-file: every difference from `/council-review` must derive
      from exactly two facts — check dispatches no subagents, and check is fired
      repeatedly while writing code

### Phase 2 — plugin skeleton
- [ ] `package.json` pinning `@opencode-ai/{plugin,sdk}@1.18.13`
- [ ] `src/index.ts` — `config` hook registering agents + commands + skills; `tool` hook
- [ ] v2 client construction from `serverUrl` (gotcha 1)
- [ ] `council()` returns a compact verdict; report written to `council-artifacts/<slug>/`
- [ ] Recursion guard: `experimental.primary_tools: ["council"]` **and** replicated deny
      in self-created child sessions (gotcha 2)
- [ ] Install via `"plugin": ["/root/code/opencode-council"]`, verify it loads

### Phase 3 — pure functions first, then prompts
- [ ] `src/decide.ts` — `decide` · `dedupe` · `disputes` · `converged`. No I/O.
- [ ] `src/decide.test.ts` — asserts over fixture votes, `node --test`, no framework.
      **This is the one test**: `decide()` is the deterministic core everything rests on.
- [ ] 12 role prompts in `agent/`, migrated per §5

### Phase 4 — the graph
- [ ] route (globs → roles → nodes; ≤2 models/role, 3 for security)
- [ ] fan-out over child sessions, per-model `AbortSignal.timeout`, error tagging
- [ ] verify → decide → disputes → debate → computed convergence (LOOP 1)
- [ ] report template
- [ ] human gate → patch artefact → `git apply` → scoped re-verify → test command (LOOP 2)
- [ ] `/council-plan` proposal-scoring vote

### Phase 5 — deleted
It *was* the plugin. Folded into Phase 2.

### Cleanup (after Phase 4 proves out)
- [ ] Delete the `agent` block from `~/.config/opencode/opencode.json`
- [ ] Delete `command/council-{review,plan,task,independent}.md`
- [ ] Delete `agent/council-*.md` (migrated into this repo)
- [ ] Existing `council-artifacts/` in target repos keeps working

---

## 7. Spike results

Measured 2026-08-16 against opencode 1.18.13. **Verdict: GO.**

| Q | Result |
|---|---|
| **Q1** `config.agent[id]` | **CONFIRMED.** `spike-probe (subagent)` appeared in `opencode agent list` only with the plugin loaded. `config.command[name]` likewise. Prompt is honored end-to-end (agent replied `REGISTERED`). |
| **Q1b** role × model | **CONFIRMED.** `opencode run --agent spike-probe -m google/gemini-3.6-flash` → header `> spike-probe · gemini-3.6-flash`. Role from the agent, model from the flag. |
| **Q2** `format` round-trip | **CONFIRMED.** `format:{type:"json_schema"}` → `info.structured`, 4.5s. **On `POST /session/{id}/message`, not `/api/session/{id}/prompt`.** |
| **Q3** structured output | **11 of 13.** Two deterministic failures with identified causes — see §5. |
| **Q4** free-tier ceiling | **6/6 concurrent, no 429.** 5.2–9.5s under burst vs 4.7s solo. `serial` flag **dropped**. |

### Consequences

- `serial` column: **deleted** — not needed at realistic concurrency.
- `structured` column: **deleted** — a model either works or is not in the roster (§5).
- Role agents must be **`mode: all`**, not `subagent` (gotcha 13).
- `deepseek` and `qwen` are out; their roles reassigned to `glm52`/`grok45` (systems) and
  `mimo` (pragmatist).

---

## 8. Conventions

- **Verification before completion.** No phase is marked done without a runnable check
  that fails if the logic breaks.
- **Anti-silent-fail.** Distinguish "ran and passed" from "did not run". Every node
  records a typed state; a dropped node is always reported, never swallowed. This is the
  bug being fixed from the old `prune`.
- **ponytail.** Shortest diff that works. No abstraction with one implementation, no
  config for a value that never changes. Deliberate simplifications get a `ponytail:`
  comment naming the ceiling and the upgrade path.
- Node 24 strips TypeScript natively and has a built-in test runner — **no build step, no
  test framework, no bundler.**
