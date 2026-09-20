// Harness: a deterministic repo scorecard, running alongside `verify`.
//
// `verify` answers "did I break anything?". It is the project's own test suite and it is
// the right question, but it is blind to the thing that makes a repo safe to work in
// unattended: whether the harness around the code - CI, hooks, guardrails, eval coverage,
// context hygiene - still holds up. A run can leave every test green and the repo measurably
// worse to hand to the next unattended session.
//
// The scorer is ECC's `scripts/harness-audit.js` (rubric-versioned, reproducible for the
// same commit, 12 fixed categories of which 7 are always applicable). We shell out to it
// and never reimplement it: a second copy of someone else's rubric would drift from theirs
// silently, and the whole value of the number is that it is not our judgement.
//
// The same reason the council aggregates in code rather than asking a model to summarise:
// this is arithmetic, and a model's opinion of a repo's health is not evidence.
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

/** ECC checkout probed when nothing is configured. */
export const ECC_DEFAULT = "/root/code/AI/ECC"

/** Wall clock for one audit. It is filesystem checks, not model calls - seconds, not minutes. */
export const AUDIT_TIMEOUT_MS = 60_000

const AUDIT_SCRIPT = join("scripts", "harness-audit.js")

export type HarnessSource = "config" | "env" | "probe"

export type HarnessLocation = { root: string; script: string; from: HarnessSource }

/**
 * Where the scorer lives, in order of decreasing explicitness: what the repo recorded,
 * then the environment, then the one known checkout.
 *
 * `harness: none` in the lets block is a decision and returns null - the same distinction
 * `tracker` draws between "never asked" and "the human said no". Probing after an explicit
 * `none` would re-impose a gate someone deliberately declined.
 */
export function findHarness(
  configured?: string,
  env: NodeJS.ProcessEnv = process.env,
): HarnessLocation | null {
  if (configured === "none") return null
  const candidates: { root: string; from: HarnessSource }[] = []
  if (configured) candidates.push({ root: configured, from: "config" })
  if (env.ECC_HOME) candidates.push({ root: env.ECC_HOME, from: "env" })
  candidates.push({ root: ECC_DEFAULT, from: "probe" })
  for (const c of candidates) {
    const script = join(c.root, AUDIT_SCRIPT)
    if (existsSync(script)) return { root: c.root, script, from: c.from }
  }
  return null
}

export type HarnessAction = { action: string; path: string; category: string; points: number }

export type HarnessAudit = {
  /** the repo that was scored, not the ECC checkout that scored it */
  target: string
  /** ECC's own rubric version. A delta across two rubrics is not a delta (see `comparable`) */
  rubric: string
  /** "consumer" for a repo using ECC, "repo" for the ECC checkout itself */
  mode: string
  score: number
  max: number
  /** 0-10 per category, as ECC normalises them. Keyed by ECC's category name */
  categories: Record<string, number>
  actions: HarnessAction[]
}

export type HarnessResult =
  | { ok: true; audit: HarnessAudit }
  | { ok: false; reason: string }

/** Score as a percentage of the applicable maximum, 0-100, rounded. */
export const percent = (a: Pick<HarnessAudit, "score" | "max">) =>
  a.max > 0 ? Math.round((a.score / a.max) * 100) : 0

/**
 * Run the scorer against `target`.
 *
 * Never throws. An audit that cannot run is a missing signal, not a failed run: the caller
 * degrades to verify alone and says so. Failing a work item because ECC moved on disk would
 * be a gate that punishes the wrong thing.
 */
export function runAudit(
  loc: HarnessLocation,
  target: string,
  timeoutMs = AUDIT_TIMEOUT_MS,
): HarnessResult {
  let raw: string
  try {
    raw = execFileSync(
      process.execPath,
      [loc.script, "repo", "--format", "json", "--root", target],
      { cwd: loc.root, encoding: "utf8", timeout: timeoutMs, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 },
    )
  } catch (e: any) {
    const detail = String(e?.stderr || e?.message || e).trim().slice(0, 300)
    return { ok: false, reason: `harness audit did not run: ${detail || "unknown error"}` }
  }
  return parseAudit(raw, target)
}

/**
 * Split from runAudit so the parse - the part with decisions in it - is testable without a
 * child process or an ECC checkout on disk.
 */
