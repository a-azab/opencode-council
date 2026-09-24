# Security Policy

## Reporting a vulnerability

Report privately through **GitHub private security advisories**:
[github.com/a-azab/opencode-council/security/advisories/new](https://github.com/a-azab/opencode-council/security/advisories/new).

Please do not open a public issue for a vulnerability, and do not include live API keys or
other credentials in the report — a redacted transcript is enough.

Useful in a report: the opencode version, the node version, which tool was running
(`council`, `lets` or `crew`), and the smallest input that reproduces it. Expect an
acknowledgement within a week; this is a small project and there is no on-call rotation.

## Supported versions

Only the tip of `master` is supported. There are no maintenance branches and no backports.

## What this plugin actually does — read this first

This is not a hardened product, and treating it as one would be the mistake this file
exists to prevent.

**It spawns model sessions that hold `edit` and `bash` on your machine.** The `lets`
implementer is the clearest case: it is a model, driven unattended, with a shell and write
access to a git worktree in your repository. It runs your build, your tests and whatever
else it decides it needs. A prompt injected through the code it is reading, the issue it
is working from, or a dependency it installs is a prompt reaching a process that can run
commands as you.

What bounds it today, honestly:

1. **Confinement** — `external_directory: deny`, with `edit`/`bash` granted only when the
   caller opts in. This is enforced by the opencode server, not by a sentence in a prompt.
   It answers *where*, and it holds: a read outside the worktree is refused.
2. **The runtime guard** in `src/hooks.ts` — described below. It answers *what*, partially.
3. **Detection after the fact** — `verify` and the harness scorecard, which catch a subset
   of damage *after* it is already in the worktree.

Everything else is a model behaving as instructed, which is not a security control.

## What the runtime guard actually refuses

`src/hooks.ts` registers a `tool.execute.before` hook. It applies **only to sessions this
plugin itself spawned** — the plugin records the session ids it creates, and the guard
fires for exactly those. Your own session on the same opencode server is untouched, because
the hook event carries a session id and nothing else, and guarding everything would mean
this plugin silently refusing your own commands under a policy you never opted into.

Within those sessions it refuses six things, by regex, each because it defeats a gate the
run itself depends on:

| Refused | Why it is on the list |
|---|---|
| `git commit --no-verify` (and the `-n` short form) | skips the repo's own pre-commit checks |
| `git push --force` / `-f` (not `--force-with-lease`) | discards commits that are not the worker's to discard |
| `git reset --hard`, `git clean -f` | destroys uncommitted work in the worktree, including work not yet reported |
| `rm -rf` | recursive force delete |
| edits to paths under `.github/workflows/` | a worker that edits the gate judging it has removed the judge |
| `git checkout`/`switch` to `master` or `main` | takes the work out of the isolated branch nobody else is watching |

A project can add its own rules — `{ pattern, reason }`, where `pattern` is a regex source
— in `hooks.guard.refuse` in `.claude/settings.json`, and turn the whole guard off with
`hooks.guard.enabled: false`. That file ships with the package so the policy is inspectable
and disablable by whoever installed it. A settings file that does not parse degrades to the
built-in list and says so; an entry whose regex does not compile is skipped rather than
taking the rest down.

### What the guard is not

**It is not a sandbox, and it is not a security boundary.** It is a denylist of six regexes.
A determined or merely creative model can express any of those actions in a form the
patterns do not match — a shell variable, a script file, an alias, `git` invoked through
another tool. It is a guard against the plausible accident, not against an adversary, and
a claim otherwise would be worse than no guard because it invites trust it cannot carry.

The denylist is deliberate rather than an allowlist: an implementer legitimately runs
arbitrary build, test and inspection commands nobody can enumerate in advance, so an
allowlist would refuse real work daily and be switched off within a week.

## In scope

- Anything that lets a **repository's contents** — code, issues, ADRs, tool output —
  cause the plugin to run commands or write files outside the confinement it advertises.
- **Credential handling**: API keys reaching a log, an artifact under `council-artifacts/`,
  a written ADR, a report, or a model that did not need them.
- A **bypass of the guard's stated scope** — a guard that fires on the user's own session,
  or that silently does nothing while reporting it is protecting you (this has happened
  once: registration was per-process and the hook read an empty set; see
  `docs/adr/2026-09-20-runtime-hooks-for-the-implementer.md` and the 2026-09-24 fix).
- Path traversal or worktree escape in the `lets`/`crew` worktree handling.
- Anything that causes the harness gate to report a pass it did not measure.

## Out of scope

- **Evading the six refusal patterns by rephrasing a command.** This is a known and
  documented limitation, not a vulnerability — see above. A concrete class of bypass that
  defeats the *scoping* (sessions the plugin spawned) is in scope; a cleverer `rm` is not.
- A model producing wrong, harmful or low-quality code, or following an instruction that
  was in the repository. There is no defence here against a malicious repository, only the
  confinement the server enforces, and you should assume the implementer will do what the
  code it reads tells it to.
- Vulnerabilities in **opencode itself**, in the model providers, or in `zod` — report
  those upstream.
- Anything requiring an attacker who already has local shell access as your user; they do
  not need this plugin.
- The cost of API calls made by a run.

## If you run this unattended

- Run it against a repository whose contents you trust, in a worktree, on a branch nobody
  else is on.
- Scope the API keys you give it, and rotate them if a run does something surprising.
- `council-artifacts/` and `.lets/` hold transcripts of model runs; both are gitignored,
  and both can contain whatever was in your code. Treat them as you treat the code.
- Read the report. The whole point of the audit trail is that someone does.
