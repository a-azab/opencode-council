// The generic tracker: any MCP server configured in opencode.json, local or remote.
//
// Linear was the first native implementation and stays as a fast path, but the seam was
// never meant to end there — any tracker that ships an MCP server (Jira, GitHub Issues,
// Plane, you name it) should be mirrorable without us writing a client for it. This file
// resolves servers from the opencode config the user already maintains, so lets adds
// zero new configuration of its own for HOW to run a server — only WHAT to call on it.
//
// Both transports, because the interesting trackers are remote. stdio servers are spawned;
// remote ones are POSTed to over Streamable HTTP. The two share one `call()` surface so
// mcpTracker never learns which it is talking to.
//
// Remote servers usually need OAuth, and we do NOT run an OAuth flow: the token is read
// from whatever the machine already has (see `remoteAuth`). A remote server with no
// resolvable credential is not offered as a tracker rather than offered and then failing
// at the first call — an offered mirror that silently never mirrors is the failure the
// whole tracker seam exists to avoid.
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ItemOutcome, McpConfig, RunResult, Tracker, WorkItem } from "./lets.ts"

// ------------------------------------------------------------------ server resolution

export type McpServerSpec =
  | {
      transport: "local"
      name: string
      command: string[]
      environment?: Record<string, string>
      cwd?: string
    }
  | {
      transport: "remote"
      name: string
      url: string
      /** Ready-to-send Authorization header value, or undefined for an open server. */
      auth?: string
      headers?: Record<string, string>
    }

/**
 * Authorization for a remote server, from credentials the machine already holds.
 *
 * Order is explicitness first: an env var the user set for this server, then a stored
 * OAuth token, then nothing. We never run an OAuth flow and never prompt — a tracker is
 * a side channel, and a mirror that blocks a run on an interactive login would be worse
 * than no mirror.
 *
 * `MCP_TOKEN_<NAME>` uses the server's own name upper-cased with non-alphanumerics as
 * underscores, so `linear` reads MCP_TOKEN_LINEAR and `github-issues` reads
 * MCP_TOKEN_GITHUB_ISSUES.
 *
 * The OAuth path reads Hermes's token store, which is where an already-authorised remote
 * MCP connection keeps its grant. Reading it is deliberate: the user authorised this
 * server once, for this purpose, and asking them for a second personal API key to do the
 * same job would be asking for a credential we already have.
 */
export function remoteAuth(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  tokenDir = join(homedir(), ".hermes", "mcp-tokens"),
): string | undefined {
  const key = `MCP_TOKEN_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`
  const fromEnv = env[key]?.trim()
  // Taken verbatim when it already names a scheme, so a user can supply `Basic abc` or a
  // vendor's own prefix. A bare token is the common case and gets Bearer.
  if (fromEnv) return /^\S+\s/.test(fromEnv) ? fromEnv : `Bearer ${fromEnv}`

  const file = join(tokenDir, `${name}.json`)
  if (!existsSync(file)) return undefined
  try {
    const t = JSON.parse(readFileSync(file, "utf8"))
    if (typeof t?.access_token !== "string" || !t.access_token) return undefined
    // An expired grant is treated as absent rather than sent and rejected: the caller
    // then does not offer this server, which is a legible outcome. `expires_at` is
    // seconds since epoch in this store.
    if (typeof t.expires_at === "number" && t.expires_at * 1000 <= Date.now()) return undefined
    return `${t.token_type || "Bearer"} ${t.access_token}`
  } catch {
    return undefined
  }
}

/**
 * Parse JSONC: opencode config files may contain comments and trailing commas.
 *
 * Naive regex stripping breaks on `https://` inside strings, so this walks the text with a
 * tiny state machine instead. Returns undefined when the text is neither valid JSON nor
 * valid JSONC — a config we cannot read is a config we have no opinion about.
 */
export function parseJsonc(text: string): any | undefined {
  try {
    return JSON.parse(text)
  } catch {
    /* fall through to the tolerant scan */
  }
  let out = ""
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      out += c
      for (i++; i < text.length; i++) {
        out += text[i]
        if (text[i] === "\\") out += text[++i] ?? ""
        else if (text[i] === '"') break
      }
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i++
    } else out += c
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"))
  } catch {
    return undefined
  }
}

/**
 * Every local (stdio) MCP server the user has configured, merged global-then-repo so a
 * project can override a global entry by name. Remote-only entries are skipped: we cannot
 * spawn what we cannot speak to.
 */
