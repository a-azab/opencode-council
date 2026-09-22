#!/usr/bin/env node
// Drive a long-running council/lets/crew tool call without holding one HTTP response open.
//
// The trap this exists to avoid: undici (Node's fetch) caps the wait for response HEADERS
// at around five minutes, and that cap is NOT what `AbortSignal.timeout` controls. A crew
// run legitimately takes an hour, so a script that POSTs the message and awaits the reply
// dies with UND_ERR_HEADERS_TIMEOUT while the run continues perfectly well server-side.
// Measured 2026-09-22: the driver died at ~5 minutes on a run that went on to work for 63.
//
// So: fire the message, then poll. The run's own artifacts are the source of truth - the
// step log and the checkpoint are written as it goes, and they survive the driver dying,
// which is the property that matters.
//
// Usage:
//   node drive.mjs --dir /path/to/repo --text "Call the `crew` tool with mode:'execute'."
//   node drive.mjs --dir . --text "..." --model zai-coding-plan/glm-5.2 --poll 30
import { setTimeout as sleep } from "node:timers/promises"

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1])

const BASE = (args.get("server") ?? process.env.OPENCODE_SERVER ?? "http://127.0.0.1:4096").replace(/\/$/, "")
const DIR = args.get("dir") ?? process.cwd()
const TEXT = args.get("text")
const MODEL = args.get("model") ?? "zai-coding-plan/glm-5.2"
const AGENT = args.get("agent") ?? "build"
const POLL_S = Number(args.get("poll") ?? 30)
// A ceiling on the WHOLE drive, not on one request. Defaults above crew's own two-hour
// budget so the tool's ceiling is the one that fires, not this one.
const MAX_MIN = Number(args.get("max") ?? 150)

if (!TEXT) {
  console.error("usage: drive.mjs --dir <repo> --text <prompt> [--model p/m] [--agent a] [--poll 30] [--max 150]")
  process.exit(2)
}

const user = process.env.OPENCODE_SERVER_USERNAME
const pass = process.env.OPENCODE_SERVER_PASSWORD
const H = {
  "content-type": "application/json",
  ...(user && pass ? { authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") } : {}),
}
const q = `?directory=${encodeURIComponent(DIR)}`

/** Short calls only. Anything that can outlive undici's header cap must be polled instead. */
async function api(path, init = {}, ms = 30_000) {
  const r = await fetch(`${BASE}${path}`, { headers: H, signal: AbortSignal.timeout(ms), ...init })
  const text = await r.text()
  if (r.status >= 300) throw new Error(`HTTP ${r.status} on ${path}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

const session = await api(`/session${q}`, { method: "POST", body: JSON.stringify({ title: "drive" }) })
console.log(`session ${session.id}`)

const [providerID, ...rest] = MODEL.split("/")
const body = JSON.stringify({
  model: { providerID, modelID: rest.join("/") },
  agent: AGENT,
  parts: [{ type: "text", text: TEXT }],
})

// Fire and DO NOT await the response. The request stays open server-side; undici will give
// up on our end long before a crew run finishes, and that is fine - the catch swallows it
// rather than letting an unhandled rejection kill the process mid-poll.
const inflight = fetch(`${BASE}/session/${session.id}/message${q}`, { method: "POST", headers: H, body })
  .then((r) => r.text())
  .then((t) => ({ ok: true, text: t }))
  .catch((e) => ({ ok: false, text: String(e?.cause?.code ?? e?.message ?? e) }))

const deadline = Date.now() + MAX_MIN * 60_000
let lastPrinted = 0
console.log(`polling every ${POLL_S}s, ceiling ${MAX_MIN}m — the run outlives this script if it dies`)

while (Date.now() < deadline) {
  await sleep(POLL_S * 1000)

  // Message state is the authority on whether the turn is over. Session listing alone
  // cannot tell "still working" from "finished and idle".
  let done = false
  try {
    const msgs = await api(`/session/${session.id}/message${q}`)
    const last = Array.isArray(msgs) ? msgs[msgs.length - 1] : null
    const info = last?.info ?? last
    if (info?.role === "assistant" && info?.time?.completed) done = true

    const texts = (last?.parts ?? []).filter((p) => p?.type === "text").map((p) => p.text).join("\n")
    if (texts.length > lastPrinted) {
      process.stdout.write(texts.slice(lastPrinted))
      lastPrinted = texts.length
    }
  } catch (e) {
    // A poll that fails is not a run that failed. Say so and keep polling.
    console.error(`  (poll error: ${String(e?.message ?? e).slice(0, 100)})`)
  }

  if (done) {
    console.log("\n--- assistant turn complete ---")
    break
  }
}

const settled = await Promise.race([inflight, sleep(1000).then(() => null)])
if (settled && !settled.ok) console.log(`(the POST connection ended as ${settled.text} — expected on long runs)`)
if (Date.now() >= deadline) console.log(`\n--- drive ceiling ${MAX_MIN}m reached; the run may still be going ---`)
