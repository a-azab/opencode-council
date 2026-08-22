# Graph Report - .  (2026-08-22)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 241 nodes · 500 edges · 14 communities
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `2e486603`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- index.ts
- decide.ts
- crew.ts
- engine.ts
- crew.test.ts
- linear.ts
- package.json
- git
- roster.ts
- runReview
- failover.test.ts
- trackerFor
- proposeInit
- fixOne

## God Nodes (most connected - your core abstractions)
1. `git()` - 12 edges
2. `runItem()` - 10 edges
3. `runReview()` - 10 edges
4. `proposeInit()` - 9 edges
5. `runExecute()` - 9 edges
6. `fixOne()` - 8 edges
7. `ROSTER` - 8 edges
8. `bySlug()` - 8 edges
9. `skepticPool()` - 8 edges
10. `trackerFor()` - 7 edges

## Surprising Connections (you probably didn't know these)
- `dedupe()` --indirect_call--> `f()`  [INFERRED]
  src/decide.ts → src/decide.test.ts
- `proposeLanes()` --calls--> `selectRoles()`  [EXTRACTED]
  src/crew.ts → src/roster.ts
- `runIntake()` --calls--> `bySlug()`  [EXTRACTED]
  src/crew.ts → src/roster.ts
- `checkAcceptance()` --calls--> `skepticPool()`  [EXTRACTED]
  src/crew.ts → src/roster.ts
- `runItem()` --calls--> `bySlug()`  [EXTRACTED]
  src/crew.ts → src/roster.ts

## Import Cycles
- None detected.

## Communities (14 total, 0 thin omitted)

### Community 0 - "index.ts"
Cohesion: 0.08
Nodes (23): CrewConfig, readInstructions(), Finding, Patch, Review, AGENT_DEFAULTS, artifactDir(), artifactRoot() (+15 more)

### Community 1 - "decide.ts"
Cohesion: 0.12
Nodes (22): applyOutcome(), applyRevisions(), Confidence, converged(), decide(), dedupe(), disputes(), downgrade() (+14 more)

### Community 2 - "crew.ts"
Cohesion: 0.11
Nodes (24): cpoPrompt(), CrewWorktree, ctoPrompt(), graphContext(), graphExplain(), graphify(), graphPath(), graphQuery() (+16 more)

### Community 3 - "engine.ts"
Cohesion: 0.13
Nodes (20): askOnce(), AskOpts, classify(), headers(), NodeResult, Plan, PLANNING_ROLES, proposalPrompt() (+12 more)

### Community 4 - "crew.test.ts"
Cohesion: 0.11
Nodes (14): applyInit(), CREW_IGNORES, ItemOutcome, missingIgnores(), renderCrewBlock(), renderRun(), RunResult, CFG (+6 more)

### Community 5 - "linear.ts"
Cohesion: 0.15
Nodes (16): linearTracker(), Activity, addExternalUrl(), createActivity(), createSessionOnIssue(), findIssue(), gql(), issueIdentifierIn() (+8 more)

### Community 6 - "package.json"
Cohesion: 0.11
Nodes (17): dependencies, zod, description, files, license, main, name, scripts (+9 more)

### Community 7 - "git"
Cohesion: 0.17
Nodes (16): checkAcceptance(), closeWorktree(), commitMessage(), git(), GraphState, installIfDepsChanged(), listWorktrees(), openPr() (+8 more)

### Community 8 - "roster.ts"
Cohesion: 0.22
Nodes (12): diagnose(), bySlug(), Member, MODELS_PER_ROLE, Node, Role, ROSTER, ROUTES (+4 more)

### Community 9 - "runReview"
Cohesion: 0.17
Nodes (12): ask(), backoffMs(), debatePrompt(), debateRound(), DEFAULT_RETRY, isRetryable(), runIndependent(), runReview() (+4 more)

### Community 10 - "failover.test.ts"
Cohesion: 0.32
Nodes (7): Bench, benchable(), fanout(), reviewPrompt(), substitutesFor(), round, ALL_ROLES

### Community 11 - "trackerFor"
Cohesion: 0.29
Nodes (7): availableTrackers(), fanout(), guarded(), renderInitProposal(), stdoutTracker(), Tracker, trackerFor()

### Community 12 - "proposeInit"
Cohesion: 0.29
Nodes (7): detectBaseCandidates(), detectStack(), detectVerifyCandidates(), parseCrewBlock(), proposeInit(), proposeLanes(), readCrewConfig()

### Community 13 - "fixOne"
Cohesion: 0.29
Nodes (7): computeDiff(), fixOne(), fixPrompt(), patchApplies(), Proposal, runFix(), verifyFixPrompt()

## Knowledge Gaps
- **44 isolated node(s):** `name`, `version`, `description`, `type`, `main` (+39 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `dedupe()` connect `decide.ts` to `engine.ts`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **Why does `runReview()` connect `runReview` to `index.ts`, `crew.ts`, `engine.ts`, `git`, `roster.ts`, `failover.test.ts`?**
  _High betweenness centrality (0.010) - this node is a cross-community bridge._
- **Why does `ask()` connect `runReview` to `crew.ts`, `engine.ts`?**
  _High betweenness centrality (0.006) - this node is a cross-community bridge._
- **What connects `name`, `version`, `description` to the rest of the system?**
  _44 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.07899159663865546 - nodes in this community are weakly interconnected._
- **Should `decide.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.12433862433862433 - nodes in this community are weakly interconnected._
- **Should `crew.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.11333333333333333 - nodes in this community are weakly interconnected._