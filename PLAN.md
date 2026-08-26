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
| qa | new | assertion quality — would the test fail? |
| docs | new | statements that have become untrue |
| ops | new | containers, CI/CD, deploy safety, rollback |
| skeptic | new | verdict schema: `{real, confidence, reason}`. Also verifies fixes. |
| fixer | new | returns the corrected **file content**; git computes the diff. Never edits. |

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

> **Status 2026-08-16: Phases 0–4 complete and verified. 34 tests passing.**
>
> Measured end-to-end against a planted-bug fixture:
>
> | run | result |
> |---|---|
> | review, no debate | 6/6 nodes, 19 raw findings → 6 kept, 74s |
> | review, with debate loop | 6/6 nodes, 19 raw → 4 kept, 212s |
> | fix loop | patch produced, `confident:false`, escalated — as designed |
> | `/check` | 5 findings, all 3 planted bugs + 1 unintended |
>
> **Debate costs ~3× wall time.** That is the honest price of deliberation, and why the
> loop fires only when reviewers actually disagree.
>
> **Cleanup of the old commands is DONE** (2026-08-16). See §6.

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

### Phase 4b — debate loop — **DONE**

`debateRound` + `applyRevisions`, bounded twice: by `maxRounds` and by the computed fixed
point. Measured on the fixture: 1 round, 6 re-judgements, 0 changed position, stopped on
"no tier changed since last round". Debate costs ~3× wall time, which is why it fires only
when reviewers actually disagree.

### Phase 4c — fix loop — **PARTIAL**

Done: patch generation, `git apply --check` validation, `confident:false` escalation.
Measured — a clean single-line patch, `git apply --check` PASS.

The fixer returns **full file content** and `git diff --no-index` computes the patch.
Asking models for unified diffs failed 2 of 5 times on hunk arithmetic; the model supplies
content, git supplies the diff.

**Not done — the loop does not close.** After a human applies a patch, nothing re-verifies
that the finding is actually resolved, that a model other than the fixer agrees, or that
the project's tests still pass. Today it is: review → patches → human. The promised
`apply → scoped re-verify → converge or escalate (max 2 attempts)` half does not exist.

### Phase 5 — deleted
It *was* the plugin. Folded into Phase 2.

---

## Remaining work

**All features are built. Only cleanup remains, and it is blocked on use rather than code.**

### What ships

| surface | entry point |
|---|---|
| `/check` | inline 6-lens pass, no subagents |
| `/council-review` | `council({ mode: "review", base })` — the full graph |
| `/council-fix` | `council({ mode: "fix" })` — verified patches, applies nothing |
| `/council-plan` | `council({ mode: "plan", goal })` — cross-scored vote |
| `/council-independent` | `council({ mode: "independent", goal })` — every model alone, unmerged |
| `/council-work` | `council({ mode: "work", goal, verify })` — implement until the project's own check passes |
| 12 role agents | `council-{security,systems,code,pragmatist,product,breadth,reviewer,docs,qa,ops,skeptic,fixer}` |

### The work loop (`mode: "work"`) — measured 2026-08-21

The only mode that writes code. Decompose → implement → **run the project's test command** →
independent verify → retry with the failure as feedback → escalate after 2.

Three properties it exists to guarantee:

1. **The done-predicate is objective.** The test command decides, not a model. A loop whose
   stopping condition is an opinion either stops early and claims success or never stops.
2. **It asks rather than guesses.** If the verify command can't be determined unambiguously,
   the tool returns a question. A command that passes trivially would report finished work
   that never happened — the worst failure available to this mode.
3. **It writes only inside a throwaway worktree** on its own branch. A bad run costs a
   deleted directory, not a recovery.

Green tests prove nothing broke; they don't prove the item was *done*. So a model that did
not implement it judges that separately, and both must pass.

**Verified end-to-end on this repo:** goal decomposed, implemented on attempt 1,
`npm test` green at 47 tests, confirmed by `minimax` (not the implementer), main tree
untouched. The implementation reused the existing `TIER_RANK` constant rather than
duplicating the mapping.

**Bug this surfaced:** `runWork` originally hardcoded `opus5` as planner *and* implementer,
so one unreachable provider killed the whole run at decomposition — the same
single-point-of-failure removed from the review path. Now `askAny()` falls through an
ordered worker list. The cost is that fallback is sequential, so an unreachable first
candidate burns its full timeout; order `WORKERS` by reliability.

### Phase 4c — fix loop — **DONE** (was PARTIAL)

The loop closes. A patch is re-checked against the patched content by a model that did not
write it; on rejection the verifier's reason becomes the next attempt's instruction, and
after two attempts it escalates. Measured: `VERIFIED: true`, verifier `minimax` on a fix by
`gpt55`, with a code-grounded reason.

Three outcomes are kept distinct and tested — `verified`, `produced but not verified` (the
check could not run), and `still unresolved after retries`. Collapsing them is how the
project's central claim would become silently false.

Not built, deliberately: running the project's test suite against the patch. That needs a
scratch worktree with dependencies installed and a test command we would have to guess at.
The human is applying the patch anyway.

### Phase 4d — `/council-plan` — **DONE**

