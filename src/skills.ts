// Skills: reusable procedure documents, selected per work item.
//
// ECC ships 281 of them and dsh a handful, and unlike rules they carry NO path globs —
// only `name` and `description`, sometimes `tags` and `category`. So selection cannot be
// a path match; it has to be a relevance judgement, and that is a much easier thing to
// get wrong.
//
// Getting it wrong is expensive in a specific way this codebase has already been bitten
// by: the rules selector cheerfully handed a Node CLI React Native and HarmonyOS
// conventions because ECC's frontmatter over-claimed. A worker told to mind Expo's
// navigation lifecycle while editing a git worktree is not merely unhelped, it is
// misled. So the rule here is the same one: WRONG ADVICE IS WORSE THAN NO ADVICE, and
// every knob below is set to prefer silence over a guess.
//
//   - scoring is token overlap against the item's own words, not a model call
//   - a minimum score, below which nothing is selected at all
//   - at most a few skills, and a byte budget under all of them
//   - self-referential and fixture skills are excluded outright: a skill about how to
//     develop cordis plugins is noise in every repo that is not cordis
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"

/** Total skill text allowed into one prompt. */
export const SKILLS_BUDGET_BYTES = 12_000

/** At most this many skills, however well they score. */
export const MAX_SKILLS = 3

/**
 * Minimum overlap score for a skill to be offered at all.
 *
 * The single most important number in this file. Too low and every item gets three
 * loosely-related documents; too high and the feature never fires. It is deliberately set
 * so that a generic item selects NOTHING — silence is the correct answer when no skill is
 * clearly on point.
 */
export const MIN_SCORE = 6

/**
 * How much of a word's weight survives being common across the corpus.
 *
 * A raw overlap count cannot tell "this skill is about the thing" from "this skill shares
 * a word with the thing", and the corpus is full of the latter. Measured 2026-09-20: an
 * item titled "Fix OAuth token refresh race" matched `evm-token-decimals` (Ethereum) and
 * `token-budget-advisor` (LLM context) on the single word "token" - both would have gone
 * to a worker editing an auth module.
 *
 * Document frequency is the discriminator, because it is a property of the corpus rather
 * than a guess: across 281 ECC skills, `swiftui` appears in 2 and `workflow` in 23. A
 * word that half the library uses says almost nothing about which half you want; a word
 * two skills use says a great deal.
 *
 * Requiring N distinct matches was tried first and rejected: it killed correct selections
 * on precise short titles (a CI item legitimately matched `github-ops` on one strong
 * word) while a vaguer item with two weak words still passed. Weighting beats counting.
 */
const idf = (docFreq: number, total: number): number =>
  // Floored, not raw. In a corpus of one, `log((1+1)/(1+1))` is exactly 0, so every word
  // weighs nothing and nothing is ever selected — a tiny corpus would silently disable
  // the feature rather than behave like a small version of a large one. The floor keeps
  // a match worth something while still ranking rare words far above common ones.
  Math.max(0.5, Math.log((total + 1) / (docFreq + 1)))

/**
 * Distinct item words a skill must match before it is offered.
 *
 * One shared word is a coincidence; the corpus is full of them. Two or more is a topic.
 * Verified against the real corpus with realistic item descriptions: a SwiftUI item
 * matches `swiftui-patterns` on four words, a security review matches `security-review`
 * on two, and a "Write a PowerPoint deck" item matches nothing at all - which is correct,
 * because silence is the right answer when no skill is on point.
 *
 * The cost is that a very terse item selects nothing. That is the side to err on: a
 * missing skill is silence, a wrong one is misdirection, and misdirection is what a
 * worker will actually follow.
 */
export const MIN_DISTINCT_MATCHES = 2

export type Skill = {
  /** stable id: the skill's own directory name */
  id: string
  /** where it came from, for attribution in the prompt */
  source: string
  name: string
  description: string
  tags: string[]
  body: string
  bytes: number
}

/**
 * Directories whose SKILL.md files are never candidates.
 *
 * Fixtures and snapshots are test data. Presets and `.agents/` skills in a vendor's own
 * repo are about developing THAT vendor's product - dsh's `dsh-merging-stacked-prs` and
 * `cordis-plugin-development` describe workflows in repositories the worker is not in.
 */
const EXCLUDED_SEGMENTS = ["snapshots", "tests", "fixtures", "node_modules", "presets", ".agents"]

/** Skill ids that are about the harness itself rather than about engineering. */
const SELF_REFERENTIAL = /^(dsh|cordis|ecc)-|^(editing-cordis|snapshot-skill|model-only|user-only)/

