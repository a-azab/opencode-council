---
description: Ask the council a question. /council:task for one converged answer with its dissent, /council:independent for unmerged takes.
---

LETS's `ask` pings one expert agent and returns its take. This plugin has no single-expert
surface and does not want one — it has fifteen lane-carrying models — so the question is
**not who to ask but whether you want the answers merged**.

That choice is the whole reason both targets exist. Make it before you call anything.

| you want | command | what you get |
|---|---|---|
| **one answer** you can act on | `/council:task` | every schema-capable model answers, the answers are cross-scored, and the winner comes back **with the objections raised against it still attached** |
| **the disagreement itself** | `/council:independent` | one file per model, no moderator, no debate, no synthesis — deliberately unmerged |

Pick `task` by default. Pick `independent` when the spread between models *is* the
information — an unfamiliar domain, a contested call, or any time a merged answer would
launder away the fact that the models did not agree.

## Running it

Call the `council` tool with `mode: "task"` (or `mode: "independent"`) and `goal` set to the
question. `$ARGUMENTS` is the question. Pass `context` as well when there is material the
models need to read — file contents, output, a spec. It is handed to them as data, not as
instructions.

If the user gave no question, ask for one. Do not invent it. Fifteen models answering a
question nobody set produces fifteen confident answers to the wrong question.

## Reading the result

**`task`** — present the answer, then the objections recorded against it. They are kept
verbatim precisely because a winning answer's score is an average, and an average erases the
one scorer who spotted the flaw. If it came back **tied**, show both and name the deciding
difference rather than choosing. If it came back **unranked**, say so plainly: answers
arrived but no score did, so nothing was compared — that is a council that never voted, not
a close call.

**`independent`** — report the counts and the artifact directory, and **do not summarise the
takes**. Aggregation is exactly what the user opted out of by choosing this mode. If they
then ask you to compare them, do it; the rule is that you do not do it uninvited.

Either way, name any model that failed to answer, so the user knows how wide the sample
actually was.

---

## Response Footer

- **Got one answer, and it settles the work** → `/lets:plan`.
- **Choosing between named options instead** → `/lets:opinion`.
- **The merged answer hid the disagreement** → re-run as `/council:independent`.

## Rules

- Choose `task` or `independent` deliberately, and say which you ran.
- Never summarise `independent` takes uninvited.
- Respond in the user's language.
