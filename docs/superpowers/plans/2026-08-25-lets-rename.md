# `/lets` Rename Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the single-task pipeline from `crew` to `lets`, so sub-project 3 can build the real `crew` (an orchestrator of several lets) on top of it.

**Architecture:** Three chunks. Chunk 1 is atomic and unavoidably large — the hard rename and the three read-both readers must land together, because renaming the config parser while ten tests still feed it the old fence would break the suite mid-chunk. Chunk 2 adds the compatibility coverage. Chunk 3 is docs.

**Tech Stack:** TypeScript, NO build step (node strips types, so a stale import is a runtime error). `npm test` = `node --test src/*.test.ts`. Baseline: **178 pass**.

**Spec:** `docs/superpowers/specs/2026-08-25-lets-design.md` (rev 3)

**Scale:** 336 `crew` lines across 24 files.

---

## Chunk 1: The rename, with its guards

### Task 1.1: The three guards

Written first so the rename has a target. All three go red, then green in Task 1.2.

**Files:** `src/index.test.ts`

- [ ] **Step 1: Write the guards**

```ts
test("no module still imports the pre-rename pipeline", () => {
  // No build step: a stale `from "./crew.ts"` is a runtime module-not-found, not a compile
  // error. tool.test.ts uses a DYNAMIC import, which a static-import grep misses - so match
  // the string. Excludes THIS file, which must contain the string to search for it.
  const offenders = readdirSync(join(PKG, "src"))
    .filter((f) => f.endsWith(".ts") && f !== "index.test.ts")
    .filter((f) => /["'`]\.\/crew\.ts["'`]/.test(readFileSync(join(PKG, "src", f), "utf8")))
  assert.deepEqual(offenders, [], `stale ./crew.ts imports: ${offenders.join(", ")}`)
})

test("no command still tells the model to call a tool named crew", () => {
  // Every command file invokes the tool by BARE name - `Call the \`crew\` tool with ...` -
  // with no colon. A guard matching `crew:` command names sails past all four, and the
  // result is every command calling a tool that does not exist: a silent no-op, never an
  // error.
  const offenders = readdirSync(join(PKG, "command"))
    .filter((f) => /`crew` tool/.test(readFileSync(join(PKG, "command", f), "utf8")))
  assert.deepEqual(offenders, [], `commands invoking a dead tool: ${offenders.join(", ")}`)
})

test("no pre-rename crew: command name survives", () => {
  // Test TITLES trip this too - three exist today. That is correct: a title naming a
  // command that no longer exists is a lie about coverage.
  const files = [
    ...readdirSync(join(PKG, "command")).map((f) => `command/${f}`),
    ...readdirSync(join(PKG, "src")).map((f) => `src/${f}`),
    "README.md",
  ].filter((f) => /\.(md|ts)$/.test(f) && !f.endsWith("index.test.ts"))
  const offenders = files.filter((rel) =>
    /\/crew:(init|plan|execute|status)(?![\w-])/.test(readFileSync(join(PKG, rel), "utf8")))
  assert.deepEqual(offenders, [], `stale crew: command refs: ${offenders.join(", ")}`)
})
```

- [ ] **Step 2: Run — all three must fail**, naming real files. Record which.

### Task 1.2: The rename

**Do not commit until the suite is green.** This is one atomic change.

- [ ] **Step 1: Move the files**

```bash
git mv src/crew.ts src/lets.ts
git mv src/crew.test.ts src/lets.test.ts
for m in init plan execute status; do git mv "command/crew:$m.md" "command/lets:$m.md"; done
for a in cpo cto dev; do git mv "agent/crew-$a.md" "agent/lets-$a.md"; done
```

- [ ] **Step 2: Repoint every import**

`src/index.ts:24`, `src/lets.test.ts:42`, `src/mcp.test.ts:8`, `src/linear.test.ts:5`,
`src/mcp.ts:15`, and the **dynamic** `await import("./crew.ts")` at `src/tool.test.ts:211`.

- [ ] **Step 3: Rename the symbols**

`CREW_MODELS`→`LETS_MODELS`, `readCrewConfig`→`readLetsConfig`,
`parseCrewBlock`→`parseLetsBlock`, `renderCrewBlock`→`renderLetsBlock`,
`CrewConfig`→`LetsConfig`, and their import sites.

- [ ] **Step 4: The tool key and the two confinement controls**

- `src/index.ts` — tool key `crew` → `lets`; the "no config" message; artifact kinds
  (§3.2 handles the reader).
- **`src/engine.ts:241`** — `{ permission: "crew", … }` → `"lets"`. This is what stops a
  spawned worker re-entering the tool; leave it and the deny silently stops matching.
- **`src/index.ts:559-560`** — `primary_tools` `["council","crew"]` → `["council","lets"]`.
  Its comment at `:556-557` names it as the control keeping the tool out of task-tool
  subagents.

- [ ] **Step 5: Agent names in prompts**

`agent: "crew-dev"` and siblings at the `ask()` call sites → `lets-*`, matching the moved
files, or the worker loads no agent at all.

- [ ] **Step 6: The three read-both readers — required now, not later**

These cannot wait for a later chunk: Task 1.3's fixtures feed the old formats, and the
suite must be green at this commit.

**a. The fence** (`lets.ts:81`). `FENCE` accepts ` ```crew ` or ` ```lets `;
`renderLetsBlock` (`:196`) writes ` ```lets `. Also update `HEADING = "## Crew"` (`:182`)
and the prose `` Config for `/crew`. `` (`:198`), both written into the user's AGENTS.md.