Five lanes propose, every model scores every proposal except its own, `tally()` picks the
winner by mean, and ties escalate to the human rather than to a tiebreaker model. Measured:
3/4 proposals (one timed out and was reported dropped), 5 cross-scores, **0 self-scores
requested**, winner at 18.00/20.

---

### Historical — the items below were the open list, now closed.

### 1. Close the fix loop (LOOP 2) — the largest gap

Today: `review → patches → human`. The design promised `apply → re-verify → converge or
escalate`. Missing pieces:

- [ ] Re-verify a finding against the **new** code after the patch is applied, scoped to
      the changed hunks rather than re-reviewing the whole diff
- [ ] The verifier must not be the model that wrote the fix (the same
      no-self-verification rule the skeptic pool already enforces)
- [ ] Run the project's test command; a patch that breaks tests is not a fix
- [ ] Bound at 2 attempts per finding, then escalate to the human

This is what makes the project's central claim true — that it verifies fixes, which
neither source system does. Until it lands, that claim is half-earned.

### 2. `/council-plan` — the planning vote

- [ ] Every model proposes; every model scores every proposal **except its own**
- [ ] Arithmetic tally; ties escalate to the human, never to a tiebreaker model
- [ ] `command/council-plan.md`

Nothing exists for this — no command, no scoring, no tally. It is the D3 principle applied
where there is no diff to compute against.

### 3. Cleanup — commands DONE; the inert model-named agents remain. See §6.

### Migration off the old commands — **DONE** (2026-08-16)

| old command | outcome |
|---|---|
| `council-review.md` | deleted — plugin registers the same name and wins the collision, so it was already dead |
| `council-plan.md` | deleted — same |
| `council-task.md` | **deleted on the user's call** — `council-fix` covers the need |
| `council-independent.md` | **ported to `mode:"independent"`**, verified 11/11 before deleting |
| `workflow.md` | untouched — not part of this project |

`/root/.config/opencode/command/` now contains only `workflow.md`. Everything else is
recoverable from commit `0c02c55`.

All four deleted files carried the same defects: rosters naming `deepseek` and
`qwen3.8-max` (both fail every call), the `prune` substring match that silently drops any
response quoting `"timeout"` or `"error:"`, and writing `.run-model.sh` into whatever repo
they ran in.

**Lesson from the port.** `mode:"independent"` first forced a one-field JSON schema purely
to reuse the existing `ask()` path — and 3 of 11 models returned `StructuredOutputError`
on a field they filled fine as prose. Structured output is a *forced tool call*; demanding
one to carry free text costs models that cannot do it, for no benefit. Making the schema
optional took coverage 7/11 → 11/11. **The fix was deleting the ceremony, not working
around it.**

### Cleanup — **DONE** (2026-08-16)

- [x] Delete `command/council-{review,plan,task,independent}.md` — see the migration table above
- [ ] Delete the `agent` block from `~/.config/opencode/opencode.json`
- [ ] Delete `agent/council-*.md` (the model-named originals, migrated into this repo)

The two remaining items are lower risk than the commands were: the old model-named agents
(`council-fable`, `council-glm`, …) are `mode: subagent` and no longer referenced by
anything, so they are inert rather than shadowing. They can go whenever.

Everything is recoverable — `/root/.config/opencode` is a git repo as of commit `0c02c55`.

## 6b. Industry-standard gap analysis (researched 2026-08-21)

Primary sources fetched and quoted; full research brief in the commit that added this
section. Verdicts are the literature's, not mine.

### What the evidence VALIDATES in the current design

| design choice | evidence |
|---|---|
| Test execution as the work loop's arbiter | **STRONG.** Huang et al. §6: "the code executor serves as the perfect verifier." Kamoi TACL: self-correction "works well in tasks that can use reliable external feedback." Chen Self-Debugging: +12% with unit tests vs +2–3% without. |
| A *different* model verifies a fix | **STRONG.** Panickssery et al.: linear correlation between self-recognition and self-preference bias. A model grading its own work is measurably biased. |
| Hard iteration caps everywhere | **STRONG.** MAST (1642 traces): ~19% of all multi-agent failures are stopping-condition failures — 12.4% "unaware of stopping conditions" + 6.2% "premature termination." |
| Multi-level verification (tests **and** an independent model) | **STRONG.** MAST Insight 3: adding objective verification gave **+15.6%** on the same model. Their warning is exactly our design target: "many existing verifiers perform only superficial checks... such as checking if the code compiles." |
| Single worker for code construction, not a swarm | **STRONG.** Anthropic's own caveat: "most coding tasks involve fewer truly parallelizable tasks than research." Cognition: "running multiple agents in collaboration only results in fragile systems." MAST: 41–86.7% failure rates across 7 frameworks. |
| Parallel multi-model for *read-only review* | **SUPPORTED.** This is the case that works — breadth-first retrieval with compression back to one result. |
| No graph framework | **SUPPORTED by four independent parties**, two of whom ship graph frameworks. Pydantic: "Don't use a nail gun unless you need a nail gun." Anthropic: frameworks "obscure the underlying prompts and responses." Microsoft: "If you can write a function to handle the task, do that instead." |

### What the evidence CONTRADICTS — the debate loop

Huang et al. (ICLR 2024) re-ran multi-agent debate with the original authors' prompts on the
**full** GSM8K set instead of a 100-example subset:

