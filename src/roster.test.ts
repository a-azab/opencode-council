import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  selectRoles,
  selectNodes,
  essentialFirst,
  skepticPool,
  ROSTER,
  type Member,
  type Role,
  ALL_ROLES,
  KNOWN_ROLES,
  canSchema,
  preferFast,
  PRAGMATIST_LINE_THRESHOLD,
  MODELS_PER_ROLE,
  vendorOf,
} from "./roster.ts"
import { substitutesFor, type Bench } from "./engine.ts"

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
test("GPT-6 Astra participates in the architecture council", () => {
  const astra = ROSTER.find((m) => m.slug === "gpt6astra")
  assert.equal(astra?.model, "openai/gpt-6-astra")
  assert.ok(astra && canSchema(astra))
  // Not on a bare `selectNodes(["architect"])`: the per-role cap of 2 goes to the two
  // fastest candidates there, and astra is third by ms. It takes the lane the way it
  // runs in practice - mid-review, once the round has already spent the faster picks.
  assert.ok(selectNodes([...ALL_ROLES]).some((n) => n.slug === "gpt6astra"))
})

// Same shape failover.test.ts:10-11 builds: a round with a lane to cover.
const round = selectNodes(["code", "security"])
const codeNode = round.find((n) => n.role === "code")!

test("a docs-only change does not wake the security panel", () => {
  const roles = selectRoles(["docs/guide.md", "README.md"])
  assert.ok(roles.includes("docs"), `expected docs in ${roles}`)
  assert.ok(roles.includes("reviewer"))
  assert.ok(!roles.includes("security"), `security should not fire on docs: ${roles}`)
  assert.ok(!roles.includes("code"))
})

test("auth-shaped paths wake security", () => {
  assert.ok(selectRoles(["src/auth/session.ts"]).includes("security"))
  assert.ok(selectRoles(["lib/jwt_helper.go"]).includes("security"))
})

test("migrations wake systems and security", () => {
  const roles = selectRoles(["db/migrations/003_tokens.sql"])
  assert.ok(roles.includes("systems"))
  assert.ok(roles.includes("security"))
})

test("a terraform diff wakes infrastructure without costing more nodes", () => {
  const roles = selectRoles(["envs/prod/main.tf"])
  assert.ok(roles.includes("infrastructure"), "the specific role must win over generic ops")
  assert.ok(!roles.includes("ops"), "infrastructure REPLACES ops here; it does not add to it")
  assert.equal(selectNodes(roles).length, 7, "node count must stay flat")
})

test("reviewer always runs, even on an unrecognised path", () => {
  assert.deepEqual(selectRoles(["weird/thing.xyz"]), ["reviewer"])
})

test("pragmatist only joins above the line threshold", () => {
  const files = ["src/a.ts"]
  assert.ok(!selectRoles(files, PRAGMATIST_LINE_THRESHOLD).includes("pragmatist"))
  assert.ok(selectRoles(files, PRAGMATIST_LINE_THRESHOLD + 1).includes("pragmatist"))
})

test("security gets a wider panel than other roles", () => {
  const nodes = selectNodes(["security", "code"])
  assert.equal(nodes.filter((n) => n.role === "security").length, 3)
  // two carriers since kimik3go joined: kimi-for-coding primary, opencode-go the
  // billing-cycle fallback the user asked for. A lane with one model is a lane that
  // vanishes when that model's quota does.
  assert.equal(nodes.filter((n) => n.role === "code").length, 2)
})

test("selection prefers models not already used this round", () => {
  // reviewer and systems overlap on glm53 and nemoultra; the second role should reach past
  // whichever the first already took rather than doubling up on it
  const nodes = selectNodes(["reviewer", "systems"])
  const counts = new Map<string, number>()
  for (const n of nodes) counts.set(n.slug, (counts.get(n.slug) ?? 0) + 1)
  const reused = [...counts.entries()].filter(([, c]) => c > 1)
  assert.equal(reused.length, 0, `model reused across roles: ${JSON.stringify(reused)}`)
})

test("every role's model cap is actually satisfiable by the roster", () => {
  // Guards the mismatch this test suite already caught once: MODELS_PER_ROLE said security
  // deserved a panel of 3 while only two members carried the role, so the cap silently
  // under-delivered. A cap the roster cannot meet is a lie about coverage.
  for (const [role, cap] of Object.entries(MODELS_PER_ROLE)) {
    const capable = ROSTER.filter((m) => m.roles.includes(role as any)).length
    assert.ok(capable >= cap!, `role ${role} caps at ${cap} but only ${capable} models can serve it`)
  }
})

