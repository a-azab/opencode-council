// Roster and routing: pure data plus the selection arithmetic over it.
//
// The old council fired all ten models at every change, including a docs typo. Routing
// exists to spend models where they matter - it is a cost cut, not an addition.
import path from "node:path"

export type Role =
  | "security" | "systems" | "code" | "pragmatist" | "product"
  | "breadth" | "reviewer" | "docs" | "qa" | "ops" | "skeptic"
  | "architect" | "infrastructure" | "techwriter"

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
  /** Roles this member ALWAYS covers when it is available, ahead of the per-role cap.
   *  A cap is a cost control; an essential reviewer is a correctness requirement, so the
   *  pin wins. */
  essential?: Role[]
}

/**
 * Capability is MEASURED, not assumed (D11): a model that fails the forced-tool-call smoke
 * test does not get a fallback path, it gets `capability: ["agentic"]` and no lane. Latency
 * numbers below were re-measured 2026-08-25 and are timeout inputs only - never a quality
 * or tier signal.
 */
export const ROSTER: Member[] = [
  { slug: "opus5",     model: "anthropic/claude-opus-5",                roles: ["reviewer", "security", "architect"], ms: 4263, capability: ["schema", "agentic"] },
  // `essential` on security: fable is the SLOWEST of the three security carriers, so under
  // the (timesUsed, ms) sort it is last and would be the first dropped the moment a fourth
  // carrier joins. It is in the lane today by arithmetic coincidence - the pin makes it a
  // rule, so a roster edit cannot silently take the security panel's named reviewer out.
  { slug: "fable",     model: "anthropic/claude-fable-5",               roles: ["security", "skeptic"],    ms: 6704, essential: ["security"] },
  { slug: "kimik3",    model: "kimi-for-coding/k3",                     roles: ["code"],                   ms: 21151 },
  // The requested quota fallback: when kimi-for-coding/k3 hits its billing-cycle limit, the
  // code lane substitutes here first (same role) before borrowing another model. Measured
  // 2026-08-23: emits schema-valid structured output, 6782ms on a trivial task.
  { slug: "kimik3go",  model: "opencode-go/kimi-k3",                    roles: ["code"],                   ms: 6782 },
  // `techwriter` is APPENDED here and on gpt56terra, never prepended: roles[0] is the voice
  // a model answers in (engine.ts:1272), so prepending would re-cast an existing member.
  // Both already carry `docs`, which is the roster's existing statement that they are the
  // prose members, and both are schema-capable - the writing role still answers structured.
  { slug: "gemini36",  model: "google/gemini-3.6-flash",                roles: ["breadth", "docs", "techwriter"], ms: 9028 },
  { slug: "grok45",    model: "opencode-go/grok-4.5",                   roles: ["systems", "skeptic", "infrastructure"], ms: 7146 },
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
  { slug: "gpt56sol",   model: "openai/gpt-5.6-sol",   roles: ["security", "systems", "architect"],
    ms: 3696, tier: "deep",     capability: ["schema", "agentic"] },
  { slug: "gpt56terra", model: "openai/gpt-5.6-terra", roles: ["product", "reviewer", "docs", "techwriter"],
    ms: 2664, tier: "standard", capability: ["schema", "agentic"] },
  // carries `skeptic` on purpose: skepticPool filters on that role, so without it the fast
  // tier is unreachable from the highest-volume loop in the system.
  { slug: "gpt56luna",  model: "openai/gpt-5.6-luna",  roles: ["reviewer", "qa", "skeptic"],
    ms: 4228, tier: "fast",     capability: ["schema", "agentic"] },
  { slug: "glm53", model: "zai-coding-plan/glm-5.3", roles: ["systems", "reviewer", "infrastructure"],
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
  "architect", "infrastructure", "techwriter",
]

/** Every role a repo's lets block may legally name. Lives here, not in lets.ts, so the
 *  roster suite can assert on it without importing a 2000-line module. */
export const KNOWN_ROLES: string[] = [...ALL_ROLES, "skeptic"]

/** Changed-path globs to the roles they should wake. Ported from lets-workflow §4.1.
 *
 *  `techwriter` is deliberately NOT here, though it would look natural beside `docs` on the
 *  markdown routes. ROUTES wakes REVIEW lanes on a diff, and `docs` already reviews exactly
 *  that - statements a diff has made untrue. techwriter is an authoring role: it writes and
 *  repairs documentation as part of the work (`/crew:execute`), it does not second-opinion a
 *  markdown change. Adding it would put two prose models on every doc diff saying close to
 *  the same thing, which is the per-change cost ROUTES exists to hold down. It reaches a
 *  panel through ALL_ROLES, which is the "whole council" case, not the per-diff one. */
export const ROUTES: [string, Role[]][] = [
  // `infrastructure` REPLACES `ops` here rather than joining it: the specific lane covers
  // what the generic one would have said, and a swap keeps the node count flat.
  ["**/{Dockerfile,docker-compose*,Makefile,*.tf}", ["infrastructure", "security"]],
  ["**/*.tfvars", ["infrastructure", "security"]],
  ["**/k8s/**", ["infrastructure", "security"]],
  ["**/{terraform,infra,infrastructure}/**", ["infrastructure", "security"]],
  // CI and runtime config stay `ops`: a pipeline is not topology.
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
 * Members pinned to this role first, then the cap's remaining slots from the rest in the
 * order they arrived.
 *
 * If the pins alone exceed the cap, they ALL run and the cap is exceeded. That is a
 * deliberate inversion of the usual precedence: everywhere else the cap is the last word,
 * because it is a cost control - but an essential reviewer is a correctness requirement,
 * and correctness outranks cost.
 *
 * `candidates` arrives already filtered and sorted by the caller, and this only ever picks
 * out of it - so a member that cannot answer (not `canSchema`, or benched by failover) is
 * never here to be pinned back in. "Always covers" is conditional on being available; its
 * absence is reported rather than papered over (report.ts).
 */
export function essentialFirst(candidates: Member[], role: Role, cap: number): Member[] {
  const pinned = candidates.filter((m) => m.essential?.includes(role))
  const rest = candidates.filter((m) => !m.essential?.includes(role))
  return [...pinned, ...rest.slice(0, Math.max(0, cap - pinned.length))]
}

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
    for (const m of essentialFirst(candidates, role, cap)) {
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
 *
 * Ordered by `preferFast` because this is the highest-volume loop in the system - 3 calls
 * per BLOCKER, 2 per SUGGESTION, all of them shallow and repetitive, which is the work the
 * fast tier exists for. The slice is what makes the order matter: it decides who runs, not
 * merely who runs first.
 */
export function skepticPool(excludeSlugs: string[], count: number): Member[] {
  return preferFast(
    ROSTER.filter((m) => m.roles.includes("skeptic") && canSchema(m) && !excludeSlugs.includes(m.slug)),
  ).slice(0, count)
}

export const SKEPTICS_PER_TIER = { BLOCKER: 3, SUGGESTION: 2, NIT: 0 } as const

/** Fast tier first, then today's ms order. For the two high-volume, shallow loops:
 *  council:task's scoring pass, and skeptic verification. Degrades to the ms order when
 *  no fast-tier member exists. */
export const preferFast = <T extends { tier?: string; ms: number }>(xs: T[]): T[] =>
  [...xs].sort((a, b) => Number(b.tier === "fast") - Number(a.tier === "fast") || a.ms - b.ms)
