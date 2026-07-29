# Stage 4 Implementation Plan — Staff

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the loop. A teacher can file a case today and nobody can answer it — every staff-facing pipeline in this system currently terminates in the database. Stage 4 gives each one its endpoint: a person who can see the case, act on it, and have the teacher told.

**Architecture:** Built leaves-first, as Stage 3 was. Two pure modules (the role ladder, the queue map) hold every authorization decision; one SQL predicate holds every visibility decision; the commands are thin. Staff commands run *inside* the existing update pipeline rather than beside it, so they inherit the update claim, the chat lock and the interaction log.

**Tech Stack:** Unchanged — TypeScript on Node 22, grammY, PostgreSQL 17 via Drizzle, graphile-worker, Vitest.

**Baseline:** 332 tests, 24 files, typecheck and build clean, at `d743d72`.

---

## ▶ Where this stands — 29 July 2026, third session

**Layers 1 and 2 are complete. Layer 3 is eight tasks of nine done: 31, 32, 33, 34, 35, 45 and 46.**

`694 tests across 42 files, none skipped. Typecheck, build and deps:check clean.` Every number in this section was verified by a full run against a live database, not inferred.

| Task | What | State |
|---|---|---|
| 23 | Role ladder + capability table | ✅ `src/staff/roles.ts` |
| 24 | Queue map, total over every category | ✅ `src/staff/queues.ts` |
| 25 | Command parser | ✅ `src/telegram/commands/parse.ts` |
| 42 | The migration | ✅ `drizzle/0006_notes_regions_importance.sql`, applied and verified |
| 26 | Staff repository | ✅ `src/staff/repository.ts` |
| 43 | Region resolution | ✅ `src/teachers/region.ts` |
| 27 | Visibility predicate | ✅ `src/staff/visibility.ts` |
| 28 | Staff case queries | ✅ `src/cases/queries.ts` |
| 29 | Case notes | ✅ `src/cases/notes.ts` |
| 44 | Importance, due dates, snoozes | ✅ `src/cases/importance.ts` + `service.ts` |
| 30 | Teacher revocation, both halves | ✅ `repository.ts` + the gate in `router.ts` |
| 40 | The `/` prefix log rule | ✅ done early, `src/log/interactions.ts` |
| R10 | `OutgoingMessage.purpose` | ✅ **pulled forward from Task 39** — see R10 |
| 31 | Dispatcher, deny path, `/whoami` | ✅ `src/telegram/commands/{index,context,staff}.ts` |
| 32 | New-case notification | ✅ `src/cases/notify.ts`, wired into both filing paths |
| 33 | Case reading — `/cases` `/mycases` `/urgent` `/case` `/search` | ✅ `src/telegram/commands/cases.ts`, plus the status vocabulary in `src/cases/status.ts` |
| 34 | Case mutation — `/reply` `/await` `/close` `/reopen` `/note` | ✅ same file; fixed `updateCase` leaving a stale `closed_at` on reopen |
| 35 | `/assign` | ✅ same file; both R3 checks before the write, plus a `CASE_ASSIGNED` audit row |
| 45 | `/region` `/regions` `/mark` `/due` `/snooze` | ✅ `cases.ts` + `staff.ts`; `/region` checks **both ends** of the move, and refuses a region the system has never heard of |
| 46 | Asking the teacher about their region | ✅ `router.ts` + `keyboards.ts` + `handlers/menu.ts`; needed **a second migration**, `0007_region_asked_at.sql` |
| **36–39, 41** | **The rest of layer 3, and layers 4–5** | ⬜ **not started** |

**All four audit faults are now closed.** Revocation revokes, a corrected region reaches the visibility rule, the staff table has a reader and a writer, and — as of Task 32 — a case that is filed reaches the people who can work it. `Received` has a writer for the first time, and a case nobody can act on raises a critical alert instead of sitting unseen.

**Next is Task 36**, staff management — `/staff` `/staff_add` `/staff_role` `/staff_remove` `/revoke` `/restore`. It is the last of layer 3, and it is where D13's "refuse to deactivate the last active System member" and D27's `/restore` land.

**What the last two tasks changed outside their own files** — departures 13 to 20, and none of them optional to know: the case-status vocabulary was collapsed into one list; `/case` bounds its own output because `send.ts` does not split messages; `updateCase` now clears `closed_at` when a case leaves a terminal status, which was a live fault against D28's retention; `StaffCaseRow` carries where a region came from; `listRegionFlags` takes a region scope; and `knownRegions` and `clearSnooze` are new.

**All three remaining questions were answered on 29 July** and are recorded as **D26** (`Action required` means the teacher must act, and `Closed` gets a writer), **D27** (`/restore`, added to Task 36) and **D28** (retention: unresolved cases kept indefinitely, resolved ones 7 days, urgent and critical 6 months, the interaction log 3 days). No question in this plan is open.

**Nothing is open.** Both follow-ups were answered the same day: `/close <ref> unresolved <reason>` exists, with the reason as required free text written to a case note (D26); and the three retention periods are **settings**, which makes rendering the privacy notice from those settings mandatory rather than optional (D28).

**Read `docs/plans/2026-07-29-stage-4-handoff.md` before starting.** It records what is built, what is deliberately different from this plan, and the three open questions.

---

## What this stage is not

`/announce` and `/export` are **Stage 5**, with the announcement tables that already exist for them. Both are bulk egress, both need a fan-out-and-report mechanism this stage does not build, and `/export` additionally needs a document-sending path that `src/telegram/send.ts` does not have. `BOT-SPEC.md` §6.5 lists them among the nineteen commands; they are deferred here deliberately, not overlooked. See D19.

---

# Decisions recorded

Continuing D1–D6 from the Stage 3 plan. These were open questions; they are settled here, with the reasoning, so they stay decisions rather than becoming accidents.

### D7 — A five-rank ladder, with a deliberate observer at the bottom

**Revised 29 July** after the design session. The original decision carried Apps Script's four working ranks and no observer; the head of project asked for one, and named a real use — senior ministry staff, auditors, and new hires in their first week.

**Decision:** Authorization uses `staff_role` as `src/db/schema.ts:85` defines it, ranked by index in `STAFF_ROLE_ORDER`, with **one value added below `Support`** and **one renamed**: `Observer < Support < Lead < Program < System`. The capability table from `BOT-SPEC.md` §6.1 is re-expressed against these names.

**Settled 29 July, by the head of project.** The observer rank is called `Observer` — "Jstaff" was considered and dropped, because the word says what the person can do to anyone who reads it, including the auditors and first-week hires it exists for. And the rank formerly called `Regional` is renamed **`Lead`**, for the reason set out below. Both were free to change at the moment they were answered: the `staff` table has never held a row. Neither is free now, and Task 42 is where they become permanent.

**Why an observer, when Apps Script's `ReadOnly` is not being carried over:** they are not the same thing. `roleForAdmin_` (`AdminCommands.gs:185-193`) returned `ReadOnly` when `ROLE` was blank *and* the row was not a System Admin *and* the Tier matched none of three known values — the "we do not know what this row is" bucket, produced by a migration fallback for spreadsheet rows written before the column existed. That bucket has nothing to hold here, because every `staff` row is created by a command requiring an explicit rank. An observer chosen on purpose is a different object with the same permissions, and it is added because somebody asked for it rather than because a fallback needed somewhere to land.

The table, which becomes the single source of truth in `src/staff/roles.ts`:

| Capability | Observer | Support | Lead | Program | System |
|---|---|---|---|---|---|
| `case.view` — `/cases` `/mycases` `/urgent` `/case` `/search` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `case.update` — `/reply` `/await` `/close` `/reopen` `/note` | | ✅ | ✅ | ✅ | ✅ |
| `case.mark` — `/mark` (D22) | | ✅ | ✅ | ✅ | ✅ |
| `case.assign` — `/assign` | | | ✅ | ✅ | ✅ |
| `urgent.issue` — `/generate_urgent_code` | | ✅ | ✅ | ✅ | ✅ |
| `teacher.region` — `/region` (D20) | | | ✅ | ✅ | ✅ |
| `teacher.revoke` — `/revoke` | | | | ✅ | ✅ |
| `staff.manage` — `/staff` `/staff_add` `/staff_role` `/staff_remove` | | | | | ✅ |
| `maintenance` — `/maintenance` | | | | | ✅ |
| `announce`, `export` | | | | ✅ | ✅ |

**The rank formerly named `Regional` had nothing to do with regions**, and region is a separate setting on every row. A MoPSE "regional admin" is usually `Support` rank with a region set — which is to say, a regional admin did not hold the rank called Regional, and the rank called Regional did not imply a region. One word meant two unrelated things, in a system where getting the two confused is how the old bot ended up making everybody a full administrator.

**Settled: the rank is `Lead`.** Region stays the separate setting it always was. The teacher-facing phrase "Regional admin" — in `src/cases/urgent.ts`, `src/telegram/handlers/urgent.ts` and `RUNBOOK.md` — is MoPSE's job title for a person and is **left exactly as it is**; it was never the enum, and disentangling the two is the entire point of the rename.

`announce` and `export` are in the table but have no command in this stage. They are listed so Stage 5 adds a command rather than a permission model, and so `/whoami` — which reads this table — does not have to change twice.

A System member bypasses every capability, queue and region check, exactly as `adminCanSeeCase_` does (`AdminCommands.gs:290-294`).

**Consequence of the observer, which is where it will go wrong if it goes wrong:** `case.view` is not the same question as "should this person be told when a case arrives". An observer who receives a notification for every new case is being paged about work they cannot do. New-case notification therefore filters on `case.update`, not on `case.view` — see R14. Apps Script filtered on visibility alone (`AdminCommands.gs:353`), which was correct there only because its `ReadOnly` bucket was almost always empty.

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

*D20–D24 were added on 29 July, from the design session recorded in `2026-07-29-staff-and-lifecycle-design.md`.*

### D20 — A region correction lives in the database and never goes back to the spreadsheet

**Decision:** `teachers` gains `region_override text` and `region_set_by`/`region_set_at`. A new function `regionFor(teacher)` returns `region_override ?? roster_entries.region` — the roster read **live through a join**, not the `teachers.region` copy taken at sign-in — and **every** region read goes through it. `/region <chat_id> <region>` at `Lead` rank and above is the only writer.

**Why not write to the sheet:** the bot holds Viewer access to one spreadsheet, and `CONCERNS-AND-IT-ACTIONS.md` A8 is about read access to that document already being broader than anyone would like. Writing needs Editor, which is edit power over the tab holding the confidential answer bank. It would also reverse the one-way flow that `src/db/schema.ts:10-17` states as the ownership rule — the sheet owns what the bot reads, the database owns what the bot writes — and two writable copies of one fact is an argument waiting for the worst possible moment.

**Precedence, stated once so it is never re-derived:** an explicit decision by a named person beats an import. The override wins whenever it is set; clearing it (`/region <chat_id> clear`) returns the teacher to whatever the roster says, which is also the recovery path from a mistyped region.

**The function this breaks, and it is not obvious.** `bindTeacher` (`src/teachers/repository.ts:119`) upserts with `onConflictDoUpdate` and its `set` object includes `region`. A teacher who signs in again — a new phone, the commonest legitimate reason — would have their staff-set region silently overwritten by the roster's. The override column must be absent from that `set`, with a test that re-verifies a teacher and asserts the override survives. See R11.

### D21 — The teacher confirms their region; only staff change it

