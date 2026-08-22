import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer, type Server } from "node:http"
import { issueIdentifierIn, findIssue, LinearError, type LinearCtx } from "./linear.ts"
import { linearTracker } from "./crew.ts"

// No Linear workspace is reachable from here, so these run against a stub that records
// what was sent. That cannot prove Linear accepts these mutations - only a real workspace
// can - but it does prove the client is internally consistent: that a plan status actually
// changes, that an incomplete run reports as `error` rather than `response`, and that a
// failure inside the tracker never escapes into the run.

type Call = { query: string; variables: any }

function stub(handler: (c: Call) => unknown): Promise<{ url: string; calls: Call[]; close: () => Promise<void> }> {
  const calls: Call[] = []
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      let body = ""
      req.on("data", (c) => (body += c))
      req.on("end", () => {
        const call = JSON.parse(body) as Call
        calls.push(call)
        let data: unknown
        try {
          data = handler(call)
        } catch (e: any) {
          res.writeHead(200, { "content-type": "application/json" })
          return res.end(JSON.stringify({ errors: [{ message: e.message }] }))
        }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ data }))
      })
    })
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

const ISSUE = { id: "uuid-1", identifier: "ENG-7", title: "t", url: "https://linear.app/x/issue/ENG-7" }
const route = (c: Call) => {
  if (c.query.includes("issue(id:")) return { issue: ISSUE }
  if (c.query.includes("agentSessionCreateOnIssue"))
    return { agentSessionCreateOnIssue: { success: true, agentSession: { id: "ses-1" } } }
  if (c.query.includes("agentActivityCreate")) return { agentActivityCreate: { success: true } }
  if (c.query.includes("agentSessionUpdate")) return { agentSessionUpdate: { success: true } }
  throw new Error(`unrouted query: ${c.query.slice(0, 60)}`)
}

const item = (title: string) => ({ title, detail: "", files: [], acceptance: "a" })
const outcome = (title: string, state: any, over: any = {}) => ({ item: item(title), state, attempts: 1, ...over })

test("an issue identifier is recognised, free text is not", () => {
  // Decides whether a directive can carry a Linear session at all.
  assert.equal(issueIdentifierIn("ENG-7"), "ENG-7")
  assert.equal(issueIdentifierIn("  LIN-123  "), "LIN-123")
  assert.equal(issueIdentifierIn("A1-9"), "A1-9")
  assert.equal(issueIdentifierIn("add a dark mode toggle"), null)
  assert.equal(issueIdentifierIn("fix ENG-7 please"), null, "must be the whole directive, not a mention")
  assert.equal(issueIdentifierIn("eng-7"), null, "identifiers are upper case")
})

test("a GraphQL error becomes a LinearError, not a parse failure", async () => {
  const s = await stub(() => {
    throw new Error("Authentication required")
  })
  try {
    await assert.rejects(
      () => findIssue({ token: "bad", endpoint: s.url } as LinearCtx, "ENG-7"),
      (e: any) => e instanceof LinearError && /Authentication required/.test(e.message),
    )
  } finally {
    await s.close()
  }
})

test("start opens a session, acknowledges, and posts the plan as pending", async () => {
  const s = await stub(route)
  try {
    const t = linearTracker({ token: "t", endpoint: s.url }, "ENG-7", () => {})
    await t.start({ directive: "d", items: [item("one"), item("two")], branch: "crew/x" })

    assert.ok(
      s.calls.some((c) => c.query.includes("agentSessionCreateOnIssue") && c.variables.input.issueId === "uuid-1"),
      "must create the session against the resolved uuid, not the identifier",
    )
    // Linear marks a session unresponsive without an activity within 10s of creation.
    assert.ok(
      s.calls.some((c) => c.variables?.input?.content?.type === "thought"),
      "must acknowledge immediately",
    )
    const plan = s.calls.find((c) => c.variables?.input?.plan)?.variables.input.plan
    assert.deepEqual(plan, [
      { content: "one", status: "pending" },
      { content: "two", status: "pending" },
    ])
  } finally {
    await s.close()
  }
})

