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
