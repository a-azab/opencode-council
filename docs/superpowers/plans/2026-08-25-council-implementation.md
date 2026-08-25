# Council Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/council-*` into a colon-namespaced advisory body that puts every model on one question with debate, adds `council:task`, and replaces hardcoded model pins with measured, dynamically-recruited ones.

**Architecture:** Four independently shippable chunks against the existing plugin. Chunk 1 is a rename plus two call-site parameters. Chunk 2 corrects the roster (real model versions, capability classes, tiers, two new roles). Chunk 3 adds `council:task` as a new engine function reusing `tally()`. Chunk 4 makes the roster dynamic — live catalog, measured capability cache, outage recruitment.

**Tech Stack:** TypeScript (no build step — node strips types), `node --test`, zod for tool args, the opencode server HTTP API.

**Spec:** `docs/superpowers/specs/2026-08-25-council-design.md`

**Ordering note:** Chunk 2 runs before the role work inside it, because §3.5 assigns `architect` to `gpt56sol`, which only exists after the §3.7.5 tier split.

---

## File Structure

| file | responsibility | chunk |
|---|---|---|
| `command/council:{review,fix,plan,independent,check,task,models}.md` | the seven entry points | 1, 3, 4 |
| `src/engine.ts` | `councilArgs`, `runTask`, `scorersFor`, capability filters, tier-4 injection | 1, 2, 3, 4 |
| `src/roster.ts` | members, roles, routes, capability + tier fields and their filters | 2, 4 |
| `src/schema.ts` | `TASK_PROPOSAL_SCHEMA`, `TASK_SCORE_SCHEMA` | 3 |
| `src/report.ts` | `renderTask` | 3 |
| `src/catalog.ts` | **new** — live catalog + measured capability cache + probe budget | 4 |
| `src/index.ts` | tool modes, dispatch, artifacts | 1, 3, 4 |
| `agent/council-{architect,infrastructure}.md` | **new** — the two new lane prompts | 2 |
| `src/{index,roster,crew,task,catalog}.test.ts` | tests, colocated with `npm test`'s `src/*.test.ts` glob | all |

---

## Chunk 1: Rename to the colon namespace, full panel, debate on

Spec §3.1, §3.2, §3.3. Ships: every council command under `/council:*`, with review and task
running the full panel and 2 debate rounds, while crew keeps glob routing and 0 rounds.

### Task 1.1: The rename guard test

**Files:**
- Test: `src/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("no command still refers to a pre-colon council name", () => {
  // The likely failure of a rename is a dangling cross-reference, not a missing file.
  // Matching the five exact names, never the bare `/council-` prefix: that also matches
  // the legitimate "/council-work" message below, the 12 agent/council-*.md files, and
  // the `council-${role}` literals in engine.ts.
  const OLD = ["/council-review", "/council-fix", "/council-plan", "/council-independent", "/check"]
  const roots = ["command", "src", "README.md"]
  const offenders: string[] = []
  for (const root of roots) {
    const files = statSync(join(PKG, root)).isDirectory()
      ? readdirSync(join(PKG, root)).map((f) => join(root, f))
      : [root]
    for (const rel of files) {
      if (!/\.(md|ts)$/.test(rel)) continue
      const text = readFileSync(join(PKG, rel), "utf8")
      for (const name of OLD) {
        // `/checkout`, `/check-in` etc. must not trip it: require a non-word boundary.
        const re = new RegExp(`${name.replace("/", "\\/")}(?![\\w-])`)
        if (re.test(text)) offenders.push(`${rel} → ${name}`)
      }
    }
  }
  assert.deepEqual(offenders, [], `stale command references:\n${offenders.join("\n")}`)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test 2>&1 | grep -A5 "pre-colon"`
Expected: FAIL, listing `command/check.md`, `command/council-fix.md`, `src/index.ts`, `README.md`.

- [ ] **Step 3: Rename the five files**

