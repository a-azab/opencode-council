---
description: Decide between competing approaches. Delegates to /council:plan — five lanes propose, every model scores everyone else's proposal, the winner is arithmetic.
---

LETS's `opinion` is the team meeting: several experts analyse a decision in parallel and one
of them writes the recommendation. **`/council:plan` is that meeting with the vote counted**,
so this delegates rather than porting it.

Call the `council` tool with `mode: "plan"` and `goal` set to the decision the user wants
made. `$ARGUMENTS` is the topic.

If the user gave no goal, ask for one. Do not infer it. A plan for a goal the user never
stated is worse than no plan, because it looks like an answer.

## What comes back

Five lanes propose an approach, then **every model scores every other model's proposal** —
no model scores its own. The winner is the arithmetic, not a summariser's preference.

- **A winner** → present it, and say which lanes were outvoted and why. The losing
  proposals routinely hold the risk the winner missed; that is most of the value here.
- **A tie** → do not break it yourself. Show both and name the difference that actually
  decides between them. A tie means the numbers refused to separate the options, and
  putting your own preference there is not a decision the council made.
- **Dropped proposals** → say how many and why. A vote among three lanes is a different
  thing from a vote among five, and the user is entitled to know which one they got.

## opinion vs ask

`/lets:opinion` takes a **decision with competing options** and returns a ranking.
`/lets:ask` takes a **question** and returns an answer. If you are choosing between A and
B, this one; if you want to know a thing, that one.

---

## Response Footer

- **A winner you accept** → `/lets:plan <the approach>` to turn it into work items.
- **A tie** → decide it yourself; the vote will not.
- **Wanted an answer rather than a ranking** → `/lets:ask`.

## Rules

- Never break a tie on the council's behalf.
- Never present the winner without the objections to it.
- Respond in the user's language.
