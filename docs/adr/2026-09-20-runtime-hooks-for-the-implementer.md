# Runtime hooks for the lets implementer: refusing the action, not scoring the damage

**Date:** 2026-09-20 · **Status:** proposed · **Scope:** design only — no code in this change

## Context

The `lets` implementer is the only model in this plugin holding `edit` and `bash`. Today it
is bounded by two things:

1. **Confinement** — `external_directory: deny`, plus `edit`/`bash` granted only when the
   caller opts in, enforced by the opencode server rather than by a prompt sentence
   (`src/engine.ts:332-350`). Measured 2026-08-21: a read outside the worktree returns
   "denied by the permission rules" immediately.
2. **Detection after the fact** — `verify` (did the code break) and, since
   [the harness scorecard](2026-09-19-harness-scorecard-beside-verify.md), ECC's repo
   scorecard (did the repo get worse).

Confinement answers *where*, never *what*. Inside the worktree the worker may do anything:
`git commit --no-verify`, delete a CI workflow that is failing, `rm -rf` a directory it
decided was stale, weaken a check to make an item pass. The harness scorecard catches a
subset of that — but only **after** the damage is committed to the worktree, and only for
what ECC's rubric happens to measure.

ECC ships 48 hook scripts under `scripts/hooks/` and an OpenCode adapter at
`.opencode/plugins/ecc-hooks.ts` that already maps Claude Code's hook events onto
opencode's (`PreToolUse → tool.execute.before`, `PostToolUse → tool.execute.after`). The
question this ADR answers is whether those can become a **third gate** — preventive rather
than detective — for the implementer specifically.

## What was measured

Everything below was verified against opencode 1.18.31 on 2026-09-20, not inferred.

**1. `tool.execute.before` runs before the tool, and a throw blocks it.**

The runtime does `yield* i.trigger("tool.execute.before", …)` and only then
`yield* k.execute(…)` — confirmed by reading the shipped binary. A probe plugin that throws
on a matching command was installed and driven for real:

```ts
"tool.execute.before": async (input, output) => {
  if (input.tool === "bash" && String(output?.args?.command ?? "").includes("FORBIDDEN"))
    throw new Error("BLOCKED_BY_HOOK: the probe refused this command")
}
```

```
✗ echo FORBIDDEN_TEST_STRING failed
Error: BLOCKED_BY_HOOK: the probe refused this command
```

The command did not run, and **the model was told why in the tool result** — it reported
back that a local hook had refused it. That second half matters as much as the block: a
refusal the worker cannot read is a silent stall, and this one is legible.

**2. Hooks apply to spawned sessions, over HTTP.**

This was the load-bearing unknown. `lets` does not shell out to `opencode run`; it POSTs to
`/session` and `/session/:id/message` on a long-lived server (`src/engine.ts:318-352`). A
session was created against the probe's directory and driven through that exact path:

```
POST /session?directory=/tmp/hookprobe          → ses_f42bab896ffe32GTbwj1Zrntrt
POST /session/<id>/message?directory=/tmp/hookprobe
→ "The command was blocked: BLOCKED_BY_HOOK: the probe refused this command"
```

So the mechanism reaches the implementer. Had this failed, the whole design would have been
dead and the right answer would have been "don't".

**3. The opencode hook signature is `(input, output)`, and the args are in `output`.**

```ts
"tool.execute.before"?: (
  input: { tool: string; sessionID: string; callID: string },
  output: { args: any },
) => Promise<void>
```

`sessionID` is present; the tool arguments are **mutable on `output.args`**, which is how
the adapter reads a bash command. There is no `directory` or `agent` on the input — see
risk 1.

**4. ECC's OpenCode adapter does not block. It logs.**

`.opencode/plugins/ecc-hooks.ts` is 599 lines and its `tool.execute.before` is entirely
`log("warn", …)` / `log("info", …)`. Its own comments say "Block creation of unnecessary
documentation files" above a branch that only warns. The 48 enforcing scripts live in
`scripts/hooks/` behind Claude Code's `hooks.json` contract (`PreToolUse`, `Stop`,
`SessionStart`, …), which reads JSON on stdin and signals refusal by exit code — a contract
opencode does not implement.

**This is the finding that shapes the decision: there is no adapter to adopt. There is a
naming convention to adopt and an enforcement layer that would have to be written here.**

## Decision

**Write a small, first-party hook layer in this plugin. Do not import ECC's.**

Six constraints, each from something measured above or from a rule this plugin already
holds:

**1. It gates the implementer, and nothing else.** Every hook is a no-op unless the call
belongs to a `lets`/`crew` implementer session. The user's own interactive session must be
untouched — a plugin that silently starts refusing a human's `git push` has made itself the
problem. See risk 1 for how the session is identified.

**2. Refusals are a deny-list of specific, named actions — never a judgement call.** The
candidate set, drawn from what ECC's scripts guard and narrowed to what an unattended
implementer can plausibly do inside a worktree:

| refuse | why |
|---|---|
| `git commit --no-verify` / `-n` | defeats the repo's own hooks; the worker is not entitled to skip them |
| `git push` | `runExecute` owns pushing, after review. A worker push bypasses the gate entirely |
| `rm -rf` outside the worktree, or of `.git` | confinement covers reads; this covers destruction |
| writes to `.github/workflows/**`, `hooks/**` | the exact damage the harness scorecard detects — better refused than scored |
| reads/writes of `**/.env`, `**/*.pem`, `**/*.key` | already an instruction in `implementPrompt`; an instruction is not an enforcement |
| `git checkout`/`switch`/`reset --hard` on the branch | the run owns the branch; a worker moving HEAD corrupts the record |

