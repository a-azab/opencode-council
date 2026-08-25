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
| `council({ mode: "independent", goal: "..." })` | every model answers alone, nothing merged |

`goal` is required for `mode: "plan"` and ignored otherwise. `base` accepts any git ref.

To **build** something rather than judge it, use the `crew` tool — see below.

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

## The crew — a directive to a PR

The council judges work. The **crew** does it.

```
/crew:init                                    # once per repo
/crew add a --json flag to the export command # plan it, and stop
/crew:execute                                     # build the plan you approved
```

### `/crew:init` — hire for this repo

Detects the stack, the command that proves the project still works, the branch PRs target,
and which review lanes this repo needs. Proposes all of it, and **asks about what is
genuinely ambiguous** rather than picking. On a monorepo it offers `nx affected` ahead of
the whole-workspace command — running 900 files of tests to check a one-file change is how
a run becomes an hour.

The answers land in a fenced `crew` block in your `AGENTS.md`. Editing it by hand is the
intended way to change your mind; re-running init only ever rewrites that block, never
prose you wrote.

### `/crew:plan <directive>` — intake, then a gate

Two lanes, in sequence, handing an artifact to each other:

- **CPO** turns the directive into outcomes and *checkable* acceptance criteria. "Handles
  errors" is not a criterion; "a duplicate submit returns the first result rather than
  creating a second record" is.