export function parseAudit(raw: string, target: string): HarnessResult {
  let j: any
  try {
    j = JSON.parse(raw)
  } catch {
    return { ok: false, reason: "harness audit returned output that is not JSON" }
  }
  if (typeof j?.overall_score !== "number" || typeof j?.max_score !== "number")
    return { ok: false, reason: "harness audit JSON is missing overall_score/max_score" }

  const categories: Record<string, number> = {}
  // `applicable_categories` is the authority, not the keys of `categories`: ECC reports
  // deploy-target categories only when a marker file is present, and scoring a category
  // that does not apply to this repo would invent a regression out of a missing vercel.json.
  const applicable: string[] = Array.isArray(j.applicable_categories)
    ? j.applicable_categories
    : Object.keys(j.categories ?? {})
  for (const name of applicable) {
    const c = j.categories?.[name]
    if (c && typeof c.score === "number") categories[name] = c.score
  }

  const actions: HarnessAction[] = Array.isArray(j.top_actions)
    ? j.top_actions
        .filter((a: any) => a && typeof a.action === "string")
        .map((a: any) => ({
          action: String(a.action),
          path: String(a.path ?? ""),
          category: String(a.category ?? ""),
          points: Number(a.points ?? 0),
        }))
    : []

  return {
    ok: true,
    audit: {
      target: String(j.root_dir ?? target),
      rubric: String(j.rubric_version ?? "unknown"),
      mode: String(j.target_mode ?? "unknown"),
      score: j.overall_score,
      max: j.max_score,
      categories,
      actions,
    },
  }
}

/**
 * Two audits can only be subtracted when the same rubric produced them.
 *
 * ECC versions its rubric and rescores categories between versions, so a "regression"
 * measured across an upgrade is a measurement artefact. Reporting it as a regression would
 * fail a work item for something the work item did not do - the one failure mode that makes
 * a gate worse than no gate.
 */
export const comparable = (before: HarnessAudit, after: HarnessAudit) => before.rubric === after.rubric

export type Regression = { category: string; before: number; after: number }

/**
 * Per-category drops, and nothing else.
 *
 * Deliberately not the overall score: `max_score` moves when a category becomes applicable
 * (adding a `vercel.json` adds a category scored 0, which drops the total while improving
 * nothing and breaking nothing). Per-category comparison is the only one that survives that,
 * and it is also the only one that can name what got worse - which is what the retry needs.
 *
 * Categories absent from `before` are skipped rather than treated as 0: a newly applicable
 * category is new information, not a loss.
 */
export function regressions(before: HarnessAudit, after: HarnessAudit): Regression[] {
  if (!comparable(before, after)) return []
  const out: Regression[] = []
  for (const [category, b] of Object.entries(before.categories)) {
    const a = after.categories[category]
    if (typeof a === "number" && a < b) out.push({ category, before: b, after: a })
  }
  return out.sort((x, y) => y.before - y.after - (x.before - x.after))
}

export type FloorBreach = { floor: number; actual: number }

/** Below the recorded floor, as a percentage of the applicable max. */
export const belowFloor = (a: HarnessAudit, floor?: number): FloorBreach | null => {
  if (typeof floor !== "number") return null
  const actual = percent(a)
  return actual < floor ? { floor, actual } : null
}

export type HarnessVerdict =
  | { kind: "pass" }
  | { kind: "unavailable"; reason: string }
  | { kind: "regressed"; regressions: Regression[]; breach: FloorBreach | null }
  | { kind: "below-floor"; breach: FloorBreach }

/**
 * The gate, as arithmetic. No model is consulted and none should be.
 *
 * An unavailable audit is its own verdict rather than a pass: the caller must be able to
 * tell "the harness held" from "nobody looked", and collapsing them into `pass` is exactly
 * the unverified-presented-as-verified move `/council:fix` refuses to make.
 */
export function judge(
  before: HarnessAudit | null,
  after: HarnessResult,
  floor?: number,
): HarnessVerdict {
  if (!after.ok) return { kind: "unavailable", reason: after.reason }
  const breach = belowFloor(after.audit, floor)
  const drops = before ? regressions(before, after.audit) : []
  if (drops.length) return { kind: "regressed", regressions: drops, breach }
  if (breach) return { kind: "below-floor", breach }
  return { kind: "pass" }
}

// ------------------------------------------------------------------ rendering

/** One line, for a run log. */
export const auditLine = (a: HarnessAudit) =>
  `harness ${a.score}/${a.max} (${percent(a)}%), rubric ${a.rubric}, ${Object.keys(a.categories).length} categories`

