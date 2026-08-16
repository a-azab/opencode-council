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

1. **The plugin's injected `client` is v1 and silently drops `format`.** No error — the
   field is discarded and you get unstructured text. Build a v2 client from the injected
   `serverUrl`:
   ```ts
   import { createOpencodeClient } from "@opencode-ai/sdk/v2"
   const v2 = createOpencodeClient({ baseUrl: input.serverUrl.toString() })
   ```
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

---

## 5. Roster

`structured` and `serial` are set by the Phase 0 spike — values below are the hypothesis,
not measured.

```
slug        model                                  roles                structured  serial
opus5       anthropic/claude-opus-5                reviewer,security         ?
fable       anthropic/claude-fable-5               security,skeptic          ?
gpt55       openai/gpt-5.5                         product,reviewer          ?
glm52       zai-coding-plan/glm-5.2                reviewer,systems          ?
deepseek    deepseek/deepseek-v4-pro               pragmatist,systems        ?
kimik3      kimi-for-coding/k3                     code                      ?
gemini36    google/gemini-3.6-flash                breadth,docs              ?
qwen38      opencode-go/qwen3.8-max                systems,reviewer          ?
grok45      opencode-go/grok-4.5                   reviewer,skeptic          ?
mimo        opencode-go/mimo-v2.5-pro              reviewer,skeptic          ?
minimax     opencode-go/minimax-m3                 reviewer,skeptic          ?
nemosuper   opencode/nemotron-3-super-free         reviewer,systems          ?        yes
nemolight   opencode/nemotron-3.5-lightning-free   skeptic                   ?        yes
```

**Model diversity earns its keep in the skeptic pool.** Three votes from one model are
correlated and near-worthless; three from different models are real evidence. Grok, MiMo,
MiniMax and nemolight exist in this roster primarily to be cheap independent verifiers.

Also available on credentials already held, if more diversity is wanted later:
`opencode-go/{glm-5.3, gpt-5.6-luna, kimi-k3, hy3, qwen3.7-max}`.

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

### Phase 0 — spike (GO/NO-GO) ⬅ current

- [ ] `git init` `/root/.config/opencode`, commit baseline (D9)
- [ ] **Q1** Does `config.agent[id] = {...}` register an agent?
      *Fallback if no: pass the role prompt as `system:` at prompt time — works
      regardless and is simpler.*
- [ ] **Q2** Does a v2 client built from `serverUrl` round-trip
      `format` → `info.structured` from inside a plugin tool?
- [ ] **Q3** Which of the 13 models produce structured output? → sets `structured` flag
- [ ] **Q4** Free-tier 429 ceiling for `opencode/*` → sets `serial` flag
- [ ] Record results in §5 and §7, GO/NO-GO

### Phase 1 — `/check` (ships alone, zero dependencies)
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

*Filled in by Phase 0. Empty until measured — do not populate with assumptions.*

| Q | Result | Date |
|---|---|---|
| Q1 `config.agent[id]` | | |
| Q2 v2 `format` round-trip | | |
| Q3 structured-output support | | |
| Q4 free-tier ceiling | | |

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