export function localMcpServers(
  repoRoot?: string,
  dirs?: { global?: string; repo?: string },
  // Injected rather than read from the ambient environment so a test can exercise remote
  // resolution without depending on — or reading — the real machine's token store.
  env: NodeJS.ProcessEnv = process.env,
  tokenDir = join(homedir(), ".hermes", "mcp-tokens"),
): Map<string, McpServerSpec> {
  // XDG_CONFIG_HOME is the config ROOT, not the opencode dir — the global config lives at
  // $XDG_CONFIG_HOME/opencode, exactly as it does at ~/.config/opencode when unset.
  const globalDir = dirs?.global ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode")
  const files = [
    join(globalDir, "opencode.json"),
    join(globalDir, "opencode.jsonc"),
    ...(repoRoot || dirs?.repo
      ? [join(dirs?.repo ?? repoRoot!, "opencode.json"), join(dirs?.repo ?? repoRoot!, ".opencode", "opencode.json")]
      : []),
  ]
  const out = new Map<string, McpServerSpec>()
  for (const f of files) {
    if (!existsSync(f)) continue
    const parsed = parseJsonc(readFileSync(f, "utf8"))
    // The config key is `mcp` (confirmed against the server's own Config schema and live
    // configs). `mcpServers` is also accepted: the name appears all over MCP documentation
    // and costing nothing to tolerate, while rejecting it would silently find nothing.
    const servers = parsed?.mcp ?? parsed?.mcpServers
    if (!servers || typeof servers !== "object") continue
    for (const [name, raw] of Object.entries<any>(servers)) {
      if (raw?.enabled === false) continue // present-but-disabled is a decision, not an oversight

      // Remote first: opencode marks these `type: "remote"` with a `url`. Anything with a
      // url and no command is treated as remote even when the type is missing, because a
      // url is not spawnable and guessing "local" would only produce a confusing ENOENT.
      const url = typeof raw?.url === "string" ? raw.url : undefined
      if (url && (raw?.type === "remote" || !Array.isArray(raw?.command))) {
        const auth = remoteAuth(name, env, tokenDir)
        // Headers in the config win: a user who wrote an explicit Authorization there is
        // overriding whatever we would have resolved, which is the point of writing it.
        const headers =
          typeof raw?.headers === "object" && raw.headers
            ? Object.fromEntries(Object.entries<any>(raw.headers).map(([k, v]) => [k, String(v)]))
            : undefined
        const hasHeaderAuth = headers && Object.keys(headers).some((k) => k.toLowerCase() === "authorization")
        // No credential, no offer. Listing a server we cannot authenticate to would put a
        // tracker in front of the user that fails on its first call — the "offered but
        // silently never mirrors" outcome this seam exists to prevent.
        if (!auth && !hasHeaderAuth && raw?.requiresAuth !== false) continue
        out.set(name, { transport: "remote", name, url, ...(auth ? { auth } : {}), ...(headers ? { headers } : {}) })
        continue
      }

      // `type` may be omitted when `command` is present; anything else is not spawnable
      if ((raw?.type && raw.type !== "local") || !Array.isArray(raw?.command)) continue
      out.set(name, {
        transport: "local",
        name,
        command: raw.command.map(String),
        environment: typeof raw.environment === "object" && raw.environment ? raw.environment : undefined,
        cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
      })
    }
  }
  return out
}

// ------------------------------------------------------------------ MCP client

/**
 * One JSON-RPC session over the server's stdio. MCP framing on stdio is
 * newline-delimited JSON; requests are correlated by id. Server-initiated requests get a
 * method-not-found error rather than silence — a server blocked awaiting an answer would
 * hang the run for no reason we benefit from.
 */
class McpSession {
  private child: ChildProcess
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private dead: string | null = null

