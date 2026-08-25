# Council Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/council-*` into a colon-namespaced advisory body that puts every model on one question with debate, adds `council:task`, and replaces hardcoded model pins with measured, dynamically-recruited ones.

**Architecture:** Four independently shippable chunks against the existing plugin. Chunk 1 is a rename plus one call-site parameter. Chunk 2 corrects the roster (real model versions, capability classes, tiers, two new lanes). Chunk 3 adds `council:task` as a new engine function reusing `tally()`. Chunk 4 makes the roster dynamic — live catalog, measured capability cache, outage recruitment.

**Tech Stack:** TypeScript (no build step — node strips types), `node --test src/*.test.ts`, zod for tool args, the opencode server HTTP API.

**Spec:** `docs/superpowers/specs/2026-08-25-council-design.md` (rev 9)

**Baseline:** `npm test` → 150 tests, 150 pass. **Every commit in this plan must leave it green.**

**Ordering constraint:** Task 2.2 must precede Task 2.3 — `architect`'s carrier is `gpt56sol`, which only exists after the gpt-5.6 tier split.

---

## File Structure

| file | responsibility | chunk |
|---|---|---|
| `command/council:{review,fix,plan,independent,check,task,models}.md` | the seven entry points | 1, 3, 4 |
| `src/engine.ts` | `councilArgs`, `runTask`, `decideTask`, `scorersFor`, capability filters, tier-4 injection | 1, 2, 3, 4 |
| `src/roster.ts` | members, roles, routes, `capability`/`tier` and their filters, `KNOWN_ROLES` | 2, 4 |
| `src/schema.ts` | `TASK_PROPOSAL_SCHEMA`, `TASK_SCORE_SCHEMA` | 3 |
| `src/report.ts` | `renderTask`, `renderModelsProposal` | 3, 4 |
| `src/catalog.ts` | **new** — live catalog + measured capability cache + probe budget | 4 |
| `src/index.ts` | tool modes, dispatch, artifacts | 1, 3, 4 |
| `agent/council-{architect,infrastructure}.md` | **new** — the two new lane prompts | 2 |
| `src/{index,roster,crew,failover,task,catalog}.test.ts` | tests, matching `npm test`'s `src/*.test.ts` glob | all |

---

## Chunk 1: Rename to the colon namespace, full panel, debate on

Spec §3.1–§3.3. Ships: every council command under `/council:*`, review running the full
panel with 2 debate rounds, crew keeping glob routing and 0 rounds.

### Task 1.1: The rename, guarded

**Files:**
- Rename: the five `command/*.md`
- Modify: `command/council:check.md`, `command/council:fix.md`, `src/index.ts:355`, `README.md`
- Test: `src/index.test.ts`

- [ ] **Step 1: Add the imports the test needs**

`src/index.test.ts` currently imports only `mkdtempSync, rmSync, existsSync` from `node:fs`.
Add `readFileSync, readdirSync`:

```ts
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs"
```

- [ ] **Step 2: Write the failing test**

```ts
test("no live file still refers to a pre-colon council name", () => {
  // The likely failure of a rename is a dangling cross-reference, not a missing file.
  //
  // Two exclusions, both load-bearing. Match the five exact names and never the bare
  // `/council-` prefix: that also hits the legitimate "/council-work" message below, the
  // 12 agent/council-*.md files, and the `council-${role}` literals in engine.ts. And skip
  // *.test.ts: this very file must contain the old names to search for them, so scanning
  // itself would make the test permanently red.
  const OLD = ["/council-review", "/council-fix", "/council-plan", "/council-independent", "/check"]
  const files = [
    ...readdirSync(join(PKG, "command")).map((f) => `command/${f}`),
    ...readdirSync(join(PKG, "src")).map((f) => `src/${f}`),
    "README.md",
  ].filter((f) => /\.(md|ts)$/.test(f) && !f.endsWith(".test.ts"))

  const offenders: string[] = []
  for (const rel of files) {
    const text = readFileSync(join(PKG, rel), "utf8")
    for (const name of OLD) {
      // (?![\w-]) so /checkout and /check-in are left alone; end-of-line counts as a match.
      if (new RegExp(`${name.replace("/", "\\/")}(?![\\w-])`).test(text)) offenders.push(`${rel} → ${name}`)
    }
  }
  assert.deepEqual(offenders, [], `stale command references:\n${offenders.join("\n")}`)
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npm test 2>&1 | grep -A6 "pre-colon"`
Expected: FAIL listing `command/check.md`, `command/council-fix.md`, `src/index.ts`, `README.md`.

- [ ] **Step 4: Rename the five files**

```bash
cd /root/code/opencode-council
git mv command/council-review.md      'command/council:review.md'
git mv command/council-fix.md         'command/council:fix.md'
git mv command/council-plan.md        'command/council:plan.md'
git mv command/council-independent.md 'command/council:independent.md'
git mv command/check.md               'command/council:check.md'
```

- [ ] **Step 5: Rewrite every cross-reference**

`/check` needs two expressions. `README.md:76` is a fenced code block containing exactly
`/check` with nothing after it, so a pattern requiring a following character silently skips
it and Step 6 would fail:

```bash
cd /root/code/opencode-council
for f in command/*.md src/index.ts README.md; do
  sed -i 's|/council-review|/council:review|g
          s|/council-fix|/council:fix|g
          s|/council-plan|/council:plan|g
          s|/council-independent|/council:independent|g
          s|/check\([^-A-Za-z0-9_]\)|/council:check\1|g
          s|/check$|/council:check|g' "$f"
done
```

- [ ] **Step 6: Verify nothing was mangled**

