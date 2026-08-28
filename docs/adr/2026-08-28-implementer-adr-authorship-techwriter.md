# Who writes the code, who writes the record, and who keeps the docs true

**Date:** 2026-08-28 · **Status:** accepted · **Scope:** `src/lets.ts`, `src/roster.ts`,
`src/crew-org.ts`, `command/crew:plan.md`, `command/crew:execute.md`, `command/lets:plan.md`,
`agent/council-techwriter.md`, `README.md`

## Context

Three directives from the repo's owner, shipped together as `ccd2dcf`. They are filed
together because they are the same question asked about three jobs: **who is assigned to
this, and what happens when nobody is.**

deepseek was verified agentic and was doing nothing. The ADR was mandatory and had no
assigned author. Documentation was everyone's responsibility, which is to say nobody's.

The framing that decides all three is the owner's: **this is an organisation.** A council of
models is a set of people with jobs, not a pipeline with stages. Work that matters gets a
name attached to it, not a checkpoint bolted in front of it.

## Decision

1. **`LETS_MODELS` was split into `LETS_INTAKE_MODELS` and `LETS_IMPLEMENT_MODELS`**, and
   **deepseek leads the implementer chain** on cost. The split is not tidiness: the two call
   sites need opposite capabilities and no single filter over one list can serve both.
   Intake is filtered on `canSchema`. Only the implementer's **lead** is required to be
   `canAgentic`; **the tail is deliberately unfiltered.**
2. **The architect writes the ADR, after research and before decomposition**, and is
   **recruited unconditionally** (`recruitFloor`, `src/crew-org.ts`). It was
   keyword-triggered. `/lets:plan` writes one too, expected rather than enforced.
3. **A `techwriter` role joined the roster**, carried by `gemini36` and `gpt56terra` — the
   two members already carrying `docs` — with `agent/council-techwriter.md`. It is
   **deliberately not in `ROUTES`.** It is a person on the team, not a gate in the pipeline.

## The measurements and discoveries this rests on

### The two call sites want opposite things, and that is why the list split

One list served both. The moment deepseek led the implementer, it could not.

| | intake (CPO, CTO) | the implementer |
|---|---|---|
| the call passes | a **schema** — a forced tool call | `allow: ["edit", "bash"]`, **no schema** |
| the requirement | `canSchema` | `canAgentic` |
| deepseek | **400s** — `Thinking mode does not support this tool_choice` | **leads it** |

deepseek is the cheapest model in the roster that drives tools, and implementing is the
highest-volume paid call lets makes: every item, every attempt, every escalation. That is
where cheapest-first is worth the most. It is also the one call that sends no schema, which
is the only reason deepseek can take it.

### Why a per-site filter over one list is not the smaller change

Filtering one list at each call site is the obvious move, it is a smaller diff, and it is
wrong. **A filter can narrow a list. It cannot invert one.**

For a single list to serve both sites, it would have to contain deepseek — intake's filter
would then have to remove it, and the implementer's filter would have to *promote it to the
front*. That second operation is not a filter; it is an ordering rule that exists to
reintroduce cost preference the list had already thrown away. The list would then encode two
orderings at once and be correct in neither, and the "one list" it bought would be a lie
maintained by two predicates pulling in opposite directions.

The chains are not one list with exceptions. They are two lists that currently share five of
six members. Writing them as two says that; writing them as one with a filter says they are
the same thing and dares the next reader to find out otherwise.

### Unset capability is absent evidence, and this codebase has been here before

The implementer's tail is `LETS_INTAKE_MODELS` unchanged. Filtering it on `canAgentic` looks
like an obvious consistency fix. It would drop `minimax` and `kimik3`:

| member | `capability` | `canAgentic` reads | what is actually known |
|---|---|---|---|
| `deepseek` | `["agentic"]` | true | measured: drove bash, returned an exact marker, 9459ms |
| `opus5`, `gpt56terra`, `glm53` | `["schema", "agentic"]` | true | measured |
| **`minimax`**, **`kimik3`** | **unset** | **false** — defaults to `["schema"]` | **never measured for tool driving** |

`canAgentic` cannot distinguish "measured and failed" from "never measured", because the
default hides the difference. The roster records measurements rather than assumptions, and
the two members that genuinely fail a forced tool call are flagged **explicitly**, with
their 400s quoted. Silence in the `capability` field is not a failure report. Both members
have been implementing here all along.

The cost of getting this wrong is exact: **the fallback chain drops from five models to
three**, and the run that needs the fourth is by definition the run where deepseek is
already down.

**This is the third time this repo has hit the same trap, and it is worth naming as a
pattern rather than a coincidence:**

