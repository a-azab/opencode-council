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

test("all three tools are registered", async () => {
  const { tool } = await load()
  assert.deepEqual(Object.keys(tool).sort(), ["council", "crew", "lets"])
})

test("every tool has a description and an executable entry point", async () => {
  const { tool } = await load()
  for (const [name, t] of Object.entries(tool)) {
    assert.ok(t.description?.length > 40, `${name} needs a description the model can route on`)
    assert.equal(typeof t.execute, "function", `${name} has no execute`)
    assert.ok(t.args?.mode, `${name} has no mode arg`)
  }
})

test("all three tools are primary, so subagents cannot recurse into them", async () => {
  const { config } = await load()
  for (const name of ["council", "crew", "lets"])
    assert.ok(config.experimental.primary_tools.includes(name), `${name} is not a primary tool`)
})

test("the spawned-worker deny rule names the tools that actually exist", () => {
  // The SECOND confinement control, and the one with no other coverage. engine.ts denies
  // each tool BY NAME so a worker it spawns cannot re-enter it and recurse. Rename a tool
  // and miss this string and the deny silently stops matching - it guards nothing, and
  // nothing fails. Source-text assertion, following the precedent below that reads
  // engine.ts the same way; a live check would need a server this suite refuses to call.
  const engine = readFileSync(join(PKG, "src/engine.ts"), "utf8")
  // `crew` is back on this list, and the inverse assertion that used to sit here is gone.
  // It read "a deny rule for a tool that no longer exists guards nothing" - true while crew
  // was the pre-rename pipeline's dead name, and false the moment crew became a real tool
  // that spawns workers. Leaving it would have FORBIDDEN the confinement rule that stops a
  // crew-spawned worker re-entering crew and recursing.
  for (const name of ["council", "crew", "lets"])
    assert.match(engine, new RegExp(`permission: "${name}"`), `${name} is not denied to workers`)
})

test("every agent file is registered and read-only unless it opts in", async () => {
  const { config } = await load()
  const agents = Object.keys(config.agent)
  for (const required of ["lets-cpo", "lets-cto", "lets-dev", "council-skeptic", "council-reviewer", "council-ciso"])
    assert.ok(agents.includes(required), `missing agent: ${required}`)

  for (const [name, a] of Object.entries<any>(config.agent)) {
    if (name === "lets-dev") continue
    assert.equal(a.permission.edit, "deny", `${name} can edit; only lets-dev may, and only in a worktree`)
    assert.equal(a.permission.bash, "deny", `${name} can run commands`)
  }
})

test("every council lane has an agent file behind it", async () => {
  // engine.ts spawns `council-${node.role}` by string. A role in ALL_ROLES with no agent
  // file asks opencode for an agent that does not exist - the lane fails at the call, not
  // at load, so nothing here would notice until a real review ran. Self-maintaining: it
  // covers any lane added later, not just the one that prompted it.
  const { config } = await load()
  const { ALL_ROLES } = await import("./roster.ts")
  for (const role of ALL_ROLES)
    assert.ok(config.agent[`council-${role}`], `role '${role}' has no agent/council-${role}.md`)
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
  for (const c of ["lets:plan", "lets:init", "lets:execute", "lets:worktree"])
    assert.ok(config.command[c]?.template?.length > 100, `command ${c} missing or empty`)
  // A command is only half an entry point: /lets:worktree tells the agent to call the tool
  // with mode 'status', so the enum has to accept it or the command fails at the call.
  // (It was /lets:status until the session spine landed and took that name for the orient
  // snapshot, which is what /lets:status means in the LETS plugin this ports from.)
  for (const m of ["init", "plan", "run", "status"])
    assert.ok(tool.lets.args.mode.safeParse(m).success, `lets rejects mode '${m}'`)
})

test("the worktree list kept a slash command when status was repurposed", async () => {
  // The tool's `mode: "status"` is still the only way to find a stranded worktree, and a
  // capability reachable only by direct tool call is a capability users stop finding. This
  // asserts the relocation, not just that some file exists: exactly one command may drive
  // that mode, and /lets:status must no longer be it.
  const { config } = await load()
  assert.match(config.command["lets:worktree"].template, /mode: "status"/)
  assert.doesNotMatch(
    config.command["lets:status"].template,
    /mode: "status"/,
    "/lets:status is the orient snapshot now; it must not also drive the worktree list",
  )
  assert.match(config.command["lets:status"].template, /lets-orient/)
})

