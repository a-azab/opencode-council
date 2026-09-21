import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "engine.ts"), "utf8")

// These assert the SHAPE of the cleanup contract. The behaviour itself was verified
// against the live server on 2026-09-21: a successful call left the session count
// unchanged at 98, and a failing call left it at 99. What tests can protect from here is
// the reasoning being edited away later, which is the part that would silently regress.

test("a session is disposed only on success", () => {
  // The asymmetry is the whole design. A session that answered has nothing left to tell
  // you; one that timed out or returned malformed output is the only surviving record of
  // what happened, and deleting it destroys the evidence exactly when someone is about to
  // go looking for it.
  assert.match(SRC, /if \(created\.id && result\.ok\) await disposeSession/)
})

test("the delete is awaited, not fired and forgotten", () => {
  // A run that exits while deletes are in flight leaves exactly the sessions this exists
  // to remove.
  assert.match(SRC, /await disposeSession\(ctx, created\.id\)/)
  assert.doesNotMatch(SRC, /void disposeSession|disposeSession\([^)]*\)\.catch/)
})

test("cleanup never throws into the run", () => {
  // A failed cleanup is a slightly untidy server. A failed RUN because cleanup threw is a
  // real loss, and the two must not be traded.
  const fn = SRC.slice(SRC.indexOf("async function disposeSession"))
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3)
  assert.match(body, /try \{/)
  assert.match(body, /\} catch \{/)
})

test("the delete is bounded by a timeout", () => {
  // Cleanup that blocks a run has inverted its own purpose.
  assert.match(SRC, /DISPOSE_TIMEOUT_MS/)
  const fn = SRC.slice(SRC.indexOf("async function disposeSession"))
  assert.match(fn.slice(0, 600), /AbortSignal\.timeout\(DISPOSE_TIMEOUT_MS\)/)
})

test("the id is recorded before the message is sent", () => {
  // So a timeout or crash mid-call still leaves the caller holding the id to dispose.
  const createIdx = SRC.indexOf("created.id = session.id")
  const messageIdx = SRC.indexOf("/message${qs}`")
  assert.ok(createIdx > 0 && messageIdx > 0)
  assert.ok(createIdx < messageIdx, "the id must be captured before the call that can hang")
})

test("nothing deletes by listing, title or age", () => {
  // The opencode server is SHARED with the human's own interactive sessions. A sweep that
  // looked like tidying would delete their work. Holding an id this process just created
  // is the entire safety argument, so there must be no path that discovers ids instead.
  const deletes = [...SRC.matchAll(/method:\s*"DELETE"/g)]
  assert.equal(deletes.length, 1, "exactly one delete path")
  assert.doesNotMatch(SRC, /GET[\s\S]{0,200}session[\s\S]{0,200}DELETE/)
  assert.doesNotMatch(SRC, /\.filter\([^)]*title[^)]*\)[\s\S]{0,200}DELETE/)
})