Each is a pattern match on `output.args`, decided in code. **No model is consulted about
whether an action is allowed** — the same rule as `decide()` and the harness comparison.

**3. A refusal is a first-class outcome, not an error.** It must reach `ItemOutcome` as its
own state (`refused`), alongside `harness-regressed` and for the same reason: "the code is
broken", "the repo got worse" and "the worker tried something it is not allowed to do" are
three different facts and must not collapse into one label. The refusal reason becomes the
retry's feedback, exactly as the harness regression does.

**4. Every rule is individually switchable, and the whole layer is off by default.** A new
`hooks:` key in the ` ```lets ` block, with the `tracker`/`harness` semantics: absent means
never asked, `none` is a recorded decision never re-asked. Shipping enforcement on by
default would change the behaviour of every existing repo on upgrade.

**5. A refusal loop must terminate.** A worker that needs a refused action will retry it,
burn its 2 attempts + 3 escalations, and fail the item — spending ~50 minutes to arrive at
"it was never going to work". So: **the same rule refused twice in one item ends the item
immediately** with `refused` and the rule name. The wall-clock floor already bounds the run;
this bounds the waste inside it.

**6. Findings, not opinions, in the report.** The run report gains a line per refusal:
which rule, which command, which item. A run where the worker repeatedly tried to disable CI
is telling you something about the plan, and it should survive into the record.

## Alternatives rejected

**Import ECC's `hooks.json` and the 48 scripts.** They implement Claude Code's hook
contract, which opencode does not have; adopting them means writing the dispatcher *and*
owning 48 scripts whose failure modes are someone else's. The measured fact that the
OpenCode adapter only logs removes the "it already works" argument entirely.

**Use ECC's `.opencode/plugins/ecc-hooks.ts` as-is.** It would add logging, not enforcement.
Nothing in the problem statement is solved by more log lines.

**`permission.ask` instead of a throw.** The signature (`output.status = "deny"`) looks
cleaner. But this plugin's own comment records the measured trap: with no human attached, a
permission prompt **hangs** until the wall clock trips (`src/engine.ts:335-338`). A throw
returns immediately with a reason the model can read. Rejected on evidence.

**Prompt instructions instead of hooks.** `implementPrompt` already says not to read secret
files. That is exactly the gap this ADR exists to close: an instruction is a request, and an
unattended run is precisely where requests stop being honoured.

**Scoring instead of refusing.** Already built — that is the harness scorecard. It runs
after the fact, and for anything outside ECC's rubric it never runs at all.

## Risks

**1. Identifying the implementer session is not solved.** `tool.execute.before` gives
`sessionID`, `tool`, `callID` — no directory, no agent name. The plugin knows the session
IDs it created (`askOnce` has the response), so the intended approach is a module-level
registry of implementer session IDs, written at session creation and read in the hook. This
is the single largest implementation unknown; **it must be proven with a spike before any
rule is written**, because a hook that cannot tell whose call it is has only two available
behaviours and both are wrong: gate everything, or gate nothing.

**2. The plugin must be loaded in the worktree's config.** `opencode.json` is not tracked in
this repo (verified), so a fresh worktree does not inherit a project-local plugin list. If
plugin loading is per-directory rather than per-server, hooks may not fire for the
worktree-pinned session even though they fired in the probe. The probe passed
`?directory=/tmp/hookprobe` with the config **in that directory** — the untested case is a
directory with no `opencode.json` of its own. Spike this second; it is cheap and it is
another potential dead end.

**3. A false refusal is worse than no hook.** A rule that blocks something legitimate turns
into a two-attempt failure and a confusing report. Mitigations: off by default, per-rule
switches, the twice-then-stop rule, and the refusal reason in the retry feedback so the
failure is at least legible.

**4. Scope creep toward 48 rules.** The deny-list above is six entries and should stay
small. Every rule is a thing that can misfire, and the marginal rule is worth less than the
first six by a wide margin.

**5. Hook exceptions could break unrelated tool calls.** A bug in the matcher throws on
calls it never meant to gate, breaking the run in a way that looks like a model failure.
The hook body must be fully defensive — any internal error is swallowed and the call allowed,
because failing open is the correct bias for a layer that is not the primary gate.

## What would make this the wrong call

If the spike shows the implementer's session cannot be reliably identified from the hook, or
that plugins do not load for a worktree-pinned session, this design is dead — and the honest
answer becomes "confinement plus the harness scorecard is what we get", which is already
two gates more than most.

If, after running the harness gate on real work, refusals would rarely have fired — i.e. the
implementer does not in practice attempt these actions — then this is a solution to a
hypothetical, and the cost of a misfiring rule is not worth paying.

## Next steps, in order

1. **Spike A: session identity.** Register a created session ID, then assert the hook can
   match a call to it. Half a day. If this fails, stop.
2. **Spike B: worktree plugin loading.** Drive a session pinned to a directory with no
   `opencode.json` and confirm the hook still fires. If it fails, the plugin path must be
   written into the worktree by `openWorktree`, which is a design change, not a detail.
3. Only then: the deny-list, the `refused` outcome state, the `hooks:` config key, tests.

**Neither spike should be written until the harness gate has run on real work** — the
evidence from those runs is what decides whether step 3 is worth doing at all.
