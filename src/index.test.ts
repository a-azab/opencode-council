import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
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
  const { tool, config } = await load()
  for (const c of ["crew:plan", "crew:init", "crew:execute", "crew:status"])
    assert.ok(config.command[c]?.template?.length > 100, `command ${c} missing or empty`)
  // A command is only half an entry point: /crew:status tells the agent to call the tool
  // with mode 'status', so the enum has to accept it or the command fails at the call.
  for (const m of ["init", "plan", "run", "status"])
    assert.ok(tool.crew.args.mode.safeParse(m).success, `crew rejects mode '${m}'`)
})

test("status answers in a repo with no crew config, and writes nothing", async () => {
  // Placement, not output: the branch sits above the config lookup on purpose. A repo whose
  // config was never written or was removed is exactly where worktrees get stranded, so
  // demanding config here would withhold the list from the repos that need it most.
  const dir = mkdtempSync(join(tmpdir(), "crew-status-"))
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir })
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir })
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir })
    // resolveScope reads HEAD, which does not resolve until there is a commit.
    execFileSync("git", ["commit", "-qm", "init", "--allow-empty"], { cwd: dir })
    const { tool } = await load()
    const out = await tool.crew.execute({ mode: "status" }, { directory: dir })

    assert.match(out, /No live crew worktrees/)
    assert.doesNotMatch(out, /crew:init/, "status demanded config it does not need")
    // Read-only query: it must not call artifactDir.
    assert.ok(!existsSync(join(dir, "council-artifacts")), "status created an artifact directory")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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

test("the council tool accepts task mode and a context argument", async () => {
  const { tool } = await load()
  assert.ok(tool.council.args.mode.safeParse("task").success, "mode enum must accept 'task'")
  assert.ok(tool.council.args.context, "context is a new arg, used by task and independent")
})

test("every council command registers under its colon name", async () => {
  // The mirror of the negative grep test: that one proves no stale name survives, this
  // proves the new ones actually load. A command file whose name is wrong is silently
  // absent, never an error.
  const { config } = await load()
  for (const c of ["council:review", "council:fix", "council:plan", "council:independent", "council:check", "council:task"])
    assert.ok(config.command[c]?.template?.length > 100, `command ${c} missing or empty`)
})

test("no live file still refers to a pre-colon council name", () => {
  // The likely failure of a rename is a dangling cross-reference, not a missing file.
  //
  // Two exclusions, both load-bearing. Match the five exact names and never the bare
  // `/council-` prefix: that also hits the legitimate "/council-work" message below, the
  // 12 agent/council-*.md files, and the `council-${role}` literals in engine.ts. And skip
  // *.test.ts: this very file must contain the old names to search for them, so scanning
  // itself would make the test permanently red.
  const OLD = ["/council-review", "/council-fix", "/council-plan", "/council-independent", "/check"]
  const files = [
    ...readdirSync(join(PKG, "command")).map((f) => `command/${f}`),
    ...readdirSync(join(PKG, "src")).map((f) => `src/${f}`),
    "README.md",
  ].filter((f) => /\.(md|ts)$/.test(f) && !f.endsWith(".test.ts"))

  const offenders: string[] = []
  for (const rel of files) {
    const text = readFileSync(join(PKG, rel), "utf8")
    for (const name of OLD) {
      // (?![\w-]) so /checkout and /check-in are left alone; end-of-line counts as a match.
      if (new RegExp(`${name.replace("/", "\\/")}(?![\\w-])`).test(text)) offenders.push(`${rel} → ${name}`)
    }
  }
  assert.deepEqual(offenders, [], `stale command references:\n${offenders.join("\n")}`)
})

test("council reviews the whole panel with debate; crew keeps routing and 0 rounds", async () => {
  // The real call sites need a live fan-out and this suite mocks nothing
  // (tool.test.ts:14 - "Only paths that return BEFORE any model call are exercised here"),
  // so the values are asserted through the pure seam index.ts reads, plus source text for
  // the crew side.
  const { councilArgs } = await import("./engine.ts")
  const { ALL_ROLES } = await import("./roster.ts")
  assert.deepEqual(councilArgs().roles, ALL_ROLES, "council must wake every lane")
  assert.equal(councilArgs().maxRounds, 2, "council must debate")

  const engine = readFileSync(join(PKG, "src/engine.ts"), "utf8")
  assert.match(engine, /DEFAULT_MAX_ROUNDS = 0/, "crew inherits this default; it must stay 0")

  const crew = readFileSync(join(PKG, "src/crew.ts"), "utf8")
  const call = crew.slice(crew.indexOf("runReview(ctx, {"), crew.indexOf("runReview(ctx, {") + 200)
  assert.doesNotMatch(call, /maxRounds|roles:/,
    "crew's review must inherit both defaults, or every crew run costs a council run")
})
