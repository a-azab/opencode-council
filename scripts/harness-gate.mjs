#!/usr/bin/env node
// CI gate on the ECC harness score: does this repo still hold its recorded floor?
//
// `npm test` answers "did I break the code?". This answers the question the test suite
// cannot: whether the harness AROUND the code - CI, hooks, guardrails, eval coverage,
// context hygiene - is still there. src/harness.ts runs the same scorer inside a `lets`
// run; this is the same check hoisted to CI so a pull request cannot quietly strip it.
//
// THE POINT OF THIS FILE IS THAT IT IS NOT YAML. A gate expressed as a shell one-liner in
// a workflow step can only be tested by pushing a commit, which means its failure modes -
// the ones that matter here - are discovered in production. This is plain node with no
// dependencies so all three verdicts can be exercised from a terminal in one second.
//
// Three verdicts, and they are deliberately three rather than two:
//   exit 0  harness: 39/39 >= floor 39 OK
//   exit 0  harness: unavailable (...)        <- nobody looked. NOT a pass.
//   exit 1  harness: 31/39 BELOW floor 39
//
// Usage:
//   node scripts/harness-gate.mjs
//   node scripts/harness-gate.mjs --repo /tmp/fixture --audit /tmp/fake-audit.js
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, appendFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1])

// Default to the repo this script is checked into, not `process.cwd()`. A gate that scores
// whatever directory it happened to be invoked from reports on the wrong tree the first
// time someone runs it from a subdirectory.
const REPO = resolve(args.get("repo") ?? join(dirname(fileURLToPath(import.meta.url)), ".."))
const AGENTS = join(REPO, "AGENTS.md")

// `--repo` and `--audit` exist so the three verdicts are reachable from a fixture directory.
// There is deliberately no `--floor`: a flag that lowers the bar is a flag that gets passed
// in CI the first time the bar is inconvenient, and then the gate is decorative.
const ECC_ROOT = args.get("ecc") ?? process.env.ECC_HOME ?? "/root/code/AI/ECC"
const AUDIT = resolve(args.get("audit") ?? join(ECC_ROOT, "scripts", "harness-audit.js"))

/** GitHub folds ordinary log lines away; a workflow command survives into the run summary. */
function announce(level, title, message) {
  const banner = `${"=".repeat(72)}\n${message}\n${"=".repeat(72)}`
  console.log(banner)
  if (process.env.GITHUB_ACTIONS) console.log(`::${level} title=${title}::${message.replace(/\n/g, "%0A")}`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `**${title}** — ${message}\n`)
    } catch {
      // A summary file that cannot be written is not a reason to change the verdict.
    }
  }
}

/**
 * The floor recorded in the repo's own ```lets block, e.g. `harness-floor: 39`.
 *
 * Parsed at runtime, never baked in: the floor is raised as the repo improves, and a
 * hardcoded copy here would keep passing a repo that had already regressed past the number
 * its AGENTS.md claims. Same fence as parseLetsBlock in src/lets.ts, and the `crew` spelling
 * is still accepted there, so it is accepted here too.
 */
function readFloor(path) {
  if (!existsSync(path)) return { ok: false, why: `AGENTS.md not found at ${path}` }
  const fence = /^```(?:lets|crew)[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/m.exec(readFileSync(path, "utf8"))
  if (!fence) return { ok: false, why: `no \`\`\`lets block in ${path}` }
  for (const line of fence[1].split(/\r?\n/)) {
    const i = line.indexOf(":")
    if (i === -1 || line.trimStart().startsWith("#")) continue
    if (line.slice(0, i).trim() !== "harness-floor") continue
    const n = Number(line.slice(i + 1).trim())
    if (!Number.isFinite(n) || n < 0) return { ok: false, why: `harness-floor is not a number: ${line.trim()}` }
    return { ok: true, floor: n }
  }
  return { ok: false, why: `no \`harness-floor:\` line in the \`\`\`lets block of ${path}` }
}

// UNAVAILABLE IS NOT A PASS, AND FAIL-OPEN IS A DELIBERATE CHOICE.
//
// The ECC checkout lives OUTSIDE this repository, so on a GitHub runner it is simply not
// there and this is the path that will actually run in CI today. Failing the build would
// mean every pull request is red for a reason no contributor can fix from inside the repo,
// and the fix people reach for then is deleting the gate. So: exit 0, but shout.
//
// The shout is the load-bearing part. This project's ADRs say every gate must distinguish
// "it held" from "nobody looked", and a gate that prints nothing when it could not run is
// indistinguishable from one that passed - which is worse than having no gate, because it
// manufactures confidence. Hence a banner, a `::notice`, and the word `unavailable` rather
// than any word that could be mistaken for a verdict.
function unavailable(why) {
  announce("notice", "harness gate", `harness: unavailable (${why})\nNO SCORE WAS TAKEN. This is not a pass - nothing checked the harness on this run.`)
  process.exit(0)
}

if (!existsSync(AUDIT)) unavailable(`audit script not found at ${AUDIT}`)

let raw
try {
  // Matches src/harness.ts exactly - same argv, same 60s ceiling. These are filesystem
  // checks, not model calls; a minute is already generous.
  raw = execFileSync(process.execPath, [AUDIT, "repo", "--format", "json", "--root", REPO], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  })
} catch (e) {
  unavailable(`audit did not run: ${String(e?.stderr || e?.message || e).trim().slice(0, 300)}`)
}

let audit
try {
  audit = JSON.parse(raw)
} catch {
  unavailable(`audit output was not JSON (${raw.trim().slice(0, 120)})`)
}
if (typeof audit?.overall_score !== "number" || typeof audit?.max_score !== "number")
  unavailable("audit JSON has no overall_score/max_score")

// A missing or malformed floor fails CLOSED, unlike a missing audit script. The asymmetry is
// the point: AGENTS.md ships inside this repository and is present on every runner, so if the
// floor cannot be read that is a defect a contributor can fix in the same pull request. Only
// the genuinely external dependency gets the benefit of the doubt.
const f = readFloor(AGENTS)
if (!f.ok) {
  announce("error", "harness gate", `harness: CANNOT GATE - ${f.why}\nScored ${audit.overall_score}/${audit.max_score} but there is no recorded floor to compare it against.`)
  process.exit(1)
}

const score = `${audit.overall_score}/${audit.max_score}`
const checks = Array.isArray(audit.checks) ? audit.checks : []
const failed = checks.filter((c) => c && c.pass === false)

if (audit.overall_score < f.floor) {
  // The failing checks are printed on the failure path only. On the passing path they are
  // noise; here they are the entire remediation list, and a contributor reading a red build
  // should not have to install ECC locally to find out which points went missing.
  const detail = failed.map((c) => `  - [${c.category}] ${c.id}: ${c.description} (${c.points} pts)`).join("\n")
  announce("error", "harness gate", `harness: ${score} BELOW floor ${f.floor}\n${failed.length} failing check(s):\n${detail}`)
  process.exit(1)
}

console.log(`harness: ${score} >= floor ${f.floor} OK (rubric ${audit.rubric_version ?? "unknown"}, mode ${audit.target_mode ?? "unknown"})`)
if (failed.length) console.log(`  ${failed.length} non-fatal failing check(s): ${failed.map((c) => c.id).join(", ")}`)
