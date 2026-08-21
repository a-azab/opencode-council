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

  // The loop must be auditable. "Converged" is a computed claim, so show what computed it
  // and what actually moved - otherwise it is indistinguishable from a model asserting it.
  lines.push("## Convergence", "")
  lines.push(`Stopped after ${review.debate.length} debate round(s): ${review.convergence}.`, "")
  for (const r of review.debate) {
    const changed = r.revisions.filter((v) => v.changed)
    lines.push(
      `- **Round ${r.round}** — ${r.revisions.length} re-judgements, ${changed.length} changed position` +
        (changed.length
          ? ": " + changed.map((c) => `${c.model}→${c.tier}`).join(", ")
          : " (positions held)"),
    )
  }
  lines.push("")

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

/** Patch artefacts. Nothing here is applied - the human is the only writer (D5). */
export function renderPlan(plan: import("./engine.ts").Plan): string {
  const { proposals, ranked, winner, tied, dropped, scores } = plan
  const live = proposals.filter((p) => p.state === "ok")
  const meanOf = (slug: string) => ranked.find((r) => r.proposal === slug)?.mean

  const lines = [
    `# Council plan`,
    "",
    `**Goal.** ${plan.goal}`,
    "",
    `${live.length} proposals · ${scores.length} cross-scores · ` +
      (winner ? `winner: **${winner.proposal}**` : `**no winner — too close to call**`),
    "",
  ]

  if (!winner && tied.length > 1) {
    // A tie goes to the human. Asking a model to break it would put the decision back
    // inside a model, which is the thing this design forbids (D3).
    lines.push(
      `## Your call`,
      "",
      `${tied.map((t) => `**${t.proposal}** (${t.mean.toFixed(2)})`).join(" and ")} scored within ` +
        `${(0.25).toFixed(2)} of each other. That gap is smaller than these scores can`,
      "resolve, so calling one the winner would be false precision. Both are below — pick on",
      "grounds the rubric does not capture.",
      "",
    )
  }

  if (ranked.length) {
    lines.push("## Ranking", "", "| proposal | role | mean | scores |", "|---|---|---|---|")
    for (const r of ranked) {
      const p = proposals.find((x) => x.slug === r.proposal)
      lines.push(`| ${r.proposal}${winner?.proposal === r.proposal ? " ✅" : ""} | ${p?.role ?? "?"} | ${r.mean.toFixed(2)} | ${r.scores} |`)
    }
    lines.push("")
  }

  const order = [...live].sort((a, b) => (meanOf(b.slug) ?? 0) - (meanOf(a.slug) ?? 0))
  for (const p of order) {
    const m = meanOf(p.slug)
    lines.push(`## ${p.role} — ${p.slug}${m !== undefined ? ` (${m.toFixed(2)})` : ""}`, "")
    lines.push(p.summary, "")
    if (p.steps.length) {
      lines.push("**Steps**", "")
      p.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`))
      lines.push("")
    }
    if (p.risks.length) {
      lines.push("**Risks**", "")
      p.risks.forEach((r) => lines.push(`- ${r}`))
      lines.push("")
    }
    lines.push(`**Gives up.** ${p.tradeoff}`, "")
    const against = scores.filter((s) => s.proposal === p.slug)
    if (against.length) {
      lines.push("<details><summary>how others scored it</summary>", "")
      for (const s of against)
        lines.push(`- **${s.scorer}** — correctness ${s.correctness}, simplicity ${s.simplicity}, risk ${s.risk}, completeness ${s.completeness}. ${s.reason}`)
      lines.push("", "</details>", "")
    }
  }

  if (dropped.length) {
    lines.push("## Proposers that did not report", "")
    for (const d of dropped)
      lines.push(`- ${d.role} / ${d.slug} — \`${d.state}\` ${(d.detail ?? "").slice(0, 90)}`)
    lines.push("", `> ${dropped.length} of ${proposals.length} lanes are missing from this comparison.`, "")
  }

  return lines.join("\n")
}

/**
 * An index, not a synthesis. Each take is written to its own file and this only points at
 * them - the mode exists so a human reads the disagreement directly, so summarising here
 * would defeat it.
 */
export function renderTakesIndex(takes: import("./engine.ts").Take[], task: string): string {
  const ok = takes.filter((t) => t.state === "ok")
  const failed = takes.filter((t) => t.state !== "ok")
  const lines = [
    "# Independent takes",
    "",
    `**Task.** ${task}`,
    "",
    `${ok.length} of ${takes.length} models answered. Each take is a separate file, deliberately`,
    "not merged — read them yourself.",
    "",
    "| model | words | file |",
    "|---|---|---|",
  ]
  for (const t of ok)
    lines.push(`| ${t.slug} | ${t.response.trim().split(/\s+/).length} | \`${t.slug}.md\` |`)
  if (failed.length) {
    lines.push("", "## Did not answer", "")
    for (const t of failed) lines.push(`- \`${t.slug}\` — ${t.state}${t.detail ? `: ${t.detail.slice(0, 90)}` : ""}`)
  }
  return lines.join("\n")
}

