// crew: one directive, interviewed rather than stated, executed without an approval gate.
//
// `/lets` puts the human at the planning gate; `/crew` removes that gate and puts an audit
// trail in its place. With nobody approving the plan, the report is the ONLY thing standing
// between the user and a bad decision - so everything in this file exists to keep the record
// truthful, and nothing in it may make a run look better than it was.
//
// Model-driven work (the interview, research, decomposition) lives in `command/crew:*.md`,
// exactly as `/lets:plan` does. What is here is what can be tested without a model.
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { selectRoles, type Role } from "./roster.ts"
import type { RunResult } from "./lets.ts"
import { renderDelta, type HarnessAudit } from "./harness.ts"

// ------------------------------------------------------------------ recruiting

/**
 * Prose words that ROUTES only knows as filenames.
 *
 * This maps a word to a PATH, never to a role - which lanes a signal wakes stays in ROUTES,
 * the one routing table. Without this, `terraform` in a directive routes nowhere, because
 * ROUTES matches `*.tf` and a sentence has no file extensions in it.
 */
const AS_PATH: Record<string, string> = {
  terraform: "main.tf", tofu: "main.tf", opentofu: "main.tf", tf: "main.tf", tfvars: "x.tfvars",
  kubernetes: "k8s/x", kube: "k8s/x", k8s: "k8s/x", helm: "k8s/x", kubectl: "k8s/x",
  docker: "Dockerfile", dockerfile: "Dockerfile", containerise: "Dockerfile",
  containerize: "Dockerfile", compose: "docker-compose.yml",
  infra: "infra/x", infrastructure: "infrastructure/x",
  testing: "test/x", tests: "test/x", coverage: "test/x", qa: "test/x",
  // Regulated ground. A directive says "GDPR" or "audit trail"; it never says
  // `docs/compliance/`. These map to the compliance PATH and nothing else - which lanes
  // that wakes stays in ROUTES, same contract as every entry above, which is why this is
  // an extension of the one routing table rather than a second keyword table beside it.
  //
  // Words that ALREADY route are deliberately absent: `compliance`, `policy`, `policies`,
  // `governance`, `iam`, `rbac`, `permissions` and `authz` all reach `ciso` through
  // probesFor unaided, and restating them here would be a second place to keep in sync.
  //
  // `audit` is knowingly wide - it catches "audit the bundle size" too. recruitFloor is a
  // floor and errs wide by design: a redundant lane costs one model call, a missing one on
  // an unattended run costs a merged mistake nobody reviewed.
  gdpr: "compliance/x", hipaa: "compliance/x", ccpa: "compliance/x", sox: "compliance/x",
  pci: "compliance/x", dss: "compliance/x", fedramp: "compliance/x", hitrust: "compliance/x",
  // Only the unspaced forms survive the `[a-z0-9]+` tokeniser; "SOC 2" arrives as two
  // tokens and is carried by whatever else the directive says.
  soc2: "compliance/x", iso27001: "compliance/x",
  audit: "compliance/x", auditable: "compliance/x", auditor: "compliance/x",
  regulatory: "compliance/x", regulation: "compliance/x", regulated: "compliance/x",
  pii: "compliance/x", phi: "compliance/x", retention: "compliance/x",
}

/**
 * A word, as the paths that word implies, so ROUTES can answer "which lanes?".
 *
 * Four shapes because ROUTES globs are anchored differently: a bare name (`auth` hits the
 * auth/secret/token glob), a name inside a directory, a directory of that name, and an
 * extension (`x.tf`).
 */
const probesFor = (word: string): string[] => [word, `x/${word}`, `${word}/x`, `x.${word}`]

/**
 * New structure, as opposed to a change to existing structure.
 *
 * The one signal that CANNOT come from ROUTES: there is no `architect` route, because
 * ROUTES maps paths and "this needs an architect" is a property of the directive's intent.
 * A filename cannot tell you a service is new.
 */
const ARCHITECT =
  /\b(new (service|module|package|system|component|api|endpoint|schema)|re-?design|re-?write|re-?architect|migrat(e|es|ed|ing|ion|ions)|port(ing)? .* to|extract|introduc(e|ing)|split .* (in)?to|greenfield|from scratch|replace .* with)\b/i

