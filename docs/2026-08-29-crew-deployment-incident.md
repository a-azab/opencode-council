# Crew deployment incident report — 2026-08-29

**Repo affected:** `FundMe/oci-infrastructure` (crew run `2026-08-29T09-24-50-crew-org-plan`, 10 tasks / 19 items)
**Plugin:** `opencode-council` (`/root/code/opencode-council`)
**Outcome:** 3 failed runs → 4th run working. Root cause was **not** the plan, the models, or the repo — it was **server auth propagation to spawned sessions**, masked by two red herrings.

---

## Timeline

| Run | Started | Result | Blocker |
|---|---|---|---|
| `mte6s7n1` | 09:36 | 0 waves completed | `item.files.join is not a function` (plugin crash, wave 1) |
| `mtect23l` | 12:19 | All 10 waves "scheduled", **0 files written** | `deepseek/deepseek-v4-pro: session create http 401` |
| `mteejhfx` (attempt A) | 13:14 | Wave 1 model-failed; wave 2 committed | `opencode-go/kimi-k3: The operation timed out` |
| `mteejhfx` (attempt B, auth fixed) | — | **waves committing, in progress** | — |

---

## Root cause 1 — plan encoding: `item.files.join is not a function`

### Symptom
Wave 1 crashed instantly on `item.files.join is not a function` — zero branches produced.

### Diagnosis
Census of the plan JSON (09:24 plan) vs a known-good 08-28 plan:

```
--- RAN OK 2026-08-28 ---   item keys: ['title','detail','files','acceptance']   files: list
--- STOPPED 2026-08-29 ---  item keys: ['title','detail','files','acceptance']   files: str   <-- 19 of 19
```

The 09-24 plan was written with `files` as a **string** in some items; the crew scheduler expects `files` as an **array** and calls `.join()`. Fix: normalized all 19 items to `files: string[]` (52 distinct paths, 0 malformed). This also fixed the dependency graph — absent-file resolution went from opaque blobs to per-path resolution (18 → 65 distinct).

**Status: FIXED (in the recorded plan; no plugin change needed).**

---

## Root cause 2 — server auth: `session create http 401` on every spawned worker

### Symptom
All 10 waves "executed", **zero files written**. `run.log`:
```
[00:00] [The edge...] attempt 1/5: implementing
[00:00] [The edge...] stopped: model-failed
```
`state.json` per task: `model-failed | deepseek/deepseek-v4-pro: session create http 401: (empty body)`

### The first red herring
The deepseek credential in `auth.json` was suspected (expired/revoked). **It was not.** Direct probe against `api.deepseek.com` with the same key returned the model list (200).

### The second red herring
Switching the implementer lead from `deepseek` to `anthropic/claude-opus-5` (user directive) **did not fix it** — identical 401 on a different provider. That falsified the credential hypothesis entirely.

### Real cause (proven end-to-end)
The opencode **server** (`opencode serve --port 4096`) requires **HTTP basic auth** (`OPENCODE_SERVER_USERNAME/PASSWORD`). The crew tool spawns per-task sub-sessions via the server API. The spawned processes **did not inherit the auth env vars**, so every `POST /session` returned 401 — regardless of which model was requested. Evidence:

- `GET /config` and `POST /session` → **401 without auth, 200 with auth**
- Env census: `OPENCODE_SERVER_USERNAME/PASSWORD` were `UNSET` in every spawned crew child (`0 of 2` vars present), while set in the server process itself
- Same 401 on deepseek AND anthropic — impossible if a single credential were bad

### Fix
Export the creds so spawned children inherit them:
```bash
export OPENCODE_SERVER_USERNAME='...' OPENCODE_SERVER_PASSWORD='...'
opencode run --username '...' --password '...' ...
```
Verified: spawned shell children now carry both vars (`2 of 2`), auth probe flips 401 → 200, server pid unchanged (no restart).

**Status: FIXED (environmental — no plugin bug, but see recommendations §A).**

---

## Root cause 3 — implementer chain: dead kimi tail + one-shot chain

