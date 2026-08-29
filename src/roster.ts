// Roster and routing: pure data plus the selection arithmetic over it.
//
// The old council fired all ten models at every change, including a docs typo. Routing
// exists to spend models where they matter - it is a cost cut, not an addition.
import path from "node:path"

export type Role =
  | "security" | "systems" | "code" | "pragmatist" | "product"
  | "breadth" | "reviewer" | "docs" | "qa" | "ops" | "skeptic"
  | "architect" | "infrastructure" | "techwriter" | "ciso"

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
  { slug: "opus5",     model: "anthropic/claude-opus-5",                roles: ["reviewer", "architect"], ms: 4263, capability: ["schema", "agentic"] },
  // `essential` on security: fable is the SLOWEST of the three security carriers, so under
  // the (timesUsed, ms) sort it is last and would be the first dropped the moment a fourth
  // carrier joins. It is in the lane today by arithmetic coincidence - the pin makes it a
  // rule, so a roster edit cannot silently take the security panel's named reviewer out.
  { slug: "fable",     model: "anthropic/claude-fable-5",               roles: ["security", "skeptic"],    ms: 6704, fallback: "opus5", essential: ["security"] },
  // The 2026-08-28 probe came back "you have reached your weekly (7-day) usage" and this
  // entry was written off as dead. It was a WEEKLY limit: re-probed 2026-08-29 it answered
  // schema-valid in 8687ms. A spent quota is a temporary state that reads exactly like a
  // permanent one, so "currently guaranteed to fail" belonged in a probe result, never in a
  // roster comment - it outlived the fact by one day and a 2026-08-29 incident report
  // repeated it as grounds for dropping this model from the implementer chain.
  //
  // `ms` stays at the 2026-08-28 figure deliberately. It is a timeout hint, where high is
  // merely conservative - but it is ALSO what `selectNodes` sorts carriers by, and lowering
  // it to 8687 would move this model ahead of gemini36 onto the `code` lane, where it would
  // then hold `code` and `security` at once and review an auth diff twice wearing two hats.
  // That arrangement was considered and declined on 2026-08-27.
  { slug: "kimik3",    model: "kimi-for-coding/k3",                     roles: ["code", "security"],                   ms: 21151, fallback: "kimik3go" },
  // The requested quota fallback: when kimi-for-coding/k3 hits its billing-cycle limit, the
  // code lane substitutes here first (same role) before borrowing another model. Measured
  // 2026-08-23: emits schema-valid structured output, 6782ms on a trivial task.
  { slug: "kimik3go",  model: "opencode-go/kimi-k3",                    roles: ["code"],                   ms: 6782, fallback: "gpt56sol" },
  // `techwriter` is APPENDED here and on gpt56terra, never prepended: roles[0] is the voice
  // a model answers in (engine.ts:1272), so prepending would re-cast an existing member.
  // Both already carry `docs`, which is the roster's existing statement that they are the
  // prose members, and both are schema-capable - the writing role still answers structured.
  { slug: "gemini36",  model: "google/gemini-3.6-flash",                roles: ["breadth", "docs", "techwriter", "code"], ms: 9028 },
  // Was `grok-4.5` until 2026-08-29, when a probe returned http 500 - the provider had
  // retired it and the pin had been dead for an unknown stretch, silently costing `systems`,
  // `skeptic` and `infrastructure` a member. Nothing caught it: a dead pin looks exactly like
  // a model having a bad day, and failover covers for it rather than complaining. `4.6` is
  // its replacement, measured 5741ms schema-valid the same day. This is the case
  // `/council:models` exists to surface - run it when a lane looks thin.
  { slug: "grok46",    model: "opencode-go/grok-4.6",                   roles: ["systems", "skeptic", "infrastructure"], ms: 5741 },
  // `ciso` carriers are mimo and minimax, and the choice is load-bearing rather than
  // spare-capacity: NEITHER CARRIES `security`.
  //
  // The mechanism, because it is not the obvious one. selectNodes deprioritises a model
  // already used this round, which is usually enough to keep two lanes on two voices - but
  // that only helps while there are unused carriers left to reach for. `ciso` has exactly
  // two carriers and DEFAULT_MODELS_PER_ROLE is two, so the cap never truncates anything:
  // BOTH CARRIERS ALWAYS RUN. A carrier that also carried `security` would therefore be
  // handed both lanes on every diff waking both - the governance finding written in the
  // voice that just wrote the attack, which is the one outcome the second lane was bought
  // to avoid. Measured, not assumed: putting `ciso` on opus5 yields `security:opus5` and
  // `ciso:opus5` in the same round on `src/auth/session.ts`. That is why opus5, gpt56sol
  // and fable are all excluded despite being the obvious strong-reasoning picks.
  //
  // glm53 was passed over on LOAD, not correlation - it already carries three lanes, and
  // as a third carrier the used-count sort would in fact have kept it out of a doubled
  // round. Load is the whole reason: mimo and minimax carry two lanes each, the lightest
  // schema members outside the code pair.
  //
  // Both are judgement lanes already: mimo's `pragmatist` weighs proportionality, which is
  // the risk arithmetic a CISO does. APPENDED, never prepended - roles[0] is the voice
  // (engine.ts:1272).
  { slug: "mimo",      model: "opencode-go/mimo-v2.5-pro",              roles: ["pragmatist", "skeptic", "ciso"],  ms: 7027 },
  // agentic MEASURED 2026-08-28: drove bash in a pinned worktree and returned the exact
  // marker, 10.4s. It sat in the implementer fallback on prior use alone until then.
  // `ciso` appended for the reason above: minimax is a `reviewer` - weighing whether a
  // claim actually holds is the same motion as judging a control gap - and at 4532ms it is
  // the fastest reviewer that does NOT normally win a reviewer slot (the cap of 2 goes to
  // gpt56terra/gpt56luna on ms), so the lane costs a model that was otherwise idle.
  { slug: "minimax",   model: "opencode-go/minimax-m3",                 roles: ["reviewer", "skeptic", "ciso"],    ms: 4532, capability: ["schema", "agentic"] },
  // `nemoultra` and `nemolight` were here until 2026-08-29, when a census probe found both
  // returning "[502] Upstream error" - 4 attempts each, persistent, and ~73s per failure.
  // A 502 in the message body classifies as `failed` with no statusCode, so it does NOT
  // retry; the cost was one slow failure per lane rather than three, which is why nothing
  // surfaced it. They held `reviewer, systems, breadth` and `skeptic, qa, ops`; removing
  // them left `breadth` and `ops` on a single carrier each, which is what this entry
  // restores.
  //
  // `big-pickle` is measured, not assumed: schema-valid in 3097ms on 2026-08-29, the same
  // bar every other member cleared to join. It is otherwise unproven, and it holds exactly
  // the two lanes that lost their second carrier - assigned on coverage, not on any claim
  // about what it is good at.
  { slug: "bigpickle", model: "opencode/big-pickle",                  roles: ["breadth", "ops"],         ms: 3097, free: true },
  // Implementer class: chats and drives tools fine, 400s on a *named* tool_choice with
  // `only "auto" is supported`. Same cause as deepseek below. No lane, by measurement.
  { slug: "musespark", model: "opencode/muse-spark-1.2-contributor-free", roles: [],                       ms: 8000, free: true, capability: ["agentic"] },
  // The paid route, not `opencode/hy3-free`: the free one returned `malformed` 3/3 on
  // 2026-08-23, this one holds the schema at 6.1s.
  { slug: "hy3",       model: "opencode-go/hy3",                         roles: ["qa", "ops"],              ms: 6117 },
  // openai's three are TIERS, not variants - peak / balanced / fast.
  { slug: "gpt56sol",   model: "openai/gpt-5.6-sol",   roles: ["systems", "architect", "infrastructure"],
    ms: 3696, tier: "deep",     capability: ["schema", "agentic"] },
  { slug: "gpt56terra", model: "openai/gpt-5.6-terra", roles: ["product", "reviewer", "docs", "techwriter"],
    ms: 2664, tier: "standard", capability: ["schema", "agentic"] },
  // carries `skeptic` on purpose: skepticPool filters on that role, so without it the fast
  // tier is unreachable from the highest-volume loop in the system.
  { slug: "gpt56luna",  model: "openai/gpt-5.6-luna",  roles: ["reviewer", "qa", "skeptic"],
    ms: 4228, tier: "fast",     capability: ["schema", "agentic"] },
  { slug: "glm53", model: "zai-coding-plan/glm-5.3", roles: ["systems", "reviewer", "infrastructure", "security"],
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
  "architect", "infrastructure", "techwriter", "ciso",
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
  // `ciso` rides along here because a schema change is where the obligations physically
  // live: what personal data we now hold, how long we may keep it, and whether the access
  // to it leaves a trail. A migration adding customer columns with no retention story is a
  // textbook control gap that `security` will correctly say nothing about - nothing in it
  // is exploitable. This was left out of the role's first introduction to keep it
  // conservative and added on the reasoning above, which is the one place the lane's own
  // ADR predicted it would be needed first.
  ["**/{migrations,migrate}/**", ["systems", "security", "ciso"]],
  ["**/*.sql", ["systems", "security"]],
  ["**/*.{py,go,java,rb,rs,php,cs}", ["code", "security"]],
  ["**/*.{ts,tsx,js,jsx,mjs,cjs,vue,svelte}", ["code"]],
  // `ciso` JOINS `security` here deliberately - this is the one place the two lanes are
  // pointed at the same file on purpose, and it is not a mirror. Security asks whether the
  // token can be forged; the CISO asks whether the access it grants is least privilege and
  // whether we could prove afterwards who used it. A correct auth check that writes no
  // audit record is a finding only one of them has.
  ["**/*{auth,session,token,login,passwd,password,crypto,secret,jwt,oauth}*", ["security", "ciso"]],
  ["**/*.{test,spec}.*", ["qa"]],
  ["**/{test,tests,__tests__,spec}/**", ["qa"]],
  ["**/*.{md,mdx,rst,txt}", ["docs"]],
  ["**/{docs,doc}/**", ["docs"]],
  ["**/.env*", ["security", "ops", "ciso"]],
  ["**/*.{yml,yaml,toml,ini,conf}", ["ops", "security"]],

  // ---- ciso-only routes. Deliberately NOT a copy of security's: `ciso` is absent from
  // every source-code glob above, because "is this code exploitable" is the question it is
  // explicitly told not to ask. It wakes where governance lives, not where bugs do.

  // Access control as a governed thing, and NARROWER than `*.tf` on purpose: routing every
  // terraform diff here would put the CISO on tag renames and keep the infrastructure lane
  // company for no added question. `iam`/`rbac`/`policy` in a path is an unambiguous
  // access-control artefact whatever the language - terraform, k8s, OPA, a policy JSON.
  // `role`/`roles` are excluded despite fitting: too common in ordinary source (`roles.ts`)
  // to carry the signal.
  ["**/*{iam,rbac,policy,policies,permission,permissions,authz}*", ["ciso"]],

  // A newly declared dependency is a new subprocessor: third-party exposure is the CISO's,
  // and nothing else in ROUTES looks at vendor risk. MANIFESTS ONLY, never lockfiles -
  // `package-lock.json` and `go.sum` churn on every transitive bump and would wake the lane
  // constantly for a decision nobody took. A manifest edit is someone CHOOSING a vendor.
  ["**/{package.json,requirements*.txt,go.mod,Gemfile,pom.xml,Cargo.toml,pyproject.toml,composer.json,build.gradle}", ["ciso"]],

  // The repo's own control surface. `docs` reviews these as prose; the CISO reads them as
  // the commitments every one of its other findings is measured against, so a change to
  // what we claim is precisely when it should look.
  ["**/{SECURITY.md,COMPLIANCE.md,PRIVACY.md}", ["ciso", "docs"]],
  ["**/{compliance,policies,policy,governance}/**", ["ciso", "docs"]],
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