```bash
cd /root/code/opencode-council
git mv command/council-review.md      'command/council:review.md'
git mv command/council-fix.md         'command/council:fix.md'
git mv command/council-plan.md        'command/council:plan.md'
git mv command/council-independent.md 'command/council:independent.md'
git mv command/check.md               'command/council:check.md'
```

- [ ] **Step 4: Fix every cross-reference**

```bash
cd /root/code/opencode-council
for f in command/*.md src/index.ts README.md; do
  sed -i 's|/council-review|/council:review|g; s|/council-fix|/council:fix|g;
          s|/council-plan|/council:plan|g; s|/council-independent|/council:independent|g;
          s|/check\([^-a-zA-Z]\)|/council:check\1|g' "$f"
done
```

Then read `command/council:check.md` and confirm its "Consistency contract" section still
reads correctly, and that no `/council:checkout`-style mangling occurred.

- [ ] **Step 5: Run the test**

Run: `npm test 2>&1 | tail -5`
Expected: PASS, and no other test regresses.

- [ ] **Step 6: Update the human's stopgap outside the repo**

```bash
sed -i 's|/council-plan|/council:plan|g; s|/council-review|/council:review|g' \
  ~/.config/opencode/command/workflow.md
grep -n 'council' ~/.config/opencode/command/workflow.md
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "refactor(council): colon namespace, one name per command"
```

### Task 1.2: `councilArgs` — the full panel and the rounds split

**Files:**
- Modify: `src/engine.ts` (new export), `src/index.ts:454`
- Test: `src/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("council runs the whole panel with debate; crew keeps routing and 0 rounds", async () => {
  // The real call sites need a live fan-out, and this suite mocks nothing (tool.test.ts:14
  // - "Only paths that return BEFORE any model call are exercised here"), so the values
  // are asserted through the pure seam that index.ts reads.
  const { councilArgs } = await import("./engine.ts")
  for (const mode of ["review", "task"] as const) {
    assert.deepEqual(councilArgs(mode).roles, ALL_ROLES, `${mode} must wake every lane`)
    assert.equal(councilArgs(mode).maxRounds, 2, `${mode} must debate`)
  }
  const engine = readFileSync(join(PKG, "src/engine.ts"), "utf8")
  assert.match(engine, /DEFAULT_MAX_ROUNDS = 0/, "crew inherits this; it must stay 0")
  const crew = readFileSync(join(PKG, "src/crew.ts"), "utf8")
  const call = crew.slice(crew.indexOf("runReview(ctx, {"))
  assert.doesNotMatch(call.slice(0, 200), /maxRounds|roles:/,
    "crew's review must inherit both defaults, or every crew run costs a council run")
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test 2>&1 | grep -A5 "whole panel"`
Expected: FAIL — `councilArgs` is not exported.

- [ ] **Step 3: Implement `councilArgs`**

In `src/engine.ts`, beside `DEFAULT_MAX_ROUNDS`:

```ts
/**
 * What a council command asks the engine for, as data rather than inline literals.
 *
 * Two reasons it is a function. Routing is a cost control that is right for crew and wrong
 * for "my council", and the rounds split must live at the call site: `crew.ts` calls
 * `runReview` with neither argument, so raising DEFAULT_MAX_ROUNDS would silently give
 * every crew branch-review two debate rounds.
 */
export function councilArgs(mode: "review" | "task"): { roles: Role[]; maxRounds: number } {
  return { roles: ALL_ROLES, maxRounds: 2 }
}
```

- [ ] **Step 4: Read it at the call site**

In `src/index.ts` (the `runReview` call, ~line 454), spread `councilArgs("review")` into the
input alongside `diff`/`files`/`changedLines`.

- [ ] **Step 5: Run the test**

Run: `npm test 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(council): full panel and debate rounds, split from crew at the call site"
```

### Task 1.3: Prove the Convergence block renders

**Files:** none — verification only.