export function renderWork(r: import("./work.ts").WorkResult): string {
  const done = r.items.filter((i) => i.state === "done")
  const lines = [
    `# Work — ${r.done ? "DONE" : "INCOMPLETE"}`,
    "",
    `**Goal.** ${r.goal}`,
    `**Done-predicate.** \`${r.verifyCommand}\` — this, not a model, decided whether each item stood.`,
    `**Branch.** \`${r.branch}\` in \`${r.worktree}\`. Your working tree was never touched.`,
    "",
    `${done.length} of ${r.items.length} items completed.`,
    "",
  ]
  for (const i of r.items) {
    lines.push(`## ${i.state === "done" ? "✅" : "❌"} ${i.item.title}`, "")
    lines.push(`**Done when.** ${i.item.acceptance}`)
    lines.push(`**State.** \`${i.state}\` after ${i.attempts} attempt(s)`)
    if (i.filesWritten.length) lines.push(`**Files.** ${i.filesWritten.map((f) => `\`${f}\``).join(", ")}`)
    if (i.verifier) lines.push(`**Checked by.** ${i.verifier} — ${i.verifyReason ?? ""}`)
    if (i.detail) lines.push(`**Note.** ${i.detail}`)
    if (i.state === "failed-check" && i.checkOutput)
      lines.push("", "```", i.checkOutput.slice(-1500).trim(), "```")
    lines.push("")
  }
  if (!r.done)
    lines.push(
      "---",
      "",
      "Stopped at the first item that did not complete. Items are ordered and share one",
      "worktree, so continuing would have piled work on a base already known to be broken.",
      "",
    )
  return lines.join("\n")
}

export function renderPatches(patches: import("./engine.ts").Patch[]): string {
  const usable = (p: (typeof patches)[number]) =>
    p.state === "ok" && p.confident && p.patch.trim()
  // "verified" and "we did not manage to verify" are different facts and must not share a
  // heading - the whole point of the fix loop is that a patch nobody checked is not done.
  const ok = patches.filter((p) => usable(p) && p.verified)
  const unverified = patches.filter((p) => usable(p) && !p.verified)
  const escalated = patches.filter((p) => p.state === "ok" && !usable(p))
  const unresolved = patches.filter((p) => p.state === "unresolved")
  const failed = patches.filter((p) => p.state !== "ok" && p.state !== "unresolved")

  const lines = [
    `# Proposed patches`,
    "",
    `${ok.length} verified · ${unverified.length} unverified · ${escalated.length} need a decision · ` +
      `${unresolved.length} unresolved · ${failed.length} failed`,
    "",
    "Nothing has been applied. Review each hunk, then apply what you accept.",
    "",
  ]

  for (const p of ok) {
    lines.push(`## ${p.finding.file}:${p.finding.line} — ${p.finding.issue}`, "")
    lines.push(
      `${p.explanation}`,
      "",
      `<sub>fixed by ${p.model} · confirmed resolved by ${p.verifier}` +
        `${p.attempts > 1 ? ` on attempt ${p.attempts}` : ""} — ${p.verifyReason ?? ""}</sub>`,
      "",
      "```diff",
      p.patch.trim(),
      "```",
      "",
    )
  }

  if (unverified.length) {
    lines.push("## Produced, but not verified", "")
    lines.push(
      "These patches apply cleanly, but the independent check did not run. Treat them as",
      "unreviewed - the fixer's own confidence is not evidence.",
      "",
    )
    for (const p of unverified) {
      lines.push(`### ${p.finding.file}:${p.finding.line} — ${p.finding.issue}`, "")
      lines.push(`${p.explanation}`, `<sub>${p.detail ?? "verifier unavailable"}</sub>`, "", "```diff", p.patch.trim(), "```", "")
    }
  }

  if (unresolved.length) {
    lines.push("## Still unresolved after retries", "")
    lines.push(
      "A patch was written and re-checked, and an independent reviewer still sees the",
      "original problem. The last attempt is shown so you can judge how close it got.",
      "",
    )
    for (const p of unresolved) {
      lines.push(
        `### ${p.finding.file}:${p.finding.line} — ${p.finding.issue}`,
        "",
        `**${p.verifier} rejected it:** ${p.verifyReason ?? "(no reason given)"}`,
        "",
        "```diff",
        p.patch.trim(),
        "```",
        "",
      )
    }
  }

  if (escalated.length) {
    lines.push("## Needs your decision", "")
    lines.push(
      "The fixer was not confident about these. That is the designed outcome when the right",
      "fix depends on intent it was not told, or when two reasonable fixes exist and the",
      "choice is not the model's to make.",
      "",
    )
    for (const p of escalated)
      lines.push(`- \`${p.finding.file}:${p.finding.line}\` — ${p.finding.issue}`, `  ${p.explanation || "(no patch produced)"}`)
    lines.push("")
  }

  if (failed.length) {
    lines.push("## Failed", "")
    for (const p of failed)
      lines.push(`- \`${p.finding.file}:${p.finding.line}\` — \`${p.state}\` ${(p.detail ?? "").slice(0, 80)}`)
  }
  return lines.join("\n")
}