  private constructor(child: ChildProcess) {
    this.child = child
    let buf = ""
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      buf += chunk
      for (let nl; (nl = buf.indexOf("\n")) !== -1; ) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          continue // a non-JSON line is the server's business, not ours
        }
        if (msg?.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!
          this.pending.delete(msg.id)
          msg.error ? p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error))) : p.resolve(msg.result)
        } else if (msg?.method && msg?.id !== undefined)
          this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } })
        // notifications (logs, progress) are ignored
      }
    })
    child.on("exit", () => {
      this.dead = "server exited"
      for (const p of this.pending.values()) p.reject(new Error("MCP server exited"))
      this.pending.clear()
    })
  }

  static async spawn(spec: Extract<McpServerSpec, { transport: "local" }>): Promise<McpSession> {
    const child = spawn(spec.command[0], spec.command.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...spec.environment },
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
    })
    // stderr must be drained: a chatty server on a pipe nobody reads fills the buffer and
    // deadlocks the child. Not logged — server noise is not lets progress.
    child.stderr?.resume()
    const s = new McpSession(child)
    try {
      await s.request(
        "initialize",
        { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "opencode-council", version: "0" } },
        10_000,
      )
      s.send({ jsonrpc: "2.0", method: "notifications/initialized" })
      return s
    } catch (e) {
      s.stop()
      throw e
    }
  }

  private send(msg: unknown) {
    if (this.dead) throw new Error(`MCP session unusable: ${this.dead}`)
    this.child.stdin!.write(JSON.stringify(msg) + "\n")
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      try {
        this.send({ jsonrpc: "2.0", id, method, params })
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e as Error)
      }
    })
  }

  /** Call a tool; resolves to the concatenated text of its result content. */
  async call(tool: string, args: Record<string, unknown>, timeoutMs = 15_000): Promise<string> {
    const r = await this.request("tools/call", { name: tool, arguments: args }, timeoutMs)
    if (r?.isError) throw new Error(`tool ${tool} reported an error: ${JSON.stringify(r).slice(0, 200)}`)
    return (r?.content ?? [])
      .filter((c: any) => c?.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("\n")
      .trim()
  }

  stop() {
    try {
      this.child.kill()
    } catch {
      /* already gone */
    }
  }
}

/**
 * The same session, over Streamable HTTP, for remote servers.
 *
 * A separate class rather than a transport flag inside McpSession: the two share almost
 * no mechanism. stdio is a long-lived child with newline framing and id correlation
 * across one pipe; this is a POST per request, where the id only has to survive a single
 * round trip. Forcing them into one class would mean a constructor that is half-empty
 * whichever way it is built.
 *
 * Both expose `call(tool, args)` returning concatenated text, which is the entire surface
 * mcpTracker uses — so the tracker never learns which transport it has.
 */
class McpHttpSession {
  private nextId = 1
  /** Servers may hand back a session id on initialize; it is echoed on later calls. */
  private sessionId: string | null = null
  // Plain fields assigned in the body, NOT constructor parameter properties: this file is
  // executed unbuilt by node's strip-only TypeScript, which rejects `private readonly x`
  // in a parameter list with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. tsc accepts it, so the
  // typecheck passes and the plugin then fails to load at runtime.
  private readonly url: string
  private readonly headers: Record<string, string>

  private constructor(url: string, headers: Record<string, string>) {
    this.url = url
    this.headers = headers
  }

  static async connect(spec: Extract<McpServerSpec, { transport: "remote" }>): Promise<McpHttpSession> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // Both, because the spec allows a server to answer either way and Linear answers
      // with SSE. Sending only application/json gets a 406 from servers that stream.
      accept: "application/json, text/event-stream",
      ...(spec.auth ? { authorization: spec.auth } : {}),
      ...(spec.headers ?? {}),
    }
    const s = new McpHttpSession(spec.url, headers)
    await s.request(
      "initialize",
      { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "opencode-council", version: "0" } },
      15_000,
    )
    // A notification: no id, no reply expected, and a failure here is not fatal to the
    // session - some servers ignore it entirely.
    await s.notify("notifications/initialized").catch(() => {})
    return s
  }

  private async post(body: unknown, timeoutMs: number): Promise<{ status: number; text: string; sid: string | null }> {
    const h = { ...this.headers, ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}) }
    const r = await fetch(this.url, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { status: r.status, text: await r.text(), sid: r.headers.get("mcp-session-id") }
  }

  private async notify(method: string, params: unknown = {}): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, params }, 10_000)
  }

  /**
   * One request/response.
   *
   * The body may be plain JSON or an SSE stream carrying the same JSON-RPC envelope in a
   * `data:` line - Linear returns the latter. Parsing both here keeps that detail out of
   * every caller.
   */
  private async request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    const id = this.nextId++
    let res: { status: number; text: string; sid: string | null }
    try {
      res = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs)
    } catch (e: any) {
      // A timeout arrives as an AbortError, which says nothing useful on its own.
      throw new Error(
        e?.name === "TimeoutError" || e?.name === "AbortError"
          ? `MCP ${method} timed out after ${timeoutMs}ms`
          : `MCP ${method} failed: ${String(e?.message ?? e).slice(0, 200)}`,
      )
    }
    if (res.sid) this.sessionId = res.sid
    if (res.status >= 300)
      throw new Error(`MCP ${method} http ${res.status}: ${res.text.slice(0, 200) || "(empty body)"}`)

    let msg: any
    const line = res.text.split("\n").find((l) => l.startsWith("data:"))
    try {
      msg = JSON.parse(line ? line.slice(5).trim() : res.text)
    } catch {
      throw new Error(`MCP ${method} returned an unparseable body: ${res.text.slice(0, 200)}`)
    }
    if (msg?.error) throw new Error(msg.error.message ?? JSON.stringify(msg.error).slice(0, 200))
    return msg?.result
  }

  /** Call a tool; resolves to the concatenated text of its result content. */
  async call(tool: string, args: Record<string, unknown>, timeoutMs = 15_000): Promise<string> {
    const r = await this.request("tools/call", { name: tool, arguments: args }, timeoutMs)
    if (r?.isError) throw new Error(`tool ${tool} reported an error: ${JSON.stringify(r).slice(0, 200)}`)
    return (r?.content ?? [])
      .filter((c: any) => c?.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("\n")
      .trim()
  }

  stop() {
    /* nothing to kill: every call is its own request */
  }
}

