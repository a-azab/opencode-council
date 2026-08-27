---
description: Interview the human into a directive, research it, design it, decompose it, and record the ADR. No approval gate — /crew:execute runs whatever this writes.
---

`/crew:plan` is the front half of the third namespace. `/lets` has you state the
requirements and approve the plan; `/crew` **interviews you for the requirements and then
decides the plan itself**. There is no approval gate after this command. What you write
here is what runs.

That asymmetry is the whole reason for the ADR. With nobody approving the plan, the ADR is
the only record of what was asked for and why — so it is written **before** execution, not
after, and it is a hard requirement of the tool: `crew:plan` refuses without one.

## 1. Read the repo before you ask anything

A question whose answer is already in the repo wastes the user's turn and teaches them the
interview is theatre. Before the first question:

- `graphContext` / the dependency graph, for what depends on what
- the detected stack, `AGENTS.md`, `README.md`
- `git log --oneline -30` and recent branches — what is already underway
- any `docs/**/specs/**` or ADRs that already cover this ground

Say in one line what you learned. Then ask only what the repo could not tell you.

## 2. The interview — bounded, and it may fail

Ask with the **`question` tool**, never as prose in a reply.

**Hard bounds: at most TWO rounds, at most FOUR questions per round.**

Round 1 targets the things that change the shape of the work:
- what "done" looks like, in terms someone could check
- what is explicitly out of scope
- constraints that are not visible in the code (deadlines, compatibility, people)
- which of the repo's ambiguities you actually hit while reading

Round 2 exists only to close gaps the answers to round 1 opened. If round 1 converged, do
not ask a second round to look thorough.

> **If it has not converged after two rounds, STOP.** Say so plainly: the directive is too
> vague to run unattended, name the specific questions still open, and do not plan. Do not
> guess, and do not "proceed with reasonable assumptions" — an unattended run built on a
> guessed requirement is exactly the failure this namespace has no gate to catch.

**Every question and every answer goes into the ADR, verbatim.** That is the requirements
record. Paraphrasing it away is destroying the only evidence of what the user asked for.

## 3. Research

Use the **browser MCP** for anything you need from outside the repo.

> **`websearch` does not exist in this environment.** A spawned session that reaches for it
> reports `NO-TOOL` and comes back with nothing. If you need the web, drive the browser.

Prefer primary sources — the actual docs, the actual changelog, the actual RFC. Record what
you found and what you could not find; "I could not confirm X" belongs in the ADR too.

## 4. Design, then decompose

Design first, in the ADR: the approach, what you rejected and why, the risks, and what would
make this the wrong call. Then decompose into tasks.

Decomposition rules that the scheduler depends on:

- **At most 12 tasks** (`MAX_TASKS`). More than that wants a human splitting it, not a
  scheduler. The tool refuses.
- Each task is `{title, items: [{title, detail, files, acceptance}]}`.
- **`files` is load-bearing.** It is what decides whether two tasks may run concurrently. A
  task that under-declares its files gets scheduled beside work it actually touches, and the
  first evidence of that is a merge conflict. List every file the item will touch.
- `acceptance` must be checkable by someone who did not write the task.
- Order tasks so that anything foundational comes first — the scheduler preserves plan order
  when it builds waves.

## 5. Write the ADR, then record the plan

Write the ADR to `docs/adr/` (or wherever this repo keeps them) **first**. It contains:

1. The directive as finally understood
2. Every interview question and answer
3. Research findings, including the dead ends
4. The design, the rejected alternatives, the risks
5. The task decomposition and why it splits that way

Then record it:

```
Call the `crew` tool with mode: "plan", directive: "<the settled directive>",
adr: "<path to the ADR you just wrote>", tasks: "<the decomposition as a JSON array>"
```

The tool computes the lane floor and the wave schedule and prints them back. If it reports
`sequential` or `partial`, say so to the user in your summary — it means the dependency
graph could not prove the tasks independent, the run will be slower than it looks, and
rebuilding the graph fixes it.

## Response Footer

- **Run it** → `/crew:execute`
- **See what it would schedule first** → `/crew:status`
- **You wanted to approve the plan yourself** → that is `/lets:plan`, not this

## Rules

- Never skip the interview because the directive "seems clear". The interview IS the
  requirements gathering; there is no later gate to catch what it missed.
- Never exceed two rounds or four questions per round. An interview that cannot converge is
  a signal, not an obstacle to push through.
- Never write the ADR after execution. A record written after the fact records outcomes,
  not requirements.
- Do not implement anything here. This command plans; `/crew:execute` runs.
- Respond in the user's language.