**Decision:** the bot shows the region it holds and asks whether it is still right. "No" writes nothing — it raises a flag that whoever holds `teacher.region` (`Lead` and above) can see and act on. Staff make the change through D20.

**Why not a picker:** region decides who sees a teacher's case. A menu of regions is a menu of "who gets my problem", and a wrong tap routes an emergency to the wrong province. The teacher is the best source of the *signal* and the worst source of the *record*.

**Why not on every conversation:** there is no session to attach it to — the bot has no login, only messages and a thirty-minute conversation state. "Every new session" becomes "most times they come back", which for 1,800 people is a question tapped through unread, filling the field that routes emergencies with noise.

**Split across stages, deliberately.** Stage 4 builds the staff-facing half: the flag, and `/region`. The teacher-facing prompt is Task 45 and is the one piece of teacher-visible change in this stage — it is small, and putting it here avoids a second round of teacher-facing work in Stage 5.

### D22 — Importance is a permanent marker, separate from status

**Decision:** `cases` gains `importance` — `Normal | Urgent | Critical`, default `Normal`, set by `/mark <ref> <level>` at `Support` rank and above. The urgent-code path sets `Urgent` at creation.

**Why it cannot be the status:** the agreed retention rule keeps urgent and critical cases for six months and removes the rest sooner. `Escalated` is a *status*, and a status moves — an escalated case that gets resolved becomes `Completed`, and its history of having been an emergency disappears with it. Retention would then delete the record of exactly the cases most worth keeping. A marker is set once and stays.

**Why `Critical` exists at all when `Urgent` already does:** urgent is what a teacher's one-time code buys, and it is issued by the flow. Critical is a judgement a person makes after reading the case. Collapsing them would mean either every code-holder's case is critical or no staff member can mark one.

**Forward, and it must not be forgotten:** Stage 5's retention job reads this column. It is the only thing standing between "six months for urgent" and a job that treats every case identically.

### D23 — A case carries a promised date and a snooze, and Stage 4 writes both

**Decision:** `cases` gains `due_at` and `snoozed_until`, with `/due <ref> <date>` and `/snooze <ref> <period>` at `case.update`. The daily chasing that reads them is Stage 5.

**Why write them here rather than add the columns in Stage 5:** two reasons, and the first is this plan's own argument turned on itself. The backward audit above lists eleven things earlier stages built with no consumer, and every one of them cost something. Adding two columns nothing writes would put this stage on that list. Giving them a writer now means Stage 5 adds a schedule to a field that already holds real data, rather than a schedule and a field and the hope that staff start filling it.

The second is cheaper: one migration instead of two.

**What is deliberately not built:** nothing arrives unasked. `casesPastDue()` is written in Task 44 and returns cases whose `due_at` has passed and whose `snoozed_until` is null or past. Stage 5 gives it a trigger.

> **Two ideas of "late", and they carry one name each — everywhere in this plan.**
>
> | Name | Means | Reads | Written in |
> |---|---|---|---|
> | `staleCases(overdueDays)` | Open, and nobody has touched it for N days | `OVERDUE_DAYS` | Task 28 |
> | `casesPastDue()` | Somebody promised a date and missed it | `due_at`, `snoozed_until` | Task 44 |
>
> A case can be either, both or neither. Earlier drafts of this plan called these
> `overdueCases`, `escalatedAndOverdue`, `staleCases` and `casesPastDue` in
> different sections — four names for two functions, in a document that warns
> against exactly that. The two names above are the only ones.

> **Settled 29 July. See D25**, which is the mapping. Task 34 is unblocked.

### D24 — Documents stay in Google Forms, and this reverses a planned direction

**Decision:** teachers submit documents through the existing per-stage Google Forms. The bot never accepts or stores a file. Form links live in a third spreadsheet tab; submissions are matched to teachers by recruitment email read from the form's own responses tab.

**Why it is recorded in the Stage 4 plan when it is Stage 6 work:** because it contradicts documents this stage is already correcting, and because one line of it constrains this stage. `RUNBOOK.md` Part 6 calls Telegram upload *"the only genuinely new feature in the rebuild"*; `BOT-SPEC.md` §1 says the opposite of both, describing the Apps Script Forms flow as current. Task 41 corrects all of it in one pass rather than leaving a third drift for somebody to find.

**The line that constrains this stage:** the forward table already says not to reintroduce the `UNRESOLVED:` sentinel, and this decision is why that holds. Matching on the roster identifier is stronger than the mechanism it replaces — the Apps Script version pre-filled the chat id into a *visible, editable* form field and could therefore never trust it as identity. An email matched against the roster is the same identity check as sign-in. Commands written in this stage must not carry a branch for an unidentifiable submitter, because the schema cannot store one and now nothing will produce one.

### D25 — The eight statuses stay; four of them are the only ones a staff member ever types

**Settled 29 July**, answering the question D23 left open.

**Decision:** `caseStatusEnum` is unchanged. Staff type four words, which are the four the mutation commands write. The other four are written by the system or not at all, and no command asks a staff member to choose from a list of eight.

| What staff call it | Status written | Who writes it | When |
|---|---|---|---|
| not yet opened | `New` | `createCase` | Automatically, at filing. Nobody types it |
| working on it | `Under review` | `/reply`, `/reopen` | A staff member has the case and is working it |
| **waiting on the teacher** | `Action required` | `/await <ref> <what is needed>` | The teacher must do something before the case can move |
| done | `Completed` | `/close` | The teacher's problem is resolved |

The four nobody types: `Received` is written by Task 32 when a new-case notification actually reaches at least one staff member — which gives it a real writer for the first time and makes "filed but seen by nobody" distinguishable from "filed and picked up" without asking anyone to maintain it. `Escalated` is set by the urgent-code path and already is. `Duplicate` is set by the duplicate rule. `Closed` is the case shut without being resolved — see D26 for who writes it, because that changed.

**The judgement call was put to the head of project and answered on 29 July — see D26.** `Action required` means **the teacher must act**. The row above is already corrected; the paragraph that used to say "accepted and being worked" is gone rather than struck through, because a decision recorded twice in two wordings is how this document would start disagreeing with itself.

**Why not trim the enum to four.** Two things would be lost that cost nothing to keep, and both are load-bearing later: `Duplicate` is what the 24-hour duplicate window writes, and `Escalated` is how an emergency is visible while it is open. D22 already establishes that a *status* cannot carry the memory of an emergency once it resolves — that is what `importance` is for — but while a case is open, `Escalated` is what puts it in `/urgent`.

**Why not show all eight.** Eight words written for a proposal document, offered to a staff member mid-conversation, is a vocabulary nobody asked for. Four verbs that each write one status is the same information with nothing to learn.

---

*D26–D28 were answered by the head of project on 29 July, closing the last three open questions in the stage. Nothing above them is superseded except the one row of D25 already corrected.*

### D26 — `Action required` means the teacher must act, and `Closed` gains the writer that frees up

**Settled 29 July.** D25 left one row open and named the cost of getting it wrong. The answer is the second reading: **`Action required` means the teacher has to do something.** `/await <ref> <what is needed>` writes it, and the text the staff member types is written to `public_update` — which is the only case text a teacher ever sees, so "what is needed" actually reaches them rather than sitting in a column staff read.

**A taxonomy of action types is coming and is not built here.** The head of project has said the case should eventually show *what kind* of action is wanted — send a document, attend an appointment, confirm an address. Until that exists, `/await` carries free text and nothing pretends otherwise. Task 41 must record this in the runbook so that whoever adds the taxonomy finds the decision rather than inventing a second one, and so the phrase is defined for staff on day one: **"Action required" is a request to the teacher, never a note to ourselves.**

**What this frees, and it is the part that would have been missed.** D25 parked `Closed` with Stage 5's retention pass, on the reasoning that retention would shut cases nobody resolved. D28 removes that job — an unresolved case is now kept indefinitely — so `Closed` would have been left with no writer at all, which is the eleven-row backward audit at the top of this plan happening again inside the same stage.

✅ **Approved 29 July.** `Closed` becomes a staff verb: the case is shut and was not resolved. It is the honest answer for a teacher who has left the country, stopped replying, or withdrawn the request, and it must not collapse into `Completed` — the difference between "we fixed it" and "we gave up" is the single most useful thing a later reader can know. Task 34 gives it the form `/close <ref> unresolved <reason>`, alongside the ordinary `/close <ref> <message>` that writes `Completed`.

**The reason is free text and is required.** The head of project asked specifically that a person be able to write why in their own words, so there is no list of reasons to choose from — the situations that end a case unresolved are exactly the ones a fixed list would fail to cover.

**Where that text goes is the one judgement in this, and it goes to a note rather than to the teacher.** `/close <ref> <message>` writes `public_update`, because it is a reply. The unresolved reason is not a reply: it is written for whoever reads the case afterwards, and staff being candid — *"unreachable since March, three attempts"* — is what makes it worth having. Sending that to the teacher would either leak a blunt internal judgement or teach staff to write nothing useful. So `/close … unresolved` writes the reason to `case_notes` via `addNote` (D8) and sends the teacher a plain notice that their case has been closed and how to raise it again. **Cost: nothing** — both write paths already exist and are already tested.

**The ripple into chasing, which belongs to Stage 5 and is stated here so it is inherited rather than rediscovered:** a case sitting in `Action required` is waiting on the *teacher*. Chasing must chase the teacher, not the staff member who is correctly doing nothing. A digest that nags staff about cases they are not permitted to move is a digest they will learn to ignore, which costs the cases that genuinely are their fault.

### D27 — A revoked teacher can be restored, by the rank that revoked them

**Settled 29 July.** The plan never specified a counterpart to `/revoke`, so revoking the wrong person meant a database session over the SSH tunnel. Revoking the wrong teacher is an ordinary mistake; reaching for the database is not an ordinary recovery.

**Decision:** `/restore <chat_id>` at `teacher.revoke` — the same capability as `/revoke`, deliberately. Whoever can make the mistake can undo it without escalating to somebody more senior, and a recovery that needs a second person is a recovery that waits until Monday.

It sets `verification_state = 'Verified'`, clears `revoked_at` and `revoked_by`, and writes a `TEACHER_RESTORED` audit row naming who did it (D18). It does **not** touch `identifier`, `region_override` or the privacy-acceptance columns: restoring somebody is undoing one act, not re-running their sign-in.

**Why it cannot simply be "sign in again", which is the obvious cheap answer and is wrong.** `bindTeacher` clears `revoked_at`, so a revoked teacher who signed in again would silently undo their own revocation — which is exactly why `requireSignIn` was changed to refuse them rather than prompt (departure 6 in the handoff). That refusal is load-bearing and must stay; `/restore` is the door it leaves shut being opened by somebody with the authority to open it.

**The failure this must not have, and it is not obvious.** There are two ways a teacher loses access and only one of them is `Revoked`. A teacher whose *roster row* was deactivated or removed is still `Verified` and still fails `teacherHasAccess`, because the gate re-checks the roster live (D17). `/restore` cannot help them — the fix is recruitment's spreadsheet — and a command that reports success while the teacher stays locked out is worse than no command. It must therefore check the roster and say which of the two situations it found, in those words.

### D28 — Retention: resolved cases go in a week, the interaction log in three days, urgent cases in six months

**Settled 29 July**, the last of the four original questions, and the one every earlier document has been waiting on.

| What | Kept | Reads |
|---|---|---|
| A case that is **not resolved** | **Indefinitely** | `status` — nothing terminal |
| A resolved case, `importance = Normal` | **7 days** after `closed_at` | `closed_at`, `importance` |
| A resolved case, `importance = Urgent` or `Critical` | **180 days** after `closed_at` | `closed_at`, `importance` |
| `messages` — the interaction log | **3 days** | `at` |
| `audit_log` | **Never pruned** | — |

