import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  parseSkill,
  readSkills,
  corpusStats,
  scoreSkill,
  selectSkills,
  renderSkills,
  skillRoots,
  skillsFor,
  MIN_SCORE,
  MIN_DISTINCT_MATCHES,
  SKILLS_BUDGET_BYTES,
  MAX_SKILLS,
  type Skill,
} from "./skills.ts"

const skill = (over: Partial<Skill> = {}): Skill => ({
  id: "s",
  source: "T",
  name: "s",
  description: "",
  tags: [],
  body: "body",
  bytes: 4,
  ...over,
})

// ------------------------------------------------------------------ parsing

test("frontmatter is read and excluded from the body", () => {
  const s = parseSkill("x", "ECC", "---\nname: my-skill\ndescription: Does a thing.\n---\n# Heading\ntext\n")
  assert.ok(s)
  assert.equal(s.name, "my-skill")
  assert.equal(s.description, "Does a thing.")
  assert.match(s.body, /# Heading/)
  assert.doesNotMatch(s.body, /description:/, "frontmatter must not reach the prompt")
})

test("nested frontmatter keys are not mistaken for top-level ones", () => {
  // `metadata:\n  origin: ECC` would otherwise set an `origin` field from an indented line.
  const s = parseSkill("x", "ECC", "---\nname: n\nmetadata:\n  origin: ECC\n---\nbody\n")
  assert.ok(s)
  assert.equal(s.name, "n")
})

test("inline tags and category both become tags", () => {
  const s = parseSkill("x", "ECC", "---\nname: n\ntags: [motion, animation]\ncategory: frontend\n---\nbody\n")
  assert.ok(s)
  assert.deepEqual(s.tags.sort(), ["animation", "frontend", "motion"])
})

test("a file with no frontmatter is not a skill", () => {
  assert.equal(parseSkill("x", "ECC", "# Just markdown\n"), null)
  assert.equal(parseSkill("x", "ECC", "---\ndescription: no name\n---\nbody"), null)
})

// ------------------------------------------------------------------ selection

test("one shared word is a coincidence, not a match", () => {
  // The measured failure: an item titled "Fix OAuth token refresh race" matched
  // `evm-token-decimals` (Ethereum) and `token-budget-advisor` (LLM context) on the
  // single word "token". Both would have gone to a worker editing an auth module.
  const skills = [skill({ id: "evm-token-decimals", name: "evm-token-decimals", description: "ERC20 decimals" })]
  const picked = selectSkills(skills, { title: "Fix OAuth token refresh race", detail: "concurrent 401" })
  assert.deepEqual(picked, [], "a single coincidental word must not qualify a skill")
})

test("several shared words are a topic", () => {
  const skills = [
    skill({
      id: "swiftui-patterns",
      name: "swiftui-patterns",
      description: "SwiftUI architecture, observable state, navigation, performance",
    }),
  ]
  const filler = Array.from({ length: 20 }, (_, i) => skill({ id: `f${i}`, name: `filler-${i}`, description: "unrelated" }))
  const picked = selectSkills([...skills, ...filler], {
    title: "Build a SwiftUI settings screen",
    detail: "observable state and navigation",
  })
  assert.deepEqual(picked.map((s) => s.id), ["swiftui-patterns"])
})

test("an item with no distinctive words selects nothing", () => {
  // Silence is the correct answer. A worker handed three vaguely-related documents reads
  // none of them and has spent the budget a relevant one would have used.
  const skills = [skill({ id: "a", name: "testing-patterns", description: "how to test code" })]
  assert.deepEqual(selectSkills(skills, { title: "Rename a variable", detail: "tidy up" }), [])
})

test("an empty item selects nothing rather than everything", () => {
  assert.deepEqual(selectSkills([skill()], { title: "", detail: "" }), [])
})

test("a name or tag match outweighs the same word in prose", () => {
  // The author choosing a word for the title is a stronger signal than it appearing
  // somewhere in a paragraph.
  const named = skill({ id: "a", name: "webhook-security", description: "misc" })
  const prosed = skill({ id: "b", name: "misc", description: "webhook security appears here in prose" })
  const filler = Array.from({ length: 20 }, (_, i) => skill({ id: `f${i}`, name: `filler-${i}`, description: "unrelated" }))
  const stats = corpusStats([named, prosed, ...filler])
  const toks = new Set(["webhook", "security"])
  assert.ok(scoreSkill(named, toks, stats).score > scoreSkill(prosed, toks, stats).score)
})

test("the budget and the count cap are both enforced", () => {
  const many = Array.from({ length: 10 }, (_, i) =>
    skill({ id: `s${i}`, name: "alpha beta", description: "alpha beta gamma", bytes: 1000 }),
  )
  const picked = selectSkills(many, { title: "alpha beta gamma work", detail: "alpha beta" })
  assert.ok(picked.length <= MAX_SKILLS, `got ${picked.length}`)
  assert.ok(picked.reduce((a, s) => a + s.bytes, 0) <= SKILLS_BUDGET_BYTES)
})

test("a huge skill does not crowd out smaller equally-relevant ones", () => {
  const huge = skill({ id: "huge", name: "alpha beta", description: "alpha beta", bytes: 11_000 })
  const small = skill({ id: "small", name: "alpha beta", description: "alpha beta", bytes: 100 })
  const filler = Array.from({ length: 20 }, (_, i) => skill({ id: `f${i}`, name: `filler-${i}`, description: "unrelated" }))
  const picked = selectSkills([huge, small, ...filler], { title: "alpha beta gamma", detail: "alpha beta" }, { budget: 11_050 })
  assert.equal(picked[0].id, "small", "smallest first among equals - the budget is the binding constraint")
})

// ------------------------------------------------------------------ hygiene

test("fixtures, snapshots and vendor-internal skills are never read", () => {
  // dsh's SKILL.md files are mostly snapshot fixtures, and its `.agents/` skills describe
  // how to develop dsh itself - noise in every repo that is not dsh.
  const dir = mkdtempSync(join(tmpdir(), "sk-"))
  try {
    for (const p of ["good/real-skill", "snapshots/fake", "tests/fixtures/fake2", "presets/cordis/x"]) {
      mkdirSync(join(dir, p), { recursive: true })
      writeFileSync(join(dir, p, "SKILL.md"), "---\nname: n\ndescription: d\n---\nbody\n")
    }
    mkdirSync(join(dir, "dsh-internal"), { recursive: true })
    writeFileSync(join(dir, "dsh-internal", "SKILL.md"), "---\nname: n\n---\nbody\n")

    const found = readSkills(dir, "T").map((s) => s.id)
    assert.deepEqual(found, ["real-skill"], `got ${JSON.stringify(found)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the block subordinates borrowed skills to the repo", () => {
  const out = renderSkills([skill({ name: "n", source: "ECC" })])
  assert.match(out, /REPO WINS/)
  assert.match(out, /background, not/)
  assert.match(out, /do not widen the/i)
  assert.match(out, /source="ECC"/, "attribution, so a worker knows whose advice it is")
})

test("no skills renders nothing at all", () => {
  assert.equal(renderSkills([]), "")
})

test("a missing corpus costs advice, never the run", () => {
  assert.equal(skillsFor({ title: "anything" }, []), "")
  assert.deepEqual(readSkills("/nonexistent-skills-root", "T"), [])
  assert.deepEqual(skillRoots(undefined, undefined), [])
})

// ------------------------------------------------------------------ the real corpus

const ECC = "/root/code/AI/ECC"
test("against the real corpus, selection is relevant and bounded", { skip: !existsSync(ECC) }, () => {
  const roots = skillRoots(ECC, existsSync("/tmp/dsh") ? "/tmp/dsh" : undefined)
  const all = roots.flatMap((r) => readSkills(r.root, r.source))
  assert.ok(all.length > 100, `expected a real corpus, got ${all.length}`)
  const stats = corpusStats(all)

  // On topic: a SwiftUI item must find the SwiftUI skill.
  const sw = selectSkills(all, {
    title: "Build a SwiftUI settings screen",
    detail: "observable state and navigation",
    files: ["App/Settings.swift"],
  }, { stats })
  assert.ok(sw.some((s) => s.id === "swiftui-patterns"), `got ${sw.map((s) => s.id).join(", ")}`)

  // Off topic: a trivial item must find nothing.
  assert.deepEqual(selectSkills(all, { title: "Rename a variable", detail: "tidy up" }, { stats }), [])

  // Bounded: the corpus is ~2.4MB and must never arrive whole.
  const total = all.reduce((a, s) => a + s.bytes, 0)
  assert.ok(total > 1_000_000, `corpus is ${total} bytes`)
  for (const item of [
    { title: "Add a GitHub Actions CI workflow", detail: "run npm test on pull requests" },
    { title: "Review this pull request for security vulnerabilities", detail: "audit the auth path" },
  ]) {
    const sel = selectSkills(all, item, { stats })
    assert.ok(sel.length <= MAX_SKILLS)
    assert.ok(sel.reduce((a, s) => a + s.bytes, 0) <= SKILLS_BUDGET_BYTES)
  }
})

test("the thresholds are the measured ones", () => {
  // Pinned so a later tweak is a deliberate decision with a test to update, not a drift.
  assert.equal(MIN_DISTINCT_MATCHES, 2)
  assert.equal(MIN_SCORE, 6)
})
