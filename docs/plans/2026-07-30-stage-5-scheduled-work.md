# Stage 5 Implementation Plan — Scheduled work, retention, and bulk egress

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the system act without being asked. Everything built so far happens because somebody typed something; four things that have to happen on their own do not happen at all. Records are kept for ever against a notice that promises otherwise, a promised date passes and nobody is told, MoPSE cannot reach 1,800 teachers at once, and a teacher who asks to be removed cannot be.

**Architecture:** Built leaves-first, as Stages 3 and 4 were, with one new shape. Every piece of scheduled work is **composed in the worker task** out of pure formatting and single-statement stores — the task is the only thing that knows about both the database and Telegram, which is what keeps a store from importing the layer above it. Nothing new runs inside the webhook.

**Tech Stack:** Unchanged — TypeScript on Node 22, grammY, PostgreSQL 17 via Drizzle, graphile-worker, Vitest.

**Baseline:** 778 tests across 47 files, none skipped; typecheck, build and `deps:check` clean, at `d38c639`. 64 source files, 47 test files, no cycles.

---

## ▶ Where this stands — 30 July 2026, first session

# 🟡 **Layers 0, 1 and 2 are built and committed. No command and no scheduled job exists yet, so nothing in this stage runs on its own.**

```
922 tests across 56 files, none skipped · typecheck clean · build clean · deps:check clean
```

Verified by a full run against a live database at `cb791f2`, not inferred. The baseline was 778 across 47 files, so this is **+144 tests and +9 files**. The working tree is clean.

**What that means in plain terms:** every rule this stage needs is written and tested, and none of it is reachable by a person or a clock yet. Nothing deletes anything, nothing arrives at seven in the morning, and no teacher sees any change. That is the correct half-way state for a leaves-first build and it is not a half-built feature.

| Task | What | State |
|---|---|---|
| — | **Q1, Q2, Q3** | ✅ **answered 30 July — see below. Nothing is open** |
| 47 | One migration for the whole stage | ✅ `cb791f2` — `drizzle/0008_retention_and_chasing.sql`, both paths proven |
| 48 | Retention vocabulary, and the re-consent rule | ✅ `src/config/retention.ts` |
| 49 | The privacy notice, generated from the periods | ✅ `src/config/privacy.ts`; the stage 3 test inverted, as R17 said |
| 50 | The CSV writer | ✅ `src/export/csv.ts` |
| 51 | `sendDocument` | ✅ `src/telegram/send.ts` |
| 52 | Digest and chase wording | ✅ `src/digest/format.ts` |
| 53 | Announcement audience vocabulary | ✅ `src/announcements/audience.ts` |
| 54 | Reading the three periods | ✅ `src/config/settings.ts` — **pulled forward**, see the departures |
| 55 | The purge functions | ✅ `src/retention/purge.ts` |
| 56 | The nightly content roll-up | ❌ **not built — Q1 answered no** |
| 57 | Recording a privacy acceptance | ✅ `src/teachers/privacy.ts`, and `bindTeacher` writes the periods |
| 58 | `forgetTeacher` | ✅ `src/teachers/forget.ts` |
| 59 | The announcement store | ✅ `src/announcements/store.ts`; **needed an enum value** — see below |
| 60 | Chase queries, and the counter reset | ✅ `queries.ts` + `service.ts`; the reset is inside `updateCase` |
| 61 | `/retention` | ⬜ |
| 62 | `/announce` `/announce_send` `/announce_cancel` `/announcements` | ⬜ |
| 63 | `/export` | ⬜ |
| 64 | `/forget` | ⬜ |
| 65 | The teacher's re-consent gate | ⬜ |
| 66 | Telling a teacher who their regional manager is | ⬜ **Q2 answered yes — name and Telegram username** |
| 67 | The retention job | ⬜ |
| 68 | The daily digest job | ⬜ |
| 69 | The announcement sweeper | ⬜ |
| 70 | The layer rule, mechanically enforced | ⬜ **droppable** |
| 71 | Correct every document this stage makes wrong | ⬜ |

### Two faults found by building, both by running things rather than by reading

1. **The audience freeze did not run at all.** `audienceWhere` is built from drizzle column references, which render as fully-qualified `"teachers"."verification_state"`, and the `INSERT … SELECT` around it had aliased its tables — so PostgreSQL could not resolve the names and rejected the statement outright. The same class of trap `visibility.ts` documents one row along, and it fails at the database where neither the typechecker nor a reading can see it.

2. **`delivery_state` had no `Sending` value, and this plan assumed one.** Without it there is no way to *claim* a recipient, so two overlapping sweeps would both read the same `Pending` rows and message that teacher twice — the one failure a broadcast to 1,800 people must not have. Added to `0008` as `ALTER TYPE … ADD VALUE`, which is additive; the migration was regenerated and both paths reproven. **This is a change to the schema that this document did not anticipate**, and it is recorded here rather than quietly folded into D45.

### Four deliberate departures so far

Each has its reason at the site, and none should be reverted.

1. **Task 54 was pulled forward**, out of the stated build order. Task 49 changes `privacyNotice`'s signature and its callers cannot compile without the settings reader, so the two are one change — splitting them would leave typecheck broken across a task boundary, which this project does not accept.
2. **`SETTING` spreads `RETENTION_SETTING` from `retention.ts`** rather than declaring the three keys a second time. Two lists that have to agree with nothing enforcing it is precisely the fault `status.ts` was created to fix.
3. **`forgetTeacher` reports three outcomes, not two.** `alreadyForgotten` is kept apart from `notFound`, because reporting "no such teacher" for somebody removed last month sends an operator looking for a row that is behaving exactly as it should.
4. **The chase tests are a new file** (`src/cases/chase.integration.test.ts`) rather than additions to the two existing ones. The reset lives in `service.ts` and the queries in `queries.ts`, so either home would have split one behaviour across two files.

Also: the three `RETENTION_DAYS` tests in `settings.integration.test.ts` are **re-pointed at `OVERDUE_DAYS` rather than deleted**. What they pin is the *reader* — fallback, read-back, and cache-drop-on-write — and all three are still worth having.

**Read `docs/plans/2026-07-29-stage-4-handoff.md` first.** It records what is built, the twenty-six deliberate departures from the Stage 4 plan, and the environment traps.

---

## What this stage is not

**Documents are Stage 6.** D24 keeps Google Forms; the `FORMS` tab and the response sync are not built here. `sendDocument` arrives in this stage (Task 51) because `/export` needs it, and it is deliberately the *only* half of document handling that lands — the bot still never accepts or stores a file.

**The resignation route is not built.** Decision 9 of `2026-07-29-staff-and-lifecycle-design.md` — a resignation option unlocked per teacher by a Program member, with the record anonymised three months later — is later than this stage. What it needs from here is one function it can call, and Task 58 is written so it exists (`forgetTeacher`), rather than being buried inside a command.

**No command reads `audit_log`.** Still D18's decision, still for D18's reason.

**Nothing is anonymised on a timer.** `/forget` is a command a person runs after a request. The three-month automatic timer belongs with the resignation route that produces it.

---

# Three questions, all answered on 30 July 2026

Two were reserved for the head of project by §8 of the handoff; the third was found while writing this plan. All three blocked Task 47, because two changed what is in the migration and the third changes what teachers see. **Nothing is open.** The answers are recorded here with what each one costs, so they stay decisions rather than becoming accidents.

### Q1 — The nightly content roll-up: ❌ **no**

Three-day retention on the interaction log killed `RUNBOOK.md` §4.7, the monthly content review. That review answered two questions: **what are teachers asking that the answer bank cannot cover**, and **which confident answers are teachers rejecting** — which the runbook itself called "the strongest signal available". The recovery offered was a nightly roll-up into counts, taken before the delete, keeping nobody's words.

**Declined.** The stage is one table and one task smaller. Task 56 is not built.

**The cost, recorded because nobody should rediscover it in November.** Past three days those two questions cannot be answered at all. The `ANSWER_HELPFUL` rows added in Stage 3 — added specifically so the answer bank could learn what was working — go back to having no reader. `RUNBOOK.md` §4.7 stays deleted, and Task 71 records that the roll-up was offered and declined rather than leaving the deletion looking like an oversight.

**It remains available later.** Nothing in this stage forecloses it; it would be one table and one step in a job that will already exist.

### Q2 — Telling a teacher who their regional manager is: ✅ **yes — name and Telegram username**

Raised during Stage 4 and never answered. Nothing depended on it then, so it was withdrawn rather than left blocking.

**A username rather than a telephone number, which is the better answer and would have been the recommendation.** It is tappable inside the app the teacher is already in, it publishes no personal telephone number, and a staff member can change it themselves without anybody editing a database. It needs a column on `staff`, which is why it had to be settled before Task 47.

**What it publishes, stated plainly:** the name and Telegram handle of a named ministry employee, to 1,800 people, in a chat each of them keeps on their phone. It cannot be unpublished, and it creates an expectation that whoever is named answers.

**Two consequences that are not obvious and are traced as R33 and R34:** a Telegram username that is changed becomes claimable by anybody, so a stale column can point 1,800 teachers at a stranger — which is why Task 66 verifies the handle still resolves to the same person rather than trusting the column. And a teacher who can message a manager directly will sometimes do so instead of opening a case, which moves work out of the system that records it.

### Q3 — How far the re-consent gate reaches: ✅ **gate cases, leave the answer bank open**

Setting the retention periods changes what teachers were told, so 1,800 people must read the notice again.

**Decided:** the notice is shown before Contact Support, Urgent Case and Check My Case. The FAQ, `/privacy`, `/help` and `/start` are untouched. One tap, once, and the teacher lands back on what they were trying to do.

**Why this and not the alternatives:** it matches what the bot already does — the answer bank has always been open, and maintenance mode deliberately leaves it running — and it is the only option that produces a record saying a named teacher confirmed a specific version on a specific date. "We showed it to them" is not that record, and the notice they signed up under promised they would be *asked*.

**The cost, stated rather than buried:** a teacher in an emergency taps once before reaching the code prompt. Their code is not spent until the case is actually filed, so the tap costs them nothing they cannot recover.

This is D32, and R21 traces it.

---

# Decisions recorded

Continuing D1–D28 from the Stage 3 and Stage 4 plans. D28 is the parent of most of what follows and is not restated.

### D29 — Retention ships as one release, and the release is five things

**Decision:** the deletion job, the three settings, the notice generated from them, the bumped wording version, and the re-consent gate are built in this stage and deployed together. No part of it goes out alone.

**Why:** R17. The notice already tells every teacher who has signed in *"Until the Ministry sets a retention period. When one is set, this notice will be updated and you will be asked to read it again."* Any subset is a false statement in one direction or the other — a job with no notice deletes data against a promise to keep it, a notice with no job promises deletion that nothing performs, and a notice nobody re-accepted is a commitment made on somebody's behalf.

**What this rules out:** shipping the job first "to stop the tables growing" and the notice later. The tables have grown for four stages and one more week costs nothing next to publishing a period nobody was asked about.

### D30 — Unset means delete nothing, and a bad value means delete nothing

**Decision:** `retentionPeriods(db)` returns `{ caseDays, urgentCaseDays, messageDays }` where each is `number | null`. `null` means **delete nothing of that class**, and it is returned for a missing row, an empty string, a non-integer, a zero and a negative.

**Why:** exactly the rule `overdueDays` already follows for `OVERDUE_DAYS`, and for a stronger version of the same reason. A job that invents a period deletes real records against a number nobody chose, and there is no undo. A zero is the dangerous one: read as a number it means *delete everything closed*, and it is one keystroke away from a typo.

**Consequence, stated because it will be reported as a bug:** at launch, before the runbook's settings insert has been run, the job runs nightly and deletes nothing. That is the safe direction and it looks exactly like a job that does not work. The job therefore logs and reports what it did, including "nothing, because no period is set", and `/retention` with no arguments says so in those words.

### D31 — Re-consent is computed from the periods, never remembered by a person

**Decision:** a teacher must accept again when **either** the notice's wording version has changed, **or** any current period is *longer* than the one they accepted. Shortening never triggers it. The comparison is made from values recorded on the teacher's row, not from a version string somebody remembered to bump.

Three new nullable integer columns on `teachers` record what was accepted. `null` means "accepted while that class was kept indefinitely", and indefinite is the longest period there is — so a teacher who accepted the current notice and is then given a 7-day period has been given a *shortening*, which is why the periods alone do not force the re-consent. The wording change does.

