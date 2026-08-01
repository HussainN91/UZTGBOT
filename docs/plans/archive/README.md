# Superseded documents

**Nothing in this folder is current. Do not read anything here to get up to speed** — if you do, you
will be working from a picture of the project that was true on the day the document stopped being
maintained.

Where to go instead:

| You want | Read |
|---|---|
| The rules, patterns and procedures for working here | **`CLAUDE.md`** at the repository root — it loads automatically |
| Where the project stands, what is next, what is undecided | **`docs/plans/2026-08-01-identity-and-urgent-design.md`**, the plan of record |
| What the bot actually does | `BOT-SPEC.md` |
| How to run and deploy it | `RUNBOOK.md` |

---

## What is in here, and why it was retired

### `2026-07-29-stage-4-handoff.md` — the rolling handoff

Retired **1 August 2026**. It was rewritten in full at the end of every session and had become a
third copy of things that were already written down better elsewhere: status and open questions
lived in the plan of record, the reasoning behind each feature lived in its own design document,
what the bot does lived in `BOT-SPEC.md`, the traps in the code lived in the code's own comments,
and the commit table was `git log`.

**Three copies drift, and when they disagree nobody knows which is right** — the same argument this
codebase makes about not restating a rule in four places.

What was genuinely only in it has been moved, not dropped:

- The working rules, the machine's traps, and the artifact instructions → **`CLAUDE.md`**
- Two open decisions — reviewing the privacy notice before the deploy, and whether the Contact
  Support button under FAQ answers should be hidden from unsigned chats → **the plan of record's
  Open questions**, items 0 and 5

The final version, as archived, is accurate as of commit `81c2b30`.

### `2026-08-01-handoff-prompt.md` — the paste-into-a-fresh-window prompt

Retired **1 August 2026**, the day it was written. It existed to give a new session its bearings
from disk. `CLAUDE.md` does that automatically, for every session, with nothing to paste.

---

Older documents in `docs/plans/` — the stage plans, the review-phase findings, the deployment
handoff — are records of finished work rather than superseded ones. They stay where they are.
