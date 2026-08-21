import { test } from "node:test"
import assert from "node:assert/strict"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import plugin from "./index.ts"

// This file exists because of a real failure: deleting `work` mode with index-based string
// slicing merged `council`'s args into `crew` and removed the `council` tool outright - and
// all 82 tests still passed, because nothing loaded the plugin. A tool that silently stops
// being registered is invisible to a test suite that only ever imports modules.

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))

async function load() {
  const p = await plugin({ directory: PKG })
  const config: any = {}
  await p.config(config)
  return { tool: p.tool as Record<string, any>, config }
}

test("both tools are registered", async () => {
  const { tool } = await load()
  assert.deepEqual(Object.keys(tool).sort(), ["council", "crew"])
})

test("every tool has a description and an executable entry point", async () => {
  const { tool } = await load()
  for (const [name, t] of Object.entries(tool)) {
    assert.ok(t.description?.length > 40, `${name} needs a description the model can route on`)
    assert.equal(typeof t.execute, "function", `${name} has no execute`)
    assert.ok(t.args?.mode, `${name} has no mode arg`)
  }
})

test("both tools are primary, so subagents cannot recurse into them", async () => {
  const { config } = await load()
  for (const name of ["council", "crew"])
    assert.ok(config.experimental.primary_tools.includes(name), `${name} is not a primary tool`)
})

test("every agent file is registered and read-only unless it opts in", async () => {
  const { config } = await load()
  const agents = Object.keys(config.agent)
  for (const required of ["crew-cpo", "crew-cto", "crew-dev", "council-skeptic", "council-reviewer"])
    assert.ok(agents.includes(required), `missing agent: ${required}`)

  for (const [name, a] of Object.entries<any>(config.agent)) {
    if (name === "crew-dev") continue
    assert.equal(a.permission.edit, "deny", `${name} can edit; only crew-dev may, and only in a worktree`)
    assert.equal(a.permission.bash, "deny", `${name} can run commands`)
  }
})

test("crew-dev is the one agent granted tools, via its own frontmatter", async () => {
  // The grant is safe only because runItem pins its session to a worktree. If this ever
  // becomes true for an agent that is called without a `directory`, it edits the user's
  // actual checkout.
  const { config } = await load()
  assert.deepEqual(config.agent["crew-dev"].permission, { edit: "allow", bash: "allow" })
})

test("commands are registered for every crew entry point", async () => {
  const { config } = await load()
  for (const c of ["crew", "crew-init", "crew-run"])
    assert.ok(config.command[c]?.template?.length > 100, `command ${c} missing or empty`)
})

test("work mode is gone from every surface", async () => {
  // Crew is a strict superset. Leaving `work` registered anywhere means two implement
  // loops to maintain and a user guessing which one to run.
  const { tool, config } = await load()
  assert.ok(!("work" in config.command), "the /council-work command still exists")
  assert.ok(
    !JSON.stringify(tool.council.args.mode).includes("work"),
    "council still advertises a work mode",
  )
})