**Why not a hash of the notice text:** it is the obvious cheap answer and it is wrong in a way that costs 1,800 taps. Any hash changes when a period is shortened, and D28 says plainly that shortening breaks no commitment and must not force a re-consent. A hash cannot express an asymmetric rule.

**Why not leave it to `PRIVACY_NOTICE_VERSION` alone:** because the notice is now generated, its text can change without a deploy, and R17 predicted exactly this — *"this ripple fires again every time somebody edits one, and next time silently, because nobody will be watching for it."* A rule in code cannot forget; a person editing a settings row can.

`PRIVACY_NOTICE_VERSION` keeps its name and now versions **the wording only**. That is recorded in the file, because the next reader will otherwise assume it covers the numbers too.

### D32 — The gate stands where `requireSignIn` already stands, and reuses its resume

**Decision:** subject to Q3 — the re-consent check runs in front of Contact Support, Urgent Case and Check My Case, and nowhere else. The FAQ, `/privacy`, `/help` and `/start` are untouched.

The accept button carries the wording version **and the three periods it was shown with**. If either has moved between the notice being shown and the button being tapped, the notice is shown again rather than an acceptance being recorded for text the teacher never saw. It fits in a callback payload with room to spare — `PRIV:2026-07-30.1:7-180-3` is 26 characters against a 64-byte limit.

**Why the resume matters:** `AwaitingIdentifier` already carries a `resumeAction`, and a teacher who signs in lands on what they were trying to do. The gate reuses it, so the extra tap costs one tap and never costs a teacher their place. Building a second resume mechanism beside the first is how the two drift.

### D33 — Nine tables hold data and nothing deletes any of it

**Decision:** the retention job covers every table below. **No new settings are invented for them** — each is tied to a period already chosen, or to a stated reason for keeping it.

| Table | What it holds | Rule | Why that rule |
|---|---|---|---|
| `cases` | The teacher's own words | 7 days after `closed_at`, or 180 if `importance` is not `Normal` | D28 |
| `case_notes` | Staff writing about teachers | Cascades from the case | D8's `ON DELETE CASCADE` |
| `messages` | The interaction log | `MESSAGE_RETENTION_DAYS` | D28 |
| `conversation_states` | **A teacher's typed question**, on the abandoned path | `MESSAGE_RETENTION_DAYS` after `expires_at` | Same class of content as `messages`. Deleting an **expired** row changes no behaviour — an expired state is already treated as absent (D4) |
| `urgent_code_attempts` | A chat id and a time, per wrong guess | `MESSAGE_RETENTION_DAYS` | Meaningful only inside a 60-minute window. Nothing has ever deleted one |
| `processed_updates` | An update id | 24 hours | `pruneProcessedUpdates` already exists, already has this default, and has **never had a caller** |
| `sync_runs.rejections` | **Teacher email addresses**, every ten minutes, for ever | The jsonb is scrubbed to `[]` after `MESSAGE_RETENTION_DAYS`; the row stays | `rows_rejected` is a separate count column, so the operational signal survives the scrub. One duplicate roster row puts that address into 144 rows a day |
| `announcement_recipients` | 1,800 chat ids per announcement | 30 days after `finished_at` | After a month, per-person delivery state answers no question anybody asks |
| `announcements` | What MoPSE told teachers | **Never pruned** | Audit-class: staff-written, sent to everybody, contains no teacher's words |
| `urgent_codes` | Who authorised an emergency, and for whom | **Never pruned** | Audit-class, same argument as `audit_log`. The schema already states it outlives the case, which is why it has no foreign key |
| `audit_log` | Who granted what | **Never pruned** | D28 |
| `job_runs`, `case_sequences` | One row per job; one per prefix and year | **Never pruned** | Bounded. See R31 on why the sequence table must survive a deletion |

**Why not a setting each:** nine settings is a control panel nobody can hold in their head, and the notice has to state the rules in a sentence or two. Three periods are three sentences. Twelve are a document.

**Why this is in the plan rather than left to the job:** four of these hold personal data and the notice is about to make a promise that covers it. A notice saying "the messages you send are kept for three days" while a teacher's abandoned question sits in `conversation_states` for ever is exactly the class of fault this rebuild exists to remove — a document describing behaviour the code does not have.

### D34 — `RETENTION_DAYS` is deleted, not renamed

**Decision:** the key is removed from `SETTING` in the same commit as the three that replace it, and the runbook says so.

**Why:** it has never been read by anything, and D28 already replaced it with three keys because one number cannot carry three promises. A renamed key would leave a plausible-looking value in a production settings table that nothing consumes — which is the same failure as a spreadsheet tab that looks like it works.

### D35 — Deleting a case is not a `service.ts` operation

**Decision:** the deletion lives in `src/retention/purge.ts`. `src/cases/service.ts` remains the one write path for *fields on a case*, and gains a comment pointing at the new file.

**Why:** `service.ts` exists so that no caller hand-rolls a write and drifts. That argument is about changing a case, and it is why every function there takes a reference. A delete that took a reference would be reachable from a command, and **a command that can delete a case by reference is a command that deletes the wrong case** — with no undo, and with `case_notes` cascading out from under it. The purge takes no reference at all: it takes the periods and a clock, and it is called by one job.

### D36 — Scheduled work is composed in the worker task

**Decision:** each new job is a thin task in `src/worker/tasks/` that reads the database through stores and speaks to Telegram through `send.ts`. No store imports anything above it.

**Why, concretely:** the retention job needs `pruneProcessedUpdates`, which lives in `src/telegram/dedup.ts` — layer 3 by directory, a store by nature. A retention module importing it would be an upward edge, and moving the function would separate it from `claimUpdate`, which is the other half of the same idea. The job composes both instead, because the job is above both. The same shape keeps digest wording pure (`src/digest/format.ts` takes rows and returns strings) and testable with no database and no network.

### D37 — Every scheduled job records a run; nothing on demand ever does

**Decision:** `recordJobRun` wraps the retention job, the digest job and the announcement sweeper. It does **not** wrap anything triggered by a person.

**Why, and this is a fault caught by reading the heartbeat rather than by building:** `checkHeartbeats` alarms on any row in `job_runs` whose last success is older than 1.5 times its expected interval. A row for an on-demand job would therefore raise a critical alarm on the operations chat **every hour in which nobody sent an announcement** — which is most hours. The alarm that exists to make silence audible would have become the noisiest thing in the channel, and the fix people reach for is to stop reading it.

**Consequence for announcements, and it is a better design than the one it replaces:** there is no "send this announcement" job to enqueue. `/announce_send` marks the announcement `Queued`, and a **scheduled sweeper** picks it up. One path, watched by the heartbeat, and resumable after a restart by construction rather than by a second mechanism.

### D38 — The crontab is UTC, whatever the container says

**Decision:** absolute-time entries are written in UTC with the Tashkent time in a comment beside them. The digest at 07:00 Tashkent is `0 2 * * *`.

**Why — verified, not assumed:** `graphile-worker`'s cron matcher digests a timestamp with `getUTCHours()` and `getUTCMinutes()` (`node_modules/graphile-worker/dist/cron.js`, `digestTimestamp`). `docker-compose.yml` sets `TZ: Asia/Tashkent` on both services, which changes `Date#getHours()`, the logs and every `AT TIME ZONE` reader — **and does not change cron matching at all.** A digest written the obvious way, as `0 7 * * *`, arrives at noon.

This has not bitten anything yet because both existing entries are intervals (`*/10`, `*/5`), which are indifferent to the zone. The digest is the first absolute-time job in the system. `TIMEZONE` in `constants.ts` warns about exactly this failure — *"the 07:00 digest would arrive at noon"* — and the container's timezone setting makes it look handled.

Uzbekistan is UTC+5 all year and has no daylight saving, so a fixed offset is safe here in a way it would not be in most places. That is recorded so nobody copies the pattern somewhere it breaks twice a year.

### D39 — The digest is per person, scoped, and only to people who can act

**Decision:** one message per active staff member holding `case.update`, containing **their own** scoped lists — the cases they own that are past due, the stale cases in their queue and region, and the unowned cases in it. Built by evaluating the existing queries once per member with that member's scope.

**Why not one message to the operations chat:** a queue-and-region system whose daily summary ignores queue and region teaches everybody that most of the message is not theirs, and the whole point of `visibleToStaff` is that no question asked of the case queries returns a case the asker may not see.

**Why not Observers:** R14. Somebody who cannot reply, close or take a case is being paged about work they are not permitted to do. It is the same filter new-case notification already applies, for the same reason, and reusing the capability rather than the visibility rule is what keeps them from drifting.

**A staff member with nothing due gets nothing.** A daily message that says "nothing to do" is a daily message people filter, and then they filter the one that matters.

### D40 — Chasing the teacher is capped, and the cap resets in one place

**Decision:** a case at `Action required` whose teacher has not been chased for `TEACHER_CHASE_AFTER_DAYS` (3) is sent one reminder naming the case and what was asked for — which is already in `public_update`, because `/await` writes it there. At most `TEACHER_CHASE_MAX` (3) reminders. After the last one, **the case's owner is told the teacher has stopped responding**, and nothing chases again.

Two new columns on `cases` carry it, and **both are reset inside `updateCase` whenever the status changes** — the same place and the same shape as `closed_at` in the fix that Stage 4 made.

**Why the reset is in `updateCase` and not in `/await`:** because leaving `Action required` and re-entering it both mean the clock restarts, and `updateCase` is the one write path that sees every status change. Putting it in the command would mean a second command that writes a status later inherits nothing — which is precisely the hole that let a reopened case keep its `closed_at`.

**Why chase the teacher and not the staff member:** D26. A case at `Action required` is waiting on the teacher; the staff member holding it is correctly doing nothing. A digest that nags people about work they are not permitted to move is a digest they learn to ignore, which costs the cases that genuinely are theirs.

**Why it stops, and why stopping is told to somebody:** three unanswered reminders is a teacher who has left, changed number, or given up. That is exactly the situation D26 built `/close <ref> unresolved <reason>` for, and until now nothing would ever have told a staff member it had happened.

### D41 — An announcement freezes its audience at draft, and skips whoever has since lost access

**Decision:** `/announce <text>` writes the `announcements` row **and every `announcement_recipients` row**, then reports the exact count to the sender. `/announce_send <id>` marks it `Queued`. At send time each recipient is re-checked with `teacherHasAccess`; anybody who now fails is marked `Skipped` and is not messaged.

**Why freeze at draft rather than at confirmation:** the flaw the schema describes is that the old version *"counted the audience once to show the sender a preview, then looked it up again when sending"*, so the number approved was not the number that received it. Freezing at the preview is the only version where those two numbers are the same one.

**Why re-check anyway:** a draft can sit for a day. Messaging a teacher whose access was revoked this morning because the list was frozen last night is the frozen list being wrong in the other direction. `deliveryStateEnum` already has `Skipped` for this, and the report distinguishes all three — *"1,780 sent, 15 skipped because they no longer have access, 5 could not be reached"*.

### D42 — An announcement is sent in batches, and no job run is long

**Decision:** the sweeper sends at most `ANNOUNCEMENT_BATCH` (200) recipients per run, runs every minute, and returns. 1,800 teachers take about nine minutes across nine runs.

**Why, and it is R27:** the worker is deliberately `concurrency: 1`. A single job run that paces itself through 1,800 sends — longer still if Telegram rate-limits it — occupies the only worker slot for minutes, during which the ten-minute sync and the five-minute heartbeat do not run. The heartbeat is the thing that notices stopped jobs, so the first symptom would be a **false alarm that the sheet sync has stopped**, raised by a heartbeat that was itself late. Short runs make the question moot rather than answered.

### D43 — `/export` is a management report, and carries no teacher's words

**Decision:** a CSV of the cases visible to the asker — reference, category, status, importance, region, owner, created, updated, due, closed. **Not `detail`, not `public_update`, not the teacher's name.** Scoped by `visibleToStaff`, written to an audit row, and named with the date it was taken.

**Why the words are left out:** `/case` shows them, checks permission first and leaves a row saying who read them. A file has none of those properties: it lands in a Telegram chat, syncs to that person's devices, is forwardable, and outlives the retention job that was built to delete the very text inside it. Bulk egress of a teacher's account of their own problem is a different act from a staff member reading one case, and the system should not make them the same command.