"Resolved" means any status that stamps `closed_at`, which is already `Completed`, `Closed` and `Duplicate` (`TERMINAL_STATUSES` in `service.ts`). That column already has a writer, so the job reads a real field rather than inferring an end date from a status history nobody keeps.

**Why `importance` and never `status`.** This is D22 and R13 arriving at their consumer. A case marked `Critical` that gets resolved becomes `Completed`, and nothing about `Completed` remembers it was ever an emergency — a job reading status would delete exactly the cases most worth keeping, at the shortest interval, and nobody would notice for six months.

**Cases are deleted, not anonymised, and that is a change of direction worth stating.** The forward table below says removal means anonymise, because `cases.teacher_chat_id` is a non-null foreign key. That constraint is about deleting a **teacher**, not a case: `ON DELETE restrict` refuses to remove a teacher who still has cases, and `case_notes` cascades from the case. Deleting the case row is unobstructed, and it is what "deleted in a week" means. The consequence is real and is accepted: a week after a case is closed its reference stops resolving, so a teacher telephoning about `VISA-2026-00123` gets "no such case" and `/reopen` has nothing to reopen.

✅ **Settled 29 July: the three periods are settings, not constants.** MoPSE adjusts them itself, without a deployment. `RETENTION_DAYS` is replaced by three keys, because one number cannot carry three different promises:

| Key | Default | Governs |
|---|---|---|
| `CASE_RETENTION_DAYS` | 7 | A resolved case, `importance = Normal` |
| `URGENT_CASE_RETENTION_DAYS` | 180 | A resolved case, `importance = Urgent` or `Critical` |
| `MESSAGE_RETENTION_DAYS` | 3 | Rows in `messages` |

**Unset means delete nothing.** Exactly the rule `staleCases` already follows for `OVERDUE_DAYS`, and for a stronger version of the same reason: a job that invents a retention period deletes real records against a number nobody chose, and there is no undo. The runbook seeds all three at launch, in the same shape as the settings inserts it already carries (§2.4).

**The one thing this choice makes mandatory, and it is what turns it from a risk into a clean design.** The privacy notice must **render the current values** rather than have numbers typed into its text. A settings row and a hard-coded sentence can disagree; a sentence generated from the row cannot. `privacyNotice()` therefore becomes a function of the three settings, and the notice always states what the system will actually do — which is the property the constants option was reaching for, obtained a different way.

**Consequence for re-consent, so Stage 5 inherits a rule rather than an argument (R17).** Changing a period changes what teachers were told, so:

- **Lengthening** one — keeping data longer than promised — is a material change. It bumps `PRIVACY_NOTICE_VERSION` and asks teachers to read the notice again.
- **Shortening** one is not. Deleting sooner than promised breaks no commitment made to anybody, and forcing 1,800 people through a re-consent to be told their data goes sooner is a cost with no beneficiary.

Every change to any of the three writes a `recordAudit` row (D18). It is a change to a published commitment, and "who shortened this to one day, and when" is an audit question.

**Not built in Stage 4.** No key is added and `RETENTION_DAYS` is not renamed here: three settings with no reader is the eleven-row backward audit at the top of this plan happening again. Stage 5 adds the keys, the job and the notice together.

**The promise that has already been made, and it is the expensive part.** `src/config/privacy.ts` says, to every teacher who has signed in: *"Until the Ministry sets a retention period. When one is set, this notice will be updated and you will be asked to read it again."* Setting a period therefore requires new wording, a bumped `PRIVACY_NOTICE_VERSION`, and **asking every teacher to read it again** — a teacher-facing re-consent flow for 1,800 people that nothing in any plan currently builds. It ships in Stage 5, in the same release as the job, because a notice promising deletion before the job exists is false in the other direction.

**Three days is three days, for every row.** No exemptions, no per-action carve-outs. A retention rule with a list of things it does not apply to is a rule nobody can state in one sentence, and the privacy notice has to state it in one sentence.

**What that costs, stated plainly because it is a real loss and not a theoretical one.** `RUNBOOK.md` §4.7 is a **monthly** content review that runs two **30-day** queries over `messages`. At three days both return nothing, and an empty result from a review reads exactly like a system with no problems. The review is dead as written — see R18. Task 41 removes it from the runbook rather than leaving instructions that quietly stop working, and the recovery, **if the head of project wants one**, is a nightly roll-up into counts before the delete: a Stage 5 task, not a longer period. Nobody should discover this by running the query in November and finding nothing.

`BOT-SPEC.md` §7.1.3's word for this is "archive". It is now a delete, and Task 41 corrects the vocabulary in every document that says otherwise.

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
| Stage 2 | `roster_entries.region` | synced from the sheet, **reaches no teacher who has already signed in** (R12) | `regionFor` reads it live (Task 43) |

**The one that is not connected:** `messages`' `ANSWER_HELPFUL` / `ANSWER_UNHELPFUL` rows and the `AWAITING_QUESTION_TOPIC` misses are read by the monthly content review in `RUNBOOK.md` §4.7, by a human running SQL. That is a real endpoint and needs no command.

## Forward — Stage 4 must leave these open

| Owner | Thing | What Stage 4 must do |
|---|---|---|
| Stage 5 | `announcements`, `announcement_recipients` | Leave untouched. Carry `announce`/`export` in the capability table so Stage 5 adds commands only (D7, D19) |
| Stage 5 | The daily overdue digest | Read `OVERDUE_DAYS` for `/urgent`; do not push anything on a schedule. The digest is the same query with a different trigger, so `staleCases()` is written here as a reusable query |
| Stage 5 | Retention clean-up — **now specified, see D28** | Do not consume the periods here; nothing in Stage 4 deletes anything. Five things must be in that job's scope and none are obvious: `case_notes` (D8) cascades from the case and holds staff writing about teachers; `isRetained(importance)` (D22) is what makes "six months for urgent and critical" possible, and a job reading `status` instead would delete exactly those; `closed_at` is what the job reads, not a status history; the **privacy notice, its version bump and a re-consent flow for 1,800 teachers ship in the same release** (R17), because the notice already promises it; and `RUNBOOK.md` §4.7's monthly content review does not survive a 3-day log (R18) |
| Stage 5 | Chasing open cases | `due_at` and `snoozed_until` are written here (D23) and `casesPastDue()` exists and is tested. Stage 5 adds a schedule, not a field |
| Stage 6 | `DOC:` callback prefix, `CASE_CATEGORY.SUBMIT_DOCS` | The queue map must be **total** over `CaseCategory` today, so a document case files to a real queue the moment Stage 6 emits one |
| Stage 6 | Document cases with an unresolvable submitter | Do **not** reintroduce the `UNRESOLVED:` sentinel. `cases.teacher_chat_id` is a non-null FK with a digits check; Apps Script's sentinel cannot be stored and `hasNotifiableChatId_` (`AdminCommands.gs:652`) has no equivalent here. Under D24 nothing will produce one either — submissions are matched on the roster identifier — so commands written in this stage must not carry a branch for a state that is both forbidden and unreachable |
| Stage 6 | Documents through Google Forms (D24) | A third spreadsheet tab, `FORMS`, synced exactly as `FAQ` and `ROSTER` are. Nothing in this stage blocks it; the sync's existing shape — reject a bad row, report it with its row number, apply the rest — is what makes a half-ready form unable to reach a teacher |
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
| Region correction | Recruitment edits the sheet | **nothing reaches the teacher** (R12) | The region used to route their cases | Task 43 |
| Region, teacher moved | Nobody — no route exists | — | A flag a manager sees and acts on | Tasks 45, 46 |
| Importance | Urgent code, or a judgement | Lost when the case is resolved | A marker retention can read (D22) | Tasks 42, 44 |
| A promise to a teacher | Staff say when it will be done | Said aloud, recorded nowhere | A date on the case, chased in Stage 5 | Task 44 |

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
Layer 3  commands (the thin part)                    · teacher-facing: region confirmation
         /cases /mycases /urgent /case /search       ← case.view
         /reply /await /close /reopen /note           ← case.update
         /mark /due /snooze                          ← case.update
         /assign                                     ← case.assign
         /generate_urgent_code                       ← urgent.issue
         /region /regions                            ← teacher.region
         /revoke                                     ← teacher.revoke
         /staff /staff_add /staff_role /staff_remove ← staff.manage
         /maintenance                                ← maintenance
         /whoami /help                               ← any active staff row
              │
Layer 2  stores (database, no Telegram)
         staff repository ── region resolution ── visibility predicate ── case queries
         case notes ── importance and chasing ── teacher revocation
         existing: updateCase, setSetting, recordAudit
              │
Layer 1  leaves (no database, no network)
         role ladder + capability table ── queue map ── importance vocabulary ── command parser
              │
Layer 0  the migration (Task 42), then everything already built and unchanged
         chat lock · conversation state · interaction log · send · alerts · constants
