// Roster and routing: pure data plus the selection arithmetic over it.
//
// The old council fired all ten models at every change, including a docs typo. Routing
// exists to spend models where they matter - it is a cost cut, not an addition.
import path from "node:path"

export type Role =
  | "security" | "systems" | "code" | "pragmatist" | "product"
  | "breadth" | "reviewer" | "docs" | "qa" | "ops" | "skeptic"

export type Member = {
  slug: string
  model: string
  roles: Role[]
  /** observed latency on a trivial structured task, ms - for timeouts, not quality */
  ms: number
  free?: boolean
}

/**
 * Every member below is CONFIRMED to emit schema-valid structured output (PLAN §7, measured
 * 2026-08-16). A model that fails the smoke test does not get a fallback path, it gets left
 * out (D11). deepseek and qwen are excluded with cause - see PLAN §5.
 */
export const ROSTER: Member[] = [
  { slug: "opus5",     model: "anthropic/claude-opus-5",                roles: ["reviewer", "security"],   ms: 4263 },
  { slug: "fable",     model: "anthropic/claude-fable-5",               roles: ["security", "skeptic"],    ms: 6704 },
  { slug: "gpt55",     model: "openai/gpt-5.5",                         roles: ["product", "reviewer", "security"], ms: 4369 },
  { slug: "glm52",     model: "zai-coding-plan/glm-5.2",                roles: ["systems", "reviewer"],    ms: 8403 },
  { slug: "kimik3",    model: "kimi-for-coding/k3",                     roles: ["code"],                   ms: 21151 },
  { slug: "gemini36",  model: "google/gemini-3.6-flash",                roles: ["breadth", "docs"],        ms: 9028 },
  { slug: "grok45",    model: "opencode-go/grok-4.5",                   roles: ["systems", "skeptic"],     ms: 7146 },
  { slug: "mimo",      model: "opencode-go/mimo-v2.5-pro",              roles: ["pragmatist", "skeptic"],  ms: 7027 },
  { slug: "minimax",   model: "opencode-go/minimax-m3",                 roles: ["reviewer", "skeptic"],    ms: 4532 },
  { slug: "nemoultra", model: "opencode/nemotron-3-ultra-free",         roles: ["reviewer", "systems"],    ms: 7307, free: true },
  { slug: "nemolight", model: "opencode/nemotron-3.5-lightning-free",   roles: ["skeptic", "qa", "ops"],   ms: 4672, free: true },
]

export const bySlug = (slug: string) => ROSTER.find((m) => m.slug === slug)

/**
 * Every lane, for when the caller wants the whole council rather than the lanes a diff's
 * filenames happen to wake. `skeptic` is excluded on purpose: it verifies findings that
 * already exist, it does not produce them.
 */
export const ALL_ROLES: Role[] = [
  "security", "systems", "code", "pragmatist", "product",
  "breadth", "reviewer", "docs", "qa", "ops",
]

/** Changed-path globs to the roles they should wake. Ported from lets-workflow §4.1. */
export const ROUTES: [string, Role[]][] = [
  ["**/{Dockerfile,docker-compose*,Makefile,*.tf}", ["ops", "security"]],
  ["**/.github/workflows/**", ["ops", "security"]],
  ["**/{migrations,migrate}/**", ["systems", "security"]],
  ["**/*.sql", ["systems", "security"]],
  ["**/*.{py,go,java,rb,rs,php,cs}", ["code", "security"]],
  ["**/*.{ts,tsx,js,jsx,mjs,cjs,vue,svelte}", ["code"]],
  ["**/*{auth,session,token,login,passwd,password,crypto,secret,jwt,oauth}*", ["security"]],
  ["**/*.{test,spec}.*", ["qa"]],
  ["**/{test,tests,__tests__,spec}/**", ["qa"]],
  ["**/*.{md,mdx,rst,txt}", ["docs"]],
  ["**/{docs,doc}/**", ["docs"]],
  ["**/.env*", ["security", "ops"]],
  ["**/*.{yml,yaml,toml,ini,conf}", ["ops", "security"]],
]

/** Large diffs get an over-engineering lens. Below this, it is not worth a model call. */
export const PRAGMATIST_LINE_THRESHOLD = 200

/** Diversity beats depth for verification, so security gets a wider panel than the rest. */
export const MODELS_PER_ROLE: Partial<Record<Role, number>> = { security: 3 }
export const DEFAULT_MODELS_PER_ROLE = 2

/**
 * `reviewer` always runs. lets-workflow's bias rule - "default is INCLUDE, only skip if
 * clearly irrelevant" - applied to the one role that is never irrelevant.
 */
export function selectRoles(files: string[], changedLines = 0): Role[] {
  const roles = new Set<Role>(["reviewer"])
  for (const file of files) {
    for (const [pattern, rs] of ROUTES) {
      if (path.matchesGlob(file, pattern)) rs.forEach((r) => roles.add(r))
    }
  }
  if (changedLines > PRAGMATIST_LINE_THRESHOLD) roles.add("pragmatist")
  return [...roles]
}

export type Node = { role: Role; slug: string; model: string }

/**
 * One node per (role, model). Models already used this round are deprioritised: two roles
 * answered by the same model are correlated, and correlation is the thing a multi-model
 * council is buying its way out of.
 */
export function selectNodes(roles: Role[]): Node[] {
  const nodes: Node[] = []
  const used = new Map<string, number>()
  // security first so the widest panel gets first pick of unused models
  const ordered = [...roles].sort((a, b) => (a === "security" ? -1 : b === "security" ? 1 : 0))

  for (const role of ordered) {
    const cap = MODELS_PER_ROLE[role] ?? DEFAULT_MODELS_PER_ROLE
    const candidates = ROSTER.filter((m) => m.roles.includes(role)).sort(
      (a, b) => (used.get(a.slug) ?? 0) - (used.get(b.slug) ?? 0) || a.ms - b.ms,
    )
    for (const m of candidates.slice(0, cap)) {
      nodes.push({ role, slug: m.slug, model: m.model })
      used.set(m.slug, (used.get(m.slug) ?? 0) + 1)
    }
  }
  return nodes
}

/**
 * Skeptics for one finding. Never the model that raised it - self-verification is not
 * verification, the same reason lets-workflow bars the architect from judging its own
 * design. Returns fewer than `count` rather than reusing a model; decide() treats thin
 * evidence as a reason to keep, so under-supplying is safe and over-supplying is not.
 */
export function skepticPool(excludeSlugs: string[], count: number): Member[] {
  return ROSTER.filter((m) => m.roles.includes("skeptic") && !excludeSlugs.includes(m.slug))
    .sort((a, b) => a.ms - b.ms)
    .slice(0, count)
}

export const SKEPTICS_PER_TIER = { BLOCKER: 3, SUGGESTION: 2, NIT: 0 } as const