test("every role a config may name is answerable by some model", () => {
  // Derived from KNOWN_ROLES, not ALL_ROLES: ALL_ROLES deliberately omits `skeptic`, and
  // dropping that assertion would leave skepticPool, verifyGroup and fixOne's verifier
  // depending on a lane nothing is proven to carry.
  for (const role of KNOWN_ROLES) {
    const carriers = ROSTER.filter((m) => m.roles.includes(role as any) && canSchema(m))
    assert.ok(carriers.length, `no schema-capable model carries '${role}' — a silent empty lane`)
  }
})

test("techwriter is carried, and joining it never changed a model's voice", () => {
  // Two failures in one, both silent. A role no model carries is an empty lane that
  // recruits fine and answers nothing. And `roles[0]` is the voice a model speaks in
  // (engine.ts:1272 - `council-${voice(m)}`), so PREPENDING techwriter to a carrier would
  // quietly re-cast an existing member as the tech writer in runTask.
  const carriers = ROSTER.filter((m) => m.roles.includes("techwriter"))
  assert.ok(carriers.length, "no model carries 'techwriter' — a silently empty lane")
  for (const m of carriers) {
    assert.ok(canSchema(m), `${m.slug} carries techwriter but cannot emit structured output`)
    assert.notEqual(m.roles[0], "techwriter", `${m.slug}'s voice was displaced; append, never prepend`)
  }
})

test("ciso is carried, and never by a model that also carries security", () => {
  // Two silent failures in one. A role no model carries recruits fine and answers nothing.
  // And the correlation one, which is the entire reason this lane is separate from
  // `security`: selectNodes only DEPRIORITISES an already-used model, it does not forbid
  // one - so a security carrier holding `ciso` too would, on any diff waking both, be
  // handed both and write the governance finding in the voice that just wrote the attack.
  // The roster is the only place that can be prevented, so it is pinned here rather than
  // left to arithmetic that happens to work today.
  const carriers = ROSTER.filter((m) => m.roles.includes("ciso"))
  assert.ok(carriers.length, "no model carries 'ciso' — a silently empty lane")
  for (const m of carriers) {
    assert.ok(canSchema(m), `${m.slug} carries ciso but cannot emit structured output`)
    assert.ok(!m.roles.includes("security"), `${m.slug} carries ciso AND security; the lanes correlate`)
    assert.notEqual(m.roles[0], "ciso", `${m.slug}'s voice was displaced; append, never prepend`)
  }
})

test("a diff that wakes ciso alongside its neighbours still gets distinct models", () => {
  // The property the carrier rule above exists to buy, asserted behaviourally rather than
  // by proxy: an IAM path is the densest overlap in ROUTES - ciso, infrastructure,
  // security and reviewer all fire - so it is where a shared carrier collapses two lanes
  // into one opinion.
  //
  // Not vacuous, verified by mutation: moving `ciso` onto opus5 fails this with
  // `[["opus5",2]]`. The reason it bites is that `ciso` has exactly two carriers and the
  // default cap is two, so the cap truncates nothing and BOTH always run - the used-count
  // sort in selectNodes has no unused carrier left to prefer. A third carrier would be
  // spared by that sort, which is precisely why this guards the arithmetic and not just
  // the roster's role lists.
  const nodes = selectNodes(selectRoles(["infra/iam_policy.tf"]))
  assert.ok(nodes.some((n) => n.role === "ciso"), "fixture: this path must wake ciso")
  const counts = new Map<string, number>()
  for (const n of nodes) counts.set(n.slug, (counts.get(n.slug) ?? 0) + 1)
  const doubled = [...counts.entries()].filter(([, c]) => c > 1)
  assert.equal(doubled.length, 0, `a model answers two lanes on one diff: ${JSON.stringify(doubled)}`)
})