```

**Two edges that are easy to get backwards.** The visibility predicate depends on region resolution, not the other way round — Task 43 before Task 27. And every case query depends on the migration, so Task 42 is first in Layer 2 rather than sitting with the other schema work in the middle of it.

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
**Terminates at:** a cap of twenty, which at Telegram's response times is a second or two. Apps Script called it `NEW_CASE_NOTIFY_MAX_ADMINS_`; here it is `NEW_CASE_NOTIFY_CAP` in `constants.ts`, because a number that governs how long a webhook request takes should not live only in a prose reference to a deleted file. Recorded rather than changed: if the staff list ever grows past twenty, this moves to the worker, and that is the same threshold `/announce` already has to respect.

### R10 — `deliver`'s error message assumes it knows who a message is for

`bot.ts:70-77` hardcodes *"This was a notice about somebody else's action (a duplicate sign-in)"* for every message after the first → new-case notification adds a second kind of non-first message → a failed staff notification would be alerted as a duplicate sign-in.
**Terminates at:** `OutgoingMessage` carrying a short `purpose`, used in the alert text. Small, and the kind of thing that silently misleads an operator at three in the morning.

✅ **Done ahead of Task 39, deliberately.** The fix was originally scheduled at Task 39, seven tasks after Task 32 creates the second kind of message — which would have left a window where a failed staff notification alerted as a duplicate sign-in. `purpose` is now on `OutgoingMessage`, the duplicate-holder notice sets it, and `deliver` reads it with a deliberately vague fallback: an alarm that admits it does not know beats one that confidently names the wrong thing. **Task 32 must set `purpose` on every notification it emits.**

*R11–R15 trace the decisions added on 29 July.*

### R11 — Signing in again wipes a staff-set region

`/region` writes `region_override` → the teacher later changes phone and verifies again → `verifyIdentifier` calls `bindTeacher` → `bindTeacher` upserts with `onConflictDoUpdate` whose `set` object writes `region` from the roster (`src/teachers/repository.ts:120-131`) → if the override lives anywhere that `set` touches, a manager's correction is silently undone by the teacher buying a phone.
**Terminates at:** the override columns being absent from `bindTeacher`'s `set`, and a test that verifies, overrides, re-verifies and asserts the override survived. The same test guards `revoked_at`, which `bindTeacher` deliberately *does* clear — a previously revoked chat that verifies again is active once more, and that behaviour must not be broken by fixing this one.

### R12 — The roster's region column has never reached anybody

Recruitment corrects a region in the spreadsheet → the sync updates `roster_entries.region` → **nothing else happens.** `teachers.region` is written once, at bind time, and `bindTeacher` is the only writer. A teacher who signed in last month keeps last month's region for ever, because there is no reason for them ever to sign in again.
**So there are two ways to change a teacher's region today and neither works:** the spreadsheet (never propagates) and no command at all.
**Terminates at:** `regionFor()` resolving `region_override ?? roster_entries.region`, read live through the join the visibility predicate already needs, rather than from the `teachers` snapshot. Recruitment's edits then take effect within ten minutes like every other sheet edit, and `teachers.region` becomes what it honestly is — a record of the region at bind time, kept because it costs nothing and answers "what did we think then".
**The property that must survive:** D10's rule that an unknown region hides a case from nobody. `COALESCE` of two nulls is null, and the predicate's `OR ... IS NULL` branch still catches it — tested explicitly, because this is the change most likely to break it.

### R13 — Importance, status, and a retention job that has not been written

`/mark` sets `Critical` → the case is worked and closed → its status becomes `Completed` → Stage 5's retention job runs → if the job reads *status* it deletes a critical case at the ordinary interval, because nothing about `Completed` says it was ever critical.
**Terminates at:** D22's separate column, and one test asserting a marked case keeps its marker through close and reopen.
**Second order:** the urgent-code path files at `Escalated` and must now also set `importance = 'Urgent'`, in the same insert. Two writes would mean a code spent for a case that is not marked as what the code bought — the same shape of fault as an urgent code spent with no case, which already has an alarm.
**Third order:** `appendUrgentFollowUp` escalates an *existing* case on the deduplicated path (`src/cases/service.ts:145`). That path must raise importance too, or the common urgent case — urgent plus deduplicated — is the one that loses its marker.

### R14 — Notifying an observer about work they cannot do

New case → recipients computed → an observer holds `case.view` and matches the queue and region → they are paged for every case that arrives → they cannot reply, close or take it.
**Terminates at:** filtering recipients on `case.update` rather than on visibility. Apps Script filtered on `adminCanSeeCase_` alone (`AdminCommands.gs:353`), which was right there only because its `ReadOnly` bucket was nearly always empty; here the rank exists because somebody asked for it, so it will have people in it.
**Collides with R4:** the zero-recipients alarm must count people who can *act*, not people who can see. A queue covered only by observers is a queue where cases arrive and nobody works them, and that must alarm rather than look staffed.

### R15 — Two columns nobody reads until the stage after next

`due_at` and `snoozed_until` are added here (D23) and the chasing that reads them is Stage 5 → for one stage they are columns with a writer and no reader → which is a milder version of the eleven-row backward audit at the top of this plan.
**Terminates at:** `/case` displaying both, and `casesPastDue()` existing and being tested in Task 44. The data is visible to a human and queryable from the first day, so Stage 5 adds a schedule rather than a schedule plus a field plus the hope that staff have been filling it in.
**Left as a known cost:** until Stage 5, a promised date that passes is visible only to somebody who looks. That is the same position `OVERDUE_DAYS` has been in since Stage 2 and is honest about what this stage does not do.

*R16–R18 trace D26, D27 and D28.*

### R16 — Restoring somebody the roster no longer lists

`/restore` sets `Verified` and clears `revoked_at` → the teacher's roster row was *also* deactivated, or was never the reason → `teacherHasAccess` re-checks the roster live (D17) and still refuses them → the staff member is told "restored", the teacher tries again and is still locked out, and the two of them conclude the bot is broken.
**Terminates at:** `/restore` reading the roster before it reports anything, and naming which of the two situations it found — "restored, and they can use the bot again" versus "restored, but their roster row is inactive; recruitment has to put it back". Same shape as R3's rule for `/assign`: the recoverable outcome is being told what to fix, and the unrecoverable one is believing it worked.
**Second order:** a teacher who was never revoked at all. `/restore` on a `Verified` teacher must say so and change nothing, rather than writing a `TEACHER_RESTORED` audit row for an event that did not happen — an audit trail with invented entries is worse than a short one.

### R17 — Setting a retention period triggers a promise already made to 1,800 people

D28 fixes the periods → `src/config/privacy.ts` currently tells every teacher the period is unset and that *"when one is set, this notice will be updated and you will be asked to read it again"* → publishing the periods without the re-consent breaks a commitment made in the one document teachers were required to read before signing in.
**Terminates at:** Stage 5 shipping four things in one release — the new wording, a bumped `PRIVACY_NOTICE_VERSION`, a re-consent flow, and the job itself. Any three without the fourth is a false statement in one direction or the other.
**Sharper now that the periods are settings (D28).** The notice must be *generated from* the three settings rather than have numbers written into its text, or this ripple fires again every time somebody edits one — and next time silently, because nobody will be watching for it. Generated, the notice cannot disagree with the system; typed, it disagrees the moment a period changes and nothing anywhere notices.
**Not fixed by:** updating the notice in Stage 4. The notice would then promise deletion that nothing performs, which is the same class of fault as `RUNBOOK.md` §4.3 promising that a roster edit revokes a teacher — a document describing behaviour the code does not have, which is what this rebuild exists to stop.
**Consequence for this stage:** `src/config/privacy.test.ts` asserts the notice names no period (`does not promise a retention period, because none has been decided`). That test is **correct today and must not be changed here.** It inverts in Stage 5, in the same commit as the wording.

### R18 — Three days deletes the evidence the monthly review runs on

`messages` is pruned at 3 days → `RUNBOOK.md` §4.7 runs two 30-day queries over it → both return nothing → an empty result from a review looks exactly like a system with no problems, which is the failure mode this project keeps finding.
**Terminates at:** Task 41 deleting §4.7 from the runbook. An instruction that has silently stopped working is worse than no instruction, and this one would fail in the direction of false reassurance.
**Collides with the backward audit:** the `ANSWER_HELPFUL` / `ANSWER_UNHELPFUL` rows are the one entry marked "not connected — read by a human running SQL", and that was accepted precisely because a person reading them monthly *is* the endpoint. Three days removes that endpoint, so those rows go back to having no consumer at all. `ANSWER_HELPFUL` was added in Stage 3 specifically so the answer bank could learn what was working; it now has three days to be read in.
**The cost, named so nobody reports it as a bug later.** Two questions become unanswerable beyond three days: *what are teachers asking that the answer bank cannot cover*, and *which confident answers are teachers rejecting*. The second is described in the runbook as "the strongest signal available".
**The recovery, and it is the head of project's to ask for.** A nightly roll-up into counts, run *before* the delete, keeps both signals without keeping anybody's words — the row becomes "`VISA-001` was rejected 14 times in October" and no teacher text survives past three days. That is a Stage 5 task and it is **not** a longer retention period. It is written down here so it is a choice rather than something rediscovered when the answer bank stops improving.

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
| `src/telegram/commands/cases.ts` | `/cases` `/mycases` `/urgent` `/case` `/search` `/reply` `/await` `/close` `/reopen` `/assign` `/note` |
| `src/telegram/commands/staff.ts` | `/staff` `/staff_add` `/staff_role` `/staff_remove` `/whoami` `/revoke` |
| `src/telegram/commands/ops.ts` | `/maintenance` `/generate_urgent_code` |
| `src/teachers/region.ts` | `regionFor`, `setRegionOverride`, `clearRegionOverride`, `flagRegionMismatch`, `listRegionFlags` (D20, D21) |
| `src/cases/importance.ts` | The `Normal / Urgent / Critical` vocabulary and its parser. Pure (D22) |
| `drizzle/0006_notes_regions_importance.sql` | Generated — one migration for the whole stage (D23) |

Test files alongside each, following the existing `.test.ts` / `.integration.test.ts` split.

## Modified

- `src/db/schema.ts` — `caseNotes`; `Observer` added to `staffRoleEnum` and `STAFF_ROLE_ORDER`; `teachers.region_override`, `region_set_by`, `region_set_at`; `cases.importance`, `due_at`, `snoozed_until`
- `src/telegram/router.ts` — the staff branch in `routeText`; `OutgoingMessage.purpose`
- `src/telegram/bot.ts` — private-chat gate, `my_chat_member` leave handler, generalised failure alert
- `src/telegram/alerter.ts` — System-staff fan-out
- `src/log/interactions.ts` — the `/` prefix rule (D16)
- `src/cases/service.ts` — `findCase`; `createCase` reports what notification needs and sets `importance` on the urgent path; `appendUrgentFollowUp` raises importance on the deduplicated path (R13)
- `src/teachers/repository.ts` — roster-active re-check, `revokeTeacher`, and **`bindTeacher`'s `set` must not touch the override columns** (R11)
- `src/staff/visibility.ts` — resolves region through `regionFor`, joining `roster_entries` (R12)
- `src/config/constants.ts` — `STAFF_LIST_CAP`, `CASE_NOTES_SHOWN`, `URGENT_CODE_TTL_HOURS`, `REGION_CONFIRM_AFTER_DAYS`, `MAX_SNOOZE_DAYS`, and **`NEW_CASE_NOTIFY_CAP`** — the twenty-recipient limit of R9, which until now was referred to only by its Apps Script name (`NEW_CASE_NOTIFY_MAX_ADMINS_`) and had no home in the rebuild. A number that governs how long a webhook request takes needs to be findable.
- `BOT-SPEC.md`, `RUNBOOK.md`, `CONCERNS-AND-IT-ACTIONS.md`

---

---

## A note on task numbers

Tasks 42–46 came out of the 29 July design session, after this plan was already committed. They are numbered after 41 so that anything already referring to a task number still means what it said, and they are placed **where they must be built** rather than at the end. Build the document in the order it reads, top to bottom:

`23 · 24 · 25 · 42 · 26 · 43 · 27 · 28 · 29 · 44 · 30 · 31 · 32 · 33 · 34 · 35 · 45 · 46 · 36 · 37 · 38 · 39 · 40 · 41`

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
    expect(can({ role: 'Lead', active: true }, 'case.assign')).toBe(true);
  });

  it('lets an Observer see a case and change nothing', () => {
    // D7. The whole point of the rank: sight without the power to alter.
    expect(can({ role: 'Observer', active: true }, 'case.view')).toBe(true);
    for (const capability of ALL_CAPABILITIES.filter((c) => c !== 'case.view')) {
      expect(can({ role: 'Observer', active: true }, capability)).toBe(false);
    }
  });

  it('does not let an Observer issue an urgent code', () => {
    // Called out separately because it is the one capability that is not about
    // cases and would be easy to grant by pattern-matching on "read-only means
    // no writes to cases".
    expect(can({ role: 'Observer', active: true }, 'urgent.issue')).toBe(false);
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
  CASE_MARK: 'case.mark',
  CASE_ASSIGN: 'case.assign',
  URGENT_ISSUE: 'urgent.issue',
  TEACHER_REGION: 'teacher.region',
  TEACHER_REVOKE: 'teacher.revoke',
  STAFF_MANAGE: 'staff.manage',
  MAINTENANCE: 'maintenance',
  ANNOUNCE: 'announce',
  EXPORT: 'export',
} as const;

const GRANTS: Readonly<Record<Capability, readonly StaffRole[]>> = {
  'case.view':      ['Observer', 'Support', 'Lead', 'Program', 'System'],
  'case.update':    ['Support', 'Lead', 'Program', 'System'],
  'case.mark':      ['Support', 'Lead', 'Program', 'System'],
  'case.assign':    ['Lead', 'Program', 'System'],
  'urgent.issue':   ['Support', 'Lead', 'Program', 'System'],
  'teacher.region': ['Lead', 'Program', 'System'],
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

### Task 42: One migration for the whole stage

Numbered after 41 because this plan was already committed; **built in the position it appears here**, first in Layer 2, because everything below reads what it creates.

Every schema change this stage needs, in one migration. D23's second reason: one migration instead of three, and no window in which half the columns exist.

**Files:** Modify `src/db/schema.ts`; generate `drizzle/0006_notes_regions_importance.sql`

- [ ] **Step 1: `Observer` into the role enum, and `Regional` renamed to `Lead`**

```ts
export const staffRoleEnum = pgEnum('staff_role', ['Observer', 'Support', 'Lead', 'Program', 'System']);
export const STAFF_ROLE_ORDER = ['Observer', 'Support', 'Lead', 'Program', 'System'] as const;
```

Both names were confirmed on 29 July (D7) and are permanent from the moment this ships. **There are two changes here, not one** — an earlier draft of this step showed only the addition, because the rename was decided after the plan was written. The rename is the half that needs a statement drizzle-kit will not write for you; see Step 5.

⚠️ **A PostgreSQL trap worth knowing before you run it.** `ALTER TYPE … ADD VALUE` may run inside a transaction on PostgreSQL 12 and later — which matters because `src/db/migrate.ts` wraps each migration in one — but the new value **cannot be used in that same transaction**. Adding it is all this migration does; nothing inserts an `Observer` row until runtime, which is a different transaction. Do not add a seed row to this migration.

Generate with `BEFORE 'Support'` so `ORDER BY role` in any future ad-hoc query sorts the way the ladder reads. Ranking in the program is by index in `STAFF_ROLE_ORDER`, not by the enum's internal order, so this is tidiness rather than correctness.

- [ ] **Step 2: The region override columns** (D20)

```ts
    /**
     * A region set by a named person, which beats the roster.
     *
     * The roster is recruitment's copy and it goes stale — teachers are moved.
     * The bot cannot write back to the spreadsheet (it holds Viewer access to
     * one document, and edit access would reach the confidential answer bank),
     * so a correction is recorded here and `regionFor` resolves the precedence
     * in one place. Clearing it returns the teacher to whatever the roster says,
     * which is also how a mistyped region is undone.
     *
     * NOT written by `bindTeacher`. A teacher who signs in again — a new phone,
     * the commonest legitimate reason — would otherwise have a manager's
     * correction silently reverted by the roster's value.
     */
    regionOverride: text('region_override'),
    regionSetBy: chatId('region_set_by'),
    regionSetAt: tsz('region_set_at'),
    /** Raised when a teacher says the region we hold is wrong. Cleared when staff act. */
    regionFlaggedAt: tsz('region_flagged_at'),