**If a report of the words is wanted, say so before Task 63.** It is a change to one column list and a conversation about where the file is allowed to go — not a redesign. Recorded as a decision rather than a question because there is a clearly correct default and the stage should not wait on it.

### D44 — `/forget` is System-only, and what it cannot remove is stated plainly

**Decision:** `/forget <chat_id> <the word FORGET>` at a new capability `teacher.forget`, floored at **System**. It clears the teacher's name, recruitment identifier, both regions and the privacy columns, sets them `Revoked`, deletes their interaction-log rows and any conversation state, and writes an audit row. Case history stays, which is decision 8 of the design session.

**Why System and not the rank that can revoke:** `/revoke` is reversible — that is the entire argument of D27, and `/restore` exists so the mistake is cheap. This has no undo whatsoever. There are two named System members by launch-checklist requirement, so a removal request reaching the support desk is escalated to one of two people, which for a request of this kind is the correct handling rather than an obstacle.

**The cost, stated because it is real:** a Support member who takes the request cannot action it themselves.

**What it does not remove, and this must be in the runbook rather than discovered:** the Telegram chat id survives, because every one of that teacher's cases points at it and the foreign key is what guarantees no case exists without a real person behind it. So does what they wrote in their cases. Both are honest limits, and retention closes most of the second one on its own — a resolved case goes in seven days, so the words disappear without anybody doing anything. Nobody should be told "removed" and understand something stronger than that.

**One function, not one command.** The resignation route (design decision 9) anonymises automatically after three months and will call `forgetTeacher` directly. Writing the logic inside the command would mean writing it twice.

### D45 — One migration for the whole stage, and Stage 4 says why that is a claim to check

**Decision:** `drizzle/0008_retention_and_chasing.sql` carries everything, and the questions above have fixed what "everything" is — three accepted-period columns on `teachers`, two chase columns on `cases`, `telegram_username` on `staff` (Q2), and two indexes. **No roll-up table** (Q1).

**Why the answers blocked it:** Task 42 made exactly this claim for Stage 4 and it did not hold (departure 21) — Task 46 needed a column nothing in the schema could answer for, and a second migration was written. That was a good outcome handled properly, and it was cheaper to ask three questions first than to write `0009` in a week.

`drizzle-kit generate` has emitted a destructive `DROP TYPE` in this repository once already. **Read the SQL before accepting it**, rename the file, fix the journal tag, and prove the deploy path against an empty database as well as the incremental one.

### D46 — The layer rule gets a checker, and it is the one task that can be dropped

**Decision:** roughly thirty lines added to `scripts/dependency-tree.mjs`, failing on an import that points up the layers.

**Why now:** the architecture rests on one rule and everything else load-bearing in this project is a compile error when it breaks. This stage adds three new directories and the first modules whose natural shape is to reach upward — a retention module wanting `dedup.ts`, a digest module wanting a reply builder. D36 answers both by hand, and a checker is what stops the next answer being different.

**Why it is droppable:** nothing else depends on it, and dropping it leaves nothing half-built. It is last before documentation for that reason.

### D47 — A published Telegram username is verified, never trusted

**Decision (Q2):** `staff.telegram_username` is set by the staff member themselves through `/username`, and **the bot checks that the handle still resolves to that person's Telegram id** — once when it is set, and again in the daily job. A handle that no longer matches is cleared, the staff member and the operations chat are told, and until it is fixed the teacher is shown the name and the support contact instead.

**Why a check and not a column:** a Telegram username is not an identifier, it is a *label a person can release*. When somebody changes theirs, the old handle becomes claimable by anybody. A stale column would therefore not degrade to "nobody answers" — it would degrade to **1,800 teachers being pointed at a stranger by the ministry's own bot**, which is a worse failure than the one the feature fixes, and it would be completely silent. The check is one API call against a value that changes about never, and it turns a silent wrong answer into an alarm.

`api.getChat('@handle')` returns the chat; comparing its id to `staff.telegram_id` is the whole test. Verifying on set is the courtesy — the staff member gets told immediately that they typed it wrongly. Verifying daily is the guarantee, because the failure appears months later without anybody acting.

**What is deliberately not done:** the bot does not read the username from Telegram and keep it current by itself. `getChat` by numeric id does not reliably return a username for a user the bot has not seen recently, and a mechanism that silently sometimes works is worse than one a person maintains. `/username` is one command and staff already manage themselves through commands.

**The cost that has no technical answer, recorded once (R34):** a teacher who can message a manager directly will sometimes do that instead of opening a case. That work then has no reference, no queue, no record and no retention rule. The wording sends anything needing a record back to Contact Support, and wording is the only control there is.

---

# The pipeline audit — backward and forward

Stage 4's instruction was to check the pipelines in both directions. The same audit, redone for this stage, is the reason several tasks exist.

## Backward — built in an earlier stage, consumer never written

| Built | Thing | Consumers today | Endpoint this stage gives it |
|---|---|---|---|
| Stage 2 | `announcements`, `announcement_recipients` | **nothing at all** | `/announce` and the sweeper |
| Stage 2 | `announcementStatusEnum` — six values | none | Draft, Queued, Sending, Sent, Failed, Cancelled all reachable |
| Stage 2 | `deliveryStateEnum` — including `Skipped` | none | `Skipped` is what D41 needs |
| Stage 2 | `pruneProcessedUpdates` | **tests only** | The retention job. This is the twelfth row of Stage 4's eleven-row audit |
| Stage 2 | `settings.RETENTION_DAYS` | in `SETTING`, read by nobody | **Declared dead.** Deleted (D34) |
| Stage 3 | `teachers.privacy_notice_accepted_at`, `privacy_notice_version` | written at sign-in, **read by nobody** | The re-consent gate |
| Stage 4 | `cases.due_at`, `snoozed_until` | `/due`, `/snooze`, `/case` | The chasing digest |
| Stage 4 | `casesPastDue` | **tests only** | The digest |
| Stage 4 | `staleCases` | `/urgent` | The digest, on a schedule |
| Stage 4 | `cases.importance`, `isRetained` | `/mark`, `/case` | The retention job — the one thing standing between "six months for urgent" and a job that treats every case alike |
| Stage 4 | `cases.closed_at` | written by `updateCase` | The retention job measures from it |
| Stage 4 | `CAPABILITY.ANNOUNCE`, `CAPABILITY.EXPORT` | `/whoami` lists them as "no command for this yet" | `/announce`, `/export` |
| Stage 4 | `cases_chasing_idx` | none — added for this stage | The chase query, written against exactly its three columns |

**The one that is still not connected:** `regionFlaggedAt` has `/regions` and needs nothing here.

## Forward — Stage 5 must leave these open

| Owner | Thing | What Stage 5 must do |
|---|---|---|
| Stage 6 | The `FORMS` tab and the response sync (D24) | Nothing. `sendDocument` is added for `/export` and must not grow a receive path |
| Stage 6 | `CASE_CATEGORY.SUBMIT_DOCS` | Keep the queue map total. The digest and the export must not enumerate categories anywhere |
| Later | The resignation route (design decision 9) | Leave `forgetTeacher` as a callable function with its own tests, and its three-month timer unwritten (D44) |
| Later | The `/await` taxonomy (D26) | The teacher's chase message reads `public_update` verbatim, so a taxonomy that later structures that text changes the chase's *input*, not the chase |
| Stage 7 | Launch readiness | Three settings seeded before the first teacher is served, or the job deletes nothing and the notice says so |

## Endpoint check — where each pipeline terminates

| Pipeline | Starts | Terminates today | Correct terminus | Closed by |
|---|---|---|---|---|
| Retention | A case is closed | **nowhere — the row is immortal** | Deleted on a period MoPSE chose | Tasks 55, 67 |
| The privacy promise | A teacher accepts a notice | A column nobody reads | A teacher asked again when the promise changes | Tasks 57, 65 |
| A promised date | `/due` | Visible to whoever looks | Whoever holds the case is told the morning it passes | Task 68 |
| A stale case | Nobody touches it | `/urgent`, if somebody types it | The same list, arriving unasked | Task 68 |
| `Action required` | `/await` | The teacher is told once | The teacher is reminded, and their silence is reported | Tasks 60, 68 |
| Reaching every teacher | — | **no mechanism** | A paced, resumable, reported broadcast | Tasks 59, 62, 69 |
| Case data out | — | One case at a time via `/case` | A scoped report, audited, with no teacher's words | Task 63 |
| A removal request | A teacher asks | **impossible** | Name and identifier gone, history kept, limits stated | Tasks 58, 64 |
| The interaction log | Every message | Grows for ever | Three days, and nothing kept beyond it (Q1) | Task 55 |
| "Who do I call?" | A teacher with a problem | The support address, for everybody | The named person covering their province | Task 66 |

---

# The dependency tree

Read downward: everything above depends on everything below it. Nothing in a layer may import from a layer above it. Checked against `docs/dependency-tree.md` at `d38c639`, not asserted.

```
Layer 5  documentation
         BOT-SPEC §4.2 §6.5 §7.1.3 §12 · RUNBOOK §2.4 §4.7 §4.11 Part 3 · CONCERNS A10 B3
              │
Layer 4  scheduled work — the only place that knows both the database and Telegram
         retention job ── daily digest job ── announcement sweeper
              │                  │                    │
Layer 3  commands and the teacher-facing gate
         /retention                                   ← maintenance (System)
         /announce /announce_send /announce_cancel     ← announce
         /announcements                                ← announce
         /export                                       ← export
         /forget                                       ← teacher.forget (System, new)
         /username                                     ← any active staff row, own row only
         re-consent gate · "who is my manager"          · teacher-facing
              │
Layer 2  stores (database, no Telegram)
         retention period reader ── the purge functions ── privacy acceptance
         forgetTeacher ── announcement store ── the region-manager lookup
         chase queries + markTeacherChased ── updateCase's counter reset
         existing: staleCases, casesPastDue, visibleToStaff, pruneProcessedUpdates
              │
Layer 1  leaves (no database, no network)
         retention vocabulary + the re-consent rule ── the generated notice
         CSV writer ── sendDocument ── digest wording ── audience vocabulary
              │
Layer 0  the migration (Task 47), then everything already built and unchanged
         send · alerts · constants · roles · queues · status · importance
```

**Three edges that are easy to get backwards.**

1. **The notice depends on the retention vocabulary, not the reverse.** Task 48 before Task 49. `privacy.ts` must not read the database — it is pure today and the re-consent rule has to be testable without one.
2. **`sendDocument` is a leaf.** `src/telegram/send.ts` imports nothing inside `src/`, and that is why `/export` can depend on it from layer 3 without a cycle. Task 51 sits in Layer 1 for that reason and not by accident.
3. **The retention job depends on `pruneProcessedUpdates`; the purge module must not.** D36. The job composes; the store stays where it is.

**Legend for the gap hunt:** everything marked *existing* is built and tested. There is no branch of this tree that depends on Stage 6 or 7 — checked deliberately, because Stage 3's plan claimed that of itself and was wrong.

**The one backward dependency:** the chase message renders `public_update`, whose *content* will change shape when the `/await` taxonomy arrives (D26). It renders it as text and must not parse it.

---

# Ripple analysis

Continuing R1–R18. Each chain is traced outward until nothing further moves.

### R19 — A deleted case is a reference that stops resolving

Retention deletes a resolved case → its reference no longer exists → `/reopen` has nothing to reopen, `/case` says "no such case", Check My Case stops listing it, and a teacher telephoning about `VISA-2026-00123` is told it does not exist.
**Terminates at:** D28, which accepted this explicitly, and at the runbook saying so in the words an operator will need in week two.
**Already handled, and worth knowing:** `appendUrgentFollowUp` returns false when the case has gone and `service.ts` already documents why — *"a case can be removed by retention between the dedup read and this write."* Written before the job existed, and correct.

### R20 — The notice's numbers can change without a deploy

The notice is generated from settings (D28) → a period is edited → the text every teacher reads changes → the version they accepted still says `2026-07-28.1` → nothing anywhere notices that they accepted different numbers.
**Terminates at:** D31. The accepted periods are recorded beside the accepted wording, and the rule compares them.
**Not fixed by:** hashing the notice, which forces a re-consent on a shortening — the one change D28 says must not force one.
**Second order:** `/retention` must warn, before it writes, that lengthening a period will ask 1,800 people to read the notice again. A System member changing 7 to 30 to keep records a little longer should not discover that from the outbound message count.