test("ciso wakes where governance lives, not on ordinary source", () => {
  const wakes = (f: string) => selectRoles([f]).includes("ciso")
  // access control, secrets, declared vendors, and the repo's own control surface
  for (const f of ["src/auth/session.ts", "infra/iam_policy.tf", "k8s/rbac.yaml",
                   ".env.production", "package.json", "go.mod", "docs/compliance/soc2.md"])
    assert.ok(wakes(f), `${f} should wake ciso: ${selectRoles([f]).join(", ")}`)

  // ...and nowhere else. `ciso` is deliberately absent from every source-code glob: "is
  // this exploitable" is the question the prompt forbids it to ask, so a plain source or
  // docs diff must not pay for the lane.
  for (const f of ["src/parser.ts", "lib/render.go", "docs/guide.md", "README.md",
                   "envs/prod/main.tf"])
    assert.ok(!wakes(f), `${f} woke ciso and should not: ${selectRoles([f]).join(", ")}`)

  // A lockfile is a transitive bump nobody decided; a manifest is someone choosing a
  // vendor. Only the second is a governance event, and conflating them would wake the lane
  // on every `npm install`.
  assert.ok(!wakes("package-lock.json"), "lockfile churn must not wake the lane")
  assert.ok(!wakes("go.sum"), "lockfile churn must not wake the lane")
})

test("the full panel is 27 nodes, and the ciso lane is 2 of them", () => {
  // ALL_ROLES is the most expensive path in the system and every role added is paid on
  // every full review. 23 → 25 when techwriter joined, 25 → 27 with ciso. Pinned as a
  // number because "it only adds a couple of nodes" is how the cost stops being noticed;
  // a future reader weighing whether to keep this lane needs the figure, not an adjective.
  assert.equal(selectNodes(ALL_ROLES).length, 27)
  assert.equal(selectNodes(ALL_ROLES).filter((n) => n.role === "ciso").length, 2)
})

test("skeptics never include the model that raised the finding", () => {
  const pool = skepticPool(["fable"], 3)
  assert.ok(!pool.some((m) => m.slug === "fable"))
  assert.equal(pool.length, 3)
})

test("skeptic pool returns fewer rather than reusing a model", () => {
  const all = ROSTER.filter((m) => m.roles.includes("skeptic")).map((m) => m.slug)
  const pool = skepticPool(all.slice(1), 3)
  assert.equal(pool.length, 1)
  assert.equal(new Set(pool.map((m) => m.slug)).size, pool.length)
})

test("volume loops rank the fast tier above a lower-ms member of another tier", () => {
  // Asserting `skepticPool([],3)[0].tier === "fast"` alone would be VACUOUS: gpt56luna is
  // also the lowest-ms skeptic carrier, so it already sorts first under the ms-only rule -
  // the test would pass before the change exists and keep passing if the rule were removed.
  // Test the rule itself, with a fast member that is SLOW by ms.
  const members = [
    { slug: "quick", tier: "standard", ms: 10 },
    { slug: "fast-tier", tier: "fast", ms: 9000 },
  ] as any
  assert.equal((preferFast(members) as any)[0].slug, "fast-tier",
    "tier is a measured capability class; ms is queue noise and must not outrank it")
})

test("the skeptic pool is actually wired to preferFast, not merely coincident with it", () => {
  // The behavioural test below cannot catch a regression here: gpt56luna is both the
  // fast-tier carrier AND the lowest-ms one, so un-routing skepticPool back to a plain ms
  // sort leaves every assertion green. Verified by mutation - reverting the call changed
  // no test outcome. Until a fast-tier skeptic exists that is not also fastest by ms, the
  // wiring needs pinning directly. Same technique the suite already uses for the lets
  // runReview call site.
  const src = readFileSync(join(PKG, "src/roster.ts"), "utf8")
  const fn = src.slice(src.indexOf("export function skepticPool"))
  const body = fn.slice(0, fn.indexOf("\n}"))
  assert.match(body, /preferFast/, "skepticPool must route through the tier rule")
})

test("the skeptic pool routes through it and still fills behind", () => {
  const pool = skepticPool([], 3)
  assert.equal(pool[0].tier, "fast")
  assert.ok(pool.length > 1, "the rest of the pool still fills behind the fast member")
})

test("a model that cannot emit structured output never reaches a schema lane", () => {
  // deepseek and muse-spark-free both 400 on a *named* tool_choice while driving tools
  // fine under `auto`. That boundary is exactly implementer vs council lane.
  const agenticOnly = ROSTER.filter((m) => !canSchema(m))
  assert.ok(agenticOnly.length, "fixture: the roster must contain an agentic-only member")
  const banned = new Set(agenticOnly.map((m) => m.slug))
  for (const n of selectNodes(ALL_ROLES)) assert.ok(!banned.has(n.slug), `${n.slug} in a lane`)
  for (const m of skepticPool([], 99)) assert.ok(!banned.has(m.slug), `${m.slug} as a skeptic`)
})