/**
 * Parse a SKILL.md. Frontmatter is flat `key: value` plus an optional inline `tags: [a, b]`.
 *
 * Hand-rolled for the same reason the lets block and the rules frontmatter are: this reads
 * three keys, and a YAML dependency to do it would be the tail wagging the dog. A skill
 * with no frontmatter has no name and is dropped by the caller.
 */
export function parseSkill(id: string, source: string, text: string): Skill | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return null
  const body = text.slice(m[0].length).trim()
  const fields: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":")
    // Indented lines belong to a nested block (`metadata:`), which this parser does not
    // read. Skipping them stops `origin: ECC` from being mistaken for a top-level key.
    if (i === -1 || /^\s/.test(line)) continue
    fields[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  if (!fields.name) return null
  const tags = (fields.tags ?? "")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
  if (fields.category) tags.push(fields.category)
  return {
    id,
    source,
    name: fields.name,
    description: fields.description ?? "",
    tags,
    body,
    bytes: Buffer.byteLength(body),
  }
}

/** Read every usable skill under a root. Returns [] when there is nothing there. */
export function readSkills(root: string, source: string): Skill[] {
  const out: Skill[] = []
  if (!existsSync(root)) return out
  const walk = (d: string, depth: number) => {
    if (depth > 6) return // a skill tree is shallow; deeper is someone else's node_modules
    let entries: string[]
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e)
      let s
      try {
        s = statSync(p)
      } catch {
        continue
      }
      if (s.isDirectory()) {
        if (EXCLUDED_SEGMENTS.includes(e)) continue
        walk(p, depth + 1)
      } else if (e === "SKILL.md") {
        const rel = relative(root, p)
        if (rel.split(sep).some((seg) => EXCLUDED_SEGMENTS.includes(seg))) continue
        const id = rel.split(sep).slice(-2)[0] ?? rel
        if (SELF_REFERENTIAL.test(id)) continue
        try {
          const parsed = parseSkill(id, source, readFileSync(p, "utf8"))
          if (parsed) out.push(parsed)
        } catch {
          /* an unreadable skill is one fewer skill, never a failed run */
        }
      }
    }
  }
  walk(root, 0)
  return out
}

/** Words too common to carry signal. Matching on these is how everything scores 1. */
const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "are", "was", "has", "have",
  "add", "use", "using", "new", "not", "all", "any", "can", "will", "when", "what", "how",
  "code", "file", "files", "test", "tests", "run", "make", "set", "get", "its", "one", "two",
  "src", "lib", "app", "main", "index", "build", "update", "change", "support", "handle",
])

const tokens = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP.has(t))

/**
 * How well a skill matches an item, as a small integer.
 *
 * Weighted so that a deliberate signal outranks an accidental one:
 *   - a tag or the skill's own name matched  -> 3 (the author chose that word)
 *   - a description word matched             -> 1
 *
 * A model is deliberately NOT asked to do this. Selection runs per item on the hot path,
 * a model call here would cost as much as the work, and its judgement would be
 * unauditable - where this returns a number you can print.
 */
export type CorpusStats = { docFreq: Map<string, number>; total: number }

/** Document frequency per word: how many skills mention it at all. */
export function corpusStats(skills: Skill[]): CorpusStats {
  const docFreq = new Map<string, number>()
  for (const s of skills)
    for (const w of new Set([...tokens(s.name), ...tokens(s.description), ...s.tags.flatMap(tokens)]))
      docFreq.set(w, (docFreq.get(w) ?? 0) + 1)
  return { docFreq, total: skills.length }
}

export function scoreSkill(
  skill: Skill,
  itemTokens: Set<string>,
  stats: CorpusStats,
): { score: number; matched: string[] } {
  let score = 0
  const matched = new Set<string>()
  const weight = (t: string) => idf(stats.docFreq.get(t) ?? 0, stats.total)
  const strong = new Set([...tokens(skill.name), ...skill.tags.flatMap(tokens)])
  // A name or tag match is the author's own choice of word, so it carries three times the
  // weight of the same word appearing somewhere in prose.
  for (const t of strong)
    if (itemTokens.has(t)) {
      score += 3 * weight(t)
      matched.add(t)
    }
  for (const t of new Set(tokens(skill.description)))
    if (itemTokens.has(t) && !strong.has(t)) {
      score += weight(t)
      matched.add(t)
    }
  return { score, matched: [...matched] }
}