### R21 — A gate in front of an emergency

The re-consent gate blocks Urgent Case → a teacher with a spent code and a real emergency meets a privacy notice → they tap through it unread, or they give up and telephone.
**Terminates at:** one tap, once, with the resume mechanism putting them straight back on the urgent path, and Q3 putting the choice where it belongs. The code is not spent until the case is filed (`URGENT_CODE_TTL_HOURS`, and the "not used up until their case is actually filed" wording in `/generate_urgent_code`), so the tap costs them nothing they cannot recover.
**Not fixed by:** exempting the urgent path. That is the one path that collects a teacher's account of an emergency, so it is the last one to collect it without consent.

### R22 — The alarm for silence becomes the loudest thing in the channel

An on-demand job records a run → `job_runs` gains a row with an expected interval → `checkHeartbeats` compares last success against 1.5× that interval → nobody sends an announcement for two hours → **a critical alarm on the operations chat saying the announcement job has stopped**, repeated hourly.
**Terminates at:** D37. Only scheduled work records a run, and announcements are driven by a scheduled sweeper rather than an enqueued job.
**Found by reading `checkHeartbeats`**, which is the function that has already been silently broken twice — once by a `::float8` cast and once by an array interpolation. Anything added to `job_runs` is added to the thing that watches everything.

### R23 — 07:00 becomes noon

The digest is scheduled `0 7 * * *` → `graphile-worker` matches on `getUTCHours()` → the container's `TZ: Asia/Tashkent` changes logs and `AT TIME ZONE` readers but not cron → the digest arrives at 12:00 Tashkent, five hours after the working day starts.
**Terminates at:** D38, and a test asserting the mapping rather than a comment claiming it.
**Why nothing has caught it:** both existing entries are intervals. This is the first absolute-time job in the system, and `constants.ts` names this exact failure in its warning about the timezone.

### R24 — Teacher email addresses accumulate in the sync log for ever

Recruitment pastes a duplicate roster row → `parseRosterTab` rejects it with the identifier in `Rejection.value` → the rejection is stored in `sync_runs.rejections` → the sync runs every ten minutes → **144 rows a day, each containing that teacher's recruitment email**, until somebody fixes the spreadsheet. Nothing has ever deleted a `sync_runs` row.
**Terminates at:** D33 — the jsonb is scrubbed after the message retention period and the row is kept, because `rows_rejected` already carries the count the operational history needs.
**Collides with the notice:** the notice is about to promise that the messages a teacher sends are kept for three days. A teacher's address sitting in an operational log for a year is not that promise, and the promise is the thing that must not be false.

### R25 — An abandoned question outlives the conversation that held it

A teacher types a question and never picks a topic → `AwaitingQuestionTopic` stores their words in `conversation_states.payload` → the row expires after thirty minutes and is treated as absent → **the row is never deleted**, because D4 deliberately has nothing sweep this table.
**Terminates at:** D33 — delete only rows whose `expires_at` passed more than `MESSAGE_RETENTION_DAYS` ago. An expired state is already invisible to the router, so the delete changes no behaviour at all.
**What must not happen:** pruning on `updated_at`, or pruning unexpired rows. A teacher part-way through describing an urgent case has a state with a 24-hour life, and deleting it costs them a spent code and everything they had typed — which is the failure `URGENT_DETAIL_TTL_HOURS` exists to prevent.

### R26 — A pruner with a test and no caller

`pruneProcessedUpdates` was written in Stage 2, has an integration test asserting a 48-hour-old row is removed, and **is called by nothing in `src/`.** The table has grown by one row per Telegram update since the day it was built.
**Terminates at:** the retention job calling it. It is the twelfth entry in a backward audit that listed eleven, and it was found by grepping for callers rather than by reading the file — which is the same lesson every session here has produced.

### R27 — One long announcement starves everything else

`/announce_send` to 1,800 teachers → the worker is `concurrency: 1` → one job run paces itself through the fan-out, longer still under a Telegram rate limit → the ten-minute sync and five-minute heartbeat do not run → the first symptom is a **false alarm that the sheet sync has stopped**, raised late by the heartbeat that was itself starved.
**Terminates at:** D42. Batches of 200, a run of a few seconds, nine runs.
**Second order:** the sweeper must be safe to overlap with itself if a run is slow — the batch claim is a single conditional `UPDATE` marking rows `Sending`, not a read followed by a write.

### R28 — A file leaves the system and outlives everything that governed it

`/export` produces a CSV → it lands in a Telegram chat → it syncs to that person's devices, is forwardable, and is not covered by any retention period → a report taken today still holds cases the job deleted a week ago.
**Terminates at:** D43 — no teacher's words in it, `visibleToStaff` applied so a Lead cannot export another region, an audit row naming who took it and how many rows, and the date in the filename so a stale file is obviously stale.
**Not fixed by:** a permission check alone. The permission governs the act of exporting; nothing governs the file afterwards, which is why what goes into it is the only control that holds.

### R29 — Chasing somebody who cannot answer

The chase finds a case at `Action required` → the teacher was revoked, or their roster row went → the reminder is sent to somebody who cannot use the bot → it either fails or arrives and cannot be acted on.
**Terminates at:** the chase query applying `teacherHasAccess`'s two conditions, and skipping rather than failing. A skipped chase still counts as nothing having happened, so the case's clock does not advance and the staff member is told when the reminders run out — which is the honest outcome, because a revoked teacher at `Action required` is a case that should be closed unresolved.

### R30 — Deleting a case must not let a reference be reissued

Retention deletes `VISA-2026-00482` → a later case allocates its reference from a scan of existing rows → the reference is reissued and two different cases have shared one number.
**Terminates at:** `case_sequences`, which already prevents it, and which must never be pruned (D33). The Apps Script version derived the next number by scanning the sheet for the current maximum, which *"under-counted the moment the archive job moved rows out — and could therefore reissue a reference that was already in use."* The counter table was built for exactly this stage. Checked, and nothing moves.

### R31 — A spent urgent code pointing at a case that has gone

Retention deletes an urgent case → `urgent_codes.case_reference` still names it → `checkStrandedUrgentCodes` looks for a spent code with no case and raises a critical alarm.
**Terminates at:** nothing, because the column is deliberately not a foreign key and the check reads `case_reference IS NULL`, not "the case exists". The schema states the reason — *"this table outlives the retention window of an individual case"* — and it is correct. Traced because a deletion touching a table with an alarm on it is exactly where a false alarm comes from.

### R32 — `/forget` and the case its teacher still owns

`/forget` clears a teacher's identity → their open cases still exist and are still visible → a staff member replies to a case whose teacher row has no name and no identifier → `/case` renders "not recorded" where a name was, and `/reply` reaches a `Revoked` chat.
**Terminates at:** `/forget` reporting the open-case count exactly as `/revoke` does (R5), and refusing nothing — the cases must stay, because the history is what decision 8 keeps. `/reply` already warns when a teacher cannot receive.
**Second order:** the digest and the chase must both survive a nameless teacher. Neither reads `teachers.name` for anything except display, and the display must not assume it is there.

### R33 — A released Telegram username points teachers at a stranger

A staff member changes their Telegram handle → the old handle is released and can be claimed by anybody → `staff.telegram_username` still holds it → the bot shows 1,800 teachers a name beside a link to somebody else entirely → a teacher messages a stranger about a visa problem, believing they are messaging the ministry.
**Terminates at:** D47 — verify on set and verify daily, clear the column when it stops matching, and fall back to the name and the support contact. The alarm goes to the staff member *and* to the operations chat, because the staff member is the one person who already knows they changed it and therefore the least likely to act on being told.
**Why it is not a small risk:** every other stale value in this system degrades towards nothing happening. This one degrades towards the wrong thing happening, confidently, at scale, with the ministry's name on it.
**Second order:** the same check must run before an announcement or a digest quotes a handle. It does not, because neither does — only Task 66 renders one, and the check lives beside it.

### R34 — Work moves out of the system that records it

A teacher is shown their manager's handle → they message the manager directly instead of opening a case → the problem is dealt with in a direct chat → **no reference, no queue, no owner, no promised date, no retention rule, and nothing for the next person to read.**
**Terminates at:** nothing technical, and this is stated rather than solved. The wording sends anything needing a record back to Contact Support, and the manager can open a case on the teacher's behalf — but a message already sent cannot be routed backwards.
**Accepted knowingly.** It is the ordinary cost of naming a person, and it was chosen against the alternative of teachers not knowing who covers their province at all. Recorded so that a fall in case volume after this ships is read correctly rather than as an improvement.

---

# File structure

## New files

| File | Responsibility |
|---|---|
| `src/config/retention.ts` | The three keys, their defaults, `RetentionPeriods`, the validation, and `requiresReconsent`. Pure |
| `src/retention/purge.ts` | Every delete and the one scrub, each a single statement, each returning a count |
| `src/announcements/store.ts` | Draft, freeze, claim a batch, mark a recipient, finish |
| `src/announcements/audience.ts` | `all` and `region:<name>`, parsed and rendered. Pure |
| `src/digest/format.ts` | Every message this stage sends, built from rows. Pure |
| `src/export/csv.ts` | Quoting, escaping, and the formula-injection guard. Pure |
| `src/teachers/privacy.ts` | Reading and writing a teacher's acceptance |
| `src/teachers/forget.ts` | `forgetTeacher`, in one transaction |
| `src/telegram/commands/announce.ts` | `/announce` `/announce_send` `/announce_cancel` `/announcements` `/export` |
| `src/worker/tasks/retention.ts` | The nightly job |
| `src/worker/tasks/digest.ts` | The 07:00 job — staff digest and teacher chasing |
| `src/worker/tasks/announcements.ts` | The sweeper |
| `drizzle/0008_retention_and_chasing.sql` | Generated, read before it is accepted, renamed |

Test files alongside each, following the existing `.test.ts` / `.integration.test.ts` split.

## Modified

- `src/db/schema.ts` — three accepted-period columns on `teachers`; `teacher_chased_at` and `teacher_chase_count` on `cases`; `telegram_username` on `staff`; two indexes
- `src/config/privacy.ts` — `privacyNotice(supportContact, periods)`, generated; `PRIVACY_NOTICE_VERSION` bumped and re-documented as versioning the wording only
- `src/config/settings.ts` — `RETENTION_DAYS` deleted, three keys added (D34)
- `src/config/constants.ts` — `TEACHER_CHASE_AFTER_DAYS`, `TEACHER_CHASE_MAX`, `ANNOUNCEMENT_BATCH`, `DIGEST_LIST_CAP`, `EXPORT_ROW_CAP`
- `src/cases/service.ts` — `updateCase` resets the chase counters on a status change; `markTeacherChased`; a comment pointing at `retention/purge.ts` (D35)
- `src/cases/queries.ts` — `casesAwaitingTeacher`, and `casesPastDue`/`staleCases` given the owner filter the digest needs
- `src/staff/roles.ts` — `teacher.forget` at `System`
- `src/staff/repository.ts` — `setUsername`, `clearUsername`, and the region-manager lookup (Task 66)
- `src/telegram/commands/staff.ts` — `/forget`, and `/username` for a staff member to maintain their own handle (D47)
- `src/telegram/send.ts` — `sendDocument`, and `trySendDocument` if the export ever goes to more than one person
- `src/telegram/router.ts` — the re-consent gate in front of the three gated actions; the accept callback
- `src/telegram/handlers/menu.ts` — the re-consent reply and its button
- `src/telegram/keyboards.ts`, `src/telegram/callback-data.ts` — the accept button
- `src/telegram/commands/index.ts` — the new command registry entries
- `src/worker/main.ts` — three task registrations and three crontab entries
- `scripts/dependency-tree.mjs` — the layer rule (Task 70)
- `docs/dependency-tree.md` — regenerated
- `BOT-SPEC.md`, `RUNBOOK.md`, `CONCERNS-AND-IT-ACTIONS.md` — Task 71, in one pass, at the end

**Nothing else is edited mid-stage.** §8 of the handoff gives the reason: the three specification documents were made correct by Task 41, and a document edited a little at a time as code lands describes a system half-way between two states.

---

## Build order