test("a finished item flips exactly its own plan entry", async () => {
  const s = await stub(route)
  try {
    const t = linearTracker({ token: "t", endpoint: s.url }, "ENG-7", () => {})
    await t.start({ directive: "d", items: [item("one"), item("two")], branch: "crew/x" })
    await t.itemDone(outcome("one", "done", { commit: "abc" }))

    const plans = s.calls.filter((c) => c.variables?.input?.plan).map((c) => c.variables.input.plan)
    assert.deepEqual(plans.at(-1), [
      { content: "one", status: "completed" },
      { content: "two", status: "pending" },
    ])
  } finally {
    await s.close()
  }
})

test("an item that did not land is cancelled, never left pending", async () => {
  // A stuck item left `pending` reads as still-in-progress forever.
  const s = await stub(route)
  try {
    const t = linearTracker({ token: "t", endpoint: s.url }, "ENG-7", () => {})
    await t.start({ directive: "d", items: [item("one")], branch: "crew/x" })
    await t.itemDone(outcome("one", "unmet", { detail: "no 429 in the diff" }))

    const plan = s.calls.filter((c) => c.variables?.input?.plan).at(-1)!.variables.input.plan
    assert.equal(plan[0].status, "canceled")
    const action = s.calls.find((c) => c.variables?.input?.content?.type === "action")
    assert.match(action!.variables.input.content.result, /unmet/)
  } finally {
    await s.close()
  }
})

test("an incomplete run reports as error, a complete one as response", async () => {
  // The honesty property, mirrored. A green-looking summary over unfinished work is the
  // one failure that costs someone real time.
  for (const [outcomes, expected] of [
    [[outcome("one", "done", { commit: "a" })], "response"],
    [[outcome("one", "done", { commit: "a" }), outcome("two", "failed-check")], "error"],
  ] as const) {
    const s = await stub(route)
    try {
      const t = linearTracker({ token: "t", endpoint: s.url }, "ENG-7", () => {})
      await t.start({ directive: "d", items: outcomes.map((o) => o.item), branch: "crew/x" })
      await t.finish({
        branch: "crew/x", worktree: "/w", outcomes: outcomes as any, cycles: [],
        pushed: true, stoppedBy: "complete", seconds: 5,
      })
      const final = s.calls.filter((c) => ["response", "error"].includes(c.variables?.input?.content?.type)).at(-1)
      assert.equal(final!.variables.input.content.type, expected)
    } finally {
      await s.close()
    }
  }
})

test("a PR url is added rather than replacing the session's other links", async () => {
  const s = await stub(route)
  try {
    const t = linearTracker({ token: "t", endpoint: s.url }, "ENG-7", () => {})
    await t.start({ directive: "d", items: [item("one")], branch: "crew/x" })
    await t.finish({
      branch: "crew/x", worktree: "/w", outcomes: [outcome("one", "done", { commit: "a" })] as any,
      cycles: [], pushed: true, prUrl: "https://github.com/o/r/pull/1", stoppedBy: "complete", seconds: 5,
    })
    const link = s.calls.find((c) => c.variables?.input?.addedExternalUrls)
    assert.ok(link, "must use addedExternalUrls, not externalUrls — the latter replaces the whole array")
    assert.equal(link!.variables.input.addedExternalUrls[0].url, "https://github.com/o/r/pull/1")
  } finally {
    await s.close()
  }
})

test("an unreachable Linear never reaches the run", async () => {
  // The work is real; the mirror is not.
  const t = linearTracker({ token: "t", endpoint: "http://127.0.0.1:1" }, "ENG-7", () => {})
  await assert.rejects(() => t.start({ directive: "d", items: [], branch: "b" }))
  // ...which is why trackerFor wraps it in guarded(); proven separately in crew.test.ts.
})
