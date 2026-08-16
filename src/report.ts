// Report rendering. Templated from the aggregated data - no model writes this, and no
// model may add, remove, or re-tier a finding on the way out (D3).
import type { Review } from "./engine.ts"
import type { Finding } from "./decide.ts"

const TIER_ORDER = { BLOCKER: 0, SUGGESTION: 1, NIT: 2 } as const

function renderFinding(f: Finding): string {
  const ref = f.reference ? ` (${f.reference})` : ""
  return [
    `### [${f.tier}] ${f.category}${ref} — ${f.file}:${f.line}`,
    "",
    `**Issue.** ${f.issue}`,
    `**Why it matters.** ${f.why}`,
    `**Fix.** ${f.fix}`,
    "",
    `<sub>raised by ${f.role}/${f.model} · confidence ${f.confidence}</sub>`,
    "",
  ].join("\n")
}

export function renderReport(review: Review, meta: { files: string[]; ms: number }): string {
  const { verdictCounts: c, kept, nodes, dropped, disputed } = review
  const verdict =
    c.blockers > 0 ? "CHANGES REQUESTED" : c.suggestions > 2 ? "APPROVED WITH SUGGESTIONS" : "APPROVED"

  const sorted = [...kept].sort(
    (a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.file.localeCompare(b.file),
  )

  const lines: string[] = [
    `# Council review — ${verdict}`,
    "",
    `${c.blockers} blockers · ${c.suggestions} suggestions · ${c.nits} nits`,
    `${meta.files.length} files · ${nodes.length} nodes · ${(meta.ms / 1000).toFixed(1)}s`,
    "",
  ]

  if (!sorted.length) lines.push("No findings survived verification.", "")
  for (const f of sorted) lines.push(renderFinding(f))

  // Anti-silent-fail: a node that did not run is reported, always. The council this
  // replaces hid these by conflating "dropped" with "found nothing".
  if (dropped.length) {
    lines.push("## Nodes that did not report", "")
    lines.push("| role | model | state | detail |", "|---|---|---|---|")
    for (const d of dropped)
      lines.push(`| ${d.node.role} | ${d.node.slug} | \`${d.state}\` | ${(d.detail ?? "").slice(0, 90)} |`)
    lines.push("")
    lines.push(
      `> ${dropped.length} of ${nodes.length} nodes produced no review. Coverage is` +
        " incomplete — treat the verdict as provisional.",
      "",
    )
  }

  if (disputed.length) {
    lines.push("## Unresolved disagreements", "")
    for (const g of disputed)
      lines.push(
        `- \`${g.finding.file}:${g.finding.line}\` — ` +
          g.reports.map((r) => `${r.model}:${r.tier}`).join(", "),
      )
    lines.push("")
  }

  lines.push("## Participation", "")
  lines.push("| role | model | state | ms | findings |", "|---|---|---|---|---|")
  for (const n of nodes)
    lines.push(`| ${n.node.role} | ${n.node.slug} | ${n.state} | ${n.ms} | ${n.findings.length} |`)

  return lines.join("\n")
}

/** What the calling model sees. Tool output truncates at 2000 lines / 50 KiB (gotcha 8). */
export function renderSummary(review: Review, reportPath: string): string {
  const { verdictCounts: c, dropped, nodes } = review
  const head = [...review.kept]
    .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier])
    .slice(0, 5)
    .map((f) => `- [${f.tier}] ${f.file}:${f.line} — ${f.issue}`)
  return [
    `${c.blockers} blockers, ${c.suggestions} suggestions, ${c.nits} nits` +
      (dropped.length ? ` · ${dropped.length}/${nodes.length} nodes failed` : ""),
    ...head,
    review.kept.length > 5 ? `- …and ${review.kept.length - 5} more` : "",
    ``,
    `Full report: ${reportPath}`,
  ]
    .filter(Boolean)
    .join("\n")
}