test("every lets session command registers", async () => {
  // The spine is the continuity half of lets: a session you start and end, with context
  // surviving across sessions. Each of these is a separate file, and a command file whose
  // name is wrong is silently absent rather than an error.
  const { config } = await load()
  for (const c of ["lets:start", "lets:status", "lets:end", "lets:note"])
    assert.ok(config.command[c]?.template?.length > 100, `${c} missing or empty`)
})

test("every lets work-loop command registers", async () => {
  // The spine is start/end; this is the loop between them - commit, done, and the backlog
  // that chooses what to work on next. Same failure mode as the spine test above: a command
  // file whose name is wrong is silently absent, never an error.
  const { config } = await load()
  for (const c of ["lets:commit", "lets:done", "lets:backlog"])
    assert.ok(config.command[c]?.template?.length > 100, `${c} missing or empty`)
})

test("every delegating lets command registers and points somewhere real", async () => {
  const { config } = await load()
  for (const c of ["lets:check", "lets:review", "lets:opinion", "lets:ask", "lets:research", "lets:team"])
    assert.ok(config.command[c]?.template?.length > 100, `${c} missing or empty`)
  // A delegating command that names a command which does not exist is worse than no
  // command at all - it sends the user somewhere that will silently do nothing.
  const names = new Set(Object.keys(config.command))
  for (const [c, target] of [["lets:check","council:check"], ["lets:review","council:review"],
                             ["lets:opinion","council:plan"], ["lets:ask","council:task"]])
    assert.ok(names.has(target), `${c} delegates to ${target}, which is not registered`)
})

test("the ADR has a named author in crew, and exists at all in lets", async () => {
  // crew:plan already REQUIRED an ADR - the tool refuses without one (index.ts ~473) - but
  // said nothing about who writes it or when. A required artifact with no owner gets
  // written by whoever notices, which is nobody, and the refusal then gets satisfied with
  // a stub. Naming the architect is the fix: the role that owns the design owns its record.
  const { config } = await load()
  const crew = config.command["crew:plan"].template
  assert.match(crew, /architect/i, "crew:plan does not say who writes the ADR")
  assert.match(crew, /ADR/, "crew:plan lost the ADR step entirely")

  // lets has a human gate, so this is not a refusal - but the plan the human approves
  // should arrive with its reasoning recorded, not just its task list.
  const lets = config.command["lets:plan"].template
  assert.match(lets, /ADR/, "lets:plan never mentions an ADR")
  assert.match(
    lets,
    /docs\/adr\/YYYY-MM-DD-/,
    "date-slug, never a sequential number: 0007- races when parallel tasks write decisions",
  )
})

test("crew:execute hands the docs to the tech writer, as a job and not a gate", async () => {
  // Crew ships code unattended; without this step it ships code and leaves the docs
  // describing the previous version. The framing is load-bearing, not decoration: a
  // documentation step written as a gate is the first thing dropped when a run is long,
  // whereas a team member's job is simply part of the work.
  const { config } = await load()
  const x = config.command["crew:execute"].template
  assert.match(x, /tech writer/i, "no documentation step: the docs are left describing the old behaviour")
  assert.match(x, /not a gate/i, "a documentation step that reads as a gate gets skipped under pressure")
})

test("no command file still claims a built command is unbuilt", () => {
  // The spine's footers were written before the work loop existed: each told the user
  // /lets:commit was "not built yet" and sent them to raw `git add -p` instead. It exists
  // now, so that line is a live falsehood sitting in the one part of a command's output the
  // user is guaranteed to read. Same failure shape as the stale-council-name test below - a
  // dangling cross-reference rather than a missing file - so it is guarded the same way.
  const offenders = readdirSync(join(PKG, "command"))
    .filter((f) => f.endsWith(".md"))
    .filter((f) => /not built yet/i.test(readFileSync(join(PKG, "command", f), "utf8")))
  assert.deepEqual(offenders, [], `stale "not built yet" claims in: ${offenders.join(", ")}`)
})

