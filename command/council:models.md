---
description: Ask what this server actually offers, measure the models the roster does not pin, and get back a proposal. Nothing is adopted — the roster is a source file and the change is yours.
---

Call the `council` tool with `mode: "models"`. It takes no goal: the question is fixed —
what can be used here that the roster is not already using, and does it work?

It reads the server's catalogue, keeps the entries on providers the roster already uses,
measures the ones it has budget for with a single structured-output probe, and writes a
proposal. It does not edit the roster, and neither do you on its behalf. Wait to be asked.

This is not `mode: "review"` or `mode: "task"` — no diff is read and no work is done. It is
the maintenance question the roster cannot answer about itself: a hardcoded list goes stale
in both directions, pinning a model that superseded versions have passed and listing one
that has quietly stopped answering.

**Why it stops at a proposal.** A later version number is not a measurement.
`google/gemini-3.7-flash` times out at 90 seconds on the probe `3.6-flash` answers in 9.
An updater that chased "latest" would have adopted it, cost the council a lane, and
reported the loss as an upgrade. Discovery is worth automating. Adoption is not.

When the result comes back:

- **If there are candidates**, present them with their measurements, not just their names.
  A model that answered in 3 seconds and a model that returned nothing are both "available"
  and the word is doing no work — the number is the whole content of the recommendation.
- **If a candidate failed its probe**, say so plainly and do not soften it into a maybe. It
  was asked for a one-field object and did not produce one; every council lane needs exactly
  that, so it has no lane here regardless of what it is called or when it shipped.
- **If candidates went unmeasured**, name them as unknown rather than untested-so-probably-
  fine. Probes are capped per run because each one is a full model call, so a blank row is a
  question nobody has asked yet.
- **If the server returned no catalogue**, report it as a missing proposal, not a broken
  council. The roster still works; discovery is the thing that was unavailable.
- **If the user wants one adopted**, tell them what to edit — the member's `model` in
  `ROSTER`, plus a re-measured `ms` — and let them make the change.