| method | responses | GSM8K |
|---|---|---|
| Self-consistency | 3 | 82.5 |
| **Debate round 1** | **6** | **83.2** |
| Self-consistency | 6 | **85.3** |
| **Debate round 2** | **9** | **83.0** |
| Self-consistency | 9 | **88.2** |

> "The observed improvement is evidently **not attributed to 'self-correction', but rather
> to 'self-consistency'.**"

At matched budget debate loses, and **round 2 is worse than round 1** — precisely the range
`DEFAULT_MAX_ROUNDS = 2` operates in.

**Our own measurement already agreed and I did not notice.** PLAN §6 records the debate run
as *"1 round, 6 re-judgements, **0 changed position**"* while wall time went 74s → 212s. The
loop tripled cost and changed nothing. That is the literature's result reproduced locally.

### What is MISSING that every surveyed system has

| gap | consequence today | precedent |
|---|---|---|
| **No retries.** `ratelimited` is classified, `isRetryable` and `Retry-After` arrive in the payload, and all three are ignored | one transient 429 permanently kills a node and silently narrows coverage | LangGraph `RetryPolicy`, Temporal, Restate — universal |
| **No persistence** | a crash loses a 3-minute, ~20-call run entirely | Anthropic session log, Temporal Event History, LangGraph checkpointer — universal |
| **No resume** | same | 12-factor Factor 6; universal |
| **No budget cap** | unbounded spend; a large diff × 5 modes × retries has no ceiling | Anthropic scales budget by task complexity explicitly |
| **Uniform budgets** | wastes money on trivial diffs, under-serves hard ones | Snell et al.: effectiveness "critically varies depending on the difficulty of the prompt" |

---

## 6c. Upgrade plan — ordered by (evidence × cheapness)

### P0-A — Retry with backoff  *(small, strong precedent, fixes an observed failure)*

- [ ] `RetryPolicy` as data on a call: `max_attempts`, `initial_interval`, `backoff_factor`,
      `max_interval`, `jitter`
- [ ] Retry `ratelimited` (honour `Retry-After`) and 5xx; **never** retry `autherror`,
      `malformed`, or a structured-output refusal — those are deterministic
- [ ] Copy LangGraph's `default_retry_on` exclusion list rather than deriving one

Measured motivation: across real runs we lost nodes to `ratelimited` and one-off
`No provider available` that a single retry would have recovered.

### P0-B — Ablate the debate loop before keeping it  *(free)*

- [ ] Run the same diff with `maxRounds: 0` and `maxRounds: 2`; compare findings and cost
- [ ] Apply Huang §5's test to the debate prompt: fold its content into the R1 prompt and
      see whether that closes the gap. This test alone invalidated Self-Refine's headline.
- [ ] **Default to deleting it.** Evidence + our own 0-changed-positions measurement both
      point the same way; keeping it needs a positive result, not an absent negative one.
- [ ] If a consistency mechanism is wanted, spend that budget on **self-consistency**
      (same node sampled N times, majority vote) — STRONG evidence, and the only pattern in
      the brief independently replicated by a hostile party.

### P1-A — Append-only event log + resume

- [ ] One `runId`, one append-only log of every call and result; artifacts derive from it
- [ ] `resume(runId)` re-enters after the last completed step
- [ ] **ID-keyed resume, never positional.** LangGraph's index matching needs four rules and
      an exponential-blowup warning to be safe; Anthropic's id-keyed map does not.
- [ ] Store everything, transform on read — Anthropic: "It is difficult to know which tokens
      the future turns will need."

### P1-B — Budget ceiling
- [ ] `maxCalls` / `maxSpend` per run, enforced in `ask()`, surfaced in the report
- [ ] Refuse to start rather than stop halfway when the estimate exceeds the ceiling

### P2 — Difficulty-scaled budgets
- [ ] Scale node count and attempts by diff size and category, not uniformly (Snell)

### Explicitly NOT building, with reasons

| rejected | why |
|---|---|
| Graph-as-data / declarative topology | Nothing outside our runtime reads the topology. That is the deciding question, and until a visual builder or external validator exists the graph is dead weight that rots as models improve. You can add a graph over an event log later; you cannot remove one users depend on. |
| BSP / superstep semantics | One system in the entire survey uses them. Buys deterministic parallel fan-in, costs a scheduler and a vocabulary. |
| Deterministic code replay | Temporal's whole product. A partial implementation is worse than none because it *looks* like a guarantee. |
| Delta-channel state optimization | Beta after two major versions, with a documented silent-corruption mode. |
| Replacing the 3-skeptic vote with a single judge | Anthropic reverted from judge *ensembles* for **rubric scoring**. Ours is a **binary** real/not-real vote — that is self-consistency, which is the strongly-evidenced pattern. Different mechanism; not a defect. |

---

## 7. Spike results

Measured 2026-08-16 against opencode 1.18.13. **Verdict: GO.**

### Fix-loop findings (measured 2026-08-16, Phase 4c)