test("an agentic-only member is never offered as a substitute", () => {
  // The one site where `roles: []` does NOT protect: substitutesFor's tier 2 is
  // `byRole(false)`, i.e. "does not carry this role" - which is TRUE for every role when
  // roles is empty. Without the capability filter, deepseek is offered for every failed
  // lane and then handed FINDINGS_SCHEMA. No existing failover test catches it: the
  // exhaustion case benches deepseek, and the ordering case only checks free-before-busy.
  const bench: Bench = new Map()
  const offered = substitutesFor(codeNode, round, bench, new Set())
  for (const m of offered)
    assert.ok(canSchema(m), `${m.slug} cannot emit schema and must not cover a lane`)
})

test("the capability filter does not over-apply: prose lanes keep every model", () => {
  // runIndependent maps the WHOLE roster and passes NO schema (engine.ts ~889 - ask<string>,
  // prose read from message parts). deepseek answers there perfectly well; filtering it out
  // would silently shrink the panel with every test still green, because it is true by
  // construction today. This pins the boundary.
  const src = readFileSync(join(PKG, "src/engine.ts"), "utf8")
  const fn = src.slice(src.indexOf("export async function runIndependent"))
  const body = fn.slice(0, fn.indexOf("\n}"))
  assert.match(body, /ROSTER\.map/, "independent must fan out across the whole roster")
  assert.doesNotMatch(body, /canSchema/, "prose is not structured output; do not filter here")
})

test("every schema-capable member gets at least one node in a full panel", () => {
  // The roster invariant that replaced a rejected `everyModel` option: "all models on one
  // task" must be true by construction, and fail loudly if a roster edit breaks it.
  const covered = new Set(selectNodes(ALL_ROLES).map((n) => n.slug))
  // Lane-carrying members only. A member with `roles: []` is deliberately not a lane model -
  // it implements, or stands in - and demanding it hold a lane would push a roster edit into
  // declaring a capability the model was never measured to have, just to keep this green.
  for (const m of ROSTER.filter((m) => canSchema(m) && m.roles.length))
    assert.ok(covered.has(m.slug), `${m.slug} carries a lane but answers nothing`)
})

test("an essential member holds its lane even when the cap would drop it", () => {
  // fable is the SLOWEST security carrier (6704ms vs 4263/3696), so it sorts last and is
  // first to be dropped the moment a fourth carrier exists. It is in the lane today only
  // because carriers happen to equal the cap.
  const nodes = selectNodes(["security"])
  assert.ok(nodes.some((n) => n.slug === "fable"), "fable must always cover security")
})

test("the pin survives a fourth security carrier", () => {
  // The regression this exists to prevent. selectNodes reads the module-level ROSTER, so
  // rather than refactor it for injectability this asserts on BOTH halves of the wiring:
  //
  // 1. the arithmetic, against a roster with a fourth, faster carrier - the exact shape
  //    that drops fable today;
  // 2. that the live selection puts fable FIRST in the security lane. Under the ms sort
  //    fable is last (slowest of three); a cap only ever truncates the tail, so "first"
  //    means "survives every cap above zero" - which is the property the pin buys.
  const carrier = (slug: string, ms: number, essential?: Role[]): Member => ({
    slug, model: `test/${slug}`, roles: ["security"], ms, ...(essential ? { essential } : {}),
  })
  const withFourth = [
    carrier("fast1", 1000), carrier("fast2", 2000), carrier("fast3", 3000),
    carrier("fable", 6704, ["security"]),
  ].sort((a, b) => a.ms - b.ms)
  const picked = essentialFirst(withFourth, "security", 3)
  assert.ok(picked.some((m) => m.slug === "fable"), "a fourth carrier must not evict the pin")
  assert.equal(picked.length, 3, "the pin fills a cap slot, it does not widen the panel")
  assert.equal(picked[0].slug, "fable", "the pin is taken before the cap is spent")

  const security = selectNodes(["security"]).filter((n) => n.role === "security")
  assert.equal(security[0].slug, "fable", "fable must sort ahead of the cap-limited rest")
})

test("an essential member that cannot answer is not forced in", () => {
  // "always covers" is conditional on being able to. The pin picks from the pool it is
  // handed and never conjures a member into it, so anything filtered out upstream - not
  // canSchema, or benched by failover - stays out. Its absence is reported, not silent
  // (see report.ts).
  const pool: Member[] = [
    { slug: "a", model: "test/a", roles: ["security"], ms: 100 },
    { slug: "b", model: "test/b", roles: ["security"], ms: 200 },
  ]
  const picked = essentialFirst(pool, "security", 3)
  assert.ok(!picked.some((m) => m.slug === "fable"), "an absent pin must not be materialised")
  assert.ok(picked.every((m) => pool.includes(m)), "every pick comes from the pool it was given")

  // and the real roster's only non-schema members never reach a lane through the pin either
  const banned = new Set(ROSTER.filter((m) => !canSchema(m)).map((m) => m.slug))
  for (const n of selectNodes(ALL_ROLES)) assert.ok(!banned.has(n.slug), `${n.slug} pinned into a lane`)
})

