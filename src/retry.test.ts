import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { isRetryable, DEFAULT_RETRY, FALL_THROUGH_ON_TIMEOUT, ask } from "./engine.ts"

// The distinction this file protects: transient failures are worth money to retry,
// deterministic ones are not. Getting it backwards either burns budget reaching the same
// answer three times, or silently narrows coverage on a blip.

test("transient failures retry", () => {
  assert.equal(isRetryable("ratelimited"), true)
  assert.equal(isRetryable("timeout"), true)
  assert.equal(isRetryable("failed", { data: { statusCode: 503 } }), true)
  assert.equal(isRetryable("failed", { data: { statusCode: 500 } }), true)
  assert.equal(isRetryable("failed", { data: { isRetryable: true } }), true)
})

test("deterministic failures do NOT retry", () => {
  // a bad key stays bad
  assert.equal(isRetryable("autherror"), false)
  // a model that cannot produce a forced tool call will not manage it on attempt three
  assert.equal(isRetryable("malformed"), false)
  // 4xx is a request problem; the same request will fail identically
  assert.equal(isRetryable("failed", { data: { statusCode: 400 } }), false)
  assert.equal(isRetryable("failed", { data: { statusCode: 404 } }), false)
})

test("success is never retried", () => {
  assert.equal(isRetryable("ok"), false)
})

test("an unknown-shaped error does not retry by default", () => {
  // Absent evidence of transience, don't spend. Same asymmetry as decide().
  assert.equal(isRetryable("failed"), false)
  assert.equal(isRetryable("failed", {}), false)
  assert.equal(isRetryable("failed", { data: {} }), false)
})

test("the default policy is bounded and backs off", () => {
  assert.ok(DEFAULT_RETRY.maxAttempts >= 2 && DEFAULT_RETRY.maxAttempts <= 5)
  assert.ok(DEFAULT_RETRY.backoffFactor > 1, "must actually back off")
  assert.ok(DEFAULT_RETRY.maxInterval >= DEFAULT_RETRY.initialInterval)
  assert.equal(DEFAULT_RETRY.jitter, true, "jitter avoids synchronised retry storms across a fan-out")
})

// ---------------------------------------------------- 2026-08-29 incident

test("a timeout is retryable by default, and not for a caller with somewhere else to go", () => {
  // The incident's real mechanism. The implementer is an agentic session - read the code,
  // edit files, run the tests - and `ask`'s 90s default is sized for a single structured
  // answer, so every model timed out. Because a timeout was unconditionally retryable, each
  // one burned 3 attempts before the chain moved on: 7 models x 3 x 90s = 32 minutes of
  // timing out, and the item was then reported model-failed.
  assert.equal(isRetryable("timeout"), true, "a one-shot caller should still retry a timeout")
  assert.equal(
    isRetryable("timeout", undefined, FALL_THROUGH_ON_TIMEOUT),
    false,
    "a caller with a fallback chain must spend the next slot on a different model",
  )
  // Transient faults are unaffected - those are worth another go on the same model.
  assert.equal(isRetryable("ratelimited", undefined, FALL_THROUGH_ON_TIMEOUT), true)
  assert.equal(isRetryable("failed", { data: { statusCode: 503 } }, FALL_THROUGH_ON_TIMEOUT), true)
})

test("a rejected session blames the server, not whichever model was asked for", async () => {
  // Cost of getting this wrong, measured: the 2026-08-29 incident spent two runs chasing
  // provider credentials because the message read "deepseek/deepseek-v4-pro: session create
  // http 401". The credential was fine. The opencode server requires basic auth, the plugin
  // reads it from the environment, and a server given those as CLI flags rejects every
  // session this tool opens - whichever model it names.
  const server = createServer((_req, res) => {
    res.writeHead(401)
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as any).port
  try {
    const r = await ask(
      { serverUrl: `http://127.0.0.1:${port}`, retry: { ...DEFAULT_RETRY, maxAttempts: 1 } },
      { model: "deepseek/deepseek-v4-pro", text: "hi" },
    )
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.state, "autherror", "401 must abort the chain rather than try every model")
    assert.match(r.detail, /server rejected this tool's own session/)
    assert.match(r.detail, /OPENCODE_SERVER_USERNAME/, "and say what to do about it")
    assert.doesNotMatch(r.detail, /deepseek/, "naming the model is what sent the incident chasing credentials")
  } finally {
    server.close()
  }
})