| finding | consequence |
|---|---|
| Asking a model for a **unified diff** produced `corrupt patch at line 12` and `no valid patches in input` on 2 of 5 attempts | The fixer now returns the **full new file** and `git diff --no-index` computes the patch. Hunk arithmetic is mechanical; there is no reason to make a model do it. Verified: clean single-line patch, `git apply --check` PASS. |
| A patch that git rejected was returned with `state: "ok"` | `runFix` now validates with `git apply --check` before returning. A patch git will not take is not a patch, however confident the model was — reporting it as success just moves the failure onto the human. |
| `confident: false` correctly escalated the SQL-injection fix | Working as designed. The placeholder syntax depends on a driver the fixer cannot see, so declining is the right answer. |
| A full run took ~10 minutes | Rounds are sequential and each is bounded by its slowest member, so worst case ≈ 4 × per-node timeout. Default dropped 180s → 90s (~4× the slowest measured model). |

### First real multi-file run (2026-08-16)

Reviewed this repo's own `HEAD~6` diff — 10 files, 845 changed lines, 51,693 chars of
`.ts` and `.md`. Roughly 100× the fixture everything else was measured on.

| claim | measured | verdict |
|---|---|---|
| routing cuts cost | 5 roles → **6 nodes**, not 11. `pragmatist` fired (845 > 200), `docs` from `.md`, `qa` from `*.test.ts`, `security` correctly did **not** | holds |
| "~1–3 minutes" | **180s** — with 2 of 6 nodes failing | at the boundary, and optimistic |
| per-node latency | 57–62s for finishers vs 4–21s on the fixture | **~10× — the fixture numbers do not generalise** |
| 90s timeout | **2 of 6 nodes timed out** (`opus5`, `kimik3`) | **wrong, fixed** |

**The timeout was a real defect I introduced.** It was set to 90s as "~4× the slowest
measured model", but that measurement came from a *trivial* prompt. Large-context latency
does not correlate with trivial-prompt latency, so the number was derived from data that
could not support it. Replaced with `timeoutFor(chars)` — 60s base plus 3s per 1k chars,
capped at 300s. The real diff now gets 216s instead of 90s.

**The council found a genuine regression in its own source**, raised independently by two
models: `mode: "fix"` had started running a *fresh* review and patching those findings
instead of loading the previous review's `findings.json`. Because reviews are
nondeterministic, the report a user approved and the patches they received would not
correspond — and it silently paid for a second full review. Fixed.

**What did not get exercised, even here:** 4 raw findings produced 0 dedupe merges, 0
disputes and 0 debate rounds. The dedupe line-window and the debate loop still have no
real-world evidence behind them. A larger or more contentious diff is needed to test those.

**Findings clustered in the first files of the diff** (`src/index.ts`, `README.md`) with
nothing on `engine.ts` or `decide.ts`, which had the largest changes. Consistent with
attention thinning over a 51k-char payload — worth investigating whether per-file review
beats one large diff.

### Spike results

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

---

## 9. Crew — directive to PR

> **Renamed 2026-08-25.** Everything this section calls `crew` is now `lets`: the tool, the
> commands (`/lets:{init,plan,execute,status}`), the module (`src/lets.ts`), the agents
> (`agent/lets-*.md`) and the config fence (` ```lets `, though ` ```crew ` still parses).
> The name `crew` was freed for the orchestrator that runs several `lets` — sub-project 3.
>
> The entries below are left in their original wording on purpose. This is a dated record of
> decisions as they were made, and rewriting it to match a later rename would make the
> journal lie about itself. Read `crew` as `lets` throughout.

### 9.1 Why this exists

`review` judges a diff. `plan` votes on an approach. `work` implements a goal until the
project's own check passes. None of them takes a human directive through **intake →
approved plan → implementation → verification → reviewed PR**, which is the only shape
that produces work you would actually merge.

Crew is that path. It is a strict superset of `work`, so `work` dies when Phase 3 lands.

