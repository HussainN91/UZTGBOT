# Design decisions — staff, regions, case lifecycle and documents

**Date:** 29 July 2026 · **Status:** agreed in discussion, not yet built
**Source:** brainstorming session with the head of project, 29 July 2026

This records decisions taken in conversation so they stop living in a chat
window. It is not a plan. Where a decision changes the Stage 4 plan
(`2026-07-28-stage-4-staff.md`) that is stated against it; the plan is amended
separately.

**Where the build actually stands:** Stage 3 (teachers) is built, tested and
committed at `d743d72`. Stage 4 (staff) is planned and **not started**. Nothing
below is implemented.

---

## 1. An observer role exists

**Agreed:** a fifth staff rank that can see cases and change nothing.

**Rationale:** the four ranks in the schema all include the ability to reply to
a teacher and close a case. There is no way to give somebody sight of the work
without also giving them the power to alter it — wanted for senior ministry
staff, auditors, and new hires in their first week.

> ⚠️ **Open — the name.** The head of project asked for "Jstaff". This document
> uses **Observer** as a placeholder. The value becomes permanent in the database
> enum, so it must be confirmed before Task 23 is written.

**Changes:** Stage 4 plan D7 — the capability table gains a row; the `staff_role`
enum gains a value below `Support`.

## 2. Rank and region are separate, and one rank is misnamed

**Agreed:** rank (what a person may do), region (whose cases they see) and queue
(which topics they see) are three independent settings. A "regional admin" in
MoPSE's language is a person with a region set — usually at `Support` rank, not
at the rank confusingly called `Regional`.

**Open:** whether to rename the `Regional` rank — `Lead` was suggested — so the
word does not mean two different things. Free now; a schema change with data in
it later. **Not yet answered.**

## 3. Staff commands are renamed to the staff vocabulary

**Agreed** (already Stage 4 plan D14): `/staff`, `/staff_add`, `/staff_role`,
`/staff_remove`. The word "admin" is gone from the data model and should go from
the interface with it. Nobody has been trained on the old names.

## 4. Regions: the database overrides the spreadsheet

**Agreed — option B.** A region changed by staff is stored in the bot's own
database and takes precedence. The roster's column remains the starting value
for teachers whose region has never been changed by hand.

**Rejected — option A**, the bot writing back to the spreadsheet. It would need
edit access to the document that also holds the confidential answer bank, and it
would break the one-way flow that makes "which copy is correct" an unaskable
question.

**Consequence:** a new nullable column on `teachers` for the staff-set region,
and a command at `Regional` rank and above. The visibility rule (Stage 4 plan
D10) reads the override first and the roster second.

## 5. Regions: the teacher is asked to confirm, not to decide

**Agreed.** Teachers move, so the roster goes stale. But a teacher who picks
their region from a menu is choosing who sees their case, and a wrong tap routes
it to the wrong person.

The agreed shape: the bot **shows the region it holds and asks whether it is
still right**, one tap, periodically rather than on every visit. "No" raises a
flag for that teacher's Regional manager, who makes the actual change. The
teacher reports; staff decide.

**Rejected:** asking on every new conversation. There is no session to hang it
on — the bot has no login — so in practice it would be a question 1,800 people
tap through without reading, filling the field with noise.

## 6. The roster is not filled by scraping email

**Agreed — dropped.** A parser over free-text acceptance emails misses people
silently, and a missed teacher is one who cannot sign in with nobody knowing
why. It would also mean giving the bot mailbox access, which is a large
widening of what one leaked key reaches.

Arrival-confirmation **Google Forms already write to a spreadsheet natively**,
so feeding the roster from them is a copy step rather than engineering.

## 7. Retention: by class of case, in the database, not in Drive

**Agreed:** cases staff have marked **urgent or critical** are kept for **six
months**. Everything else is removed sooner.

**Dropped:** exporting closed cases into Google Drive folders organised by date,
region and name. The head of project withdrew this on learning the bot has its
own database. It is recorded because the reasoning matters: exporting cases
would copy teachers' own words out of the one place with one set of controls
into folders with different sharing — making the privacy position worse, not
better — and it would put old cases beyond both Check My Case and staff search.
Database size is not a real constraint at this scale.

**Requires:** an importance marker staff can set on a case, which does not exist.
`Escalated` is a *status*, not a permanent classification, and a case can be
escalated and then resolved.

> **Open:** the retention period for ordinary cases, and for the message log,
> which is a separate thing — one row per message a teacher sends, used mainly
> to find questions the answer bank does not cover. "Six months for urgent"
> answers a third of `CONCERNS-AND-IT-ACTIONS.md` A10.

## 8. Removal means anonymisation

**Agreed.** A teacher who leaves is removed from the system by replacing the
name and the identifier and keeping the case history.

**Why this matters more than it looks:** `cases.teacher_chat_id` refuses to
delete any teacher who has ever opened a case — deliberately, because it
guarantees no case exists without a real person behind it — while the privacy
notice promises removal on request. That contradiction is `CONCERNS` **A11**, a
red-flag open decision. Anonymisation satisfies both. **A11 can be closed.**

