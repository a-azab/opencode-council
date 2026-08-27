# Council: colon namespace, measured capability, and a dynamic roster

**Date:** 2026-08-25 · **Status:** accepted · **Scope:** `src/roster.ts`, `src/engine.ts`,
`src/catalog.ts`, `command/`, `README.md`

> **Superseded names, 2026-08-26.** This record predates the `crew` → `lets` rename
> ([2026-08-26-lets-workflow-port.md](2026-08-26-lets-workflow-port.md)). Where it says
> `crew.ts`, read `src/lets.ts`; where it says `crew:init`, read `/lets:init`. The wording
> below is left exactly as written — an ADR records a decision as it was made, and editing
> it to match a later rename would make the record lie about itself.
>
> Nothing enforces this note: the rename guards scan `command/`, `src/` and `README.md`,
> deliberately not `docs/`, because a guard over dated records would demand rewriting
> history to stay green. Accuracy here is a convention, not a test.

## This file establishes the ADR convention

ADRs live at `docs/adr/YYYY-MM-DD-slug.md`. One file per decision, **named by date and
slug, never by sequential number.**

Sequential numbering (`0007-…`) requires allocating the next integer, which is a shared
counter. Two workers deciding two things concurrently both read `0006` and both write
`0007`; the collision surfaces as a merge conflict at best and a silently overwritten
decision at worst. The crew is built to run lets in parallel, so that race is the normal
case here rather than an edge case. A date and a slug need no allocation and cannot
collide.

This is the first entry.

## Context

The council fired a routed subset of a fourteen-model hardcoded roster at every review,
under kebab-and-bare command names (`/council-review`, `/check`) while `crew:*` was already
colon-namespaced. Debate was off. There was no way to hand the council a task rather than a
diff, and no way to ask what the server could actually serve today.

Design spec: [`docs/superpowers/specs/2026-08-25-council-design.md`](../superpowers/specs/2026-08-25-council-design.md).

## Decision

1. **One namespace, one name per command.** The five commands move to `/council:review`,
   `/council:fix`, `/council:plan`, `/council:independent`, `/council:check`. No aliases —
   an alias is a second name to keep true.
2. **`/council:review` wakes every lane and debates.** `councilArgs()` returns
   `{ roles: ALL_ROLES, maxRounds: 2 }`, read at the call site in `index.ts`.
   `DEFAULT_MAX_ROUNDS` stays `0` so crew's branch review inherits neither.
3. **Two new commands.** `/council:task` — every schema-capable member answers, members
   cross-score, one answer returns with its dissent attached. `/council:models` — discover
   the live catalog, measure candidates, propose. Never adopt.
4. **Capability is a measured set, not a catalog flag.** `capability: ("schema" |
   "agentic")[]`, defaulting to `["schema"]`.
5. **`tier: "deep" | "standard" | "fast"` records the vendor's own class**, and is never
   derived from `ms`.
6. **Two new roles**, `architect` and `infrastructure`, each with carriers.

## The measurements this rests on

All taken 2026-08-25 against the live server, one call each unless stated.

### `gpt-5.6` ships as three tiers, not three variants

| member | model | tier | job | ms |
|---|---|---|---|---|
| `gpt56sol` | `openai/gpt-5.6-sol` | `deep` | peak reasoning, slowest, dearest | 3696 |
| `gpt56terra` | `openai/gpt-5.6-terra` | `standard` | balanced production default | 2664 |
| `gpt56luna` | `openai/gpt-5.6-luna` | `fast` | high-volume, budget | 4228 |

All three pass structured output. They are three members doing three different jobs, not
three candidates for one slot.

**`ms` must never be used to rank them.** An earlier draft of the spec picked Terra for the
single slot *because it won the latency probe* — and the data mocks that reasoning:
**Luna, the tier built for speed, measured slowest of the three.** A one-call probe ranks
queue noise, not capability. `ms` is documented in `roster.ts` as a timeout input, and this
is the case that proves the documentation has to be obeyed rather than admired.

### "Latest" is not "better" — so adoption is human-gated

`google/gemini-3.7-flash` **times out at 90s** on the probe that `google/gemini-3.6-flash`
answers in 9s. `gemini36` is therefore pinned unchanged at 3.6.

This is the whole argument for `/council:models` proposing rather than adopting. An
auto-updater chasing version numbers would have taken 3.7, quietly cost the `breadth` and
`docs` lanes, and reported the loss as an upgrade. Discovery is worth automating; adoption
is not.

### Availability is not capability — the route was the problem

`opencode/hy3-free` returned `malformed` **3/3**. `opencode-go/hy3` passes structured
output at **6117ms**. Same model, different route. `hy3` is re-pinned to the paid route
rather than dropped, which is what a model-level judgement would have got wrong.

### The 400s name a capability class, not one model's quirk

Two models drive tools perfectly well and refuse a *named* tool call, and their errors say
why:

```
deepseek/deepseek-v4-pro
  400  Thinking mode does not support this tool_choice

opencode/muse-spark-1.2-contributor-free
  400  only "auto" is supported for tool_choice; "none", "required", and named
       function choices are not currently supported
```

That boundary — `tool_choice: auto` yes, named function no — is exactly the boundary
between an implementer and a council lane. Council lanes need forced-tool-call output; an
implementer only needs to drive tools. Hence `capability: ("schema" | "agentic")[]` rather
than a deepseek special case: a second model failing the same way one week later would have
needed a second special case.

Both carry `roles: []` as defence in depth — every role-based selector filters them out
even if a capability check is missed. `deepseek/deepseek-v4-pro` is verified agentic: drove
bash, returned an exact marker, 9459ms.

### Debate: re-tested, not reversed

The measurement that turned debate off stands: **1 round, 6 re-judgements, 0 changed
positions, wall time 74s → 212s.** Huang et al. (ICLR 2024) found the same shape — debate
losing to self-consistency at matched budget.

Rounds are now on for the `/council:*` path at the human's explicit request. **This is a
re-test, not a reversal.** The evidence is not overturned; it is being re-run where it can
be seen. `report.ts` prints a `## Convergence` block giving, per round, the re-judgement
count and every changed position (`model→tier`), or `(positions held)`. So the next several
council reviews either produce the positive result the rounds have never had, or retire
them on a second measurement rather than on a hunch.

The split lives at the call site, not in the constant: `crew.ts` calls `runReview` with
neither `maxRounds` nor `roles`, so raising `DEFAULT_MAX_ROUNDS` would silently give every
crew branch review two rounds. A test pins the constant at `0` and pins crew's call to
passing neither.

### The scoring pass has no fast-tier lever; the skeptic pool does

Both are high-volume shallow loops, so both look like places to route the `fast` tier. Only
one of them is.

- **`scorersFor` is a cyclic assignment.** Proposal `i` of `N` is scored by
  `(i+1)…(i+k) mod N`. Every member therefore scores exactly `k` regardless of ordering —
  **verified uniform at 3 per model across all 15 proposers.** Sorting its output shifts no
  volume, because nothing is discarded. Ordering there would be a cost lever that moves no
  cost.
- **`skepticPool` slices.** It takes `count` from the front and drops the rest, so the
  order genuinely selects *who runs*, not merely who runs first. `preferFast` there is a
  real lever: it puts `gpt56luna` at the head of the pool.

`gpt56luna` carries `skeptic` deliberately. `skepticPool` filters on that role, so without
it the fast tier would be unreachable from the highest-volume loop in the system — the
tier routing would be dead code.

## Alternatives rejected

**An `everyModel` selection option.** Proposed so `/council:review` could guarantee every
member gets used. Tracing `selectNodes(ALL_ROLES)` shows **23 nodes with all 15
schema-capable members receiving ≥1** — the guarantee already holds by construction. An
option that guards a condition which never fires is dead code that still has to be read,
tested and kept true. It became a **roster invariant test** instead, which fails loudly if
a future roster change leaves a member unused.

**Auto-adoption of catalog upgrades.** Rejected on the `gemini-3.7-flash` measurement above.
Model identity changes what the council *is*: swap a member and every verdict afterwards
comes from a different panel. `/council:models` proposes and stops, the same
detect-and-confirm shape `crew:init` already uses.

**Reusing `runPlan` for `council:task`.** `runPlan` picks one member per planning role,
first match wins — at most 5 proposers — and scores all-pairs. `council:task` needs every
member and a bounded `k`.

**A one-dimensional `score: 1-10` for task scoring.** `tally()` sums exactly four
dimensions and `TIE_MARGIN = 0.25` is calibrated against that 4–20 scale. A single field
would make every term `undefined`, every mean `NaN`, every `NaN` comparison falsy — and the
sort would fall through to alphabetical-by-slug **while still reporting a confident
winner.** That is a silent false consensus, the precise failure `council:task` exists to
prevent. The task score reuses `Score`'s four dimensions verbatim and adds `objection`, so
`decide.ts` is unmodified.

## Consequences

- **`/council:review` is now the most expensive path in the system:** 23 nodes × up to 2
  debate rounds, plus verification. Intended and stated in the README rather than hidden.
  `/council:check` remains the cheap inline option.
- **`/council:task` costs 15 proposals + 45 scoring calls.** All-pairs would have been 210.
- **Ties are never resolved.** At `k=3` the means land on thirds, so exact ties are common;
  every tied answer is presented side by side and the report says the council did not
  converge.
- The roster is no longer a closed list: `substitutesFor` can recruit a verified
  non-roster model when the roster tiers are exhausted, bounded at 3 probes per run.
- Capability lives in `~/.cache/opencode-council/capability.json` — machine- and
  account-specific, so not in the repo. A teammate's quota is not a fact about the code.