test("the plugin registers its own skills directory", async () => {
  // Skills are the session spine's shared logic - orient, detect-task, artifact-path,
  // session-snapshot. A command that invokes a skill opencode never registered fails at
  // the invocation, not at load, so an unregistered directory is silent until a user runs
  // /lets:start and gets nothing.
  const { config } = await load()
  assert.ok(
    config.skills.paths.some((p: string) => p.endsWith("/skills")),
    "the plugin's own skills/ directory is not on config.skills.paths",
  )
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

test("a planning panel can be aimed at the lanes PLANNING_ROLES leaves out", async () => {
  // A recruiting planner exists to ask the architect and infrastructure lanes, and the
  // default panel is precisely the five that exclude them. No model is called here: the
  // panel is picked from the roster before the first ask, so the pick is a pure seam.
  const { planPanel, PLANNING_ROLES } = await import("./engine.ts")

  assert.ok(
    !(PLANNING_ROLES as readonly string[]).includes("architect"),
    "fixture: the default panel is the one that excludes the lane we are aiming at",
  )

  const aimed = planPanel(["architect", "infrastructure"])
  assert.deepEqual(aimed.map((p) => p.role), ["architect", "infrastructure"])
  for (const p of aimed)
    assert.ok(p.member.roles.includes(p.role as any), `${p.member.slug} does not carry ${p.role}`)

  // Unset behaves exactly as today: the default panel, one model per lane, never twice.
  const fallback = planPanel(PLANNING_ROLES)
  assert.ok(fallback.length, "the default panel must not be empty")
  for (const p of fallback)
    assert.ok((PLANNING_ROLES as readonly string[]).includes(p.role), `${p.role} is not a planning lane`)
  assert.equal(
    new Set(fallback.map((p) => p.member.slug)).size,
    fallback.length,
    "one model must never sit on two lanes",
  )

  const engineSrc = readFileSync(join(PKG, "src/engine.ts"), "utf8")
  assert.match(engineSrc, /planPanel\(input\.roles \?\? PLANNING_ROLES\)/,
    "runPlan must fall back to PLANNING_ROLES, or today's callers change behaviour")
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

test("only crew's own commands invoke the crew tool, and they all do", () => {
  // This guard used to say NO command may invoke `crew`, because crew was the pre-rename
  // pipeline's dead name. crew is a real tool again, so the rule inverts rather than
  // relaxes: a lets/council command reaching into crew would cross the namespaces, and a
  // crew command that never calls the tool is prose that silently does nothing.
  const offenders = readdirSync(join(PKG, "command"))
    .filter((f) => !f.startsWith("crew:"))
    .filter((f) => /`crew` tool/.test(readFileSync(join(PKG, "command", f), "utf8")))
  assert.deepEqual(offenders, [], `non-crew commands invoking crew: ${offenders.join(", ")}`)

  for (const f of ["crew:plan.md", "crew:execute.md", "crew:status.md"])
    assert.match(readFileSync(join(PKG, "command", f), "utf8"), /`crew` tool/, `${f} never calls the crew tool`)
})

test("every /crew: reference names a command that exists", () => {
  // Stronger than the flat ban it replaces, and self-maintaining: while crew was dead the
  // rule was "no crew: refs at all"; now that three of them are real the useful rule is
  // that a reference must RESOLVE. /crew:init is caught by this for free - crew has no
  // init mode, it reuses the lets block.
  const names = new Set(
    readdirSync(join(PKG, "command")).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")),
  )
  const files = [
    ...readdirSync(join(PKG, "command")).map((f) => `command/${f}`),
    ...readdirSync(join(PKG, "src")).map((f) => `src/${f}`),
    "README.md",
  ].filter((f) => /\.(md|ts)$/.test(f) && !f.endsWith("index.test.ts"))
  const bad: string[] = []
  for (const rel of files)
    for (const m of readFileSync(join(PKG, rel), "utf8").matchAll(/\/crew:([\w-]+)/g))
      if (!names.has(`crew:${m[1]}`)) bad.push(`${rel} -> /crew:${m[1]}`)
  assert.deepEqual(bad, [], `references to crew commands that do not exist: ${bad.join(", ")}`)
})
