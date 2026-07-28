# Stage 4 Implementation Plan — Staff

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the loop. A teacher can file a case today and nobody can answer it — every staff-facing pipeline in this system currently terminates in the database. Stage 4 gives each one its endpoint: a person who can see the case, act on it, and have the teacher told.

**Architecture:** Built leaves-first, as Stage 3 was. Two pure modules (the role ladder, the queue map) hold every authorization decision; one SQL predicate holds every visibility decision; the commands are thin. Staff commands run *inside* the existing update pipeline rather than beside it, so they inherit the update claim, the chat lock and the interaction log.

**Tech Stack:** Unchanged — TypeScript on Node 22, grammY, PostgreSQL 17 via Drizzle, graphile-worker, Vitest.

**Baseline:** 332 tests, 24 files, typecheck and build clean, at `d743d72`.

---

## What this stage is not

`/announce` and `/export` are **Stage 5**, with the announcement tables that already exist for them. Both are bulk egress, both need a fan-out-and-report mechanism this stage does not build, and `/export` additionally needs a document-sending path that `src/telegram/send.ts` does not have. `BOT-SPEC.md` §6.5 lists them among the nineteen commands; they are deferred here deliberately, not overlooked. See D19.

---

# Decisions recorded

Continuing D1–D6 from the Stage 3 plan. These were open questions; they are settled here, with the reasoning, so they stay decisions rather than becoming accidents.

### D7 — The role ladder is the four values already in the schema, and `ReadOnly` is not carried over

**Decision:** Authorization uses `staff_role` exactly as `src/db/schema.ts:85` defines it — `Support < Regional < Program < System`, ranked by index in `STAFF_ROLE_ORDER`. The capability table from `BOT-SPEC.md` §6.1 is re-expressed against these four names. Apps Script's `ReadOnly` gets no equivalent.

**Why:** `ReadOnly` was not a designed role. `roleForAdmin_` (`AdminCommands.gs:185-193`) returns it when `ROLE` is blank *and* the row is not a System Admin *and* the Tier is not one of three known values — it is the "we do not know what this row is" bucket, produced by a migration fallback for spreadsheet rows written before the column existed. There are no such rows here: every `staff` row is created by a command that requires an explicit role, so the bucket has nothing to hold.

The re-expressed table, which becomes the single source of truth in `src/staff/roles.ts`:

| Capability | Support | Regional | Program | System |
|---|---|---|---|---|
| `case.view` — `/cases` `/mycases` `/urgent` `/case` `/search` | ✅ | ✅ | ✅ | ✅ |
| `case.update` — `/reply` `/close` `/reopen` `/note` | ✅ | ✅ | ✅ | ✅ |
| `case.assign` — `/assign` | | ✅ | ✅ | ✅ |
| `urgent.issue` — `/generate_urgent_code` | ✅ | ✅ | ✅ | ✅ |
| `teacher.revoke` — `/revoke` | | | ✅ | ✅ |
| `staff.manage` — `/staff` `/staff_add` `/staff_role` `/staff_remove` | | | | ✅ |
| `maintenance` — `/maintenance` | | | | ✅ |
| `announce`, `export` | | | ✅ | ✅ |

`announce` and `export` are in the table but have no command in this stage. They are listed so Stage 5 adds a command rather than a permission model, and so `/whoami` — which reads this table — does not have to change twice.

A System member bypasses every capability, queue and region check, exactly as `adminCanSeeCase_` does (`AdminCommands.gs:290-294`).

**Consequence, recorded as an open item:** there is now no way to give somebody sight of cases without also giving them the ability to change one. If MoPSE wants a ministry observer, that is one added enum value and one table row — cheap, and cheapest before launch. It is called out in the open items rather than quietly absorbed.

### D8 — Staff notes get their own table, rather than being appended to `cases.detail`

**Decision:** A new `case_notes` table. `/note` inserts a row; `/case` reads the most recent few.

**Why:** `src/cases/service.ts:170` states what `detail` is — *"the teacher's own words at the moment they filed"* — and `CaseFields` deliberately cannot reach it. Apps Script appended staff notes into the same cell (`AdminCommands.gs:788`), which is why `handleCaseDetail_` has a comment about the message outgrowing Telegram's 4096-character limit: an internal thread was accumulating inside a field that also holds a teacher's original words, with attribution and timestamps encoded as text somebody would eventually have to parse.

Three things a table gives that a text append does not: the author is a column, so "who said this" survives; the time is a column, in the database's clock rather than a formatted string; and `/case` can show the last few and say how many more there are, instead of growing until it must be split.

**The one thing it must not become:** a second write path for `detail`. `appendUrgentFollowUp` stays the only route that changes `detail`, and it stays append-only, because what it appends is the *teacher's* words on the urgent path.

### D9 — Staff commands are matched inside the pipeline, and an unrecognised sender falls through

**Decision:** Command recognition happens inside `routeText`, after `/start`, `/privacy` and `/help` and before the teacher state machine. A command word that exists is recognised whoever sends it; if the sender is not active staff, the denial is logged as `STAFF_DENIED` and the message **falls through to ordinary text handling** rather than being answered with a rejection.

**Why the pipeline:** the same argument that put `/privacy` inside it (`src/telegram/bot.ts:177-187`). A `bot.command` handler runs outside the update claim, outside the chat lock and outside the interaction log — a redelivered `/close` would close a case twice, and two staff members acting at once would not be serialised at all.

**Why the fall-through, which departs from `BOT-SPEC.md` §6.5:** the specification says `routeAdminCommand_` matches the word first and then rejects a non-admin with *"You are not registered as an admin."* That has two costs the rebuild does not have to pay. It confirms to any stranger that the command exists, which is precisely what §13's privilege-probing control is meant to make expensive. And because the rejection consumes the message (`AdminCommands.gs:409-417` returns `true`), a *teacher* part-way through describing a case who types anything beginning with `/case` loses what they wrote and is told they are not an admin.

Falling through keeps the audit trail — the denial is still logged with the caller's shape — while telling the sender nothing and costing them nothing. A teacher mid-case-detail files their text; a stranger gets the ordinary topic-picker reply.

### D10 — Visibility is one predicate, evaluated in SQL

**Decision:** `queue AND region` is computed in a single SQL fragment applied to every staff-facing case query. Never in JavaScript over a fetched list.

**Why:** `adminCanSeeCase_` was correct and was applied inside `.filter()` over case lists and inside per-admin loops (`AdminCommands.gs:529`, `569`, `597`, `636`, `836`). That forced `caseRegionMap_` to exist, and its own comment says the memoisation is *"not an optimisation — it is a correctness requirement for the execution limit"*. The whole apparatus is an artefact of not having a join. Filtering after fetching also means `LIMIT 20` cannot be pushed into the query: you fetch every case to display twenty.

Two properties of the rule must survive the translation, because both are load-bearing and neither is obvious:

- **An unknown region hides a case from nobody.** `adminCoversRegion_` returns true when the teacher's region is falsy (`AdminCommands.gs:236`). A teacher whose roster row has no region would otherwise file cases that no region-scoped staff member can see. In SQL that is an explicit `OR t.region IS NULL`, with a test.
- **A staff member with no regions covers all of them.** `staff.regions` defaults to the empty array and `src/db/schema.ts:281` says why: *"Empty array means every region — so adding this column cannot narrow existing access."*

### D11 — New-case notification is built here in full, because Stage 3's D2 was never implemented

**Decision:** Stage 4 builds targeted notification outright.

**Why:** Stage 3's D2 said it would *"emit a case-created event through the existing `Alerter`"* and leave "one clean seam for Stage 4 to widen". Checked against the code, there is no seam: `createCase` (`src/cases/service.ts:90`) returns without alerting, and no path in `src/telegram/router.ts` raises an alert when a case is filed. A case is filed today and **nothing anywhere is told** — not a staff member, not the operations chat, not the log.

