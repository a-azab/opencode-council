import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  parseRule,
  matchesGlob,
  readRules,
  selectRules,
  frameworkEvidence,
  renderRules,
  conventionsFor,
  RULES_BUDGET_BYTES,
  type Rule,
} from "./rules.ts"

const rule = (name: string, paths: string[], bytes: number): Rule => ({
  name,
  paths,
  body: "x".repeat(bytes),
  bytes,
})

// ------------------------------------------------------------------ glob

test("a doublestar prefix matches a top-level file", () => {
  // The bug this pins, measured against ECC's real corpus: chained .replace() calls
  // produced `(?:.[^/]*/)?` for a doublestar-slash prefix — the later `*` pass rewrote
  // the `.*` inside the output of the earlier one. The pattern then required a
  // one-character directory and matched NOTHING. All 111 scoped rules selected zero
  // files until this was a single left-to-right pass.
  assert.ok(matchesGlob("**/*.ts", "a.ts"), "a root-level file must match")
  assert.ok(matchesGlob("**/*.ts", "src/lets.ts"))
  assert.ok(matchesGlob("**/*.ts", "src/deep/nested/x.ts"))
})

test("a single star does not cross a directory boundary", () => {
  assert.ok(matchesGlob("src/*.ts", "src/a.ts"))
  assert.ok(!matchesGlob("src/*.ts", "src/deep/a.ts"))
})

test("extensions are matched literally, not as regex", () => {
  // An unescaped dot would make `*.ts` match `axts`.
  assert.ok(!matchesGlob("**/*.ts", "axts"))
  assert.ok(!matchesGlob("**/*.ts", "a.tsx"), "tsx is a different language's rules")
  assert.ok(matchesGlob("**/*.component.ts", "src/app.component.ts"))
})

test("a pattern with regex metacharacters cannot blow up the matcher", () => {
  assert.doesNotThrow(() => matchesGlob("**/*(weird)[x]+.ts", "a.ts"))
  assert.ok(matchesGlob("**/a+b.ts", "src/a+b.ts"))
})

// ------------------------------------------------------------------ parsing