test("essentials beyond the cap all run, and the cap loses", () => {
  // The deliberate inversion: a cap is a cost control, an essential reviewer is a
  // correctness requirement. Asserted because nothing in today's roster exercises it.
  const pins: Member[] = ["x", "y", "z"].map((slug) => ({
    slug, model: `test/${slug}`, roles: ["security"], ms: 100, essential: ["security"],
  }))
  assert.equal(essentialFirst([...pins, { slug: "q", model: "t/q", roles: ["security"], ms: 1 }], "security", 2).length, 3)
})

test("a schema change wakes the CISO — retention and classification live there", () => {
  // security reads a migration and correctly has nothing to say: adding a column is not
  // exploitable. The compliance question is the one nobody else asks - what personal data
  // do we now hold, for how long, and can we prove who read it. That is why the lane exists.
  const roles = selectRoles(["db/migrations/003_add_customer_pii.sql"])
  assert.ok(roles.includes("ciso"), "a migration must wake the compliance lane")
  assert.ok(roles.includes("security"), "and must not stop waking the adversarial one")
})

test("no model reviews the same diff wearing two hats", () => {
  // The panel's whole value is decorrelation: two lanes agreeing means two models agreed.
  // If one model holds both, the report shows two lanes and you have one opinion.
  //
  // This is why `code` and `infrastructure` carry a THIRD model each. A lane whose carrier
  // count equals its cap runs ALL of them, every time - so any model holding that lane plus
  // security was guaranteed to double up. Measured before the third carriers were added:
  // glm53 = security+infrastructure on a .tf diff, kimik3go = security+code on auth code.
  // With a third, the least-used sort routes around whoever security already took.
  const securityPaths = [
    "envs/prod/main.tf", "db/migrations/001.sql", "src/auth/session.ts",
    ".env.production", "src/pay.py",
  ]
  for (const path of securityPaths) {
    const held: Record<string, string[]> = {}
    for (const n of selectNodes(selectRoles([path]))) (held[n.slug] ??= []).push(n.role)
    const doubled = Object.entries(held).filter(([, roles]) => roles.length > 1)
    assert.deepEqual(doubled, [], `on ${path}: ${doubled.map(([s, r]) => `${s} holds ${r.join("+")}`).join(", ")}`)
  }
})

test("security is reviewed by the security specialists", () => {
  // The owner's call: fable (pinned essential), kimi and glm - not whichever generalists
  // happen to be most reliable.
  //
  // kimi is the CODING-PLAN route, with the opencode-go one as its named fallback rather
  // than as a second carrier. Both on the lane would not work: the ms sort would compare
  // 21151 against 6782 and pick the go route every time, so the coding plan would never be
  // used at all. As a fallback it is reached only when the plan hits its limit, which is
  // the intent.
  const carriers = ROSTER.filter((m) => m.roles.includes("security")).map((m) => m.slug).sort()
  assert.deepEqual(carriers, ["fable", "glm53", "kimik3"])
  assert.equal(ROSTER.find((m) => m.slug === "kimik3")?.fallback, "kimik3go",
    "the coding plan escapes to the go route when its quota runs out")
})

test("a panel is spread across vendors, not just across models", () => {
  // Measured 2026-09-20: plain fast-first ordering returned gpt-5.6-luna, minimax-m3 and
  // grok-4.6 - three distinct models but TWO behind `opencode-go`. That panel reads as
  // independent and is not: one gateway incident removes a two-thirds majority.
  const panel = skepticPool([], 3)
  assert.equal(panel.length, 3)
  const vendors = new Set(panel.map((m) => vendorOf(m.model)))
  assert.equal(vendors.size, 3, `got ${panel.map((m) => m.model).join(", ")}`)
})

test("a panel larger than the vendor count still fills", () => {
  // Three judges from two vendors still beats two judges.
  const panel = skepticPool([], 5)
  assert.equal(panel.length, 5)
  assert.equal(new Set(panel.map((m) => m.slug)).size, 5, "and never by repeating a member")
})