```

- [ ] **Step 3: Importance, promised date and snooze** (D22, D23)

```ts
    /**
     * How serious this case is, as a person judged it — not as its status says.
     *
     * Separate from `status` because status moves: an escalated case that gets
     * resolved becomes Completed, and with it goes every trace of its having
     * been an emergency. Retention keeps urgent and critical cases for six
     * months, so a retention job reading status would delete exactly the cases
     * most worth keeping.
     */
    importance: caseImportanceEnum('importance').notNull().default('Normal'),
    /** When whoever holds this case said it would be done. */
    dueAt: tsz('due_at'),
    /** Suppresses chasing until this passes. Never suppresses the case itself. */
    snoozedUntil: tsz('snoozed_until'),
```

plus `caseImportanceEnum` (`Normal`, `Urgent`, `Critical`) and `index('cases_chasing_idx').on(t.status, t.dueAt, t.snoozedUntil)`.

- [ ] **Step 4: `case_notes`** — the table from Task 29, created here rather than there.

- [ ] **Step 5: Generate, then READ IT — drizzle-kit will hand you a destructive migration**

```bash
npx drizzle-kit generate --name=notes_regions_importance
```

⚠️ **drizzle-kit does not emit `ALTER TYPE … ADD VALUE`. It emits a drop and a recreate**, and the generated file will contain roughly this:

```sql
ALTER TABLE "staff" ALTER COLUMN "role" SET DATA TYPE text;
DROP TYPE "public"."staff_role";
CREATE TYPE "public"."staff_role" AS ENUM('Observer', 'Support', 'Lead', 'Program', 'System');
ALTER TABLE "staff" ALTER COLUMN "role" SET DATA TYPE "public"."staff_role" USING "role"::"public"."staff_role";
```

**This passes every test here and breaks on the server.** It works locally only because `staff` is empty; the final cast is `USING role::staff_role`, and any existing `Regional` row fails it — so the one machine where it matters is the one machine where it is not exercised. Replace those statements by hand with:

```sql
ALTER TYPE "public"."staff_role" ADD VALUE 'Observer' BEFORE 'Support';
ALTER TYPE "public"."staff_role" RENAME VALUE 'Regional' TO 'Lead';
```

Editing the `.sql` and leaving `drizzle/meta/` alone is correct and safe: drizzle diffs against the snapshot, not against the SQL, so the next `generate` will not re-emit this. If a later generate ever does, hand-fix it the same way.

`BEFORE 'Support'` so `ORDER BY role` in an ad-hoc query sorts the way the ladder reads. Ranking in the program is by index in `STAFF_ROLE_ORDER`, so this is tidiness rather than correctness.

Expected once corrected: one `CREATE TABLE`, one `CREATE TYPE` (importance), one `ADD VALUE`, one `RENAME VALUE`, seven `ALTER TABLE … ADD COLUMN`, two indexes. **No column drops, no type drops, no `NOT NULL` without a default** — rollback stays code-only only while every migration is additive, and this is the largest one in the rebuild so far.

- [ ] **Step 6: Run the whole existing suite against the new schema**

Run: `npm test`
Expected: 332 passing, unchanged. A migration that changes behaviour before a line of new code is written means one of the defaults is wrong.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts drizzle
git commit -m "feat: the stage 4 schema — notes, region overrides, case importance and chasing"
```

---

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

### Task 43: Region resolution, in one function

Implements D20 and closes R11 and R12. **Built before Task 27**, because the visibility predicate reads what this defines.

**Files:** Create `src/teachers/region.ts`, `region.integration.test.ts`; modify `src/teachers/repository.ts`

- [ ] **Step 1: Write the test that proves today's behaviour is wrong**

```ts
it('follows the roster when recruitment corrects a region', async () => {
  // R12. There is no code path from a corrected roster row to a teacher who has
  // already signed in: teachers.region is written once, by bindTeacher, and a
  // verified teacher never verifies again. Recruitment's edits reach nobody.
  await verifyTeacher(db, CHAT, IDENTIFIER);           // roster says Tashkent
  await setRosterRegion(db, IDENTIFIER, 'Samarkand');  // as the sync would
  expect(await regionFor(db, CHAT)).toBe('Samarkand');
});

it('lets a manager override the roster', async () => {
  await setRegionOverride(db, CHAT, 'Bukhara', MANAGER);
  await setRosterRegion(db, IDENTIFIER, 'Samarkand');
  expect(await regionFor(db, CHAT)).toBe('Bukhara');
});

it('keeps the override when the teacher signs in again from a new phone', async () => {
  // R11. bindTeacher upserts with onConflictDoUpdate and its `set` writes
  // region from the roster. A manager's correction must not be undone by a
  // teacher buying a phone.
  await setRegionOverride(db, CHAT, 'Bukhara', MANAGER);
  await verifyIdentifier(db, CHAT, IDENTIFIER, 0);
  expect(await regionFor(db, CHAT)).toBe('Bukhara');
});

it('still un-revokes a chat that verifies again', async () => {
  // The same `set` object deliberately clears revoked_at. Fixing R11 must not
  // break that — they are two columns in one statement and it is easy to widen
  // the fix by one field too many.
});

it('returns null when neither the override nor the roster has one', async () => {
  // D10 depends on this: an unknown region hides a case from nobody.
});

it('returns to the roster value when the override is cleared', async () => { /* … */ });
```

- [ ] **Step 2: `regionFor`, and every region read goes through it**

```ts
/**
 * The one answer to "which region is this teacher in".
 *
 * Precedence, stated once so nothing re-derives it: an explicit decision by a
 * named person beats an import. Below that, the roster is read LIVE rather than
 * from the copy taken at sign-in — `teachers.region` is written once by
 * `bindTeacher` and a verified teacher never signs in again, so a correction
 * made in the spreadsheet has never reached anybody. Reading through the join
 * makes recruitment's edits behave like every other sheet edit: ten minutes.
 *
 * `teachers.region` is kept, and is now honestly what it always was — a record
 * of what we believed at bind time.
 */
export async function regionFor(db: Database, chatId: string): Promise<string | null>
```

- [ ] **Step 3: Repair `bindTeacher`.** Remove nothing from its `set` that is there on purpose; add nothing to it. The override columns are simply never in it. The test in Step 1 is the guard.

- [ ] **Step 4: The writers** — `setRegionOverride(db, chatId, region, actor)`, `clearRegionOverride(db, chatId, actor)`, both writing `region_set_by` / `region_set_at` and an audit row (D18); `flagRegionMismatch(db, chatId)` for the teacher-facing half; `listRegionFlags(db, staffScope)` so a manager can see who has reported a move.

- [ ] **Step 5: Run the whole suite, then commit**

```bash
git commit -am "feat: one answer to a teacher's region, and roster corrections that arrive"
```

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

it('follows a corrected region, not the one copied at sign-in', async () => {
  // The test that stops this predicate quietly bypassing Task 43. teachers.region
  // still says Tashkent; the case must now be visible to Samarkand staff and not
  // to Tashkent staff. Without this, the region fix works everywhere except the
  // one place that decides who sees a teacher's emergency.
  await setRosterRegion(IDENTIFIER, 'Samarkand');
  const samarkand = await visibleCases(db, { role: 'Support', queue: 'All', regions: ['Samarkand'] });
  const tashkent = await visibleCases(db, { role: 'Support', queue: 'All', regions: ['Tashkent'] });
  expect(samarkand.map((r) => r.reference)).toContain(reference);
  expect(tashkent.map((r) => r.reference)).not.toContain(reference);
});