/**
 * The lanes this directive needs, before any model proposes anything.
 *
 * A deterministic FLOOR, not a ceiling: the caller may add model-proposed roles on top. It
 * is a floor because an unattended run has no human to notice that the security lane never
 * woke - so the lanes that must always look at terraform, or at anything with `token` in
 * it, are computed here where a test can pin them, not suggested by a model that may forget.
 *
 * Errs wide on purpose. Recruiting a lane that turns out to have nothing to say costs one
 * model call; missing one on an unattended run costs a merged mistake nobody reviewed.
 */
export function recruitFloor(directive: string, stack: string[]): Role[] {
  const words = [
    ...(directive.toLowerCase().match(/[a-z0-9]+/g) ?? []),
    // `dir:apps` and friends carry a prefix detectStack added; the payload is the useful half
    ...stack.map((s) => s.toLowerCase().replace(/^dir:/, "")),
  ]
  const probes = words.flatMap((w) => probesFor(AS_PATH[w] ?? w))
  // selectRoles already pins `reviewer`, and pinning it in one place keeps that guarantee
  // single-sourced rather than restated here where it could drift.
  const roles = new Set<Role>(selectRoles(probes))
  // The architect is unconditional, not keyword-triggered. `crew:plan` REFUSES without an
  // ADR, and the architect is the role that writes it - so a directive that failed a regex
  // would leave a mandatory document with no assigned author, and the model would pick
  // whoever was free. A decision written up by whoever happened to be free is a summary,
  // not a record. `ARCHITECT` still marks structural work for the prompt's benefit; it no
  // longer decides whether the ADR has an owner.
  roles.add("architect")
  return [...roles]
}

// ------------------------------------------------------------------ recovery

/**
 * The tail of a task's slug - the only part of a branch name that is stable across runs.
 *
 * Must stay identical to the derivation in the execute path. If the two drift, recovery
 * silently matches nothing and an interrupted run looks like one that never started, which
 * is the failure this exists to prevent.
 */
export const taskSlug = (title: string) =>
  String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24)

/**
 * Finished branches worked out from git alone, for a run that predates checkpointing or whose
 * artifact directory has since been deleted.
 *
 * The branches ARE the work - they outlive the process that made them, and their names carry
 * the task title. But this is weaker evidence than a checkpoint and is labelled as such
 * wherever it surfaces: a branch proves something was committed, never that the task finished.
 * So it feeds the same refuse-and-name path rather than resuming on its own. The human is the
 * check that the record cannot be here.
 */
export function inferLanded(root: string, planned: { title: string }[], base: string): CrewTask[] {
  let branches: string[] = []
  try {
    branches = git(root, ["branch", "--list", "lets/crew-*", "--format=%(refname:short)"])
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean)
  } catch {
    return []
  }

  const out: CrewTask[] = []
  for (const t of planned) {
    const want = taskSlug(t.title)
    // `lets/crew-<runId>-<wave><index>-<title>`. Strip our own prefix rather than matching the
    // tail loosely - a title slug may itself contain digits and dashes.
    const hits = branches.filter((b) => b.replace(/^lets\/crew-[^-]+-\d+-/, "") === want)
    // Two hits means two runs of this plan each left a branch for this task, and nothing here
    // can tell which one holds the work meant. Naming neither is safer than picking one.
    if (hits.length !== 1) continue
    // A branch with no commits on it is not finished work, whatever its name says.
    let ahead = 0
    try {
      ahead = Number(git(root, ["rev-list", "--count", `${base}..${hits[0]}`]))
    } catch {
      continue
    }
    if (ahead > 0)
      out.push({
        title: t.title,
        slug: hits[0].replace(/^lets\//, ""),
        wave: 1,
        inferred: true,
        run: { branch: hits[0] } as any,
      })
  }
  return out
}

// ------------------------------------------------------------------ integration

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