- [ ] **Step 1: Run a small real review with rounds on**

```bash
cd /root/code/opencode-council
node --input-type=module -e '
import { runReview } from "./src/engine.ts"
const ctx = { serverUrl: "http://127.0.0.1:4096",
  auth: "Basic " + Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64") }
const diff = `--- a/x.ts\n+++ b/x.ts\n@@\n+export function f(a){ return eval(a) }\n`
const r = await runReview(ctx, { diff, files: ["x.ts"], maxRounds: 2, roles: ["security","reviewer"] })
console.log("rounds:", r.debate.length, "| convergence:", r.convergence)
'
```

Expected: `rounds:` ≥ 0 and a convergence reason. The debate loop has never run with
`maxRounds > 0`; this is the first execution of that path.

- [ ] **Step 2: Confirm the report prints it**

The `## Convergence` block is `report.ts:92-103` and already prints re-judgements and
changed positions. Render a report from the result above and confirm the block appears.

---

## Chunk 2: The roster gets right — models, tiers, capability, two new roles

Spec §3.5, §3.6, §3.7.5. Ships: real current models, the capability class that separates
implementers from lanes, tiers, and the `architect`/`infrastructure` lanes.

### Task 2.1: Capability and tier fields, with filters

**Files:**
- Modify: `src/roster.ts`
- Test: `src/roster.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("a model that cannot emit structured output never reaches a schema lane", () => {
  // deepseek and muse-spark-free both 400 on a *named* tool_choice while driving tools
  // fine under `auto`. That boundary is exactly implementer vs council lane.
  const agenticOnly = ROSTER.filter((m) => !(m.capability ?? ["schema"]).includes("schema"))
  assert.ok(agenticOnly.length, "fixture: the roster must contain an agentic-only member")
  const slugs = new Set(agenticOnly.map((m) => m.slug))
  for (const n of selectNodes(ALL_ROLES))
    assert.ok(!slugs.has(n.slug), `${n.slug} cannot answer a schema lane`)
  for (const m of skepticPool([], 99))
    assert.ok(!slugs.has(m.slug), `${m.slug} cannot answer a skeptic call`)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test 2>&1 | grep -A5 "structured output never"`
Expected: FAIL on the fixture assertion — no member has `capability` yet.

- [ ] **Step 3: Add the fields and the filters**

In `src/roster.ts`:

```ts
export type Member = {
  slug: string
  model: string
  roles: Role[]
  ms: number
  free?: boolean
  /**
   * What the model can actually do, measured - never read off a catalogue flag.
   * `schema`: forced-tool-call structured output, which every council lane needs.
   * `agentic`: drives tools in a session, which the implementer needs.
   * Two models now fail the first while passing the second, and their 400s name the
   * cause: only `tool_choice: "auto"` is supported.
   */
  capability?: ("schema" | "agentic")[]
  /**
   * The vendor's own capability/cost class. NEVER derived from `ms`: that is latency on a
   * trivial call, and Luna - the tier built for speed - measures slowest of the gpt-5.6
   * three. Latency ranks queue noise, not capability.
   */
  tier?: "deep" | "standard" | "fast"
}

export const canSchema = (m: Member) => (m.capability ?? ["schema"]).includes("schema")
export const canAgentic = (m: Member) => (m.capability ?? ["schema"]).includes("agentic")
```

Filter `selectNodes`' candidate list and `skepticPool` with `canSchema`.

- [ ] **Step 4: Run the test**

Run: `npm test 2>&1 | tail -5`
Expected: still FAIL on the fixture — deepseek is not added until Task 2.2.

- [ ] **Step 5: Commit the field and filters**

```bash
git add -A && git commit -m "feat(roster): capability and tier as measured facts, filtered at schema lanes"
```

### Task 2.2: The measured model updates

**Files:**
- Modify: `src/roster.ts`, `src/failover.test.ts`, `README.md`

- [ ] **Step 1: Apply the roster changes**

