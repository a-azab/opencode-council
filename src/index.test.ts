import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import plugin from "./index.ts"

// This file exists because of a real failure: deleting `work` mode with index-based string
// slicing merged `council`'s args into `lets` and removed the `council` tool outright - and
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
  assert.deepEqual(Object.keys(tool).sort(), ["council", "lets"])
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
  for (const name of ["council", "lets"])
    assert.ok(config.experimental.primary_tools.includes(name), `${name} is not a primary tool`)
})

test("the spawned-worker deny rule names the tools that actually exist", () => {
  // The SECOND confinement control, and the one with no other coverage. engine.ts denies
  // each tool BY NAME so a worker it spawns cannot re-enter it and recurse. Rename a tool
  // and miss this string and the deny silently stops matching - it guards nothing, and
  // nothing fails. Source-text assertion, following the precedent below that reads
  // engine.ts the same way; a live check would need a server this suite refuses to call.
  const engine = readFileSync(join(PKG, "src/engine.ts"), "utf8")
  for (const name of ["council", "lets"])
    assert.match(engine, new RegExp(`permission: "${name}"`), `${name} is not denied to workers`)
  assert.doesNotMatch(engine, /permission: "crew"/,
    "a deny rule for a tool that no longer exists guards nothing")
})

test("every agent file is registered and read-only unless it opts in", async () => {
  const { config } = await load()
  const agents = Object.keys(config.agent)
  for (const required of ["lets-cpo", "lets-cto", "lets-dev", "council-skeptic", "council-reviewer"])
    assert.ok(agents.includes(required), `missing agent: ${required}`)

  for (const [name, a] of Object.entries<any>(config.agent)) {
    if (name === "lets-dev") continue
    assert.equal(a.permission.edit, "deny", `${name} can edit; only lets-dev may, and only in a worktree`)
    assert.equal(a.permission.bash, "deny", `${name} can run commands`)
  }
})

test("lets-dev is the one agent granted tools, via its own frontmatter", async () => {
  // The grant is safe only because runItem pins its session to a worktree. If this ever
  // becomes true for an agent that is called without a `directory`, it edits the user's
  // actual checkout.
  const { config } = await load()
  assert.deepEqual(config.agent["lets-dev"].permission, { edit: "allow", bash: "allow" })
})

test("commands are registered for every lets entry point", async () => {
  const { tool, config } = await load()
  for (const c of ["lets:plan", "lets:init", "lets:execute", "lets:status"])
    assert.ok(config.command[c]?.template?.length > 100, `command ${c} missing or empty`)
  // A command is only half an entry point: /lets:status tells the agent to call the tool
  // with mode 'status', so the enum has to accept it or the command fails at the call.
  for (const m of ["init", "plan", "run", "status"])
    assert.ok(tool.lets.args.mode.safeParse(m).success, `lets rejects mode '${m}'`)
})

test("status answers in a repo with no lets config, and writes nothing", async () => {
  // Placement, not output: the branch sits above the config lookup on purpose. A repo whose
  // config was never written or was removed is exactly where worktrees get stranded, so
  // demanding config here would withhold the list from the repos that need it most.
  const dir = mkdtempSync(join(tmpdir(), "lets-status-"))
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir })
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir })
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir })
    // resolveScope reads HEAD, which does not resolve until there is a commit.
    execFileSync("git", ["commit", "-qm", "init", "--allow-empty"], { cwd: dir })
    const { tool } = await load()
    const out = await tool.lets.execute({ mode: "status" }, { directory: dir })

    assert.match(out, /No live lets worktrees/)
    assert.doesNotMatch(out, /lets:init/, "status demanded config it does not need")
    // Read-only query: it must not call artifactDir.
    assert.ok(!existsSync(join(dir, "council-artifacts")), "status created an artifact directory")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("work mode is gone from every surface", async () => {
  // Lets is a strict superset. Leaving `work` registered anywhere means two implement
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

test("the council tool accepts models mode", async () => {
  const { tool } = await load()
  assert.ok(tool.council.args.mode.safeParse("models").success)
})

test("every council command registers under its colon name", async () => {
  // The mirror of the negative grep test: that one proves no stale name survives, this
  // proves the new ones actually load. A command file whose name is wrong is silently
  // absent, never an error.
  const { config } = await load()
  for (const c of ["council:review", "council:fix", "council:plan", "council:independent", "council:check", "council:task", "council:models"])
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

test("council reviews the whole panel with debate; lets keeps routing and 0 rounds", async () => {
  // The real call sites need a live fan-out and this suite mocks nothing
  // (tool.test.ts:14 - "Only paths that return BEFORE any model call are exercised here"),
  // so the values are asserted through the pure seam index.ts reads, plus source text for
  // the lets side.
  const { councilArgs } = await import("./engine.ts")
  const { ALL_ROLES } = await import("./roster.ts")
  assert.deepEqual(councilArgs().roles, ALL_ROLES, "council must wake every lane")
  assert.equal(councilArgs().maxRounds, 2, "council must debate")

  const engine = readFileSync(join(PKG, "src/engine.ts"), "utf8")
  assert.match(engine, /DEFAULT_MAX_ROUNDS = 0/, "lets inherits this default; it must stay 0")

  const lets = readFileSync(join(PKG, "src/lets.ts"), "utf8")
  const call = lets.slice(lets.indexOf("runReview(ctx, {"), lets.indexOf("runReview(ctx, {") + 200)
  assert.doesNotMatch(call, /maxRounds|roles:/,
    "the lets review must inherit both defaults, or every lets run costs a council run")
})

test("no module still imports the pre-rename pipeline", () => {
  // No build step: a stale `from "./lets.ts"` is a runtime module-not-found, not a compile
  // error. tool.test.ts uses a DYNAMIC import, which a static-import grep misses - so match
  // the string. Excludes THIS file, which must contain the string in order to search for it.
  const offenders = readdirSync(join(PKG, "src"))
    .filter((f) => f.endsWith(".ts") && f !== "index.test.ts")
    .filter((f) => /["'`]\.\/crew\.ts["'`]/.test(readFileSync(join(PKG, "src", f), "utf8")))
  assert.deepEqual(offenders, [], `stale ./crew.ts imports: ${offenders.join(", ")}`)
})

test("no command still tells the model to call a tool named crew", () => {
  // Every command file invokes the tool by BARE name - "Call the `crew` tool with ..." -
  // with no colon. A guard matching `crew:` command names sails past all four, and the
  // result is every command instructing the model to call a tool that does not exist:
  // a silent no-op, never an error.
  const offenders = readdirSync(join(PKG, "command"))
    .filter((f) => /`crew` tool/.test(readFileSync(join(PKG, "command", f), "utf8")))
  assert.deepEqual(offenders, [], `commands invoking a dead tool: ${offenders.join(", ")}`)
})

test("no pre-rename crew: command name survives", () => {
  // Test TITLES trip this too - three exist today. That is correct: a title naming a
  // command that no longer exists is a lie about its own coverage.
  const files = [
    ...readdirSync(join(PKG, "command")).map((f) => `command/${f}`),
    ...readdirSync(join(PKG, "src")).map((f) => `src/${f}`),
    "README.md",
  ].filter((f) => /\.(md|ts)$/.test(f) && !f.endsWith("index.test.ts"))
  const offenders = files.filter((rel) =>
    /\/crew:(init|plan|execute|status)(?![\w-])/.test(readFileSync(join(PKG, rel), "utf8")))
  assert.deepEqual(offenders, [], `stale crew: command refs: ${offenders.join(", ")}`)
})