That is not a criticism of D2, it is what D2 predicted would happen if it were built as written: notification through the alerter would have reached the operations chat with no queue or region filtering, and would have had to be unpicked here. But it means Stage 4 inherits the whole feature rather than widening a seam, and the plan is sized accordingly.

**Shape:** the recipients are computed inside the transaction and returned in `RouterOutcome.messages`, which already carries messages for people other than the sender (`src/telegram/router.ts:93-101`). They are delivered by `deliver` after the commit. Nothing is sent from inside the transaction — same rule as the duplicate-identity notice.

**Zero authorised recipients is an alert, not a log line.** `notifyAdminsOfNewCase_` writes `console.error` and returns (`AdminCommands.gs:355-359`); the case then sits unseen and the only trace is in a log nobody opens. Here it raises a critical alert naming the category, because a case nobody can see is the exact failure this feature exists to prevent.

### D12 — Alerts keep `OPS_ALERT_CHAT_ID` as the floor and add System staff on top

**Decision:** `telegramAlerter` continues to send to `OPS_ALERT_CHAT_ID` and additionally sends to every active System-role staff member. Both, always, not one or the other.

**Why:** `src/sync/alerts.ts:10` anticipates "an alerter that messages System-role staff", and read alone that suggests replacing the environment variable. It must not. The environment variable is what works when the `staff` table is empty, wrong, or unreachable — and "the staff table is wrong" is a state whose alarm must not depend on the staff table. It is also the only recipient during bootstrap, and the smoke test in `RUNBOOK.md` Part 3 step 8 treats its arrival as the proof that the whole alerting path works.

Duplicate delivery to a System member who is also in the operations group is accepted. An alarm arriving twice is a nuisance; an alarm arriving nowhere is the concern this whole mechanism exists to answer.

### D13 — The first System staff row is created by SQL, and that is documented rather than automated

**Decision:** No bootstrap command, no bootstrap environment variable. `RUNBOOK.md` gains a documented `INSERT`, in the same shape as the settings and urgent-code inserts it already carries (§2.4, §4.4).

**Why:** every alternative is worse. A bootstrap environment variable is a permanent back door that grants System access to whoever can edit `.env` — and moving permissions *out* of a file anyone could edit is the entire point of `BOT-SPEC.md` §13's permission-boundary row. A "first caller becomes System" rule is a race with the public internet. Apps Script's answer was a hand edit of the ADMINS sheet (§6.3), and the rebuild's version of a hand edit is SQL over the SSH tunnel, which requires server access rather than document access — which is the improvement.

**Consequence:** `/staff_remove` must refuse to deactivate the last active System member, exactly as `handleRemoveAdmin_` does (`AdminCommands.gs:1216`), because the recovery from getting that wrong is another trip to the database.

### D14 — Staff management commands are renamed to the vocabulary the schema uses

**Decision:** `/staff`, `/staff_add`, `/staff_role`, `/staff_remove` replace `/admins`, `/add_admin`, `/set_role`, `/remove_admin`.

**Why:** the word "admin" does not appear in the data model any more — the table is `staff`, the enum is `staff_role`, the column is `staff.telegram_id`. Keeping the old command names would mean the documents, the schema and the log rows say "staff" while the interface says "admin", which is the two-vocabularies-for-one-concept drift these plans keep finding elsewhere. The system has never been launched and nobody has been trained on the old names, so the rename costs nothing now and cannot be made cheaply later.

`BOT-SPEC.md` §6.5's command table is corrected in the documentation task.

### D15 — Group chats are refused, and the bot leaves them — except the operations chat

**Decision:** Restore the private-chat gate. Non-private updates are ignored; being added to a group triggers `leaveChat`; the chat whose id is `OPS_ALERT_CHAT_ID` is exempt from both.

**Why it is missing:** `Webhook.gs:57-69` rejects any non-private chat and leaves groups it is added to. `BOT-SPEC.md` §1 ("Not a group-chat bot"), §8.1.1 and §13's "Group exposure" row all describe this control as present. **It does not exist anywhere in `src/`.** This is the same class of loss as `update_id` deduplication in Stage 2.5 — a safeguard the specification still lists as shipped, dropped in the rebuild.

**Why it matters now rather than later:** the operations alert chat is a group, and the bot must be a member of it. Today, any message typed in that group enters the pipeline with a negative chat id, reaches `saveState`, and violates `conversation_states`' `CHECK (chat_id ~ '^[0-9]+$')`. The transaction rolls back and `bot.catch` swallows the error, so the whole thing is invisible. Stage 4 is also the stage where staff start using the bot, and staff put bots in groups.

**The exemption is the trap.** A naive "leave every group" implementation makes the bot leave the operations chat the moment it is added to it, which breaks every alarm in the system. The exemption is tested explicitly.

### D16 — A staff command's arguments are never written to the interaction log

**Decision:** `redactDetail` gains one rule: **any detail beginning with `/` is logged as its command word and first argument only.** The remainder is dropped.

**Why:** `redactDetail` chooses a redaction from the conversation state (`src/log/interactions.ts:45-78`). Staff have no conversation state, so `state` is `null` and the default branch applies — which keeps the text, masking only addresses and truncating at 500 characters. `/note VISA-2026-00001 <the internal note>` and `/reply VISA-2026-00001 <the message>` would therefore be written into `messages` almost verbatim. That copies internal case content into a table with a different retention story from the one it belongs to, and `BOT-SPEC.md` §4.2 keeps `detail` out of far less exposed places than this.

**Why the rule is on the `/` prefix rather than on a list of staff actions:** a list is a thing somebody forgets to extend. Stage 5 adds `/announce ALL <message to 1,800 teachers>` and `/export <reason>`; Stage 6 adds document commands. The prefix rule covers all of them the day they are written, and it leaves `/start`, `/privacy` and `/help` — which have no arguments — logged exactly as they are now. `/export`'s reason is deliberately recorded, and that is a `recordAudit` row, which this rule does not touch.

### D17 — Roster deactivation must actually revoke, and there is a command for the direct case

**Decision:** Two changes. Every gated action re-checks that the teacher's roster row is still active. And `/revoke <chat_id>` writes `verification_state = 'Revoked'`, `revoked_at` and `revoked_by`.

**Why:** `RUNBOOK.md` §4.3 tells an operator that setting a roster row inactive revokes a teacher and *"takes effect on their next message"*. It does not. `verifyIdentifier` reads `roster.active` (`src/teachers/verify.ts:91`) and that is the only place it is read — an already-`Verified` teacher never signs in again, and `requireSignIn` and `createCase` check `verificationState` alone. **A teacher who has signed in keeps full access after their roster row is deactivated or removed, indefinitely.** `CONCERNS-AND-IT-ACTIONS.md` A2 and `BOT-SPEC.md` §5.1 both repeat the claim.

