# Borrowing from DeepSeek Harness and ECC without depending on either

**Date:** 2026-09-20 · **Status:** accepted · **Scope:** `src/ralph.ts`, `src/rules.ts`,
`src/schema.ts`, `src/lets.ts`, `src/index.ts`, `src/crew-org.ts`

## Context

The directive: *"merge ECC, deepseek-harness, lets loop engineering and context
engineering, and get the most out of them all, to have a dedicated organization team that
builds things for me."*

Four inputs, and they are not four things of the same kind:

| | what it actually is |
|---|---|
| **ECC** (`/root/code/AI/ECC`) | 281 skills, 122 rules, 94 commands, 48 hooks — an asset library for Claude Code |
| **DeepSeek Harness** (`/tmp/dsh`) | 158MB, 291 workspace packages, MIT — an agent *substrate* |
| **lets/crew** (this repo) | a working orchestrator: worktrees, waves, judging, integration |
| **context engineering** | a discipline, not an artifact |

"Merge" is therefore not a coherent instruction on its own. Two of the four are substrates
and only one can be the substrate. The real question is what to take from each.

Two parallel audits were commissioned, each required to cite file paths. Every
load-bearing claim below was then re-verified by hand before being acted on, because a
subagent summary is a self-report.

## What was measured

**On dsh** — impressive, and genuinely well built. 1,135 `.spec.ts` files against 1,769
sources. Real Claude Code hook protocol (`BLOCKING_EXIT_CODE = 2`, stdin JSON, structured
stdout). Real `subagent-claude-code` on Anthropic's own Agent SDK. A genuinely
provider-neutral `LlmAdapter` whose only required method is `stream()`, plus `llm-pi-ai`
with an `openai-completions` protocol — so pointing it at this machine's OpenCode server
would be a config entry, not a fork.

And three facts that decide against adopting it:

```
vendor/cordis                          ← cordis is VENDORED, not an upstream dependency
grep -rl "@deepseek-ai/cordis" | wc -l → 1230   ← every seam is a cordis module augmentation
git rev-list --count HEAD              → 1      ← one squashed commit; no release history
```

`README.md` says *"developer preview … THERE WILL BE COMPATIBILITY-BREAKING CHANGES"*;
`AGENTS.md` says *"Public APIs are pre-stable"*; the version is `0.1.6-alpha.2`.

Adopting dsh means adopting vendored cordis wholesale, rewriting council/lets/crew against
a different agent loop, and abandoning the opencode integration that is this plugin's
entire reason to exist — in exchange for a dependency with no observable release behaviour
to underwrite it.

The hybrid option is worse than it sounds: dsh's SDK works by spawning a whole
`dsh --profile sdk` runtime over stdio JSON-RPC, and the capabilities worth borrowing
(compaction region selection, spill policy, the repeat-tool guard) all operate *on a
session surface you own* — so they cannot usefully be called across an RPC boundary.

**On this repo** — the audit found real defects, since fixed or recorded:

- crew passed no `maxSeconds`, so every task inherited `runExecute`'s own 1-hour default:
  `MAX_TASKS` 12 / `MAX_WAVE_WIDTH` 4 = 3 waves × 3600s = **a three-hour arithmetic
  ceiling** before integration, verify and the council, none of which were timed either
- `implementPrompt` never received the run's directive
- no token or cost accounting anywhere — the system cannot say what a run spent
- sessions are created per call and never deleted

## Decision

**Keep opencode as the substrate. Borrow ideas from dsh. Borrow assets from ECC. Depend on
neither.**

**1. The Ralph contract** (`src/ralph.ts`, from `packages/workflow/tool-ralph`). A fresh
worker per round carrying only the immutable objective and the previous round's structured
report, with the working tree as long-term memory. The cross-field validation is the value:
`complete` requires evidence AND zero next steps AND no blocker. A schema can say `evidence`
is an array of strings; only a cross-field rule can say that claiming completion with an
empty one is not a completion.

