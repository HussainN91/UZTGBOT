# Engineering Concerns and Actions Needed from IT

**Version:** 1.1 · **Date:** 2026-07-27 — updated after the UPGRADE-PLAN v1.1 execution

Two parts. **Part A** is a concrete action list — things someone must do, with an
owner and a deadline. **Part B** is my honest assessment of where this system is
weak, so nobody is surprised later.

Nothing here blocks launch except where marked 🔴.

---

# PART A — Needs attention from IT

## 🔴 A1. The internal answer bank is sitting in the deployment folder

`Teacher_Contract_Accommodation_Answer_Bank_September_2026_UPDATED.md` is in the
same directory as the source code. Every page of it is stamped
`Confidential Internal Answer Bank`, and it contains the salary-cap rationale,
the benchmarking strategy, the Quick Reply Map, and staff instructions like
*"No net salary should be promised."*

**If this folder is handed to IT staff, a contractor, or a vendor, that document
goes with it.** The bot itself is clean — I verified zero internal content
reached `FAQ-import.csv` — but the source file's location is a disclosure risk
that has nothing to do with the bot.

**Action:** move both source markdown files out of the deployment folder into
wherever MoPSE keeps restricted HR material. Keep `FAQ-import.csv` (it is
teacher-facing by construction).
**Owner:** Head of project · **When:** before sharing this folder with anyone

## 🔴 A2. Re-run `installTriggers()`

Newer triggers were added (`handleSheetChange`, and `runDailyDigest` from the
upgrade plan). Without re-running, revoking a teacher's access by deleting their
USERS row silently keeps working for up to 30 minutes, and no overdue digest is
ever sent.

**Action:** run `installTriggers` once after deploying. Re-run `createAllSheets`
at the same time — the upgrade plan appended columns to CASES and ADMINS.
**Owner:** IT · **When:** at deployment

## ✅ A3. Delete or quarantine `bot_spec.md` — **DONE**

It documented `MessageHandler.gs`, `CallbackHandler.gs`, `FormGenerator.gs`,
`EmailParser.gs`, `CAND-0042` deep links and a 7-column flat sheet. **None of
this exists.** Anyone who read it while setting the system up would have been
actively misled. `BOT-SPEC.md` replaces it.

**Action:** ✅ **Done — 2026-07-27.** `bot_spec.md` was deleted rather than
renamed, and `proposal_gap_analysis.md` was deleted alongside it for the same
reason — it was a mid-build status table that was wrong in both directions.
Deletion is a stronger resolution than quarantine: a file that is gone cannot be
mistaken for authoritative. `BOT-SPEC.md`, `RUNBOOK.md`,
`CONCERNS-AND-IT-ACTIONS.md` and `UPGRADE-PLAN.md` are now the only
documentation, with no overlap between them.
**Owner:** IT · **When:** ✅ complete

## 🟠 A4. Add a second System Administrator

`/add_admin` requires an existing System Admin. If the single seeded row is
deleted or that person leaves, **no one can administer the bot** and the only
recovery is editing the ADMINS sheet by hand.

The lifecycle around this improved with the upgrade plan: `/admins` lists
everyone with provenance, `/remove_admin` deactivates safely (it **refuses to
deactivate the last active System Admin**), `/set_role` restores, and
`/add_admin` can no longer accidentally strip an existing System Admin's flag.
None of that changes the underlying need for a second person.

**Action:** seed at least two System Admins in different people's names.
**Owner:** Head of project · **When:** at deployment

## 🟠 A5. Establish spreadsheet ownership and backup

Everything lives in one Google Spreadsheet on one Google account. If that account
is suspended, has its password lost, or belongs to someone who leaves, the entire
system and all case history goes with it.

**Action:**
- Own the spreadsheet with a **MoPSE organisational account**, not a personal one
- Add a second owner
- Enable a scheduled export or use Google Takeout periodically
- Record who owns it in your IT asset register

Google Sheets version history covers accidental edits but **not** account loss.
**Owner:** IT · **When:** before launch

## 🟠 A6. Decide the FAQ content review cadence

