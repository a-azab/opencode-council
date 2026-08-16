import { readdirSync, readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, basename } from "node:path"

const PKG = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Flat `key: value` frontmatter only.
 * ponytail: nested YAML would need a real parser dependency; nothing here needs it.
 * Agent permissions are set in code (AGENT_DEFAULTS) precisely so the files stay flat.
 * If a field ever genuinely needs nesting, add the dependency then, not now.
 */
function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!m) return { data: {}, body: raw }
  const data: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":")
    if (i === -1 || line.trimStart().startsWith("#")) continue
    data[line.slice(0, i).trim()] = line
      .slice(i + 1)
      .trim()
      .replace(/^["']|["']$/g, "")
  }
  return { data, body: raw.slice(m[0].length) }
}

function readMarkdownDir(dir: string): Array<{ name: string; data: Record<string, string>; body: string }> {
  const path = join(PKG, dir)
  if (!existsSync(path)) return []
  return readdirSync(path)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({
      name: basename(f, ".md"),
      ...parseFrontmatter(readFileSync(join(path, f), "utf8")),
    }))
}

/**
 * Role agents must be `mode: all`, never `subagent`.
 * Measured: `opencode run --agent <subagent>` prints a warning, falls back to `build`,
 * and still exits 0 — you would get a review from the wrong agent and never know.
 */
const AGENT_DEFAULTS = {
  mode: "all" as const,
  // Council roles analyse and propose patches as text. They never touch the workspace;
  // the only writer is `git apply`, run by the human after the gate. (D5)
  permission: { edit: "deny", bash: "deny" } as Record<string, string>,
}

export const CouncilPlugin = async () => ({
  config: async (config: any) => {
    config.command ??= {}
    for (const { name, data, body } of readMarkdownDir("command")) {
      config.command[name] = {
        description: data.description ?? `council: ${name}`,
        template: body,
        ...(data.agent ? { agent: data.agent } : {}),
        ...(data.model ? { model: data.model } : {}),
      }
    }

    config.agent ??= {}
    for (const { name, data, body } of readMarkdownDir("agent")) {
      config.agent[name] = {
        ...AGENT_DEFAULTS,
        description: data.description ?? `council role: ${name}`,
        prompt: body,
      }
    }
  },
})

export default CouncilPlugin