/** What both sessions provide, and all the tracker needs. */
type McpClient = { call(tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<string>; stop(): void }

/** Connect by transport. The only place either class is named. */
export function openMcp(spec: McpServerSpec): Promise<McpClient> {
  return spec.transport === "remote" ? McpHttpSession.connect(spec) : McpSession.spawn(spec)
}

// ------------------------------------------------------------------ the tracker

/** Substitute `${issue}` `${directive}` `${branch}` `${text}` `${state}` in template strings. */
export function substitute(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\$\{(issue|directive|branch|text|state)\}/g, (_, k) => vars[k] ?? "")
}

/** Reused by the beads tracker's closing note — one run summary, not two that drift. */
export const summaryOf = (r: RunResult): string => {
  const done = r.outcomes.filter((o) => o.state === "done").length
  const lines = [
    `lets run ${r.stoppedBy}: ${done}/${r.outcomes.length} item(s) landed in ${Math.round(r.seconds)}s`,
    ...r.outcomes.map(
      (o) => `- ${o.state === "done" ? "✓" : "✗"} ${o.item.title}${o.commit ? ` (${o.commit})` : ""}`,
    ),
  ]
  if (r.prUrl) lines.push(`PR: ${r.prUrl}`)
  return lines.join("\n")
}

/**
 * Build the MCP tracker. Only the tool names configured in the lets block are called — a
 * tracker that just comments on finish is as valid as one that calls all four. Argument
 * names differ per server (`issueKey` vs `issue`), so `mcp-args` templates are merged over
 * our defaults and win: the server's names are the ones that have to match, not ours.
 */
export function mcpTracker(
  spec: McpServerSpec,
  cfg: McpConfig,
  issueRef: string | null | undefined,
  onStep: (m: string) => void,
): Tracker {
  let session: Promise<McpClient> | null = null
  const ensure = () => (session ??= openMcp(spec))

  // Spread order is the contract: built-in defaults < per-call values < user templates.
  // Templates win because the server's argument names are the ones that must match — a
  // user's {"text": "lets: ${text}"} overriding the raw call value is the whole point of
  // having templates at all.
  const vars = (extra: Record<string, string>): Record<string, unknown> => ({
    issue: issueRef ?? "",
    ...extra,
    ...Object.fromEntries(
      Object.entries(cfg.args ?? {}).map(([k, v]) => [k, substitute(v, { issue: issueRef ?? "", ...extra })]),
    ),
  })

  const call = async (tool: string | undefined, args: Record<string, unknown>, what: string) => {
    if (!tool) return
    const s = await ensure()
    const out = await s.call(tool, args)
    if (out) onStep(`  tracker(mcp:${spec.name}) ${what}: ${out.slice(0, 120)}`)
  }

  return {
    name: "mcp" as const,
    start: async (i: { directive: string; items: WorkItem[]; branch: string }) => {
      await call(
        cfg.start,
        vars({ directive: i.directive, branch: i.branch, text: i.items.map((x) => x.title).join("; ") }),
        "start",
      )
    },
    step: (message: string) => {
      if (!cfg.step || session === null) return // nothing to queue onto; step must stay cheap
      call(cfg.step, vars({ text: message }), "step").catch(() => {})
    },
    itemDone: async (o: ItemOutcome) => {
      await call(
        cfg.item,
        vars({ text: `${o.item.title}: ${o.state}`, state: o.state }),
        "item",
      )
    },
    finish: async (r: RunResult) => {
      try {
        await call(
          cfg.finish,
          vars({ branch: r.branch, state: r.stoppedBy, text: summaryOf(r) }),
          "finish",
        )
      } finally {
        session?.then((s) => s.stop(), () => {})
        session = null
      }
    },
  }
}