### Symptom
With auth fixed, wave 1 attempt 1 ran the full 36 min then:
```
stopped: model-failed | opencode-go/kimi-k3: The operation timed out.
attempts: 1  →  remaining 3 items in the task: not-attempted
```

### Diagnosis
The implementer chain (`LETS_IMPLEMENT_MODELS`, `src/lets.ts`) was:
```
deepseek → opus5 → gpt56terra → glm53 → minimax → kimik3 → kimik3go
```
(deepseek led; after the 2026-08-29 directive, `opus5` leads: `opus5 → deepseek → ...`)

Two structural problems surfaced:

1. **Known-dead tail:** `kimik3` (`kimi-for-coding/k3`) has a documented spent quota — the roster comment itself says *"the account is exhausted... the one member of that chain currently guaranteed to fail."* Its timeout **burned the recorded failure detail**, masking what actually happened upstream (opus5 ran 36 min, burned $1.38/12.3k output tokens, and did not land the change within its window).

2. **One-shot chain:** a single attempt iterates the whole chain; when the chain exhausts, the item is `model-failed` with **only the last model's error** in `detail` (`src/lets.ts:1583`):
   ```ts
   last = { ...last, state: "model-failed", detail: `${member.model}: ${r.detail}` }
   if (r.state === "autherror") return last
   ```
   A slow-but-close opus5 run gets **no retry with feedback** because the chain exhausted inside attempt 1 — and 3 remaining items in the same task were never attempted.

### Fix (user directive, applied + tested)
`src/lets.ts:718`:
```ts
export const LETS_IMPLEMENT_MODELS = ["opus5", "deepseek", "gpt56terra", "glm53", "minimax", "kimik3go"] as const
```
- `kimik3` (dead, quota-exhausted) dropped from the implementer chain
- `kimik3go` (opencode-go route) kept as last-resort tail
- Intake chain (`LETS_INTAKE_MODELS`) unchanged — still has both kimi routes adjacent for quota fallback
- Tests updated: `lets.test.ts` (lead assertion → opus5; kimi fallback test → intake keeps both, implement keeps go-only; implementer-keeps-intake test → skips kimik3 with explicit assert). **72/72 pass.**

**Status: FIXED in source (applies to next run; the in-flight run loaded the old chain at startup).**

---

## Appendix A — recommendations for the plugin

