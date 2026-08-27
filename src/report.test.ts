import { test } from "node:test"
import assert from "node:assert/strict"
import { renderPatches, renderReport } from "./report.ts"
import type { Patch } from "./engine.ts"
import type { Finding } from "./decide.ts"

const finding: Finding = {
  tier: "BLOCKER",
  category: "security",
  file: "a.ts",
  line: 3,
  issue: "sql injection",
  why: "w",
  fix: "x",
  confidence: "high",
  model: "gpt56terra",
  role: "security",
}

const patch = (over: Partial<Patch> = {}): Patch => ({
  finding,
  patch: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new",
  explanation: "e",
  confident: true,
  model: "openai/gpt-5.6-terra",
  state: "ok",
  verified: true,
  verifier: "mimo",
  attempts: 1,
  ...over,
})

// The central claim of the fix loop is that a patch nobody independently checked is not
// done. If these ever collapse into one bucket, that claim is silently false.
test("an unverified patch is never presented as verified", () => {
  const out = renderPatches([patch({ verified: false, detail: "verifier unavailable" })])
  assert.match(out, /0 verified/)
  assert.match(out, /1 unverified/)
  assert.match(out, /Produced, but not verified/)
})

test("a verified patch is presented as ready, with its verifier named", () => {
  const out = renderPatches([patch()])
  assert.match(out, /1 verified/)
  assert.match(out, /0 unverified/)
  assert.match(out, /confirmed resolved by mimo/)
  assert.doesNotMatch(out, /Produced, but not verified/)
})

test("a patch still rejected after retries is reported unresolved, not ready", () => {
  const out = renderPatches([
    patch({ state: "unresolved", confident: false, verified: false, attempts: 2, verifyReason: "still interpolates" }),
  ])
  assert.match(out, /0 verified/)
  assert.match(out, /1 unresolved/)
  assert.match(out, /Still unresolved after retries/)
  assert.match(out, /still interpolates/)
})

test("a low-confidence fixer result is escalated rather than offered", () => {
  const out = renderPatches([patch({ confident: false })])
  assert.match(out, /1 need a decision/)
  assert.match(out, /Needs your decision/)
})

test("nothing is ever described as applied", () => {
  const out = renderPatches([patch(), patch({ verified: false }), patch({ state: "failed" })])
  assert.match(out, /Nothing has been applied/)
})

const reviewFixture = (over: Record<string, unknown> = {}) => ({
  verdictCounts: { blockers: 0, suggestions: 0, nits: 0 },
  kept: [], nodes: [], dropped: [], disputed: [], substituted: [],
  debate: [], convergence: "no disputes",
  ...over,
}) as any

test("a debate round that moves a position is reported as having moved it", () => {
  // The debate loop has never executed with maxRounds > 0. Asserting on a live review would
  // be non-deterministic - converged() returns done immediately when there are no disputes,
  // so a small diff plausibly yields 0 rounds and would 'pass' having proven nothing.
  const out = renderReport(reviewFixture({
    debate: [{ round: 1, revisions: [
      { model: "opus5", tier: "SUGGESTION", changed: true },
      { model: "fable", tier: "BLOCKER", changed: false },
    ] }],
    convergence: "no tier moved",
  }), { files: ["x.ts"], ms: 1234 })

  assert.match(out, /## Convergence/)
  assert.match(out, /Round 1/)
  assert.match(out, /1 changed position/)
  assert.match(out, /opus5→SUGGESTION/)
})

// --- essential reviewers ------------------------------------------------------------

const node = (role: string, slug: string, state = "ok", over: Record<string, unknown> = {}) =>
  ({ node: { role, slug, model: `m/${slug}` }, state, ms: 1, findings: [], ...over }) as any

test("a lane that ran without its essential reviewer says so", () => {
  // The whole point of pinning a reviewer is that you notice when it did not review, and
  // the substituted case is the one that hides best: the participation table shows three
  // security nodes, all `ok`, and the panel looks complete.
  const out = renderReport(
    reviewFixture({
      nodes: [
        node("security", "gpt56sol"),
        node("security", "opus5"),
        node("security", "minimax", "ok", {
          substituted: [{ from: "fable", state: "timeout", detail: "aborted after 90s" }],
        }),
      ],
    }),
    { files: ["src/auth.ts"], ms: 1 },
  )
  assert.match(out, /Security ran without fable, its essential reviewer/)
  assert.match(out, /timeout/, "the reason it was absent must be named, not just the absence")
})

test("an essential reviewer that dropped outright is named with its state", () => {
  const dropped = node("security", "fable", "autherror", { detail: "401 from the provider" })
  const out = renderReport(
    reviewFixture({ nodes: [node("security", "opus5"), dropped], dropped: [dropped] }),
    { files: ["src/auth.ts"], ms: 1 },
  )
  assert.match(out, /Security ran without fable, its essential reviewer/)
  assert.match(out, /401 from the provider/)
})

test("no line when the essential reviewer actually reviewed", () => {
  const out = renderReport(
    reviewFixture({ nodes: [node("security", "fable"), node("security", "opus5")] }),
    { files: ["src/auth.ts"], ms: 1 },
  )
  assert.doesNotMatch(out, /ran without fable/, "it reviewed; there is nothing to report")
})

test("no line when the lane was never part of this run", () => {
  // A docs-only diff does not wake security, and reporting a missing security reviewer on
  // a run that never asked for one would be noise that trains people to ignore the line.
  const out = renderReport(reviewFixture({ nodes: [node("docs", "gemini36")] }), {
    files: ["README.md"],
    ms: 1,
  })
  assert.doesNotMatch(out, /essential reviewer/)
})
