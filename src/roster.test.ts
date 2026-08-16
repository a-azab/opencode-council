import { test } from "node:test"
import assert from "node:assert/strict"
import {
  selectRoles,
  selectNodes,
  skepticPool,
  ROSTER,
  PRAGMATIST_LINE_THRESHOLD,
  MODELS_PER_ROLE,
} from "./roster.ts"

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
  assert.equal(nodes.filter((n) => n.role === "code").length, 1) // only kimik3 has `code`
})

test("selection prefers models not already used this round", () => {
  // reviewer and systems overlap on glm52; the second role should reach past it
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

test("every roster role is answerable by at least one model", () => {
  const roles = new Set(ROSTER.flatMap((m) => m.roles))
  for (const r of ["security", "systems", "code", "reviewer", "skeptic", "docs", "qa", "ops", "product", "breadth", "pragmatist"])
    assert.ok(roles.has(r as any), `no model can serve role: ${r}`)
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
