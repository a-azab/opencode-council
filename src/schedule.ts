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