All measured 2026-08-25 against the live server:

```ts
// openai's three are TIERS, not variants - peak / balanced / fast.
{ slug: "gpt56sol",   model: "openai/gpt-5.6-sol",   roles: ["security","architect","systems"],
  ms: 3696, tier: "deep",     capability: ["schema","agentic"] },
{ slug: "gpt56terra", model: "openai/gpt-5.6-terra", roles: ["product","reviewer","docs"],
  ms: 2664, tier: "standard", capability: ["schema","agentic"] },
{ slug: "gpt56luna",  model: "openai/gpt-5.6-luna",  roles: ["reviewer","qa"],
  ms: 4228, tier: "fast",     capability: ["schema","agentic"] },
// glm 5.3 supersedes 5.2; hy3 works on the PAID route, the free one fails schema 3/3.
{ slug: "glm53", model: "zai-coding-plan/glm-5.3", roles: ["systems","infrastructure","reviewer"], ms: 6007 },
{ slug: "hy3",   model: "opencode-go/hy3",         roles: ["qa","ops"],                            ms: 6117 },
// Implementer class: drives tools, cannot be forced into a named schema call.
{ slug: "deepseek", model: "deepseek/deepseek-v4-pro", roles: [], ms: 9459, capability: ["agentic"] },
```

Remove `gpt55` and `glm52`. Keep `gemini36` — `gemini-3.7-flash` times out at 90s.
Append `deepseek`, never at index 0: `engine.ts:799` falls back to `ROSTER[0].model` and
then passes `PATCH_SCHEMA`.

- [ ] **Step 2: Update the one test this changes**

`src/failover.test.ts:39,43` hardcode the slug `gpt55`. Replace with `gpt56terra`.

- [ ] **Step 3: Run the tests**

Run: `npm test 2>&1 | tail -5`
Expected: PASS, including Task 2.1's capability test now that deepseek exists.

- [ ] **Step 4: Correct the README's exclusion table**

`README.md:409` lists `deepseek/*` as excluded and recommends `opencode-go/deepseek-v4-pro`.
Backwards: the direct route drives tools (verified, 9.5s); the recommended remedy answers
*"only available hosted in China, requires explicit opt-in"*. Rewrite the row to say
deepseek is implementer-class, and note `muse-spark-…-contributor` needs a data-collection
opt-in.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(roster): current models, measured - gpt-5.6 tiers, glm-5.3, hy3 paid route, deepseek"
```

### Task 2.3: `architect` and `infrastructure`

**Files:**
- Modify: `src/roster.ts`, `src/roster.test.ts`
- Create: `agent/council-architect.md`, `agent/council-infrastructure.md`

- [ ] **Step 1: Write the failing test**

```ts
test("every role a config may name is answerable by some model", () => {
  // Derived from KNOWN_ROLES, not ALL_ROLES: the latter deliberately excludes `skeptic`,
  // and dropping that assertion would lose the only guarantee that skepticPool,
  // verifyGroup and fixOne's verifier have anyone to call.
  for (const role of KNOWN_ROLES) {
    const carriers = ROSTER.filter((m) => m.roles.includes(role as Role) && canSchema(m))
    assert.ok(carriers.length, `no schema-capable model carries '${role}' - a silent empty lane`)
  }
})