112 answers describing salary, visa rules and contract terms will drift. Nothing
in the system flags a stale answer — `LAST_APPROVED_DATE` exists but is never
read by code.

**Action:** name an owner and a review interval (quarterly is typical), and
populate `LAST_APPROVED_BY` / `LAST_APPROVED_DATE` at import so the clock starts.
**Owner:** Head of project · **When:** first month

## 🟡 A7. Set up a way to notice failures

Errors go to Apps Script's execution log, which nobody reads by default. A
broken FAQ row, an exhausted quota, or a failed announcement will be invisible
until a teacher complains.

**Action:** add a weekly calendar reminder to open **Apps Script → Executions**
and filter to **Failed**. A lightweight alternative is a time-driven function
that emails a daily error digest — say the word and I'll write it.
**Owner:** IT · **When:** first month

## 🟡 A8. Restrict spreadsheet access

Anyone with read access to the spreadsheet can read **every teacher's case
detail**, including whatever they typed into Contact Support. `DETAIL` is
internal-only by design and is never shown to teachers, but the sheet has no
row-level permissions. Anyone with **edit** access can grant themselves System
Admin by typing their Telegram ID into the ADMINS tab.

**Detection now exists, prevention still doesn't:** a direct edit of the ADMINS
tab alerts every System Admin and is logged (`ADMINS_SHEET_EDITED`), `/export`
requires a recorded reason and notifies peers, and every case mutation records
its actor (`LAST_ACTOR`). The Drive sharing list remains the real access
boundary — restricting it is still the actual fix.

**Action:** share the spreadsheet with named staff only. Do not use "anyone with
the link". Review the access list quarterly.
**Owner:** IT · **When:** before launch — **still open**

## 🟡 A9. Note where the webhook secret is visible

`WEBHOOK_SECRET` is passed as a URL query parameter, because Apps Script exposes
request headers inconsistently for `doPost`. It is therefore visible in the full
webhook URL, which appears in `getWebhookInfo()` output and any log that records
it.

This is an accepted trade-off and the URL is not public — but treat the output of
`getWebhookInfo()` as sensitive and don't paste it into tickets or chats.
**Owner:** IT · **When:** ongoing awareness

---

# PART B — Engineering concerns

Ranked by how likely they are to bite you.

## B1. The global lock is the throughput ceiling — 🟠 Medium

`logInteraction()` takes `LockService.getScriptLock()` on **every single
update**, and it is a *global* mutex, not per-row. Every webhook execution
serialises behind every other one. If the lock isn't acquired within 3 seconds
the log row is dropped.

**Practical impact:** fine for hundreds of teachers with ordinary usage. It will
bite during a burst — the minutes after an `/announce`, or the day placement
letters go out.

**Fix if it becomes a problem:** buffer log rows in `CacheService` and flush them
in a batch from a time-driven trigger. Roughly half a day's work. I would not do
it pre-emptively.

## B2. Sheets is not a database — 🟠 Medium, grows over time

Nearly every case operation calls `getDataRange().getValues()`, reading the
**entire** CASES sheet into memory. At a few thousand rows this is unnoticeable.
At tens of thousands it will be slow, and eventually it will hit the 6-minute
execution limit.

Archiving (§6.1 of the runbook) is the pressure valve — it keeps the live sheet
small. **This is precisely why setting `RETENTION_DAYS` matters more than it
looks.** Left unset, CASES and MESSAGES grow without bound — and since the
privacy notice shipped (`/privacy`), indefinite retention also contradicts what
teachers are told. One decision closes both the performance and the privacy
side.

## B3. `/announce` still runs inside the webhook — 🟠 Medium

It paces at 60 ms per recipient and self-caps at 4.5 minutes. Telegram's webhook
timeout is shorter, so on a large audience the admin's HTTP request times out.

`update_id` deduplication (added this week) means the retry is ignored, so the
broadcast **is not sent twice** — that was the real damage and it's fixed. What
remains: the admin may see no immediate response, and on very large audiences
some recipients are reported as "not attempted" and need a re-run.

**Proper fix:** queue recipients and drain from a time-driven trigger. A day's
work. Worth doing before the roster passes ~500 teachers.

