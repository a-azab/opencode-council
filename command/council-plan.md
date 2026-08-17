---
description: Plan an approach by council vote — five lanes propose, every model scores everyone else's proposal, the winner is arithmetic. Ties come to you.
---

Call the `council` tool with `mode: "plan"` and `goal` set to what the user asked for.

If the user gave no goal, ask for one first — do not invent it. A plan for a goal the
user did not state is worse than no plan, because it looks like an answer.

When the result comes back:

- **If there is a winner**, present it and say which lanes were outvoted and why. The
  losing proposals often contain the risk that the winner missed.
- **If it came back tied**, do not break the tie yourself. Say so, show both, and give the
  user the difference that actually matters between them. The tie means the numbers do not
  support a choice — inventing one puts your preference where the vote refused to.
- **If proposals were dropped**, say how many and why. A vote among three lanes is a
  different thing from a vote among five, and the user should know which one they got.
