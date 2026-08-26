import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  selectRoles,
  selectNodes,
  skepticPool,
  ROSTER,
  ALL_ROLES,
  KNOWN_ROLES,
  canSchema,
  preferFast,
  PRAGMATIST_LINE_THRESHOLD,
  MODELS_PER_ROLE,
} from "./roster.ts"
import { substitutesFor, type Bench } from "./engine.ts"

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))
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
  assert.equal(preferFast(members)[0].slug, "fast-tier",
    "tier is a measured capability class; ms is queue noise and must not outrank it")
})

test("the skeptic pool is actually wired to preferFast, not merely coincident with it", () => {
  // The behavioural test below cannot catch a regression here: gpt56luna is both the
  // fast-tier carrier AND the lowest-ms one, so un-routing skepticPool back to a plain ms
  // sort leaves every assertion green. Verified by mutation - reverting the call changed
  // no test outcome. Until a fast-tier skeptic exists that is not also fastest by ms, the
  // wiring needs pinning directly. Same technique the suite already uses for crew's
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
  for (const m of ROSTER.filter(canSchema))
    assert.ok(covered.has(m.slug), `${m.slug} is in the roster but answers nothing`)
})