- **CTO** turns those into an ordered work item list, grounded in a
  [graphify](https://github.com/Graphify-Labs/graphify) knowledge graph of your codebase —
  real node locations and call edges, so `files` are cited rather than guessed.

Then it **stops**. Nothing is written until you approve. If a lane failed to answer, the
gate says so — a thin plan is never presented as a simple one.

### `/crew:execute` — build it

Runs **the plan you approved**, not a fresh one. Re-planning here would build something
other than what you read.

Each item, in order, in a throwaway worktree: implement → run your check → have a model
that *didn't write it* judge the diff against the item's acceptance criteria → commit.

**Green tests are not evidence the item was delivered.** A suite that never covered rate
limiting stays green whether or not you added it. That is why acceptance is judged
separately, and by someone else.

When an item gets stuck, the crew escalates instead of giving up: a lane that isn't the
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

An incomplete run reports as incomplete, in the terminal and in the PR body. Items that
never ran are listed as `not-attempted` with the reason — a plan that stopped at item 2 of
6 reports "1/6", not "1/2". An item that passed its checks without an independent judge
says **"NOT independently judged — checks only"**. That is enforced by tests, because the
one lie that would matter is the report that hides what happened.

### `/crew:status` — what's still lying around

Lists live crew worktrees with their branch, age, and the exact command to remove each.
Works in any git repo, including one with no crew config — that's precisely where a
worktree gets stranded and forgotten.

The crew wrote this one.

### Tracking — optional, and off by default

Runs report to your terminal. If you want them mirrored somewhere, `/crew:init` asks once
and records the answer in the `crew` block.

| `tracker:` | behaviour |
|---|---|
| absent | init never asked — it will ask once, and offer to record your answer |
| `none` | you declined. It won't ask again. |
| `mcp` | mirrored through any MCP server configured in opencode.json — Jira, GitHub Issues, Plane, … |
| `linear` | mirrored into a Linear agent session (native fast path) |

**`none` and absent are different on purpose.** Creating issues in someone's workspace
uninvited is worse than asking one question, so the crew never guesses.

With `mcp`, the tracker is whatever you already run: name one of your opencode.json
`mcpServers` entries and map the run's moments to that server's tools. Argument names are
the server's, not ours — a small template adapts them:

```crew
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
from opencode.json so the crew adds no server configuration of its own.

With `linear`, the crew registers as a real workspace member and streams into a native
agent session: a live plan checklist, one entry per item, and the PR link attached when it
opens. Outbound only — no webhook, no public endpoint, no daemon. Needs `LINEAR_API_TOKEN`
from an OAuth app installed with `actor=app` (workspace admin required). Without the token
it isn't offered at all. It is an implementation of the same seam, not a privileged one.

**A tracker can never break a run.** An outage, an expired token, or a preview-API change
costs you a warning line. The work is real; the mirror is not.

### `/council:independent` — the raw takes, unmerged

```
/council:independent what's the biggest risk of an in-memory rate limiter?
```

Every model in the roster answers **alone**. No routing, no dedupe, no debate, no
verification, no synthesis. One file per model in
`council-artifacts/<timestamp>-independent/`, plus an index.

This is deliberately the only mode that does **not** aggregate. Everything else here exists
to turn many opinions into one answer; aggregation is lossy by design, and sometimes what
you want is to read the disagreement yourself before any machinery decides what mattered.

It is also the only mode that sends **no schema** — the output is prose for a human, and
forcing a tool call to carry free text costs models that can't do it for no benefit
(measured: 7/11 with a one-field schema, 11/11 without).

### `/council:plan` — pick an approach by vote

```
/council:plan add rate limiting without adding Redis
```

Five lanes propose an approach. Every model then scores every proposal **except its own**
on correctness, simplicity, risk and completeness. The winner is the highest mean —
arithmetic, not a model's preference.

**Ties come to you.** Two proposals within `TIE_MARGIN` are not meaningfully ranked, so no
winner is declared; picking one would be false precision the numbers don't support.

Artifacts land in `council-artifacts/<timestamp>-<kind>/` — `report.md`, `findings.json`,
`patches.md`, or `plan.md` + `plan.json`.

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
                      debate — OFF by default (see below); only ever wakes for
                         │                   disputed findings, disputing models
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

**Debate is off by default** (`DEFAULT_MAX_ROUNDS = 0`). Huang et al. (ICLR 2024) found
multi-agent debate *losing* to self-consistency at matched budget with round 2 worse than
round 1, and our own measurement agreed: one debate round re-judged six findings and
changed zero positions while wall time tripled. The code remains; turning it back on is a
one-line experiment that needs a positive result to justify itself.

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
| which plan wins | mean of cross-scores; ties escalate rather than resolve |

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

Fourteen models. `ms` is measured latency on a trivial structured task — for setting
timeouts, not a quality signal. Every member was smoke-tested on joining; two of the
fourteen are carried on user directive despite currently failing that smoke (noted below) —
the bench makes a model-level failure cost one call per run, so they are cheap to carry.

| slug | model | roles | ms |
|---|---|---|---|
| `opus5` | anthropic/claude-opus-5 | reviewer, security | 4263 |
| `fable` | anthropic/claude-fable-5 | security, skeptic | 6704 |
| `gpt55` | openai/gpt-5.5 | product, reviewer, security | 4369 |
| `glm52` | zai-coding-plan/glm-5.2 | systems, reviewer | 8403 |
| `kimik3` | kimi-for-coding/k3 | code | 21151 |
| `kimik3go` | opencode-go/kimi-k3 | code | 6782 |
| `gemini36` | google/gemini-3.6-flash | breadth, docs | 9028 |
| `grok45` | opencode-go/grok-4.5 | systems, skeptic | 7146 |
| `mimo` | opencode-go/mimo-v2.5-pro | pragmatist, skeptic | 7027 |
| `minimax` | opencode-go/minimax-m3 | reviewer, skeptic | 4532 |
| `nemoultra` | opencode/nemotron-3-ultra-free | reviewer, systems | 7307 · free |
| `nemolight` | opencode/nemotron-3.5-lightning-free | skeptic, qa, ops | 4672 · free |
| `musespark` | opencode/muse-spark-1.2-contributor-free | breadth, docs | 8000 · free · **chats but no structured output as of 2026-08-23** |
| `hy3` | opencode/hy3-free | qa, ops | 5000 · free · **chats but no structured output as of 2026-08-23** |

`kimik3go` exists as the `code` lane's billing-cycle fallback: when kimi-for-coding's
quota trips, the lane substitutes to it first (same role, same model, other provider).

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
- **Nodes fail, and the report says so.** Failed nodes substitute first (see above); one
  that still did not run is listed with its cause and the verdict is marked provisional.
  This is deliberate: a node that failed must never be indistinguishable from one that
  found nothing.
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
| `src/decide.ts` | pure judgement: dedupe, disputes, convergence, `decide`, `tally` |
| `src/roster.ts` | models, routing table, node and skeptic selection |
| `src/engine.ts` | fan-out, debate, verification, fix, plan — moves data, holds no judgement |
| `src/schema.ts` | JSON Schemas enforced by the runtime as forced tool calls |
| `src/report.ts` | report, patch and plan rendering |
| `src/index.ts` | plugin entry: registers agents, commands, and the `council` tool |
| `agent/*.md` | the 12 role prompts — expertise and tier calibration only |
| `src/*.test.ts` | 46 tests: `decide`, `roster`, `tally`, patch classification |

The rule the whole design rests on: **anything that decides an outcome lives in
`decide.ts` and is tested.** `engine.ts` may move data and call models, but if you find
yourself writing a judgement there, it belongs one file over.

**[PLAN.md](./PLAN.md)** carries the design decisions with rationale, the measured spike
results, and 18 opencode runtime gotchas that cost real time to discover. Read it before
changing the architecture.

## License

MIT