| site | the two things that look identical | what conflating them costs |
|---|---|---|
| `decide()` | "no skeptic voted" vs "skeptics refuted it" | a real finding disappears silently — hence `no votes → keep` |
| `src/schedule.ts` | a file absent from the graph vs a file with no neighbours | a stale graph reads as proven independence — hence `partial` mode and named files |
| `LETS_IMPLEMENT_MODELS` | `capability` unset vs `capability` measured-and-failed | the fallback silently shortens on evidence nobody gathered |

In all three, a default collapses **absence of evidence** into **evidence of absence**, and
in all three the failure is silent and looks like a working system. The general rule this
repo keeps rediscovering: *a field that is unset and a field that is set to a negative are
different facts, and any code that reads them the same way is hiding one of them.* When the
next default is added, this is the question to ask of it.

### A mandatory document cannot have a conditional author

`crew:plan` **refuses without an `adr` path**. The ADR is a hard requirement of the tool.

The architect — the role that writes it — was woken by a regex over the directive
(`ARCHITECT` in `src/crew-org.ts`), matching "new service", "migrate", "re-architect" and
similar. So a directive the regex missed produced a run that *could not proceed without an
ADR* and had *nobody assigned to write one*. The model would then pick whoever was free, and
a decision written up by whoever happened to be free is a summary, not a record.

Two tests asserted the old behaviour and both were **inverted**, deliberately:

- `recruitFloor always includes reviewer, even for a directive that routes nowhere` —
  `["reviewer"]` became `["architect", "reviewer"]`.
- `recruitFloor wakes qa for test work and architect for new structure` — its final
  assertion was commented `...and does NOT invent an architect for ordinary work` and read
  `assert.ok(!recruitFloor("fix the typo in the readme", []).includes("architect"))`. It now
  asserts the opposite.

That second test is worth recording precisely because it was not a bug: it was a correct
test of a design that had been decided wrongly. The regex still exists and still marks
structural work for the prompt's benefit. It no longer decides whether the ADR has an owner.

### The ADR is written after research and before decomposition

The old sequence wrote it last, alongside the plan. **A record written after the tasks exist
is a justification for them.** Written before, it is the decision the tasks come out of — and
anything that cannot be justified in it should not become a task. `command/crew:plan.md` now
sequences interview → research → the architect writes the ADR → decompose, and step 6 adds
the decomposition to the ADR already written rather than writing the ADR around a
decomposition already made.

### Documentation rots because it is nobody's job, not because there is no gate

The tech writer is a **role on the roster**, not a check in a pipeline, and
`agent/council-techwriter.md` states the standard the role exists to hold: *every claim is
checked against the source before you write it — not the commit message, not the plan, not
what the change was supposed to do.* It is pointed at the failure this repo actually has:
**a stale document is a defect**, because someone acts on it and it costs them a debugging
session.

It is carried by `gemini36` and `gpt56terra`, the two members already carrying `docs`. That
is the roster's existing statement about which models write prose, and a new role is not a
reason to relitigate it. `techwriter` is **appended** to their `roles` and never prepended:
`roles[0]` is the voice a model answers in (`engine.ts:1272`), so prepending would silently
re-cast an existing member. A test in `src/roster.test.ts` pins both halves — that some model
carries the role at all, and that no carrier's voice was displaced.

### `docs` reviews, `techwriter` authors, and `ROUTES` only wakes reviewers

`techwriter` is deliberately absent from `ROUTES`, where it would look natural beside `docs`
on the markdown globs.

`ROUTES` maps changed paths to the **review** lanes a diff should wake, and `docs` already
reviews exactly what a markdown diff breaks — statements the change has made untrue. The
tech writer authors: it writes and repairs the documentation a change left behind, as part
of the work, in `/crew:execute`. Adding it to `ROUTES` would put two prose models on every
documentation diff saying close to the same thing, which is precisely the per-change cost
routing exists to hold down. It reaches a panel through `ALL_ROLES` — the whole-council case,
not the per-diff one.

## Alternatives rejected

**One model list with a per-call-site filter.** The obvious move and the wrong one, for the
reason above: the sites require *different* capabilities, so no predicate over a shared list
produces both chains. It would also have needed a promotion rule to put deepseek first,
which is not a filter at all.

**Filtering the implementer's tail on `canAgentic`.** Consistent-looking, and it cuts the
fallback from five to three on the strength of a measurement nobody took. Unset is not a
failure report.

**Measuring `minimax` and `kimik3` for agentic capability before shipping.** The correct
resolution, and it remains open. It was not a reason to hold the change: the tail's members
are the models that were doing this job before deepseek arrived, so leaving them in restores
exactly the status quo while the measurement is outstanding. Filtering them out on no
evidence would have been a regression justified as a cleanup.

