import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openCache, probeBudget, parseCatalog, successorOf } from "./catalog.ts"
import { renderModelsProposal } from "./report.ts"

test("the catalog flattens providers into provider/model ids", () => {
  // Verified shape from GET /config/providers on 2026-08-25: 9 providers, ~114 models.
  const ids = parseCatalog({ providers: [
    { id: "openai", models: { "gpt-5.6-sol": {}, "gpt-5.6-luna": {} } },
    { id: "anthropic", models: { "claude-opus-5": {} } },
  ] })
  assert.deepEqual(ids.sort(), ["anthropic/claude-opus-5", "openai/gpt-5.6-luna", "openai/gpt-5.6-sol"])
})

test("the cache round-trips and a contradicting failure invalidates it", () => {
  const dir = mkdtempSync(join(tmpdir(), "cap-"))
  try {
    const path = join(dir, "capability.json")
    const c = openCache(path)
    c.record("x/y", "schema", { ok: true, ms: 1200 })
    assert.equal(openCache(path).get("x/y", "schema")?.ok, true, "must survive a reopen")
    c.contradict("x/y", "schema")   // a malformed/failed call says otherwise
    assert.equal(c.get("x/y", "schema"), undefined, "a stale 'works' must not keep routing lanes")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a failed probe is remembered, so a dead model costs one probe not one per run", () => {
  const dir = mkdtempSync(join(tmpdir(), "cap-"))
  try {
    const path = join(dir, "capability.json")
    openCache(path).record("dead/model", "schema", { ok: false, ms: 90000 })
    assert.equal(openCache(path).get("dead/model", "schema")?.ok, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("the probe budget caps a bad day at three", () => {
  const b = probeBudget(3)
  assert.deepEqual([b.take(), b.take(), b.take(), b.take()], [true, true, true, false])
})

test("the models proposal names what changed and never claims to have applied it", () => {
  // gemini-3.7-flash times out at 90s while 3.6 answers in 9s. An auto-updater chasing
  // "latest" would have adopted it and quietly cost a lane, so this proposes only.
  const out = renderModelsProposal({
    roster: [{ slug: "gemini36", model: "google/gemini-3.6-flash" }] as any,
    catalog: ["google/gemini-3.6-flash", "google/gemini-3.7-flash"],
    probes: { "google/gemini-3.7-flash": { ok: false, ms: 90000 } },
  })
  assert.match(out, /gemini-3\.7-flash/)
  assert.match(out, /90000|90s|timed out/i, "the measurement must be shown, not hidden")
  assert.doesNotMatch(out, /\bapplied\b|\bupdated the roster\b/i)
})

test("a retired pin is matched to its immediate successor, and nothing else", () => {
  // opencode-go/grok-4.5 returned http 500 for an unknown stretch because the provider had
  // replaced it with 4.6. Nothing noticed: a dead pin looks exactly like a model having a
  // bad day, and failover covers for it rather than complaining.
  const offered = [
    "opencode-go/grok-4.6",
    "opencode-go/grok-5.0",
    "opencode-go/kimi-k3",
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-terra",
    "openai/gpt-5.7-sol",
    "zai-coding-plan/glm-5.3",
  ]
  assert.equal(successorOf("opencode-go/grok-4.5", offered), "opencode-go/grok-4.6",
    "the immediate successor, not the highest available - a major jump is a different model")

  assert.equal(successorOf("openai/gpt-5.6-sol", offered), "openai/gpt-5.7-sol",
    "the suffix must match: sol is a tier, and terra is not a newer sol")

  assert.equal(successorOf("opencode-go/kimi-k3", offered), null,
    "a name with no parseable version is left alone rather than guessed at")

  assert.equal(successorOf("zai-coding-plan/glm-5.3", offered), null, "already current")
  assert.equal(successorOf("opencode-go/grok-4.6", ["openai/grok-4.9"]), null,
    "never across providers")
})
