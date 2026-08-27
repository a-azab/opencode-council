import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileEdges, conflicts, schedule, MAX_WAVE_WIDTH, MAX_TASKS } from "./schedule.ts"

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

test("two tasks touching the same file conflict", () => {
  const edges = withGraph(fileEdges)!
  assert.equal(conflicts(["src/a.ts"], ["src/a.ts"], edges), true)
  assert.equal(conflicts(["src/a.ts", "src/d.ts"], ["src/x.ts", "src/d.ts"], edges), true)
})

test("two tasks touching unrelated files do not conflict", () => {
  const edges = withGraph(fileEdges)!
  assert.equal(conflicts(["src/a.ts"], ["src/d.ts"], edges), false)
})

test("files one graph hop apart conflict - the whole reason the graph is consulted", () => {
  const edges = withGraph(fileEdges)!
  assert.equal(conflicts(["src/a.ts"], ["src/b.ts"], edges), true, "a--b is a link")
  assert.equal(conflicts(["src/b.ts"], ["src/a.ts"], edges), true, "and symmetrically")
})

test("conflict is ONE hop, never transitive: a--b--c leaves a and c compatible", () => {
  const edges = withGraph(fileEdges)!
  // At two hops any real codebase becomes one connected blob and every task conflicts
  // with every other - a sequential schedule wearing a graph's costume.
  assert.equal(conflicts(["src/a.ts"], ["src/c.ts"], edges), false)
})

test("a file absent from the graph is compared by literal path only", () => {
  const edges = withGraph(fileEdges)!
  // A newly-created file has no node, so the graph can say nothing about it. Path
  // equality still holds; the guarantee is deliberately weaker here.
  assert.equal(conflicts(["src/new.ts"], ["src/a.ts"], edges), false, "no node, no graph claim")
  assert.equal(conflicts(["src/new.ts"], ["src/new.ts"], edges), true, "same path still conflicts")
})

test("with no graph, everything conflicts - that is what forces the sequential fallback", () => {
  assert.equal(conflicts(["src/a.ts"], ["src/d.ts"], null), true)
  assert.equal(conflicts([], [], null), true)
})

const task = (name: string, ...files: string[]) => ({ name, files })
const names = (waves: { name: string }[][]) => waves.map((w) => w.map((t) => t.name))

test("two tasks touching the same file land in different waves", () => {
  const edges = withGraph(fileEdges)!
  const { waves, mode } = schedule([task("t1", "src/a.ts"), task("t2", "src/a.ts")], edges)
  assert.equal(mode, "graph")
  assert.deepEqual(names(waves), [["t1"], ["t2"]])
})

test("two tasks touching unrelated files share a wave", () => {
  const edges = withGraph(fileEdges)!
  // Without this the module is a sequential schedule with extra steps.
  const { waves } = schedule([task("t1", "src/a.ts"), task("t2", "src/d.ts")], edges)
  assert.deepEqual(names(waves), [["t1", "t2"]])
})

test("tasks whose files are graph neighbours land in different waves", () => {
  const edges = withGraph(fileEdges)!
  const { waves } = schedule([task("t1", "src/a.ts"), task("t2", "src/b.ts")], edges)
  assert.deepEqual(names(waves), [["t1"], ["t2"]])
})

test("one hop only: a--b--c lets the ends of the chain share a wave", () => {
  const edges = withGraph(fileEdges)!
  const { waves } = schedule([task("t1", "src/a.ts"), task("t2", "src/c.ts")], edges)
  assert.deepEqual(names(waves), [["t1", "t2"]], "two hops must not conflict")
})

test("a task creating a new file is placed on literal path comparison alone", () => {
  const edges = withGraph(fileEdges)!
  const { waves } = schedule(
    [task("new", "src/new.ts"), task("touches-a", "src/a.ts"), task("new-again", "src/new.ts")],
    edges,
  )
  // src/new.ts has no node, so nothing can be inferred about it; only the repeated
  // literal path forces separation.
  assert.deepEqual(names(waves), [["new", "touches-a"], ["new-again"]])
})

test("a missing graph gives mode sequential and one task per wave", () => {
  const { waves, mode } = schedule(
    [task("t1", "src/a.ts"), task("t2", "src/d.ts"), task("t3", "src/z.ts")],
    fileEdges(join(tmpdir(), "definitely-not-here-9f3a", "graph.json")),
  )
  assert.equal(mode, "sequential", "the caller must be able to report the degradation")
  assert.deepEqual(names(waves), [["t1"], ["t2"], ["t3"]])
})

test("an unparseable graph degrades the same way and does not throw", () => {
  const edges = withGraph(fileEdges, "{ not json")
  const { waves, mode } = schedule([task("t1", "src/a.ts"), task("t2", "src/d.ts")], edges)
  assert.equal(mode, "sequential")
  assert.deepEqual(names(waves), [["t1"], ["t2"]])
})

test("plan order is preserved as far as conflicts allow", () => {
  const edges = withGraph(fileEdges)!
  const plan = [task("p1", "src/n1.ts"), task("p2", "src/n2.ts"), task("p3", "src/n3.ts")]
  assert.deepEqual(names(schedule(plan, edges).waves), [["p1", "p2", "p3"]], "no conflicts, no reordering")

  // Earliest-fit: p3 does not conflict with p1, so it joins wave 0 rather than waiting.
  const mixed = [task("q1", "src/a.ts"), task("q2", "src/a.ts"), task("q3", "src/d.ts")]
  assert.deepEqual(names(schedule(mixed, edges).waves), [["q1", "q3"], ["q2"]])
})

test("no wave exceeds MAX_WAVE_WIDTH - the cost bound", () => {
  const edges = withGraph(fileEdges)!
  const plan = ["w1", "w2", "w3", "w4", "w5", "w6"].map((n) => task(n, `src/${n}.ts`))
  const { waves } = schedule(plan, edges) // all mutually compatible
  assert.deepEqual(names(waves), [["w1", "w2", "w3", "w4"], ["w5", "w6"]])
  for (const w of waves) assert.ok(w.length <= MAX_WAVE_WIDTH, `wave of ${w.length}`)
  assert.equal(waves.flat().length, 6, "splitting must not drop work")
})

test("more than MAX_TASKS is refused, not silently truncated", () => {
  const edges = withGraph(fileEdges)!
  const many = Array.from({ length: MAX_TASKS + 1 }, (_, i) => task(`t${i}`, `src/f${i}.ts`))
  assert.throws(() => schedule(many, edges), /MAX_TASKS|13/, "dropping work silently is worse")
  assert.equal(schedule(many.slice(0, MAX_TASKS), edges).waves.flat().length, MAX_TASKS, "the limit itself is fine")
})
