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
/** Parts of the final assistant message, so an empty completion can say what it got. */
let lastParts = null
/** The provider error on the settled turn, if any - usually the real explanation. */
let lastError = ""
console.log(`polling every ${POLL_S}s, ceiling ${MAX_MIN}m — the run outlives this script if it dies`)

while (Date.now() < deadline) {
  await sleep(POLL_S * 1000)

  // Message state is the authority on whether the turn is over. Session listing alone
  // cannot tell "still working" from "finished and idle".
  let done = false
  try {
    const msgs = await api(`/session/${session.id}/message${q}`)
    const list = Array.isArray(msgs) ? msgs : []

    // Assistant text accumulates across EVERY assistant message after the last user turn,
    // not just the final one. A tool-using turn emits several - `step-start, reasoning,
    // tool, step-finish` then `step-start, reasoning, text, step-finish` - so reading only
    // the last message reports "no text" on a turn that answered perfectly well.
    let lastUser = -1
    for (let i = list.length - 1; i >= 0; i--) {
      if ((list[i]?.info ?? list[i])?.role === "user") { lastUser = i; break }
    }
    const turn = list.slice(lastUser + 1)

    lastParts = turn.flatMap((m) => m?.parts ?? [])
    for (const m of turn) {
      const e = (m?.info ?? m)?.error
      if (e) lastError = `${e.name ?? "error"}: ${String(e.data?.message ?? "").slice(0, 160)}`
    }
    const texts = lastParts.filter((p) => p?.type === "text").map((p) => p.text).join("\n")

    // Settled when the newest assistant message carries a completion time. Requiring text
    // as well was tried and is wrong: a model CAN legitimately finish with nothing, and
    // that combination then polls to the ceiling instead of reporting the empty answer.
    const tail = turn[turn.length - 1]
    const tailInfo = tail?.info ?? tail
    if (tailInfo?.role === "assistant" && tailInfo?.time?.completed) done = true
    if (texts.length > lastPrinted) {
      process.stdout.write(texts.slice(lastPrinted))
      lastPrinted = texts.length
    }
  } catch (e) {
    const msg = String(e?.message ?? e)
    // opencode 1.18.31 accepts a `format` on the message POST and then cannot serialize
    // that message back: GET /session/<id>/message returns 400 "Expected
    // OutputFormatJsonSchema". Verified 2026-09-22 - no schema reads fine, every schema
    // variant 400s, and `?limit=1` works only because it stops before the assistant
    // message. Polling can never see this turn finish, so say so once and stop, rather
    // than run silently to the ceiling and look like a hang.
    if (msg.includes("OutputFormatJsonSchema")) {
      console.log(
        `\n--- cannot poll this session ---\n` +
          `    opencode ${"1.18.31"} cannot read back a message whose request carried a JSON schema,\n` +
          `    so completion is undetectable from here. THE RUN IS STILL GOING - watch its own\n` +
          `    artifacts instead: council-artifacts/<newest>/run.log`,
      )
      break
    }
    // Any other poll failure is not a run failure. Say so and keep polling.
    console.error(`  (poll error: ${msg.slice(0, 100)})`)
  }

  if (done) {
    // A turn that completes with nothing to show is NOT the same as one that worked, and
    // printing the same line for both is how a silent failure reads as a success.
    // Measured 2026-09-22: a council fan-out whose lanes all failed fast returned an
    // assistant message with zero parts, and the driver reported only "complete".
    if (!lastPrinted) {
      const types = (lastParts ?? []).map((p) => p?.type).filter(Boolean)
      // The provider's own error is the answer most of the time, and it is carried on the
      // message rather than in its parts. Measured 2026-09-22: a 5-hour quota limit (429)
      // rendered as a bare "no text", sending me to look at the driver for a problem that
      // was a usage cap with a stated reset time.
      const err = lastError
      console.log(
        `\n--- assistant turn complete, but produced NO TEXT (parts: ${types.join(", ") || "none"}) ---` +
          (err ? `\n    provider said: ${err}` : "") +
          `\n    Check the run's own artifacts — council-artifacts/<newest>/run.log is written` +
          `\n    as the run goes and survives this script either way.`,
      )
    } else {
      console.log("\n--- assistant turn complete ---")
    }
    break
  }
}

const settled = await Promise.race([inflight, sleep(1000).then(() => null)])
if (settled && !settled.ok) console.log(`(the POST connection ended as ${settled.text} — expected on long runs)`)
if (Date.now() >= deadline) console.log(`\n--- drive ceiling ${MAX_MIN}m reached; the run may still be going ---`)
