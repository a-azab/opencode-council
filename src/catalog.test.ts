import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openCache, probeBudget, parseCatalog, successorOf, successorsOf, resolvePins } from "./catalog.ts"
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

test("successorsOf lists every higher version, lowest first", () => {
  const offered = ["opencode-go/grok-4.6", "opencode-go/grok-5.0", "opencode-go/grok-4.5", "openai/gpt-5.7-sol"]
  assert.deepEqual(successorsOf("opencode-go/grok-4.5", offered), ["opencode-go/grok-4.6", "opencode-go/grok-5.0"],
    "ascending, so [0] is the conservative step and the tail is the newest")
  assert.equal(successorOf("opencode-go/grok-4.5", offered), "opencode-go/grok-4.6", "successorOf stays the smallest step")
  assert.deepEqual(successorsOf("openai/gpt-5.6-terra", offered), [], "a sibling tier is never a successor")
})

test("a newer version is adopted only once something has measured it", async () => {
  // The hazard this guards: google/gemini-3.7-flash times out at 90s where 3.6 answers in
  // 9s. A tool that adopted the higher number on sight would have taken a working lane out
  // and called it an upgrade. Driven entirely from the cache here, so no model is called.
  const dir = mkdtempSync(join(tmpdir(), "pins-"))
  try {
    const cache = openCache(join(dir, "cap.json"))
    const offered = ["p/m-1.0", "p/m-1.1", "p/m-2.0"]
    const ctx = { serverUrl: "http://127.0.0.1:1" } // never reached: every candidate is cached

    // Newest measured good -> taken, major bump included.
    cache.record("p/m-2.0", "schema", { ok: true, ms: 111 })
    let r = await resolvePins(ctx as any, ["p/m-1.0"], offered, { cache, budget: 0 })
    assert.equal(r.map.get("p/m-1.0"), "p/m-2.0")
    assert.deepEqual(r.adopted, [{ from: "p/m-1.0", to: "p/m-2.0", ms: 111 }])

    // Newest measured BAD -> falls to the next one down rather than to nothing.
    cache.contradict("p/m-2.0", "schema")
    cache.record("p/m-2.0", "schema", { ok: false, ms: 90_000 })
    cache.record("p/m-1.1", "schema", { ok: true, ms: 50 })
    r = await resolvePins(ctx as any, ["p/m-1.0"], offered, { cache, budget: 0 })
    assert.equal(r.map.get("p/m-1.0"), "p/m-1.1", "a bad release costs one probe, not the lane")

    // Every candidate measured bad -> the pin stands, and nothing is claimed.
    cache.contradict("p/m-1.1", "schema")
    cache.record("p/m-1.1", "schema", { ok: false, ms: 1 })
    r = await resolvePins(ctx as any, ["p/m-1.0"], offered, { cache, budget: 0 })
    assert.equal(r.map.size, 0, "the pin stands")
    assert.deepEqual(r.adopted, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an unmeasured candidate with no probe budget leaves the pin alone, and says so", async () => {
  // Silently keeping the old model is right. Silently implying it was checked is not - that
  // is the difference between "no upgrade found" and "no upgrade looked for".
  const dir = mkdtempSync(join(tmpdir(), "pins-"))
  try {
    const cache = openCache(join(dir, "cap.json"))
    const r = await resolvePins({ serverUrl: "http://127.0.0.1:1" } as any, ["p/m-1.0"], ["p/m-9.9"], {
      cache,
      budget: 0,
    })
    assert.equal(r.map.size, 0)
    assert.deepEqual(r.unchecked, ["p/m-1.0"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a probe never inherits the caller's timeout", () => {
  // resolvePins runs on the first model call of the process, and that call may be the
  // implementer's - whose ctx carries IMPLEMENT_TIMEOUT_MS (10 min). A dead candidate
  // inheriting it would hold the entire run before the real work started.
  const src = readFileSync(new URL("./catalog.ts", import.meta.url), "utf8")
  const fn = src.slice(src.indexOf("export async function resolvePins"), src.indexOf("export function openCache"))
  assert.match(fn, /const probeCtx: Ctx = \{ \.\.\.ctx, timeoutMs: 60_000/, "probes are bounded independently")
  assert.match(fn, /probe\(probeCtx, candidate/, "and the bounded ctx is the one actually used")
})
