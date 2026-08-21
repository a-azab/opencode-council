# Graph Report - .  (2026-08-21)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 181 nodes · 378 edges · 7 communities
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 7 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `4e092ff1`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- engine.ts
- crew.ts
- decide.ts
- index.ts
- package.json
- work.ts
- roster.ts

## God Nodes (most connected - your core abstractions)
1. `runReview()` - 14 edges
2. `f()` - 10 edges
3. `proposeInit()` - 9 edges
4. `bySlug()` - 9 edges
5. `runWork()` - 9 edges
6. `ask()` - 8 edges
7. `fixOne()` - 8 edges
8. `dedupe()` - 7 edges
9. `skepticPool()` - 7 edges
10. `files` - 6 edges

## Surprising Connections (you probably didn't know these)
- `detectVerifyCandidates()` --indirect_call--> `f()`  [INFERRED]
  src/crew.ts → src/decide.test.ts
- `runFix()` --indirect_call--> `f()`  [INFERRED]
  src/engine.ts → src/decide.test.ts
- `readMarkdownDir()` --indirect_call--> `f()`  [INFERRED]
  src/index.ts → src/decide.test.ts
- `renderReport()` --indirect_call--> `f()`  [INFERRED]
  src/report.ts → src/decide.test.ts
- `runWork()` --indirect_call--> `f()`  [INFERRED]
  src/work.ts → src/decide.test.ts

## Import Cycles
- None detected.

## Communities (7 total, 0 thin omitted)

### Community 0 - "engine.ts"
Cohesion: 0.09
Nodes (36): ask(), askOnce(), backoffMs(), classify(), computeDiff(), debatePrompt(), debateRound(), DEFAULT_RETRY (+28 more)

### Community 1 - "crew.ts"
Cohesion: 0.12
Nodes (32): applyInit(), cpoPrompt(), CREW_IGNORES, CrewConfig, ctoPrompt(), detectBaseCandidates(), detectStack(), detectVerifyCandidates() (+24 more)

### Community 2 - "decide.ts"
Cohesion: 0.12
Nodes (24): applyOutcome(), applyRevisions(), Confidence, converged(), decide(), dedupe(), disputes(), downgrade() (+16 more)

### Community 3 - "index.ts"
Cohesion: 0.11
Nodes (20): readInstructions(), renderGate(), renderInitProposal(), Finding, Patch, Review, AGENT_DEFAULTS, CouncilPlugin() (+12 more)

### Community 4 - "package.json"
Cohesion: 0.11
Nodes (17): dependencies, zod, description, files, license, main, name, scripts (+9 more)

### Community 5 - "work.ts"
Cohesion: 0.17
Nodes (16): Ctx, NodeState, IMPLEMENT_SCHEMA, WORKITEMS_SCHEMA, createWorktree(), decomposePrompt(), git(), implementPrompt() (+8 more)

### Community 6 - "roster.ts"
Cohesion: 0.17
Nodes (13): proposalPrompt(), runPlan(), scorePrompt(), bySlug(), Member, MODELS_PER_ROLE, Node, Role (+5 more)

## Knowledge Gaps
- **41 isolated node(s):** `name`, `version`, `description`, `type`, `main` (+36 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `dedupe()` connect `decide.ts` to `engine.ts`?**
  _High betweenness centrality (0.015) - this node is a cross-community bridge._
- **Why does `f()` connect `decide.ts` to `engine.ts`, `crew.ts`, `index.ts`, `work.ts`?**
  _High betweenness centrality (0.014) - this node is a cross-community bridge._
- **Why does `bySlug()` connect `roster.ts` to `engine.ts`, `crew.ts`, `work.ts`?**
  _High betweenness centrality (0.012) - this node is a cross-community bridge._
- **Are the 7 inferred relationships involving `f()` (e.g. with `detectVerifyCandidates()` and `dedupe()`) actually correct?**
  _`f()` has 7 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `description` to the rest of the system?**
  _41 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `engine.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.08771929824561403 - nodes in this community are weakly interconnected._
- **Should `crew.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.11596638655462185 - nodes in this community are weakly interconnected._