it('lets a manager override reach the predicate too', async () => {
  await setRegionOverride(db, CHAT, 'Bukhara', MANAGER);
  const rows = await visibleCases(db, { role: 'Support', queue: 'All', regions: ['Bukhara'] });
  expect(rows.map((r) => r.reference)).toContain(reference);
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
 *
 * The region expression is `coalesce(teachers.region_override,
 * roster_entries.region)` — the same precedence `regionFor` applies, for the
 * same reason (D20, R12). It must NOT read `teachers.region`: that column is the
 * snapshot taken at sign-in, and this predicate is the most important consumer
 * of a region there is. Reading it here would leave the fault Task 43 exists to
 * fix alive in the one place it decides who sees a teacher's emergency.
 */
export function visibleToStaff(staff: StaffScope): SQL {
  if (staff.role === 'System') return sql`true`;

  // An empty regions array means every region, and it is decided in JavaScript
  // rather than in SQL — `cardinality()` over a bound array is one of the three
  // broken forms described below.
  const region = sql`coalesce(${teachers.regionOverride}, ${rosterEntries.region})`;
  const regionClause =
    staff.regions.length === 0
      ? sql`true`
      : sql`(${region} IS NULL OR ${inArray(sql`lower(${region})`, staff.regions.map((r) => r.toLowerCase()))})`;

  return sql`${inArray(cases.category, [...categoriesVisibleTo(staff.queue)])} AND ${regionClause}`;
}
```

⚠️ **A JS array cannot be dropped into a `sql` template, and this is the third time it has cost something.** Drizzle expands `${someArray}` into a **parameter list** — `($1, $2)` — not into an array literal. So every one of these is a syntax error at the database, and adding a `::text[]` cast does not rescue any of them:

```
= ANY(${categories})                → = ANY(($1, $2))
cardinality(${regions}::text[]) = 0 → cardinality(($1, $2)::text[]) = 0
regions is []                       → cardinality(()::text[]) = 0
```

Verified against the live database rather than reasoned about, because this fails at the database and nothing above it — not the typechecker, not review — can see it. **Use `inArray()`**, which emits `in ($1, $2)` and is safe on an empty array, or `sql.param(arr)::text[]` when a genuine array parameter is wanted.

Every caller joins `teachers` on `cases.teacher_chat_id`, and then LEFT joins `roster_entries` on `teachers.identifier`. The first join is inner, which is safe: `teacher_chat_id` is a non-null foreign key. The second must be a LEFT join — a teacher whose roster row was removed still has cases, and an inner join would make those cases invisible to everybody, which is the failure this predicate exists to prevent.

- [ ] **Step 3: Run, commit**

---

### Task 28: Staff-facing case queries

**Files:** Create `src/cases/queries.ts`, `queries.integration.test.ts`

- [ ] **Step 1: The query set**

`listCases({ openOnly | status | unassigned })`, `casesOwnedBy(chatId)`, `staleCases()`, `searchCases(term)`, `findCase(reference)` — each taking the staff scope and applying `visibleToStaff`.

**Every list-returning function returns `{ cases, total }`**, including the ones that cannot currently exceed the cap, and `casesPastDue` in Task 44 does too. `findCase` returns one row or null. Uniformity is the point: a module where some functions return a bare array and others return an object is one where a command writes `.map` on the wrong one, and layer 3 calls all five.

`staleCases` reads `OVERDUE_DAYS` itself rather than taking it as an argument, so "omit entirely when unset" cannot be forgotten by a caller — the same reasoning that keeps redaction inside `redactDetail`.

`staleCases` is the "nobody has touched it" half of `/urgent`, and it is the name used everywhere in this plan — see the table in D23. `casesPastDue` is a different function about a missed promise, and it is written in Task 44.

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

**Files:** Create `src/cases/notes.ts`, `notes.integration.test.ts`. **No schema change and no migration here** — Task 42 created the table, and this task only writes to it.

- [ ] **Step 1: The table is already built.** Its shape is in `src/db/schema.ts` as `caseNotes`, and the columns are `id`, `case_reference`, `author_chat_id`, `body`, `created_at`.

An earlier draft of this task carried a second, different definition — `author` / `note` / `at`, and no check constraint. Two definitions of one table is how a column ends up meaning different things in two places, so the sample is gone rather than corrected. The schema file is the definition; read it there.

Two properties to keep in mind while writing against it:

`ON DELETE CASCADE`, unlike almost everywhere else in this schema: a note about a case that no longer exists is not a record worth keeping, and Stage 5's retention job must be able to remove a case without tripping over its notes.

An INSERT rather than a read-append-write, which also settles the concurrency question: two staff members writing at the same moment take different chat locks, so anything read-modify-write on a case would lose one of the two (R2).

- [ ] **Step 2: Test that two concurrent notes both survive**

```ts
it('keeps both notes when two staff write at the same moment', async () => {
  await Promise.all([addNote(db, ref, 'A', '111'), addNote(db, ref, 'B', '222')]);
  expect(await recentNotes(db, ref)).toHaveLength(2);
});
```

- [ ] **Step 3: Run, commit.** No migration here — Task 42 generated it.

---

### Task 44: Importance, promised dates and snoozes

Implements D22 and D23, and closes R13. **Built after Task 29**, because it touches the same write path.

**Files:** Create `src/cases/importance.ts`, `importance.test.ts`; modify `src/cases/service.ts`, `src/cases/queries.ts`

- [ ] **Step 1: The vocabulary, pure**

`CASE_IMPORTANCE` (`Normal`, `Urgent`, `Critical`), `parseImportance(raw)` accepting the spellings a person actually types, `isRetained(importance)` naming which levels the six-month rule covers — so Stage 5's retention job asks this module rather than hard-coding two strings.

- [ ] **Step 2: The three writes on the urgent path, tested together**

```ts
it('marks a case urgent when it is filed with a code', async () => {
  // In the same insert as the status, not a second write. A code spent for a
  // case that is not marked as what the code bought is the same shape of fault
  // as a code spent with no case at all — which already has its own alarm.
});

it('raises importance when an urgent follow-up escalates an EXISTING case', async () => {
  // R13, third order, and the one most likely to be missed: urgent plus
  // deduplicated is the common path (BOT-SPEC §7.3), not an edge case. If
  // appendUrgentFollowUp escalates the status but leaves importance at Normal,
  // the commonest urgent case is the one retention throws away first.
});

it('keeps the marker through close and reopen', async () => {
  // The whole reason importance is not a status.
});

it('never lowers importance on the deduplicated path', async () => {
  // A Critical case that receives an urgent follow-up stays Critical.
});
```

- [ ] **Step 3: `markImportance(db, reference, level, actor)`**, through `updateCase`'s pattern — `updated_at` and `last_actor` set by the function, never by the caller.

- [ ] **Step 4: `setDue` and `setSnooze`.** Both single statements. `snoozed_until` is capped at `MAX_SNOOZE_DAYS` so a case cannot be snoozed out of existence, and a snooze never changes the case's status — it suppresses chasing, not the work.

- [ ] **Step 5: `casesPastDue(staffScope)`** in `queries.ts` — `due_at < now()` and `snoozed_until` null or past, with the visibility predicate applied.

⚠️ **Two different ideas of "late", and they must not be merged.** `staleCases(overdueDays)` in Task 28 is `/urgent`'s half: an open case nobody has touched for N days, where N comes from `OVERDUE_DAYS`. `casesPastDue()` is a promise somebody made and has missed. A case can be either, both or neither. These two names are used throughout this plan and nowhere is a third invented — see the table in D23.

- [ ] **Step 6: Run, commit**

```bash
git commit -am "feat: case importance that survives being resolved, and dates somebody promised"
```

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

it('does not notify an Observer, who could not act on it', async () => {
  // R14. `case.view` is not the same question as "should this person be paged".
  // Recipients are filtered on case.update, not on visibility.
});

it('alarms when a queue is covered only by Observers', async () => {
  // R14 colliding with R4. A queue where cases arrive and nobody is able to
  // work them must alarm, not look staffed.
});

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

- [ ] **Step 2: Implement as a returned message list**, computed inside the transaction, delivered after the commit. Carries the reference, category, time in Tashkent, and ready-to-tap `/case` and `/assign` lines. Capped at `NEW_CASE_NOTIFY_CAP` (R9).

  **Set `purpose` on every message** — `'a new case notification'` and `'an urgent case notification'`. The field already exists (R10, done early); an unset one falls back to wording that names nothing, which is correct but wastes the alarm.

- [ ] **Step 2a: Move the case to `Received` when at least one recipient is found** (D25). This is what gives `Received` a writer — it has never had one — and it makes "filed, and somebody can see it" distinguishable from "filed, and nobody could" without asking any staff member to maintain the difference by hand. Zero recipients leaves the case at `New` and raises the critical alert below, so the two states cannot both be true.

- [ ] **Step 3: Log it** as `STAFF_NOTIFIED_NEW` / `STAFF_NOTIFIED_URGENT` with chat id `SYSTEM` and a delivered/total count — `'SYSTEM'` because `src/db/schema.ts:459` reserves it for bot-initiated events, so a case reference never lands in the chat id column.

- [ ] **Step 4: Commit**

---

### Task 33: Case reading — `/cases` `/mycases` `/urgent` `/case` `/search`

**Files:** Create `src/telegram/commands/cases.ts` and its test

- [x] **Step 1: Tests**, including `/case` showing the last few notes and the count of the rest, and `/cases unassigned` as the intake backlog.

- [x] **Step 2: Implement.** Every one takes the staff scope from the dispatcher; none of them re-derives visibility.

- [x] **Step 3: Commit**

**Two things this task found that the plan did not anticipate.**

**The case-status vocabulary existed three times.** `caseStatusEnum` in the schema, a hand-written eight-value union in `service.ts`, and — worse — `OPEN_CASE_STATUSES` defined in *both* `schema.ts` and `service.ts`, with `queries.ts` importing one copy and `service.ts` using the other. They agreed by luck. `/cases <status>` has to validate what a staff member typed against *the* list, and there was no such thing. Collapsed: `CASE_STATUS_ORDER` in the schema is the source, the enum and the type derive from it, and `src/cases/status.ts` holds the parser and the open/closed split exactly as `importance.ts` holds the other axis. A test asserts the two halves partition all eight, because a status in neither list would be invisible to `/cases` and immortal to stage 5's retention.

**`send.ts` does not split long messages, and `/case` can produce one.** Telegram rejects anything over 4096 characters; `send` throws, `deliver` catches it and alerts, so the staff member gets silence and an operator gets woken. `/case` prints `cases.detail` — which has no length limit and which `appendUrgentFollowUp` appends to — plus up to five notes with none either. This is reachable by ordinary use, and it is the failure `handleCaseDetail_` carried a comment about: D8 stopped the field growing without limit, it did not make either one short. The detail and each note are budgeted (`CASE_DETAIL_SHOWN_CHARS`, `CASE_NOTE_SHOWN_CHARS`), and `reply` clamps whatever comes out, so the guarantee is structural rather than arithmetic. **Task 34 inherits this**: `/note` and `/reply` carry staff free text of unbounded length, and their confirmations must go through `reply` like everything else.

---

### Task 34: Case mutation — `/reply` `/await` `/close` `/reopen` `/note`

The status-writing verbs of D25, **as corrected by D26**. `/reply` moves an open case to `Under review`; `/await` writes `Action required`, which now means **the teacher must do something**; `/close` writes `Completed`, and `/close <ref> unresolved <reason>` writes `Closed`; `/reopen` returns a case to `Under review`. `/note` writes no status at all — it is internal, and a note is not progress.

**Files:** Modify `src/telegram/commands/cases.ts`

- [ ] **Step 1: The tests that encode the rules**

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

it('puts what the teacher must do where the teacher can read it', async () => {
  // D26. `Action required` means they have to act, so the request has to reach
  // them — public_update is the only case text a teacher ever sees, and an
  // instruction sitting in a staff-only column is an instruction nobody follows.
  await run('/await VISA-2026-00001 send us a scan of your passport page');
  const visible = await getCasesForChatId(db, CHAT);
  expect(JSON.stringify(visible)).toContain('passport page');
});

it('refuses /await with nothing to ask for', async () => {
  // A case moved to "waiting on the teacher" without saying what is wanted
  // strands them: they can see they must act and not what the act is.
});

it('distinguishes a case that was resolved from one that was given up on', async () => {
  // D26. `Closed` has a writer now, and the difference between "we fixed it"
  // and "we gave up" is the most useful thing a later reader can know. Both
  // stamp closed_at, which is what D28's retention job reads.
  await run('/close VISA-2026-00001 your visa was issued on Tuesday');
  expect(await statusOf('VISA-2026-00001')).toBe('Completed');
  await run('/close VISA-2026-00002 unresolved teacher has left the country');
  expect(await statusOf('VISA-2026-00002')).toBe('Closed');
});

it('keeps the unresolved reason internal, and still tells the teacher', async () => {
  // D26. The reason is written for whoever reads the case afterwards, and
  // staff being candid is what makes it worth having. The teacher is told
  // their case is closed — silence would be worse — but not told this.
  const outcome = await run('/close VISA-2026-00002 unresolved unreachable since March, three attempts');

  expect(await notesOn('VISA-2026-00002')).toContain('three attempts');
  const visible = await getCasesForChatId(db, CHAT);
  expect(JSON.stringify(visible)).not.toContain('three attempts');
  expect(outcome.messages.some((m) => m.chatId === CHAT)).toBe(true);
});

it('refuses to close a case unresolved without saying why', async () => {
  // The reason is the whole point of the form. `Closed` with no explanation is
  // `Completed` with a different word, and a case shut for no recorded reason
  // is one nobody can answer for.
});

it('sets closed_at when a case is closed, and clears nothing when it is reopened', async () => { /* … */ });
```

- [x] **Step 2: Implement** through `updateCase` and `addNote` only. Nothing here writes to `cases` directly — that is the point of the single write path (`src/cases/service.ts:1-14`).

- [x] **Step 3: Commit**

**A live fault this task found, in code committed two sessions ago.** `updateCase` stamped `closed_at` on the way *into* a terminal status and left it alone on the way *out* — so a case that was closed and then reopened stayed open carrying a `closed_at` from its previous life. That was harmless when it was written and stopped being harmless the day D28 was answered, because stage 5's retention measures its seven days from exactly that column: a reopened case somebody was actively working would have been deleted a week later. `closed_at` now follows the status in both directions. **The plan's own test sketch above said "clears nothing when it is reopened", which was right before retention was decided and is wrong now** — it is replaced by the two tests in `service.integration.test.ts` that assert the clearing, and that a write which does not move the status still leaves the column alone.

**The authorization step, stated because it is the one thing in this task that must never be skipped.** `updateCase` and `addNote` take a bare reference and write; neither knows who is asking. Every mutation resolves through `findCase` first — that is what applies the scope — in one shared helper rather than at five call sites, which is the whole lesson of `adminCanSeeCase_` being correct and being applied by hand until somewhere forgot. There is a test that every one of the five refuses a case outside the caller's queue *and writes nothing*.

**R5 turned out to be wider than it was written.** A teacher loses the use of the bot two ways — `/revoke`, and their roster row being deactivated or removed — and only the first is a `Revoked` state. The warning is driven by `teacherHasAccess`, which is the single answer to both, rather than by a comparison against `verification_state`.

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

- [x] **Step 2: Implement. Step 3: Commit**

**The third test above needed rewording, because in this architecture nothing can report a failed notification at the moment of assigning.** Delivery happens after the commit, in `deliver`, which is the only thing that learns whether Telegram accepted a message. What `/assign` can do is name what the message was, so a failure is reported as *"a notice that a case has been assigned to somebody"* rather than as the vague fallback — which is R10, done at Task 31. The test asserts the `purpose` is set.

**Two things not in the sketch.** `/assign` writes a `CASE_ASSIGNED` audit row, because D18 lists case assignment among the privileged actions and `recordAudit` propagates its errors — an assignment that cannot be recorded does not happen. And assigning a case to *yourself* sends no notification: it is the commonest use of the command, and being messaged about your own action is noise.

---

### Task 45: `/region` `/mark` `/due` `/snooze`

The commands over Tasks 43 and 44. **Built after Task 35.**

**Files:** Modify `src/telegram/commands/cases.ts`, `src/telegram/commands/staff.ts`

- [x] **Step 1: `/region <chat_id> <region|clear>`** at `teacher.region` — `Lead` and above. Clears `region_flagged_at` when it acts, so the flag means "reported and not yet dealt with" rather than "reported once, ever".

- [x] **Step 2: `/regions`** — the flag list. Without it, a teacher's report has a writer and no reader, which is the pattern the backward audit of this plan exists to stop.

- [x] **Step 3: `/mark <ref> Normal|Urgent|Critical`**, `/due <ref> <date>`, `/snooze <ref> <days>`. `/mark` is at `case.mark` rather than `case.update`, following D7's table — the plan text said `case.update` and the capability table is the source.

- [x] **Step 4: `/case` shows all four fields** — importance, promised date, snooze, and who set the region — or R15 stands and the columns are invisible until Stage 5.

- [x] **Step 5: Tests.** 19 in `region.integration.test.ts`, 20 added to `mutate.integration.test.ts`, 12 added to `parse.test.ts`.

- [ ] **Step 6: Commit**

**Three things the sketch did not say, each of which is a hole the sketch's own reasoning opens.**

**`/region` checks both ends of the move, not only the destination.** The named test asks that a Samarkand lead be unable to push a teacher into Bukhara. Refusing only the destination still lets them *pull* a teacher out of Bukhara into Samarkand, which is the same act of taking work from the person holding it seen from the other side. Both are refused. A teacher with **no** region recorded is covered by everybody, because D10 already says an unknown region hides a case from nobody — without that carve-out the teachers whose region is least certain become the ones nobody may correct. The consequence is deliberate and is stated in the refusal: **a cross-region move needs somebody who covers both regions**, which in practice is a `Lead` with no region set, or `Program`/`System`.

**A region the system has never heard of is refused, listing the ones it knows** (`knownRegions`). A typo written happily puts a teacher in a province no staff member covers: their cases visible only to all-region staff, routed nowhere, and wrong in a way nothing reports. The typed region is also canonicalised to the roster's spelling, so `tashkent` is stored as `Tashkent` — visibility already compares case-insensitively, so that is legibility rather than correctness, but two spellings on screen is how a person concludes there are two places.

**`/due` refuses `15/08/2026` rather than guessing.** Day-first and month-first are both in ordinary use and disagree for the first twelve days of every month, and a date read the wrong way round is not visibly wrong — it is a promise to a teacher on the wrong day. Two forms are accepted, `2026-08-15` and `15 Aug 2026`, and the refusal names the ambiguity rather than saying "invalid". The parsed instant is the **end** of that day in Tashkent: parsed as midnight, every promise would land five hours into the previous day for everyone who reads it, and a case promised for today would look broken the moment it was promised.

---

### Task 46: Asking the teacher whether their region is still right

Implements D21's teacher-facing half — the only teacher-visible change in this stage.

**Files:** Modify `src/telegram/router.ts`, `src/telegram/keyboards.ts`, `src/telegram/handlers/menu.ts`

- [x] **Step 1: Ask rarely, and only where it is relevant**

Shown when the chat is verified, `REGION_CONFIRM_AFTER_DAYS` have passed since the last confirmation, and the teacher is at the main menu — never in the middle of describing a case, and never as a blocker. Two buttons: *Yes, still right* / *No, I have moved*.

**This needed a column and therefore a second migration in the stage** — `drizzle/0007_region_asked_at.sql`, one `ADD COLUMN`, generated and verified against an empty database as well as an incremental one. Task 42's "one migration for the whole stage" could not hold: nothing in the schema could answer "when did we last ask", and without it Step 2's *does not ask again the next day* cannot be implemented at all. `regionFlaggedAt` does not serve — it means "reported wrong, not yet dealt with", and it is cleared when staff act.

**The stamp is written when the question is SHOWN, not when it is answered**, and that is the whole design of the cadence. Stamped on answer, a teacher who ignores the question is asked again on every visit to the menu — the nagging D21 rules out. Stamped on show, everyone is asked at most once per interval whether they answer or not, and an ignored question returns later rather than never. `REGION_CONFIRM_AFTER_DAYS` is **180**.

**Asked on `/start` and the Main Menu button only, not on the fallback paths.** `mainMenuReply()` is reached from a dozen recovery branches — a withdrawn answer, an unknown topic, an expired state — and it is documented as the one thing that cannot itself fail. It is unchanged. Interrupting a recovery with an unrelated question is the blocking behaviour D21 rules out.

**A teacher with no region recorded is not asked.** There is nothing to confirm, D21's question is "is *this* still right", and their cases are already visible to every staff member (D10) — over-routed rather than misrouted, which is the less urgent of the two failures and not one this question can fix.

- [x] **Step 2: "No" writes nothing but a flag**

```ts
it('does not change the region when a teacher says it is wrong', async () => {
  // D21. The teacher is the best source of the signal and the worst source of
  // the record — region decides who receives their emergency, so a menu of
  // regions is a menu of "who gets my problem". They report; staff decide.
  await tapRegionWrong(CHAT);
  expect(await regionFor(db, CHAT)).toBe('Tashkent');
  expect(await listRegionFlags(db, ANY_MANAGER)).toContainEqual(expect.objectContaining({ chatId: CHAT }));
});

it('does not ask again the next day', async () => { /* … */ });

it('never interrupts a teacher part-way through a case', async () => { /* … */ });
```

**Also asserted, and the second one is the reason the first is safe:** the question arrives *beside* the menu and never instead of it, so a teacher who ignores it has lost nothing; and **a tap from a chat with no teacher row is answered exactly as a teacher's tap is**, because the button survives in scrollback for ever, arrives from the network, and saying "no such teacher" would tell a stranger whether we hold a record. Neither answer can move a case, so neither needs a guard against a replayed tap.

**One behaviour not in the sketch:** "still right" clears an outstanding mismatch flag. A teacher who reported a move that nobody acted on, and who now says the record is correct, has withdrawn the report — leaving it raised keeps it on `/regions` as work a manager was asked to do by somebody who no longer wants it done.

- [x] **Step 3: Two new callback prefixes** through `encodeCallback`, and the byte-ceiling assertion extended to cover them — one place measures callback data and the suite asserts the worst realistic payload with real values. `REGION_CONFIRMED` (`ROK`) and `REGION_MOVED` (`RMV`), both carrying **no parts at all**: a payload naming a region would make this a picker, which is the one thing D21 forbids.

- [x] **Step 4: Run the full router suite.** This adds a branch to the teacher path, which is finished and working; the router tests are what will catch a mistake. **694 tests across 42 files, none skipped.** The migration was additionally applied to an empty database to prove the deploy path, not only the incremental one.

- [ ] **Step 5: Commit**

---

### Task 36: Staff management — `/staff` `/staff_add` `/staff_role` `/staff_remove` `/revoke` `/restore`

Implements D14, D18, the second half of D17, and **D27**.

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

- [ ] **Step 3: `/revoke <chat_id>` and `/restore <chat_id>`**, both at `teacher.revoke` — D17's command half and D27. `restoreTeacher` joins `revokeTeacher` in `src/teachers/repository.ts`; the commands are thin over both.

  The same rank on purpose. Whoever can make the mistake can undo it without escalating, because a recovery that needs a second person is a recovery that waits until Monday.

```ts
it('gives a wrongly revoked teacher their access back', async () => {
  // D27. Before this the only route was a database session over the SSH
  // tunnel, for what is an ordinary mistake.
  await run(`/revoke ${TEACHER}`);
  expect(await canUseBot(TEACHER)).toBe(false);
  await run(`/restore ${TEACHER}`);
  expect(await canUseBot(TEACHER)).toBe(true);
});

it('does not let a restore be faked by signing in again', async () => {
  // The reason /restore has to exist at all. `bindTeacher` clears revoked_at,
  // so prompting a revoked teacher to sign in would let them undo their own
  // revocation — which is why requireSignIn refuses them instead. That refusal
  // is load-bearing and this test is what keeps it.
  await run(`/revoke ${TEACHER}`);
  await teacherTypes('/start');
  await teacherTypes(IDENTIFIER);
  expect(await canUseBot(TEACHER)).toBe(false);
});

it('says so, and changes nothing, when the teacher was never revoked', async () => {
  // R16, second order. An audit trail with entries for events that did not
  // happen is worse than a short one.
  const outcome = await run(`/restore ${TEACHER}`);
  expect(outcome).toMatch(/not revoked/i);
  expect(await auditRowsFor(TEACHER)).toHaveLength(0);
});

it('warns when the roster is the reason they are locked out, not the revocation', async () => {
  // R16, and the failure this command must not have. A teacher whose roster
  // row was deactivated is still `Verified` and still fails teacherHasAccess,
  // because the gate re-checks the roster live (D17). /restore cannot help
  // them — recruitment has to put the row back — and reporting success while
  // they stay locked out is worse than having no command.
  await deactivateRosterRow(IDENTIFIER);
  await run(`/revoke ${TEACHER}`);
  const outcome = await run(`/restore ${TEACHER}`);
  expect(outcome).toMatch(/roster/i);
  expect(await canUseBot(TEACHER)).toBe(false);
});

it('reports the teacher’s open cases both ways', async () => {
  // R5. Revoking somebody with open cases strands a staff member replying to
  // a teacher who cannot read it; restoring them is the moment those cases
  // become answerable again, and the person doing it should know.
});
```

  `/restore` writes `verification_state = 'Verified'`, clears `revoked_at` and `revoked_by`, and records `TEACHER_RESTORED` (D18). It touches **nothing else** — not `identifier`, not `region_override`, not the privacy-acceptance columns. Restoring somebody undoes one act; it does not re-run their sign-in.

- [ ] **Step 4: Commit**

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
  - §6.1 — the capability table, re-expressed against the five ranks `Observer/Support/Lead/Program/System`, recording that the rank once called `Regional` is now `Lead` precisely because it was never the region axis, and that a MoPSE "regional admin" is usually `Support` with a region set (D7). The teacher-facing job title "Regional admin" stays as it is, and §6.1 should say so, or the next reader will "correct" it
  - §6.4, §6.5 — command names (D14), and the command list: nineteen becomes eighteen, minus two deferred (D19), plus `/mark` `/due` `/snooze` `/region` `/regions` (D20, D22, D23) and `/restore` (D27)
  - **§6.5 — define `Action required` as "the teacher must do something" (D26)**, in those words, next to the command that writes it. This is the row D25 flagged as the weak joint; it has been answered and the document is where the answer has to live, because the phrase is ambiguous to anyone reading it cold and the wrong reading routes work to the wrong person
  - **§7.1.3 — "archive" becomes "delete" (D28).** The word appears throughout and is now wrong: resolved ordinary cases are removed after seven days, urgent and critical after six months, the interaction log after three days, and an unresolved case is never removed at all. Name the three periods rather than referring to a settings key
  - **§4.2, §12 — the retention paragraph.** It currently rests on `RETENTION_DAYS` being unset. Every sentence that says "until a period is decided" is now false
  - **§10 — rewrite.** It describes the Apps Script Forms flow as current, including the pre-filled chat id. D24 keeps Forms and changes how a submission is identified; the `FORMS` tab and roster-email matching replace `FORM_URLS` and the prefill entirely
  - **§1 — the non-goal about uploads is now correct rather than aspirational**, and should say so; `RUNBOOK.md` Part 6 says the opposite and is the one that changes
  - §6.2 — queue and region as one SQL predicate; the seven FAQ-topic mappings deleted as structurally impossible (Task 24)
  - §5.1 — **correct the revocation claim** (D17)
  - §7.1.1 — notification, now built
  - §8.1.1, §13 — the group gate, now true
  - §16 — move `/announce` and `/export` into the deferred list with D19's reasoning

- [ ] **Step 2: `RUNBOOK.md`**
  - §1.2 — the launch gate moves: the staff half exists
  - §2.4 — `/maintenance` replaces the SQL, and the launch settings insert gains the three retention keys seeded at 7, 180 and 3 (D28). Unseeded, the job deletes nothing — which is the safe direction, and is also why it will look like it is not working
  - **new §2.5** — bootstrapping the first System member (D13)
  - §4.3 — **rewrite.** It currently describes revocation that does not happen. Add `/restore` and, in the same paragraph, **the one thing it cannot fix**: a teacher locked out because their *roster row* went is not revoked and `/restore` will not help them — recruitment has to put the row back (D27, R16). Two causes with one symptom is how an operator wastes an afternoon
  - §4.4 — `/generate_urgent_code` replaces the hand-written `INSERT`
  - §4.5 — `/maintenance on`
  - **new §4.6a — what the four case words mean**, written for staff rather than for engineers, with `Action required` defined as **a request to the teacher, never a note to ourselves** (D26). Record that a taxonomy of action types is coming and that until it does, `/await` carries free text — so whoever builds it finds the decision instead of inventing a second one
  - **§4.7 — delete it.** The monthly content review runs two 30-day queries over a table that now keeps three days (R18). Leaving it would have somebody run it in November, get an empty result, and read that as "no problems". If the signal is wanted back, it comes from a nightly roll-up, and that is a Stage 5 item — not a longer period
  - **new §4.11 — changing a retention period.** The three keys, what each governs, and the two rules that go with them (D28): unset deletes nothing, and *lengthening* a period requires the privacy notice to be re-accepted while shortening one does not. Written for whoever will actually type it, with the warning that these are not ordinary settings — they govern deletion, there is no undo, and the notice teachers read is generated from them
  - **new §4.10 — changing a teacher's region**, and the fact that correcting the spreadsheet now reaches teachers who already signed in, which it never did (R12)
  - Part 3 — smoke-test steps below
  - **Part 6 — correct the document entry.** It calls Telegram upload "the only genuinely new feature in the rebuild"; under D24 there is no upload. What arrives is a `FORMS` tab and submissions matched by recruitment email
  - **Part 1 §1.3 — every open decision can now be marked settled.** All four original questions are answered: the observer rank, the `Regional`→`Lead` rename, the case-status vocabulary (D25, D26) and retention (D28). Nothing in that list stays open
  - **The retention entry states the four rules and their consequence.** An unresolved case is kept for ever; a resolved one goes after seven days, or six months if it was marked urgent or critical; the interaction log goes after three days. Say plainly what the first consequence is, because an operator will meet it in week two: **a week after a case is closed, its reference stops resolving.** A teacher telephoning about `VISA-2026-00123` gets "no such case", and there is nothing for `/reopen` to reopen
  - **A note for whoever owns the spreadsheet:** the bot reads two tabs. If the original document is reused, the other six are inert and should be deleted — especially `ADMINS`, which used to grant administrator rights and now does nothing at all. A tab that looks like it works and does not is worse than no tab

- [ ] **Step 3: `CONCERNS-AND-IT-ACTIONS.md`**
  - A2 — correct the revocation sentence
  - A4 — two System members, now with the commands to manage them
  - A7 — close the "left for you" half; the ops chat is still required (D12)
  - B3 — unchanged, re-pointed at Stage 5
  - **A11 — close it, and correct what it says.** The constraint it worries about is `ON DELETE restrict` on `cases.teacher_chat_id`, which refuses the deletion of a **teacher** who has cases. It never blocked deleting a case, and `case_notes` cascades from one. D28 deletes cases; anonymisation is what a teacher's *own* removal request needs, and that is the distinction A11 currently blurs
  - **A10 — close it.** All four periods are decided (D28). Record the two consequences rather than only the numbers: the monthly content review does not survive three days (R18), and publishing the periods requires re-consent from every teacher who accepted the current notice (R17)
  - **new B11 — regions were never correctable.** Recruitment's spreadsheet edits reached nobody who had already signed in, and no command existed. Recorded as closed by Task 43, because the lesson is the one B4 already teaches: a column with a writer and no reader looks exactly like a working feature

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
3. **A code issued by command is spent by a teacher.** `/generate_urgent_code`, give the code to the test account, file an urgent case. `used_at`, `used_by` and `case_reference` are all set, `issued_by` names a real person rather than `'0'`, and the case's `importance` is `Urgent`.
4. **A region correction arrives.** Change the region on `deploy-check@mopse.uz` in the roster tab, wait for the sync, and confirm `/case` on that teacher's case shows the new region. This has never worked and the runbook has always said it did.

**4. Revocation now bites.** After the deploy, deactivating a roster row ends that teacher's access on their next message (D17). Anyone who deactivated rows expecting today's no-op behaviour should be told before the deploy, not after.

---

## Four answers this plan needed — three are now given

These came out of the 29 July design session and were not settled in it. Three were answered on 29 July, before Task 23 was written; the fourth belongs to Stage 5 and is still open.

| # | Question | Blocks | Answer |
|---|---|---|---|
| 1 | **The observer rank's name** — "Jstaff" was asked for, `Observer` was the placeholder | Task 42, Task 23 | ✅ **`Observer`.** The word states the permission to anyone who reads it. See D7 |
| 2 | **Whether to rename the `Regional` rank** so one word does not mean two things | Task 42 | ✅ **Renamed to `Lead`.** Region remains a separate setting; the teacher-facing job title "Regional admin" is untouched. See D7 |
| 3 | **How the four working states map to the eight case statuses** | Task 34 | ✅ **The eight stay; four commands write four of them.** See D25, including the one row that is a judgement call |
| 4 | **Retention for ordinary cases, and for the message log** — six months covers urgent and critical only | Stage 5, not this stage | ⬜ **Still open.** `CONCERNS` A10 stays red. The message log is the one filling up now |

One more, raised and unanswered, that blocks nothing: **should the bot tell a teacher who their regional manager is**, by name and possibly by phone? It would answer "teachers who do not know who to call" directly, and it publishes staff contact details to 1,800 people. A MoPSE decision.

## Open items this plan deliberately does not close

- **`audit_log` has no reader.** By decision (D18). It is queried during an investigation by somebody with database access, and a command to read it would need a permission model to stop it becoming the thing it audits.
- **`case_notes` is new content with no retention rule.** It holds staff writing about teachers and is covered by the same unset `RETENTION_DAYS` as everything else (A10). Stage 5's clean-up job must include it; the `ON DELETE CASCADE` on the case is what makes that possible.
- **Announcements and export remain absent** (D19), and `CONCERNS-AND-IT-ACTIONS.md` B3 stays open until Stage 5.
- **The overdue digest is not pushed.** `/urgent` reads `OVERDUE_DAYS`, but nothing arrives unasked until Stage 5. `staleCases()` and `casesPastDue()` are both written here so that stage adds a schedule, not a query.
- **Staff notification volume is bounded at twenty** (R9). Past that it belongs in the worker, which is the same threshold `/announce` will have to respect.
- **`RETENTION_DAYS` is still unset**, and now there are more tables holding more content — `case_notes` among them. What changed is that erasure is no longer blocked: removal means anonymisation, which the database permits and which satisfies the notice. `CONCERNS` A11 closes; A10 narrows to the two periods still unnamed.
- **Nothing chases a missed date until Stage 5.** `due_at` is written and shown from the first day; a date that passes is visible to whoever looks and to nobody else. The same position `OVERDUE_DAYS` has been in since Stage 2, stated rather than implied.
- **The resignation route is not built.** A teacher submitting a resignation, unlocked case by case by a Program-rank member, with the record anonymised three months later, is agreed and belongs after this stage. Recorded here so the three-month timer is designed with the retention job rather than bolted onto it.