1. **Auth failure isolation (design gap):** the 401 was environmental, but the plugin had no way to distinguish "credential broken" from "server rejects us" until we probed manually. Consider surfacing the server auth requirement in the preflight (e.g., probe `GET /config` with/without auth and warn when a server needs creds the spawned children won't inherit).

2. **Chain detail masking:** `detail` records only the **last** model's error. When a chain exhausts, keep a compact per-model error list (`opus5: timeout; deepseek: 401; ...`) so the report says *which* models failed, not just the tail. This incident was misdiagnosed twice because the visible error was always the last model's.

3. **One-shot chain vs retry:** consider allowing a second attempt when the lead model made real progress (diff exists, non-trivial tokens spent) but the chain timed out — the current `attempts: 1` with 3 un-attempted sibling items is the cheapest possible recovery, not the most useful.

4. **Timeout budget:** `timeoutFor()` caps at 300 s (5 min) per node call (`src/engine.ts:83`). The 36-min wave-1 attempt is a **chain of many node calls**, not one call — worth documenting so "36 min then model-failed" is read as "N model calls exhausted the attempt", not a single hung call.

## Appendix B — git state at time of writing (nothing pushed)

- `crew/integration`: 21→22 commits ahead of `origin/main`, never pushed (previous run's merged work + ADR + bd export)
- `main`: 1 unpushed commit (`b5ae68f` bd export)
- Dead branches/worktrees from all failed runs: cleaned (10 `mtecln71`, 10 `mtect23l`, stranded `mte6s7n1`)
- 7 legitimate `mtcvvalc` worktrees from the earlier successful run: untouched
- Blocker issue filed: `oci-infrastructure-ggq` (P1) with evidence chain

---

## Review — 2026-08-29, against source

Every claim below was checked against the code rather than the report. **Root causes 1 and 3
needed correcting; root cause 2 was right and is now better reported.**

### Root cause 3 was misdiagnosed — the implementer was timing out at 90 seconds

`ask()`'s default timeout is `DEFAULT_TIMEOUT_MS = 90_000` (`src/engine.ts:70`), sized for a
single structured answer. The implementer passed **no override** — so an agentic session that
reads the surrounding code, edits files and runs the project's verify command was aborted at
90 seconds. And `isRetryable` returned true for `timeout` unconditionally, with
`maxAttempts: 3`.

```
7 models × 3 attempts × 90s + backoff = 31.9 min      predicted
                                        36 min        observed
```

**No model could ever have implemented anything.** The chain was guaranteed to exhaust, every
time, on every item. opus5 did not "run 36 min and not land the change" — it was cut off at 90
seconds, three times, and so was every model after it.

The report's two conclusions do not survive this:

- **"one-shot chain"** — it was three-shot per model, which is precisely what made 36 minutes
  out of what should have been one attempt.
- **"known-dead kimi tail burned the recorded failure detail"** — the tail contributed ~4.5 of
  the 36 minutes. Dropping it changes nothing about the mechanism.

Fixed: `IMPLEMENT_TIMEOUT_MS` (10 min), `FALL_THROUGH_ON_TIMEOUT` so a timeout yields its slot
to the next model instead of retrying the same one, a per-model deadline check, and every
model's error in `detail` instead of only the tail's.

### The kimi entry was not dead — a weekly quota had reset

The roster comment said *"currently guaranteed to fail"*, written 2026-08-28 after a probe
returned "you have reached your weekly (7-day) usage". Re-probed 2026-08-29:

```
PASS  8687ms  kimi-for-coding/k3
PASS  6155ms  opencode-go/kimi-k3
```

A spent quota is a temporary state that reads exactly like a permanent one. The comment
outlived the fact by a day, and this report repeated it as grounds for a roster change. Both
model IDs were correct throughout — `k3` and `kimi-k3` both exist on their providers.

Kimi is now reserved for the judgement lanes (`security`, `code`) and kept out of both chains
— a budget decision, since the quota is small and the chains run per plan and per item.

### Root cause 1 was not "no plugin change needed"

The crash (`item.files.join is not a function`) was the **lucky half**. A string is iterable,
so `withFiles` spreading `"a.ts"` produces `["a", ".", "t", "s"]`. The task's file set becomes
characters, `schedule()` compares them as if they were paths, finds no overlap between any two
tasks, and **runs genuinely conflicting work concurrently** — the one safety property the
parallel design rests on, defeated silently by a mis-encoded field.

Guarded at `withFiles`, which all three crew modes funnel through, so a plan already recorded
in that shape is refused by `execute` too and not only at `plan`.

### Root cause 2 was right, and the message was the trap

The diagnosis is correct and well evidenced. The reason it cost two runs is that the plugin
reported `deepseek/deepseek-v4-pro: session create http 401` — blaming the model for the
plugin's own failure to authenticate to its server. That message now names the server and says
which variables to export. (`autherror` already aborted the chain correctly; only the wording
was wrong.)

### Found while reviewing: a retired model still pinned

`opencode-go/grok-4.5` returns http 500 — the provider replaced it with `grok-4.6`, which
answers in 5741ms. The pin had been dead for an unknown stretch, silently costing `systems`,
`skeptic` and `infrastructure` a member. Nothing caught it, because a dead pin looks exactly
like a model having a bad day and failover covers for it rather than complaining. This is what
`/council:models` exists to surface.

### On Appendix A

| recommendation | status |
|---|---|
| 1. auth failure isolation | partly done — the message now names the server and the fix. A preflight probe is still worth having |
| 2. per-model error list | **done** |
| 3. retry on real progress | superseded — the premise was that opus5 was slow. It was being cut off at 90s. With a 10-minute budget the first attempt is a real one |
| 4. document the timeout budget | done, in code: `IMPLEMENT_TIMEOUT_MS` carries the arithmetic and the incident reference |
