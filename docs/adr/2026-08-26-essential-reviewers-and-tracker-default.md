# Essential reviewers, and what `/lets:init` is allowed to recommend

**Date:** 2026-08-26 · **Status:** accepted · **Scope:** `src/roster.ts`, `src/report.ts`,
`src/lets.ts`, `src/beads.ts`, `command/lets:init.md`

## Context

Two decisions shipped together, and they are filed together because they are the same
decision applied to different material: **a default that nobody chose is not a decision, and
a default that hides its own absence is a bug.**

One is about who reviews security. The other is about what `/lets:init` may put in your repo.

## Decision

1. **`Member.essential` pins a member to a role ahead of the per-role cap**, and `fable` is
   pinned to `security`. Availability still wins; an absent pin is **reported**.
2. **`/lets:init` asks which tracker**, via the `question` tool, and **recommends `beads`**
   wherever it can actually be honoured — `bd` on PATH *and* `.beads/` in the repo.
   Where it cannot, `none` carries the recommendation and the reason beads is missing is
   stated. **Nothing here runs `bd init`.**

## The measurements and discoveries this rests on

### `fable` held the security lane by arithmetic, not by rule

`MODELS_PER_ROLE` caps `security` at 3 (`roster.ts:131`). Exactly three members carry the
role — `opus5`, `fable`, `gpt56sol` — so all three fit and the panel looked deliberate.

It was not. `selectNodes` sorts candidates by `(timesUsed, ms)`, and `fable` is the slowest
of the three:

| member | ms |
|---|---|
| `gpt56sol` | 3696 |
| `opus5` | 4263 |
| **`fable`** | **6704** |

So `fable` sorts **last**, and `candidates.slice(0, cap)` would have dropped it the moment a
fourth `security` carrier joined the roster. Adding a model is the most routine edit this
repo has. **No test would have failed**, and the security panel would still have reported
three nodes — just not the one that was supposed to be there.

`essentialFirst()` takes the pins, then fills the cap's remaining slots as before.

### When a pin and the cap conflict, the cap loses

If the pins alone exceed the cap, **they all run and the cap is exceeded**. That inverts the
precedence everywhere else in the roster, and the reason is a difference in kind rather than
in weight: **a cap is a cost control; an essential reviewer is a correctness requirement.**
Spending more than budgeted is a number going up. Shipping a security review without its
named reviewer is a wrong answer that looks right.

### Availability still wins, and the absence is reported

`essentialFirst` picks out of `candidates`, which the caller has **already filtered** — not
`canSchema`, or benched by failover, and the member was never in the pool to be pinned back
in. "Always covers this role" is therefore conditional on being able to answer, which is the
only honest form the guarantee can take.

That conditionality is exactly what needed reporting, because the two existing report
sections both hide it. **A lane covered by a stand-in reads `ok` in the participation
table**: three security nodes answer, the panel looks complete, and the reviewer that was
required to be there never ran. `renderReport` now names the lane, the member, and what
became of it — its own failure state, the state it was passed over in, or `not selected`.

Scoped to lanes the run actually asked for (`inPlay`). A docs-only diff never wakes
`security`, and reporting a missing security reviewer there is noise that trains people to
skip the line on the run where it matters.

### `/lets:init` never asked, so the tracker was configured only by accident

`renderInitProposal` listed the available trackers as prose and `lets:init.md` had no
question for them. The human had to **volunteer the topic** to get a tracker at all —
which means the common outcome was terminal-only reporting that nobody chose.

The fix is the `question` tool, the convention `lets:commit.md` and `lets:done.md` already
use, with every available option listed and the recommended one first.

### A recommendation has to be something the human can accept as-is

`beads` is the recommendation wherever `availableTrackers` honours it: local, no token, no
server, nothing leaves the machine — and the repo has already opted in by having `.beads/`.

Where it cannot be honoured, **`none` carries the default**, because every other tracker
needs configuring before it would work. Recommending Linear to someone with no
`LINEAR_API_TOKEN` is recommending an error message.

Only what the proposal lists is offered. It has already checked the token, the server and
the `.beads/` directory, so anything it left out **cannot** be honoured — and offering it
would promise mirroring that silently never happens. Every remaining option is still shown:
a default is not a decision made for the user.

### The two ways beads can be missing want different things from the human

`beadsAvailable` is `bd` on PATH **and** `.beads/` in the repo. Collapsing both halves into
"beads unavailable" hides the actionable one, so `bdInstalled()` splits it:

| state | what init says |
|---|---|
| `bd` not on PATH | install it, then `bd init` here |
| `bd` installed, no `.beads/` | **`bd init` is yours to run** — and it is not run here |

The second is the one with a rule attached. **Creating a task database in someone's repo
uninvited is the same class of overreach `trackerFor` already refuses** when its Linear
branch declines to attach to an issue it would have to invent: *inventing an issue is not
ours to do* (`lets.ts:1023`). The binary being installed says the tool exists on the
machine. Only `.beads/` says *this repo* wanted it. Those are different facts and only the
second is consent.

## Alternatives rejected

**Leaving `fable` in the security lane on the arithmetic.** It works today and fails on the
next roster edit, silently, in the lane where silence is most expensive. The coincidence was
not visible from the roster table — three carriers and a cap of three look intentional.

**Raising `MODELS_PER_ROLE.security` to 4 instead.** Buys one roster edit of headroom and
restates the same coincidence one number higher. It also spends money on every security
review to fix a membership question.

**Letting the cap win over the pins.** Keeps one precedence rule instead of two, and gives
back exactly the failure the pin exists to prevent — quietly, since a capped-out pin drops
without a word.

**Substituting a stand-in silently when a pinned reviewer cannot answer.** This is what
already happened, and it is why the report section exists. A lane reading `ok` without its
essential reviewer is the failure, not the recovery.

**Reporting a missing essential reviewer on every run.** Rejected on the noise argument: a
line that is usually irrelevant is a line that stops being read.

**Defaulting the tracker without asking.** Faster, and it puts a choice about someone's
issue tracker in our hands. `none` was already the de-facto default precisely because
nothing asked; making that explicit is the smaller change and the honest one.

**Recommending `beads` everywhere, including where `bd` is absent.** A recommendation that
requires an install first is not a recommendation, it is a chore with a suggestion attached.

**Running `bd init` when `bd` is present and `.beads/` is not.** The version that looks
helpful. It writes a database into a project that never asked for one, and the first the
human hears of it is a new directory in `git status`.

## Consequences

- **A roster edit can no longer take the security panel's named reviewer out silently.**
  It can still take it out — by making `fable` unavailable — and then the report says so.
- **The per-role cap is no longer the last word.** `essentialFirst` can exceed it, and any
  future reasoning about cost must account for pins first.
- **`Member.essential` is a general mechanism with exactly one user today.** That is
  deliberate: the pin is a correctness claim about a specific lane, and pinning more
  members would raise the floor cost of every run that wakes those lanes.
- **`/lets:init` now asks a question it did not ask before.** One more prompt in first-time
  setup, in exchange for a tracker that was chosen rather than defaulted into.
- **A repo with `bd` and no `.beads/` gets told what to run, and it is still not run.**
  The human opts in, or does not, and `none` remains a fully-supported state rather than a
  degraded one.