The literature in §6b applies unchanged and constrains the design: multi-model fan-out for
**read-only** analysis is SUPPORTED; a swarm of role agents **constructing** code is
CONTRADICTED (MAST: 41–86.7% failure across 7 frameworks; Cognition: "running multiple
agents in collaboration only results in fragile systems"). Crew therefore parallelises
nothing during construction. One worker, one item, in order.

### 9.2 Locked decisions

| # | Decision | Reason |
|---|---|---|
| **C1** | Scope is the git root of the session's cwd. No repo allowlist, no issue→repo mapping. | Blast radius is "where you are standing". Deletes a whole feature. |
| **C2** | Items run **sequentially**, one branch, one commit each, one PR. | The disjoint-file scheduler solved a problem we do not have and reintroduced the exact concurrency risk §6b warns about. |
| **C3** | Approval gate after intake, **on by default**. | You see the task list before a worktree is touched. |
| **C4** | PR only. Never merges, never pushes to a base branch. | Matches `work`'s existing promise not to touch your tree. |
| **C5** | Item failure **escalates**, it does not abort. Reviewer + skeptic lanes diagnose, fix, then the list resumes. | User directive. Replaces the earlier stop-on-first-failure rule. |
| **C6** | Review and acceptance gaps go **back to execute**. PR is the loop's exit, not a step. | User directive. |
| **C7** | Termination floors: 3 escalation rounds/item, 3 review→fix cycles, 60 min wall clock. First to trip stops the run **with a report**. | C5 + C6 make the pipeline a loop with no natural end. §6b: ~19% of multi-agent failures are stopping-condition failures. Non-negotiable. |
| **C8** | Acceptance criteria are **verified by the `qa` lane against the item's diff**, read-only. | `WorkItem.acceptance` was decorative — the verify command proves *nothing broke*, not *the thing got built*. §6b: "many existing verifiers perform only superficial checks." |
| **C9** | Dirty working tree → **refuse, offer to stash**. | Branching from HEAD with uncommitted work plans against a state that is not on the user's screen, and the PR then collides with it. |
| **C10** | Retry `maxAttempts: 3 → 11`, transient only. `Retry-After` > 30 min → **bench the model for the run** and pick a replacement. | User directive. `isRetryable` already excludes `autherror`/`malformed`. |
| **C11** | `AGENTS.md` (+ `CLAUDE.md`) is read at run start and **prepended to every crew node's prompt**. | User directive: the crew always respects it. Deterministic — does not rely on opencode session injection. |
| **C12** | The implementer carries **ponytail** discipline inline in `agent/crew-dev.md`. | User directive. Includes the never-simplify-away list: validation at trust boundaries, error handling preventing data loss, security, accessibility, understanding the problem. |
| **C13** | **graphify** supplies codebase understanding at intake; the crew reads, updates and uses it for impact analysis. | Replaces a per-run explore lane with a persistent graph. Measured on thiqwave-platform 2026-08-21: 903 code files → 6130 nodes / 10170 edges / 460 communities in **13.6s, zero LLM calls** (`--code-only`, tree-sitter AST). Cheap enough to rebuild every run. |
| **C14** | Config lives in a fenced `crew` block in the repo's `AGENTS.md`. | One file, already loaded in every session, human-editable, no second source of truth. Parsed by the flat `key: value` parser already in `index.ts`. |
| **C15** | The worker gets `bash`, **confined to the worktree by `external_directory: deny`** — a runtime rule, not a prompt sentence. Read-only lanes keep `edit: deny, bash: deny` and also get the confinement. | Without `bash` the implementer writes blind and its only signal is pass/fail; C5's escalation is worthless if nothing can run a failing test and read the trace. The confinement half was **claimed but not implemented until 2026-08-22** — see §9.7. |
| **C16** | No spend cap. | User declined one. C7's floors still guarantee termination. Run summary reports call count and `AGENTS.md` token overhead so the cost is visible. |
| **C18** | A lane never drops while a usable model remains: on failure it substitutes, preferring an unassigned model that carries the role, then any unassigned one, then reusing a model already working another lane. | User directive. Measured 2026-08-21: a full-panel review reported **24 of 56 lanes**, with `code` having no working model at all (kimi quota exhausted) and four models returning `malformed` on every slice. Restricting substitutes to *unassigned* models offered zero stand-ins on a full panel — precisely when coverage was being lost. Reuse costs correlation, so `substituted` is recorded and the report names it. |
| **C19** | Model-level failures bench for the whole run; call-level ones do not. | `malformed` means the model cannot emit a forced tool call and will fail identically on all 14 lanes; a quota error will not refill mid-run. A timeout might just be a large slice, so it is not benchable. Without a bench, failover retries a quota-dead model once per node. |
| **C20** | The tracker seam is MCP-generic: `tracker: mcp` mirrors through any local `mcpServers` entry from opencode.json (Jira, GitHub Issues, …), mapping run moments to that server's tool names, with a template adapting argument names. Linear stays as one native implementation, not a privileged path. | User directive, 2026-08-23: "don't stick to Linear — it might be any MCP like Jira; it was an example." The seam existed but the only real tracker was Linear, and the init text advertised Linear alone. Stdio servers only: remote MCP needs a different transport and OAuth, written when someone needs it. |
| **C17** | No resume. | Model-level failure is already covered by `askAny` roster fallthrough + C10. Process-level death leaves the commits on the branch; re-run. |

### 9.3 Pipeline

```
/crew "directive"
  0  resolve scope     git root, verify command(s), base branch, dirty check (C9)
  1  read instructions AGENTS.md + CLAUDE.md, prepended everywhere after (C11)
  2  intake            crew-cpo + crew-cto, read-only, fed by graphify (C13)
                       -> WorkItem[] { title, detail, files, acceptance }
  3  GATE              you approve or redirect (C3)
  4  execute           per item, sequential (C2): worktree -> implement (C12,C15)
                       -> verify -> commit.  failure escalates (C5)
  5  review            council review on the branch diff
  6  acceptance        qa lane: item diff vs its acceptance criteria (C8)
  7  gaps?             -> back to 4 (C6), bounded by C7
  8  ship              push, gh pr create, report
```

### 9.4 Phases

#### Phase 1a — `/crew init` — **DONE** (2026-08-21)
- [ ] Scope resolution: git root, refuse non-repo, dirty check + stash offer (C9)
- [ ] Detect stack (manifests + directory shape), verify command list **with path scopes**
      for monorepos, base branch (detect and **ask** — `origin/HEAD` often disagrees with
      the branch the team actually merges to)
- [ ] Propose the lane roster from `ROUTES` globs; user edits; write it down
- [ ] Read/write the fenced `crew` block in `AGENTS.md`, idempotent, diff shown first,
      never touches prose
- [ ] `.git/info/exclude` gets `.worktrees/`, `council-artifacts/` — per-clone, not
      committed, so the crew stays out of the team's diffs
- [ ] graphify staleness check: `graphify-out/graph.json` mtime vs `git log -1`; offer rebuild
- [ ] Tests: detection, block parse/write round-trip, scope resolution

#### Phase 1b — intake + gate — **DONE** (2026-08-21)
- [x] ~~`Role` union gains `cpo`/`cto`~~ — **not needed.** Agent names are plain strings and
      both lanes always run, so nothing routes to them. Touching the union would have been
      work in service of nothing.
- [x] `agent/crew-cpo.md` (outcomes + acceptance criteria), `agent/crew-cto.md` (ordered
      items grounded in the graph)
- [x] graphify helpers shelled out, `GRAPHIFY_QUERY_LOG_DISABLE=1` always
- [x] `WorkItem[]` via the existing `WORKITEMS_SCHEMA`
- [x] Gate renders; writes nothing
- [x] CPO → CTO is **sequential**, an artifact handoff. Parallel would give two independent
      readings of the directive and no owner of the merge.

**Measured, first live run (opencode-council, "refuse to plan on a stale graph"):**

| | |
|---|---|
| graph context | 12,749 chars in 0.4s |
| intake | 162.7s, 2 calls (gpt55 → opus5) |
| output | 5 items, **file paths and line numbers taken from the graph** (`src/crew.ts:L237`, `src/index.ts:L101`, `src/engine.ts:L783`) |
| acceptance quality | judgeable — "the ask spy call count is zero", "renderCrewBlock's output is byte-identical" |

The grounded line numbers are C13 paying off: without the graph these would have been
plausible guesses, and a guessed path costs a whole implementation round.

**Two bugs found by running it, both fixed:**
- `ask()` called `.json()` before checking status. A 401 returns an empty body, so an auth
  failure reported as `Unexpected end of JSON input` — a parser error for a missing
  credential, which sends you looking in entirely the wrong place. Now reads text first and
  classifies 401/403 as `autherror`.
- `Intake.dropped` recorded *that* a lane failed but not *why* — the exact silent-fail §8
  forbids. "No items because every model was rate-limited" and "no items because the
  directive was incoherent" need opposite responses from the human. Now carries state and
  detail, and stops walking the roster on `autherror` rather than turning one
  misconfiguration into five identical errors.

#### Phase 2 — execute — **DONE** (2026-08-21)
- [x] `agent/crew-dev.md` with ponytail inline (C12), incl. the never-simplify-away list
- [x] Worktree per run, `prune` on start, cleanup on failure, kept on success
- [x] Implement → verify → commit per item; conventional commit scope from the item's path
- [x] ~~Secret exclusion named in the implement prompt~~ — a sentence in a prompt is not a
      control. Superseded by `external_directory: deny` (§9.7), which is enforced by the
      runtime. Note a git worktree contains only *tracked* files, so a gitignored `.env`
      is not present in it to begin with.
- [x] `gh pr create`; PR body carries the directive, per-item status, and **what did not
      land** — an incomplete run must not read as a complete one
- [x] Manifest change in an item → real install before the check
- [x] Wall-clock budget enforced between items

**The worker is agentic, not content-emitting.** `POST /session` and
`POST /session/{id}/message` accept a `?directory=` query parameter. Verified 2026-08-21: a
session created against a worktree reports that path from `pwd` and the worktree's branch
from `git rev-parse`. So `crew-dev` gets `edit`+`bash` **pinned to the worktree** and reads,
greps and runs tests directly.

This is both more capable than marshalling whole files through `IMPLEMENT_SCHEMA` and less
code — but it is safe *only* because of the directory pin, so the argument does not
generalise to any other caller. Read-only lanes keep `edit: deny, bash: deny`; the grant is
opt-in per agent file via `tools:` frontmatter. We still re-run the verify command
ourselves afterwards: a model reporting on its own work is not evidence.

**Measured, first live execute (opencode-council):**

| | |
|---|---|
| worker call | 38.0s, one attempt |
| result | `src/crew.ts` edited, `npm test` passed, committed `feat(src): document humanBytes` |
| **user's checkout** | **`git status` clean throughout** — the pin holds |

**Three bugs found by running it, none of which reasoning had surfaced:**
- A test asserted the repo root ends with `opencode-council`. That is false inside
  `.worktrees/<slug>` — *which is where every crew run executes* — so it would have failed
  on each one. Now asserted against `git rev-parse` output.
- The symlinked `node_modules` showed as untracked in the worktree, so `git add -A` staged
  the symlink into the commit **and** the no-change guard read it as real work — making a
  worker that changed nothing indistinguishable from one that did. Both paths now use a
  `:(exclude)node_modules` pathspec, with a regression test.
- `commitMessage` produced `feat(README): …` for root files, reading as though README were
  a component.

#### Phase 3 — the full loop — **DONE** (2026-08-21)
- [x] All items sequentially; **escalation** on failure (C5) — after `MAX_ATTEMPTS` plain
      retries, a lane that is not the implementer reads the failure and the work so far and
      writes the brief for the next attempt. Escalating earlier would diagnose noise.
- [x] **Acceptance check** (C8) — an independent judge reads the item's diff against its
      criteria after the checks pass. Polarity inherited from the skeptic lane: `real: true`
      means a genuine problem, i.e. not delivered. Judge is excluded from the models that
      wrote the code — Panickssery et al. measure self-preference bias directly.
- [x] **Review cycle** (C6) — council review of the branch; BLOCKERs become work items and
      re-enter execute. Suggestions and nits go to the PR body for the human: looping on
      taste spends the budget a real defect needs.
- [x] Termination floors (C7): `MAX_ATTEMPTS=2`, `MAX_ESCALATIONS=3`, `MAX_REVIEW_CYCLES=3`,
      `MAX_RUN_SECONDS=3600`. Every exit path emits a report, and `stoppedBy` is **computed**
      — the report says *why* it stopped in prose, never a bare enum.
- [x] Heartbeat per step via `onStep`
- [x] **Deleted `work` mode**, `/council-work`, `src/work.ts` (332 lines), `renderWork`, and
      `IMPLEMENT_SCHEMA`. Crew is a strict superset; two implement loops would mean
      maintaining both and guessing which to run.

The honesty property is now tested rather than asserted: a run with any outstanding item
cannot render as `**Done**`, an empty run is not `Done` either, every `stoppedBy` is
explained in prose, and a failed `gh pr create` reports the branch as pushed rather than
the run as lost.

**One self-inflicted breakage worth recording:** deleting the work block with index-based
string slicing silently merged `council`'s args into `crew` and removed the `council` tool
entirely — while all 82 tests still passed, because nothing tests tool registration. Caught
only by loading the plugin and printing `Object.keys(tool)`. Structural edits to `index.ts`
get exact-string edits and a load check, not offset arithmetic.

#### First full end-to-end run — 2026-08-21

Directive: *"add a /crew-status command that lists the live crew worktrees in this repo with
their branch and age, so abandoned runs can be found and removed."* Run against a dedicated
`opencode serve --port 4177` so the crew agents were registered.

| | |
|---|---|
| intake | 2 items, both citing real line numbers (`src/index.ts` ~L126, ~L145, ~L156) |
| item 1 | 1 attempt → `3f61401` |
| item 2 | **2 acceptance rejections**, 1 escalation, then `1998af2` |
| review | 1 finding: 0 blocker, 1 suggestion → correctly did not loop |
| total | 1140s, `stoppedBy: complete` |
| result | 129 insertions across 5 files, `listWorktrees`/`renderWorktrees` each defined **exactly once** despite the retries, tests added to both suites |

**C8 paid for itself on the first run.** `npm test` passed on both rejected attempts. The
acceptance judge still caught that the diff imported functions it believed were undefined —
the check tests could not make. This is the "superficial verification" failure §6b names,
caught in practice.

**Two bugs the run exposed:**

1. **The report lied.** `push` failed (no `origin`) and the output still said *"The branch
   is pushed; open it yourself"*. Telling someone their work is on a remote when it is not
   sends them looking somewhere empty. `RunResult` now carries `pushed` separately from
   `prError`, and the test covers both push-failure and gh-failure — it previously only
   covered the latter, which is exactly why this shipped.
2. **The acceptance judge had a false-negative mode.** It saw only the item's own diff, so
   when item 2 called a function item 1 had already committed, it reported that function
   "is not defined anywhere in src/crew.ts" and rejected twice. Cost two attempts and an
   escalation on a non-problem. The judge is now told which items already landed on the
   branch and instructed not to call a symbol undefined merely because its definition is
   not in this diff.

Neither was reachable by reasoning about the code. Both needed a real run.

**The branch was reviewed and merged.** The code holds up: `git worktree list --porcelain`
parsed properly, filtered to `crew/` branches so a user's own worktrees cannot appear in a
list whose purpose is deletion, pruned registrations skipped, and age taken from the
directory's birthtime rather than the HEAD commit date — with that reasoning written down,
because it is the non-obvious part (a fresh run in a stale repo would otherwise report days
of age and read as abandoned).

It also fixed a latent bug nobody asked it to: the `crew` tool's `execute` arg type still
read `"init" | "plan"` and was already missing `"run"`. The CTO lane spotted it while
reading `index.ts` for item 2 and the implementer corrected it in passing.

`/crew-status` therefore exists because the crew built it, and its first output was the
worktree the crew itself had been running in.

#### PAUSE — run it on something real before Phase 4.

#### Phase 4 — tracker seam — **DONE** (2026-08-21)
- [x] `start / step / itemDone / finish`. The stdout implementation is the **default, not
      silence** — an unmirrored run would otherwise be twenty silent minutes, which is
      indistinguishable from a hang.
- [x] `guarded()` — a tracker failure costs a warning line, never a branch. The work is
      real; the mirror is not. An outage, an expired token or a preview-schema change must
      not be able to lose committed work.
- [x] `fanout()` — a mirror never *replaces* the terminal signal, it accompanies it.
- [x] Three config states kept distinct: **absent** (never asked → ask once, offer to
      record), **`none`** (declined → never re-ask), **unknown** (dropped, so a typo reads
      as "never asked" rather than silently disabling tracking).
- [x] `availableTrackers()` lists only what can actually be honoured, so init cannot ask a
      question it is unable to deliver on.

Also closed a gap this surfaced: in the real tool path `runExecute` had nowhere to send
progress, because a tool call returns once at the end. Steps now append to `run.log` in the
artifact dir as they happen, so a run can be tailed while it is still going.

#### Phase 5 — Linear tracker — **BUILT, UNVERIFIED against a live workspace** (2026-08-21)
- [x] `src/linear.ts` — hand-rolled over `fetch`, six operations. Not `@linear/sdk`: both
      APIs are previews (Agents API is Developer Preview, Agent Plans is a technology
      preview) and Linear says outright they may change. A thin file is a one-file repair;
      a dependency pinned to a preview schema is not.
- [x] `agentSessionCreateOnIssue`, `thought` acknowledgement **within the 10s window Linear
      requires**, `agentSessionUpdate{plan}` as the live checklist, `action` per item,
      `response`/`error` at the end, PR via `addedExternalUrls` (never `externalUrls`,
      which replaces the whole array).
- [x] Progress uses **ephemeral** activities, so a twenty-minute run replaces its own
      progress line instead of burying the issue in a hundred entries.
- [x] Outbound only. No webhook, no daemon, no ingress.
- [x] Every degradation path is honest: no token → not offered; token but the directive
      names no issue → says so and falls back to terminal-only; unreachable Linear →
      warning line, run continues.

**Verified against a stub GraphQL server (8 tests), not a real workspace.** That proves the
client is internally consistent — a plan status actually flips, a stuck item is `canceled`
rather than left `pending` forever, an incomplete run reports as `error` not `response`.
It cannot prove Linear accepts these mutations. Only a real workspace can.

**What remains, and it needs the human:** create a Linear OAuth application with
`actor=app` and the `app:assignable` scope (**workspace admin required**), then export
`LINEAR_API_TOKEN`. Until then `availableTrackers()` correctly omits `linear` and init will
not offer it.

### 9.7 Confinement — claimed, then actually measured (2026-08-22)

C15 said the worker's `bash` was "confined to the worktree". A full-panel council review
raised it as a BLOCKER, and it was right: the session sent `pattern: "*"` on every rule and
`?directory=` only governs *relative* path resolution. The claim was untested — verifying
`pwd` had been mistaken for verifying confinement, and `pwd` is not evidence of anything.
Worse, `crew-dev.md` told the model outright that "nothing you do here can reach the user's
checkout", so an unenforced control was also a false statement to the agent relying on it.

Probed against a worktree-pinned session, `cat` of a path outside it:

| permissions sent | result |
|---|---|
| `edit:*allow, bash:*allow` (what shipped) | **session hung** — raised a permission prompt with no human attached |
| `+ external_directory:*deny` | **"denied by the permission rules"**, immediately |
| `+ external_directory:*deny`, work *inside* the worktree | read, write and `npm test` all fine |

So the shipped behaviour was not a silent leak — it was a **silent stall**, which the run's
wall clock would eventually trip. Still a real defect, and a less obvious one.

`external_directory: deny` is now unconditional on every session the engine creates,
including read-only lanes: none of them has cause to reach outside, and a lane that hangs
on a prompt is a dropped lane. Verified through `ask()` itself, not a hand-rolled request —
outside refused, inside unaffected.

Two consequences worth keeping:
- **A git worktree contains only tracked files.** A gitignored `.env` is not in it at all,
  so the `SECRETS` prompt list was guarding against something largely absent while the real
  exposure — everything outside the worktree — went unguarded.
- **`pwd` is not confinement.** The original verification looked convincing and proved
  nothing about what the process could reach.

### 9.5 Explicitly NOT building

| rejected | why |
|---|---|
| Parallel item execution | C2. Nothing measured says sequential is too slow. Re-open with a number, not a feeling. |
| Linear webhook / daemon (Tier 3) | Buys exactly one thing: starting a run from the Linear UI. Costs a public endpoint, a 5s ACK path, and an always-on worker. Purely additive later — the receiver would call the same entry point. |
| Spend cap | C16. |
| Resume / event log | C17. |
| `AGENTS.md` distillation digest | 64KB × ~50 calls is real overhead, but building the digest before measuring is the mistake §6c warns about. Report the number first. |
| graphify via MCP | Shelling out works regardless of whether engine-created sessions receive MCP tools. Revisit once Phase 1 answers that. |

### 9.6 Open risks

0. **New agent files need an opencode restart.** Measured 2026-08-21: `crew-cpo` returned
   `http 500 UnknownError` from a server started before the file existed, while
   `council-product` on the same model answered fine. The plugin's `config` hook runs at
   server start, so an agent added mid-session does not exist as far as the server is
   concerned — and the error says nothing about why. Restart after adding a lane.
1. **Do engine-created sessions load `AGENTS.md` or plugin prompts?** C11 and C12 make this
   moot by inlining both — but if injection *does* work we are paying twice. Measure in
   Phase 1.
2. **Intake quality is the whole product.** A bad task list poisons every downstream phase.
   This is where to over-invest, and graphify (C13) is the lever.
3. **graphify community labels are LLM-free placeholders** without a backend. Names come
   from representative nodes (`community=transaction.module.ts`), which is serviceable but
   worse than real labels. `--backend claude-cli` would use the local subscription; not
   done yet.
4. **nixpkgs graphify is 0.9.28, PyPI is 0.9.48.** We shell out to stable CLI surface
   (`extract`/`query`/`path`/`explain`), so skew is low-risk. PyPI wheels do not work on
   NixOS — numpy needs `libstdc++`/`libz` the wheels cannot find. Do not "fix" this with
   `LD_LIBRARY_PATH`.