test("a terraform diff wakes infrastructure without costing more nodes", () => {
  const roles = selectRoles(["envs/prod/main.tf"])
  assert.ok(roles.includes("infrastructure"), "the specific role must win over generic ops")
  assert.ok(!roles.includes("ops"), "infrastructure REPLACES ops here; it does not add to it")
  assert.equal(selectNodes(roles).length, 7, "node count must stay flat")
})
```

- [ ] **Step 2: Run and watch both fail**

Run: `npm test 2>&1 | grep -A4 "answerable by some model\|terraform diff"`
Expected: FAIL — the roles do not exist.

- [ ] **Step 3: Add the roles**

In `src/roster.ts`: extend the `Role` union with `"architect" | "infrastructure"`, add both
to `ALL_ROLES`, **append** them to carriers (never prepend — `roles[0]` picks the agent
voice for `runTask` proposers):

- `architect` → `opus5`, `gpt56sol`
- `infrastructure` → `glm53`, `grok45`

`ROUTES`: swap `ops` → `infrastructure` on the `{Dockerfile,docker-compose*,Makefile,*.tf}`
row, and add `**/*.tfvars`, `**/k8s/**`, `**/{terraform,infra,infrastructure}/**` →
`["infrastructure","security"]`. Leave `.github/workflows`, `*.{yml,yaml,…}` and `.env*` on
`ops` — CI and runtime config are ops.

- [ ] **Step 4: Write the two agent files**

`agent/council-architect.md` — boundaries, sequencing, what *not* to build, and the cost of
a wrong seam. `agent/council-infrastructure.md` — Terraform/cloud/network/IAM, blast radius,
what is irreversible. Frontmatter: `description` + `mode: all` only; both must inherit
`edit: deny` / `bash: deny`, which `index.test.ts:50-54` asserts for every agent but
`crew-dev`.

- [ ] **Step 5: Run the tests**

Run: `npm test 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(council): architect and infrastructure lanes"
```

---

## Chunk 3: `council:task`

Spec §3.4. Ships: hand the council a task, get one answer back with its dissent intact.

### Task 3.1: `scorersFor` — the assignment rule, pure

**Files:**
- Modify: `src/engine.ts`
- Test: `src/task.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
test("scorer assignment is deterministic, never self, and survives a thin panel", () => {
  const p = (n: number) => Array.from({ length: n }, (_, i) => ({ slug: `m${i}` }) as any)
  for (const n of [1, 2, 3, 4, 14]) {
    const map = scorersFor(p(n))
    if (n === 1) { assert.equal(map.get("m0")!.length, 0, "one proposal has no scorer"); continue }
    for (const [proposal, scorers] of map) {
      assert.equal(scorers.length, Math.min(3, n - 1), `k = min(3, N-1) at N=${n}`)
      assert.ok(!scorers.includes(proposal), "a model never scores its own answer")
      assert.equal(new Set(scorers).size, scorers.length, "no scorer twice")
    }
  }
  assert.deepEqual(scorersFor(p(14)), scorersFor(p(14)), "same input, same assignment")
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test 2>&1 | grep -A4 "scorer assignment"`
Expected: FAIL — `scorersFor` is not defined.

- [ ] **Step 3: Implement**

```ts
/**
 * Who scores whom. Cyclic-next over roster order, so it is reproducible and no model ever
 * scores itself (k <= N-1 guarantees it). All-pairs would be 182 calls at N=14; this is 42.
 * Keyed by proposal slug -> the slugs that score it.
 */
export function scorersFor(live: { slug: string }[]): Map<string, string[]> {
  const n = live.length
  const k = Math.min(3, n - 1)
  return new Map(live.map((p, i) => [
    p.slug,
    Array.from({ length: Math.max(k, 0) }, (_, j) => live[(i + 1 + j) % n].slug),
  ]))
}
```

- [ ] **Step 4: Run the test**

Run: `npm test 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

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
  // false consensus - the exact failure council:task exists to prevent.
  const props = TASK_SCORE_SCHEMA.properties
  for (const dim of ["correctness", "simplicity", "risk", "completeness"])
    assert.ok(props[dim], `tally() sums ${dim}; the task score must carry it`)
  assert.ok(props.objection, "dissent needs its own field: `reason` is praise when the score is high")
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test 2>&1 | grep -A4 "four dimensions"`
Expected: FAIL — `TASK_SCORE_SCHEMA` is not defined.

- [ ] **Step 3: Add both schemas**

In `src/schema.ts`, mirroring `SCORE_SCHEMA`'s four 1–5 dimensions and adding `objection`
(`""` when the scorer has none). `TASK_PROPOSAL_SCHEMA` is `{answer, reasoning, confidence}`
with `confidence` an enum of `high|medium|low`. Leave `PROPOSAL_SCHEMA`/`SCORE_SCHEMA`
untouched so `/council:plan` is unaffected.

- [ ] **Step 4: Run, then commit**

Run: `npm test 2>&1 | tail -5` → PASS

```bash
git add -A && git commit -m "feat(council): task proposal and score schemas"
```

### Task 3.3: `runTask` and its three terminal states

**Files:**
- Modify: `src/engine.ts`
- Test: `src/task.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test("the winner is the highest mean, not the alphabetically first", () => {
  // Guards the NaN-sort failure directly: give the LAST proposal by slug the best scores.
  const result = decideTask(fixtureProposals(3), fixtureScoresFavouring("m2"))
  assert.equal(result.winner?.slug, "m2")
  assert.equal(result.unscored, false)
})