**b. The branch prefix — three sites.**

| site | role |
|---|---|
| `lets.ts:1064` | writes — `openWorktree` → `` `lets/${slug}` `` |
| `lets.ts:1116`,`:1120` | reads — `listWorktrees` |
| `lets.ts:1631` | reads — `branchExists` in `runExecute`'s collision loop |

`:1631` must check the same namespace `:1064` writes, or the collision guard is checking an
empty one and `git worktree add -b` throws on the collision it exists to prevent.

**`:1120` must capture the prefix, not rebuild it.** It currently reconstructs
`` `crew/${slug}` ``. Widening only the regex leaves it reporting a `lets/foo` worktree as
`crew/foo` — a branch that does not exist, printed in a removal command a human will run.

**c. Artifact kinds.** `latestArtifact` (`index.ts:150`) must find `-crew-plan` and
`-lets-plan`; new writes use `-lets-*`. It is **shared with the council path** (`:522`
review, `:529` fix), so prefer an additive `kind: string[]` over rewriting its anchored
template. Note `.sort().pop()` means `lets-plan` wins a same-second tie, which is the
correct preference.

- [ ] **Step 7: Update assertions whose VALUE changes** (not mechanical)

`lets.test.ts:99, 219, 371, 471, 475` · `index.test.ts:26, 40, 47, 56, 63, 67, 71, 168`
(note `:56` and `:63-68` are `crew-dev` special-cases) · `tool.test.ts:19, 126, 138, 139`.

- [ ] **Step 8: Run — 178 green and all three guards pass**

- [ ] **Step 9: Commit**

```
refactor(lets): rename the single-task pipeline from crew

Sub-project 3 makes `crew` an orchestrator that runs several lets; two things
cannot both be called crew.

Renames hard: the module, tool key, commands, agents, symbols - and the two
confinement controls keyed on the tool name (engine.ts's permission deny rule
and primary_tools), either of which fails silently if missed.

Reads both names for the three persisted formats - config fence, worktree
branch prefix, artifact directories - so existing config, stranded worktrees and
approved plans stay visible.
```

### Task 1.3: Prove the compatibility fixtures survived

**Files:** `src/lets.test.ts`

- [ ] **Step 1: Confirm the ten fixtures still say `crew`**

`lets.test.ts:64, 238, 239, 615, 617, 625, 626` · `mcp.test.ts:177, 180` ·
`tool.test.ts:37` feed ` ```crew ` as **input**. They are the read-both regression suite for
free. If Task 1.2 converted any to ` ```lets `, restore it.

- [ ] **Step 2: Add the comment that stops the next tidy-up removing them**

```ts
// Deliberately ```crew, not ```lets: this is the compatibility path. A repo configured
// before the rename must still parse, and these fixtures are the only thing proving it.
```

- [ ] **Step 3: Run — green. Step 4: Commit**

`test(lets): mark the pre-rename fence fixtures as deliberate`

---

## Chunk 2: Coverage for the read-both behaviours

### Task 2.1: The three compatibility tests

**Files:** `src/lets.test.ts`, `src/index.test.ts`

- [ ] **Step 1: Write them**

