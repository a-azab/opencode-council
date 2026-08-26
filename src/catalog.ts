// What can actually be used right now: what the server offers, and what those models have
// been MEASURED to do.
//
// Discovery and capability live in one file because they answer one question. A hardcoded
// ROSTER goes stale in both directions at once - `openai/gpt-5.5` sat pinned while three
// gpt-5.6 tiers superseded it, and `opencode/hy3-free` stayed listed while failing
// structured output 3/3. Existing is not the same as usable, so neither half is an answer
// on its own.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { ask, type Ctx } from "./engine.ts"

export type Kind = "schema" | "agentic"
export type Result = { ok: boolean; ms: number }
export type Entry = Result & { at: number }

/**
 * Flatten `/config/providers` into `provider/model` ids.
 *
 * Pure, so the shape can be asserted without a server - the suite makes no network calls.
 * Defensive about every key: this is a live payload from a server version we do not pin,
 * and a provider that arrives without `models` must contribute no ids rather than take a
 * review down.
 */
export function parseCatalog(json: any): string[] {
  const providers = Array.isArray(json?.providers) ? json.providers : []
  return providers.flatMap((p: any) =>
    p?.id && p?.models && typeof p.models === "object" ? Object.keys(p.models).map((m) => `${p.id}/${m}`) : [],
  )
}

/**
 * Offered models on a provider the roster already uses, that no member pins.
 *
 * Provider-scoped because that is what makes a candidate *plausible*: the roster is routed
 * by what each member is, and a sibling behind the same provider is the nearest thing to a
 * like-for-like swap. A model from a provider with no member is not an upgrade to anything,
 * it is a new relationship.
 *
 * Exported and shared by the probe loop and the renderer on purpose - two copies of this
 * rule would drift, and the report would then measure one set and display another.
 */
export const upgradeCandidates = (roster: { model: string }[], offered: string[]): string[] => {
  const provider = (id: string) => id.split("/")[0]
  const pinned = new Set(roster.map((m) => m.model))
  const inUse = new Set(roster.map((m) => provider(m.model)))
  return offered.filter((id) => inUse.has(provider(id)) && !pinned.has(id))
}

/** Memoised per run: a review asks once, not once per lane that needs a stand-in. */
let pending: Promise<string[]> | null = null

export function catalog(ctx: Ctx): Promise<string[]> {
  return (pending ??= fetchCatalog(ctx))
}

async function fetchCatalog(ctx: Ctx): Promise<string[]> {
  const base = ctx.serverUrl.replace(/\/$/, "")
  try {
    const r = await fetch(`${base}/config/providers`, {
      headers: { "content-type": "application/json", ...(ctx.auth ? { authorization: ctx.auth } : {}) },
    })
    if (r.status >= 300) return []
    return parseCatalog(await r.json())
  } catch {
    // Discovery is an optimisation over ROSTER, which still works. A server that will not
    // answer must cost us recruitment, not the review.
    return []
  }
}

const DEFAULT_PATH = join(homedir(), ".cache", "opencode-council", "capability.json")

/**
 * Measured capability, remembered across runs.
 *
 * Under `~/.cache` and never the repo: a probe result is a fact about this machine and this
 * account, not about the code. A teammate's exhausted quota committed to the tree would
 * route their lanes by our billing.
 *
 * Never throws. A cache is an optimisation, and one that can break a run is worse than no
 * cache at all - so a missing, corrupt or unwritable file is simply an empty one.
 */
export function openCache(path: string = DEFAULT_PATH) {
  let data: Record<string, Partial<Record<Kind, Entry>>> = {}
  try {
    data = JSON.parse(readFileSync(path, "utf8")) ?? {}
  } catch {
    data = {}
  }

  const save = () => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(data, null, 2))
    } catch {}
  }

  return {
    get: (model: string, kind: Kind): Entry | undefined => data[model]?.[kind],

    /** Both outcomes are worth keeping: remembering a failure is what makes a dead model
     *  cost one probe for the whole machine rather than one per run. */
    record(model: string, kind: Kind, r: Result) {
      ;(data[model] ??= {})[kind] = { ...r, at: Date.now() }
      save()
    },

    /**
     * A live call said otherwise. Forget the measurement rather than overwrite it with a
     * failure: a cached "works" that has stopped being true keeps routing lanes into a
     * model that cannot serve them, and one fresh probe is cheaper than a dropped lane.
     */
    contradict(model: string, kind: Kind) {
      if (data[model]) delete data[model][kind]
      save()
    },
  }
}

/**
 * At most `n` probes per run.
 *
 * The day half the providers are down is exactly when probing is most tempting and least
 * useful - each probe is a full model call, and an unbudgeted run would spend the review's
 * entire wall clock discovering that things are still broken.
 */
export function probeBudget(n: number) {
  let left = n
  return { take: () => left-- > 0 }
}

const PROBE_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
} as const

/**
 * Measure one capability of one model and remember the answer.
 *
 * `schema` is the only kind a single cheap call can settle: structured output is a forced
 * tool call, so asking for a one-field object either comes back parsed or returns
 * StructuredOutputError - the call IS the measurement.
 *
 * ponytail: `agentic` is not probed. It needs a session that actually drives a tool, which
 * is not one call. It reads from the cache and otherwise stays unknown rather than being
 * inferred from the schema result - musespark and deepseek pass agentic while failing
 * schema, so neither is evidence of the other.
 */
export async function probe(
  ctx: Ctx,
  model: string,
  kind: Kind = "schema",
  cache = openCache(),
): Promise<Entry | undefined> {
  const known = cache.get(model, kind)
  if (known || kind !== "schema") return known
  const r = await ask<{ ok: boolean }>(ctx, { model, text: "Reply with ok: true.", schema: PROBE_SCHEMA })
  cache.record(model, kind, { ok: r.ok, ms: r.ms })
  return cache.get(model, kind)
}