This is the third dead pipeline of the same shape: the columns exist (`teachers.revoked_at`, `revoked_by`, and the enum's `Revoked` value), the documentation describes the behaviour, and nothing writes any of it.

**Why both halves:** the re-check makes the documented spreadsheet route true, which matters because that is the route an operator will actually use. The command writes the columns and gives an actor, which matters because "who revoked this person and when" is an audit question and a roster edit cannot answer it.

**The risk this creates, and why it is acceptable:** a roster row that disappears now cuts a teacher off on their next message. The sync's damage limit already refuses any run that would deactivate more than a fifth of active rows, which is the protection against a cleared or filtered tab. A single row removed by mistake affects one teacher, is visible in the sync history, and is undone by putting the row back.

### D18 — Every privileged action writes an audit row, inside its own transaction

**Decision:** `recordAudit` is called for staff lifecycle changes, maintenance changes, teacher revocation, case assignment and urgent-code issuance, in the same transaction as the action.

**Why:** it is what the table is for, it has never had a caller outside tests, and `src/log/audit.ts:8-13` already states the contract that makes it correct — unlike `logInteraction`, it *propagates* its errors, so a grant that cannot be recorded does not happen.

**What Stage 4 deliberately does not build:** a command to read `audit_log`. It is read by a person with database access during an investigation, which is the only time it is needed, and a command to read it would need its own permission model to avoid becoming the thing it audits. Recorded so it is a decision rather than an omission.

### D19 — `/announce` and `/export` defer to Stage 5

**Decision:** Neither is built here.

**Why:** they are the same feature wearing two hats — bulk egress with a confirmation step, a paced fan-out, and a report back to the sender. `announcements` and `announcement_recipients` exist for exactly this and `src/db/schema.ts:525-555` already records the design that makes a paced send resumable. `/export` additionally needs a document-sending path; `src/telegram/send.ts` sends text only. Building either here would mean building half the Stage 5 machinery in the wrong file.

`CONCERNS-AND-IT-ACTIONS.md` B3 already says announcements are Stage 5. The capability table carries both permissions from day one (D7) so Stage 5 adds commands, not a permission model.

---

# The pipeline audit — backward and forward

The instruction for this stage was to check the pipelines in both directions and put their endpoints in the right place. This section is that audit. It is the reason several tasks below exist at all.

## Backward — built in an earlier stage, consumer never written

Every row here is something a previous stage created and nothing has ever used. Each is either connected by this stage or explicitly declared dead.

| Built | Thing | Consumers today | Endpoint this stage gives it |
|---|---|---|---|
| Stage 2 | `staff` table | none — no reader, no writer | The staff repository, and every command |
| Stage 2 | `cases.owner` FK, `cases_owner_idx` | none | `/assign` writes it, `/mycases` and `/cases unassigned` read it |
| Stage 2 | `teachers.revoked_at`, `revoked_by`, state `Revoked` | selected by `findTeacher`, read by nobody | `/revoke` (D17) |
| Stage 2 | `audit_log` | `recordAudit`, tests only | Every privileged command (D18) |
| Stage 2 | `settings.OVERDUE_DAYS` | in `SETTING`, read by nobody | `/urgent`'s overdue half |
| Stage 2.5 | `setSetting` | tests only | `/maintenance` |
| Stage 2.5 | `Alerter` injection seam | logging + ops chat | System-staff fan-out (D12) |
| Stage 3 | `updateCase` | tests only | `/reply` `/close` `/reopen` `/assign` |
| Stage 3 | `cases.public_update` | always `''`; teachers see an empty field | `/reply` writes it — it is the only case text a teacher ever sees |
| Stage 3 | `urgent_codes.issued_by` | hand-inserted `'0'` per RUNBOOK §4.4 | `/generate_urgent_code` |
| Stage 3 | `teachers.region` | copied at bind time for "Stage 4's entire region axis" | The region half of D10 |

**The one that is not connected:** `messages`' `ANSWER_HELPFUL` / `ANSWER_UNHELPFUL` rows and the `AWAITING_QUESTION_TOPIC` misses are read by the monthly content review in `RUNBOOK.md` §4.7, by a human running SQL. That is a real endpoint and needs no command.

## Forward — Stage 4 must leave these open

| Owner | Thing | What Stage 4 must do |
|---|---|---|
| Stage 5 | `announcements`, `announcement_recipients` | Leave untouched. Carry `announce`/`export` in the capability table so Stage 5 adds commands only (D7, D19) |
| Stage 5 | The daily overdue digest | Read `OVERDUE_DAYS` for `/urgent`; do not push anything on a schedule. The digest is the same query with a different trigger, so `overdueCases()` is written here as a reusable query |
| Stage 5 | Retention clean-up | Do not consume `RETENTION_DAYS`. `case_notes` (D8) is a new table with teacher-adjacent content, so it must be added to the retention job's scope — recorded in the open items so Stage 5 does not miss it |
| Stage 6 | `DOC:` callback prefix, `CASE_CATEGORY.SUBMIT_DOCS` | The queue map must be **total** over `CaseCategory` today, so a document case files to a real queue the moment Stage 6 emits one |
| Stage 6 | Document cases with an unresolvable submitter | Do **not** reintroduce the `UNRESOLVED:` sentinel. `cases.teacher_chat_id` is a non-null FK with a digits check; Apps Script's sentinel cannot be stored and `hasNotifiableChatId_` (`AdminCommands.gs:652`) has no equivalent here. Commands must not carry a check for a state the schema forbids |
| Stage 7 | Launch readiness | Bootstrap SQL, two named System members, and the smoke-test steps below |

## Endpoint check — where each pipeline terminates

| Pipeline | Starts | Terminates today | Correct terminus | Closed by |
|---|---|---|---|---|
| Case | Teacher describes a problem | `cases` row | Teacher told the outcome | `/reply` `/close` `/reopen` |
| New case → work | `createCase` | **nowhere at all** (D11) | The staff who can act on it | Task 32 |
| Assignment | — | — | A named owner, notified | `/assign` |
| Urgent code | Hand-written SQL | Spent, case escalated | Issued by a person with the capability | `/generate_urgent_code` |
| Alerting | Anything that raises an Alert | Ops chat, or a log | Ops chat **and** System staff | D12 |
| Revocation | Roster edit | **nothing happens** (D17) | Access actually ends | Task 30 |
| Maintenance | — | Read by the router | Flippable by a person in seconds | `/maintenance` |
| Audit | — | Table with no writer | Rows a person can query during an investigation | D18 |
| Privilege denial | A staff command | — | A logged `STAFF_DENIED` with the caller's shape | D9 |

---

# The dependency tree

Read downward: everything above depends on everything below it. Nothing in a layer may import from a layer above it.

```
Layer 5  documentation
         BOT-SPEC §6 §7.1.1 §12 §13 · RUNBOOK Parts 3,4,6 · CONCERNS A4 B7
              │
Layer 4  seams and pipeline ends
         new-case notification ── staff fan-out alerter ── group gate
              │                          │                     │
Layer 3  commands (the thin part)
         /cases /mycases /urgent /case /search       ← case.view
         /reply /close /reopen /note                 ← case.update
         /assign                                     ← case.assign
         /generate_urgent_code                       ← urgent.issue
         /revoke                                     ← teacher.revoke
         /staff /staff_add /staff_role /staff_remove ← staff.manage
         /maintenance                                ← maintenance
         /whoami /help                               ← any active staff row
              │
Layer 2  stores (database, no Telegram)
         staff repository ── visibility predicate ── case queries
         case notes ── teacher revocation ── existing: updateCase, setSetting, recordAudit
              │
Layer 1  leaves (no database, no network)
         role ladder + capability table ── queue map ── command parser
              │
Layer 0  already built, unchanged
         chat lock · conversation state · interaction log · send · alerts · constants
```

**Legend for the gap hunt:** everything in Layers 0–2 marked *existing* is built and tested; everything else is new in this stage. There is no branch of this tree that depends on Stage 5, 6 or 7 — checked deliberately, because Stage 3's plan claimed that of itself and the dependency review refuted it.

**The one backward dependency:** `queueForCategory` must be total over `CaseCategory`, which includes `SUBMIT_DOCS`, whose only producer is Stage 6. It maps to `All` and is tested now, so Stage 6 cannot file a case into a queue nobody holds.

---

# Ripple analysis

Each chain is traced outward until nothing further moves. The last two are collisions between one chain's consequences and another's, which is the only reason they were found.

### R1 — Staff free text reaches the interaction log

`/note` and `/reply` carry free text → `routeText` logs the raw message before dispatch (`router.ts:124`) → staff have no conversation state → `redactDetail`'s default branch keeps the text → internal case content lands in `messages` → `messages` is retained on a schedule nobody has set (A10) and archived rather than deleted.
**Terminates at:** D16's prefix rule. **Test:** `/note REF secret` logs `/note REF`.

### R2 — Two staff members on one case are not serialised

The chat lock is `pg_advisory_xact_lock(hashtext(chat_id))` and the chat id for a staff command is the **staff member's**, not the teacher's → two staff acting on one case take two different locks → any read-modify-write on a case races.
**Terminates at:** every case mutation being a single statement. `updateCase` already is. `/note` must therefore be an `INSERT` (D8) rather than the read-append-write `handleNote_` performs (`AdminCommands.gs:788`), which under this locking would silently lose one of two simultaneous notes.
**Not fixed by:** locking the teacher's chat instead. That would make a staff command block behind a teacher who is mid-conversation, and would introduce a second lock taken in a different order on a different path — the deadlock recipe that D-era Stage 3 took one lock in one place to avoid.

### R3 — `/assign` can violate a foreign key

`cases.owner` references `staff.telegram_id` → assigning an id with no staff row raises a constraint error → the error propagates to `bot.catch` → the update is acknowledged and **nothing is said to anyone** → the assigner believes it worked.
**Terminates at:** validating the assignee is active staff *and* can see the case, before the write — `AdminCommands.gs:742-751` does exactly this and gives the reason: cases were "routinely assigned to typos and to people who are not admins — the case then looked handled and nobody was working it."
**Second order:** `/staff_remove` on somebody who owns open cases. `ON DELETE SET NULL` never fires because staff are deactivated, never deleted, so their cases stay assigned to an inactive person and appear in nobody's `/mycases`. The command reports the count and refuses to pretend; it does not silently unassign.

### R4 — A case nobody can see

Contact Support files under a real category → `queueForCategory` routes it → no active staff member holds that queue, or none covers the teacher's region → zero recipients → the case sits unseen.
**Terminates at:** D11's critical alert naming the category, plus `/cases unassigned` as the standing backlog view. `AdminCommands.gs:28-32` flags this as the operational consequence of queue scoping being live, and its answer was a `console.error`.

### R5 — Revoking a teacher who has open cases

`/revoke` sets `Revoked` → the teacher's open cases still exist and are still visible to staff → the teacher can no longer use Check My Case to read a `/reply` → a staff member replies to somebody who cannot receive it.
**Terminates at:** `/revoke` reporting the count of open cases, and `/reply` to a revoked teacher warning the sender that the recipient cannot see it. The message is still delivered — Telegram will accept it, the teacher just cannot use the bot — so this is a warning, not a refusal.

### R6 — Maintenance mode and in-flight conversations

`/maintenance on` → `setSetting` clears the cache immediately → the next tap of Contact Support is refused → but a teacher already in `AwaitingCaseDetail` or `AwaitingUrgentDetail` is not blocked, because the router checks maintenance at `startCase` and `chooseCaseTopic`, not at detail submission.
**Terminates at:** nothing to change. This is correct and deliberate — `handleMaintenance_`'s own message says so (`AdminCommands.gs:1401`): blocking in-flight submissions would waste a spent urgent code. The `/maintenance` confirmation must repeat it, or the first System member to use it will report the trickle of cases as a bug.

### R7 — The role rename ripples into three documents

`ReadOnly/Agent/Manager/SystemAdmin` (D7) and `/add_admin` (D14) appear in `BOT-SPEC.md` §6.1, §6.4, §6.5 and §13, in `CONCERNS-AND-IT-ACTIONS.md` A4, and in `RUNBOOK.md` Part 6.
**Terminates at:** Task 38. Uncorrected, §6.1's capability table would describe roles the code does not have — the same failure `bot_spec.md` was deleted for.

### R8 — The group gate collides with the alert channel

D15 says leave every group → `OPS_ALERT_CHAT_ID` is a group and `CONCERNS-AND-IT-ACTIONS.md` A7 instructs IT to *"create the operations group, add the bot to it"* → the bot leaves it on being added → every alarm in the system loses its destination → including the alarm that would tell somebody.
**Terminates at:** the exemption in D15, tested by a case that asserts the ops chat is never left.

### R9 — Notification volume inside the webhook

A new case notifies up to twenty staff → `deliver` sends sequentially inside the webhook request → `webhookCallback` is configured with a 25-second timeout and `onTimeout: 'return'` (`src/web/main.ts:40-44`).
**Terminates at:** the existing cap of twenty (`NEW_CASE_NOTIFY_MAX_ADMINS_`), which at Telegram's response times is a second or two. Recorded rather than changed: if the staff list ever grows past twenty, this moves to the worker, and that is the same threshold `/announce` already has to respect.

### R10 — `deliver`'s error message assumes it knows who a message is for

`bot.ts:70-77` hardcodes *"This was a notice about somebody else's action (a duplicate sign-in)"* for every message after the first → new-case notification adds a second kind of non-first message → a failed staff notification would be alerted as a duplicate sign-in.
**Terminates at:** `OutgoingMessage` carrying a short `purpose`, used in the alert text. Small, and the kind of thing that silently misleads an operator at three in the morning.

---

# File structure

## New files

| File | Responsibility |
|---|---|
| `src/staff/roles.ts` | The role ladder, the capability table, `can()`. Pure |
| `src/staff/queues.ts` | Queue vocabulary, `queueForCategory`, `categoriesVisibleTo`. Pure |
| `src/staff/repository.ts` | `findStaff`, `listStaff`, `addStaff`, `setStaffRole`, `deactivateStaff`, `countActiveSystem`, `systemStaffIds` |
| `src/staff/visibility.ts` | The one queue-AND-region SQL predicate |
| `src/cases/queries.ts` | Staff-facing case reads: list, search, one case, overdue, by owner |
| `src/cases/notes.ts` | `addNote`, `recentNotes` |
| `src/cases/notify.ts` | Who should be told about a new case, and what they are told |
| `src/telegram/commands/parse.ts` | Command word, arguments, reference validation. Pure |
| `src/telegram/commands/index.ts` | The dispatcher and the deny path |
| `src/telegram/commands/cases.ts` | `/cases` `/mycases` `/urgent` `/case` `/search` `/reply` `/close` `/reopen` `/assign` `/note` |
| `src/telegram/commands/staff.ts` | `/staff` `/staff_add` `/staff_role` `/staff_remove` `/whoami` `/revoke` |
| `src/telegram/commands/ops.ts` | `/maintenance` `/generate_urgent_code` |
| `drizzle/0006_case_notes.sql` | Generated |

Test files alongside each, following the existing `.test.ts` / `.integration.test.ts` split.

## Modified

- `src/db/schema.ts` — add `caseNotes`
- `src/telegram/router.ts` — the staff branch in `routeText`; `OutgoingMessage.purpose`
- `src/telegram/bot.ts` — private-chat gate, `my_chat_member` leave handler, generalised failure alert
- `src/telegram/alerter.ts` — System-staff fan-out
- `src/log/interactions.ts` — the `/` prefix rule (D16)
- `src/cases/service.ts` — `findCase`; `createCase` reports what notification needs
- `src/teachers/repository.ts` — roster-active re-check, `revokeTeacher`
- `src/config/constants.ts` — `STAFF_LIST_CAP`, `CASE_NOTES_SHOWN`, `URGENT_CODE_TTL_HOURS`
- `BOT-SPEC.md`, `RUNBOOK.md`, `CONCERNS-AND-IT-ACTIONS.md`

---

# Layer 1 — leaves (no database, no network)

### Task 23: The role ladder and the capability table

Implements D7. The single source of truth for authorization; `/whoami` reads the same table the gates read, so what it reports can never disagree with what is enforced.

**Files:** Create `src/staff/roles.ts`, `src/staff/roles.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe('the capability table', () => {
  it('grants every capability to System', () => {
    for (const capability of ALL_CAPABILITIES) {
      expect(can({ role: 'System', active: true }, capability)).toBe(true);
    }
  });

  it('refuses everything to a deactivated member, whatever their role', () => {
    // A deactivated System member is not a System member. This is checked here
    // rather than at the call sites so that adding a command cannot forget it.
    for (const capability of ALL_CAPABILITIES) {
      expect(can({ role: 'System', active: false }, capability)).toBe(false);
    }
  });

  it('does not let Support assign cases', () => {
    expect(can({ role: 'Support', active: true }, 'case.assign')).toBe(false);
    expect(can({ role: 'Regional', active: true }, 'case.assign')).toBe(true);
  });

  it('lets every role work a case, because there is no observer role', () => {
    // D7: ReadOnly was the fallback for a blank Tier, not a designed role.
    // If this test ever needs changing, add the enum value deliberately.
    expect(can({ role: 'Support', active: true }, 'case.update')).toBe(true);
  });

  it('names every capability in the ladder order, so /whoami can list them', () => {
    expect(capabilitiesFor('Program')).toContain('announce');
    expect(capabilitiesFor('Program')).not.toContain('staff.manage');
  });
});
```

- [ ] **Step 2: Run and watch them fail.** `npx vitest run src/staff/roles.test.ts`

- [ ] **Step 3: Implement**

```ts
/**
 * What each role may do.
 *
 * One table, read by the gates AND by /whoami, so the bot can never describe a
 * permission model different from the one it enforces — `handleWhoAmI_`
 * (AdminCommands.gs:453) records that as a deliberate property and it is worth
 * keeping.
 *
 * `announce` and `export` have no command until stage 5. They are here so that
 * stage adds a command rather than a permission model.
 */
export const CAPABILITY = {
  CASE_VIEW: 'case.view',
  CASE_UPDATE: 'case.update',
  CASE_ASSIGN: 'case.assign',
  URGENT_ISSUE: 'urgent.issue',
  TEACHER_REVOKE: 'teacher.revoke',
  STAFF_MANAGE: 'staff.manage',
  MAINTENANCE: 'maintenance',
  ANNOUNCE: 'announce',
  EXPORT: 'export',
} as const;

const GRANTS: Readonly<Record<Capability, readonly StaffRole[]>> = {
  'case.view':      ['Support', 'Regional', 'Program', 'System'],
  'case.update':    ['Support', 'Regional', 'Program', 'System'],
  'case.assign':    ['Regional', 'Program', 'System'],
  'urgent.issue':   ['Support', 'Regional', 'Program', 'System'],
  'teacher.revoke': ['Program', 'System'],
  'staff.manage':   ['System'],
  'maintenance':    ['System'],
  'announce':       ['Program', 'System'],
  'export':         ['Program', 'System'],
};
```

`can()` takes `{ role, active }` rather than a whole staff row, so it stays pure and testable, and returns false for an inactive member before consulting the table.

- [ ] **Step 4: Run until green, then commit**

```bash
git add src/staff/roles.ts src/staff/roles.test.ts
git commit -m "feat: one role ladder and one capability table, read by the gates and by /whoami"
```

---

### Task 24: The queue map, total over every case category

**Files:** Create `src/staff/queues.ts`, `src/staff/queues.test.ts`

- [ ] **Step 1: Write the test that matters most**

```ts
it('maps every case category to a queue', () => {
  // The guard against a category being added later with no queue, which would
  // route those cases to a queue nobody holds and hide them from everybody.
  for (const category of Object.values(CASE_CATEGORY)) {
    expect(QUEUE_FOR_CATEGORY[category]).toBeDefined();
  }
});

it('routes document cases to All, before stage 6 can file one', () => {
  expect(queueForCategory(CASE_CATEGORY.SUBMIT_DOCS)).toBe(QUEUE.ALL);
});

it('routes an unknown category to All rather than to nobody', () => {
  // cases.category is text, so a row written by a newer build can hold a value
  // this one does not know. Failing open is right: a case seen by too many
  // people is recoverable, a case seen by nobody is not.
  expect(queueForCategory('Something Stage 9 invented')).toBe(QUEUE.ALL);
});
```

- [ ] **Step 2: Implement, and delete seven mappings that cannot occur here**

```ts
/**
 * The queues a case can actually be routed to.
 *
 * Deliberately shorter than Apps Script's list. ADMIN_QUEUE carried
 * `Recruitment` and `Technical` as "reserved for case types the proposal
 * describes but this bot doesn't yet model" (AdminCommands.gs:53) — a queue that
 * structurally cannot match anything is a setting that looks configured and does
 * nothing, which is the failure mode this rebuild exists to remove. Add one when
 * a category needs it.
 */
export const QUEUE = {
  VISA: 'Visa',
  TRAVEL: 'Travel',
  CONTRACT: 'Contract',
  ACCOMMODATION: 'Accommodation',
  ALL: 'All',
  NONE: 'None',
} as const;
```

`queueForCategory_` also mapped the seven newer FAQ topic labels (`AdminCommands.gs:215-221`). **Those mappings are dead here by construction** and must not be ported: a case's category is a `CaseCategory`, of which there are six, because `createCase` accepts nothing else and `CASE_TOPIC_CHOICES` offers five. In Apps Script a case could be filed under an FAQ topic *label*; here it cannot.

- [ ] **Step 3: `categoriesVisibleTo(queue)`** — returns the categories a queue may see, so the visibility predicate can push the filter into SQL as `category = ANY($1)` rather than expressing the map in SQL.

- [ ] **Step 4: Run, commit**

```bash
git commit -am "feat: queue routing, total over every case category"
```

---

### Task 25: The command parser

**Files:** Create `src/telegram/commands/parse.ts`, `parse.test.ts`

- [ ] **Step 1: Tests**

```ts
it('treats the remainder as one phrase, not as words', () => {
  // /cases Under review — a status can contain a space, and splitting it would
  // make that filter silently unmatchable (AdminCommands.gs:501).
  expect(parseCommand('/cases Under review')).toEqual({ name: '/cases', rest: 'Under review' });
});

it('strips a bot mention', () => {
  expect(parseCommand('/case@MopseBot VISA-2026-00001')?.name).toBe('/case');
});

it('lowercases the command but never the arguments', () => {
  // A case reference is upper-case and a teacher's name is not ours to change.
  expect(parseCommand('/CASE Visa-2026-00001')).toEqual({ name: '/case', rest: 'Visa-2026-00001' });
});

it('returns null for text that is not a command', () => {
  expect(parseCommand('how long does a visa take')).toBeNull();
  expect(parseCommand('')).toBeNull();
});

it('splits a reference from a message without losing internal spacing', () => {
  expect(splitReference('VISA-2026-00001  we have  emailed you')).toEqual({
    reference: 'VISA-2026-00001',
    rest: 'we have  emailed you',
  });
});
```

- [ ] **Step 2: Implement.** No database, no Telegram, no knowledge of who is allowed to do what.

- [ ] **Step 3: Commit**

---

# Layer 2 — stores (database, no Telegram)

### Task 26: The staff repository

**Files:** Create `src/staff/repository.ts`, `repository.integration.test.ts`

- [ ] **Step 1: Tests**

```ts
it('does not return a deactivated member from the authorization lookup', async () => {
  // findStaff is the gate. findAnyStaff is for management commands, which must
  // still be able to address a deactivated row or /staff_remove is irreversible
  // from inside the bot (AdminCommands.gs:1160).
  await deactivateStaff(db, ID, ACTOR);
  expect(await findStaff(db, ID)).toBeNull();
  expect(await findAnyStaff(db, ID)).not.toBeNull();
});

it('refuses to add somebody who already has a row', async () => {
  // /add_admin used to upsert, and its defaulting fourth argument stripped
  // IS_SYSTEM_ADMIN from existing rows — including the caller's own
  // (AdminCommands.gs:1089). Adding is adding.
});

it('reactivates a deactivated member when their role is set', async () => {
  // The one obvious way back from /staff_remove.
});

it('counts only active System members', async () => { /* … */ });
```

- [ ] **Step 2: Implement.** `addStaff` requires an explicit role and queue — no defaults. The schema defaults `queue` to `'All'` and `role` to `'Support'` for migration safety; a command that lets somebody omit them grants more than the caller meant to.

- [ ] **Step 3: Commit**

---

### Task 27: The visibility predicate

Implements D10. The one place queue and region are ever combined.

**Files:** Create `src/staff/visibility.ts`, `visibility.integration.test.ts`

- [ ] **Step 1: Write the two tests that are easiest to get wrong**

```ts
it('does not hide a case whose teacher has no region', async () => {
  // adminCoversRegion_ returns true for a falsy region (AdminCommands.gs:236).
  // Without this a teacher whose roster row has no region files cases that no
  // region-scoped staff member can see, and nobody finds out.
  await bindTeacherWithRegion(null);
  const rows = await visibleCases(db, { role: 'Support', queue: 'All', regions: ['tashkent'] });
  expect(rows.map((r) => r.reference)).toContain(reference);
});

it('treats an empty regions array as every region', async () => {
  // schema.ts:281 — the default, chosen so the column could not narrow access.
});

it('shows a System member everything, whatever their queue says', async () => { /* … */ });

it('hides a Visa case from an Accommodation queue', async () => { /* … */ });

it('compares regions without case sensitivity', async () => {
  // The roster is typed by hand. "Tashkent" and "tashkent" are one place.
});
```

- [ ] **Step 2: Implement as a fragment, not a function that fetches**

```ts
/**
 * The single visibility rule: queue AND region must both permit it.
 *
 * A SQL fragment rather than a filter over fetched rows, which is what
 * adminCanSeeCase_ had to be. That forced caseRegionMap_ to exist, whose own
 * comment says the memoisation is "not an optimisation — it is a correctness
 * requirement" against the execution limit; the whole apparatus is an artefact
 * of not having a join. It also means LIMIT can be pushed into the query rather
 * than applied after fetching every case in order to display twenty.
 */
export function visibleToStaff(staff: StaffScope): SQL {
  if (staff.role === 'System') return sql`true`;
  const categories = categoriesVisibleTo(staff.queue);
  return sql`
    cases.category = ANY(${categories})
    AND (
      cardinality(${staff.regions}::text[]) = 0
      OR teachers.region IS NULL
      OR lower(teachers.region) = ANY(SELECT lower(r) FROM unnest(${staff.regions}::text[]) AS r)
    )
  `;
}
```

Every caller joins `teachers` on `cases.teacher_chat_id`. The join is inner, which is safe: `teacher_chat_id` is a non-null foreign key.

- [ ] **Step 3: Run, commit**

---

### Task 28: Staff-facing case queries

**Files:** Create `src/cases/queries.ts`, `queries.integration.test.ts`

- [ ] **Step 1: The query set**

`listCases({ openOnly | status | unassigned })`, `casesOwnedBy(chatId)`, `escalatedAndOverdue(overdueDays)`, `searchCases(term)`, `findCase(reference)` — each taking the staff scope and applying `visibleToStaff`.

- [ ] **Step 2: Tests**

```ts
it('lists open cases only, by default', async () => {
  // /cases previously listed closed and completed ones too, which buried the
  // actionable work (AdminCommands.gs:493).
});

it('caps at twenty and says how many more there are', async () => { /* … */ });

it('searches the detail, which is exactly why /search needs the visibility rule', async () => {
  // The teacher's own words are searchable by staff who can see the case, and
  // by nobody else. This is the query with the largest exposure surface here.
});

it('omits overdue cases entirely when OVERDUE_DAYS is unset', async () => {
  // Rather than inventing an SLA. AdminCommands.gs:551 — the command says so.
});

it('orders by created_at descending, so the newest work is at the top', async () => { /* … */ });
```

- [ ] **Step 3: Commit**

---

### Task 29: Case notes

Implements D8.

**Files:** Modify `src/db/schema.ts`; create `src/cases/notes.ts`, `notes.integration.test.ts`; generate `drizzle/0006_case_notes.sql`

- [ ] **Step 1: The table**

```ts
/**
 * Staff notes on a case — internal, never shown to a teacher.
 *
 * Its own table rather than an append to `cases.detail`, which is the teacher's
 * own words at the moment they filed and which `CaseFields` deliberately cannot
 * reach. Apps Script appended notes into that same cell (AdminCommands.gs:788),
 * which is why reading a case could outgrow Telegram's message limit and why
 * "who wrote this" was a string somebody would eventually have to parse.
 *
 * An INSERT rather than a read-append-write, which also settles the concurrency
 * question: two staff members writing at the same moment take different chat
 * locks, so anything read-modify-write on a case would lose one of the two.
 */
export const caseNotes = pgTable(
  'case_notes',
  {
    id: text('id').primaryKey().default(sql`gen_random_uuid()`),
    caseReference: text('case_reference')
      .notNull()
      .references(() => cases.reference, { onDelete: 'cascade' }),
    author: chatId('author').notNull(),
    note: text('note').notNull(),
    at: tsz('at').notNull().defaultNow(),
  },
  (t) => [index('case_notes_case_idx').on(t.caseReference, t.at)],
);
```

`ON DELETE CASCADE` here, unlike everywhere else in this schema: a note about a case that no longer exists is not a record worth keeping, and the retention job (Stage 5) must be able to remove a case without tripping over its notes.

- [ ] **Step 2: Test that two concurrent notes both survive**

```ts
it('keeps both notes when two staff write at the same moment', async () => {
  await Promise.all([addNote(db, ref, 'A', '111'), addNote(db, ref, 'B', '222')]);
  expect(await recentNotes(db, ref)).toHaveLength(2);
});
```

- [ ] **Step 3: Generate the migration, run, commit**

```bash
npx drizzle-kit generate --name=case_notes
```

Expected: `CREATE TABLE` and one index. No alterations to existing tables — the additive property that makes rollback code-only must hold.

---

### Task 30: Teacher revocation, both halves

Implements D17. **This closes a live gap between the documentation and the code.**

**Files:** Modify `src/teachers/repository.ts`, `src/cases/service.ts`; tests

- [ ] **Step 1: Write the test that proves the current behaviour is wrong**

```ts
it('refuses a gated action once the roster row is deactivated', async () => {
  // RUNBOOK 4.3 tells an operator this already works: "Set their roster row
  // inactive... it takes effect on their next message." It does not. roster
  // .active is read only by verifyIdentifier, and a teacher who has already
  // signed in never signs in again — so today they keep full access for ever.
  await verifyTeacher(db, CHAT, IDENTIFIER);
  await deactivateRosterRow(db, IDENTIFIER);
  await expect(createCase(db, { chatId: CHAT, category: 'Visa', detail: 'x' }))
    .rejects.toBeInstanceOf(TeacherNotVerifiedError);
});

it('refuses a gated action for a teacher whose access was revoked by command', async () => { /* … */ });

it('still lets a revoked teacher read the FAQ', async () => {
  // Browsing is open to anyone and revocation is not a punishment. It ends
  // their ability to open cases, not their ability to read public information.
});
```

- [ ] **Step 2: Make the eligibility check one query**

`findTeacher` gains the roster join and returns an `eligible` flag — `verificationState = 'Verified'` AND `revoked_at IS NULL` AND the roster row is active. One query, not three, and one place, so a future caller cannot check two of the three.

- [ ] **Step 3: `revokeTeacher(db, chatId, actor)`** — writes `verification_state = 'Revoked'`, `revoked_at = now()`, `revoked_by = actor`, and returns the count of the teacher's open cases for R5.

- [ ] **Step 4: Run the whole suite.** This changes a check every gated path runs; the Stage 3 router tests are the ones that will catch a mistake.

- [ ] **Step 5: Commit**

```bash
git commit -am "fix: deactivating a roster row now actually revokes access"
```

---

# Layer 3 — commands

### Task 31: The dispatcher, the deny path, and `/whoami`

Implements D9.

**Files:** Create `src/telegram/commands/index.ts`, `staff.ts`; modify `src/telegram/router.ts`

- [ ] **Step 1: Wire it into `routeText`, in this order**

```ts
  if (text === '/start') { /* … existing … */ }
  if (text === '/privacy') return only(update.chatId, privacyReply(deps.supportContact));
  if (text === '/help') return only(update.chatId, await helpReply(db, update.chatId, deps));

  /**
   * Staff commands, before the teacher state machine.
   *
   * A staff member part-way through their own case must still be able to run
   * /close, for the same reason a teacher mid-case must still be able to reach
   * /help. Returns null when the text is not a command word at all, and also
   * when the sender is not staff — D9: the denial is logged, and the message
   * falls through to ordinary handling rather than being answered with a
   * rejection that both confirms the command exists and discards what they
   * typed.
   */
  const staffOutcome = await routeStaffCommand(db, update.chatId, text, deps);
  if (staffOutcome !== null) return staffOutcome;
```

- [ ] **Step 2: Tests**

```ts
it('lets a teacher describing a case type something starting with a slash', async () => {
  // The fall-through in D9. Under the Apps Script rule this teacher lost their
  // case detail and was told they are not an admin.
  await saveState(db, CHAT, { kind: 'AwaitingCaseDetail', category: 'Visa', attempts: 0 });
  const outcome = await route(db, { chatId: CHAT, kind: 'text', text: '/closed the door on my flat' }, deps);
  expect(outcome.messages[0]?.text).toMatch(/VISA-2026-/);
});

it('logs a denial with the caller shape when a non-staff chat uses a command', async () => {
  // §13: every authorization denial leaves a trace, so privilege probing does.
  await route(db, { chatId: STRANGER, kind: 'text', text: '/staff' }, deps);
  expect(await lastAction(db, STRANGER)).toBe('STAFF_DENIED');
});

it('does not tell a stranger that the command exists', async () => {
  const outcome = await route(db, { chatId: STRANGER, kind: 'text', text: '/staff' }, deps);
  expect(outcome.messages[0]?.text).not.toMatch(/staff|admin|permission/i);
});
```

- [ ] **Step 3: `/whoami`** — reads `capabilitiesFor(role)` from Task 23 and lists them, plus the member's queue and regions. `/help` appends the command list for a staff sender only, so a teacher never sees commands they cannot use (`Webhook.gs:249`).

- [ ] **Step 4: Commit**

---

### Task 32: New-case notification

Implements D11. Closes the largest missing endpoint in the system.

**Files:** Create `src/cases/notify.ts`, `notify.integration.test.ts`; modify `src/telegram/router.ts`

- [ ] **Step 1: Tests first**

```ts
it('tells the staff who can see the case, and nobody else', async () => { /* … */ });

it('never includes the case detail', async () => {
  // A teacher's free text is not copied into N Telegram histories
  // (AdminCommands.gs:325). Admins read it with /case.
  const messages = await notificationsFor(db, reference);
  expect(messages.every((m) => !m.text.includes(DETAIL))).toBe(true);
});

it('raises a critical alert when nobody is authorised', async () => {
  // Apps Script logged this and returned; the case then sat unseen with the
  // only trace in a log nobody opens.
  const outcome = await fileCaseWithNoMatchingStaff();
  expect(outcome.alerts[0]?.severity).toBe('critical');
  expect(outcome.alerts[0]?.body).toContain('Accommodation');
});

it('notifies on an urgent escalation of an existing case, not only on a new one', async () => {
  // The dedup path. urgent+deduplicated is the common path, not an edge case.
});

it('caps recipients at twenty', async () => { /* R9 */ });
```

- [ ] **Step 2: Implement as a returned message list**, computed inside the transaction, delivered after the commit. Carries the reference, category, time in Tashkent, and ready-to-tap `/case` and `/assign` lines.

- [ ] **Step 3: Log it** as `STAFF_NOTIFIED_NEW` / `STAFF_NOTIFIED_URGENT` with chat id `SYSTEM` and a delivered/total count — `'SYSTEM'` because `src/db/schema.ts:459` reserves it for bot-initiated events, so a case reference never lands in the chat id column.

- [ ] **Step 4: Commit**

---

### Task 33: Case reading — `/cases` `/mycases` `/urgent` `/case` `/search`

**Files:** Create `src/telegram/commands/cases.ts` and its test

- [ ] **Step 1: Tests**, including `/case` showing the last few notes and the count of the rest, and `/cases unassigned` as the intake backlog.

- [ ] **Step 2: Implement.** Every one takes the staff scope from the dispatcher; none of them re-derives visibility.

- [ ] **Step 3: Commit**

---

### Task 34: Case mutation — `/reply` `/close` `/reopen` `/note`

**Files:** Modify `src/telegram/commands/cases.ts`

- [ ] **Step 1: The tests that encode the two rules**

```ts
it('commits the case update before messaging the teacher', async () => {
  // The same rule as everywhere else: a send that fails after a good commit is
  // recoverable and alerts; a commit that fails after the teacher has been told
  // is not recoverable by anything.
});

it('tells the sender when the teacher cannot receive it', async () => {
  // R5. A revoked teacher can be messaged but cannot use the bot, so /reply
  // must warn rather than refuse.
});

it('never writes a note where the teacher can read it', async () => {
  const visible = await getCasesForChatId(db, CHAT);
  expect(JSON.stringify(visible)).not.toContain(NOTE_TEXT);
});

it('sets closed_at when a case is closed, and clears nothing when it is reopened', async () => { /* … */ });
```

- [ ] **Step 2: Implement** through `updateCase` and `addNote` only. Nothing here writes to `cases` directly — that is the point of the single write path (`src/cases/service.ts:1-14`).

- [ ] **Step 3: Commit**

---

### Task 35: `/assign`

Implements R3.

**Files:** Modify `src/telegram/commands/cases.ts`

- [ ] **Step 1: Tests**

```ts
it('refuses an assignee who is not active staff, before touching the case', async () => {
  // cases.owner is a foreign key. Writing an unknown id raises a constraint
  // error, which reaches bot.catch, which says nothing at all — so the
  // assigner believes it worked and nobody is working the case.
});

it('refuses an assignee who could not see the case', async () => {
  // Assigning into a queue the assignee does not hold makes the case look
  // handled while being invisible to the person it was handed to.
});

it('reports back when the assignee could not be notified', async () => { /* … */ });
```

- [ ] **Step 2: Implement. Step 3: Commit**

---

### Task 36: Staff management — `/staff` `/staff_add` `/staff_role` `/staff_remove` `/revoke`

Implements D14, D18 and the second half of D17.

**Files:** Modify `src/telegram/commands/staff.ts`

- [ ] **Step 1: The refusals, tested first**

```ts
it('refuses to deactivate the last active System member', async () => {
  // D13: the only recovery is another trip to the database.
});

it('refuses self-deactivation', async () => { /* AdminCommands.gs:1209 */ });

it('reports open cases owned by somebody being deactivated, and leaves them assigned', async () => {
  // R3, second order. Silently unassigning would lose the only record of who
  // was working them.
});

it('writes an audit row in the same transaction as the grant', async () => {
  // D18. src/log/audit.ts propagates its errors on purpose: a grant that
  // cannot be recorded should not happen.
});

it('notifies the person whose access changed', async () => { /* … */ });
```

- [ ] **Step 2: Implement.** `/staff_add` adds only — an existing target is refused and pointed at `/staff_role`. Role and queue are required arguments, not defaulted.

- [ ] **Step 3: Commit**

---

### Task 37: `/maintenance` and `/generate_urgent_code`

**Files:** Create `src/telegram/commands/ops.ts` and its test

- [ ] **Step 1: `/maintenance on|off`** through `setSetting`, which clears the cache. The confirmation must state R6 plainly — in-flight submissions still complete, so a trickle of cases for a few hours is correct behaviour and not a bug.

- [ ] **Step 2: `/generate_urgent_code`**

```ts
it('issues a code that the teacher flow will accept', async () => {
  // The two halves have never met: codes have only ever been inserted by hand
  // (RUNBOOK 4.4). This test drives the issuing command and then the teacher
  // path, end to end, which is the only way to prove the formats agree.
});

it('records who issued it', async () => {
  // urgent_codes.issued_by is notNull and has held '0' for every hand-issued
  // code. The stranded-code alarm names the issuer; '0' names nobody.
});
```

Six characters, upper case, from a cryptographic source rather than a UUID slice. `URGENT_CODE_TTL_HOURS = 48`, moved into `constants.ts` with its provenance (`AdminCommands.gs:77`).

- [ ] **Step 3: Commit**

---

# Layer 4 — seams

### Task 38: The group gate

Implements D15 and R8. **A control the specification lists as shipped and which does not exist.**

**Files:** Modify `src/telegram/bot.ts`; test

- [ ] **Step 1: Tests**

```ts
it('ignores a message from a group', async () => { /* … */ });

it('leaves a group it is added to', async () => { /* … */ });

it('never leaves the operations chat', async () => {
  // R8. The ops chat is a group and CONCERNS A7 instructs IT to add the bot to
  // it. A naive "leave every group" makes the bot leave the channel every alarm
  // in this system depends on — including the alarm that would report it.
});
```

- [ ] **Step 2: Implement** as a gate before `run`, plus a `my_chat_member` handler. The gate is in `bot.ts` rather than the router because a non-private update should not consume an update claim or take a chat lock.

- [ ] **Step 3: Commit**

---

### Task 39: The staff fan-out alerter, and honest delivery failures

Implements D12 and R10.

**Files:** Modify `src/telegram/alerter.ts`, `src/telegram/router.ts`, `src/telegram/bot.ts`

- [ ] **Step 1: Fan out to System staff in addition to `OPS_ALERT_CHAT_ID`**, never instead of it. `trySend`, not `send` — a failure to deliver an alarm must not abort the operation that raised it.

- [ ] **Step 2: Give `OutgoingMessage` a `purpose`** and use it in `deliver`'s failure alert, which currently describes every non-first message as a duplicate sign-in.

- [ ] **Step 3: Test that an empty staff table still alerts** — the bootstrap case, and the case where the staff table is the thing that is wrong.

- [ ] **Step 4: Commit**

---

### Task 40: The interaction-log rule for commands

Implements D16 and R1.

**Files:** Modify `src/log/interactions.ts`, `interactions.test.ts`

- [ ] **Step 1: Tests**

```ts
it('logs a command and its first argument, and nothing else', () => {
  expect(redactDetail('/note VISA-2026-00001 she is still waiting on the embassy', null))
    .toBe('/note VISA-2026-00001');
});

it('applies to a command this build has never heard of', () => {
  // Stage 5 adds /announce ALL <message to 1,800 teachers>. The rule is on the
  // prefix, not on a list, so it covers that the day it is written.
  expect(redactDetail('/announce ALL the airport transfer has moved', null)).toBe('/announce ALL');
});

it('leaves an ordinary question alone', () => {
  // An unanswered question is the most valuable content signal there is.
  expect(redactDetail('how long does a visa take', null)).toBe('how long does a visa take');
});
```

- [ ] **Step 2: Implement inside `redactDetail`**, not at the call sites — the existing comment gives the reason and it has not changed: a parameter is a thing a caller forgets.

- [ ] **Step 3: Commit**

---

# Layer 5 — documentation

### Task 41: Correct every document this stage makes wrong

Not optional, and larger than Stage 3's equivalent because this stage corrects two documented behaviours that were never true.

- [ ] **Step 1: `BOT-SPEC.md`**
  - §6.1 — the capability table, re-expressed against `Support/Regional/Program/System` (D7)
  - §6.4, §6.5 — command names (D14), the nineteen becoming eighteen plus two deferred (D19)
  - §6.2 — queue and region as one SQL predicate; the seven FAQ-topic mappings deleted as structurally impossible (Task 24)
  - §5.1 — **correct the revocation claim** (D17)
  - §7.1.1 — notification, now built
  - §8.1.1, §13 — the group gate, now true
  - §16 — move `/announce` and `/export` into the deferred list with D19's reasoning

- [ ] **Step 2: `RUNBOOK.md`**
  - §1.2 — the launch gate moves: the staff half exists
  - §2.4 — `/maintenance` replaces the SQL
  - **new §2.5** — bootstrapping the first System member (D13)
  - §4.3 — **rewrite.** It currently describes revocation that does not happen
  - §4.4 — `/generate_urgent_code` replaces the hand-written `INSERT`
  - §4.5 — `/maintenance on`
  - Part 3 — smoke-test steps below
  - Part 6 — what is left is Stage 5 and 6 only

- [ ] **Step 3: `CONCERNS-AND-IT-ACTIONS.md`**
  - A2 — correct the revocation sentence
  - A4 — two System members, now with the commands to manage them
  - A7 — close the "left for you" half; the ops chat is still required (D12)
  - B3 — unchanged, re-pointed at Stage 5
  - **new B11** — no observer role (D7's consequence), cheapest to fix before launch

- [ ] **Step 4: Commit**

---

## Deploy-day checklist

Unchanged in shape from Stage 3 — migrate before serving, always — with four additions.

```bash
docker compose build web worker
docker compose stop web worker
docker compose run --rm --no-deps web node dist/db/migrate.js
docker compose up -d worker
docker compose up -d web
```

**Rollback stays code-only.** `drizzle/0006` adds one table and one index and alters nothing, so the previous image still runs against the new schema. Prove it on deploy day, before any teacher is served, by booting the previous image against the new schema.

**1. Seed the first System member, before anything else.** There is no command for this and there is not meant to be (D13):

```sql
INSERT INTO staff (telegram_id, name, role, queue, added_by)
VALUES ('<their telegram id>', '<their name>', 'System', 'All', '0')
ON CONFLICT (telegram_id) DO NOTHING;
```

Then add the second one with `/staff_add`, from the first one's account. Two named System members is already a launch-checklist item (`RUNBOOK.md` §1.4) and the reason is now sharper: `/staff_remove` refuses to deactivate the last one, so recovering from a single lost account means another trip to the database.

**2. Check the ops chat survived.** The group gate leaves groups (D15). Immediately after deploying, confirm the bot is still in the operations chat and that an alarm still arrives — R8 is the collision most likely to be discovered at the worst moment.

**3. Smoke-test additions**, appended to `RUNBOOK.md` Part 3. The three that matter most, because each proves a pipeline that has never had both ends:

1. **A case reaches a person.** File a case from the teacher account. A staff member holding that queue and region must receive the notification, and it must not contain what the teacher typed.
2. **A reply reaches the teacher.** `/reply <ref> <message>`, then Check My Case from the teacher account. The public update is there; the internal note from `/note` is not.
3. **A code issued by command is spent by a teacher.** `/generate_urgent_code`, give the code to the test account, file an urgent case. `used_at`, `used_by` and `case_reference` are all set, and `issued_by` names a real person rather than `'0'`.

**4. Revocation now bites.** After the deploy, deactivating a roster row ends that teacher's access on their next message (D17). Anyone who deactivated rows expecting today's no-op behaviour should be told before the deploy, not after.

---

## Open items this plan deliberately does not close

- **There is no observer role.** D7 removed `ReadOnly` because it was a migration fallback rather than a designed role, but the consequence is real: sight of cases now comes with the ability to change them. One enum value and one row if MoPSE wants a ministry observer, and cheapest before launch.
- **`audit_log` has no reader.** By decision (D18). It is queried during an investigation by somebody with database access, and a command to read it would need a permission model to stop it becoming the thing it audits.
- **`case_notes` is new content with no retention rule.** It holds staff writing about teachers and is covered by the same unset `RETENTION_DAYS` as everything else (A10). Stage 5's clean-up job must include it; the `ON DELETE CASCADE` on the case is what makes that possible.
- **Announcements and export remain absent** (D19), and `CONCERNS-AND-IT-ACTIONS.md` B3 stays open until Stage 5.
- **The overdue digest is not pushed.** `/urgent` reads `OVERDUE_DAYS`, but nothing arrives unasked until Stage 5. `overdueCases()` is written here so that stage adds a schedule, not a query.
- **Staff notification volume is bounded at twenty** (R9). Past that it belongs in the worker, which is the same threshold `/announce` will have to respect.
- **`RETENTION_DAYS` is still unset, and erasure is still blocked by the database.** Unchanged from Stage 3, and now with more tables holding more content.