```bash
grep -rn '/council:check[-_A-Za-z0-9]' command/ src/ README.md || echo "no mangling"
grep -rn '/checkout\|/check-in' command/ src/ README.md || echo "no bare survivors needed"
```
Expected: `no mangling`. Then read `command/council:check.md` and confirm its "Consistency
contract" section still reads correctly.

- [ ] **Step 7: Run the suite**

Run: `npm test 2>&1 | tail -5`
Expected: 151 pass, 0 fail.

- [ ] **Step 8: Update the human's stopgap outside the repo**

```bash
sed -i 's|/council-plan|/council:plan|g; s|/council-review|/council:review|g' \
  ~/.config/opencode/command/workflow.md
grep -n 'council' ~/.config/opencode/command/workflow.md
```

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "refactor(council): colon namespace, one name per command"
```

### Task 1.2: Commands register under the new names

**Files:**
- Test: `src/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("every council command registers under its colon name", async () => {
  // The mirror of Task 1.1's negative grep: that one proves no stale name survives, this
  // proves the new ones actually load. index.test.ts:65-73 already does exactly this for
  // crew. A command file whose name is wrong is silently absent, never an error.
  //
  // `load()` (index.test.ts:17) is async; the callback must be too, or `{config}` comes off
  // a Promise as undefined.
  const { config } = await load()
  for (const c of ["council:review", "council:fix", "council:plan", "council:independent", "council:check"])
    assert.ok(config.command[c]?.template?.length > 100, `command ${c} missing or empty`)
})
```

Reuse `load()` at `index.test.ts:17` rather than adding a second helper.

- [ ] **Step 2: Run** — Expected: PASS immediately (Task 1.1 already did the renames). This
  test is a regression guard, not a driver; note that in the commit message.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "test(council): guard colon-name command registration"
```

### Task 1.3: `councilArgs` — the full panel and the rounds split

**Files:**
- Modify: `src/engine.ts` (new export), `src/index.ts` (the `runReview` call, ~line 454)
- Test: `src/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("council reviews the whole panel with debate; crew keeps routing and 0 rounds", async () => {
  // The real call sites need a live fan-out and this suite mocks nothing
  // (tool.test.ts:14 - "Only paths that return BEFORE any model call are exercised here"),
  // so the values are asserted through the pure seam index.ts reads, plus source text for
  // the crew side.
  const { councilArgs } = await import("./engine.ts")
  const { ALL_ROLES } = await import("./roster.ts")
  assert.deepEqual(councilArgs().roles, ALL_ROLES, "council must wake every lane")
  assert.equal(councilArgs().maxRounds, 2, "council must debate")

  const engine = readFileSync(join(PKG, "src/engine.ts"), "utf8")
  assert.match(engine, /DEFAULT_MAX_ROUNDS = 0/, "crew inherits this default; it must stay 0")

  const crew = readFileSync(join(PKG, "src/crew.ts"), "utf8")
  const call = crew.slice(crew.indexOf("runReview(ctx, {"), crew.indexOf("runReview(ctx, {") + 200)
  assert.doesNotMatch(call, /maxRounds|roles:/,
    "crew's review must inherit both defaults, or every crew run costs a council run")
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test 2>&1 | grep -A6 "whole panel"`
Expected: FAIL — `councilArgs` is not exported.

- [ ] **Step 3: Implement**

In `src/engine.ts`, beside `DEFAULT_MAX_ROUNDS`:

```ts
/**
 * What `council:review` asks the engine for, as data rather than inline literals.
 *
 * Routing is a cost control that is right for crew and wrong for "my council", and the
 * rounds split MUST live at the call site: crew.ts calls runReview with neither argument,
 * so raising DEFAULT_MAX_ROUNDS would silently give every crew branch-review two debate
 * rounds.
 *
 * `council:task` is deliberately absent. runTask takes {goal, context} and has no lanes -
 * it reaches every model by proposing from every schema-capable member instead. Passing it
 * these values would hand it arguments it cannot accept.
 */
export function councilArgs(): { roles: Role[]; maxRounds: number } {
  return { roles: ALL_ROLES, maxRounds: 2 }
}
```

- [ ] **Step 4: Read it at the call site**

In `src/index.ts`, spread `councilArgs()` into the `runReview` input beside
`diff`/`files`/`changedLines`.

- [ ] **Step 5: Run** — Expected: 153 pass, 0 fail.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(council): full panel and debate rounds, split from crew at the call site"
```

### Task 1.4: Prove the debate loop and its report actually run

**Files:**
- Test: `src/report.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { renderReport } from "./report.ts"

// renderReport(review, meta) takes TWO arguments and dereferences meta.files.length and
// meta.ms (report.ts:22,34). It also destructures kept/nodes/dropped/disputed and spreads
// `kept` immediately, so `as any` on a partial object throws rather than degrading.
const reviewFixture = (over: Record<string, unknown> = {}) => ({
  verdictCounts: { blockers: 0, suggestions: 0, nits: 0 },
  kept: [], nodes: [], dropped: [], disputed: [], substituted: [],
  debate: [], convergence: "no disputes",
  ...over,
}) as any

