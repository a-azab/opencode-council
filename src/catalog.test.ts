import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openCache, probeBudget, parseCatalog, successorOf, successorsOf, resolvePins, measuresCapability, ttlFor, FAILURE_TTL_MS, SUCCESS_TTL_MS, SLOW_TTL_MS } from "./catalog.ts"
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

test("a slow probe is remembered as latency, never as incapability", async () => {
  // Measured on this machine: opencode-go/mimo-v2.6-pro hit the 60s probe ceiling, yet
  // answers a real schema call correctly in 28s. Too slow for a trivial probe is a fact
  // about the clock; writing it down as ok:false would retire a model that works.
  const dir = mkdtempSync(join(tmpdir(), "slow-"))
  try {
    const path = join(dir, "cap.json")
    const cache = openCache(path)
    const offered = ["p/m-1.0", "p/m-1.1", "p/m-2.0"]
    const ctx = { serverUrl: "http://127.0.0.1:1" } // never reached: budget 0 is the proof

    cache.recordSlow("p/m-2.0")
    cache.record("p/m-1.1", "schema", { ok: true, ms: 50 })

    // The slow record must not read back as a capability verdict of any kind.
    assert.equal(cache.get("p/m-2.0", "schema"), undefined, "too slow is not incapable")

    // And it is skipped without spending a probe: with NO budget at all the search still
    // reaches the next candidate down. Were the slow candidate re-probed instead, budget 0
    // would stop the search on it and report the pin unchecked.
    const r = await resolvePins(ctx as any, ["p/m-1.0"], offered, { cache, budget: 0 })
    assert.equal(r.map.get("p/m-1.0"), "p/m-1.1", "the slow candidate cost nothing")
    assert.deepEqual(r.unchecked, [], "skipped, not deferred")

    // Surviving the reopen is the entire point - otherwise the next run re-pays the 60s.
    assert.equal(openCache(path).isSlow("p/m-2.0"), true)

    // Aged past the window by rewriting the timestamp on disk, the same thing a day does:
    // slow once is not slow forever, so it becomes worth one more probe.
    const raw = JSON.parse(readFileSync(path, "utf8"))
    raw._slow["p/m-2.0"] = Date.now() - SLOW_TTL_MS - 1000
    writeFileSync(path, JSON.stringify(raw))
    assert.equal(openCache(path).isSlow("p/m-2.0"), false, "expired: worth one more probe")
  } finally { rmSync(dir, { recursive: true, force: true }) }
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

test("only a malformed answer is evidence about capability", () => {
  // Measured 2026-09-23, hours apart: opencode/big-pickle refused with "free tier can only
  // be used from within OpenCode" and then answered normally; zai-coding-plan/glm-5.2 was
  // 429 for a five-hour quota window and then answered normally. The old rule recorded any
  // `failed` as incapable, which retires a working model for a reason that has expired.
  assert.equal(measuresCapability("malformed"), true, "answered, and got the schema wrong")
  for (const s of ["failed", "timeout", "ratelimited", "autherror"] as const)
    assert.equal(measuresCapability(s), false, `${s} describes the moment, not the model`)
})

test("a remembered failure expires sooner than a remembered success", () => {
  // Asymmetric because the costs are: a stale "works" self-corrects on the next call, a
  // stale "dead" is permanent - nothing re-probes a model the cache has written off.
  assert.ok(ttlFor(false) < ttlFor(true), "the expensive direction gets the short fuse")
  assert.equal(ttlFor(false), FAILURE_TTL_MS)
  assert.equal(ttlFor(true), SUCCESS_TTL_MS)
})

test("an aged-out failure is forgotten, so a model gets another chance", () => {
  const dir = mkdtempSync(join(tmpdir(), "cap-"))
  try {
    const path = join(dir, "capability.json")
    const c = openCache(path)
    c.record("x/y", "schema", { ok: false, ms: 900 })
    assert.equal(c.get("x/y", "schema")?.ok, false, "fresh: still believed")

    // Age it past the failure TTL by rewriting `at` on disk - the same thing a day does.
    const raw = JSON.parse(readFileSync(path, "utf8"))
    raw["x/y"].schema.at = Date.now() - FAILURE_TTL_MS - 1000
    writeFileSync(path, JSON.stringify(raw))
    assert.equal(openCache(path).get("x/y", "schema"), undefined, "expired: re-probe it")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("an entry with no timestamp is kept, not discarded", () => {
  // Entries written before `at` existed have no age to judge. Treating them as expired
  // would throw away every real measurement on the first run after the upgrade.
  const dir = mkdtempSync(join(tmpdir(), "cap-"))
  try {
    const path = join(dir, "capability.json")
    writeFileSync(path, JSON.stringify({ "x/y": { schema: { ok: true, ms: 100 } } }))
    assert.equal(openCache(path).get("x/y", "schema")?.ok, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("probe() sends a timeout to the slow record, not to the capability verdict", () => {
  // The gap this closes: the test above proves recordSlow() writes no verdict, and the
  // resolvePins test proves a slow candidate is skipped - but nothing pinned the seam
  // BETWEEN them, so probe() could route a timeout to cache.record() and both still pass.
  // That mutation is exactly the bug this item exists to prevent: a 60s ceiling written
  // down as ok:false, indistinguishable on disk from a model that answered wrongly.
  const src = readFileSync(new URL("./catalog.ts", import.meta.url), "utf8")
  const branch = src.slice(src.indexOf('} else if ((r as any).state === "timeout")'))
  assert.match(
    branch.slice(0, 120),
    /cache\.recordSlow\(model\)/,
    "a timed-out probe must be remembered as latency, never recorded as a capability result",
  )
  assert.doesNotMatch(
    branch.slice(0, 120),
    /cache\.record\(model,\s*kind/,
    "recording a timeout as a capability verdict is the bug, not the fix",
  )
})
