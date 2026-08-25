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
  /**
   * Measured, never read off a catalogue flag.
   * `schema`: forced-tool-call structured output - every council lane needs it.
   * `agentic`: drives tools in a session - the implementer needs it.
   * Two members fail the first while passing the second, and their 400s name the cause:
   * only `tool_choice: "auto"` is supported.
   */
  capability?: ("schema" | "agentic")[]
  /**
   * The vendor's own capability/cost class. NEVER derived from `ms`: that is latency on a
   * trivial call, and Luna - the tier built for speed - measured SLOWEST of the gpt-5.6
   * three. Latency ranks queue noise, not capability.
   */
  tier?: "deep" | "standard" | "fast"
}

/**
 * Capability is MEASURED, not assumed (D11): a model that fails the forced-tool-call smoke
 * test does not get a fallback path, it gets `capability: ["agentic"]` and no lane. Latency
 * numbers below were re-measured 2026-08-25 and are timeout inputs only - never a quality
 * or tier signal.
 */
export const ROSTER: Member[] = [
  { slug: "opus5",     model: "anthropic/claude-opus-5",                roles: ["reviewer", "security"],   ms: 4263, capability: ["schema", "agentic"] },
  { slug: "fable",     model: "anthropic/claude-fable-5",               roles: ["security", "skeptic"],    ms: 6704 },
  { slug: "kimik3",    model: "kimi-for-coding/k3",                     roles: ["code"],                   ms: 21151 },
  // The requested quota fallback: when kimi-for-coding/k3 hits its billing-cycle limit, the
  // code lane substitutes here first (same role) before borrowing another model. Measured
  // 2026-08-23: emits schema-valid structured output, 6782ms on a trivial task.
  { slug: "kimik3go",  model: "opencode-go/kimi-k3",                    roles: ["code"],                   ms: 6782 },
  { slug: "gemini36",  model: "google/gemini-3.6-flash",                roles: ["breadth", "docs"],        ms: 9028 },
  { slug: "grok45",    model: "opencode-go/grok-4.5",                   roles: ["systems", "skeptic"],     ms: 7146 },
  { slug: "mimo",      model: "opencode-go/mimo-v2.5-pro",              roles: ["pragmatist", "skeptic"],  ms: 7027 },
  { slug: "minimax",   model: "opencode-go/minimax-m3",                 roles: ["reviewer", "skeptic"],    ms: 4532 },
  { slug: "nemoultra", model: "opencode/nemotron-3-ultra-free",         roles: ["reviewer", "systems", "breadth"], ms: 7307, free: true },
  { slug: "nemolight", model: "opencode/nemotron-3.5-lightning-free",   roles: ["skeptic", "qa", "ops"],   ms: 4672, free: true },
  // Implementer class: chats and drives tools fine, 400s on a *named* tool_choice with
  // `only "auto" is supported`. Same cause as deepseek below. No lane, by measurement.
  { slug: "musespark", model: "opencode/muse-spark-1.2-contributor-free", roles: [],                       ms: 8000, free: true, capability: ["agentic"] },
  // The paid route, not `opencode/hy3-free`: the free one returned `malformed` 3/3 on
  // 2026-08-23, this one holds the schema at 6.1s.
  { slug: "hy3",       model: "opencode-go/hy3",                         roles: ["qa", "ops"],              ms: 6117 },
  // openai's three are TIERS, not variants - peak / balanced / fast.
  { slug: "gpt56sol",   model: "openai/gpt-5.6-sol",   roles: ["security", "systems"],
    ms: 3696, tier: "deep",     capability: ["schema", "agentic"] },
  { slug: "gpt56terra", model: "openai/gpt-5.6-terra", roles: ["product", "reviewer", "docs"],
    ms: 2664, tier: "standard", capability: ["schema", "agentic"] },
  // carries `skeptic` on purpose: skepticPool filters on that role, so without it the fast
  // tier is unreachable from the highest-volume loop in the system.
  { slug: "gpt56luna",  model: "openai/gpt-5.6-luna",  roles: ["reviewer", "qa", "skeptic"],
    ms: 4228, tier: "fast",     capability: ["schema", "agentic"] },
  { slug: "glm53", model: "zai-coding-plan/glm-5.3", roles: ["systems", "reviewer"],
    ms: 6007, capability: ["schema", "agentic"] },
  // Implementer class: drives tools, refuses a named schema call.
  { slug: "deepseek", model: "deepseek/deepseek-v4-pro", roles: [], ms: 9459, capability: ["agentic"] },
]

export const canSchema = (m: Member) => (m.capability ?? ["schema"]).includes("schema")
export const canAgentic = (m: Member) => (m.capability ?? ["schema"]).includes("agentic")

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

/** Every role a repo's crew block may legally name. Lives here, not in crew.ts, so the
 *  roster suite can assert on it without importing a 2000-line module. */
export const KNOWN_ROLES: string[] = [...ALL_ROLES, "skeptic"]

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
    const candidates = ROSTER.filter((m) => m.roles.includes(role) && canSchema(m)).sort(
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
  return ROSTER.filter((m) => m.roles.includes("skeptic") && canSchema(m) && !excludeSlugs.includes(m.slug))
    .sort((a, b) => a.ms - b.ms)
    .slice(0, count)
}

export const SKEPTICS_PER_TIER = { BLOCKER: 3, SUGGESTION: 2, NIT: 0 } as const