Top to bottom, exactly as this document reads. **Task 56 is not built** (Q1), and its number is left in place rather than closed up so that anything referring to a task number still means what it said — the same rule Stage 4 applied to tasks 42–46.

`47 · 48 · 49 · 50 · 51 · 52 · 53 · 54 · 55 · 57 · 58 · 59 · 60 · 61 · 62 · 63 · 64 · 65 · 66 · 67 · 68 · 69 · 70? · 71`

---

# Layer 0 — the migration

### Task 47: One migration for the whole stage

Implements D45. Q1, Q2 and Q3 are answered, so the contents below are fixed.

**Files:** Modify `src/db/schema.ts`; create `drizzle/0008_retention_and_chasing.sql`

- [ ] **Step 1: The columns**
  - `teachers.privacy_accepted_case_days`, `privacy_accepted_urgent_case_days`, `privacy_accepted_message_days` — `integer`, nullable. Nullable is meaningful: it records an acceptance made while that class was kept indefinitely (D31)
  - `cases.teacher_chased_at` — `timestamptz`, nullable
  - `cases.teacher_chase_count` — `integer not null default 0`
  - `staff.telegram_username` — `text`, nullable (Q2). The comment must say what D47 says: it is a label its owner can release, so it is verified rather than trusted, and a null means "not published" rather than "unknown"
  - **No roll-up table** (Q1)
- [ ] **Step 2: The indexes**
  - `cases_retention_idx` on `(closed_at, importance)` — what the nightly delete reads
  - `cases_teacher_chase_idx` on `(status, teacher_chased_at)` — what the chase reads
  - `cases_chasing_idx` already exists and is what `casesPastDue` reads. Do not add a fourth overlapping index; check the three before adding either of the above
- [ ] **Step 3: Generate, then read the SQL before accepting it.** Departure 5. Rename the file from its generated name and fix the `tag` in `drizzle/meta/_journal.json`
- [ ] **Step 4: Prove the deploy path**, against a throwaway database with no schema at all, not only the incremental one — the handoff §7 has the commands
- [ ] **Step 5: The comments carry the reasoning**, in the schema rather than in this plan. Every column above answers a question the schema could not answer before; a column with no comment is one the next reader deletes

---

# Layer 1 — leaves (no database, no network)

### Task 48: Retention vocabulary, and the re-consent rule

Implements D30 and D31. The most important pure module in the stage: it decides whether 1,800 people are asked to read something again.

**Files:** Create `src/config/retention.ts`, `src/config/retention.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe('parsing a period', () => {
  it('treats every unusable value as delete-nothing', () => {
    // D30. The dangerous one is '0', which read as a number means "delete
    // everything that is closed" and is one keystroke from a typo.
    for (const raw of [null, '', '  ', 'abc', '0', '-7', '7.5']) {
      expect(parsePeriod(raw)).toBeNull();
    }
    expect(parsePeriod('7')).toBe(7);
    expect(parsePeriod(' 180 ')).toBe(180);
  });
});

describe('requiresReconsent', () => {
  const periods = { caseDays: 7, urgentCaseDays: 180, messageDays: 3 };

  it('asks again when the wording changes', () => {
    expect(requiresReconsent(
      { version: '2026-07-28.1', periods },
      { version: '2026-07-30.1', periods },
    )).toBe(true);
  });

  it('asks again when a period is lengthened', () => {
    expect(requiresReconsent(
      { version: 'v1', periods },
      { version: 'v1', periods: { ...periods, caseDays: 30 } },
    )).toBe(true);
  });

  it('does NOT ask again when a period is shortened', () => {
    // D28: deleting sooner than promised breaks no commitment to anybody, and
    // forcing 1,800 people through a re-consent to be told their data goes
    // sooner is a cost with no beneficiary.
    expect(requiresReconsent(
      { version: 'v1', periods },
      { version: 'v1', periods: { ...periods, caseDays: 1 } },
    )).toBe(false);
  });

  it('treats null as the longest period there is, in both directions', () => {
    // Indefinite is longer than any number. A teacher who accepted the current
    // notice accepted indefinite retention, so giving them 7 days is a
    // shortening — which is why the wording bump, not the periods, is what
    // triggers this stage's one re-consent.
    expect(requiresReconsent(
      { version: 'v1', periods: { caseDays: null, urgentCaseDays: null, messageDays: null } },
      { version: 'v1', periods },
    )).toBe(false);

    expect(requiresReconsent(
      { version: 'v1', periods },
      { version: 'v1', periods: { ...periods, caseDays: null } },
    )).toBe(true);
  });

  it('asks again when nothing was ever recorded', () => {
    // Teachers bound before the columns existed have no recorded acceptance.
    // Inventing one for them is worse than admitting it.
    expect(requiresReconsent(null, { version: 'v1', periods })).toBe(true);
  });
});
```

- [ ] **Step 2: Implement.** `RETENTION_SETTING` with the three keys and their defaults (7, 180, 3); `parsePeriod`; `RetentionPeriods`; `isLongerThan(a, b)` where `null` is `Infinity`; `requiresReconsent`
- [ ] **Step 3: No database import, not even a type-only one.** This module has to be exercisable with three numbers and nothing else

### Task 49: The privacy notice, generated from the periods

Implements D28's mandatory half and R20. **`src/config/privacy.test.ts` currently asserts the notice names no period, and that test inverts here — in this commit, with the wording.** R17 says so explicitly.

**Files:** Modify `src/config/privacy.ts`, `src/config/privacy.test.ts`

- [ ] **Step 1: The tests, which are the whole point of the task**

```ts
describe('the retention paragraph', () => {
  it('states the numbers it was given and never a literal', () => {
    const notice = privacyNotice('support@mopse.uz', { caseDays: 7, urgentCaseDays: 180, messageDays: 3 });
    expect(notice).toContain('7 days');
    expect(notice).toContain('180 days');
    expect(notice).toContain('3 days');
  });

  it('says data is kept until a period is set, when one is not', () => {
    // D30's consequence, made visible to a teacher rather than implied.
    const notice = privacyNotice('support@mopse.uz', { caseDays: null, urgentCaseDays: null, messageDays: null });
    expect(notice).not.toMatch(/\d+ days/);
  });

  it('cannot disagree with the settings, because there is no second copy', () => {
    // The property the whole design rests on: grep the module for a typed
    // period and there must not be one.
    expect(privacyNoticeSource()).not.toMatch(/kept for \d/);
  });
});
```

- [ ] **Step 2: Bump `PRIVACY_NOTICE_VERSION`** to `2026-07-30.1`, and rewrite the comment above it: it versions **the wording**, the periods are recorded separately, and the asymmetric rule lives in `retention.ts` (D31)
- [ ] **Step 3: The wording.** Plain English, three sentences of retention, and it must be true of all twelve tables in D33 rather than of the three it names. "The messages you send are kept for N days" has to cover the abandoned-conversation and sync-log rows too, which is why D33 ties them to the same period
- [ ] **Step 4: Say what is kept for ever, and why.** A record of staff decisions about access, with no teacher's messages in it. A notice that lists only deletions and omits the permanent record is a notice that is quietly incomplete
- [ ] **Step 5: `signInPromptReply` and `privacyReply` both take the periods now.** Every caller of `privacyNotice` is a caller that must read them; the router already has `db`

### Task 50: The CSV writer

**Files:** Create `src/export/csv.ts`, `src/export/csv.test.ts`

- [ ] **Step 1: Tests** — a value containing a comma, a double quote, a newline and a leading `=`. Empty rows. A `null`
- [ ] **Step 2: The formula-injection guard.** A cell beginning `=`, `+`, `-`, `@`, tab or carriage return is prefixed with a single quote. A CSV opened in Excel executes such a cell, and although D43 keeps teachers' words out of the export, region names and staff names are still text somebody typed
- [ ] **Step 3: CRLF line endings and a UTF-8 BOM.** Excel on Windows reads a BOM-less UTF-8 file as the system codepage, which turns every Cyrillic and Latin-extended name into rubbish. The person opening this file is on Windows

### Task 51: `sendDocument`

**Files:** Modify `src/telegram/send.ts`; modify `src/telegram/send.test.ts`

- [ ] **Step 1: Tests** — a successful send returns a message id; a `403` becomes `blocked`; a rate limit carries `retryAfterSeconds`. The same classification the text path already has, because `classifyError` is shared
- [ ] **Step 2: `sendDocument(api, chatId, filename, contents, caption?)`**, throwing on failure exactly as `send` does. The file is built in memory — an export capped at `EXPORT_ROW_CAP` is a few hundred kilobytes and nothing writes to disk
- [ ] **Step 3: This is the only half of document handling that lands in this stage.** A comment saying so, because D24 says the bot never *accepts* a file and a `sendDocument` sitting alone invites its counterpart

### Task 52: Digest and chase wording

Implements D39, D40. Pure, so every message in the stage can be read in a test without a database or a network.

**Files:** Create `src/digest/format.ts`, `src/digest/format.test.ts`

- [ ] **Step 1: Tests** — a digest for somebody with cases in all three lists; one with cases in only one; the teacher's chase message; the "your teacher has stopped responding" message to an owner; the announcement report
- [ ] **Step 2: Nobody with nothing gets a message.** The formatter returns `null` for an empty digest, so the decision lives in one place and the job cannot send an empty one (D39)
- [ ] **Step 3: Every list is capped at `DIGEST_LIST_CAP` and says what it is not showing**, the same rule `STAFF_CASE_LIST_CAP` follows and for the same reason — a message that silently loses its tail is worse than one that says how much is missing
- [ ] **Step 4: The chase message quotes `public_update` verbatim and never parses it.** It is what `/await` wrote, it is the only case text a teacher ever sees, and a taxonomy will change its shape later (D26)
- [ ] **Step 5: Clamped.** These messages are built in the worker, so `reply()`'s clamp does not apply to them. A digest of twenty cases plus three headers is comfortably inside the limit, but the guarantee has to be in the code and not in the arithmetic

### Task 53: Announcement audience vocabulary

**Files:** Create `src/announcements/audience.ts`, `src/announcements/audience.test.ts`

- [ ] **Step 1: Tests** — `all`; `region:Bukhara`; `region:bukhara` canonicalised; `region:Nowhere` refused; an empty string refused
- [ ] **Step 2: Two audiences and no more.** `all` and `region:<name>`. The stored form is what goes in `announcements.audience`, and it is parsed back rather than re-derived
- [ ] **Step 3: A region is canonicalised against the same list `/region` uses** — `knownRegions` (departure 17). An announcement addressed to a province the system has never heard of reaches nobody and looks like it worked, which is the failure that rule already exists to prevent. The canonicalisation needs the database, so the pure half validates the *shape* and the store resolves the name

---

# Layer 2 — stores (database, no Telegram)

### Task 54: Reading the three periods

**Files:** Modify `src/config/settings.ts`; create `src/config/retention-settings.integration.test.ts`

- [ ] **Step 1: Delete `RETENTION_DAYS`** and add `CASE_RETENTION_DAYS`, `URGENT_CASE_RETENTION_DAYS`, `MESSAGE_RETENTION_DAYS` (D34). The doc comment on each says what it governs and that unset deletes nothing
- [ ] **Step 2: `retentionPeriods(db)`** returning all three through `parsePeriod`, so a bad value in one does not decide the others
- [ ] **Step 3: Tests** — all three set; one set and two unset; one set to `0`; one set to `abc`. Each asserts the *other two* are unaffected
- [ ] **Step 4: The settings cache is 60 seconds and that is fine here.** A nightly job reading a minute-stale period is not a hazard; `/retention` writes through `setSetting`, which drops the cached value, so the confirmation it prints is the value it wrote

### Task 55: The purge functions

Implements D33, D35. **The most dangerous code in this stage.** Every function deletes real records and nothing undoes any of it.

**Files:** Create `src/retention/purge.ts`, `src/retention/purge.integration.test.ts`

- [ ] **Step 1: Write the failing tests first, and write the ones that assert nothing is deleted before the ones that assert something is**