/** The init proposal's block, and the ADR's pre-run record. */
export function renderAudit(a: HarnessAudit): string {
  const out = [`  ${auditLine(a)} — scored as \`${a.mode}\``]
  const weak = Object.entries(a.categories)
    .filter(([, s]) => s < 10)
    .sort((x, y) => x[1] - y[1])
  for (const [name, score] of weak.slice(0, 5)) out.push(`    ${name}: ${score}/10`)
  if (weak.length > 5) out.push(`    …and ${weak.length - 5} more below 10`)
  for (const act of a.actions.slice(0, 3)) out.push(`    → ${act.action} (${act.path})`)
  return out.join("\n")
}

/** Pre→post, for the crew report. Says "not comparable" rather than subtracting anyway. */
export function renderDelta(before: HarnessAudit | null, after: HarnessAudit | null): string {
  if (!before && !after) return "Harness: never audited."
  if (!after) return `Harness: audited before the run (${auditLine(before!)}) but not after — the delta is unknown.`
  if (!before) return `Harness: ${auditLine(after)} (no pre-run baseline to compare against).`
  if (!comparable(before, after))
    return `Harness: rubric changed (${before.rubric} → ${after.rubric}) — the scores are not comparable and no delta is claimed.`
  const drops = regressions(before, after)
  const head = `Harness: ${percent(before)}% → ${percent(after)}% (${before.score}/${before.max} → ${after.score}/${after.max}, rubric ${after.rubric})`
  if (!drops.length) return `${head} — no category regressed.`
  return [
    `${head} — **${drops.length} category/categories regressed**:`,
    ...drops.map((d) => `  - ${d.category}: ${d.before}/10 → ${d.after}/10`),
  ].join("\n")
}

/**
 * What the implementer is told when the gate fails.
 *
 * Named categories and exact paths, because a retry prompt that says "the harness score
 * dropped" gives a worker nothing to act on. ECC's checks carry file paths; they are the
 * whole reason this is actionable rather than a scolding.
 */
export function regressionFeedback(v: HarnessVerdict, after: HarnessAudit): string {
  const lines: string[] = []
  if (v.kind === "regressed") {
    lines.push(
      "The project's checks pass, but your change made the repository's harness score worse.",
      "These categories regressed:",
      ...v.regressions.map((d) => `  - ${d.category}: ${d.before}/10 → ${d.after}/10`),
    )
    if (v.breach) lines.push(`It is also below this repo's recorded floor of ${v.breach.floor}% (now ${v.breach.actual}%).`)
  } else if (v.kind === "below-floor") {
    lines.push(
      `The project's checks pass, but the repository's harness score is ${v.breach.actual}%, below this repo's recorded floor of ${v.breach.floor}%.`,
    )
  } else return ""

  const relevant =
    v.kind === "regressed"
      ? after.actions.filter((a) => v.regressions.some((d) => d.category === a.category))
      : after.actions
  // The heading has to match what is under it. The scorer's top_actions are the highest
  // -value fixes overall, which frequently do NOT include the category that just
  // regressed — so a fallback list presented as "actions for these" would point the retry
  // at unrelated work while claiming to explain the failure. Observed on the first live
  // run of this gate.
  if (relevant.length) {
    lines.push("", "The scorer's own recommended actions for these:")
    for (const a of relevant.slice(0, 4)) lines.push(`  - [${a.category}] ${a.action} (${a.path})`)
  } else {
    lines.push(
      "",
      "The scorer has no recommended action for these categories — find what your change removed and restore it.",
    )
    if (after.actions.length) {
      lines.push("", "Its highest-value fixes overall, for context only — these are NOT the regression:")
      for (const a of after.actions.slice(0, 3)) lines.push(`  - [${a.category}] ${a.action} (${a.path})`)
    }
  }
  lines.push(
    "",
    "Fix this as part of the item — do not weaken the check or the config to raise the number.",
  )
  return lines.join("\n")
}

/**
 * Audit findings as planning context.
 *
 * Fed into intake the same way the dependency graph is: as data the planner may use, never
 * as items it must do. An audit action is a standing repo weakness, not part of the
 * directive, and a planner that silently expands scope to chase a score is worse than one
 * that ignores it.
 */
export function planContext(a: HarnessAudit): string {
  if (!a.actions.length) return ""
  return [
    `Harness scorecard for this repo (ECC rubric ${a.rubric}): ${a.score}/${a.max} (${percent(a)}%).`,
    "Standing weaknesses, as background only — do NOT add work items for these unless the directive asks:",
    ...a.actions.slice(0, 5).map((x) => `  - [${x.category}] ${x.action} (${x.path})`),
  ].join("\n")
}