```ts
test("a lets fence parses, and so does a pre-rename crew fence", () => {
  const block = (name: string) => "```" + name + "\nverify: npm test\nbase: main\nlanes: reviewer\n```"
  assert.ok(parseLetsBlock(block("lets"))?.verify, "the new fence must parse")
  assert.ok(parseLetsBlock(block("crew"))?.verify, "a repo configured before the rename must not lose its config")
  assert.match(renderLetsBlock({ verify: ["npm test"], base: "main", lanes: ["reviewer"] }), /```lets/)
})

test("listWorktrees sees both prefixes and reports each under its own name", () => {
  // openWorktree only writes `lets/` now, so the legacy branch is built by hand -
  // the pattern lets.test.ts:702 already uses.
  // ... create a scratch repo, `git branch crew/<stamp>` and `git branch lets/<stamp>`,
  // each with a matching .worktrees/<stamp> directory ...
  const found = listWorktrees(dir)
  const branches = found.map((w) => w.branch).sort()
  assert.ok(branches.some((b) => b.startsWith("crew/")), "a pre-rename worktree must stay visible, or it is stranded")
  assert.ok(branches.some((b) => b.startsWith("lets/")))
  for (const w of found)
    assert.ok(w.branch.endsWith(w.slug), `${w.branch} must carry its own prefix, not a rebuilt one`)
})

test("an approved plan from before the rename is still runnable", () => {
  // ... scratch repo with council-artifacts/<stamp>-crew-plan/plan.json ...
  assert.ok(latestArtifact(dir, ["lets-plan", "crew-plan"], "plan.json"),
    "a plan approved before the rename must not become invisible")
})
```

Match the argument shape to whatever Task 1.2 Step 6c actually chose for `latestArtifact`.

- [ ] **Step 2: Run — watch each fail if the reader is wrong. Step 3: Fix. Step 4: Commit**

`test(lets): pin the three read-both compatibility paths`

### Task 2.2: The confinement guards

**Files:** `src/index.test.ts`

- [ ] **Step 1: Write them**

```ts
test("the spawned-worker deny rule names the tool that exists", () => {
  // engine.ts denies the tool by NAME so a worker cannot re-enter it and recurse. Rename
  // the tool without this string and the deny stops matching - silently. Source-text
  // assertion following the existing precedent at index.test.ts:164-174.
  const engine = readFileSync(join(PKG, "src/engine.ts"), "utf8")
  assert.match(engine, /permission: "lets"/, "the deny rule must name the live tool")
  assert.doesNotMatch(engine, /permission: "crew"/, "a deny for a tool that does not exist guards nothing")
})

test("primary_tools surfaces the renamed tool", async () => {
  const { config } = await load()
  assert.ok(config.experimental.primary_tools.includes("lets"))
})
```

- [ ] **Step 2: Run — green (Task 1.2 did the work; these pin it). Step 3: Commit**

`test(lets): pin both tool-name-keyed confinement controls`

---

## Chunk 3: Docs

### Task 3.1: README, AGENTS.md, PLAN.md

- [ ] **Step 1: `README.md`** — the whole `/lets:*` surface, the tool name, and any prose
  describing the pipeline as "crew".

- [ ] **Step 2: `AGENTS.md`** — this repo's own config block at `:5-9` is a ` ```crew `
  fence. Leaving it exercises the compatibility path in the repo itself, which is a fair
  choice — but `:3`'s "Config for `/crew:plan`" names a command that no longer exists.
  Update the prose; state in the commit which you chose for the fence and why.

- [ ] **Step 3: `PLAN.md`** — 30 lines. It is a **dated journal**: leave the history alone.
  Only `:724`, `:727`, `:760` describe current behaviour and need updating, with a note that
  the entries are historical.

- [ ] **Step 4: Run — the guards must pass. Step 5: Commit**

`docs: the pipeline is lets`

---

## Definition of done

- [ ] `npm test` green at every commit
- [ ] All three guards from Task 1.1 pass
- [ ] `/lets:{init,plan,execute,status}` register; no `/crew:*` command remains
- [ ] A repo with a ` ```crew ` block still works, and `lets:status` still sees a `crew/` worktree
- [ ] `engine.ts` denies `lets`; `primary_tools` contains `lets`
- [ ] The ten compatibility fixtures still say `crew`, with the comment explaining why
