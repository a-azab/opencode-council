import { test } from "node:test"
import assert from "node:assert/strict"
import { isRetryable, DEFAULT_RETRY } from "./engine.ts"

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
