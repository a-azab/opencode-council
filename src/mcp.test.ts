import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { localMcpServers, parseJsonc, mcpTracker, substitute } from "./mcp.ts"
import { parseCrewBlock, renderCrewBlock, trackerFor, availableTrackers, type McpConfig } from "./crew.ts"

// The tracker seam was built Linear-shaped and had to become tracker-agnostic: any MCP
// server configured in opencode.json (Jira, GitHub Issues, Plane, …) is a mirror now.
// These tests prove the generic path end to end against a REAL spawned server, because a
// client this small is exactly the kind of thing that "looks right" and frames wrong.

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "crew-mcp-"))
}

/**
 * A minimal MCP server: newline-delimited JSON-RPC over stdio, initialize handshake, and
 * tools/call recording every call to a file as JSON. That file is the test's evidence.
 */
function fakeServer(dir: string, name: string): { command: string[]; log: string } {
  const script = join(dir, `${name}.mjs`)
  const log = join(dir, `${name}.log`)
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs"
const log = ${JSON.stringify(log)}
const calls = []
let buf = ""
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
process.stdin.setEncoding("utf8").on("data", (c) => {
  buf += c
  for (let nl; (nl = buf.indexOf("\\n")) !== -1; ) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (!line) continue
    const m = JSON.parse(line)
    if (m.method === "initialize")
      send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } })
    else if (m.method === "notifications/initialized") { /* fine */ }
    else if (m.method === "tools/call") {
      calls.push({ tool: m.params.name, args: m.params.arguments })
      writeFileSync(log, JSON.stringify(calls))
      send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "recorded " + m.params.name }] } })
    } else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } })
  }
})`,
  )
  return { command: ["node", script], log }
}

test("parseJsonc survives comments, trailing commas, and URLs in strings", () => {
  assert.deepEqual(
    parseJsonc(`{
      // jira mirror
      "url": "https://example.com/x", /* keep */
      "a": [1, 2,],
    }`),
    { url: "https://example.com/x", a: [1, 2] },
  )
  assert.equal(parseJsonc("{ not json"), undefined, "garbage is undefined, not a crash")
})

test("localMcpServers reads opencode.json, tolerates jsonc, repo overrides global, skips remote", () => {
  const dir = scratch()
  try {
    const globalDir = join(dir, "global")
    mkdirSync(join(globalDir, "opencode"), { recursive: true })
    writeFileSync(
      join(globalDir, "opencode", "opencode.jsonc"),
      // the REAL opencode key is `mcp` (verified against the server's Config schema);
    // this test originally asserted `mcpServers` — the key I invented — and passed while
    // finding nothing on any actual machine
      `// trackers\n{ "mcp": {\n  "jira": { "type": "local", "command": ["jira-mcp", "--x"], "environment": { "TOKEN": "t" } },\n  "github": { "type": "remote", "url": "https://mcp.github.com" }, // remote: not spawnable\n  "off": { "type": "local", "command": ["x"], "enabled": false },\n} }`,
    )
    const repo = join(dir, "repo")
    mkdirSync(repo, { recursive: true })
    writeFileSync(
      join(repo, "opencode.json"),
      `{"mcpServers": {"jira": {"type": "local", "command": ["node", "jira-override.mjs"]}}}`,
    )

    const merged = localMcpServers(repo, { global: join(globalDir, "opencode") })
    assert.deepEqual([...merged.keys()], ["jira"], "repo overrides global by name")
    assert.equal(merged.get("jira")!.command[1], "jira-override.mjs", "repo overrides global by name")

    const globalOnly = localMcpServers(undefined, { global: join(globalDir, "opencode") })
    assert.ok(globalOnly.has("jira"))
    assert.ok(!globalOnly.has("github"), "remote-only entries are not offered for spawning")
    assert.ok(!globalOnly.has("off"), "enabled: false is a decision, not an oversight")
    assert.equal(globalOnly.get("jira")!.environment!.TOKEN, "t")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the mcp tracker calls the configured tools with substituted arguments", async () => {
  const dir = scratch()
  try {
    const fake = fakeServer(dir, "jira")
    const cfg: McpConfig = {
      server: "jira",
      start: "create_issue",
      step: "add_comment",
      item: "update_issue",
      finish: "close_issue",
      args: { issueKey: "${issue}", note: "${text}" },
    }
    const lines: string[] = []
    const t = mcpTracker(
      { name: "jira", command: fake.command },
      cfg,
      "ENG-7",
      (m) => lines.push(m),
    )

    await t.start({ directive: "fix login", items: [{ title: "a", detail: "", files: [], acceptance: "" }], branch: "crew/x" })
    t.step("halfway")
    await t.itemDone({ item: { title: "a", detail: "", files: [], acceptance: "" }, state: "done", attempts: 1, commit: "abc" })
    await t.finish({
      branch: "crew/x", worktree: "/w", cycles: [], pushed: false, seconds: 1, stoppedBy: "complete",
      outcomes: [{ item: { title: "a", detail: "", files: [], acceptance: "" }, state: "done", attempts: 1, commit: "abc" }],
    })

    const calls = JSON.parse(readFileSync(fake.log, "utf8"))
    assert.equal(calls.length, 4, "start, step, item, finish — one call each")
    assert.deepEqual(
      calls.map((c: any) => c.tool),
      ["create_issue", "add_comment", "update_issue", "close_issue"],
    )
    // the server's argument names win over ours, and ${issue}/${text} substituted
    assert.equal(calls[0].args.issueKey, "ENG-7")
    assert.equal(calls[1].args.note, "halfway")
    assert.ok(calls[3].args.note.includes("1/1 item(s)"), `finish summary carried: ${calls[3].args.note}`)
    // tool output came back as a visible line, not silence
    assert.ok(lines.some((l) => l.includes("recorded close_issue")))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a tracker with only a finish tool only calls finish", async () => {
  const dir = scratch()
  try {
    const fake = fakeServer(dir, "minimal")
    const t = mcpTracker(
      { name: "minimal", command: fake.command },
      { server: "minimal", finish: "post_summary" },
      null,
      () => {},
    )
    await t.start({ directive: "d", items: [], branch: "b" })
    await t.finish({
      branch: "b", worktree: "/w", cycles: [], pushed: false, seconds: 0, stoppedBy: "complete", outcomes: [],
    })
    const calls = JSON.parse(readFileSync(fake.log, "utf8"))
    assert.deepEqual(calls.map((c: any) => c.tool), ["post_summary"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the crew block round-trips mcp wiring", () => {
  const cfg = {
    verify: ["npm test"],
    base: "main",
    lanes: ["qa" as const],
    tracker: "mcp" as const,
    mcp: { server: "jira", step: "add_comment", finish: "close_issue", args: { issueKey: "${issue}" } },
  }
  const parsed = parseCrewBlock(renderCrewBlock(cfg))
  assert.equal(parsed?.tracker, "mcp")
  assert.deepEqual(parsed?.mcp, cfg.mcp)

  // tracker: mcp without a server is an invalid block, same rule as an unknown lane
  assert.equal(parseCrewBlock("```crew\nverify: npm test\nbase: main\nlanes: qa\ntracker: mcp\n```"), undefined)
  // malformed mcp-args JSON likewise
  assert.equal(
    parseCrewBlock("```crew\nverify: x\nbase: main\nlanes: qa\ntracker: mcp\nmcp-server: j\nmcp-args: {nope\n```"),
    undefined,
  )
})

test("trackerFor falls back to stdout with a reason when the server is unresolvable", () => {
  const dir = scratch()
  try {
    const lines: string[] = []
    const t = trackerFor("mcp", (m) => lines.push(m), {
      repoRoot: dir,
      mcp: { server: "ghost" },
    })
    assert.equal(t.name, "none", "unresolvable server degrades to the terminal tracker")
    assert.ok(lines.some((l) => l.includes("ghost") && l.includes("terminal only")), `${lines}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("substitute only touches the known placeholders", () => {
  assert.equal(substitute("${issue}: ${text}", { issue: "ENG-7", text: "hi" }), "ENG-7: hi")
  assert.equal(substitute("$5 and ${unknown}", {}), "$5 and ${unknown}")
})

test("an mcp tracker is offered once a local MCP server is configured", () => {
  const dir = scratch()
  try {
    const repo = join(dir, "repo")
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, "opencode.json"), `{"mcp":{"jira":{"type":"local","command":["x"]}}}`)
    assert.ok(availableTrackers({} as NodeJS.ProcessEnv, repo).includes("mcp"))
    // negative case via localMcpServers with BOTH dirs isolated: availableTrackers has no
    // dirs override, so testing it negative here would read the developer machine's real
    // global config — which has servers of its own.
    const empty = join(dir, "empty")
    mkdirSync(empty, { recursive: true })
    assert.equal(localMcpServers(empty, { global: empty }).size, 0, "no servers anywhere → not offered")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