test("a debate round that moves a position is reported as having moved it", () => {
  // The loop has never executed with maxRounds > 0. Asserting on a live review would be
  // non-deterministic - converged() returns done immediately when there are no disputes,
  // so a small diff plausibly yields 0 rounds and would 'pass' having proven nothing.
  const out = renderReport(reviewFixture({
    debate: [{ round: 1, revisions: [
      { model: "opus5", tier: "SUGGESTION", changed: true },
      { model: "fable", tier: "BLOCKER", changed: false },
    ] }],
    convergence: "no tier moved",
  }), { files: ["x.ts"], ms: 1234 })

  assert.match(out, /## Convergence/)
  assert.match(out, /Round 1/)
  assert.match(out, /1 changed position/)
  assert.match(out, /opus5→SUGGESTION/)
})
```

- [ ] **Step 2: Run** — Expected: PASS (`report.ts:92-103` already renders this). It has
  never been exercised; this pins it before Chunk 3 touches the report module.

- [ ] **Step 3: Live smoke, recorded not asserted**

```bash
cd /root/code/opencode-council
node --input-type=module -e '
import { runReview } from "./src/engine.ts"
const ctx = { serverUrl: "http://127.0.0.1:4096",
  auth: "Basic " + Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64") }
const diff = `--- a/x.ts\n+++ b/x.ts\n@@\n+export function run(cmd){ return require("child_process").execSync(cmd) }\n`
const r = await runReview(ctx, { diff, files: ["x.ts"], maxRounds: 2, roles: ["security","reviewer","pragmatist"] })
console.log("rounds:", r.debate.length, "| convergence:", r.convergence)
for (const d of r.debate) console.log(" round", d.round, "changed:", d.revisions.filter(v=>v.changed).length)
'
```

Record the output in the commit message. If rounds is 0 on a deliberately contentious diff,
that is itself the measurement §3.3 wants — debate that never fires is debate to retire.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test(council): pin the convergence report before task work touches it"
```

---

## Chunk 2: The roster gets right — models, tiers, capability, two new lanes

Spec §3.5, §3.6, §3.7.5. Each task commits green on its own — Task 2.1 carries both the
capability field *and* the agentic-only members that make its tests satisfiable, so it does
not depend on 2.2.

### Task 2.1: Capability, tiers, and the current models

**Files:**
- Modify: `src/roster.ts`, `src/crew.ts` (re-export `KNOWN_ROLES`), `src/failover.test.ts`, `src/report.test.ts`
- Test: `src/roster.test.ts`

- [ ] **Step 1: Add imports to `src/roster.test.ts`**

```ts
import { ROSTER, ALL_ROLES, KNOWN_ROLES, canSchema, selectNodes, selectRoles, skepticPool } from "./roster.ts"
```

`KNOWN_ROLES` moves from `crew.ts:38` to `roster.ts` in Step 3, with `crew.ts` re-exporting
it. Importing it from `crew.ts` would pull that ~2000-line module into the roster suite.

- [ ] **Step 2: Write the failing tests**

```ts
test("a model that cannot emit structured output never reaches a schema lane", () => {
  // deepseek and muse-spark-free both 400 on a *named* tool_choice while driving tools
  // fine under `auto`. That boundary is exactly implementer vs council lane.
  const agenticOnly = ROSTER.filter((m) => !canSchema(m))
  assert.ok(agenticOnly.length, "fixture: the roster must contain an agentic-only member")
  const banned = new Set(agenticOnly.map((m) => m.slug))
  for (const n of selectNodes(ALL_ROLES)) assert.ok(!banned.has(n.slug), `${n.slug} in a lane`)
  for (const m of skepticPool([], 99)) assert.ok(!banned.has(m.slug), `${m.slug} as a skeptic`)
})

test("every schema-capable member gets at least one node in a full panel", () => {
  // The roster invariant that replaced the rejected `everyModel` option: "all models on one
  // task" must be true by construction, and fail loudly if a roster edit breaks it.
  const covered = new Set(selectNodes(ALL_ROLES).map((n) => n.slug))
  for (const m of ROSTER.filter(canSchema))
    assert.ok(covered.has(m.slug), `${m.slug} is in the roster but answers nothing`)
})
```

- [ ] **Step 3: Implement the fields, the filters, and the members**

In `src/roster.ts`:

```ts
export type Member = {
  slug: string
  model: string
  roles: Role[]
  ms: number
  free?: boolean
  /**
   * Measured, never read off a catalogue flag.
   * `schema`: forced-tool-call structured output - every council lane needs it.
   * `agentic`: drives tools in a session - the implementer needs it.
   * Two members now fail the first while passing the second, and their 400s name the
   * cause: only `tool_choice: "auto"` is supported.
   */
  capability?: ("schema" | "agentic")[]
  /**
   * The vendor's own capability/cost class. NEVER derived from `ms`: that is latency on a
   * trivial call, and Luna - the tier built for speed - measured SLOWEST of the gpt-5.6
   * three. Latency ranks queue noise, not capability.
   */
  tier?: "deep" | "standard" | "fast"
}

export const canSchema = (m: Member) => (m.capability ?? ["schema"]).includes("schema")
export const canAgentic = (m: Member) => (m.capability ?? ["schema"]).includes("agentic")

/** Every role a repo's crew block may legally name. Lives here, not in crew.ts, so the
 *  roster suite can assert on it without importing a 2000-line module.
 *  MUST be placed textually AFTER `ALL_ROLES` (roster.ts:59) - it reads it at module init,
 *  and a const cannot be read before its declaration. */
export const KNOWN_ROLES: string[] = [...ALL_ROLES, "skeptic"]
```

Filter with `canSchema` at **all four** schema-passing sites — `selectNodes`' candidate
list, `skepticPool`, `substitutesFor` (`engine.ts:400`), and `runPlan`'s proposer pick
(`engine.ts:978`). `substitutesFor` is not optional: its tier 2 is
`usable.filter(!inRound).filter(byRole(false))`, and `byRole(false)` is
`m.roles.includes(node.role) === false` — **true for every role when `roles: []`**. Without
the filter, deepseek is offered as a substitute for every failed lane and then handed
`FINDINGS_SCHEMA`. `roles: []` is defence in depth only where selection is *positive*.

In `crew.ts`, replace the definition with **an import plus a re-export**:

```ts
import { KNOWN_ROLES } from "./roster.ts"
export { KNOWN_ROLES }
```

`export { X } from "./y.ts"` alone would **not** create a local binding, and `crew.ts:123`
reads `KNOWN_ROLES` inside `parseCrewBlock` - node strips types without checking, so that
would be a runtime ReferenceError the first time any crew block is parsed.

Roster members, all measured 2026-08-25 against the live server:

```ts
// openai's three are TIERS, not variants - peak / balanced / fast.
{ slug: "gpt56sol",   model: "openai/gpt-5.6-sol",   roles: ["security","systems"],
  ms: 3696, tier: "deep",     capability: ["schema","agentic"] },
{ slug: "gpt56terra", model: "openai/gpt-5.6-terra", roles: ["product","reviewer","docs"],
  ms: 2664, tier: "standard", capability: ["schema","agentic"] },
// carries `skeptic` on purpose: skepticPool filters on that role, so without it the fast
// tier is unreachable from the highest-volume loop in the system (Task 4.3).
{ slug: "gpt56luna",  model: "openai/gpt-5.6-luna",  roles: ["reviewer","qa","skeptic"],
  ms: 4228, tier: "fast",     capability: ["schema","agentic"] },
{ slug: "glm53", model: "zai-coding-plan/glm-5.3", roles: ["systems","reviewer"],
  ms: 6007, capability: ["schema","agentic"] },
{ slug: "hy3",   model: "opencode-go/hy3",         roles: ["qa","ops"], ms: 6117 },
// Implementer class: drives tools, refuses a named schema call.
{ slug: "deepseek", model: "deepseek/deepseek-v4-pro", roles: [], ms: 9459, capability: ["agentic"] },
```

**Give `nemoultra` the `breadth` role**: `["reviewer","systems","breadth"]`. Without this
the roster invariant test in Step 2 cannot pass — re-derived against this roster, nemoultra
loses `systems` to glm53 (6007) and grok45 (7146) and `reviewer` to gpt56luna (4228) and
minimax (4532), leaving it with no node at all. `breadth` is free to give precisely because
`musespark` vacates it below, and a wide-angle lane suits the largest free model on the
roster.

Also: give `opus5` `capability: ["schema","agentic"]` (already a live crew implementer), and
set `musespark` to `capability: ["agentic"]` with `roles: []` — `README.md:392` already
records it as chatting but emitting no structured output, and its 400 names the same
`tool_choice: auto` cause as deepseek. Remove `gpt55` and `glm52`. **Keep `gemini36`** —
`gemini-3.7-flash` times out at 90s. Append `deepseek`; never index 0, because
`engine.ts:799` falls back to `ROSTER[0].model` and then passes `PATCH_SCHEMA`.

- [ ] **Step 4: Update the fixtures that name removed slugs**

`src/failover.test.ts:40,43` hardcode `gpt55` → `gpt56terra`.
`src/report.test.ts:16,25` hardcode `"gpt55"` / `"openai/gpt-5.5"` — inert fixture strings,
but update them so the suite does not describe a model that no longer exists.

- [ ] **Step 5: Run** — Expected: all green, including both new tests.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(roster): measured capability and tiers; current models

gpt-5.6 arrives as three tiers (sol/terra/luna) rather than one pin, glm-5.3
supersedes 5.2, hy3 moves to the paid route that actually emits schema, and
deepseek joins as implementer-class. gemini stays at 3.6: 3.7 times out at 90s."
```

### Task 2.2: `architect` and `infrastructure`

**Files:**
- Modify: `src/roster.ts`, `src/roster.test.ts`, `src/crew.test.ts`
- Create: `agent/council-architect.md`, `agent/council-infrastructure.md`

- [ ] **Step 1: Extend the existing role-coverage test — do not add a parallel one**

`roster.test.ts:69-73` hardcodes an 11-role list. Rewrite it to derive from `KNOWN_ROLES`,
which is `[...ALL_ROLES, "skeptic"]`. Deriving from `ALL_ROLES` alone would silently delete
the only assertion that anyone carries `skeptic`, which `skepticPool`, `verifyGroup` and
`fixOne`'s verifier all depend on:

```ts
test("every role a config may name is answerable by some model", () => {
  for (const role of KNOWN_ROLES) {
    const carriers = ROSTER.filter((m) => m.roles.includes(role as any) && canSchema(m))
    assert.ok(carriers.length, `no schema-capable model carries '${role}' — a silent empty lane`)
  }
})
```

- [ ] **Step 2: Write the routing test**

```ts
test("a terraform diff wakes infrastructure without costing more nodes", () => {
  const roles = selectRoles(["envs/prod/main.tf"])
  assert.ok(roles.includes("infrastructure"), "the specific role must win over generic ops")
  assert.ok(!roles.includes("ops"), "infrastructure REPLACES ops here; it does not add to it")
  assert.equal(selectNodes(roles).length, 7, "node count must stay flat")
})
```

- [ ] **Step 3: Run and watch both fail**

Run: `npm test 2>&1 | grep -A4 "answerable by some model\|terraform diff"`
Expected: FAIL — neither role exists.

- [ ] **Step 4: Add the roles**

Extend the `Role` union with `"architect" | "infrastructure"` and add both to `ALL_ROLES`.
**Append** to carriers, never prepend — `roles[0]` selects the agent voice for `runTask`
proposers in Chunk 3:

- `architect` → append to `opus5`, `gpt56sol`
- `infrastructure` → append to `glm53`, `grok45`

`ROUTES`: swap `ops` → `infrastructure` on the
`**/{Dockerfile,docker-compose*,Makefile,*.tf}` row, and add
`**/*.tfvars`, `**/k8s/**`, `**/{terraform,infra,infrastructure}/**` →
`["infrastructure","security"]`. Leave `.github/workflows`, `*.{yml,yaml,…}` and `.env*` on
`ops` — CI and runtime config are ops. Keep the `**/` prefix: a bare `*.tf` will not match
`envs/prod/main.tf`.

- [ ] **Step 5: Write the two agent files**

`agent/council-architect.md` — boundaries, sequencing, what *not* to build, the cost of a
wrong seam. `agent/council-infrastructure.md` — Terraform/cloud/network/IAM, blast radius,
what is irreversible. Frontmatter is `description` + `mode: all` only; both must inherit
`edit: deny` / `bash: deny`, which `index.test.ts:50-54` asserts for every agent but
`crew-dev`.

- [ ] **Step 6: Guard the crew-config widening**

In `src/crew.test.ts`, beside the `lanes: coed` rejection at `:615`:

```ts
test("a widened role set accepts the new lanes and still rejects typos", () => {
  // KNOWN_ROLES gained two entries, so `lanes: architect` becomes newly legal. Existing
  // configs must stay valid and a typo must stay fatal.
  assert.ok(parseCrewBlock("```crew\nverify: t\nbase: main\nlanes: architect, reviewer\n```")?.lanes)
  assert.equal(parseCrewBlock("```crew\nverify: t\nbase: main\nlanes: coed\n```"), undefined)
})
```

- [ ] **Step 7: Run** — Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(council): architect and infrastructure lanes"
```

---

## Chunk 3: `council:task`

Spec §3.4. Ships: hand the council a task, get one answer with its dissent intact.

### Task 3.1: `scorersFor` — the assignment rule, pure

**Files:**
- Modify: `src/engine.ts`
- Create: `src/task.test.ts`

- [ ] **Step 1: Create `src/task.test.ts` with its imports**

```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { scorersFor } from "./engine.ts"
```

- [ ] **Step 2: Write the failing test**

```ts
test("scorer assignment is deterministic, never self, and survives a thin panel", () => {
  const p = (n: number) => Array.from({ length: n }, (_, i) => ({ slug: `m${i}` }))
  for (const n of [1, 2, 3, 4, 16]) {
    const map = scorersFor(p(n))
    if (n === 1) { assert.equal(map.get("m0")!.length, 0, "one proposal has no scorer"); continue }
    for (const [proposal, scorers] of map) {
      assert.equal(scorers.length, Math.min(3, n - 1), `k = min(3, N-1) at N=${n}`)
      assert.ok(!scorers.includes(proposal), "a model never scores its own answer")
      assert.equal(new Set(scorers).size, scorers.length, "no scorer twice")
    }
  }
  assert.deepEqual(scorersFor(p(16)), scorersFor(p(16)), "same input, same assignment")
})
```

- [ ] **Step 3: Run and watch it fail** — `scorersFor` is not defined.

- [ ] **Step 4: Implement**

```ts
/**
 * Who scores whom. Cyclic-next over roster order, so it is reproducible and no model ever
 * scores itself (k <= N-1 guarantees it). All-pairs would be 240 calls at N=16; this is 48.
 * Keyed by proposal slug -> the slugs that score it.
 *
 * Takes `{slug}[]` rather than spec §3.4's `TaskProposal[]` on purpose: the rule needs
 * nothing else, and the looser type lets the test fixture be two fields instead of eight.
 */
export function scorersFor(live: { slug: string }[]): Map<string, string[]> {
  const n = live.length
  const k = Math.max(Math.min(3, n - 1), 0)
  return new Map(live.map((p, i) => [
    p.slug,
    Array.from({ length: k }, (_, j) => live[(i + 1 + j) % n].slug),
  ]))
}
```

- [ ] **Step 5: Run** — PASS. **Step 6: Commit**

```bash
git add -A && git commit -m "feat(council): deterministic scorer assignment for council:task"
```

### Task 3.2: The task schemas

**Files:**
- Modify: `src/schema.ts`
- Test: `src/task.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("the task score keeps Score's four dimensions so tally() stays usable", () => {
  // A 1-10 scalar would make tally()'s four-term sum NaN; NaN compares falsy, so its sort
  // falls through to alphabetical-by-slug and still reports a confident winner. That is a
  // false consensus - precisely what council:task exists to prevent.
  const props = TASK_SCORE_SCHEMA.properties
  for (const dim of ["correctness", "simplicity", "risk", "completeness"])
    assert.ok(props[dim], `tally() sums ${dim}; the task score must carry it`)
  assert.ok(props.objection, "dissent needs its own field: `reason` is praise when the score is high")
  assert.ok(TASK_PROPOSAL_SCHEMA.properties.confidence, "confidence is printed beside each answer")
})
```

- [ ] **Step 2: Run and watch it fail. Step 3: Add both schemas**

In `src/schema.ts`, mirroring `SCORE_SCHEMA`'s four 1–5 dimensions plus `reason`, and adding
`objection` (`""` when the scorer has none). `TASK_PROPOSAL_SCHEMA` is
`{answer, reasoning, confidence}` with `confidence` an enum of `high|medium|low`. Leave
`PROPOSAL_SCHEMA`/`SCORE_SCHEMA` untouched so `/council:plan` is unaffected.

- [ ] **Step 4: Run** — PASS. **Step 5: Commit**

```bash
git add -A && git commit -m "feat(council): task proposal and score schemas"
```

### Task 3.3: `decideTask` — the three terminal states

**Files:**
- Modify: `src/engine.ts`
- Test: `src/task.test.ts`

- [ ] **Step 1: Add the shared fixtures to `src/task.test.ts`**

These carry the semantics of every assertion below, so they are defined once, explicitly:

```ts
import { decideTask, type TaskProposal, type TaskScore } from "./engine.ts"

const prop = (slug: string): TaskProposal => ({
  slug, role: "reviewer", model: `test/${slug}`,
  answer: `answer from ${slug}`, reasoning: "because", confidence: "medium", state: "ok",
})
const fixtureProposals = (n: number) => Array.from({ length: n }, (_, i) => prop(`m${i}`))

/** Four dimensions, exactly as `Score` - tally() sums these and nothing else. */
const score = (proposal: string, scorer: string, v: number, objection = ""): TaskScore =>
  ({ proposal, scorer, correctness: v, simplicity: v, risk: v, completeness: v,
     reason: "fixture", objection })

/** Everyone scores 2s except `favoured`, who scores 5s. */
const fixtureScoresFavouring = (favoured: string, props = fixtureProposals(3)) =>
  props.flatMap((p) => props.filter((q) => q.slug !== p.slug)
    .map((q) => score(p.slug, q.slug, p.slug === favoured ? 5 : 2)))

/** Identical scores => identical means => inside TIE_MARGIN. */
const fixtureScoresTied = (props = fixtureProposals(2)) =>
  props.flatMap((p) => props.filter((q) => q.slug !== p.slug).map((q) => score(p.slug, q.slug, 4)))

/** m0 and m1 are scored; m2 answered but every scorer call for it failed. */
const fixtureOrphanedAnswer = () => {
  const props = fixtureProposals(3)
  const scores = ["m0", "m1"].flatMap((s) =>
    props.filter((q) => q.slug !== s).map((q) => score(s, q.slug, 3)))
  return decideTask(props, scores)
}

const fixtureWithObjection = (text: string) =>
  decideTask(fixtureProposals(2), [score("m0", "m1", 5, text), score("m1", "m0", 2, "")])
```

- [ ] **Step 2: Write the failing tests**

```ts
test("the winner is the highest mean, not the alphabetically first", () => {
  // Guards the NaN-sort failure directly: the LAST proposal by slug gets the best scores.
  const r = decideTask(fixtureProposals(3), fixtureScoresFavouring("m2"))
  assert.equal(r.winner?.slug, "m2")
  assert.equal(r.unscored, false)
})

test("a tie is reported as a tie, never resolved into a winner", () => {
  const r = decideTask(fixtureProposals(2), fixtureScoresTied())
  assert.equal(r.winner, null)
  assert.equal(r.tied.length, 2)
  assert.equal(r.runnerUp, null)
})

test("live answers with no usable score are unranked, not tied", () => {
  // tally([]) returns {ranked:[],winner:null,tied:[]}, indistinguishable from a tie.
  // Without this branch the report claims "did not converge" over an empty list while
  // three real answers exist.
  const r = decideTask(fixtureProposals(3), [])
  assert.equal(r.unscored, true)
  assert.equal(r.tied.length, 0)
  assert.equal(r.proposals.filter((p) => p.state === "ok").length, 3)
})
```

- [ ] **Step 3: Run and watch them fail. Step 4: Implement `decideTask`**

Pure, holding the whole state machine, so none of the above needs a server:

| state | when | `winner` | `tied` | `runnerUp` | `unscored` |
|---|---|---|---|---|---|
| decided | `tally()` names a winner | that one | `[]` | `ranked[1] ?? null` | `false` |
| tied | winner null, `tied` non-empty | `null` | all tied | `null` | `false` |
| unranked | no usable score at all | `null` | `[]` | `null` | `true` |

- [ ] **Step 5: Run** — PASS. **Step 6: Commit**

```bash
git add -A && git commit -m "feat(council): decideTask with an exhaustive terminal-state machine"
```

### Task 3.4: `renderTask`

**Files:**
- Modify: `src/report.ts`
- Test: `src/task.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test("no live answer disappears from the report", () => {
  // tally() ranks only what it received scores for, so a proposal whose scorers all failed
  // is in ranked/winner/tied/runnerUp nowhere - and `unscored` is false, so the unranked
  // path never fires. Without an explicit section it vanishes while the report looks clean.
  const out = renderTask(fixtureOrphanedAnswer())
  assert.match(out, /answered, but unscored/i)
  assert.match(out, /answer from m2/, "the orphaned answer must still be printed")
})

test("dissent survives into the report verbatim", () => {
  const out = renderTask(fixtureWithObjection("this ignores the retry budget"))
  assert.match(out, /this ignores the retry budget/)
})
```

- [ ] **Step 2: Run and watch it fail. Step 3: Implement `renderTask`**

Prints, in order: the answer (or the tied answers, or all answers unranked) with each one's
`confidence`; the ranked means; the runner-up; every objection verbatim; and finally
**"answered, but unscored"** listing each `state === "ok"` proposal absent from `ranked`.

- [ ] **Step 4: Run** — PASS. **Step 5: Commit**

```bash
git add -A && git commit -m "feat(council): renderTask - dissent verbatim, no answer dropped"
```

### Task 3.5: `runTask`, the tool mode, and the commands

**Files:**
- Modify: `src/engine.ts`, `src/index.ts`, `command/council:independent.md`
- Create: `command/council:task.md`
- Test: `src/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("the council tool accepts task mode and a context argument", async () => {
  const { tool } = await load()
  assert.ok(tool.council.args.mode.safeParse("task").success, "mode enum must accept 'task'")
  assert.ok(tool.council.args.context, "context is a new arg, used by task and independent")
})
```

- [ ] **Step 2: Run and watch it fail. Step 3: Implement `runTask`**

I/O only — the decision logic is already `decideTask`. Fan out proposals to every
`canSchema` member under `agent: council-${member.roles[0]}`; filter to live; `scorersFor`;
fan out scores, preferring a `fast`-tier member as scorer (Task 4.3 makes this pay); call
`decideTask`.

- [ ] **Step 4: Wire the tool and commands**

`src/index.ts`: add `"task"` to the zod `mode` enum **and** to the inline `args:` TS union
(~line 369); add `context` as a new zod field (today's schema is `{mode, base, goal}`);
dispatch `runTask`; write the artifact to `council-artifacts/<stamp>-task/`. While the
schema is open, pass `context` to `runIndependent` too — it has accepted one since
`engine.ts:878` and has never been given it.

`command/council:task.md`: hand the council a task, get one answer with dissent. Then edit
`command/council:independent.md` — its closing paragraph still steers "one answer rather
than several" to `mode: "plan"`, which is stale once this exists.

- [ ] **Step 5: Run** — PASS. **Step 6: Commit**

```bash
git add -A && git commit -m "feat(council): /council:task - one answer, dissent intact"
```

---

## Chunk 4: The dynamic roster

Spec §3.7. Ships: live catalog, measured capability cache, recruitment beyond the roster,
tier routing on the high-volume loops, and `/council:models`.

### Task 4.1: The catalog and the capability cache

**Files:**
- Create: `src/catalog.ts`, `src/catalog.test.ts`

- [ ] **Step 1: Create `src/catalog.test.ts` with its imports**

```ts
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openCache, probeBudget, parseCatalog } from "./catalog.ts"
```

- [ ] **Step 2: Write the failing tests**

```ts
test("the catalog flattens providers into provider/model ids", () => {
  // Verified shape from GET /config/providers on 2026-08-25: 9 providers, ~114 models.
  const ids = parseCatalog({ providers: [
    { id: "openai", models: { "gpt-5.6-sol": {}, "gpt-5.6-luna": {} } },
    { id: "anthropic", models: { "claude-opus-5": {} } },
  ] })
  assert.deepEqual(ids.sort(), ["anthropic/claude-opus-5", "openai/gpt-5.6-luna", "openai/gpt-5.6-sol"])
})

test("the cache round-trips and a contradicting failure invalidates it", () => {
  const dir = mkdtempSync(join(tmpdir(), "cap-"))
  try {
    const path = join(dir, "capability.json")
    const c = openCache(path)
    c.record("x/y", "schema", { ok: true, ms: 1200 })
    assert.equal(openCache(path).get("x/y", "schema")?.ok, true, "must survive a reopen")
    c.contradict("x/y", "schema")   // a malformed/failed call says otherwise
    assert.equal(c.get("x/y", "schema"), undefined, "a stale 'works' must not keep routing lanes")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a failed probe is remembered, so a dead model costs one probe not one per run", () => {
  const dir = mkdtempSync(join(tmpdir(), "cap-"))
  try {
    const path = join(dir, "capability.json")
    openCache(path).record("dead/model", "schema", { ok: false, ms: 90000 })
    assert.equal(openCache(path).get("dead/model", "schema")?.ok, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("the probe budget caps a bad day at three", () => {
  const b = probeBudget(3)
  assert.deepEqual([b.take(), b.take(), b.take(), b.take()], [true, true, true, false])
})
```

- [ ] **Step 3: Run and watch them fail. Step 4: Implement `src/catalog.ts`**

Discovery and capability in one file because they answer one question — what can actually
be used right now:

- `parseCatalog(json)` → `provider/model` ids. Pure, so it is testable without a server.
- `catalog(ctx)` → `GET /config/providers` then `parseCatalog`, memoised per run.
- `openCache(path = ~/.cache/opencode-council/capability.json)` → `get`/`record`/
  `contradict`. `~/.cache` and never the repo: a teammate's quota is not a fact about the
  code.
- `probeBudget(n)` → `take()`.
- `probe(ctx, model, kind)` → the one-call smoke test, recorded in the cache.

- [ ] **Step 5: Run** — PASS. **Step 6: Commit**

```bash
git add -A && git commit -m "feat(council): live catalog and measured capability cache"
```

### Task 4.2: Outage recruitment beyond the roster

**Files:**
- Modify: `src/engine.ts` (`substitutesFor`)
- Test: `src/failover.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("an exhausted roster can recruit from the catalog, by injection", () => {
  // The pool is passed in, never fetched here: failover.test.ts:43 asserts a fully benched
  // roster returns [] (failover.test.ts:45-47). If this function fetched a catalogue, that assertion would depend on
  // live network state and the suite would pass or fail by weather.
  const everything: Bench = new Map(ROSTER.map((m) => [m.slug, "dead"]))
  assert.deepEqual(substitutesFor(codeNode, round, everything, new Set()), [],
    "with no pool offered, behaviour is exactly what it is today")

  // codeNode is kimik3 (failover.test.ts:11), so the FAMILY here is `kimi-for-coding`.
  // A sibling from another provider would never exercise the family rule.
  const sibling = { slug: "k3-sib", model: "kimi-for-coding/k3-256k", roles: ["code"], ms: 9999 } as any
  const far = { slug: "far", model: "other/model", roles: ["code"], ms: 100 } as any
  const subs = substitutesFor(codeNode, round, everything, new Set(), [far, sibling])
  assert.deepEqual(subs.map((m) => m.slug), ["k3-sib", "far"],
    "same provider family first, even though the stranger is 100x faster by ms")
})
```

- [ ] **Step 2: Run and watch it fail. Step 3: Add the injected fourth tier**

```ts
export function substitutesFor(
  node: Node, round: Node[], bench: Bench, tried: Set<string>, extra: Member[] = [],
): Member[]
```

Tiers 1–3 over `ROSTER` exactly as today, then `extra` under the same unavailable/tried
rules, ordered same-provider-family first (compare the segment before `/` against the failed
node's model), then by measured `ms`. The caller resolves catalog ∩ cache and passes it.

- [ ] **Step 4: Run** — PASS. **Step 5: Commit**

```bash
git add -A && git commit -m "feat(council): recruit substitutes from the live catalog"
```

### Task 4.3: Tier routing on the two high-volume loops

**Files:**
- Modify: `src/roster.ts` (`skepticPool`), `src/engine.ts` (`runTask` scorer choice)
- Test: `src/roster.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("volume loops rank the fast tier above a lower-ms member of another tier", () => {
  // Asserting `skepticPool([],3)[0].tier === "fast"` would be VACUOUS: gpt56luna is also
  // the lowest-ms skeptic carrier, so it already sorts first under today's ms-only rule and
  // the test would pass before the change exists and keep passing if the rule were removed.
  // Test the rule itself, with a fast member that is slow by ms.
  const members = [
    { slug: "quick", tier: "standard", ms: 10 },
    { slug: "fast-tier", tier: "fast", ms: 9000 },
  ] as any
  assert.equal(preferFast(members)[0].slug, "fast-tier",
    "tier is a measured capability class; ms is queue noise and must not outrank it")
})

test("the skeptic pool routes through it and still fills behind", () => {
  const pool = skepticPool([], 3)
  assert.equal(pool[0].tier, "fast")
  assert.ok(pool.length > 1, "the rest of the pool still fills behind the fast member")
})
```

- [ ] **Step 2: Run and watch the first fail** — `preferFast` does not exist. The second
  passes already; it is a regression guard, not a driver.

- [ ] **Step 3: Implement**

Add the rule as a pure, exported helper so it is testable on its own, then use it in both
places:

```ts
/** Fast tier first, then today's ms order. Used by the two high-volume, shallow loops. */
export const preferFast = <T extends { tier?: string; ms: number }>(ms: T[]): T[] =>
  [...ms].sort((a, b) => Number(b.tier === "fast") - Number(a.tier === "fast") || a.ms - b.ms)
```

`skepticPool` and `runTask`'s scorer selection both route through it. With no fast member
present it degrades to exactly today's ordering.

- [ ] **Step 4: Run** — PASS. **Step 5: Commit**

```bash
git add -A && git commit -m "feat(council): route the shallow high-volume loops to the fast tier"
```

### Task 4.4: `/council:models`

**Files:**
- Modify: `src/report.ts`, `src/index.ts`
- Create: `command/council:models.md`
- Test: `src/catalog.test.ts`, `src/index.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// catalog.test.ts - the renderer is pure, so no network and no live probes.
test("the models proposal names what changed and never claims to have applied it", () => {
  // gemini-3.7-flash times out at 90s while 3.6 answers in 9s. An auto-updater chasing
  // "latest" would have adopted it and quietly cost a lane, so this proposes only.
  const out = renderModelsProposal({
    roster: [{ slug: "gemini36", model: "google/gemini-3.6-flash" }] as any,
    catalog: ["google/gemini-3.6-flash", "google/gemini-3.7-flash"],
    probes: { "google/gemini-3.7-flash": { ok: false, ms: 90000 } },
  })
  assert.match(out, /gemini-3\.7-flash/)
  assert.match(out, /90000|90s|timed out/i, "the measurement must be shown, not hidden")
  assert.doesNotMatch(out, /\bapplied\b|\bupdated the roster\b/i)
})

// index.test.ts - registration only, no execution.
test("the council tool accepts models mode", async () => {
  const { tool } = await load()
  assert.ok(tool.council.args.mode.safeParse("models").success)
})
```

- [ ] **Step 2: Run and watch them fail. Step 3: Implement**

`renderModelsProposal({roster, catalog, probes})` in `report.ts`, pure. `src/index.ts` adds
`"models"` to the zod enum and the inline `args:` union; the mode fetches the catalog, diffs
against `ROSTER`, probes candidates within `probeBudget(3)`, and renders. **It writes
nothing.**

- [ ] **Step 4: Run** — PASS. **Step 5: Commit**

```bash
git add -A && git commit -m "feat(council): /council:models - discover and propose, never adopt"
```

---

## Chunk 5: Say what shipped

### Task 5.1: The ADR

**Files:**
- Create: `docs/adr/2026-08-25-council-namespace-and-dynamic-roster.md`

- [ ] **Step 1: Write it**

`docs/adr/` does not exist yet; this is the first entry and establishes the convention from
spec §1 (date-slug, never sequential numbers — `0007-` allocation races when parallel lets
write decisions). Record the decision, the alternatives rejected, and the **measurements it
rests on**, each with its date:

- gpt-5.6 arrives as three tiers, not variants; `ms` must never rank them
- `gemini-3.7-flash` times out at 90s where 3.6 answers in 9s — why adoption stays gated
- `opencode-go/hy3` emits schema at 6.1s where `opencode/hy3-free` fails 3/3 — route, not model
- deepseek and muse-spark both 400 with *only `tool_choice: auto` supported* — the capability class
- debate measured 0 changed positions before being disabled, and what turning it back on is expected to show

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "docs(adr): council namespace and dynamic roster"
```

### Task 5.2: README catches up

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update every stale claim**

- the roster table (`:382-383` name `gpt55`/`glm52`, `:393` the old hy3 route) → the current
  members with `tier` and `capability` columns
- the exclusion table (`:409`) → deepseek is implementer-class, not excluded; the
  `opencode-go` remedy it recommends is dead; muse-spark needs a data-collection opt-in
- `:392`'s musespark note → now a capability class, not a curiosity
- document `/council:task` and `/council:models`, and the colon rename
- state the cost plainly: a full-panel review is the most expensive path in the system

- [ ] **Step 2: Verify no stale command names survive**

Run: `npm test 2>&1 | grep -A6 "pre-colon"` → PASS.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "docs: README matches what shipped"
```

---

## Definition of done

- [ ] `npm test` green at **every** commit, not just the last
- [ ] `/council:{review,fix,plan,independent,check,task,models}` all register (needs a restart)
- [ ] A real `council:review` runs the full panel with debate, and the Convergence block reports what moved
- [ ] A real `council:task` returns one answer with dissent, or an honest tie
- [ ] `README.md` and the ADR match what actually shipped