## 9. Resignation, unlocked case by case

**Agreed:** the bot offers a teacher the option to submit a resignation, and
that option is invisible until a **Program**-rank member unlocks it for that
specific teacher. Once used, the teacher's record remains for **three months**
and is then anonymised automatically.

**Stage:** later than 4. Recorded so the three-month timer is designed alongside
the retention job rather than bolted to it.

## 10. Open cases are chased daily, with dates and a snooze

**Agreed.** A daily notification for open cases, addressed to whoever holds
each one, with the ability to snooze for a chosen period.

Behaviour by state:

| State | What happens |
|---|---|
| Not yet opened | Chased daily until somebody takes it |
| Under review | The person holding it supplies an estimated date |
| Approved / processing | An estimated date is required from whoever is handling it |
| Done | Nothing |

**Requires two fields no case has:** a promised date, and a snooze-until. Both
are small, and both should be added in Stage 4's migration even though the
notifications themselves are Stage 5 — a second migration to add two columns is
avoidable work.

**Open:** how these four states map onto the eight statuses that exist
(`New`, `Received`, `Under review`, `Action required`, `Escalated`, `Completed`,
`Closed`, `Duplicate`). They are close but not identical, and the commands in
Stage 4 use the statuses, so the mapping is needed before Task 34.

## 11. Documents stay in Google Forms

**Agreed.** Teachers submit documents through the existing per-stage Google
Forms. The bot never accepts or stores a file.

**This reverses the planned direction.** The rebuild intended to replace Forms
with uploads through Telegram — `RUNBOOK.md` Part 6 calls it "the only genuinely
new feature in the rebuild" and `src/db/schema.ts:295` reasons from it. The
decision stands; the documents are wrong and are corrected with the rest.

**What it buys:** no file storage, no backup growth, no retention rule for
documents, and a much smaller final stage.

## 12. Form links live in a third spreadsheet tab

**Agreed.** A `FORMS` tab beside `ROSTER` and `FAQ`: document type, button
label, link, active flag.

**Why not in code:** they were in code in the Apps Script version, which is
precisely why all seven sat as `PLACEHOLDER_VISA` and similar until the feature
was abandoned — changing one needed a developer. In a tab, a new form appears in
the bot within ten minutes, like an FAQ answer. Blank or inactive rows do not
render, so a half-ready form cannot reach a teacher.

**Consistency:** this obeys the existing ownership rule. The spreadsheet owns
what the bot reads and says; the database owns what the bot writes. A form link
is content.

## 13. Submissions are matched by recruitment email

**Agreed — option B.** Every Google Form writes its responses to a sheet. The
form asks for the teacher's **recruitment email** — the address they already
sign in with — and the bot reads that responses tab and matches it against the
roster, filing the case under the right teacher. Unmatched rows raise an alert
for a person rather than being lost.

**Rejected:** the Apps Script approach of pre-filling the teacher's chat ID into
the form. Google Forms has no hidden fields, so it was a visible editable box
that could never be trusted as identity, and any submission it failed to match
became an `UNRESOLVED:` mystery case. The new schema cannot store those at all —
`cases.teacher_chat_id` is a non-null foreign key with a digits check.

Matching on the roster identifier is **stronger** than the mechanism it
replaces, not a workaround for it.

## 14. Housekeeping for the spreadsheet

**Action for MoPSE, not code.** The old spreadsheet had eight tabs; the bot now
reads two. If the same document is reused, the other six are inert and should be
deleted — particularly **ADMINS**, which used to grant administrator rights and
now does nothing at all. A tab that looks like it works and does not is worse
than no tab.

---

## What this changes, by stage

| Decision | Stage 4 | Stage 5 | Later |
|---|---|---|---|
| 1 · Observer role | enum value, capability row | | |
| 2 · Rank rename | if agreed, now | | |
| 4 · Region override | column + command | | |
| 5 · Region confirmation | staff-facing flag | teacher-facing prompt | |
| 7 · Importance marker | the marker | the retention job | |
| 8 · Anonymisation | | the anonymise routine | |
| 9 · Resignation | | | the whole feature |
| 10 · Chasing | two columns, in the same migration | notifications, snooze | |
| 11–13 · Documents | | | forms tab, response sync |

**Scope discipline:** Stage 4 gains an enum value, three columns, one command and
one marker. Everything else queues. The plan's own warning against letting a
stage absorb the next one applies here.

---

## Still open

1. **The observer role's name** — "Jstaff" or "Observer". Blocks Task 23.
2. **Whether to rename the `Regional` rank.** Free now, not later.
3. **Retention for ordinary cases, and for the message log.** Six months covers
   urgent and critical only. `CONCERNS` A10 stays open until both are set.
4. **How the four working states map to the eight case statuses.** Blocks Task 34.
5. **Whether the bot tells a teacher who their regional manager is** — by name,
   and possibly by phone. It would answer "teachers who don't know who to call"
   directly, and it publishes staff contact details to 1,800 people. A MoPSE
   decision, raised and not yet answered.