```ts
describe('deleteResolvedCases', () => {
  it('deletes nothing at all when the period is unset', async () => {
    // D30. The first test in the file, deliberately: this is the behaviour that
    // protects every record in the database from a settings row nobody set.
    await closeCase(db, 'VISA-2026-00001', { daysAgo: 400 });
    expect(await deleteResolvedCases(db, { caseDays: null, urgentCaseDays: null })).toEqual({ cases: 0 });
    expect(await caseExists(db, 'VISA-2026-00001')).toBe(true);
  });

  it('keeps an unresolved case for ever, however old', async () => {
    await openCase(db, 'VISA-2026-00002', { daysAgo: 900 });
    await deleteResolvedCases(db, { caseDays: 7, urgentCaseDays: 180 });
    expect(await caseExists(db, 'VISA-2026-00002')).toBe(true);
  });

  it('reads importance and NEVER status', async () => {
    // D22, R13, and the single most important assertion in the stage. A case
    // marked Critical that was resolved is `Completed`, and nothing about
    // `Completed` remembers it was an emergency.
    await closeCase(db, 'SUPPORT-2026-00003', { daysAgo: 30, importance: 'Critical', status: 'Completed' });
    await closeCase(db, 'SUPPORT-2026-00004', { daysAgo: 30, importance: 'Normal', status: 'Completed' });

    await deleteResolvedCases(db, { caseDays: 7, urgentCaseDays: 180 });

    expect(await caseExists(db, 'SUPPORT-2026-00003')).toBe(true);   // 30 < 180
    expect(await caseExists(db, 'SUPPORT-2026-00004')).toBe(false);  // 30 > 7
  });

  it('measures from closed_at, not from created_at or updated_at', async () => {
    await closeCase(db, 'VISA-2026-00005', { createdDaysAgo: 400, closedDaysAgo: 2 });
    await deleteResolvedCases(db, { caseDays: 7, urgentCaseDays: 180 });
    expect(await caseExists(db, 'VISA-2026-00005')).toBe(true);
  });

  it('takes the notes with the case', async () => {
    // D8's ON DELETE CASCADE. Notes hold staff writing about teachers and must
    // not outlive the case. Asserted rather than assumed, because the cascade is
    // in the schema and this is the only thing that depends on it.
    await closeCase(db, 'VISA-2026-00006', { daysAgo: 30 });
    await addNote(db, 'VISA-2026-00006', 'author', 'unreachable since March');
    await deleteResolvedCases(db, { caseDays: 7, urgentCaseDays: 180 });
    expect(await noteCount(db, 'VISA-2026-00006')).toBe(0);
  });

  it('leaves case_sequences alone, so a reference is never reissued', async () => {
    // R30. The Apps Script version scanned for the maximum and could reissue a
    // reference the moment the archive job moved rows out.
    const before = await sequenceValue(db, 'VISA', 2026);
    await deleteResolvedCases(db, { caseDays: 7, urgentCaseDays: 180 });
    expect(await sequenceValue(db, 'VISA', 2026)).toBe(before);
  });
});

describe('pruneConversationStates', () => {
  it('never touches a state that has not expired', async () => {
    // R25. A teacher part-way through an urgent case has a 24-hour state, and
    // deleting it costs them a spent code and everything they typed.
    await saveState(db, '111', { kind: 'AwaitingUrgentDetail', codeAccepted: 'ABC234', attempts: 0 });
    expect(await pruneConversationStates(db, 3)).toBe(0);
  });
});

describe('scrubSyncRunRejections', () => {
  it('empties the rejections and keeps the row and its count', async () => {
    // R24. The jsonb holds teacher email addresses; rows_rejected does not.
    const id = await recordSyncRun(db, { daysAgo: 30, rejections: [{ row: 4, reason: 'duplicate', value: 'a.karimov@example.com' }], rowsRejected: 1 });
    await scrubSyncRunRejections(db, 3);
    expect(await syncRunRejections(db, id)).toEqual([]);
    expect(await syncRunRowsRejected(db, id)).toBe(1);
  });
});
```

- [ ] **Step 2: Implement each as a single statement**, returning its row count. R2's argument applies with more force here than anywhere: this runs in a worker with no chat lock at all, so a read-then-delete would race a staff member closing a case
- [ ] **Step 3: `deleteResolvedCases` in one statement, both periods.** Two statements would mean a window in which the ordinary period had been applied and the urgent one had not — harmless in effect and impossible to reason about in a log. The `WHERE` is `closed_at IS NOT NULL AND ((importance = 'Normal' AND closed_at < now() - ...) OR (importance <> 'Normal' AND closed_at < now() - ...))`, with each branch dropped when its period is null
- [ ] **Step 4: A `PurgeReport`**, counted per table, returned rather than logged. The job logs it, the alert quotes it, and the test asserts against it
- [ ] **Step 5: Nothing in here takes a reference, and the file says why** (D35)

### Task 56: The nightly content roll-up — ❌ **not built**

**Q1 was answered no on 30 July.** Nothing is built and nothing is left half-built: no table, no module, no step in the retention job.

The number is kept rather than closed up, so that a reference to a task number still means what it said.

**What this costs is recorded at Q1 above and again in the open items**, and Task 71 records in the runbook that the roll-up was *offered and declined* — a deletion that looks like an oversight is one somebody restores by accident.

### Task 57: Recording a privacy acceptance

**Files:** Create `src/teachers/privacy.ts`, `src/teachers/privacy.integration.test.ts`

- [ ] **Step 1: Tests** — a teacher who has never accepted; one who accepted the current wording and periods; one who accepted a shorter period; one bound before the columns existed (all three null)
- [ ] **Step 2: `privacyAcceptance(db, chatId)`** returning `{ version, periods } | null`, and `recordAcceptance(db, chatId, version, periods)` writing all five columns in one statement
- [ ] **Step 3: `bindTeacher` must record the periods too**, or every teacher who signs in after this stage is immediately asked to re-accept what they just accepted. This is R11's shape one column-set along: `bindTeacher`'s `set` object is where a field is forgotten
- [ ] **Step 4: `/restore` must NOT touch these columns.** D27 already says restoring somebody is undoing one act rather than re-running their sign-in, and a `/restore` that cleared the acceptance would send that teacher through a re-consent nobody asked for

### Task 58: `forgetTeacher`

Implements D44 and design decision 8.

**Files:** Create `src/teachers/forget.ts`, `src/teachers/forget.integration.test.ts`

- [ ] **Step 1: Tests**

```ts
it('keeps the case history and clears the person', async () => {
  await forgetTeacher(db, CHAT, ACTOR);
  const teacher = await findTeacher(db, CHAT);
  expect(teacher?.name).toBeNull();
  expect(teacher?.identifier).toBeNull();
  expect(teacher?.verificationState).toBe('Revoked');
  expect(await caseCount(db, CHAT)).toBe(2);          // decision 8
  expect(await messageCount(db, CHAT)).toBe(0);       // their words, not case history
  expect(await stateExists(db, CHAT)).toBe(false);
});

it('leaves the audit trail intact', async () => {
  // D28 keeps audit_log for ever, and "who ended this person's access, and
  // when" is exactly the question it exists to answer — including this act.
  await forgetTeacher(db, CHAT, ACTOR);
  expect(await auditActions(db, CHAT)).toContain('TEACHER_FORGOTTEN');
});

it('is safe to run twice', async () => {
  await forgetTeacher(db, CHAT, ACTOR);
  expect(await forgetTeacher(db, CHAT, ACTOR)).toEqual({ found: false });
});

it('does not free the roster identifier for somebody else', async () => {
  // The roster row is recruitment's and is untouched. What goes is the link.
  await forgetTeacher(db, CHAT, ACTOR);
  expect(await rosterEntryExists(db, IDENTIFIER)).toBe(true);
});
```

- [ ] **Step 2: One transaction**, and `identifier` cleared *before* anything reads it. Returns what it found, so the command can distinguish "done" from "no such teacher" from "already forgotten"
- [ ] **Step 3: It does not delete the `teachers` row and cannot.** `cases.teacher_chat_id` is `ON DELETE restrict`, deliberately, and that constraint is the guarantee that no case exists without a real person behind it (CONCERNS A11). Anonymising is what satisfies both the constraint and the notice
- [ ] **Step 4: The residual is written in the file, not only in the runbook.** The chat id survives; so does what they wrote in their cases, until retention removes it. Anybody reading this function must see the limit before they describe it to a teacher

### Task 59: The announcement store

Implements D41.

**Files:** Create `src/announcements/store.ts`, `src/announcements/store.integration.test.ts`

- [ ] **Step 1: Tests**

```ts
it('freezes the audience when the draft is written', async () => {
  // The flaw in the schema's own words: the old version counted once for the
  // preview and looked it up again when sending, so the number approved was
  // not the number that received it.
  const { id, recipients } = await createDraft(db, { content: 'x', audience: 'all', createdBy: SYSTEM });
  await verifyNewTeacher(db, '999');
  expect(await recipientCount(db, id)).toBe(recipients);
});

it('excludes a teacher who cannot receive anything', async () => {
  await revokeTeacher(db, REVOKED, ACTOR);
  const { id } = await createDraft(db, { content: 'x', audience: 'all', createdBy: SYSTEM });
  expect(await recipientChatIds(db, id)).not.toContain(REVOKED);
});

it('claims a batch exactly once under two concurrent sweeps', async () => {
  // R27, second order. One conditional UPDATE, never a read then a write.
  const [a, b] = await Promise.all([claimBatch(db, id, 200), claimBatch(db, id, 200)]);
  expect(intersection(a, b)).toHaveLength(0);
});

it('resumes where it stopped', async () => {
  // The schema's second reason for this table: if the server stops at teacher
  // 900 of 1,800, delivery resumes at 901 and the first 900 cannot be messaged
  // twice.
  await markSent(db, id, first900);
  expect(await claimBatch(db, id, 200)).not.toContain(first900[0]);
});
```

- [ ] **Step 2: `createDraft` writes both tables in one transaction.** A draft with no recipients is an announcement whose preview count is a lie
- [ ] **Step 3: The audience read is the one place `teacherHasAccess`'s two conditions become SQL.** A revoked teacher and a teacher whose roster row went are both excluded, and there is a test for each — a broadcast is the largest possible way to get that check wrong
- [ ] **Step 4: `claimBatch` is `UPDATE ... SET state='Sending' WHERE state='Pending' ... LIMIT n RETURNING chat_id`.** Single statement, so two sweeps cannot claim one recipient
- [ ] **Step 5: `Failed` versus `Skipped` versus `Sent`, and `attempts`.** A retryable failure leaves the row claimable with `attempts` incremented; a permanent one is `Failed` with `last_error`; a teacher who has lost access is `Skipped`. `isRetryable` already makes that distinction and must be the only thing that does

### Task 60: Chase queries, and the counter reset

Implements D40.

**Files:** Modify `src/cases/queries.ts`, `src/cases/service.ts`; modify their integration tests

- [ ] **Step 1: Tests**

```ts
it('resets the chase counters when the status changes', async () => {
  // The same shape and the same place as the closed_at fix (8f2b84c). A case
  // that leaves Action required and comes back must start its clock again, and
  // updateCase is the one write path that sees every status change.
  await markChased(db, REF);
  await updateCase(db, REF, { status: 'Under review' }, ACTOR);
  expect(await chaseCount(db, REF)).toBe(0);
  expect(await chasedAt(db, REF)).toBeNull();
});

it('does not reset them when nothing about the status moves', async () => {
  await markChased(db, REF);
  await updateCase(db, REF, { publicUpdate: 'still waiting' }, ACTOR);
  expect(await chaseCount(db, REF)).toBe(1);
});

it('finds only cases at Action required whose clock is due', async () => { /* ... */ });

it('skips a teacher who cannot receive anything', async () => {
  // R29. A revoked teacher at Action required is a case to close unresolved,
  // not a case to chase.
  await revokeTeacher(db, TEACHER, ACTOR);
  expect(await casesAwaitingTeacher(db, 3)).toHaveLength(0);
});

it('stops after the cap and never counts past it', async () => { /* ... */ });
```

- [ ] **Step 2: `casesAwaitingTeacher(db, afterDays)`** — open at `Action required`, `teacher_chase_count < TEACHER_CHASE_MAX`, `teacher_chased_at` null or older than `afterDays`, not snoozed, and the teacher still has access. **Unscoped**, and that is the one query in `queries.ts` that is: it feeds a job, not a person, and there is nobody whose visibility it could apply. The file's guarantee is about questions a *staff member* asks, so this function must say so at its definition or it reads as a hole
- [ ] **Step 3: `markTeacherChased` lives in `service.ts`** — one statement, incrementing and stamping together. Two statements would let a crash between them chase somebody twice
- [ ] **Step 4: `casesPastDue` and `staleCases` gain an owner filter** so the digest can split "yours" from "in your queue" without a second query shape
- [ ] **Step 5: `casesExhaustedChasing(db)`** — cases at the cap whose owner has not been told. The digest tells them once, which needs a flag rather than a count; use `teacher_chase_count = TEACHER_CHASE_MAX + 1` as the "owner has been told" marker rather than adding a column, and say so at the site. A sixth column for a boolean that one query reads is not worth a migration