## B4. No automated tests — 🟠 Medium

There is no test suite and, being Apps Script, no practical way to run one
locally. Every change is verified by deploying and clicking through. The smoke
test in Part 3 of the runbook is the substitute.

This is why I have been conservative about refactors: there is no safety net.

## B5. Single points of failure — 🟠 Medium

One Google account, one spreadsheet, one script project, one bot token. Any one
of them lost takes the whole system down. Mitigations are in A4 and A5; the
architecture itself cannot be made redundant without a rewrite onto real
infrastructure, which is not warranted at this scale.

## B6. Header names are silent contracts — 🟡 Low probability, high impact

Code looks columns up by name (`headers.indexOf('REFERENCE')`). Renaming a header
in the spreadsheet does not throw — the lookup returns `-1` and the feature
silently stops working. A well-meaning "tidy up" of column names would break case
notifications with no error anywhere.

**Mitigation:** protect the header row (Data → Protect sheets and ranges) on
CASES, USERS, FAQ, ROSTER and ADMINS. The list of load-bearing headers grew
with the upgrade plan: `CASES.LAST_ACTOR` and the six appended ADMINS columns
(`NAME`, `ACTIVE`, `ADDED_BY`, `ADDED_AT`, `REGIONS`, `ROLE`) are all looked up
by name.

## B7. Verification is only as strong as the roster — 🟡 Accepted, now **detected**

Identity is "types a string that appears in ROSTER". If a teacher forwards their
verification email, whoever has it can verify as them. This is an accepted
trade-off from the original design — the alternative (one-time codes issued per
person) is materially more work for recruitment.

**Since the upgrade plan it is no longer invisible:** a second chat verifying an
already-held identifier triggers an `IDENTITY_DUPLICATE_BINDING` log row, an
alert to every System Admin, and a security notice to the chat that already held
the identity. Impersonation is detected, not prevented — prevention remains the
per-person one-time-code decision, which stays with the head of project.

Worth knowing rather than fixing: the 5-attempt cap stops brute-forcing, but not
a leaked identifier.

## B8. Urgent codes can still be lost — 🟡 Low

The code is consumed *before* the teacher types their issue. The window was 30
minutes; it is now 6 hours (`CacheService`'s maximum). A teacher who takes longer
than 6 hours still loses the code with no self-service recovery.

**Full fix** requires validating the code without consuming it and consuming it
at case creation, which opens a double-use race. The 6-hour window is the
pragmatic middle ground.

## B9. `DOC-001` speaks in the third person — 🟢 Cosmetic

The answer reads *"The candidate should avoid submitting multiple duplicate
entries… The team will advise…"* — correct in substance, but odd coming from a
bot talking **to** that candidate. Left as-is per your approval. One-line fix
whenever you want it.

## B10. No per-chat rate limiting — 🟢 Low

Beyond the 5-attempt verification cap, a single chat can send unlimited messages,
each triggering a sheet read and a lock acquisition. There is no abuse path to
data, but one determined user could degrade throughput for everyone. Telegram's
own flood limits provide some protection.

---

# Summary for the head of project

**The bot is in good shape.** The code has no undefined references, no column
mismatches, a complete state machine, locking on every teacher-facing write path,
and it cannot get stuck in a Telegram retry loop. The audit found zero
dead-on-arrival defects.

Four low-frequency admin paths are deliberately unlocked — `/add_admin`,
`/set_role`, the announcement row append, and urgent-code consumption. They are
listed in §12 of `BOT-SPEC.md` with the reasoning, so it is a recorded decision
rather than an omission.

**Three things need a decision from you, not from IT:**

1. Move the confidential answer bank out of this folder (**A1**)
2. Name at least two System Administrators (**A4**)
3. Provide the real support contact and the teacher roster — without these,
   verification fails for everyone and no case can be opened

**Everything in Part B is a known trade-off of building on Google Sheets**, not a
mistake. At the scale of one intake cohort, they are the right trade-offs. If
this system is still running in three years across multiple intakes, B1, B2 and
B3 are the three to revisit first.
