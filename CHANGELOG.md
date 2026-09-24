# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-24

First tagged state of the plugin. Everything below has shipped; the version has not been
published to npm yet, so this entry describes the repository rather than an upgrade path.

### Added

- **`/council:*`** — advisory multi-model review. Role × model fan-out over 15 reviewer
  roles, independent skeptics that challenge findings they did not raise, and
  deterministic aggregation: dedupe, dispute detection, convergence and
  keep/downgrade/drop are computed in `src/decide.ts`, never by asking a model to
  summarise. Writes no code.
- **`/lets:*`** — directive → intake → **human-approved plan** → unattended
  implementation, verification and review for one task. `lets:init` inspects the repo and
  proposes its own config (verify command, PR base, review lanes) into a fenced `lets`
  block in `AGENTS.md`.
- **`/crew:*`** — the same machinery with the planning gate removed and an audit trail put
  in its place: an ADR written *before* the run recording what it asked and what it
  decided, waves scheduled from a dependency graph, and a report that is the only account
  of what happened.
- **Harness scorecard beside `verify`** (`src/harness.ts`). `verify` answers "did I break
  anything"; the scorecard answers "did the repo get worse to hand to the next unattended
  session". Shells out to ECC's `scripts/harness-audit.js` rather than reimplementing
  someone else's rubric. Per-category comparison, a recorded floor, and an `unavailable`
  verdict that is never collapsed into `pass`.
- **Preventive runtime guard** (`src/hooks.ts`). A `tool.execute.before` hook that refuses
  a small set of gate-defeating commands — `git commit --no-verify`, force push,
  `reset --hard`/`clean -f`, `rm -rf`, edits to `.github/workflows/`, and switching to the
  base branch — for sessions **this plugin spawned**, with project-local additions read
  from `.claude/settings.json`.
- **Trackers**: a generic MCP tracker, a Linear agent-session tracker, and a `bd`/beads
  transport, sharing one run summary.
- **Repo harness**: CI (typecheck + the full suite), Dependabot, CODEOWNERS, issue and PR
  templates, secret hygiene in `.gitignore`, and four eval cases under `evals/`.
- Packaging metadata and an MIT `LICENSE`, so the declared licence has grant text behind
  it; `CONTRIBUTING.md` and `SECURITY.md`.

### Fixed

- **The guard was a no-op across a process boundary.** Spawned-session registration lived
  in a module-level `Set`, which is per-process; when anything drove `ask()` from outside
  the opencode server the hook read an empty set and never fired. Registration now lives
  in a TTL'd file in the OS temp dir.
- **A timed-out capability probe was recorded as "model cannot do this"**, poisoning the
  catalogue for every later run. A slow minute is now recorded as latency, and a bad
  minute is not a dead model.
- **A judge could not prove a claim from a diff that omitted the evidence** — `lets` now
  attaches it.
- **Drive-loop honesty**: a turn that stopped being watched ends rather than hanging, a
  session opencode cannot read back is no longer polled, an empty turn says *why* it was
  empty, and an empty session's transcript is not kept as if it were one.
- **`git commit --no-verify` was silently allowed** by the guard's first regex while the
  short `-n` matched — a guard that reported working while passing the common case
  through.
- A pathspec crash no longer costs a task whose work is already written.

### Changed

- The harness probe is an ordered list of conventional roots (`$ECC_ROOT`,
  `$XDG_DATA_HOME/ecc`, `~/.claude/plugins/ecc`, `~/code/AI/ECC`) instead of one
  developer's hardcoded absolute path. It remains a last-resort fallback behind explicit
  config and `$ECC_HOME`, and `harness: none` still short-circuits before any probing.
- Test modules are no longer shipped in the npm tarball (96 files / 1.2 MB → 75 files /
  821 kB), and `.claude/settings.json` is now included so consumers can read and disable
  the guard's policy.

### Known limitations

- `/crew:execute`'s orchestration has never run end to end: no test here may call a model,
  so the wave loop and the hand-off into integration, verify and review are exercised only
  by their refusals.
- Findings are grounded in the diff only; there is no repo-wide index.

[Unreleased]: https://github.com/a-azab/opencode-council/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/a-azab/opencode-council/releases/tag/v0.1.0
