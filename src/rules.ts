// ECC's rule library, selected by the files an item actually touches.
//
// ECC (Everything Claude Code) ships ~122 rule files: language conventions, security
// standards, review checklists. They are good, and they are 285KB — sending them whole
// would cost roughly 70k tokens on EVERY implementer prompt, which is more than the work
// item, the repo instructions and the diff combined. That is not a rule library, it is a
// context leak.
//
// The thing that makes selection possible is that ECC's own rules declare their scope, in
// YAML frontmatter:
//
//     ---
//     paths:
//       - "(doublestar)/*.tsx"
//       - "(doublestar)/*.css"
//     ---
//
// 111 of 122 files carry it. So a work item that touches `src/api.ts` can be given the
// TypeScript rules and not the Swift, Ruby, Dart and ArkTS ones. Selection is by glob
// match against the item's predicted files, and the total is capped — a rule the worker
// never reads is indistinguishable from one that does not exist, except in cost.
//
// Unscoped rules (`rules/common/*`) are NOT included by default. They are the largest and
// most general files, they apply to everything and therefore discriminate nothing, and
// the repo's own AGENTS.md is already carrying house rules on every prompt.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

/** Total rule text allowed into one prompt. */
export const RULES_BUDGET_BYTES = 24_000

/** Directory of ECC rules, relative to an ECC checkout. */
const RULES_DIR = "rules"

export type Rule = {
  /** path relative to the rules dir, e.g. "typescript/style.md" */
  name: string
  /** glob patterns from the frontmatter; empty means unscoped */
  paths: string[]
  body: string
  bytes: number
}

/**
 * Parse the `paths:` list out of leading YAML frontmatter.
 *
 * Hand-rolled, and flat on purpose: this reads one list of strings from a fenced block,
 * which is the same reasoning the lets block parser gives for not taking a YAML
 * dependency. A file with no frontmatter is a valid unscoped rule, not an error.
 */
export function parseRule(name: string, text: string): Rule {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { name, paths: [], body: text, bytes: Buffer.byteLength(text) }
  const body = text.slice(m[0].length)
  const paths: string[] = []
  let inPaths = false
  for (const line of m[1].split(/\r?\n/)) {
    if (/^paths:\s*$/.test(line)) {
      inPaths = true
      continue
    }
    if (inPaths) {
      const item = /^\s*-\s*["']?(.+?)["']?\s*$/.exec(line)
      if (item) {
        paths.push(item[1])
        continue
      }
      // A non-list line ends the block. Anything else at column 0 is the next key.
      if (/^\S/.test(line)) inPaths = false
    }
  }
  return { name, paths, body, bytes: Buffer.byteLength(body) }
}

/**
 * Glob match, limited to what ECC's frontmatter actually uses: `**` across directories,
 * `*` within a segment, and literal text.
 *
 * Deliberately not a glob dependency. The patterns in the corpus are all of the form
 * a doublestar directory prefix plus an extension, and a regex translation of those is a dozen lines that
 * cannot surprise us at runtime.
 */
export function matchesGlob(pattern: string, path: string): boolean {
  // ONE pass, left to right. Chained .replace() calls cannot do this correctly: the `**/`
  // step emits `(?:.*/)?`, and the later `*` step then rewrote the `.*` INSIDE that
  // output into `.[^/]*`, so that pattern silently compiled to a pattern requiring a
  // one-character directory name and matched nothing in the real corpus. Measured
  // against ECC's 111 scoped rules: 0 matches before, correct matches after.
  let rx = ""
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // a doublestar directory component may match nothing at all, which is what lets a doublestar-prefixed pattern match a root-level
        // `a.ts` — the same top-level-file trap that leaked a repo-root .env elsewhere in
        // this codebase.
        if (pattern[i + 2] === "/") {
          rx += "(?:.*/)?"
          i += 2
        } else {
          rx += ".*"
          i += 1
        }
      } else rx += "[^/]*"
    } else if (c === "?") rx += "[^/]"
    else if (".+^${}()|[]\\".includes(c)) rx += `\\${c}`
    else rx += c
  }
  return new RegExp(`^${rx}$`).test(path)
}

/** Read every rule under an ECC checkout. Returns [] when there is no rules dir. */
export function readRules(eccRoot: string): Rule[] {
  const dir = join(eccRoot, RULES_DIR)
  if (!existsSync(dir)) return []
  const out: Rule[] = []
  const walk = (d: string) => {
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
      if (s.isDirectory()) walk(p)
      else if (e.endsWith(".md") && e !== "README.md") {
        try {
          out.push(parseRule(relative(dir, p), readFileSync(p, "utf8")))
        } catch {
          /* an unreadable rule is one fewer rule, never a failed run */
        }
      }
    }
  }
  walk(dir)
  return out
}