test("a tie is reported as a tie, never resolved into a winner", () => {
  const result = decideTask(fixtureProposals(2), fixtureScoresTied())
  assert.equal(result.winner, null)
  assert.equal(result.tied.length, 2)
  assert.equal(result.runnerUp, null)
})

test("live answers with no usable score are unranked, not tied", () => {
  // tally([]) returns {ranked:[], winner:null, tied:[]}, which is indistinguishable from a
  // tie. Without this branch the report claims "did not converge" over an empty list while
  // real answers exist.
  const result = decideTask(fixtureProposals(3), [])
  assert.equal(result.unscored, true)
  assert.equal(result.tied.length, 0)
  assert.equal(result.proposals.filter((p) => p.state === "ok").length, 3)
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm test 2>&1 | grep -A4 "highest mean\|reported as a tie\|no usable score"`
Expected: FAIL — `decideTask` is not defined.

- [ ] **Step 3: Implement `decideTask`, then `runTask` around it**

Split deliberately: `decideTask(proposals, scores) → TaskResult` is pure and holds the whole
state machine, so the three tests above need no server. `runTask` does the I/O — fan out
proposals to every `canSchema` member under `agent: council-${roles[0]}`, filter to live,
`scorersFor`, fan out scores preferring a `fast`-tier member, then call `decideTask`.

The state machine, exhaustive and disjoint:

| state | when | `winner` | `tied` | `runnerUp` | `unscored` |
|---|---|---|---|---|---|
| decided | `tally()` names a winner | that one | `[]` | `ranked[1] ?? null` | `false` |
| tied | winner null, `tied` non-empty | `null` | all tied | `null` | `false` |
| unranked | no usable score at all | `null` | `[]` | `null` | `true` |

- [ ] **Step 4: Run, then commit**

Run: `npm test 2>&1 | tail -5` → PASS

```bash
git add -A && git commit -m "feat(council): runTask with an exhaustive terminal-state machine"
```

### Task 3.4: `renderTask`, the tool mode, and the command

**Files:**
- Modify: `src/report.ts`, `src/index.ts`
- Create: `command/council:task.md`
- Test: `src/task.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("no live answer disappears from the report", () => {
  // tally() ranks only what it received scores for. A proposal whose scorers all failed is
  // in ranked/winner/tied/runnerUp nowhere, and `unscored` is false - so without an
  // explicit section it silently vanishes while looking like a clean result.
  const out = renderTask(fixtureWhereOneProposalLostItsScorers())
  assert.match(out, /answered, but unscored/i)
  assert.match(out, /m2/, "the orphaned answer must still be printed")
})

test("dissent survives into the report verbatim", () => {
  const out = renderTask(fixtureWithObjection("this ignores the retry budget"))
  assert.match(out, /this ignores the retry budget/)
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test 2>&1 | grep -A4 "disappears from the report"`
Expected: FAIL — `renderTask` is not defined.

- [ ] **Step 3: Implement `renderTask`**

Prints, in order: the answer (or tied answers, or all answers unranked) with each one's
`confidence`; the ranked means; the runner-up; every objection verbatim; and finally
**"answered, but unscored"** listing every `state === "ok"` proposal absent from `ranked`.

- [ ] **Step 4: Wire the tool and the command**

`src/index.ts`: add `"task"` to the zod `mode` enum **and** to the inline `args:` TS union
(~line 369); add `context` as a new zod field (today's schema is `{mode, base, goal}`);
dispatch `runTask` with `councilArgs("task")`; write the artifact to
`council-artifacts/<stamp>-task/`. While the schema is open, pass `context` through to
`runIndependent`, which has accepted it since `engine.ts:878` and has never been given it.

`command/council:task.md`: describes handing the council a task and getting one answer with
dissent. Also edit `command/council:independent.md` — its closing paragraph still steers
"one answer rather than several" to `mode: "plan"`, which is stale once this exists.

- [ ] **Step 5: Run, then commit**

Run: `npm test 2>&1 | tail -5` → PASS

```bash
git add -A && git commit -m "feat(council): /council:task - one answer, dissent intact"
```

---

## Chunk 4: The dynamic roster

Spec §3.7. Ships: live catalog, measured capability cache, outage recruitment beyond the
roster, tier routing on the high-volume loops, and `/council:models`.

### Task 4.1: The catalog and the capability cache

**Files:**
- Create: `src/catalog.ts`, `src/catalog.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test("the cache round-trips and a contradicting failure invalidates it", () => {
  const dir = mkdtempSync(join(tmpdir(), "cap-"))
  const c = openCache(join(dir, "capability.json"))
  c.record("x/y", "schema", { ok: true, ms: 1200 })
  assert.equal(openCache(join(dir, "capability.json")).get("x/y", "schema")?.ok, true)
  c.contradict("x/y", "schema")            // a malformed/failed result says otherwise
  assert.equal(c.get("x/y", "schema"), undefined, "a stale 'works' must not keep routing lanes")
  rmSync(dir, { recursive: true, force: true })
})

test("a failed probe is remembered, so a dead model costs one probe not one per run", () => {
  const dir = mkdtempSync(join(tmpdir(), "cap-"))
  const c = openCache(join(dir, "capability.json"))
  c.record("dead/model", "schema", { ok: false, ms: 90000 })
  assert.equal(openCache(join(dir, "capability.json")).get("dead/model", "schema")?.ok, false)
  rmSync(dir, { recursive: true, force: true })
})

test("the probe budget caps a bad day at three", () => {
  const b = probeBudget(3)
  assert.deepEqual([b.take(), b.take(), b.take(), b.take()], [true, true, true, false])
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm test 2>&1 | grep -A4 "round-trips"`
Expected: FAIL — `src/catalog.ts` does not exist.

- [ ] **Step 3: Implement**

`src/catalog.ts` holds both discovery and capability, because they answer one question —
what can actually be used right now:

- `catalog(ctx)` → `GET /config/providers`, flattened to `provider/model` ids, memoised per
  run. Verified shape: `{providers: [{id, models: {…}}]}`, 9 providers, ~114 models.
- `openCache(path = ~/.cache/opencode-council/capability.json)` → `get` / `record` /
  `contradict`. Machine-specific, so `~/.cache` and never the repo: a teammate's quota is
  not a fact about the code.
- `probeBudget(n)` → `take()`.
- `probe(ctx, model, kind)` → the one-call smoke test, recorded in the cache.

- [ ] **Step 4: Run, then commit**

Run: `npm test 2>&1 | tail -5` → PASS

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
  // The pool is passed in, never fetched here: failover.test.ts:43 asserts that a fully
  // benched roster returns []. If this function fetched a catalogue, that assertion would
  // depend on live network state and the suite would pass or fail by weather.
  const everything: Bench = new Map(ROSTER.map((m) => [m.slug, "dead"]))
  assert.deepEqual(substitutesFor(codeNode, round, everything, new Set()), [],
    "with no pool offered, behaviour is exactly what it is today")

  const understudy = { slug: "gpt56luna-sib", model: "openai/gpt-5.6-luna", roles: ["code"], ms: 4228 } as any
  const subs = substitutesFor(codeNode, round, everything, new Set(), [understudy])
  assert.deepEqual(subs.map((m) => m.slug), ["gpt56luna-sib"])
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test 2>&1 | grep -A4 "recruit from the catalog"`
Expected: FAIL — `substitutesFor` takes four arguments.

- [ ] **Step 3: Add the injected fourth tier**

```ts
export function substitutesFor(
  node: Node, round: Node[], bench: Bench, tried: Set<string>, extra: Member[] = [],
): Member[]
```

Tiers 1–3 over `ROSTER` exactly as today, then `extra` filtered by the same
unavailable/tried rules, same-provider-family first, then by measured `ms`. The caller
resolves catalog ∩ cache and passes it.

- [ ] **Step 4: Run, then commit**

Run: `npm test 2>&1 | tail -5` → PASS

```bash
git add -A && git commit -m "feat(council): recruit substitutes from the live catalog"
```

### Task 4.3: Tier routing on the two high-volume loops

**Files:**
- Modify: `src/roster.ts` (`skepticPool`), `src/engine.ts` (`runTask` scorers)
- Test: `src/roster.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("the shallow, high-volume loops prefer the fast tier", () => {
  // 42 scoring calls per council:task and 3 skeptics per blocker is precisely the
  // "high-volume, lightweight, repetitive" work the fast tier exists for. Depth stays on
  // the lanes where depth is the point.
  const pool = skepticPool([], 3)
  assert.equal(pool[0].tier, "fast", "a fast-tier skeptic must be preferred when one exists")
})
```

- [ ] **Step 2: Run, implement, run**

Order `skepticPool` and `runTask`'s scorer selection by `tier === "fast"` first, then today's
ordering. Fall back silently when no fast member exists.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(council): route the shallow high-volume loops to the fast tier"
```

### Task 4.4: `/council:models`

**Files:**
- Modify: `src/index.ts`
- Create: `command/council:models.md`
- Test: `src/catalog.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("council:models proposes and never writes", async () => {
  // gemini-3.7-flash times out at 90s while 3.6 answers in 9s. An auto-updater chasing
  // "latest" would have adopted it and quietly cost a lane. Adoption stays human-gated.
  const { tool } = await load()
  const before = readFileSync(join(PKG, "src/roster.ts"), "utf8")
  const out = await tool.council.execute({ mode: "models" }, { directory: PKG })
  assert.equal(readFileSync(join(PKG, "src/roster.ts"), "utf8"), before, "it must not write the roster")
  assert.match(out, /propos|candidate/i)
})
```

- [ ] **Step 2: Run, implement, run**

Add `"models"` to the zod enum and the inline `args:` union. The mode fetches the catalog,
diffs it against `ROSTER`, probes candidates within the budget, and renders a table of
measurements with a recommendation. It writes nothing.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(council): /council:models - discover and propose, never adopt"
```

---

## Definition of done

- [ ] `npm test` green, with the new tests from every chunk
- [ ] `/council:{review,fix,plan,independent,check,task,models}` all register (restart required)
- [ ] A real `council:review` runs the full panel with debate, and the Convergence block reports what moved
- [ ] A real `council:task` returns one answer with dissent, or an honest tie
- [ ] `README.md` matches what shipped — roster table, the corrected deepseek row, the new commands
- [ ] An ADR at `docs/adr/2026-08-25-council-namespace-and-dynamic-roster.md` recording the
      measurements this design rests on: gpt-5.6 tiers, gemini-3.7's timeout, hy3's route,
      the `tool_choice: auto` capability class
