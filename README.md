# MoPSE Teacher Support Bot

A Telegram support bot for teachers recruited by the Ministry of Preschool and
School Education, Uzbekistan. Teachers verify their identity, browse an approved
FAQ bank, open support cases, escalate urgent ones, and submit documents. Staff
work those cases through bot commands.

This repository is the **rebuild**: the bot moves off Google Apps Script and a
Google Spreadsheet onto a rented server running PostgreSQL. The rebuild plan and
the reasoning behind every decision live in the working document
`MoPSE Teacher Support Bot — Rebuild Plan` (artifact `64bce4b9`).

> **The bot has never been launched.** No teacher has used it and it holds no
> real data. There is nothing to migrate and no switch-over window — we are
> building the real version and launching that instead.

---

## ⚠️ Do not add a public remote

`FAQ-import.csv` holds the **112 approved answers** on salary, tax, visas,
contracts and placement. It is confidential ministry content and it is committed
here because this is currently its only copy.

Before adding any remote to this repository, confirm the destination is private
and ministry-controlled. Adding a public remote would publish the answer bank,
and rewriting git history afterwards does not reliably un-publish anything.

Secrets are a separate matter and are never committed at all — see `.gitignore`.

---

## Layout

```
BOT-SPEC.md                  What the system does. The statement of intent, and
                             what the test suite is written against.
RUNBOOK.md                   How to deploy and operate it. Rewritten in Stage 7
                             for the new architecture — still describes Apps
                             Script until then.
CONCERNS-AND-IT-ACTIONS.md   Accepted risks and outstanding IT actions.
FAQ-import.csv               The approved answer bank (see warning above).

reference/                   The previous implementation, preserved as a
                             detailed instruction manual — not as code to run.
  apps-script/               The fourteen original .gs files (4,207 lines).
  UPGRADE-PLAN.md            Superseded. Planned fixes to the Apps Script
                             version in place; the rebuild replaces it.
  DEPENDENCY_TREE.md         Map of how the Apps Script version fitted together.
```

The new application is added stage by stage. Each stage produces something
testable and no stage depends on a later one.

## Why the old code is kept

The Apps Script version is unusually well commented: almost every safety check
explains *why* it exists and what broke without it. Those comments are the
record of real operational judgement, and the rebuild carries that thinking
forward.

What it does **not** carry forward is roughly 200 lines that exist only to cope
with a spreadsheet — the cell-edit watchers, the two "ignore my own edit"
mechanisms, the verification counter, and the whole archive system. Copying
those out of caution would import spreadsheet-shaped bugs into a system that no
longer has the constraint.

Because the bot was reviewed but never actually run, the old code is treated as
a description of intent rather than as known-good behaviour. Tests are written
against `BOT-SPEC.md`, not against whatever the old code happens to do.
