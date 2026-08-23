# Graph Report - .  (2026-08-23)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 264 nodes · 565 edges · 10 communities
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 2 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `973cd572`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- engine.ts
- index.ts
- mcp.ts
- decide.ts
- crew.test.ts
- crew.ts
- linear.ts
- package.json
- git
- runItem

## God Nodes (most connected - your core abstractions)
1. `git()` - 14 edges
2. `runItem()` - 11 edges
3. `trackerFor()` - 10 edges
4. `mcpTracker()` - 10 edges
5. `runReview()` - 9 edges
6. `proposeInit()` - 9 edges
7. `runExecute()` - 9 edges
8. `fixOne()` - 8 edges
9. `localMcpServers()` - 8 edges
10. `ROSTER` - 8 edges

## Surprising Connections (you probably didn't know these)
- `mcpTracker()` --indirect_call--> `tool()`  [INFERRED]
  src/mcp.ts → src/tool.test.ts
- `dedupe()` --indirect_call--> `f()`  [INFERRED]
  src/decide.ts → src/decide.test.ts
- `proposeLanes()` --calls--> `selectRoles()`  [EXTRACTED]
  src/crew.ts → src/roster.ts
- `runIntake()` --calls--> `bySlug()`  [EXTRACTED]
  src/crew.ts → src/roster.ts
- `runItem()` --calls--> `bySlug()`  [EXTRACTED]
  src/crew.ts → src/roster.ts

## Import Cycles
- None detected.

## Communities (10 total, 0 thin omitted)

### Community 0 - "engine.ts"
Cohesion: 0.06
Nodes (58): checkAcceptance(), diagnose(), ask(), askOnce(), AskOpts, backoffMs(), Bench, benchable() (+50 more)

### Community 1 - "index.ts"
Cohesion: 0.09
Nodes (25): CrewConfig, readInstructions(), renderRun(), Finding, Patch, Review, AGENT_DEFAULTS, artifactDir() (+17 more)

### Community 2 - "mcp.ts"
Cohesion: 0.11
Nodes (18): availableTrackers(), fanout(), ItemOutcome, linearTracker(), McpConfig, renderInitProposal(), RunResult, stdoutTracker() (+10 more)

### Community 3 - "decide.ts"
Cohesion: 0.12
Nodes (22): applyOutcome(), applyRevisions(), Confidence, converged(), decide(), dedupe(), disputes(), downgrade() (+14 more)

### Community 4 - "crew.test.ts"
Cohesion: 0.11
Nodes (19): applyInit(), CREW_IGNORES, detectStack(), detectVerifyCandidates(), guarded(), missingIgnores(), parseCrewBlock(), proposeInit() (+11 more)

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
Cohesion: 0.33
Nodes (7): commitMessage(), implementPrompt(), installIfDepsChanged(), runItem(), runVerify(), SECRETS, worktreeChanges()

## Knowledge Gaps
- **48 isolated node(s):** `name`, `version`, `description`, `type`, `main` (+43 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `mcpTracker()` connect `mcp.ts` to `crew.ts`?**
  _High betweenness centrality (0.034) - this node is a cross-community bridge._
- **Why does `dedupe()` connect `decide.ts` to `engine.ts`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **What connects `name`, `version`, `description` to the rest of the system?**
  _48 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `engine.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.0625 - nodes in this community are weakly interconnected._
- **Should `index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.08522727272727272 - nodes in this community are weakly interconnected._
- **Should `mcp.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.11182795698924732 - nodes in this community are weakly interconnected._
- **Should `decide.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.12433862433862433 - nodes in this community are weakly interconnected._