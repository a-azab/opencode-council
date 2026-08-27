---
description: Answer an external question from real sources you fetched. Browser-backed, no search engine — you supply the URLs or a starting page.
---

LETS's `research` decomposes a question, searches the web, fetches the best sources, and
returns a cited synthesis. **The fetching half works here. The searching half does not.**
Read the limitation before you rely on this.

## What is actually available

Verified on this machine on 2026-08-25, recorded in
[`docs/superpowers/specs/2026-08-25-council-design.md`](../docs/superpowers/specs/2026-08-25-council-design.md):

| | state |
|---|---|
| `webfetch` | **works**, including from spawned sessions |
| playwright / chrome-devtools / puppeteer MCP servers | **reachable**, including from spawned sessions — use these when a page needs JavaScript, a login, or interaction |
| `websearch` | **there is no such tool here.** It is a valid permission key, which makes it look configured, but a spawned session that reaches for it reports `NO-TOOL` |

So this command **cannot discover sources for you**. It reads sources. That is the whole
shape of the difference from LETS's version, and pretending otherwise would produce a
confident synthesis grounded in nothing but model memory — which is the failure mode a
research command exists to prevent.

## Give it somewhere to start

One of:

- **URLs** — the direct case. `webfetch` each one.
- **A starting page** — docs root, changelog, issue tracker, package index. Fetch it, then
  follow the links that matter.
- **A page that needs a browser** — anything JS-rendered, gated, or interactive. Drive
  playwright / chrome-devtools / puppeteer instead of `webfetch`.

With none of those, say so plainly and ask for a URL. Do not substitute recalled knowledge
and present it as research. If the user wants the models' knowledge rather than sources,
that is `/lets:ask` — and it should be labelled as such.

## Answer with its sources attached

Every claim carries the URL it came from and the date it was fetched. A claim you could not
source is reported as unsourced rather than dropped or smoothed in — the gaps are findings
too. Where two sources disagree, say so and cite both; do not pick silently.

## Then write it down

**A research finding that stays in the transcript is a finding you will pay for twice.**
Put anything that changes a decision into an ADR under `docs/adr/`, dated, following the
shape of the ones already there — with the **source URLs in the document**, so the next
reader can check the claim rather than re-derive it. `/lets:note` is the lighter option for
something that informs the current task but decides nothing.

---

## Response Footer

- **The finding changes a decision** → write `docs/adr/<date>-<slug>.md`, with its URLs.
- **It only informs the task in hand** → `/lets:note`.
- **No URL to start from** → ask for one, or use `/lets:ask` and label it as model knowledge.

## Rules

- Never claim a search was run. There is no search tool on this machine.
- Every sourced claim carries its URL and fetch date; unsourced claims are labelled.
- Respond in the user's language.
