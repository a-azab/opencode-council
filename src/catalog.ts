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
import { ask, DEFAULT_RETRY, type Ctx } from "./engine.ts"

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

/**
 * `provider/name-<version><suffix>` split into its comparable parts, or null when the name
 * carries no version this can reason about.
 *
 * Deliberately narrow. `kimi-k3` and `big-pickle` return null rather than being guessed at,
 * because a wrong guess here swaps a working model for an unrelated one.
 */
function parseVersion(model: string): { provider: string; base: string; v: number[]; vp: string; suffix: string } | null {
  const slash = model.indexOf("/")
  if (slash === -1) return null
  const provider = model.slice(0, slash)
  const m = /^(.*?)-(v?)(\d+(?:\.\d+)*)(-.*)?$/.exec(model.slice(slash + 1))
  if (!m) return null
  return { provider, base: m[1], vp: m[2], v: m[3].split(".").map(Number), suffix: m[4] ?? "" }
}

const higher = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d) return d > 0
  }
  return false
}

/**
 * The next version up of the same model, from what the server currently offers.
 *
 * A pinned model that starts failing is usually not a broken model - it is a retired one.
 * `opencode-go/grok-4.5` returned http 500 for an unknown stretch because the provider had
 * replaced it with `4.6`, and nothing noticed: a dead pin looks exactly like a model having
 * a bad day, and failover covers for it rather than complaining.
 *
 * Everything about the match is conservative, because the failure mode of getting it wrong
 * is silently reviewing with a model nobody chose:
 *
 * - same provider, same base name, same suffix. `gpt-5.6-sol` will never match
 *   `gpt-5.6-terra` - those are sibling tiers, not versions of each other.
 * - strictly higher version, and the LOWEST such - the immediate successor. `4.5` takes
 *   `4.6` even when `5.0` is on offer, because a major jump is a different model.
 * - a name with no parseable version gets no successor at all.
 */
export function successorsOf(model: string, offered: string[]): string[] {
  const from = parseVersion(model)
  if (!from) return []
  return offered
    .map((o) => ({ model: o, p: parseVersion(o) }))
    .filter(
      (c): c is { model: string; p: NonNullable<ReturnType<typeof parseVersion>> } =>
        !!c.p &&
        c.p.provider === from.provider &&
        c.p.base === from.base &&
        // The suffix must match exactly. `gpt-5.6-sol` and `gpt-5.6-terra` are sibling TIERS,
        // not versions of one another, and swapping between them changes what the model is
        // for. Those stay a human decision.
        c.p.suffix === from.suffix &&
        c.p.vp === from.vp &&
        higher(c.p.v, from.v),
    )
    .sort((a, b) => (higher(a.p.v, b.p.v) ? 1 : -1))
    .map((c) => c.model)
}

/** The immediate successor - the smallest step up. Used for reactive recovery of a dead pin. */
export const successorOf = (model: string, offered: string[]): string | null =>
  successorsOf(model, offered)[0] ?? null

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
export type Adoption = { from: string; to: string; ms: number }

/**
 * What each pinned model should resolve to right now, given what the server offers.
 *
 * Newest first, including major versions - but **a probe decides, never the version number.**
 * That is not caution for its own sake: `google/gemini-3.7-flash` times out at 90s where
 * `3.6` answers in 9s, so a tool that adopted the higher number on sight would have taken a
 * working lane out and called it an upgrade. "Newer" is a hypothesis; the probe is the test.
 *
 * A failed candidate falls to the next one down, so a bad release costs one probe and the
 * roster keeps working. The result is a runtime overlay - `src/roster.ts` is never rewritten,
 * because a source file edited by a background process is a diff nobody wrote and nobody
 * reviewed.
 *
 * Cost is bounded twice: `budget` caps probes per run, and every result - pass OR fail - is
 * cached on disk, so a model is measured once per machine rather than once per run.
 */
export async function resolvePins(
  ctx: Ctx,
  pins: string[],
  offered: string[],
  opts: { budget?: number; cache?: ReturnType<typeof openCache> } = {},
): Promise<{ map: Map<string, string>; adopted: Adoption[]; unchecked: string[] }> {
  const cache = opts.cache ?? openCache()
  const budget = probeBudget(opts.budget ?? 3)
  // A probe gets its OWN budget, never the caller's. This runs on the first model call of the
  // process, and that call might be the implementer's - whose ctx carries a ten-minute
  // timeout. Inheriting it would let a single dead candidate hold the whole run for ten
  // minutes before the work it was asked to do had started. A trivial probe that has not
  // answered in a minute has answered.
  const probeCtx: Ctx = { ...ctx, timeoutMs: 60_000, retry: { ...DEFAULT_RETRY, maxAttempts: 1, retryTimeout: false } }
  const map = new Map<string, string>()
  const adopted: Adoption[] = []
  const unchecked: string[] = []

  for (const pin of pins) {
    // Newest first: the user asked for major releases to be taken, not just point bumps.
    const candidates = successorsOf(pin, offered).reverse()
    if (!candidates.length) continue

    let settled = false
    for (const candidate of candidates) {
      const known = cache.get(candidate, "schema")
      if (known) {
        if (!known.ok) continue // measured and dead - try the next one down
        map.set(pin, candidate)
        adopted.push({ from: pin, to: candidate, ms: known.ms })
        settled = true
        break
      }
      // Unmeasured. Spend a probe if there is one left, otherwise leave the pin alone and
      // say so - silently keeping the old model is right, silently claiming it was checked
      // is not.
      if (!budget.take()) {
        unchecked.push(pin)
        settled = true
        break
      }
      const r = await probe(probeCtx, candidate, "schema", cache)
      if (r?.ok) {
        map.set(pin, candidate)
        adopted.push({ from: pin, to: candidate, ms: r.ms })
        settled = true
        break
      }
    }
    if (!settled) continue // every candidate measured and dead: the pin stands
  }
  return { map, adopted, unchecked }
}

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
