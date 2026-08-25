---
description: Hand the council a task — every model works it, the models score each other's answers, and one answer comes back with the objections to it still attached. Ties come to you.
---

Call the `council` tool with `mode: "task"` and `goal` set to the task the user wants done.
Pass `context` as well when there is material the models need to read — file contents,
output, a spec. It is given to them as data, not as instructions.

If the user gave no task, ask for one. Do not invent it. Fifteen models answering a task
nobody set produces fifteen confident answers to the wrong question.

This is not `mode: "plan"`. Plan asks five lanes how they would approach a goal; this asks
every model to actually do the thing and returns the answer that survived cross-scoring.

When the result comes back:

- **If there is an answer**, present it. Then present the objections raised against it —
  they are recorded verbatim precisely because a winning answer's scores are averages, and
  an average erases the one scorer who spotted the flaw. An answer delivered without its
  dissent is a summary of the vote, not the result of it.
- **If it came back tied**, do not break the tie yourself. Show both answers and the
  difference that actually decides between them. The scores refused to separate them;
  putting your own preference there is not a decision the council made.
- **If it came back unranked**, say so plainly. Answers arrived but no score did, so
  nothing was compared — that is a council that never voted, not a close call.
- **If models failed to answer**, name them. Eight answers cross-scored is a narrower
  sample than fifteen, and the user should know which one they are reading.
