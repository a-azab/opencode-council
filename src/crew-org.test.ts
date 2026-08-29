import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { recruitFloor, integrate, renderCrewReport, type CrewResult, type CrewTask } from "./crew-org.ts"
import plugin from "./index.ts"

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..")

// ------------------------------------------------------------------ recruitFloor

test("recruitFloor wakes infrastructure and security for a terraform directive", () => {
  const roles = recruitFloor("provision the VPC subnets with terraform", ["node"])
  assert.ok(roles.includes("infrastructure"), `no infrastructure lane: ${roles.join(", ")}`)
  assert.ok(roles.includes("security"), `no security lane: ${roles.join(", ")}`)
})

test("recruitFloor wakes security on auth keywords alone", () => {
  for (const directive of [
    "rotate the jwt signing secret",
    "add oauth login to the dashboard",
    "stop logging the session token",
  ]) {
    const roles = recruitFloor(directive, ["node"])
    assert.ok(roles.includes("security"), `"${directive}" did not wake security: ${roles.join(", ")}`)
  }
})

test("recruitFloor always includes reviewer, even for a directive that routes nowhere", () => {
  // The floor's whole job: an unattended run has no human to notice an empty panel.
  // architect rides along unconditionally - crew:plan refuses without an ADR and the
  // architect writes it, so a mandatory document must never have a conditional author.
  const roles = recruitFloor("tidy up", [])
  assert.deepEqual(roles.sort(), ["architect", "reviewer"])
})

test("recruitFloor wakes qa for test work and architect for new structure", () => {
  assert.ok(recruitFloor("add tests for the parser", ["node"]).includes("qa"))
  assert.ok(recruitFloor("improve test coverage", []).includes("qa"))
  assert.ok(recruitFloor("extract a new service for billing", []).includes("architect"))
  assert.ok(recruitFloor("migrate the store to postgres", []).includes("architect"))
  // ...and it is there for ordinary work too. This assertion was previously inverted: the
  // architect was keyword-triggered, which left the ADR - a hard requirement of the tool -
  // with no assigned author whenever the regex missed. A record written by whoever happened
  // to be free is a summary, not a decision.
  assert.ok(recruitFloor("fix the typo in the readme", []).includes("architect"))
})

test("recruitFloor recruits the ciso on regulated ground", () => {
  // Two routes into the lane, and both are exercised here on purpose. The last directive
  // reaches `ciso` through ROUTES unaided (`iam` and `policy` are path-shaped words); the
  // rest only get there because AS_PATH translates regulatory vocabulary into the
  // compliance path first. If AS_PATH were dropped, the last one would still pass - so
  // testing only that shape would leave the translation untested.
  for (const directive of [
    "make the data export path GDPR compliant",
    "we need an audit trail for admin actions",
    "add PII redaction to the request logs",
    "set a retention window on the events table",
    "tighten the IAM policy on the deploy role",
  ])
    assert.ok(recruitFloor(directive, []).includes("ciso"), `"${directive}" did not recruit the ciso`)

  // ...and it does not ride along on ordinary work. The floor errs wide, not everywhere:
  // a lane on every directive is the cost ROUTES exists to hold down.
  assert.ok(!recruitFloor("speed up the parser", ["node"]).includes("ciso"))
  assert.ok(!recruitFloor("fix the typo in the readme", []).includes("ciso"))
})

test("recruitFloor reads the detected stack, not just the directive", () => {
  // `docker` is what detectStack actually emits; ROUTES only knows `Dockerfile`.
  assert.ok(recruitFloor("speed up the build", ["node", "docker"]).includes("infrastructure"))
})

// ------------------------------------------------------------------ integrate

function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "crew-int-"))
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" })
  g("init", "-q", "-b", "main")
  g("config", "user.email", "t@t")
  g("config", "user.name", "t")
  writeFileSync(join(dir, "shared.txt"), "base\n")
  g("add", "-A")
  g("commit", "-qm", "init")
  return dir
}

/** A branch off main that writes `content` to `file`. */
function branchWith(dir: string, name: string, file: string, content: string) {
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" })
  g("checkout", "-q", "-b", name, "main")
  writeFileSync(join(dir, file), content)
  g("add", "-A")
  g("commit", "-qm", `${name}: ${file}`)
  g("checkout", "-q", "main")
}