**Hardcoding deepseek as the implementer with no fallback.** Cheapest and simplest, and it
makes the cheapest model a single point of failure on the highest-volume call in the system.
A cheapest-first chain is only safe if it still finishes when the cheapest is unavailable.

**Keeping the architect keyword-triggered and having `crew:plan` fail loudly when the ADR
had no author.** Turns a silent hole into a loud one, which is better, and it still refuses
runs for a reason that is entirely within our control to prevent. The regex cannot be made
complete; directives are prose.

**Making the ADR optional for small directives in `/crew`.** This is what "conditional
author" amounted to in practice, decided by regex rather than by judgement. `/crew` has no
approval gate, so the record is the entire safety story; the namespace that can least afford
a missing record is the one being asked to skip it. `/lets:plan` *may* skip it — there a
human reads the plan — and must say that it skipped.

**A docs gate instead of a tech writer: a check that blocks the report until the
documentation is updated.** Rejected on the owner's framing, and it does not survive contact
with what documentation work is. A gate is binary and documentation is not: it cannot tell a
change with no documentation surface from one that needs a rewrite, so it either blocks
trivial work or waves through stale prose, and usually both. Worse, a blocking gate creates
an incentive to satisfy it — prose written to clear a check is exactly the documentation
nobody reads. Both `agent/council-techwriter.md` and `command/crew:execute.md` say it
outright: **not a gate.** Nothing is reverted because a doc lagged. What the report must do
is say what was updated and what is still stale, and why.

**Adding `techwriter` to `ROUTES` beside `docs`.** Two prose models on every markdown diff,
overlapping heavily, at exactly the cost routing exists to control.

**Prepending `techwriter` to its carriers' roles.** Would have re-cast `gemini36` and
`gpt56terra` as tech writers in every `runTask` call, silently, because `roles[0]` is the
voice. A one-word ordering change with no visible symptom.

## Consequences

- **Every full `/council:review` is 2 nodes more expensive.** `techwriter` is in `ALL_ROLES`
  and carried by two members, so the full panel went from 23 nodes to 25 — a ~9% increase on
  the most expensive path in the system, paid on every full review whether or not the change
  has a documentation surface. That is the price of making documentation a role rather than
  a route, and it is the strongest argument any future reader will have for undoing this.
  It should be undone on evidence that the lane says nothing useful, not on the node count
  alone.
- **Every `/crew:plan` run now recruits an architect**, including for a typo fix. The floor
  cost of a crew run went up by one lane, permanently, in exchange for an ADR that always
  has an author.
- **The two model chains must be kept in sync by hand**, and share five of six members. That
  duplication is deliberate and `src/lets.test.ts` guards the part that matters — each list
  is checked against `canSchema`/`canAgentic` in the roster rather than against its slugs, so
  a roster edit that invalidates a chain fails a test rather than a run.
- **`minimax` and `kimik3` remain unmeasured for tool driving.** They are in the implementer
  chain on the strength of prior use, not a probe. Measuring them would either confirm the
  tail or justify shortening it on evidence; until then the `capability` field records
  exactly what is known, which is nothing.
- **`deepseek` now carries no lane and does the most work in the system.** Any reading of the
  roster table that treats an empty `roles` column as "unused" is wrong, and was wrong in
  this repo's own README until this change.
- **The tech writer can be skipped without anything failing.** That is the design — it is a
  person's job, not a checkpoint — and it is also the risk. The only thing standing between
  this role and the failure it exists to fix is the report saying what is still stale.

## The record this ADR is late to

Both changes documented here shipped without the documentation they mandate.

**The change that made "always write an ADR" a hard requirement shipped without an ADR.**
The change that added a tech writer to keep documentation true shipped undocumented, and the
README carried four stale counts — a 23-node panel that was 25, 14 council agents that were
15, 17 agent prompts that were 18, and 280 tests that were 289 — until `f64f869`, written
after the fact by the roles this commit introduced.

This is not an amusing footnote. It is the exact failure mode both roles exist to prevent,
demonstrated by their own introduction, and it is the strongest evidence available that the
problem is real: the author of `ccd2dcf` had just finished arguing that a mandatory record
cannot have a conditional author, and then wrote no record. Good intentions and a fresh
conviction were not enough at the moment they were strongest. That is why the answer was an
assigned role rather than a resolution to do better.

The ADR you are reading was written afterwards, which by this repo's own standard makes it a
justification rather than a decision. It is filed anyway, and filed as late, because the
alternative is a decision with no record at all — and the lateness is itself the finding.