/**
 * Frameworks whose rules claim a language's whole extension, and the evidence that has to
 * exist in the repo before they are believed.
 *
 * ECC's frontmatter over-claims, measured 2026-09-20: `rules/react-native/*` and
 * `rules/arkts/*` both declare `paths: ["**` + `/*.ts"]`, so selecting for a plain
 * `src/lets.ts` in a Node CLI pulled in React Native, Vue and HarmonyOS conventions. That
 * is worse than sending nothing — a worker told to mind Expo's navigation lifecycle while
 * editing a git worktree is being actively misled, and the budget spent on it crowds out
 * the rules that do apply.
 *
 * The fix cannot live in the glob: `**` + `/*.ts` genuinely does match the file. It needs
 * a second signal, so a framework's rules are admitted only when the repo shows some
 * trace of that framework. Keyed by the rule's top directory, checked against the
 * manifest text plus the repo's own file names.
 */
const FRAMEWORK_EVIDENCE: Record<string, RegExp> = {
  "react-native": /react-native|expo/i,
  react: /"react"|react-dom|\.jsx|\.tsx/i,
  vue: /"vue"|\.vue\b/i,
  nuxt: /"nuxt"/i,
  angular: /@angular\//i,
  arkts: /\.ets\b|oh-package|harmonyos/i,
  nextjs: /"next"/i,
  svelte: /"svelte"|\.svelte\b/i,
}

/**
 * Evidence text for the framework check: the repo's manifests, plus the item's own files.
 *
 * Cheap and bounded — a few manifest reads, not a tree walk. An unreadable manifest is
 * simply absent evidence, which fails closed: the framework's rules are not included.
 */
export function frameworkEvidence(repoRoot: string | undefined, files: string[]): string {
  const parts = [...files]
  if (repoRoot) {
    for (const name of ["package.json", "oh-package.json5", "pubspec.yaml", "Cargo.toml"]) {
      try {
        const p = join(repoRoot, name)
        if (existsSync(p)) parts.push(readFileSync(p, "utf8"))
      } catch {
        /* absent evidence, not an error */
      }
    }
  }
  return parts.join("\n")
}

/**
 * The rules that apply to these files, smallest first, within budget.
 *
 * Smallest first because the budget is the binding constraint: three focused 4KB rules
 * beat one 20KB one that crowds them out, and a rule the worker never reaches costs the
 * same as one that does not exist.
 *
 * An unscoped rule is never selected. Those are the broadest files in the corpus, they
 * match every item equally and so distinguish nothing, and the repo's own AGENTS.md
 * already rides on every prompt with the house rules that actually apply here.
 *
 * `evidence` gates the framework families above. Omit it and they are all excluded —
 * failing closed, because a wrong convention is worse than a missing one.
 */
export function selectRules(
  rules: Rule[],
  files: string[],
  budget = RULES_BUDGET_BYTES,
  evidence = "",
): Rule[] {
  if (!files.length) return []
  const hits = rules.filter((r) => {
    if (r.paths.length === 0) return false
    if (!files.some((f) => r.paths.some((p) => matchesGlob(p, f)))) return false
    const family = r.name.split("/")[0]
    const needs = FRAMEWORK_EVIDENCE[family]
    return !needs || needs.test(evidence)
  })
  hits.sort((a, b) => a.bytes - b.bytes || a.name.localeCompare(b.name))
  const out: Rule[] = []
  let spent = 0
  for (const r of hits) {
    if (spent + r.bytes > budget) continue // skip, do not stop: a later rule may still fit
    out.push(r)
    spent += r.bytes
  }
  return out
}

/**
 * The selected rules, as a prompt block.
 *
 * Labelled as conventions rather than instructions, and explicitly subordinated to the
 * repo's own files. A rule library from another project must never outrank the AGENTS.md
 * of the repo being edited — when they disagree, the repo wins, and saying so is cheaper
 * than discovering it in a review.
 */
export function renderRules(rules: Rule[]): string {
  if (!rules.length) return ""
  return [
    "<conventions source=\"ECC\">",
    "General engineering conventions for the kinds of file this item touches. They are",
    "background, not instructions: where they disagree with this repo's own AGENTS.md,",
    "CLAUDE.md or existing code, THE REPO WINS. Do not restructure existing code to match",
    "them, and do not expand the item's scope to satisfy one.",
    "",
    ...rules.map((r) => `<convention name="${r.name}">\n${r.body.trim()}\n</convention>`),
    "</conventions>",
  ].join("\n")
}

/**
 * End to end: the conventions block for one item's files, or "" when there are none.
 *
 * Never throws. Rules are an enhancement; a missing or broken ECC checkout costs the
 * worker some background advice, and must never cost the run.
 */
export function conventionsFor(
  eccRoot: string | undefined,
  files: string[],
  budget = RULES_BUDGET_BYTES,
  repoRoot?: string,
): string {
  if (!eccRoot || !files.length) return ""
  try {
    return renderRules(selectRules(readRules(eccRoot), files, budget, frameworkEvidence(repoRoot, files)))
  } catch {
    return ""
  }
}
