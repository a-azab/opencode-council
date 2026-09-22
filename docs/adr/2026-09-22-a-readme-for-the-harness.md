# A README that describes the harness this repo actually became

**Date:** 2026-09-22 · **Status:** accepted · **Scope:** `README.md`

## The interview

**What do you want delivered?**
A README that tells a new reader what this plugin is now, rather than what it was
when it was a code-review council.

**Why now?**
Thirteen commits in one session added a harness scorecard gate, ECC rule selection,
skill selection, a Ralph round contract with panel-judged acceptance, a loop guard,
a wall-clock ceiling, session cleanup and per-item checkpointing. `IDEA.md` still
describes the original brief — "a collaborative AI code-review council" — and that
is now the smallest part of what the tool does. A reader arriving at this repo has
no single document that explains the harness.

**What does done look like?**
`README.md` exists, is accurate about what is implemented, and names the three
command namespaces (`council`, `lets`, `crew`) with what each is for. Every claim
in it must be checkable against the source.

**What is explicitly out of scope?**
No new features. No changes to `src/`. No documentation of the unwired `runLoop`
as though it were active — the README must not claim capability the code does not
have, which is the same rule the harness applies to itself.

## The research

The repo already carries substantial docs: `docs/adr/` holds nine ADRs, and
`command/` holds the slash-command documentation for all three namespaces. What is
missing is the entry point that orients a reader before they reach any of it.

Existing material that the README must stay consistent with:

- `IDEA.md` — the original brief, now one capability among several
- `docs/adr/2026-09-20-borrowing-from-dsh-and-ecc.md` — why dsh and ECC are borrowed
  from rather than depended on
- `docs/adr/2026-09-19-harness-scorecard-beside-verify.md` — the harness gate
- `command/*.md` — the user-facing contract for each command

## The design

One `README.md` at the repo root, with:

1. What the plugin is, in two sentences.
2. The three namespaces and when to reach for each.
3. What the harness enforces — the gates a work item passes through.
4. Installation: the `plugin` array entry and the `lets` fence in `AGENTS.md`.
5. A pointer to `docs/adr/` for the reasoning behind each mechanism.

The constraint that matters: **every claim must be checkable against the source.**
A README that overstates what is wired is worse than no README, because it is the
document a reader trusts before they know enough to verify it. `runLoop` exists but
has no caller; if the README mentions the round contract it must say where it is
actually used (the acceptance panel and the carry-forward) and not imply a
standalone loop driver is running.

## Consequences

A new reader can orient without reading nine ADRs. The cost is one more document
that has to be kept true as the plugin changes; the mitigation is that it stays
short and points at the ADRs rather than restating them.
