---
description: Every model answers alone — no moderator, no debate, no synthesis. One file per model, deliberately unmerged, for when you want to read the disagreement yourself.
---

Call the `council` tool with `mode: "independent"` and `goal` set to the question or task
the user wants answered.

If the user gave no question, ask for one. Do not invent it.

When it returns:

- **Report the counts and the artifact directory. Do not summarise the takes.** This mode
  exists precisely because aggregation is lossy — the user asked for the raw perspectives,
  and collapsing them into a summary hands back exactly what they chose to avoid.
- If they then ask you to compare or synthesise, do it. The rule is that you do not do it
  *uninvited*.
- Name any model that failed to answer, so the user knows how wide the sample actually was.

For a question where you want *one* answer rather than several, `mode: "plan"` votes and
`mode: "review"` aggregates. This mode is the escape hatch from both.
