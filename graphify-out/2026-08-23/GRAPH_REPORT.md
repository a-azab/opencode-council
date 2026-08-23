# Graph Report - .  (2026-08-23)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 264 nodes · 559 edges · 10 communities
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 2 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `f7afadfc`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- engine.ts
- index.ts
- decide.ts
- crew.test.ts
- mcp.ts
- crew.ts
- linear.ts
- package.json
- git
- runItem

## God Nodes (most connected - your core abstractions)
1. `git()` - 14 edges
2. `trackerFor()` - 10 edges
3. `runItem()` - 10 edges
4. `runExecute()` - 10 edges
5. `runReview()` - 9 edges
6. `proposeInit()` - 9 edges
7. `mcpTracker()` - 9 edges
8. `fixOne()` - 8 edges
9. `localMcpServers()` - 8 edges
10. `ask()` - 7 edges

## Surprising Connections (you probably didn't know these)
- `runExecute()` --indirect_call--> `item()`  [INFERRED]
  src/crew.ts → src/crew.test.ts
- `dedupe()` --indirect_call--> `f()`  [INFERRED]
  src/decide.ts → src/decide.test.ts
- `disputed()` --calls--> `dedupe()`  [EXTRACTED]
  src/decide.test.ts → src/decide.ts
- `twoReports()` --calls--> `dedupe()`  [EXTRACTED]
  src/decide.test.ts → src/decide.ts
- `debateRound()` --calls--> `bySlug()`  [EXTRACTED]
  src/engine.ts → src/roster.ts

## Import Cycles
- None detected.

## Communities (10 total, 0 thin omitted)

### Community 0 - "engine.ts"
Cohesion: 0.07
Nodes (56): ask(), askOnce(), AskOpts, backoffMs(), Bench, benchable(), classify(), computeDiff() (+48 more)

### Community 1 - "index.ts"
Cohesion: 0.07
Nodes (25): CrewConfig, readInstructions(), renderRun(), Finding, Patch, Review, AGENT_DEFAULTS, artifactDir() (+17 more)

### Community 2 - "decide.ts"
Cohesion: 0.12
Nodes (22): applyOutcome(), applyRevisions(), Confidence, converged(), decide(), dedupe(), disputes(), downgrade() (+14 more)

### Community 3 - "crew.test.ts"
Cohesion: 0.11
Nodes (19): applyInit(), CREW_IGNORES, detectStack(), detectVerifyCandidates(), guarded(), missingIgnores(), parseCrewBlock(), proposeInit() (+11 more)

### Community 4 - "mcp.ts"
Cohesion: 0.14
Nodes (17): availableTrackers(), fanout(), ItemOutcome, linearTracker(), McpConfig, renderInitProposal(), RunResult, stdoutTracker() (+9 more)

### Community 5 - "crew.ts"
Cohesion: 0.11
Nodes (23): BaseCandidates, cpoPrompt(), CREW_MODELS, CrewWorktree, ctoPrompt(), graphContext(), graphify(), graphQuery() (+15 more)

### Community 6 - "linear.ts"
Cohesion: 0.15
Nodes (15): Activity, addExternalUrl(), createActivity(), createSessionOnIssue(), findIssue(), gql(), issueIdentifierIn(), LinearCtx (+7 more)

### Community 7 - "package.json"
Cohesion: 0.11
Nodes (17): dependencies, zod, description, files, license, main, name, scripts (+9 more)

### Community 8 - "git"
Cohesion: 0.22
Nodes (13): branchExists(), closeWorktree(), detectBaseCandidates(), git(), GraphState, listWorktrees(), openPr(), openWorktree() (+5 more)

### Community 9 - "runItem"
Cohesion: 0.25
Nodes (9): checkAcceptance(), commitMessage(), diagnose(), implementPrompt(), installIfDepsChanged(), runItem(), runVerify(), SECRETS (+1 more)

## Knowledge Gaps
- **48 isolated node(s):** `name`, `version`, `description`, `type`, `main` (+43 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `mcpTracker()` connect `mcp.ts` to `crew.ts`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **Why does `dedupe()` connect `decide.ts` to `engine.ts`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **What connects `name`, `version`, `description` to the rest of the system?**
  _48 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `engine.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06504494976203067 - nodes in this community are weakly interconnected._
- **Should `index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.07357357357357357 - nodes in this community are weakly interconnected._
- **Should `decide.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.12433862433862433 - nodes in this community are weakly interconnected._
- **Should `crew.test.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.10541310541310542 - nodes in this community are weakly interconnected._