// The generic tracker: any local MCP server configured in opencode.json.
//
// Linear was the first native implementation and stays as a fast path, but the seam was
// never meant to end there — any tracker that ships an MCP server (Jira, GitHub Issues,
// Plane, you name it) should be mirrorable without us writing a client for it. This file
// resolves servers from the opencode config the user already maintains, so lets adds
// zero new configuration of its own for HOW to run a server — only WHAT to call on it.
//
// Deliberately stdio-only. Remote (HTTP) MCP servers are a different transport and
// usually need OAuth; when someone actually needs one, that is the moment to write it.
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ItemOutcome, McpConfig, RunResult, Tracker, WorkItem } from "./lets.ts"

// ------------------------------------------------------------------ server resolution

export type McpServerSpec = {
  name: string
  command: string[]
  environment?: Record<string, string>
  cwd?: string
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
): Map<string, McpServerSpec> {
  // XDG_CONFIG_HOME is the config ROOT, not the opencode dir — the global config lives at
  // $XDG_CONFIG_HOME/opencode, exactly as it does at ~/.config/opencode when unset.
  const globalDir = dirs?.global ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode")
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
      // `type` may be omitted when `command` is present; anything else is not spawnable
      if ((raw?.type && raw.type !== "local") || !Array.isArray(raw?.command)) continue
      out.set(name, {
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

  static async spawn(spec: McpServerSpec): Promise<McpSession> {
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
  let session: Promise<McpSession> | null = null
  const ensure = () => (session ??= McpSession.spawn(spec))

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
