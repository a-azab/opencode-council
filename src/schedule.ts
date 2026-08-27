import { readFileSync } from "node:fs"

/** Files that touch each other, per the graph. UNDIRECTED: neighbours, not importers.
 *  null when the graph is missing or unparseable - the caller degrades, never guesses. */
export function fileEdges(graphPath: string): Map<string, Set<string>> | null {
  let graph: any
  try {
    graph = JSON.parse(readFileSync(graphPath, "utf8"))
  } catch {
    return null // missing, unreadable, or malformed - all the same to the caller
  }
  if (!Array.isArray(graph?.nodes) || !Array.isArray(graph?.links)) return null

  // Verified against graphify-out/graph.json on 2026-08-26: link endpoints are node
  // ids (strings), not embedded node objects, and every endpoint resolves.
  const fileOf = new Map<unknown, string>()
  for (const node of graph.nodes) {
    if (typeof node?.source_file === "string" && node.source_file) fileOf.set(node.id, node.source_file)
  }

  // Every known file is a key, even with no neighbours: "in the graph and isolated" must
  // stay distinguishable from "absent from the graph" (a brand-new file), which is weaker.
  const edges = new Map<string, Set<string>>()
  for (const file of fileOf.values()) if (!edges.has(file)) edges.set(file, new Set())

  for (const link of graph.links) {
    const a = fileOf.get(link?.source)
    const b = fileOf.get(link?.target)
    // An endpoint with no source_file is a package or a community label, not a file.
    // Skip it: inventing a filename would invent conflicts that do not exist.
    if (!a || !b || a === b) continue
    edges.get(a)!.add(b)
    edges.get(b)!.add(a) // undirected: the relation is symmetric, so record it both ways
  }
  return edges
}

/** Do these two file sets touch - sharing a path, or one graph hop apart? */
export function conflicts(a: string[], b: string[], edges: Map<string, Set<string>> | null): boolean {
  // No graph means no evidence of safety, so assume the worst and let the caller serialise.
  if (edges === null) return true
  const other = new Set(b)
  for (const file of a) {
    if (other.has(file)) return true // literal overlap: the only check a brand-new file gets
    // ONE hop, deliberately - never a transitive closure. Two hops turns a codebase of any
    // density into a single connected blob where every task conflicts with every other,
    // which is a sequential schedule wearing a graph's costume. Do not "improve" this.
    const neighbours = edges.get(file)
    if (neighbours) for (const n of neighbours) if (other.has(n)) return true
  }
  // Undirected neighbours are a conservative SUPERSET of "really interferes": this will
  // call some independent pairs conflicting, and will never call a conflicting pair
  // independent. For a safety gate that is the correct direction to err.
  return false
}

/** Concurrent worktrees per wave. Each one costs a checkout, a model run, and review. */
export const MAX_WAVE_WIDTH = 4

/** Past this, the directive wants decomposing by a human before it wants scheduling. */
export const MAX_TASKS = 12

/** Greedy waves. Everything in a wave may run concurrently; waves run in order. */
/**
 * Task files the graph has never heard of.
 *
 * These are the dangerous ones. A file with no entry and a file with an empty entry look
 * identical to `conflicts()` - both yield "no neighbours" - but they mean opposite things:
 * one is evidence of independence, the other is the absence of evidence. Measured on this
 * repo 2026-08-26, 9 of 27 `src/*.ts` files were absent from a stale graph, so this is the
 * common case rather than a corner.
 */
export function ungraphed(files: string[], edges: Map<string, Set<string>> | null): string[] {
  if (edges === null) return []
  return files.filter((f) => !edges.has(f))
}

export function schedule<T extends { files: string[] }>(
  tasks: T[],
  edges: Map<string, Set<string>> | null,
): { waves: T[][]; mode: "graph" | "partial" | "sequential"; ungraphed: string[] } {
  // Refuse rather than truncate. A bad GRAPH is bad data and degrades to sequential; too
  // many tasks is a bad CALL, and quietly dropping the tail would let the caller report
  // success over work that never ran.
  if (tasks.length > MAX_TASKS) {
    throw new RangeError(`schedule: ${tasks.length} tasks exceeds MAX_TASKS=${MAX_TASKS}; decompose the directive first`)
  }
  const missing = new Set<string>()
  for (const t of tasks) for (const f of ungraphed(t.files, edges)) missing.add(f)

  const waves: T[][] = []
  // Plan order carries intent the scheduler cannot see, so walk it as given and take the
  // earliest wave that fits instead of sorting or bin-packing for width.
  for (const task of tasks) {
    // A task touching a file the graph does not know has not been shown disjoint from
    // ANYTHING - it has only failed to be shown conflicting, which is not the same claim.
    // The whole gate is "concurrency only where disjointness is proven", so an unprovable
    // task runs alone. On a stale graph this collapses toward sequential, which is the
    // honest outcome: rebuild the graph and the parallelism comes back.
    const provable = ungraphed(task.files, edges).length === 0
    const wave = provable
      ? waves.find(
          (w) =>
            w.length < MAX_WAVE_WIDTH &&
            w.every((o) => ungraphed(o.files, edges).length === 0) &&
            !w.some((other) => conflicts(task.files, other.files, edges)),
        )
      : undefined
    if (wave) wave.push(task)
    else waves.push([task]) // nothing fits: a full wave splits into the next consecutive one
  }

  const mode = edges === null ? "sequential" : missing.size ? "partial" : "graph"
  return { waves, mode, ungraphed: [...missing].sort() }
}
