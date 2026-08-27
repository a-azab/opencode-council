---
description: Commit reviewed changes with a conventional message linked to the active task. Confirms before committing; never stages with `git add -A` or `git add .`.
---

Invoke `skill(name: "lets-commit")` and follow it as written.

The skill owns the whole flow: status, task detection, the diff review, matching this repo's
commit convention from its own log, the confirmation gate, and the staging rules. It lives in
a skill rather than in this file so that an explicit `/lets:commit` and a plain "commit this"
in a lets repo produce **the same commit** — a second copy of the rules here is a second copy
to drift.

If a free-text argument was passed, treat it as the **proposed subject line**. It does not
bypass anything: it still goes through the skill's Step 5 confirmation, and it is still
rewritten into the shape Step 4 finds in `git log`.

---

## Response Footer

The skill ends with its own state-driven footer. Do not print a second one.