---

# Layer 3 — commands

### Task 61: `/retention`

**Files:** Modify `src/telegram/commands/ops.ts`; modify `src/telegram/commands/ops.integration.test.ts`

- [ ] **Step 1: Tests** — with no arguments it reports all three and changes nothing; `case 7` sets one; `case 0` is refused; `case abc` is refused with the current value restated; lengthening warns; every change writes an audit row
- [ ] **Step 2: `/retention` with no arguments is the common case**, exactly as `/maintenance` with no argument is. It prints the three periods, the retention paragraph the notice will show, and — when a period is unset — **that nothing of that class is being deleted**, in those words (D30)
- [ ] **Step 3: Lengthening states its cost before it writes**, and the write still happens. *"This will ask about 1,800 teachers to read the privacy notice again the next time they use the bot."* D28 makes the rule; a System member should not learn it from the send volume (R20)
- [ ] **Step 4: `MAINTENANCE` capability, which floors at System.** A period governs deletion with no undo, and the ladder already has the right rank for that
- [ ] **Step 5: An audit row per change** (D18), naming the key, the old value and the new one. "Who shortened this to one day, and when" is the question

### Task 62: `/announce` `/announce_send` `/announce_cancel` `/announcements`

**Files:** Create `src/telegram/commands/announce.ts`; register in `src/telegram/commands/index.ts`

- [ ] **Step 1: Tests** — a draft reports its exact frozen count; `/announce_send` on somebody else's draft; on an already-sent one; on a cancelled one; `/announce_cancel` after sending has begun; a non-existent id
- [ ] **Step 2: Four commands, one capability (`announce`, `Program` and above), and a two-step confirmation.** `/announce <text>` drafts and reports; `/announce_send <id>` queues; `/announce_cancel <id>` cancels. **Nothing sends on the first command**, because 1,800 messages is the least undoable thing in the system
- [ ] **Step 3: The draft's reply quotes the text back in full** and names the audience and the count. Somebody about to message 1,800 people should read what they wrote as the teachers will see it, not as they typed it
- [ ] **Step 4: `/announce_send` may only be run by the person who drafted it.** Not a permission question — a Program member who confirms somebody else's draft is confirming words they did not write
- [ ] **Step 5: `/announce_cancel` after `Sending` has begun stops the remainder and says how many had already gone.** A cancel that claims to have stopped something already delivered is worse than one that admits the number
- [ ] **Step 6: The interaction log gets the command word and the first argument only** — D16's prefix rule already covers `/announce ALL <message to 1,800 teachers>`, and `interactions.ts` names this exact command in its comment. Assert it rather than assume it

### Task 63: `/export`

Implements D43. **Depends on Task 51.**

**Files:** Same file as Task 62

- [ ] **Step 1: Tests** — the file contains only the asker's visible cases; a Lead's export omits another region; no column holds `detail` or `public_update`; an audit row is written; an empty result sends a message rather than an empty file
- [ ] **Step 2: The column list is a constant with a comment saying what is deliberately absent, and a test asserting it.** A column added later by somebody being helpful is how a teacher's words leave the system
- [ ] **Step 3: `visibleToStaff`, through `queries.ts`, never a query of its own.** The whole guarantee of that module is that no question asked of it returns a case the asker may not see, and an export is the largest question anybody asks
- [ ] **Step 4: Capped at `EXPORT_ROW_CAP` with the cap stated in the file and in the message.** A truncated report that does not say it is truncated is a report somebody plans from
- [ ] **Step 5: The filename carries the date and the scope** — `cases-2026-07-30-bukhara.csv`. A file in a chat is found again months later, and a stale one must look stale
- [ ] **Step 6: An audit row** naming the asker, the filter and the row count (D18). This is bulk egress and it is the one act in the stage that has no other trace

### Task 64: `/forget`

**Files:** `src/telegram/commands/staff.ts`; modify `src/staff/roles.ts`

- [ ] **Step 1: Tests** — without the confirmation word it explains and changes nothing; with it, it anonymises and reports; on an unknown chat id; on somebody already forgotten; from a Program member it is refused naming System
- [ ] **Step 2: `teacher.forget` at `System`** in the capability table. `CAPABILITY_INTERFACE` in `context.ts` is total over `Capability`, so `/whoami` and `/help` pick it up with no second edit — that property is why it is total, and it must not be "fixed" by trimming
- [ ] **Step 3: `/forget <chat_id> FORGET`.** The second word is typed, not tapped, and it is the same shape a database `DELETE` without a `WHERE` should have. Without it the command explains what will and will not be removed, and does nothing
- [ ] **Step 4: The reply states the residual** — the chat id stays, their case text stays until retention removes it, and their case history is kept on purpose (D44). Whoever runs this tells a teacher their data has been removed, and they must be able to say what that means
- [ ] **Step 5: The open-case count is reported**, as `/revoke` reports it (R5, R32)

### Task 65: The teacher's re-consent gate

Implements D31, D32. **The only teacher-visible change in this stage**, and it reaches all 1,800.

**Files:** Modify `src/telegram/router.ts`, `src/telegram/handlers/menu.ts`, `src/telegram/keyboards.ts`, `src/telegram/callback-data.ts`

- [ ] **Step 1: Tests**

```ts
it('asks a teacher who accepted the old wording, once', async () => { /* ... */ });

it('leaves the answer bank open', async () => {
  // The FAQ has always been open, and maintenance mode deliberately leaves it
  // running. A teacher looking up a public answer is not somebody we are
  // collecting anything from.
  const outcome = await route(db, { chatId: CHAT, kind: 'callback', text: 'MENU:FAQ' }, deps);
  expect(outcome.messages[0]!.text).not.toContain('Privacy notice');
});

it('returns them to what they were trying to do', async () => {
  // The resume mechanism AwaitingIdentifier already carries. A gate that costs
  // a teacher their place is a gate they meet twice.
  await route(db, { chatId: CHAT, kind: 'callback', text: 'MENU:URGENT_CASE' }, deps);
  const accepted = await route(db, { chatId: CHAT, kind: 'callback', text: `PRIV:${VERSION}:7-180-3` }, deps);
  expect(accepted.messages[0]!.text).toContain('one-time code');
});

it('shows the notice again when the periods moved under the button', async () => {
  // R20. Recording an acceptance for text the teacher never saw is worse than
  // one extra tap.
  await setSetting(db, 'CASE_RETENTION_DAYS', '30');
  const outcome = await route(db, { chatId: CHAT, kind: 'callback', text: `PRIV:${VERSION}:7-180-3` }, deps);
  expect(await privacyAcceptance(db, CHAT)).toBeNull();
  expect(outcome.messages[0]!.text).toContain('30 days');
});

it('does not ask a teacher whose periods were shortened', async () => { /* D28 */ });

it('does not ask an unverified chat anything', async () => {
  // They have accepted nothing and are about to be shown the notice by the
  // sign-in prompt, which is the acknowledgement. Two notices in a row is one
  // notice nobody reads.
});
```

- [ ] **Step 2: The check runs where `requireSignIn` runs**, on the same three actions, and returns a `RouterOutcome | null` in the same shape. One helper, called from the same three places, so a fourth action added later inherits it exactly as it inherits the sign-in gate
- [ ] **Step 3: The callback payload carries the wording version and the three periods**, and a mismatch re-shows the notice rather than recording anything (D32). Measure the payload against `CALLBACK_DATA_MAX_BYTES` in a test with real values, as the existing callback tests do
- [ ] **Step 4: The wording says what changed and what it means**, not "our privacy policy has been updated". A teacher should be able to read the length of time their case is kept in the first two lines
- [ ] **Step 5: The acceptance is recorded inside the transaction** and nothing is sent from inside it, the same rule as everything else in the router
- [ ] **Step 6: `signInPromptReply` now needs the periods**, so a teacher signing in for the first time reads the same generated text an existing teacher re-accepts. Two wordings of one notice is the drift this whole design exists to prevent

### Task 66: Telling a teacher who their regional manager is

Implements Q2 and D47. The **second** teacher-visible change in this stage, and the one that publishes a named employee to 1,800 people.

**Files:** `src/staff/repository.ts`, `src/telegram/commands/staff.ts`, `src/telegram/handlers/menu.ts`, `src/telegram/keyboards.ts`

- [ ] **Step 1: Tests**

```ts
it('names the person covering the teacher’s region', async () => { /* ... */ });

it('reads the region the way everything else reads it', async () => {
  // R12. regionFor, never teachers.region — that column is the snapshot taken
  // at sign-in, and a teacher shown last year’s manager is worse than a
  // teacher shown nobody.
  await setRegionOverride(db, TEACHER, 'Bukhara', LEAD);
  expect(await regionManagerFor(db, TEACHER)).toMatchObject({ region: 'Bukhara' });
});

it('shows nobody rather than somebody who cannot act', async () => {
  // R14 one more time: an Observer covering a province is not the person a
  // teacher should be sent to.
  await addStaff(db, { telegramId: OBSERVER, role: 'Observer', queue: 'All', regions: ['Bukhara'], actor: SYS });
  expect(await regionManagerFor(db, TEACHER)).toBeNull();
});

it('falls back to the support contact, and says nothing about staffing', async () => {
  // "No manager is assigned to your province" is an operational fact a teacher
  // can do nothing with, and it is not theirs to worry about.
  const reply = regionManagerReply(null, 'support@mopse.uz');
  expect(reply.text).toContain('support@mopse.uz');
  expect(reply.text).not.toMatch(/no manager|not assigned|nobody covers/i);
});

it('does not publish a handle that has not been verified', async () => {
  // D47. A null username means "not published", and the name is still shown.
  await addStaff(db, { telegramId: LEAD, role: 'Lead', queue: 'All', regions: ['Bukhara'], actor: SYS });
  const reply = regionManagerReply(await regionManagerFor(db, TEACHER), 'support@mopse.uz');
  expect(reply.text).not.toContain('@');
});

it('refuses a handle that resolves to somebody else', async () => {
  // The whole of R33 in one test. api.getChat('@handle').id must equal the
  // staff row's telegram_id, or the column is not written at all.
  const api = fakeApi({ '@karimov': { id: '999' } });
  expect(await setUsername(db, api, LEAD, '@karimov')).toEqual({ ok: false, reason: 'belongs to somebody else' });
  expect(await usernameOf(db, LEAD)).toBeNull();
});
```

- [ ] **Step 2: `regionManagerFor(db, chatId)`** — the region through `regionFor`, then the lowest-ranked **active** staff member holding `case.update` whose queue and region cover that teacher. Reuse `staffMatching`'s shape in `notify.ts` rather than writing a third expression of the same rule; if that means exporting it, export it
- [ ] **Step 3: Lowest rank that covers them, not everybody.** A list of five names is a teacher deciding who to bother, and the senior people are the ones who will be chosen
- [ ] **Step 4: `/username @handle` and `/username clear`**, for any active staff member, on their own row only. Nobody sets anybody else's — a handle published under somebody's name is theirs to publish
- [ ] **Step 5: Verified on set, through `api.getChat`** (D47). The command reports the three outcomes separately: it matched and is published, it belongs to somebody else and nothing was written, or Telegram does not know it. A staff member who mistypes their own handle must find out from the command, not from a teacher
- [ ] **Step 6: The wording sends anything needing a record back to Contact Support** (R34). It is the only control there is, so it has to be in the message rather than in this plan
- [ ] **Step 7: Reachable from the main menu and from `/help`**, not only from a case. A teacher who does not know who to call is a teacher who is not in the middle of anything

---

# Layer 4 — scheduled work

### Task 67: The retention job

Implements D29, D36, D37, D38.

**Files:** Create `src/worker/tasks/retention.ts`; modify `src/worker/main.ts`

