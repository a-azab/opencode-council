// The deterministic core. No I/O, no model calls, no randomness.
//
// Under D3 ("no single model decides") every judgement the old council delegated to a
// moderator model is made here instead, as arithmetic over structured findings. If you are
// tempted to ask a model to do any of this, don't - that is the thing this file exists to
// prevent.

export type Tier = "BLOCKER" | "SUGGESTION" | "NIT"
export type Confidence = "high" | "medium" | "low"
export type Outcome = "keep" | "downgrade" | "drop"

export type Finding = {
  tier: Tier
  category: string
  file: string
  line: number
  issue: string
  why: string
  fix: string
  confidence: Confidence
  reference?: string
  /** provenance, stamped by the engine - never by the model */
  role?: string
  model?: string
}

/** A skeptic's judgement on one finding. */
export type Verdict = { real: boolean; confidence: Confidence; reason: string }

/** One finding as reported by one (role, model); several may collapse into a Group. */
export type Report = { role: string; model: string; tier: Tier }

export type Group = {
  key: string
  finding: Finding
  reports: Report[]
}

export const TIER_RANK: Record<Tier, number> = { BLOCKER: 3, SUGGESTION: 2, NIT: 1 }

/**
 * Two findings are the same issue if they name the same file and category and land within
 * this many lines of each other.
 *
 * ponytail: a line window, not semantic similarity. It cannot merge the same bug reported
 * at two distant call sites - upgrade to matching on the enclosing symbol only if
 * duplicates actually show up in practice.
 */
export const DEDUPE_LINE_WINDOW = 3

const downgrade = (t: Tier): Tier => (t === "BLOCKER" ? "SUGGESTION" : "NIT")

/**
 * keep | downgrade | drop, from skeptic votes.
 *
 * Deliberately asymmetric, in two ways:
 *  - Absent evidence never drops a finding. Zero votes means the verification step did not
 *    run, which is not the same as a finding being refuted, and conflating the two is how
 *    a real bug disappears silently.
 *  - A security finding needs UNANIMOUS high-confidence refutation to be dropped, where
 *    other categories need only a majority. That protection is a property of the category,
 *    applied here - no model or role holds a veto (D3).
 */
export function decide(finding: Finding, votes: Verdict[]): Outcome {
  const n = votes.length
  if (n === 0) return "keep"

  const falses = votes.filter((v) => v.real === false)
  const allFalse = falses.length === n
  const majorityFalse = falses.length * 2 > n
  const majorityHighFalse = falses.filter((v) => v.confidence === "high").length * 2 > n
  const unanimousHighFalse = allFalse && falses.every((v) => v.confidence === "high")

  if (finding.category === "security") {
    if (unanimousHighFalse) return "drop"
    return finding.tier === "BLOCKER" && majorityFalse ? "downgrade" : "keep"
  }

  if (finding.tier === "BLOCKER") {
    if (allFalse || majorityHighFalse) return "drop"
    if (majorityFalse) return "downgrade"
    return "keep"
  }

  return majorityFalse ? "drop" : "keep"
}

export function applyOutcome(finding: Finding, outcome: Outcome): Finding | null {
  if (outcome === "drop") return null
  if (outcome === "keep") return finding
  return { ...finding, tier: downgrade(finding.tier) }
}

/**
 * Collapse findings that describe the same issue. The representative keeps the HIGHEST
 * tier anyone assigned; every reporter's own tier is preserved in `reports`, because that
 * spread is exactly what `disputes()` reads.
 */
export function dedupe(findings: Finding[]): Group[] {
  const groups: Group[] = []
  for (const f of findings) {
    const hit = groups.find(
      (g) =>
        g.finding.file === f.file &&
        g.finding.category === f.category &&
        Math.abs(g.finding.line - f.line) <= DEDUPE_LINE_WINDOW,
    )
    const report: Report = { role: f.role ?? "?", model: f.model ?? "?", tier: f.tier }
    if (!hit) {
      groups.push({ key: `${f.file}:${f.line}:${f.category}`, finding: f, reports: [report] })
      continue
    }
    hit.reports.push(report)
    if (TIER_RANK[f.tier] > TIER_RANK[hit.finding.tier]) {
      hit.finding = { ...f, tier: f.tier }
    }
  }
  return groups
}

/**
 * Groups whose reporters did not agree on a tier. This is the debate agenda.
 *
 * A model that files two findings at the same spot lands twice in `reports`, at possibly
 * different tiers. That is not a disagreement - it is one reviewer being thorough - so each
 * model is counted once at its highest tier. Without this, a model gets dispatched to
 * debate itself.
 */
export function disputes(groups: Group[]): Group[] {
  return groups.filter((g) => new Set(highestPerModel(g).values()).size > 1)
}

function highestPerModel(g: Group): Map<string, Tier> {
  const best = new Map<string, Tier>()
  for (const r of g.reports) {
    const seen = best.get(r.model)
    if (!seen || TIER_RANK[r.tier] > TIER_RANK[seen]) best.set(r.model, r.tier)
  }
  return best
}

export type Revision = {
  key: string
  model: string
  tier: Tier | "WITHDRAW"
  /** the debater's stated reasoning - carried for the report, not used in the fold */
  reason?: string
  changed?: boolean
}

/**
 * Fold debate replies back into the groups. Pure, so the loop around it stays testable
 * without a model in the way.
 *
 * A WITHDRAW removes that reporter's vote; a group whose every reporter withdrew is gone.
 * The representative tier is always recomputed as the highest surviving one, so a group
 * cannot keep a tier that nobody still argues for.
 */
export function applyRevisions(groups: Group[], revisions: Revision[]): Group[] {
  const out: Group[] = []
  for (const g of groups) {
    let reports = g.reports
    for (const r of revisions.filter((r) => r.key === g.key)) {
      reports =
        r.tier === "WITHDRAW"
          ? reports.filter((x) => x.model !== r.model)
          : reports.map((x) => (x.model === r.model ? { ...x, tier: r.tier as Tier } : x))
    }
    if (reports.length === 0) continue
    const top = reports.reduce((a, b) => (TIER_RANK[b.tier] > TIER_RANK[a.tier] ? b : a)).tier
    out.push({ ...g, reports, finding: { ...g.finding, tier: top } })
  }
  return out
}

/** Stable signature of the current tier assignment, used to detect a fixed point. */
export function signature(groups: Group[]): string {
  return groups
    .map((g) => `${g.key}=${g.finding.tier}`)
    .sort()
    .join("|")
}

/**
 * Convergence is COMPUTED, never declared by a model. The old council asked a moderator to
 * emit "VERDICT: CONVERGED", which is an opinion wearing a control-flow costume.
 */
export function converged(
  previous: Group[] | null,
  current: Group[],
  round: number,
  maxRounds: number,
): { done: boolean; reason: string } {
  if (disputes(current).length === 0) return { done: true, reason: "no disputed findings" }
  if (round >= maxRounds) return { done: true, reason: `round limit (${maxRounds}) reached` }
  if (previous && signature(previous) === signature(current))
    return { done: true, reason: "no tier changed since last round" }
  return { done: false, reason: "disputes remain and tiers are still moving" }
}