test("frontmatter paths are read, and the body excludes them", () => {
  const r = parseRule("x.md", '---\npaths:\n  - "**/*.ts"\n  - "**/*.tsx"\n---\n# Heading\nbody text\n')
  assert.deepEqual(r.paths, ["**/*.ts", "**/*.tsx"])
  assert.match(r.body, /# Heading/)
  assert.doesNotMatch(r.body, /paths:/, "frontmatter must not reach the prompt")
})

test("a rule with no frontmatter is unscoped, not an error", () => {
  const r = parseRule("common.md", "# Just a rule\n")
  assert.deepEqual(r.paths, [])
  assert.match(r.body, /Just a rule/)
})

test("a key after the paths list ends the list", () => {
  const r = parseRule("x.md", '---\npaths:\n  - "**/*.ts"\ndescription: not a path\n---\nbody\n')
  assert.deepEqual(r.paths, ["**/*.ts"])
})

// ------------------------------------------------------------------ selection

test("only rules whose globs match the item's files are selected", () => {
  const rules = [rule("ts.md", ["**/*.ts"], 100), rule("py.md", ["**/*.py"], 100), rule("rs.md", ["**/*.rs"], 100)]
  assert.deepEqual(selectRules(rules, ["src/a.ts"]).map((r) => r.name), ["ts.md"])
})

test("unscoped rules are never selected", () => {
  // They match everything equally and so discriminate nothing, they are the largest
  // files in the corpus, and the repo's own AGENTS.md already carries house rules on
  // every prompt.
  assert.deepEqual(selectRules([rule("common.md", [], 100)], ["a.ts"]), [])
})

test("no files means no rules, rather than everything", () => {
  // An item with no predicted files is already a warning sign; answering it with the
  // whole library would spend the budget at exactly the moment it is least justified.
  assert.deepEqual(selectRules([rule("ts.md", ["**/*.ts"], 100)], []), [])
})

test("the budget is enforced, and a large rule does not stop smaller ones", () => {
  // Smallest first, and `continue` rather than `break`: three focused rules beat one
  // oversized one that crowds them out.
  const rules = [
    rule("huge.md", ["**/*.ts"], 5000),
    rule("small-a.md", ["**/*.ts"], 100),
    rule("small-b.md", ["**/*.ts"], 100),
  ]
  const picked = selectRules(rules, ["a.ts"], 1000)
  assert.deepEqual(picked.map((r) => r.name), ["small-a.md", "small-b.md"])
  assert.ok(picked.reduce((a, r) => a + r.bytes, 0) <= 1000)
})

test("selection is deterministic for equal sizes", () => {
  const rules = [rule("b.md", ["**/*.ts"], 100), rule("a.md", ["**/*.ts"], 100)]
  assert.deepEqual(selectRules(rules, ["a.ts"]).map((r) => r.name), ["a.md", "b.md"])
})

test("a framework's rules need evidence, not just a matching extension", () => {
  // ECC's own frontmatter over-claims: rules/react-native and rules/arkts both declare
  // every **/*.ts file. Selecting for a plain Node CLI therefore pulled in React Native,
  // Vue and HarmonyOS conventions - worse than sending nothing, because a worker told to
  // mind Expo's navigation lifecycle while editing a git worktree is being misled, and
  // the budget spent on it crowds out the rules that do apply.
  const rules = [rule("typescript/style.md", ["**/*.ts"], 100), rule("react-native/hooks.md", ["**/*.ts"], 100)]
  const noEvidence = selectRules(rules, ["src/a.ts"], 5000, '{"dependencies":{"zod":"4"}}')
  assert.deepEqual(noEvidence.map((r) => r.name), ["typescript/style.md"])

  const withEvidence = selectRules(rules, ["src/a.ts"], 5000, '{"dependencies":{"react-native":"0.7"}}')
  assert.equal(withEvidence.length, 2, "evidence present means the family is admitted")
})

test("framework gating fails closed when there is no evidence to read", () => {
  // A wrong convention is worse than a missing one, so the default excludes.
  const rules = [rule("vue/style.md", ["**/*.ts"], 100)]
  assert.deepEqual(selectRules(rules, ["a.ts"], 5000), [])
})

// ------------------------------------------------------------------ rendering

test("the block subordinates borrowed rules to the repo's own", () => {
  // A rule library from another project must never outrank the AGENTS.md of the repo
  // being edited. Saying so costs one line; discovering it in review costs a round.
  const out = renderRules([rule("ts.md", ["**/*.ts"], 10)])
  assert.match(out, /THE REPO WINS/)
  assert.match(out, /background, not instructions/)
  assert.match(out, /do not expand the item's scope/i)
})

test("no rules renders nothing at all", () => {
  assert.equal(renderRules([]), "")
})

// ------------------------------------------------------------------ end to end

test("a missing or broken ECC checkout costs advice, never the run", () => {
  assert.equal(conventionsFor(undefined, ["a.ts"]), "")
  assert.equal(conventionsFor("/nonexistent-ecc", ["a.ts"]), "")
  const empty = mkdtempSync(join(tmpdir(), "ecc-"))
  try {
    assert.equal(conventionsFor(empty, ["a.ts"]), "", "a checkout with no rules dir is not an error")
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test("rules are read from a real directory tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "ecc-"))
  try {
    mkdirSync(join(dir, "rules", "typescript"), { recursive: true })
    writeFileSync(join(dir, "rules", "typescript", "style.md"), '---\npaths:\n  - "**/*.ts"\n---\nUSE CONST\n')
    writeFileSync(join(dir, "rules", "README.md"), "not a rule")
    const out = conventionsFor(dir, ["src/a.ts"])
    assert.match(out, /USE CONST/)
    assert.doesNotMatch(out, /not a rule/, "README.md is documentation, not a rule")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Guarded: this machine has an ECC checkout, CI may not. The point is to assert against
// the REAL corpus, because a fixture cannot catch a glob bug that only the real patterns
// expose - which is exactly what happened.
const ECC = "/root/code/AI/ECC"
test("against the real ECC corpus, selection is non-empty and within budget", { skip: !existsSync(ECC) }, () => {
  const rules = readRules(ECC)
  assert.ok(rules.length > 50, `expected a real corpus, got ${rules.length} rules`)

  // This repo: a Node CLI with no react, no expo, no HarmonyOS.
  const ev = frameworkEvidence("/root/code/opencode-council", ["src/lets.ts"])
  const ts = selectRules(rules, ["src/lets.ts"], RULES_BUDGET_BYTES, ev)
  assert.ok(ts.length > 0, "TypeScript files must select TypeScript rules - this was 0 before the glob fix")
  assert.ok(
    ts.every((r) => r.name.startsWith("typescript/")),
    `frameworks whose evidence is absent must not be selected, got: ${ts.map((r) => r.name).join(", ")}`,
  )
  assert.ok(ts.reduce((a, r) => a + r.bytes, 0) <= RULES_BUDGET_BYTES)

  const py = selectRules(rules, ["main.py"], RULES_BUDGET_BYTES, ev)
  assert.ok(py.length > 0 && py.every((r) => r.name.startsWith("python/")))

  // ...and a repo that genuinely IS React Native still gets its rules.
  const rn = selectRules(rules, ["App.tsx"], RULES_BUDGET_BYTES, '{"dependencies":{"react-native":"0.7","expo":"5"}}')
  assert.ok(rn.some((r) => r.name.startsWith("react-native/")), "evidence present means the family is admitted")

  // The whole reason for selecting rather than sending: the corpus is ~270KB.
  const total = rules.reduce((a, r) => a + r.bytes, 0)
  assert.ok(total > 100_000, `corpus is ${total} bytes`)
  assert.ok(ts.reduce((a, r) => a + r.bytes, 0) < total / 5, "selection must be a fraction of the corpus")
})
