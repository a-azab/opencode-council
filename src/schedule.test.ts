import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileEdges } from "./schedule.ts"

// A hand-built stand-in for graphify output. The repo's real graph is stale and will
// change; these tests pin behaviour, not this month's dependency structure.
//   src/a.ts -- src/b.ts -- src/c.ts        (a chain: a and c are TWO hops apart)
//   src/d.ts                                 (present, no cross-file edge)
// plus a community label with no source_file, and a same-file link inside src/a.ts.
const FIXTURE = {
  directed: false,
  nodes: [
    { id: "a1", source_file: "src/a.ts" },
    { id: "a2", source_file: "src/a.ts" },
    { id: "b1", source_file: "src/b.ts" },
    { id: "c1", source_file: "src/c.ts" },
    { id: "d1", source_file: "src/d.ts" },
    { id: "community_0", label: "core", community: 0 }, // not a file
  ],
  links: [
    { source: "a1", target: "b1" },
    { source: "b1", target: "c1" },
    { source: "a1", target: "a2" }, // same file: not a self-neighbour
    { source: "community_0", target: "a1" }, // endpoint is not a file: skipped
  ],
}

function withGraph<T>(body: (path: string) => T, contents: string = JSON.stringify(FIXTURE)): T {
  const dir = mkdtempSync(join(tmpdir(), "sched-"))
  try {
    const path = join(dir, "graph.json")
    writeFileSync(path, contents)
    return body(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("fileEdges projects node-level links onto the files that hold them", () => {
  const edges = withGraph(fileEdges)
  assert.ok(edges, "a readable graph must produce a map")
  assert.deepEqual([...edges.get("src/a.ts")!].sort(), ["src/b.ts"])
  assert.deepEqual([...edges.get("src/b.ts")!].sort(), ["src/a.ts", "src/c.ts"])
  assert.deepEqual([...edges.get("src/c.ts")!].sort(), ["src/b.ts"])
})

test("a link's two endpoints join BOTH ways - the graph is undirected", () => {
  const edges = withGraph(fileEdges)!
  // There is no "a imports b" here, only "a and b touch". Symmetry is the honest shape.
  assert.ok(edges.get("src/a.ts")!.has("src/b.ts"))
  assert.ok(edges.get("src/b.ts")!.has("src/a.ts"))
})

test("a file whose only links are internal has no neighbours, and is still known", () => {
  const edges = withGraph(fileEdges)!
  assert.deepEqual([...edges.get("src/d.ts")!], [], "present in the graph, touching nothing")
  assert.ok(edges.has("src/d.ts"), "known-but-isolated must differ from absent-entirely")
  assert.ok(!edges.get("src/a.ts")!.has("src/a.ts"), "a file is not its own neighbour")
})

test("nodes without source_file are skipped, not treated as a file named undefined", () => {
  const edges = withGraph(fileEdges)!
  // A community label is not a file. Guessing one would invent conflicts out of nothing.
  assert.deepEqual([...edges.keys()].sort(), ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"])
  for (const [, neighbours] of edges) {
    for (const n of neighbours) assert.ok(n && n !== "undefined", `bogus neighbour ${n}`)
  }
})

test("a missing graph file returns null rather than throwing", () => {
  // A scheduler that crashes on a bad graph is worse than one that runs sequentially.
  assert.equal(fileEdges(join(tmpdir(), "definitely-not-here-9f3a", "graph.json")), null)
})

test("an unparseable graph returns null rather than throwing", () => {
  assert.equal(withGraph(fileEdges, "{ not json"), null)
})
