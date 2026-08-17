# opencode-council

Multi-model code review for [opencode](https://opencode.ai), shipped as one plugin.

Eleven models review your diff in parallel, each in the role it is assigned. Every finding
is then challenged by independent skeptics that did not raise it, and what survives is
decided by arithmetic — not by asking a model to summarise.

**No single model decides anything.** Dedupe, dispute detection, convergence, and
keep/downgrade/drop are all computed in code you can read and test.

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
opencode agent list | grep -E '^council-.* \(all\)'   # expect 12 roles
```

(Match on `(all)`. A plain `grep council-` will also catch any older model-named council
agents you may still have, which are unrelated to this plugin.)

---

## Use

### `/check` — fast, inline, no subagents

Six lenses (bug, security, performance, quality, compliance, docs), max 5 findings, ~30s.
It never asks a question and never moves HEAD, so it is safe to fire mid-edit.

```
/check
```

### `/council-review` — the full graph

```
/council-review
```

Or call the tool directly for a different base:

```
council({ base: "main" })
```

### `/council-fix` — patches, behind your gate

```
/council-fix
```

Generates a patch per finding and **applies nothing**. Each patch is validated with
`git apply --check` before you ever see it; a fixer that is guessing returns
`confident: false` and is escalated rather than applied.

Artifacts land in `council-artifacts/<timestamp>/` — `report.md` and `findings.json`.

---

## How it works

```
 diff ──▶ route ──▶ fan-out (parallel, one node per role x model)
                    [security] [systems] [code] [qa] ...
                         │
                         ▼
                     dedupe ──────────────────────── file + category + line window
                         │
              disputed? ─no──────────────────┐
                         │yes                │
                         ▼                   │
                      debate (only disputing models, only disputed findings)
                         │                   │
              converged? ─no & round<MAX─▶ ⟲ │      computed, never declared
                         │yes                │
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

Eleven models, each individually confirmed to emit schema-valid structured output.
`ms` is measured latency on a trivial structured task — for setting timeouts, not a
quality signal.

| slug | model | roles | ms |
|---|---|---|---|
| `opus5` | anthropic/claude-opus-5 | reviewer, security | 4263 |
| `fable` | anthropic/claude-fable-5 | security, skeptic | 6704 |
| `gpt55` | openai/gpt-5.5 | product, reviewer, security | 4369 |
| `glm52` | zai-coding-plan/glm-5.2 | systems, reviewer | 8403 |
| `kimik3` | kimi-for-coding/k3 | code | 21151 |
| `gemini36` | google/gemini-3.6-flash | breadth, docs | 9028 |
| `grok45` | opencode-go/grok-4.5 | systems, skeptic | 7146 |
| `mimo` | opencode-go/mimo-v2.5-pro | pragmatist, skeptic | 7027 |
| `minimax` | opencode-go/minimax-m3 | reviewer, skeptic | 4532 |
| `nemoultra` | opencode/nemotron-3-ultra-free | reviewer, systems | 7307 · free |
| `nemolight` | opencode/nemotron-3.5-lightning-free | skeptic, qa, ops | 4672 · free |

Model diversity earns its keep in the **skeptic pool**: three votes from one model are
correlated and near-worthless; three from different models are evidence.

Edit `src/roster.ts` to change it. **Smoke-test anything you add** — `models.json`'s
`structured_output` flag is unreliable in both directions, and several catalogued models
are not actually served.

### Excluded, with cause

| model | cause | remedy |
|---|---|---|
| `deepseek/*` | `400 Thinking mode does not support this tool_choice`, every variant | opt in to `opencode-go/deepseek-v4-pro` at `opencode.ai/workspace/.../go` |
| `opencode-go/qwen3.{7,8}-max` | deterministic timeouts (120s, 150s, 240s) | none found |

There is no text-JSON fallback by design. A model either passes the smoke test or is not
in the roster; a second parse path for two models is complexity for marginal diversity.

---

## Known limits

- **A full review takes ~1–3 minutes.** Rounds are sequential and each is bounded by its
  slowest member, so worst case is roughly 4× the per-node timeout.
- **`anthropic/*` models only work in your main opencode process.** They route through a
  local proxy that a second server cannot reach.
- **Nodes fail, and the report says so.** A node that did not run is always listed with its
  cause and the verdict is marked provisional. This is deliberate: a node that failed must
  never be indistinguishable from one that found nothing.
- Findings are grounded in the diff only. There is no repo-wide index.

---

## Development

```bash
npm test        # node --test, no framework, no build step
```

`src/decide.ts` is the deterministic core and carries the most test weight — if you change
it, the two asymmetries above are the things most likely to be "simplified" into bugs.

| file | role |
|---|---|
| `src/decide.ts` | pure aggregation: dedupe, disputes, convergence, decide |
| `src/roster.ts` | models, routing table, node and skeptic selection |
| `src/engine.ts` | fan-out, debate, verification, fix — moves data, holds no judgement |
| `src/schema.ts` | JSON Schemas enforced by the runtime as forced tool calls |
| `src/report.ts` | report rendering |
| `src/index.ts` | plugin entry: registers agents, commands, and the `council` tool |
| `agent/*.md` | the 12 role prompts — expertise and tier calibration only |

**[PLAN.md](./PLAN.md)** carries the design decisions with rationale, the measured spike
results, and 18 opencode runtime gotchas that cost real time to discover. Read it before
changing the architecture.

## License

MIT