/**
 * The skills worth showing a worker for this item, best first.
 *
 * Returns [] when nothing clears MIN_SCORE, and that is the common case by design. A
 * worker handed three vaguely-related documents reads none of them and has lost the
 * budget that a genuinely relevant one would have used.
 */
export function selectSkills(
  skills: Skill[],
  item: { title: string; detail?: string; files?: string[] },
  opts: { budget?: number; max?: number; minScore?: number; minDistinct?: number; stats?: CorpusStats } = {},
): Skill[] {
  const budget = opts.budget ?? SKILLS_BUDGET_BYTES
  const max = opts.max ?? MAX_SKILLS
  const min = opts.minScore ?? MIN_SCORE

  const itemTokens = new Set(
    tokens([item.title, item.detail ?? "", ...(item.files ?? [])].join(" ")),
  )
  if (!itemTokens.size) return []

  const stats = opts.stats ?? corpusStats(skills)
  const distinct = opts.minDistinct ?? MIN_DISTINCT_MATCHES
  const scored = skills
    .map((s) => ({ s, ...scoreSkill(s, itemTokens, stats) }))
    // BOTH gates, and the second is the one that matters. Measured against the real
    // corpus: every wrong selection shared exactly ONE word with the item - an Ethereum
    // `evm-token-decimals` and an LLM `token-budget-advisor` both matched an OAuth bug on
    // "token", and `orch-fix-defect` matched it on "fix". Every right selection shared
    // several: `swiftui-patterns` matched swiftui+state+observable+navigation,
    // `security-review` matched security+review.
    //
    // IDF weighting alone cannot separate these, and is backwards here: "token" is rare
    // across the corpus (4 of 281) so it scores HIGH, which is exactly wrong. Rarity says
    // a word is discriminating; only corroboration says the skill is on topic.
    .filter((x) => x.score >= min && x.matched.length >= distinct)
    // Score first; then SMALLEST first among equals, because the budget is the binding
    // constraint and a 30KB skill that crowds out two focused ones is a bad trade.
    .sort((a, b) => b.score - a.score || a.s.bytes - b.s.bytes || a.s.id.localeCompare(b.s.id))

  const out: Skill[] = []
  let spent = 0
  for (const { s } of scored) {
    if (out.length >= max) break
    if (spent + s.bytes > budget) continue
    out.push(s)
    spent += s.bytes
  }
  return out
}

/**
 * The selected skills, as a prompt block.
 *
 * Same subordination as the conventions block: these are reference material from other
 * projects, and the repo being edited outranks them. A skill that contradicts local
 * practice must lose, and saying so costs one line.
 */
export function renderSkills(skills: Skill[]): string {
  if (!skills.length) return ""
  return [
    "<skills>",
    "Reference procedures that may apply to this item. They are background, not",
    "instructions: where one disagrees with this repo's own files or existing code, THE",
    "REPO WINS. Do not follow a skill that does not fit the work, and do not widen the",
    "item's scope to use one.",
    "",
    ...skills.map((s) => `<skill name="${s.name}" source="${s.source}">\n${s.body}\n</skill>`),
    "</skills>",
  ].join("\n")
}

/**
 * Every skill root worth reading on this machine.
 *
 * ECC is the corpus that matters: 281 documented procedures. dsh contributes a handful of
 * genuinely portable ones (its office-document skills) - the rest of its SKILL.md files
 * are snapshot fixtures or describe how to develop dsh itself, and are excluded above.
 */
export function skillRoots(eccRoot?: string, dshRoot?: string): { root: string; source: string }[] {
  const roots: { root: string; source: string }[] = []
  if (eccRoot) roots.push({ root: join(eccRoot, "skills"), source: "ECC" })
  if (dshRoot) roots.push({ root: join(dshRoot, "packages", "skill"), source: "dsh" })
  return roots.filter((r) => existsSync(r.root))
}

/**
 * End to end: the skills block for one item, or "" when nothing is clearly relevant.
 *
 * Never throws. Skills are an enhancement; a missing corpus costs the worker some
 * background reading and must never cost the run.
 */
export function skillsFor(
  item: { title: string; detail?: string; files?: string[] },
  roots: { root: string; source: string }[],
  opts?: { budget?: number; max?: number; minScore?: number; minDistinct?: number; stats?: CorpusStats },
): string {
  try {
    const all = roots.flatMap((r) => readSkills(r.root, r.source))
    return renderSkills(selectSkills(all, item, opts))
  } catch {
    return ""
  }
}