- [ ] **Step 1: Tests** — a `null` period deletes nothing; the report is returned and logged; a failure against one table does not skip the others
- [ ] **Step 2: `recordJobRun` with a 24-hour expected interval** (D37), so a retention job that stops being scheduled raises the same alarm as a stopped sync
- [ ] **Step 3: `0 21 * * *` — 02:00 Tashkent (D38).** UTC in the crontab, Tashkent in the comment beside it, and a test asserting the arithmetic
- [ ] **Step 4: The report goes to the operations chat once a night, as a `warning` only when something is unusual.** A nightly "deleted 14 cases" alarm is an alarm people mute. What must be said aloud is the state D30 predicts will look like a fault: **no period set, so nothing was deleted** — said once a night until somebody sets one
- [ ] **Step 5: Cases first, then everything else, and each pruner independent of the last.** One `try` per table, so a lock or a bad period against one leaves the other eleven done rather than skipped — the same argument `Promise.allSettled` makes in the sheet sync, where one failing tab must not stop the other

### Task 68: The daily digest job

Implements D39, D40.

**Files:** Create `src/worker/tasks/digest.ts`; modify `src/worker/main.ts`

- [ ] **Step 1: Tests** — a staff member with cases in all three lists gets one message; one with nothing gets none; an Observer gets none; a chased teacher is chased once and their counter moves; a teacher at the cap produces one message to the owner and nothing further; a blocked teacher does not stop the run
- [ ] **Step 2: `0 2 * * *` — 07:00 Tashkent (D38).** The number that must not be wrong, and the reason the whole of D38 exists
- [ ] **Step 3: One scope evaluation per staff member**, using the existing queries. Not one query with a join across staff — the guarantee that `visibleToStaff` provides is per-asker, and re-expressing it in a bulk query is how it drifts
- [ ] **Step 4: `trySend` throughout, never `send`.** One staff member who has never started a chat with the bot must not cost everybody else their digest. The failures are logged and counted in one summary line, not alerted individually
- [ ] **Step 5: The chase and the digest are one job, and the chase runs second.** They read the same table and the chase writes to it; doing the reads first means the digest cannot report a case as chased before it was
- [ ] **Step 6: The published usernames are verified here too** (D47, R33). One `getChat` per staff member with a handle set — a handful of calls against values that change about never. A mismatch clears the column and alerts both the staff member and the operations chat. It belongs in this job rather than its own because it is the same shape as the stranded-code check the heartbeat already carries: something that should always find nothing, and that is silent for months when it does not
- [ ] **Step 7: `recordJobRun` at a 24-hour interval.** A digest that stops arriving looks exactly like a quiet week, which is the failure the heartbeat exists for

### Task 69: The announcement sweeper

Implements D41, D42.

**Files:** Create `src/worker/tasks/announcements.ts`; modify `src/worker/main.ts`

- [ ] **Step 1: Tests** — a queued announcement is picked up and moves to `Sending`; a batch is at most `ANNOUNCEMENT_BATCH`; a rate-limited recipient is retried and a blocked one is `Failed`; a recipient who lost access is `Skipped`; the run finishes and reports once; a second sweep during a slow first one claims nothing twice
- [ ] **Step 2: `* * * * *` — every minute, and no ad-hoc enqueue** (D37). The sweeper is the only sender, which is what makes a restart mid-broadcast resume rather than repeat
- [ ] **Step 3: One batch per run and then return** (D42). No pacing loop inside a run, no sleeping in the worker, and therefore no run that starves the sync and the heartbeat
- [ ] **Step 4: The report goes to whoever drafted it**, once, when the last recipient is resolved — sent, skipped and failed, counted separately (D41). An announcement that finishes silently is one nobody can say was delivered
- [ ] **Step 5: `recordJobRun` at a 60-second interval.** It is scheduled, so it is watched. And it must be cheap when there is nothing to do, because most of the time there is nothing to do — one indexed read on `announcements_status_idx` and return

---

# Layer 4.5 — the layer rule

### Task 70: The layer rule, mechanically enforced — **droppable**

Implements D46. Nothing depends on it; drop it first if the stage runs long.

**Files:** Modify `scripts/dependency-tree.mjs`

- [ ] **Step 1: The layer map**, directory by directory, in the script. Layer 1 leaves, layer 2 stores, layer 3 `src/telegram/`, layer 4 `src/worker/`
- [ ] **Step 2: The three things it must know**, all already true and all three named in §8 of the handoff: entry points and `*.test.ts` files are imported by nothing and that is correct; nothing in `src/` may import a `*.test.ts`; **a type-only import may point upward and is not a violation**
- [ ] **Step 3: It must pass on the tree as it stands before it is trusted.** A checker whose first run needs the codebase changed is a checker whose rule is wrong
- [ ] **Step 4: `npm run deps:check` gains it**, so it fails in the same place a cycle already fails

---

# Layer 5 — documentation

### Task 71: Correct every document this stage makes wrong

Not optional. One pass, at the end, exactly as Task 41 was — because a document edited a little at a time as code lands describes a system half-way between two states.

- [ ] **Step 1: `BOT-SPEC.md`**
  - **§7.1.3 — retention is now built.** The word "archive" was corrected to "delete" by Task 41; this is where the periods, the settings keys and the twelve tables of D33 are recorded. Name what is never deleted as well as what is
  - **§4.2, §12 — the privacy notice is generated.** The retention paragraph is no longer prose in a document; it is produced from three settings, and the specification must say so or somebody will edit the wording in the wrong place
  - §6.5 — `/announce` and `/export` move out of the deferred list, plus `/retention`, `/forget` and `/username`. Nineteen commands becomes twenty-six
  - §6.1 — `teacher.forget` in the capability table, at System
  - **new — the regional manager a teacher is shown** (Q2), including that the published handle is verified rather than trusted, and why (D47)
  - §16 — the deferred list loses announcements and export; the resignation route and the `/await` taxonomy stay on it
  - **§11 (or wherever scheduled work is described) — three new jobs, and the UTC crontab.** D38 belongs in a document somebody reads before writing the fourth one
- [ ] **Step 2: `RUNBOOK.md`**
  - **§2.4 — the three retention keys are now consumed.** They were added to the launch insert by Task 41 against a job that did not exist; the entry becomes "seed these before the first teacher is served, or nothing is deleted and the notice says so"
  - **§4.11 — rewrite against what was built.** Task 41 wrote it from the plan. It now needs the real command (`/retention`), the real warning (lengthening asks 1,800 people to re-accept), and the real consequence
  - **new — the daily digest and the chase.** What arrives at 07:00, who gets it, why somebody with nothing due gets nothing, and that a teacher is chased three times and then their owner is told
  - **new — sending an announcement**, as a numbered procedure. Draft, read it back, send, and what the report means. Including that a cancel after sending has begun stops the remainder and not what has gone
  - **new — a removal request.** `/forget`, that it is System-only, and **what it does not remove** — the chat id and the case text, the second of which retention clears on its own. Written for whoever will reply to the teacher
  - **new — taking an export**, and the rule that it contains no teacher's words, with D43's reason so nobody adds a column
  - **§4.7 — stays deleted, and the runbook now says it was offered and declined** (Q1). Not "removed because the log is short" but *"a nightly roll-up would have kept these two signals as counts; it was considered on 30 July 2026 and not wanted."* A deletion that reads as an oversight is one somebody restores by accident, and a restored §4.7 returns nothing and looks like good news
  - **new — publishing a manager's Telegram handle.** `/username`, that it is the staff member's own to set, that the bot checks it daily, and what happens when the check fails — because the first person to meet that will be whoever is named in the alarm
  - **Part 3 — smoke-test additions**, below
  - **Part 1 §1.3 — the retention row closes.** It has been the oldest open item in the project
- [ ] **Step 3: `CONCERNS-AND-IT-ACTIONS.md`**
  - **A10 — close it.** The periods are set *and consumed*. Task 41 recorded the numbers; this records that something reads them
  - **A11 — close the other half.** Anonymisation exists, and the residual is stated
  - **B3 — close it.** Announcements are built
  - **new — the sync log held teacher email addresses for a year** (R24), closed by the scrub. The lesson is B4's again: a column nobody reads is not a column nobody fills
- [ ] **Step 4: `npm run deps` and commit the regenerated `docs/dependency-tree.md`**
- [ ] **Step 5: Rewrite the handoff in place, and update this plan's table** — §11 of the handoff, all three things

---

## Deploy-day checklist

Unchanged in shape — migrate before serving, always — with five additions.

```bash
docker compose build web worker
docker compose stop web worker
docker compose run --rm --no-deps web node dist/db/migrate.js
docker compose up -d worker
docker compose up -d web
```

**Rollback is no longer code-only, and this is the first stage where that is true.** `0008` adds columns and indexes and alters nothing, so the previous image still runs — but the retention job will have **deleted rows that no rollback restores**. Prove the migration on deploy day before serving, and take the backup first rather than relying on the nightly one.

**1. Seed the three periods before the first teacher is served.** Unseeded, the job deletes nothing and the notice tells teachers their data is kept until a period is set — which is true, and is not what anybody intends after this deploy.

**2. Check the digest arrives at 07:00 Tashkent, on the first morning.** D38 is the one thing in this stage that fails silently and looks like nothing at all. A digest at noon is five hours of a working day.

**3. Watch the first retention run.** It is the first night, and it is the run with the most to delete — every case closed since launch, in one statement. Read the report it sends.

**4. Send one announcement to one recipient first.** `/announce` addressed to a region holding a single test teacher, sent, and the report read, before anybody addresses 1,800 people.

**5. Smoke-test additions**, appended to `RUNBOOK.md` Part 3. Each proves a pipeline that has never had both ends:

1. **A teacher is asked to accept the notice again.** From an already-verified test account, tap Contact Support: the notice arrives with the periods in it, one tap returns them to the topic picker, and the acceptance is recorded with all three numbers.
2. **A closed case disappears on schedule.** Close a test case, set `CASE_RETENTION_DAYS` to 1, wait for the night, and confirm the case and its notes have gone and the reference no longer resolves.
3. **A critical case does not.** The same, with `/mark <ref> Critical` first. It must survive, and this is the assertion that proves the job reads `importance` and not `status`.
4. **A promised date is chased.** `/due` a case to yesterday and confirm its owner is told at 07:00.
5. **A teacher at `Action required` is reminded.** `/await` a test case, and confirm the teacher — not the staff member — receives the reminder, with the text that was typed.
6. **An export contains no teacher's words.** Take one and open it. `detail` must not be there.
7. **A teacher is shown the right manager, by the right handle.** Set one with `/username`, view it from a test teacher account in that province, and tap through — it must open a chat with the person named beside it.

---

## Open items this plan deliberately does not close

- **No command reads `audit_log`** (D18). Unchanged.
- **The `/await` taxonomy is not built** (D26). The chase renders free text and must not parse it.
- **The resignation route is not built.** `forgetTeacher` exists for it; the three-month timer does not.
- **Nothing anonymises on a timer.** `/forget` is a command a person runs.
- **A teacher is not told before their case is deleted.** Deliberate: 1,800 people receiving "your case record has been removed" is noise, and the notice states the period. The first person to meet this will be a staff member on the telephone, which is why the runbook says it in the words they will need.
- **An exported file is outside every control this system has** (R28). What limits it is what goes into it.
- **`/forget` cannot remove a chat id or a teacher's own words** (D44). Retention removes the second on its own; nothing removes the first.
- **The digest is not configurable.** No per-person opt-out, no frequency setting. If it is wrong for somebody, that is a conversation and not a settings row — and a digest people can switch off is a digest that stops arriving for the people who most need it.
- **Announcements have no scheduling.** `/announce_send` sends now. A "send at 07:00 tomorrow" is a second timing mechanism beside a sweeper that already exists, and nobody has asked for it.
- **`urgent_codes` is never pruned** (D33), and it holds the chat id of every teacher who has ever used an emergency code. Audit-class, by the same argument as `audit_log`, and stated so it is a decision rather than an oversight.
- **The two content questions become unanswerable past three days** (Q1). What teachers are asking that the answer bank cannot cover, and which confident answers they are rejecting. Offered as a nightly roll-up of counts and declined on 30 July. It stays available later and is one table and one step whenever it is wanted.
- **A teacher who messages their manager directly leaves no record** (R34). The wording is the only control, and a fall in case volume after Task 66 ships should be read as work moving rather than work disappearing.