const branchExists = (root: string, branch: string): boolean => {
  try {
    git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

export type Integration =
  | { ok: true; branch: string; merged: string[] }
  | { ok: false; branch: string; merged: string[]; conflicted: string; files: string[] }

/**
 * Merge each task branch into a fresh integration branch, in order.
 *
 * STOPS AT THE FIRST CONFLICT, and does not resolve it. A conflict here is evidence that
 * the scheduler was wrong - it put two tasks in one wave after judging their file sets
 * disjoint - and resolving it unattended would destroy exactly the evidence that the
 * concurrency gate needs fixing. The half-merged tree is aborted so the repo is left clean,
 * and the branch plus the conflicting files are returned so the report can name them.
 *
 * Merges happen in a throwaway worktree, never in `root`'s checkout: an unattended tool has
 * no business moving the branch the user is standing on. The integration BRANCH survives
 * with whatever merged cleanly, because partial progress is evidence too.
 */
export function integrate(root: string, base: string, branches: string[], into: string): Integration {
  // Refuse rather than clobber. `git branch -D` on a name we did not create could delete a
  // human's branch, and reusing a stale integration branch would silently report a merge
  // that was actually made by a previous run.
  if (branchExists(root, into))
    throw new Error(`integrate: branch \`${into}\` already exists; pick a fresh name or delete it first`)

  git(root, ["worktree", "prune"])
  const path = join(root, ".worktrees", `integrate-${into.replace(/[^a-zA-Z0-9._-]/g, "-")}`)
  if (existsSync(path)) throw new Error(`integrate: ${path} already exists`)
  git(root, ["worktree", "add", "-b", into, path, base])

  const merged: string[] = []
  try {
    for (const branch of branches) {
      try {
        git(path, ["merge", "--no-ff", "-m", `crew: integrate ${branch}`, branch])
        merged.push(branch)
      } catch {
        // Read the conflicted paths BEFORE aborting - `merge --abort` clears the index that
        // `--diff-filter=U` reads, so the order here is the whole reason the files can be
        // named at all.
        let files: string[] = []
        try {
          files = git(path, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean)
        } catch {
          /* an unreadable index must not mask the conflict itself */
        }
        try {
          git(path, ["merge", "--abort"])
        } catch {
          /* already clean, or never started - either way the abort has nothing to undo */
        }
        return { ok: false, branch: into, merged, conflicted: branch, files }
      }
    }
    return { ok: true, branch: into, merged }
  } finally {
    try {
      git(root, ["worktree", "remove", path, "--force"])
    } catch {
      /* leave it for the human rather than escalate a cleanup failure over a good merge */
    }
  }
}

// ------------------------------------------------------------------ the report

export type CrewTask = {
  title: string
  slug: string
  /** 1-based wave, so the report can show what was attempted concurrently */
  wave: number
  /** the run, when the task actually ran */
  run?: RunResult
  /** why it never ran. Set only when `run` is absent - a task with neither is a bug */
  skipped?: string
  /**
   * Carried forward from an interrupted run rather than executed by this one.
   *
   * The report must say so. A resumed branch is real work and belongs in the integration,
   * but presenting it as something THIS run did would make the record claim a span of work
   * it never performed - and the record is the only thing standing in for the approval gate.
   */
  resumed?: boolean
  /**
   * Recovered from a branch on disk rather than from a checkpoint.
   *
   * Weaker evidence, and the report says so. A branch proves work was committed; it never
   * proves the task finished, because a task that crashed after its second of three items
   * leaves a branch that looks exactly like a complete one.
   */
  inferred?: boolean
}

export type CrewResult = {
  directive: string
  /** lanes that reviewed the integrated branch */
  roles: Role[]
  /** straight from schedule(). Surfaced, never summarised away */
  scheduling: { mode: "graph" | "partial" | "sequential"; ungraphed: string[]; waves: number }
  tasks: CrewTask[]
  integration?: Integration
  /** verify on the integrated branch - the only check that covers the tasks combined */
  verify?: { ok: boolean; output: string }
  /**
   * The harness scorecard on the integrated branch, against the pre-run baseline recorded
   * in the ADR.
   *
   * Crew has no approval gate, so the ADR and this report are the entire safety story. A
   * run that shipped every task and left the repo measurably worse is a finding, and it is
   * one no per-task outcome can show — each task only ever saw its own attempt.
   */
  harness?: { before?: HarnessAudit; after?: HarnessAudit; unavailable?: string }
  review?: { blockers: number; suggestions: number; nits: number; convergence: string; dropped: number }
  /** path to the ADR holding the interview, the research and the design */
  adr?: string
  /** set when the run threw rather than finished */
  error?: string
}

const DONE = "done"

/** Did this task finish with its acceptance met? */
const succeeded = (t: CrewTask) => !!t.run && t.run.outcomes.length > 0 && t.run.outcomes.every((o) => o.state === DONE)

/**
 * The CEO report: what shipped, what it decided, what it could not do, what needs you.
 *
 * Pure, so the honesty rules are testable without a model or a repo. Those rules are
 * inherited from renderRun and are not negotiable here:
 *   - an incomplete run says INCOMPLETE in the first line, never "done with caveats"
 *   - a task that never ran is listed WITH ITS REASON, never omitted for tidiness
 *   - a suppressed PR says it was suppressed, so the absence is not read as a failed push
 *   - an unjudged acceptance says so rather than passing quietly
 *   - the schedule's mode and ungraphed files are shown, because "it ran sequentially" is
 *     otherwise an unexplained cost the user cannot act on
 */
export function renderCrewReport(r: CrewResult): string {
  const out: string[] = []
  const ran = r.tasks.filter((t) => t.run)
  const never = r.tasks.filter((t) => !t.run)
  const shipped = r.tasks.filter(succeeded)
  const fell = ran.filter((t) => !succeeded(t))

  // Every reason this run is not clean. Computed from the record, never asserted.
  const problems: string[] = []
  if (r.error) problems.push(`the run crashed: ${r.error}`)
  if (never.length) problems.push(`${never.length} task(s) never ran`)
  if (fell.length) problems.push(`${fell.length} task(s) did not meet acceptance`)
  if (r.integration && !r.integration.ok)
    problems.push(`integration stopped at \`${r.integration.conflicted}\``)
  if (r.verify && !r.verify.ok) problems.push("verify failed on the integrated branch")
  // A shipped-but-degraded run is not a clean run. Crew has no human gate, so if this does
  // not reach the first line nobody will read far enough to find it.
  const harnessDrops =
    r.harness?.before && r.harness?.after && r.harness.before.rubric === r.harness.after.rubric
      ? Object.entries(r.harness.before.categories).filter(
          ([k, v]) => typeof r.harness!.after!.categories[k] === "number" && r.harness!.after!.categories[k] < v,
        )
      : []
  if (harnessDrops.length)
    problems.push(`the harness scorecard regressed in ${harnessDrops.length} category/categories`)
  if (!r.integration) problems.push("nothing was integrated")
  if (r.integration?.ok && !r.verify) problems.push("the integrated branch was never verified")
  if (r.review?.blockers) problems.push(`${r.review.blockers} blocker(s) from review`)

  out.push(`# Crew — ${r.directive || "(no directive recorded)"}`)
  out.push("")
  out.push(
    problems.length
      ? `**INCOMPLETE.** ${problems.join("; ")}.`
      : `**Complete.** ${shipped.length}/${r.tasks.length} task(s) shipped, integrated and verified.`,
  )

  // ---- what shipped
  out.push("", "## What shipped")
  if (!r.tasks.length) out.push("Nothing — the plan had no tasks.")
  for (const t of r.tasks) {
    if (!t.run) {
      out.push(`- ⨯ **${t.title}** (wave ${t.wave}) — NEVER RAN: ${t.skipped ?? "no reason recorded (this is a bug)"}`)
      continue
    }
    const bad = t.run.outcomes.filter((o) => o.state !== DONE)
    const mark = succeeded(t) ? "✓" : "⚠"
    out.push(
      `- ${mark} **${t.title}** (wave ${t.wave}) — \`${t.run.branch}\`, stopped: ${t.run.stoppedBy}` +
        (t.resumed
          ? t.inferred
            ? " · **carried forward from an earlier run, recovered from the branch — no checkpoint recorded it**"
            : " · **carried forward from an earlier run**"
          : ""),
    )
    for (const o of bad) out.push(`    - ${o.state}: ${o.item.title}${o.detail ? ` — ${o.detail}` : ""}`)
    // An acceptance nobody independently judged is not an acceptance that passed.
    const unjudged = t.run.outcomes.filter((o) => o.state === DONE && !o.judged)
    for (const o of unjudged) out.push(`    - NOT independently judged: ${o.item.title}`)
  }

  // ---- what it decided
  out.push("", "## What it decided")
  out.push(`- Lanes recruited: ${r.roles.length ? r.roles.join(", ") : "(none)"}`)
  out.push(
    `- Scheduling: ${r.scheduling.mode}, ${r.scheduling.waves} wave(s) over ${r.tasks.length} task(s)`,
  )
  if (r.scheduling.mode === "sequential")
    out.push(
      "  - No dependency graph was readable, so nothing could be PROVEN independent and every task ran alone.",
      "  - Build the graph (`graphify-out/graph.json`) and this parallelises.",
    )
  if (r.scheduling.mode === "partial") {
    const shown = r.scheduling.ungraphed.slice(0, 10)
    out.push(
      `  - ${r.scheduling.ungraphed.length} file(s) are absent from the graph, so the tasks touching them could not be`,
      "    proven independent and were run alone:",
      ...shown.map((f) => `      • ${f}`),
      r.scheduling.ungraphed.length > shown.length
        ? `      • … and ${r.scheduling.ungraphed.length - shown.length} more`
        : "",
      "  - Rebuild the graph and this parallelises.",
    )
  }
  if (r.adr) out.push(`- Requirements and design recorded in ${r.adr}`)
  else out.push("- No ADR was recorded — the interview and the reasoning behind this run are NOT on file.")

  if (r.integration) {
    out.push(
      r.integration.ok
        ? `- Integrated ${r.integration.merged.length} branch(es) into \`${r.integration.branch}\`: ${r.integration.merged.join(", ") || "(none)"}`
        : `- Integration into \`${r.integration.branch}\` STOPPED at \`${r.integration.conflicted}\` after merging ${r.integration.merged.length}: ${r.integration.merged.join(", ") || "(none)"}`,
    )
  }
  if (r.verify) out.push(`- Verify on the integrated branch: ${r.verify.ok ? "passed" : "FAILED"}`)
  if (r.harness) {
    out.push(`- ${renderDelta(r.harness.before ?? null, r.harness.after ?? null)}`)
    // An audit that could not run is reported, not omitted. Silence here would be read as
    // "it held", which is the one thing the record must never imply without evidence.
    if (r.harness.unavailable) out.push(`  - the scorer did not run cleanly: ${r.harness.unavailable}`)
  }
  if (r.review)
    out.push(
      `- Review of the integrated branch: ${r.review.blockers} blocker(s), ${r.review.suggestions} suggestion(s), ${r.review.nits} nit(s) — ${r.review.convergence}` +
        (r.review.dropped ? ` (${r.review.dropped} lane(s) produced nothing)` : ""),
    )

  // ---- what it could not do
  out.push("", "## What it could not do")
  const could: string[] = []
  for (const t of never) could.push(`- **${t.title}**: ${t.skipped ?? "no reason recorded (this is a bug)"}`)
  for (const t of fell) {
    const worst = t.run!.outcomes.find((o) => o.state !== DONE)
    could.push(
      `- **${t.title}**: stopped by ${t.run!.stoppedBy}${worst ? ` — ${worst.state} on "${worst.item.title}"` : ""}`,
    )
  }
  if (r.integration && !r.integration.ok) {
    could.push(
      `- Merge \`${r.integration.conflicted}\` — it conflicts with what was already integrated. The merge was ABORTED, not resolved:`,
      "  a conflict is evidence the scheduler wrongly judged these tasks independent, and resolving it here would erase that.",
      ...r.integration.files.slice(0, 20).map((f) => `    • ${f}`),
    )
  }
  if (r.verify && !r.verify.ok)
    could.push(`- Get the integrated branch past verify:\n\`\`\`\n${r.verify.output.slice(-1500)}\n\`\`\``)
  out.push(could.length ? could.join("\n") : "Nothing was blocked.")

  // ---- what needs you
  out.push("", "## What needs you")
  const needs: string[] = []
  // Crew never opens per-task PRs. Saying so is not a formality: a reader who cannot tell
  // "suppressed" from "the push failed" goes hunting for a break that never happened.
  const suppressed = ran.filter((t) => t.run!.prSkipped)
  if (suppressed.length)
    needs.push(
      `- No pull request was opened for any of the ${suppressed.length} task branch(es), and none was attempted — crew`,
      "  integrates locally so N tasks cannot open N competing PRs. Nothing was pushed; the branches are local.",
    )
  for (const t of ran) {
    if (t.run!.prError) needs.push(`- A PR was attempted for **${t.title}** and failed: ${t.run!.prError}`)
  }
  if (r.integration?.ok)
    needs.push(`- Review and push \`${r.integration.branch}\` — it holds the combined work and nothing has been pushed.`)
  if (r.integration && !r.integration.ok)
    needs.push(
      `- Decide what to do about \`${r.integration.conflicted}\`: rerun it on top of \`${r.integration.branch}\`, or`,
      "  fix the file sets in the plan so the two tasks are not scheduled together.",
    )
  if (r.review?.blockers) needs.push(`- ${r.review.blockers} review blocker(s) are unresolved.`)
  if (never.length || fell.length)
    needs.push(`- ${never.length + fell.length} task(s) still need doing; nobody approved this plan, so check it did the right thing.`)
  out.push(needs.length ? needs.join("\n") : "- Review and push the integrated branch.")

  return out.join("\n")
}
