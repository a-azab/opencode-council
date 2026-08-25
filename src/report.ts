// Report rendering. Templated from the aggregated data - no model writes this, and no
// model may add, remove, or re-tier a finding on the way out (D3).
import type { Review, TaskProposal, TaskResult } from "./engine.ts"
import { TIE_MARGIN, type Finding } from "./decide.ts"
import { upgradeCandidates, type Result } from "./catalog.ts"
import type { Member } from "./roster.ts"

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

  // A lane that answered only because a stand-in took over is not the lane that was
  // planned, and two lanes answered by one model are not two independent opinions.
  // Reporting the count without the substitutions would overstate coverage exactly the way
  // hiding a drop does.
  const stood = nodes.filter((n) => n.state === "ok" && n.substituted?.length)
  if (stood.length) {
    lines.push("## Lanes covered by a stand-in", "")
    lines.push("| role | answered by | passed over |", "|---|---|---|")
    for (const n of stood)
      lines.push(
        `| ${n.node.role} | ${n.node.slug} | ${n.substituted!.map((s) => `${s.from} (\`${s.state}\`)`).join(", ")} |`,
      )
    lines.push("")
    const correlated = stood.filter((n) => nodes.some((o) => o !== n && o.state === "ok" && o.node.slug === n.node.slug))
    if (correlated.length)
      lines.push(
        `> ${correlated.length} stand-in(s) reused a model already answering another lane.` +
          " Those two lanes are correlated, not independent — which is the thing a" +
          " multi-model panel is buying its way out of.",
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
        `${TIE_MARGIN.toFixed(2)} of each other. That gap is smaller than these scores can`,
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
 * One answer, with the dissent that lost still attached.
 *
 * The three terminal states decideTask() computes are rendered as three different reports,
 * because they are three different things to tell a human: here is the answer, the council
 * split and it is your call, or nothing was ever scored. Collapsing the last two into "no
 * winner" would report a disagreement that never took place.
 */
export function renderTask(result: TaskResult): string {
  const { goal, proposals, scores, ranked, winner, tied, runnerUp, objections, unscored } = result
  const live = proposals.filter((p) => p.state === "ok")
  const dropped = proposals.filter((p) => p.state !== "ok")
  const meanOf = (slug: string) => ranked.find((r) => r.proposal === slug)?.mean

  const lines: string[] = [
    "# Council answer",
    "",
    `**Task.** ${goal}`,
    "",
    `${live.length} answers · ${scores.length} cross-scores · ` +
      (winner
        ? `winner: **${winner.slug}**`
        : unscored
          ? "**unranked — nothing was scored**"
          : "**no winner — too close to call**"),
    "",
  ]

  /**
   * `confidence` rides beside every answer this prints and nowhere else. It is deliberately
   * NOT in the ranking - tally() sums four dimensions and confidence is not one of them, so
   * a model cannot win by asserting itself louder. It is solicited so a human can weigh an
   * answer the model was itself unsure of, and this is its only consumer.
   */
  const answer = (p: TaskProposal, heading: string) => {
    const m = meanOf(p.slug)
    lines.push(
      `${heading}${m !== undefined ? ` (${m.toFixed(2)})` : ""}`,
      "",
      `<sub>${p.role} · ${p.model} · confidence ${p.confidence}</sub>`,
      "",
      p.answer,
      "",
    )
    if (p.reasoning) lines.push(`**Why.** ${p.reasoning}`, "")
  }

  if (winner) {
    answer(winner, `## Answer — ${winner.slug}`)
  } else if (tied.length) {
    // A tie goes to the human. Asking a model to break it would put the decision back
    // inside a model, which is the thing this design forbids (D3).
    lines.push(
      "## Your call",
      "",
      `The council did not converge. ${tied.map((t) => `**${t.slug}** (${meanOf(t.slug)?.toFixed(2) ?? "—"})`).join(" and ")} scored`,
      `within ${TIE_MARGIN.toFixed(2)} of each other, which is a smaller gap than these scores can resolve, so`,
      "naming one the winner would be false precision. They are side by side below — pick on",
      "grounds the rubric does not capture.",
      "",
    )
    for (const t of tied) answer(t, `### ${t.slug}`)
  } else if (unscored) {
    // Not a tie, and it must never be printed as one: nothing was ranked because no usable
    // score ever arrived, so there is no disagreement here to report.
    lines.push(
      "## No ranking was possible",
      "",
      `${live.length} answer(s) came back, but not one usable cross-score did, so there is nothing`,
      "to rank. This is not a tie — the council never voted. Every answer is below, in no",
      "order, and the ordering is yours to supply.",
      "",
    )
    for (const p of live) answer(p, `### ${p.slug}`)
  }

  if (ranked.length) {
    lines.push(
      "## Ranking",
      "",
      "| answer | role | confidence | mean (of 20) | scores |",
      "|---|---|---|---|---|",
    )
    for (const r of ranked) {
      const p = proposals.find((x) => x.slug === r.proposal)
      lines.push(
        `| ${r.proposal}${winner?.slug === r.proposal ? " ✅" : ""} | ${p?.role ?? "?"} | ` +
          `${p?.confidence ?? "?"} | ${r.mean.toFixed(2)} | ${r.scores} |`,
      )
    }
    lines.push("")
  }

  if (runnerUp) answer(runnerUp, `## Runner-up — ${runnerUp.slug}`)

  // Verbatim, and never truncated. An objection is the one thing in this report that
  // survived losing, and a score of 5 with an objection attached is not agreement - it is
  // the reservation the winning answer has not answered.
  if (objections.length) {
    lines.push("## Objections", "")
    for (const o of objections)
      lines.push(`- **${o.scorer}** on \`${o.proposal}\` — ${o.objection}`)
    lines.push("")
  }

  // tally() ranks only what it received scores for, so a proposal whose scorers all failed
  // is in ranked/winner/tied/runnerUp nowhere - and `unscored` is false, so the section
  // above never fires for it either. Without this it vanishes from a report that otherwise
  // looks complete. Skipped when nothing ranked at all, because the unranked section has
  // already printed every answer along with the reason.
  const orphaned = unscored ? [] : live.filter((p) => !ranked.some((r) => r.proposal === p.slug))
  if (orphaned.length) {
    lines.push("## Answered, but unscored", "")
    lines.push(
      `${orphaned.length} model(s) answered, and every scorer assigned to them failed. They carry`,
      "no mean and appear nowhere in the ranking above. They are not worse than the ranked",
      "answers — they are unjudged, which is a different thing.",
      "",
    )
    for (const p of orphaned) answer(p, `### ${p.slug}`)
  }

  if (dropped.length) {
    lines.push("## Models that did not answer", "")
    for (const d of dropped)
      lines.push(`- ${d.role} / ${d.slug} — \`${d.state}\` ${(d.detail ?? "").slice(0, 90)}`)
    lines.push("", `> ${dropped.length} of ${proposals.length} models are missing from this answer.`, "")
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

/**
 * What the server offers that the roster does not pin, and what each candidate measured.
 *
 * Discovery is automatic; adoption is not, and the gap between those two is the whole
 * design. `google/gemini-3.7-flash` times out at 90s on the probe `3.6-flash` answers in
 * 9s - an updater that chased the highest version number would have taken a working lane
 * out of the council and filed it as an upgrade. So this measures, shows the measurement,
 * and stops. The roster is a source file and editing it stays a human act.
 *
 * Pure: every probe result is handed in already taken. Nothing here calls a model.
 *
 * ponytail: the reverse staleness - a pinned model the server has stopped offering - is not
 * reported. Add it when a lane actually 404s; the probe results already surface a member
 * that has stopped answering.
 */
export function renderModelsProposal(input: {
  roster: Member[]
  catalog: string[]
  probes: Record<string, Result | undefined>
}): string {
  const { roster, catalog, probes } = input
  const provider = (id: string) => id.split("/")[0]
  const candidates = upgradeCandidates(roster, catalog)

  const lines: string[] = [
    "# Council models",
    "",
    `${catalog.length} offered · ${roster.length} pinned by the roster · ${candidates.length} unpinned ` +
      `on providers already in use`,
    "",
    "**Nothing has been written.** This is a proposal. The roster is a source file, and",
    "changing it is yours to do.",
    "",
  ]

  if (!candidates.length) {
    lines.push(
      "Every model these providers offer is already pinned. There is nothing to propose,",
      "which is the answer, not a failure to find one.",
      "",
    )
    return lines.join("\n")
  }

  for (const p of [...new Set(candidates.map(provider))].sort()) {
    const held = roster.filter((m) => provider(m.model) === p)
    lines.push(`## ${p}`, "")
    lines.push(
      `Pinned here now: ${held.map((m) => `\`${m.model}\` (${m.slug}${m.ms ? `, ${m.ms}ms` : ""})`).join(", ")}`,
      "",
    )
    lines.push("| candidate | measured | reading |", "|---|---|---|")
    for (const id of candidates.filter((c) => provider(c) === p)) {
      const r = probes[id]
      lines.push(
        `| \`${id}\` | ${r ? `${r.ms}ms` : "—"} | ` +
          (!r
            ? "not probed — the budget did not reach it"
            : r.ok
              ? "answered the schema probe; weigh it against what it would replace"
              : "returned nothing usable — do not pin it") +
          " |",
      )
    }
    lines.push("")
  }

  lines.push(
    "## To adopt one",
    "",
    "Edit `ROSTER` in `src/roster.ts`: point that member's `model` at the new id, re-measure",
    "`ms`, and leave `capability` alone until a probe has actually settled it. Then run the",
    "suite — the roster invariants are asserted, so a swap that empties a lane fails loudly.",
    "",
  )

  // Named from the data rather than argued in the abstract: a candidate that failed its
  // probe IS the case against adopting on version number, and it is more convincing sitting
  // in the reader's own catalogue than as a story about someone else's.
  const failed = candidates.filter((id) => probes[id] && !probes[id]!.ok)
  if (failed.length)
    lines.push(
      `${failed.length} candidate(s) above returned nothing usable when measured: ` +
        `${failed.map((id) => `\`${id}\``).join(", ")}.`,
      "A later version number is not a measurement, and this is what the difference looks like.",
      "",
    )

  const unprobed = candidates.filter((id) => !probes[id])
  if (unprobed.length)
    lines.push(
      `> ${unprobed.length} of ${candidates.length} candidates were not measured. Each probe is a full model call,`,
      "> so they are capped per run — an unmeasured row is unknown, not fine.",
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