const gitOut = (dir: string, ...a: string[]) =>
  execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim()

test("integrate merges clean branches in order and reports them", () => {
  const dir = scratchRepo()
  try {
    branchWith(dir, "lets/a", "a.txt", "a\n")
    branchWith(dir, "lets/b", "b.txt", "b\n")
    branchWith(dir, "lets/c", "c.txt", "c\n")
    const r = integrate(dir, "main", ["lets/a", "lets/b", "lets/c"], "crew/int-1")
    assert.equal(r.ok, true)
    assert.equal(r.branch, "crew/int-1")
    assert.deepEqual(r.merged, ["lets/a", "lets/b", "lets/c"], "must report them in the order merged")
    // the branch really carries all three
    const files = gitOut(dir, "ls-tree", "--name-only", "crew/int-1").split("\n")
    for (const f of ["a.txt", "b.txt", "c.txt"]) assert.ok(files.includes(f), `${f} not on the branch`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("integrate stops at the first conflict and names the branch and the files", () => {
  // A conflict is EVIDENCE the scheduler wrongly judged two tasks independent. Resolving it
  // unattended would destroy that evidence, so the only correct behaviour is to stop.
  const dir = scratchRepo()
  try {
    branchWith(dir, "lets/a", "a.txt", "a\n")
    branchWith(dir, "lets/b", "shared.txt", "from b\n")
    branchWith(dir, "lets/c", "shared.txt", "from c\n")
    branchWith(dir, "lets/d", "d.txt", "d\n")
    const r = integrate(dir, "main", ["lets/a", "lets/b", "lets/c", "lets/d"], "crew/int-2")
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.conflicted, "lets/c", "must name the branch that could not merge")
    assert.deepEqual(r.merged, ["lets/a", "lets/b"], "must report exactly what got in before the stop")
    assert.deepEqual(r.files, ["shared.txt"], "must name the conflicted files")
    // and it must NOT have carried on past the conflict
    assert.ok(!r.merged.includes("lets/d"), "merging continued past a conflict")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("integrate leaves no half-merged state behind after a conflict", () => {
  const dir = scratchRepo()
  try {
    branchWith(dir, "lets/b", "shared.txt", "from b\n")
    branchWith(dir, "lets/c", "shared.txt", "from c\n")
    const r = integrate(dir, "main", ["lets/b", "lets/c"], "crew/int-3")
    assert.equal(r.ok, false)
    assert.equal(gitOut(dir, "status", "--porcelain"), "", "the user's checkout must be clean")
    assert.ok(!existsSync(join(dir, ".git", "MERGE_HEAD")), "a merge is still in progress")
    assert.ok(!existsSync(join(dir, ".worktrees", "integrate-crew-int-3")), "the scratch worktree was left behind")
    // the partial branch survives: what merged cleanly is evidence too
    assert.equal(gitOut(dir, "rev-parse", "--verify", "refs/heads/crew/int-3").length, 40)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("integrate refuses to clobber an existing branch", () => {
  const dir = scratchRepo()
  try {
    branchWith(dir, "crew/taken", "x.txt", "x\n")
    assert.throws(() => integrate(dir, "main", [], "crew/taken"), /already exists/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ renderCrewReport

const run = (over: Partial<CrewTask["run"] & object> = {}): NonNullable<CrewTask["run"]> =>
  ({
    branch: "lets/one",
    worktree: "/tmp/wt",
    outcomes: [{ item: { title: "do it", detail: "", files: [], acceptance: "" }, state: "done", attempts: 1, judged: true }],
    cycles: [],
    pushed: false,
    prSkipped: true,
    seconds: 12,
    stoppedBy: "complete",
    ...over,
  }) as any

const base = (over: Partial<CrewResult> = {}): CrewResult => ({
  directive: "do the thing",
  roles: ["reviewer"],
  scheduling: { mode: "graph", ungraphed: [], waves: 1 },
  tasks: [{ title: "One", slug: "one", wave: 1, run: run() }],
  integration: { ok: true, branch: "crew/int", merged: ["lets/one"] },
  verify: { ok: true, output: "ok" },
  adr: "docs/adr/x.md",
  ...over,
})

test("renderCrewReport calls a complete run complete", () => {
  const out = renderCrewReport(base())
  assert.match(out, /\*\*Complete\.\*\*/)
  assert.doesNotMatch(out, /INCOMPLETE/)
})

test("renderCrewReport says INCOMPLETE when a task never ran, and says why", () => {
  // The property the whole design rests on: with no approval gate, the report is the only
  // thing between the user and a bad decision.
  const out = renderCrewReport(
    base({
      tasks: [
        { title: "One", slug: "one", wave: 1, run: run() },
        { title: "Two", slug: "two", wave: 2, skipped: "wave 1 conflicted, so wave 2 was abandoned" },
      ],
    }),
  )
  assert.match(out, /INCOMPLETE/)
  assert.match(out, /never ran/i)
  assert.match(out, /Two/)
  assert.match(out, /wave 1 conflicted, so wave 2 was abandoned/, "a skipped task must carry its reason")
})

test("renderCrewReport says INCOMPLETE when a task ran but missed acceptance", () => {
  const out = renderCrewReport(
    base({
      tasks: [
        {
          title: "One", slug: "one", wave: 1,
          run: run({
            stoppedBy: "item-stuck",
            outcomes: [{ item: { title: "do it", detail: "", files: [], acceptance: "" }, state: "failed-check", attempts: 2 }],
          }),
        },
      ],
    }),
  )
  assert.match(out, /INCOMPLETE/)
  assert.match(out, /failed-check/)
  assert.match(out, /item-stuck/)
})

test("renderCrewReport reports an unjudged acceptance rather than passing it quietly", () => {
  const out = renderCrewReport(
    base({
      tasks: [
        {
          title: "One", slug: "one", wave: 1,
          run: run({
            outcomes: [{ item: { title: "do it", detail: "", files: [], acceptance: "" }, state: "done", attempts: 1, judged: false }],
          }),
        },
      ],
    }),
  )
  assert.match(out, /NOT independently judged/)
})

test("renderCrewReport says a suppressed PR was suppressed, not failed", () => {
  const out = renderCrewReport(base())
  assert.match(out, /No pull request was opened/)
  assert.match(out, /none was attempted/, "must distinguish suppressed from a failed push")
})

test("renderCrewReport surfaces a partial schedule and names the ungraphed files", () => {
  // Otherwise the user never learns why an 8-task run took 8 waves.
  const out = renderCrewReport(
    base({ scheduling: { mode: "partial", ungraphed: ["src/crew.ts", "src/new.ts"], waves: 2 } }),
  )
  assert.match(out, /partial/)
  assert.match(out, /src\/crew\.ts/)
  assert.match(out, /src\/new\.ts/)
  assert.match(out, /parallelises/, "must tell the user rebuilding the graph fixes it")
})

test("renderCrewReport surfaces a sequential schedule and its cause", () => {
  const out = renderCrewReport(base({ scheduling: { mode: "sequential", ungraphed: [], waves: 3 } }))
  assert.match(out, /sequential/)
  assert.match(out, /graph/i)
  assert.match(out, /parallelises/)
})

test("renderCrewReport reports an aborted integration with the conflicting files", () => {
  const out = renderCrewReport(
    base({
      integration: { ok: false, branch: "crew/int", merged: ["lets/one"], conflicted: "lets/two", files: ["shared.txt"] },
      verify: undefined,
    }),
  )
  assert.match(out, /INCOMPLETE/)
  assert.match(out, /lets\/two/)
  assert.match(out, /shared\.txt/)
  assert.match(out, /ABORTED, not resolved/)
})

test("renderCrewReport does not claim success when nothing was verified", () => {
  const out = renderCrewReport(base({ verify: undefined }))
  assert.match(out, /INCOMPLETE/)
  assert.match(out, /never verified/)
})

test("renderCrewReport says so when no ADR was recorded", () => {
  // The ADR is the requirements record; with no approval gate it is the only trace of what
  // the user actually asked for.
  const out = renderCrewReport(base({ adr: undefined }))
  assert.match(out, /No ADR/)
})

// ------------------------------------------------------------------ registration

async function load() {
  const p = await plugin({ directory: process.cwd() })
  const config: any = {}
  await p.config(config)
  return { tool: p.tool as Record<string, any>, config }
}

test("the crew tool registers all three modes in the zod enum AND the args union", async () => {
  const { tool } = await load()
  assert.ok(tool.crew, "the crew tool is not registered")
  for (const mode of ["plan", "execute", "status"])
    assert.ok(tool.crew.args.mode.safeParse(mode).success, `crew rejects mode '${mode}'`)
  assert.ok(!tool.crew.args.mode.safeParse("run").success, "crew accepts a mode it does not implement")

  // The inline `args` TS union is erased at runtime - type stripping is not typechecking -
  // so it can only be asserted as source text. A mode in the enum and missing from the union
  // (or the reverse) fails at exactly one layer, silently. Same idiom as the engine
  // deny-rule test in index.test.ts.
  const src = readFileSync(join(PKG, "src/index.ts"), "utf8")
  assert.match(
    src,
    /mode\?: "plan" \| "execute" \| "status"/,
    "the crew args TS union does not list exactly plan | execute | status",
  )
})

test("every crew command registers", async () => {
  const { config } = await load()
  for (const c of ["crew:plan", "crew:execute", "crew:status"])
    assert.ok(config.command[c]?.template?.length > 100, `${c} missing or empty`)
})

test("crew:plan states the interview bounds it is supposed to enforce", async () => {
  // The bound lives in the prompt, so an unbounded interview is a prompt regression that
  // nothing else in this suite would catch.
  const { config } = await load()
  const t = config.command["crew:plan"].template
  assert.match(t, /two rounds/i)
  assert.match(t, /four questions/i)
  assert.match(t, /`question` tool/, "the interview must use the question tool, not prose")
  assert.match(t, /websearch/i, "must warn that websearch does not exist here")
})

// ------------------------------------------------------------------ the tool's guards
//
// Same rationale as tool.test.ts: a tool whose entry point is never invoked is a tool with
// no tests. Only paths that return BEFORE any model call are exercised - those are the
// guards, and they are what has to hold when the arguments are wrong.

const crewTool = async () => (await load()).tool.crew

function toolRepo(withCfg = true): string {
  const dir = mkdtempSync(join(tmpdir(), "crew-tool-"))
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" })
  g("init", "-q", "-b", "main")
  g("config", "user.email", "t@t")
  g("config", "user.name", "t")
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "true" } }))
  if (withCfg)
    writeFileSync(join(dir, "AGENTS.md"), "# AGENTS\n\n```lets\nverify: npm test\nbase: main\nlanes: reviewer\n```\n")
  g("add", "-A")
  g("commit", "-qm", "init")
  return dir
}

const TASKS = JSON.stringify([
  { title: "First", items: [{ title: "a", detail: "", files: ["a.ts"], acceptance: "it works" }] },
])

test("every crew mode refuses outside a git repository", async () => {
  const crew = await crewTool()
  for (const mode of ["plan", "execute", "status"]) {
    const out = await crew.execute({ mode, directive: "x" }, { directory: "/" })
    assert.match(out, /not a git repository/i, `mode ${mode} did not refuse`)
  }
})

test("crew:status answers in a repo that was never initialised", async () => {
  const dir = toolRepo(false)
  try {
    const out = await (await crewTool()).execute({ mode: "status" }, { directory: dir })
    assert.match(out, /No crew plan recorded/)
    assert.ok(!existsSync(join(dir, "council-artifacts")), "status must write no artifacts")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("crew:plan and crew:execute refuse before the repo is initialised", async () => {
  const dir = toolRepo(false)
  try {
    const crew = await crewTool()
    for (const args of [{ mode: "plan", directive: "x", adr: "a.md", tasks: TASKS }, { mode: "execute" }])
      assert.match(await crew.execute(args, { directory: dir }), /lets:init/, `${args.mode} did not refuse`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("crew:plan refuses without an ADR", async () => {
  // With no approval gate the ADR is the only record of what was asked for, so a plan
  // without one cannot be audited afterwards. This is a hard refusal, not a warning.
  const dir = toolRepo()
  try {
    const out = await (await crewTool()).execute(
      { mode: "plan", directive: "do a thing", tasks: TASKS },
      { directory: dir },
    )
    assert.match(out, /needs `adr`/)
    assert.ok(!existsSync(join(dir, "council-artifacts")), "nothing may be recorded for a rejected plan")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("crew:plan refuses a decomposition it cannot use", async () => {
  const dir = toolRepo()
  try {
    const crew = await crewTool()
    const bad = [
      [{ tasks: "" }, /needs `tasks`/],
      [{ tasks: "{oops" }, /not valid JSON/],
      [{ tasks: JSON.stringify([{ title: "no items", items: [] }]) }, /no title or no items/],
      [{ tasks: JSON.stringify(Array.from({ length: 13 }, () => ({ title: "t", items: [{}] }))) }, /MAX_TASKS/],
    ] as const
    for (const [extra, expected] of bad) {
      const out = await crew.execute({ mode: "plan", directive: "x", adr: "a.md", ...extra }, { directory: dir })
      assert.match(out, expected)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("crew:plan refuses a dirty tree", async () => {
  const dir = toolRepo()
  writeFileSync(join(dir, "scratch.txt"), "uncommitted\n")
  try {
    const out = await (await crewTool()).execute(
      { mode: "plan", directive: "x", adr: "a.md", tasks: TASKS },
      { directory: dir },
    )
    assert.match(out, /uncommitted file/)
    assert.match(out, /scratch\.txt/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("crew:execute refuses when nothing has been planned", async () => {
  const dir = toolRepo()
  try {
    const out = await (await crewTool()).execute({ mode: "execute" }, { directory: dir })
    assert.match(out, /No crew plan found/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("crew:plan records a plan, and crew:status reads it back", async () => {
  // The whole plan path runs without a model, so the happy path is testable here.
  const dir = toolRepo()
  try {
    const crew = await crewTool()
    const out = await crew.execute(
      { mode: "plan", directive: "rotate the jwt signing secret", adr: "docs/adr/1.md", tasks: TASKS },
      { directory: dir },
    )
    assert.match(out, /No approval gate/)
    assert.match(out, /docs\/adr\/1\.md/)
    assert.match(out, /security/, "the lane floor must be recorded and shown")

    const status = await crew.execute({ mode: "status" }, { directory: dir })
    assert.match(status, /rotate the jwt signing secret/)
    assert.match(status, /1 task/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a crew plan is NEVER executable by `lets run`", async () => {
  // THE collision test. `crew-plan` is the pre-rename artifact kind for a LETS plan, and
  // index.ts still reads it as one: latestArtifact(root, ["lets-plan", "crew-plan"]). Had
  // crew written its plans under that kind, `/lets:run` would pick up a plan no human ever
  // approved and execute it with the implementer's edit+bash grant - which is precisely the
  // approval gate that distinguishes the two namespaces. Hence `crew-org-plan`.
  const dir = toolRepo()
  try {
    const { tool } = await load()
    await tool.crew.execute(
      { mode: "plan", directive: "exfiltrate", adr: "docs/adr/1.md", tasks: TASKS },
      { directory: dir },
    )
    const kinds = readdirSync(join(dir, "council-artifacts"))
    assert.ok(kinds.length === 1 && /-crew-org-plan$/.test(kinds[0]), `unexpected artifact kind: ${kinds.join(", ")}`)
    assert.ok(!kinds.some((k) => /-crew-plan$/.test(k)), "a crew plan must not use the lets legacy kind")

    const out = await tool.lets.execute({ mode: "run" }, { directory: dir })
    assert.match(out, /No approved plan/, "lets:run picked up a crew plan nobody approved")
    assert.ok(!out.includes("exfiltrate"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("lets:team no longer claims crew is unbuilt", async () => {
  const { config } = await load()
  const team = config.command["lets:team"].template
  assert.doesNotMatch(
    team,
    /has not been implemented|does not exist|not yet built|is not built|still ahead of us/i,
    "lets:team still calls crew unbuilt",
  )
  assert.match(team, /\/crew:plan/, "lets:team must point at the crew namespace now that it exists")
})


test("crew asks for one council on the integrated branch, not one per task", () => {
  // runExecute reviews its branch unconditionally unless told otherwise, so without this
  // flag a crew run is structurally N+1 full councils - N task branches plus the integrated
  // one - which the design measured as its largest single cost line. The per-task signal is
  // not lost: verify and the acceptance judge (a different model than the implementer) both
  // still run inside each task.
  const src = readFileSync(join(PKG, "src/index.ts"), "utf8")
  const call = src.slice(src.indexOf("const run = await runExecute("))
  const body = call.slice(0, call.indexOf("})"))
  assert.match(body, /review: false/, "crew must suppress the per-task branch review")
  assert.match(body, /openPr: false/, "and must not open N PRs before integration")

  // ...and the pipeline must still honour it.
  const lets = readFileSync(join(PKG, "src/lets.ts"), "utf8")
  assert.match(lets, /input\.review === false/, "runExecute must act on the flag it accepts")
})

// ---------------------------------------------------------------- resume

/**
 * A plan on disk plus a checkpoint from a run that did not finish it.
 *
 * Both are written by hand rather than by running crew, because producing them for real
 * needs model calls and this suite makes none. The shapes are the ones `latestArtifact`
 * matches and `resume` reads.
 */
function interrupted(
  dir: string,
  titles: string[],
  landed: { title: string; branch: string }[],
  opts: { plan?: string } = {},
) {
  const planDir = "2026-01-01T00-00-00-crew-org-plan"
  const runDir = "2026-01-01T00-00-01-crew-org-run"
  for (const d of [planDir, runDir]) mkdirSync(join(dir, "council-artifacts", d), { recursive: true })
  writeFileSync(
    join(dir, "council-artifacts", planDir, "plan.json"),
    JSON.stringify({
      directive: "ship it",
      adr: "docs/adr/x.md",
      roles: ["reviewer"],
      tasks: titles.map((title) => ({
        title,
        items: [{ title: "i", detail: "", files: ["x.ts"], acceptance: "ok" }],
      })),
    }),
  )
  writeFileSync(
    join(dir, "council-artifacts", runDir, "state.json"),
    JSON.stringify({
      plan: opts.plan ?? planDir,
      runId: "old",
      tasks: landed.map((l, i) => ({
        title: l.title,
        slug: `crew-old-1${i + 1}-x`,
        wave: 1,
        run: { branch: l.branch },
      })),
    }),
  )
}

const THIRTEEN = Array.from({ length: 13 }, (_, i) => `T${i}`)

test("an interrupted run is refused, with both ways out named", async () => {
  // The bug this closes: a rerun minted a fresh run id, so it rebuilt every task from
  // scratch and the finished branches just sat there. There was no way to say "carry on".
  const dir = toolRepo()
  try {
    branchWith(dir, "lets/done-one", "one.ts", "1\n")
    interrupted(dir, ["First", "Second"], [{ title: "First", branch: "lets/done-one" }])
    const out = await (await crewTool()).execute({ mode: "execute" }, { directory: dir })
    assert.match(out, /stopped part-way/)
    assert.match(out, /1 of 2 task/)
    assert.match(out, /lets\/done-one/, "the surviving branch must be named, not just counted")
    assert.match(out, /Second/, "and so must the work still to do")
    assert.match(out, /resume: true/)
    assert.match(out, /fresh: true/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a run that finished every task and then stopped resumes into integration", async () => {
  // Integration, verify and review are the longest unattended stretch in a crew run, so an
  // interruption there is the one most worth not repeating - and it leaves nothing remaining.
  const dir = toolRepo()
  try {
    branchWith(dir, "lets/all-done", "a.ts", "1\n")
    interrupted(dir, ["Only"], [{ title: "Only", branch: "lets/all-done" }])
    const out = await (await crewTool()).execute({ mode: "execute" }, { directory: dir })
    assert.match(out, /finished all 1 task/)
    assert.match(out, /integration, verify or review/)
    assert.match(out, /straight to integrating/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a finished task whose branch was deleted runs again", async () => {
  // The branch is the evidence, never the record alone. Trusting a checkpoint that points at
  // a branch the human has since deleted would drop that task's work out of the integration
  // while the report still called it done.
  const dir = toolRepo()
  try {
    interrupted(dir, THIRTEEN, [{ title: "T0", branch: "lets/deleted" }])
    const out = await (await crewTool()).execute({ mode: "execute" }, { directory: dir })
    assert.doesNotMatch(out, /stopped part-way/, "a checkpoint with no surviving branch is no checkpoint")
    assert.match(out, /MAX_TASKS/, "so it went on to schedule the full plan")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a checkpoint from a different plan is not offered", async () => {
  // Branches from another directive answer a different question. Merging them because the
  // file happened to be the newest one on disk is exactly the silent wrong answer.
  const dir = toolRepo()
  try {
    branchWith(dir, "lets/elsewhere", "b.ts", "1\n")
    interrupted(dir, THIRTEEN, [{ title: "T0", branch: "lets/elsewhere" }], { plan: "2025-01-01T00-00-00-crew-org-plan" })
    const out = await (await crewTool()).execute({ mode: "execute" }, { directory: dir })
    assert.doesNotMatch(out, /stopped part-way/)
    assert.match(out, /MAX_TASKS/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("fresh ignores a checkpoint that resume would have offered", async () => {
  const dir = toolRepo()
  try {
    branchWith(dir, "lets/done-one", "one.ts", "1\n")
    interrupted(dir, THIRTEEN, [{ title: "T0", branch: "lets/done-one" }])
    const refused = await (await crewTool()).execute({ mode: "execute" }, { directory: dir })
    assert.match(refused, /stopped part-way/, "without a flag it must refuse")

    const out = await (await crewTool()).execute({ mode: "execute", fresh: true }, { directory: dir })
    assert.doesNotMatch(out, /stopped part-way/)
    assert.match(out, /MAX_TASKS/, "fresh went past the checkpoint to the whole plan")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("crew:status names an interrupted run and the way out of it", async () => {
  // Where someone actually looks when a run dies. Nothing else on the read-only path would
  // ever mention that resuming is possible.
  const dir = toolRepo()
  try {
    branchWith(dir, "lets/done-one", "one.ts", "1\n")
    interrupted(dir, ["First", "Second"], [{ title: "First", branch: "lets/done-one" }])
    const out = await (await crewTool()).execute({ mode: "status" }, { directory: dir })
    assert.match(out, /stopped part-way/)
    assert.match(out, /lets\/done-one/)
    assert.match(out, /resume: true/)
    assert.match(out, /fresh: true/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a resumed task is reported as carried forward, never as work this run did", () => {
  // The record stands in for the approval gate, so it must not claim a span of work it did
  // not perform.
  const base: CrewResult = {
    directive: "d",
    roles: ["reviewer"],
    scheduling: { mode: "graph", ungraphed: [], waves: 1 },
    tasks: [
      {
        title: "Carried",
        slug: "crew-old-11-x",
        wave: 1,
        resumed: true,
        run: { branch: "lets/old", outcomes: [], stoppedBy: "complete", seconds: 1, worktree: "/w", cycles: [], pushed: false } as any,
      },
      {
        title: "Fresh",
        slug: "crew-new-11-y",
        wave: 1,
        run: { branch: "lets/new", outcomes: [], stoppedBy: "complete", seconds: 1, worktree: "/w", cycles: [], pushed: false } as any,
      },
    ],
  }
  const out = renderCrewReport(base)
  assert.match(out, /Carried.*carried forward from an earlier run/)
  const fresh = out.split("\n").find((l) => l.includes("Fresh"))!
  assert.doesNotMatch(fresh, /carried forward/, "work this run did must not be labelled as resumed")
})

test("crew:status also names a run that finished every task and then stopped", async () => {
  // Found by the tech writer reviewing the docs against source, not by a test: status gated
  // on `landed && remaining` while execute gates on `landed` alone, so the case worth the
  // most - interrupted during integration, verify or review - was resumable by execute and
  // invisible in the read-only view whose entire job is advertising that.
  const dir = toolRepo()
  try {
    branchWith(dir, "lets/all-done", "a.ts", "1\n")
    interrupted(dir, ["Only"], [{ title: "Only", branch: "lets/all-done" }])
    const out = await (await crewTool()).execute({ mode: "status" }, { directory: dir })
    assert.match(out, /finished every task and then stopped/)
    assert.match(out, /lets\/all-done/)
    assert.match(out, /resume: true/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