**2. ECC's rules, selected not shipped** (`src/rules.ts`). 270KB sent whole is ~70k tokens
on every prompt — more than the item, the instructions and the diff combined. 111 of 122
rules declare their scope in frontmatter, so selection is possible: this repo gets 5
TypeScript rules (6.4KB) instead of 14 files (24KB) of Swift, Dart and HarmonyOS.

**3. The directive reaches the worker** (`src/lets.ts`). Passed as context explicitly
marked *not* scope.

**4. Crew gets a wall clock** (`src/index.ts`, `src/crew-org.ts`). Two hours for
everything, 15 minutes reserved so waves cannot eat the integration step. A run that
cannot state its own end time is indistinguishable from one that has hung.

## Alternatives rejected

**Adopt dsh as the substrate.** Rejected on the three measurements above. This is
conditional, not absolute — see "what would change this".

**Hybrid: call dsh for specific capabilities.** Rejected because the capabilities worth
having operate on a session surface we own, and the only access path is spawning a second
whole runtime.

**Import ECC's rules wholesale into the prompt.** Rejected on arithmetic: 270KB per prompt.

**Adopt ECC's agents/commands/skills.** Rejected as duplicate surface. This plugin has its
own 16 agents and 28 commands with a deliberately pinned roster; a second overlapping set
is the "two ways to drive one loop" the README already refuses.

## Risks

- **The Ralph contract is unproven here.** It is built and unit-tested; no live run has
  used it yet. Its cost profile (a fresh worker per round) is strictly higher than a
  retry loop, and whether the structured handoff beats the current `feedback` string is
  an empirical question nobody has answered on this codebase.
- **ECC's rules are someone else's opinions.** Mitigated by subordination (`THE REPO
  WINS`), the budget, and evidence-gating — but a convention that contradicts local style
  in a way none of those catch will produce a confused diff.
- **The framework-evidence table is a heuristic** and will misclassify some repo. It fails
  closed, so the failure mode is a missing convention rather than a wrong one.
- **dsh may become the right answer later.** Nothing here forecloses that; the borrowed
  pieces are small and self-contained.

## What would change this

Four triggers, in decreasing likelihood:

1. **A cordis-free consumption path.** If dsh published compaction region selection, spill
   policy and the Ralph contract as plain libraries over a caller-owned message array,
   hybrid becomes cheap and should be taken.
2. **Version stability evidence.** A 1.0 with a semver policy, and a real commit history
   showing churn confined to `packages/client` rather than `packages/llm` and
   `packages/subagent`.
3. **A change in what this project is.** If it must leave opencode — standalone binary,
   durable multi-day sessions, persistence/replay, sandboxed execution — then
   reimplementing dsh's session log and process confinement natively is a multi-quarter
   project and adopting flips from "rewrite" to "a year of work for free".
4. **An out-of-process seam that fits.** A stable dsh subagent provider that could drive
   the 12 role-pinned models through the existing OpenCode server without a second runtime.

## Evidence

- `src/ralph.test.ts` — 23 tests over the contract, the loop and the rendering.
  Mutation-verified: removing the evidence requirement, or letting an invalid report
  become the handoff, each fails exactly its own test.
- `src/rules.test.ts` — including a test against the **real** ECC corpus, which is what
  caught both bugs a fixture would have missed: the glob that matched nothing, and
  React Native rules claiming every `.ts` file.
- `src/crew-org.test.ts` — the run budget must bound its own arithmetic worst case.
  Mutation-verified.
- Full suite: 423 pass, 0 fail; `tsc --noEmit` clean.

## Still open

Ranked, from the audits, not yet built:

1. **Token and cost accounting.** `askOnce` discards the provider's usage block; nothing
   can say what a run spent. This also blocks any evidence-based context decision.
2. **Session cleanup.** No `DELETE /session` anywhere; a crew run leaks hundreds.
3. **Repeat-tool guard** (~80 lines, from dsh `packages/guard`) — the cheapest ROI
   available, and it targets the `no-change` oscillation a live run already hit.
4. **Checkpoint granularity.** Crew checkpoints per task; the unit of work is an item, so
   a half-finished task can be resurrected and integrated as complete.
5. **Wiring the Ralph loop into a crew wave.** Built, not yet connected.
