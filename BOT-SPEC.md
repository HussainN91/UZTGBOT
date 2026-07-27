# MoPSE Teacher Support Bot — System Specification

**Version:** 1.2 · **Date:** 2026-07-27 · **Status:** Pre-launch — reflects the executed UPGRADE-PLAN v1.1 (Phases 0–6.1)

This document describes what the bot is, how it is built, and how every layer
behaves. It superseded `bot_spec.md`, which described an architecture that was
never built; that file has since been deleted (see §16).

---

## 1. Purpose and scope

A Telegram bot providing first-line support to international ESL teachers
recruited by the Ministry of Preschool and School Education of the Republic of
Uzbekistan (MoPSE) for the September 2026 intake.

**It does three things:**

1. **Answers questions** from an approved FAQ knowledge base — never invents or
   paraphrases an answer. Questions are matched **within a chosen topic**, not
   across the whole bank; see §9.0, which is the constraint most likely to
   surprise a stakeholder.
2. **Opens and tracks support cases** for teachers whose identity is confirmed
   against an official roster.
3. **Routes document submissions** to the correct Google Form and files a case
   when one is submitted.

**Explicit non-goals:**

- Not a chat relay to human staff — admins act through commands, not live chat.
- Not a file store. The bot never accepts uploads in chat; all documents go
  through Google Forms.
- Not multilingual at launch. English only; the language button exists and says so.
- Not a group-chat bot. Private chats only; it leaves any group it is added to.

---

## 2. Platform and runtime

| Layer | Technology |
|---|---|
| Runtime | Google Apps Script (V8), deployed as a Web App |
| Entry point | `doPost(e)` — Telegram webhook |
| Data store | One Google Spreadsheet, 8 tabs (+2 archive tabs created lazily) |
| Secrets | Apps Script **Script Properties** — never in source |
| Ephemeral state | `CacheService` (script cache) |
| Counters / flags | `PropertiesService` (script properties) |
| Concurrency control | `LockService.getScriptLock()` |
| Outbound | `UrlFetchApp` → Telegram Bot API |

**Why Apps Script:** zero-infrastructure, native Sheets access, free within
quota. **Cost:** a 6-minute hard execution limit, a global script lock as the
only mutex, and no real database.

### 2.1 File load order matters

Apps Script concatenates all `.gs` files and executes top-level code in
**filename alphabetical order**:

```
AdminCommands · ArchiveManager · CaseManager · Config · FormRouter · Logger ·
MenuHandler · QAEngine · SetWebhook · SetupSheets · TelegramAPI · Triggers · UserSession · Webhook
```

Every file shares one global scope. Consequences:

- A top-level `const` in `MenuHandler.gs` **cannot** reference one in
  `QAEngine.gs` (Q sorts after M). Several files carry comments about this.
- Cross-file **function** calls are always safe — declarations hoist.
- A duplicate top-level `const` name in any two files is a **load-time error
  that kills the entire bot**. Check before adding globals.

---

## 3. Module map

| File | Lines | Responsibility |
|---|---|---|
| `Config.gs` | ~153 | Script-property keys, sheet names, `CATEGORIES`, `FAQ_TOPICS`, form URLs, support contact, privacy notice |
| `Webhook.gs` | ~263 | `doPost` entry, secret validation, update dedup, private-chat gate, log redaction, routing, `/privacy`, `doGet` health check |
| `MenuHandler.gs` | ~565 | Menus, conversation state machine, case topic picker, case-feature gating, callback routing |
| `QAEngine.gs` | ~444 | FAQ cache, keyword scoring, miss logging, answer feedback buttons, keyboards, paging, Telegram-limit validation |
| `UserSession.gs` | ~334 | Roster verification, USERS binding, duplicate-binding detection, verified cache + epoch |
| `CaseManager.gs` | ~285 | Case create/dedup/lookup/update, actor stamping, reference generation, statuses |
| `AdminCommands.gs` | ~1386 | Role/capability model, 19 admin commands, region scoping, new-case notification, urgent codes, announcements, overdue digest, settings |
| `Triggers.gs` | ~367 | Trigger installation, `onEdit` (incl. ADMINS alert), `onChange`, `onFormSubmit`, archive job, daily digest |
| `ArchiveManager.gs` | ~204 | Retention-based archiving of CASES and MESSAGES |
| `TelegramAPI.gs` | ~225 | Telegram API wrappers, message splitting, no-throw contract |
| `FormRouter.gs` | ~102 | Doc-type ↔ form URL mapping, placeholder detection, chat-ID prefill |
| `Logger.gs` | ~58 | Interaction logging to MESSAGES |
| `SetupSheets.gs` | ~74 | One-time sheet provisioning |
| `SetWebhook.gs` | ~42 | Webhook registration helpers |

---

## 4. Data model

All tabs are created by `createAllSheets()`. **Header names are contracts** —
code looks columns up by name, so renaming a header breaks the feature that
reads it.

### 4.1 `FAQ` — the knowledge base

| Column | Purpose |
|---|---|
| `CODE` | Unique ID. Becomes `callback_data` as `FAQANS:<CODE>` — **must stay under 57 bytes** |
| `CATEGORY` | Must exactly equal a `FAQ_TOPICS[].label`. A mismatch makes the row unreachable |
| `BUTTON_TEXT` | Inline-button label. **Must not be blank** |
| `KEYWORDS` | Comma-separated match terms |
| `OFFICIAL_ANSWER` | The approved answer, sent verbatim |
| `LANGUAGE` | `EN` at launch |
| `ACTIVE` | Row is loaded only when this equals `TRUE` (case-insensitive string) |
| `LAST_APPROVED_BY` / `LAST_APPROVED_DATE` | Audit trail. **Never read by code** |

### 4.2 `CASES`

| Column | Purpose |
|---|---|
| `REFERENCE` | `PREFIX-YYYY-NNNNN`, e.g. `SUPPORT-2026-00042`. Immutable |
| `CATEGORY` | A `CATEGORIES` value, or an FAQ topic label chosen in the Contact Support topic picker |
| `CHAT_ID` | Telegram chat, or `UNRESOLVED:<id>` sentinel |
| `STATUS` | One of the 8 in §7 |
| `OWNER` | Assigned admin's Telegram ID — validated by `/assign` and read by `/mycases` and `/cases unassigned` |
| `CREATED_AT` / `UPDATED_AT` | Timestamps |
| `DETAIL` | **Internal only.** Never shown to the teacher |
| `PUBLIC_UPDATE` | Teacher-visible status note |
| `LAST_ACTOR` | Telegram ID of the admin whose command last changed the row. Blank on rows that predate the column |

Only `STATUS`, `OWNER`, `DETAIL`, `PUBLIC_UPDATE`, `LAST_ACTOR` are writable
post-creation (`CASE_UPDATABLE_FIELDS_`). Admin mutations stamp `LAST_ACTOR`
automatically via `updateCaseFields_`'s `opts.actor`.

### 4.3 `USERS` — verified identities

`CHAT_ID` · `LANGUAGE` · `FIRST_SEEN` · `LAST_SEEN` · `VERIFICATION_STATE` ·
`IDENTIFIER` · `NAME` · `REGION`

`VERIFICATION_STATE` is `VERIFIED` or empty. This is the authoritative record
of who a chat belongs to.

### 4.4 `ROSTER` — the source of truth for identity

`IDENTIFIER` · `NAME` · `REGION`

Seeded by hand or CSV import from official recruitment records. **A teacher who
is not in ROSTER cannot verify, and therefore cannot open a case.**

### 4.5 `ADMINS`

`TELEGRAM_ID` · `IS_SYSTEM_ADMIN` · `TIER` · `QUEUE` · `NAME` · `ACTIVE` ·
`ADDED_BY` · `ADDED_AT` · `REGIONS` · `ROLE` — see §6.

The last six columns were appended (never inserted) so existing positional
writes keep working. Semantics of the appended columns:

| Column | Meaning |
|---|---|
| `NAME` | Human name, so "who is 483920184?" is answerable from the sheet |
| `ACTIVE` | Blank or anything except `FALSE` = active. `/remove_admin` sets `FALSE`; `/set_role` restores. **Blank means active** so the migration cannot lock existing admins out |
| `ADDED_BY` / `ADDED_AT` | Provenance, written by `/add_admin` |
| `REGIONS` | Comma-separated region list, `All`, or blank. **Blank means all regions** — see §6.2 |
| `ROLE` | One of §6.1's ordered roles. Blank falls back to the Tier/IS_SYSTEM_ADMIN pair |

### 4.6 `SETTINGS`

`KEY` · `VALUE` · `NOTES`. Recognised keys:

| Key | Effect |
|---|---|
| `RETENTION_DAYS` | Archive age threshold. **Archiving is a no-op until set** |
| `OVERDUE_DAYS` | Enables the overdue half of `/urgent` **and** the daily overdue digest (§7.1.2) |
| `MAINTENANCE_MODE` | When `TRUE`, pauses Contact Support, Urgent Case and Submit Documents. FAQ browsing **and Check My Case** stay live — pausing submissions is not the same as locking teachers out of their own case status |

Settings are read through a **60-second cache**, because the maintenance gate is
checked on every case-feature tap. `/maintenance` invalidates it immediately, but a
value changed **by hand in the sheet** takes up to a minute to take effect.

### 4.7 `MESSAGES` and `ANNOUNCEMENTS`

`MESSAGES`: `TIMESTAMP` · `CHAT_ID` · `ACTION` · `DETAIL` — the interaction log.
`ANNOUNCEMENTS`: `ID` · `CONTENT` · `AUDIENCE` · `STATUS` · `CREATED_BY` · `CREATED_AT`.

### 4.8 Archive tabs

`CASES_ARCHIVE` and `MESSAGES_ARCHIVE` are created on first use, with headers
copied from the source tab.

---

## 5. Identity model — teachers

Two-factor by design: possessing a Telegram account is not identity.

```
Teacher taps a gated feature
  → isVerified_(chatId)?
      yes → proceed
      no  → state = AWAITING_IDENTIFIER, prompt for identifier
            (the prompt includes the full privacy notice — §5.2)
              → next message checked against ROSTER
                  match    → bind to USERS, VERIFIED, resume the original action
                  no match → attempt counter +1, retry (max 5)
```

**Duplicate identity bindings are detected, not blocked.** `bindUser_` reads,
before writing, which *other* chats are already `VERIFIED` against the same
roster identifier. When any exist, `attemptVerify_` — after releasing the
script lock — logs an `IDENTITY_DUPLICATE_BINDING` row (identifier redacted),
alerts every active System Admin, and sends the prior holder(s) a security
notice. The new binding still succeeds: a teacher switching phones produces
exactly this signal, and locking them out would be worse than a false alarm a
human can dismiss. This makes impersonation *visible*; only per-person one-time
codes would prevent it (an open product decision).

**Gated (requires verification):** Contact Support, Check My Case, Urgent Case,
Submit Documents.
**Open to anyone:** all FAQ browsing and in-topic question matching (§9.0),
`/start`, `/menu`, `/help`, Change Language.

Submit Documents is gated because `onFormSubmit` calls `createCase()`, which
hard-requires verification — an unverified teacher would otherwise reach a form
only for their submission to become an untraceable "unresolved submitter" case.

### 5.1 Verification caching

A **positive** result is cached for 30 minutes. Negative results are never
cached — that would lock a teacher out immediately after they succeed.

Cache keys are namespaced by a **verification epoch** held in Script Properties.
Bumping the epoch invalidates every cached marker at once. This exists because
`onEdit` does not fire on row deletion, so deleting a USERS row — the intuitive
way to revoke access — would otherwise keep working for up to 30 minutes.
`onChange` catches deletions and bumps the epoch.

### 5.2 Privacy

**A privacy notice is shown before any data is collected.** `PRIVACY_NOTICE_TEXT`
(Config.gs — flagged for manual review before go-live) is embedded in the
verification prompt, and replying with an identifier is treated as
acknowledgement. It is retrievable at any time with `/privacy`, which is
teacher-facing and handled in `Webhook.gs` ahead of the admin dispatcher (same
pattern as `/help`). The notice names the data held, its use, its audience, and
the contact route for access/removal requests. `RETENTION_DAYS` remains unset
until the head of project decides it — until then data is retained indefinitely,
which the notice wording must not contradict.

The identifier is an email address. It is written **once**, to the teacher's
USERS row. Failed attempts log only a redacted hint (`j***@school.uz`);
successful verifications log nothing beyond the chat_id already on the row.

**The MESSAGES log is an audit trail, not a transcript.** Every inbound message
produces a `RECEIVED_MESSAGE` row, and `loggableMessageText_` (Webhook.gs)
substitutes a placeholder plus a character count whenever the chat is in a state
where the message body is sensitive:

| State | Logged instead of the body |
|---|---|
| `AWAITING_IDENTIFIER` | `(identifier withheld — the value is in the USERS row)` |
| `AWAITING_CASE_DETAIL` | `(case detail withheld — the value is in the case DETAIL column)` |
| `AWAITING_URGENT_CODE` | `(urgent code withheld)` |

Without this the redaction above was decorative: the raw email was logged in full
by the webhook a few lines before `attemptVerify_` redacted it, and the free-text
case description that §4.2 keeps out of Check My Case was logged in full too.
MESSAGES is *archived*, not deleted, so anything written there persists.

FAQ queries and everything else are logged verbatim — they carry no identity.

---

## 6. Identity model — administrators

Completely separate from teacher verification. The two gates must never be
merged: a verified teacher has no admin rights, and an admin's tier says nothing
about whether they are a verified teacher.

### 6.1 The dimensions

**Authorization is decided by an ordered ROLE and a capability table** (`can_`,
`CAPABILITIES_` in AdminCommands.gs). The legacy Tier remains as a migration
fallback: `roleForAdmin_` uses `ROLE` when set, otherwise derives one from the
old Tier/IS_SYSTEM_ADMIN pair, so both models work simultaneously and rows can
be migrated at leisure.

| Dimension | Values | Meaning |
|---|---|---|
| `ROLE` | `ReadOnly` < `Agent` < `Manager` < `SystemAdmin` | What class of action is permitted (capability table below) |
| `QUEUE` | `Visa`, `Contract`, `Travel`, `Accommodation`, `Recruitment`, `Technical`, `All`, `None` | Which cases are visible (one axis of two — see §6.2) |
| `REGIONS` | comma-separated, `All`, or blank (= all) | Which teachers' cases are visible (the other axis) |
| `ACTIVE` | blank/`TRUE` vs `FALSE` | A deactivated admin is not an admin; history is preserved |
| `IS_SYSTEM_ADMIN` | truthy cell (`TRUE`/`YES`/`Y`/`1`/checkbox) | Legacy fallback → `SystemAdmin` role when `ROLE` is blank |
| `TIER` | `Program`, `Finance`, `Regional`, `None` | Legacy fallback: `Program`→`Manager`, `Regional`/`Finance`→`Agent`, else `ReadOnly` |

Capability table (single source of truth — `/whoami` reads it too, so what it
reports can never disagree with what the gates enforce):

| Capability | ReadOnly | Agent | Manager | SystemAdmin |
|---|---|---|---|---|
| `case.view` (`/cases` `/urgent` `/case` `/search` `/mycases`) | ✅ | ✅ | ✅ | ✅ |
| `case.update` (`/reply` `/close` `/note` `/reopen`) | | ✅ | ✅ | ✅ |
| `case.assign` (`/assign`) | | | ✅ | ✅ |
| `urgent.issue` (`/generate_urgent_code`) | | ✅ | ✅ | ✅ |
| `announce` / `export` | | | ✅ | ✅ |
| `admin.manage` (`/add_admin` `/set_role` `/remove_admin` `/admins`) | | | | ✅ |
| `maintenance` | | | | ✅ |

### 6.2 Case visibility — queue AND region

`adminCanSeeCase_()` is the single visibility rule used by every case-facing
command and by new-case notification: a System Admin sees everything; anyone
else must match the case's queue (`queueForCategory_` → exact queue or `All`)
**and** cover the teacher's region (`REGIONS` blank/`All`, or containing the
region from the teacher's USERS row). Sentinel `UNRESOLVED:` cases have no
region and are never hidden on that axis. The teacher-region lookup is memoized
per execution (`caseRegionMap_`) — a correctness requirement against the
6-minute limit, not an optimisation.

Contact Support asks the teacher what their case is about (Visa / Travel /
Contract / Accommodation / Something else), so cases now file under real
categories and queue-scoped admins see real traffic. The seven newer FAQ topics
are mapped onto the closest existing queue in `queueForCategory_` — deliberately
not given queues of their own. Urgent Case skips the picker and files generic
(routes to `All`), which is the correct destination for an emergency.

### 6.3 Bootstrapping

`/add_admin` requires an existing System Admin. **The first System Admin must be
created by hand** in the ADMINS sheet — it cannot be bootstrapped through the bot.
(Hand edits of ADMINS now alert every System Admin — §11, §13.)

### 6.4 Role assignment and lifecycle

- `/add_admin <telegram_id> [tier] [queue] [true|false] [role] [name]` — System
  Admin only. **Adds only**: an existing target is refused and pointed at
  `/set_role`. (It used to upsert, and the defaulting fourth argument silently
  stripped `IS_SYSTEM_ADMIN` from existing rows — including the caller's own.)
  The target must be all digits. Provenance (`ADDED_BY`, `ADDED_AT`) is recorded.
- `/set_role <telegram_id> <tier> <queue> [role]` — System Admin only. Writes
  tier/queue (still needed by the fallback) and optionally the new `ROLE`. It
  can never change `IS_SYSTEM_ADMIN`. Run against a deactivated admin it also
  **reactivates** them — the one obvious way back from `/remove_admin`. The
  target is notified of the change.
- `/remove_admin <telegram_id>` — System Admin only. Sets `ACTIVE=FALSE`; never
  deletes the row, so the identity behind historical log entries survives.
  Refuses self-deactivation and refuses to deactivate the **last active System
  Admin**. The target is notified.
- `/admins` — System Admin only. Lists every row with flags (`SYSTEM`,
  `DEACTIVATED`), provenance, and the active-System-Admin count.

**System Admin can be granted two ways:** by editing the ADMINS sheet directly
(now noisy by design), or by passing `true` as the optional **fourth** argument
to `/add_admin` — **new rows only**. Changing the flag on an existing row is a
deliberate sheet edit; no command does it, so it can never happen by accident.
There is likewise no command to *revoke* System Admin.

### 6.5 Command reference

All nineteen commands, their syntax, and what each requires. **Recognition is by
name, not by sender**: `routeAdminCommand_` matches the command word first and
then rejects a non-admin with "You are not registered as an admin." Anything not
in this list (a typo like `/foo`) falls through to ordinary text handling and gets
the usual topic-picker fallback.

`/help` and `/privacy` are deliberately **not** in this list — both are
teacher-facing and handled in `Webhook.gs` before the admin dispatcher, so a
teacher typing them gets an answer rather than an admin rejection. Admins get
the teacher help plus this command list appended.

| Command | Syntax | Requires |
|---|---|---|
| `/whoami` | `/whoami` | Any active ADMINS row — reports role, fields, and the exact capability list |
| `/cases` | `/cases` · `/cases all` · `/cases unassigned` · `/cases <status>` | `case.view`; results filtered by queue + region |
| `/mycases` | `/mycases` | `case.view`; open cases assigned to you |
| `/urgent` | `/urgent` | `case.view`; results filtered by queue + region |
| `/case` | `/case <reference>` | Visibility of that case (queue + region) — shows `LAST_ACTOR` |
| `/reply` | `/reply <reference> <message>` | `case.update` + visibility |
| `/close` | `/close <reference> [reason]` | `case.update` + visibility |
| `/reopen` | `/reopen <reference>` | `case.update` + visibility |
| `/assign` | `/assign <reference> <telegram_id>` | `case.assign` + visibility; assignee must be an active admin who can also see the case |
| `/note` | `/note <reference> <note>` | `case.update` + visibility |
| `/search` | `/search <term>` | `case.view`; results filtered by queue + region |
| `/export` | `/export <reason>` | **`export` capability** (Manager+). Reason ≥10 chars, recorded; other System Admins notified |
| `/announce` | `/announce <ALL\|region> <message>` → `/announce confirm` \| `cancel` | **`announce` capability** (Manager+). Two-step: draft + preview first, nothing sends without `confirm` |
| `/generate_urgent_code` | `/generate_urgent_code` | **`urgent.issue` capability** (Agent+) |
| `/add_admin` | `/add_admin <telegram_id> [tier] [queue] [true\|false] [role] [name]` | **`admin.manage`** (System Admin). New rows only |
| `/set_role` | `/set_role <telegram_id> <tier> <queue> [role]` | **`admin.manage`**. Also reactivates a deactivated target |
| `/remove_admin` | `/remove_admin <telegram_id>` | **`admin.manage`**. Deactivates, never deletes |
| `/admins` | `/admins` | **`admin.manage`** |
| `/maintenance` | `/maintenance on\|off` | **`maintenance`** (System Admin) |

A System Admin bypasses every capability, queue and region check.

**Behaviour worth knowing:**

- **Every authorization denial is logged** as `ADMIN_DENIED` with the command and
  the caller's system/tier/queue shape — privilege probing leaves a trace (§13).
- `/cases` with no argument lists **open cases only**. `/cases all` includes
  closed and completed. `/cases unassigned` is the intake backlog — open cases
  with no `OWNER`. A status argument may contain spaces (`/cases Under review`)
  — the remainder is treated as one phrase, not split.
- `/cases`, `/urgent` and `/search` cap output at **20 rows**; `/cases` says so and
  points at `/search`.
- `/urgent` shows escalated cases, plus overdue ones **only if** `OVERDUE_DAYS` is
  set in SETTINGS. Until then it says so rather than inventing an SLA. The same
  threshold drives the daily digest (§11).
- `/assign` validates the assignee: not an active admin, or an admin who cannot
  see the case, is refused. The assignee is notified in Telegram; a failed
  notification is reported back to the assigner.
- `/announce` is two-step: the first call stores a per-admin draft (Script
  Properties, 1-hour expiry) and shows a preview with the recipient count;
  only `/announce confirm` delivers. Drafting is itself logged
  (`ANNOUNCEMENT_DRAFTED`) — an abandoned draft is exactly what an audit trail
  should show.
- `/note` appends to `DETAIL` (internal, timestamped, attributed). `/reply` writes
  `PUBLIC_UPDATE` and messages the teacher. The two never cross.
- `/export` writes a CSV **excluding `DETAIL`** — a per-case read via `/case` is
  fine, a bulk file leaving the bot is a larger exposure surface. It requires a
  recorded reason and notifies the other System Admins (§13).
- `/reply`, `/close` and `/reopen` detect an `UNRESOLVED:` sentinel chat and report
  "nothing was sent" rather than claiming a delivery that could not happen.
- Every mutation reports a lock failure to the admin instead of vanishing
  silently, and stamps `LAST_ACTOR`.

### 6.6 Urgent code lifecycle

The one flow that spans an admin and a teacher:

1. An admin with the **`urgent.issue`** capability (Agent role or above) runs `/generate_urgent_code`
2. A 6-character code is stored in **Script Properties** — not `CacheService`,
   which can evict early and would silently void a code the bot promised was good
   for 48 hours
3. The admin passes it to the teacher **by phone or in person** — never through
   the bot
4. The teacher taps **🚨 Urgent Case**, passes the verification gate, and types
   the code
5. `consumeUrgentCode_` **deletes the code immediately, valid or not**, so a
   leaked or guessed code cannot be replayed, then checks the stored expiry
6. On success the chat enters `AWAITING_CASE_DETAIL` with a **6-hour** TTL and the
   resulting case is filed as `Escalated`

**TTL is 48 hours from issue.** Unused codes are swept by the `runArchive`
trigger, so they do not accumulate in Script Properties forever.

**If the case deduplicates** (§7.3) the urgent detail is appended to the existing
case and that case is escalated — the code is never burned for nothing.

**A code cannot be recovered.** It is consumed at step 5, before the teacher
writes anything. A teacher who takes longer than 6 hours to reply loses it and
must ask the admin for a new one.

---

## 7. Case lifecycle

### 7.1 Statuses

| Status | Open? | Meaning |
|---|---|---|
| `New` | ✅ | Just created |
| `Received` | ✅ | Acknowledged |
| `Under review` | ✅ | Being worked |
| `Action required` | ✅ | Waiting on the teacher |
| `Escalated` | ✅ | Urgent |
| `Completed` | ❌ | Resolved |
| `Closed` | ❌ | Closed |
| `Duplicate` | ❌ | Merged elsewhere |

Terminal statuses (`Completed`, `Closed`, `Duplicate`) are the only ones eligible
for archiving.

### 7.1.1 New-case notification

Every created case notifies the admins who could actually act on it —
`notifyAdminsOfNewCase_` filters the ADMINS sheet through `adminCanSeeCase_`
(active + queue + region), capped at 20 recipients. Urgent cases send 🚨, others
🆕; the message carries the reference, category, timestamp and ready-to-tap
`/case` and `/assign` lines, but **never the case DETAIL** — admins read that
with `/case`, and a teacher's free text is not copied into N Telegram histories.
Delivery is logged (`ADMINS_NOTIFIED_NEW` / `ADMINS_NOTIFIED_URGENT`, chat_id
`SYSTEM`) with a delivered/total count; zero authorized recipients is logged as
an error naming the category. Escalating an existing case via a duplicate urgent
submission notifies too. Unresolved-submitter document cases notify every
queue-matching admin — they are the cases only a human who knows they exist can
triage.

### 7.1.2 Overdue push — the daily digest

`runDailyDigest` (time-driven, 07:00) sends each active admin a personal ⏰
worklist of the open cases *they can see* that have had no update for
`OVERDUE_DAYS` days, with the unassigned count called out. No `OVERDUE_DAYS`
row → the digest skips and logs. `OWNER` is load-bearing now: `/assign`
validates and notifies, `/mycases` and `/cases unassigned` read it.

### 7.2 Reference generation

`PREFIX-YYYY-NNNNN`. Prefix by category: `VISA`, `TRAVEL`, `CONTRACT`, `ACCOM`,
`SUPPORT`, `DOCS`, else `CASE`.

The sequence counter lives in Script Properties (`CASE_SEQ_<PREFIX>_<YEAR>`), not
derived from a sheet scan. This is deliberate: a scan-derived sequence
under-counts the moment archiving removes current-year rows, and would reissue an
already-used reference. On first use for a prefix/year it seeds from the sheet's
current maximum, then never scans again.

### 7.3 Deduplication

On creation, if the same chat has an **open** case in the **same category**
created within **24 hours**, the existing reference is returned instead of a new
case. The teacher is told it was not duplicated.

**Urgent + deduplicated** remains common — an urgent submission files under the
generic category, so it dedups against any open generic case from the last 24
hours. Rather than dropping the escalation (which would burn the teacher's
single-use code for nothing), the urgent detail is appended to the existing case
and that case is escalated. Dedup is per-category, so now that Contact Support
files under real topics, a Visa case and an Accommodation case opened the same
day are two distinct cases — they no longer collapse into one.

---

## 8. Conversation model

### 8.1 State machine

One consolidated `CacheService` entry per chat (`chat_state_<chatId>`), so there
is a single TTL and no risk of two flags disagreeing.

| State | Set by | Next text message is treated as | TTL |
|---|---|---|---|
| *(none)* | default | Unrecognised → topic picker (`QTOPIC:`), question remembered | — |
| `CATEGORY` | Entering a topic | An FAQ query scoped to that topic | 30 min |
| `AWAITING_TOPIC_FOR_QUERY` | Typing a question with no topic | *(buttons, not text — carries `pendingQuery`)* | 30 min |
| `AWAITING_IDENTIFIER` | Gated feature, unverified | A roster identifier (max 5 attempts) | 30 min |
| `AWAITING_CASE_DETAIL` | Contact Support topic pick / valid urgent code | The case description — carries `category` from the picker | 30 min *(6 h if urgent)* |
| `AWAITING_URGENT_CODE` | Urgent Case | A single-use urgent code | 30 min |

The urgent-detail state gets the longest TTL `CacheService` permits, because by
that point the teacher's 48-hour admin-issued code has already been consumed.

Note the first row: **with no state, typed text is never matched against the
FAQ** — but it is no longer a dead end. The question is logged
(`QUERY_WITHOUT_TOPIC`), remembered, and answered in whichever topic the teacher
then taps. See §9.0 — the one-topic constraint stands.

### 8.1.1 Non-standard inbound messages

| Input | Behaviour |
|---|---|
| **Edited message** | Acknowledged, never acted on. The teacher is told *"I only read new messages"* and asked to resend. Silence here previously meant a re-edited case description filed a second time |
| **Photo / file / voice / sticker / location / contact** | Refused with a message naming that specific type, pointing at Submit Documents. The bot never accepts uploads in chat |
| **Photo or file with a caption** | The caption is treated as the message text and routed normally; the attachment is still refused. Subject to §9.0 — a caption question is only *answered* if the chat is inside a topic |
| **`/start <payload>`** (deep link) | Treated as `/start`. No payload carries meaning yet |
| **`/foo`** (unknown command) | Falls through to ordinary text handling, not an admin rejection |
| **Message from a group** | Ignored. If the update is the bot being *added* to a group, it leaves immediately |
| **Callback older than ~48 h** | Telegram omits `message`; the chat is resolved from `callback_query.from` instead. The spinner is always stopped first |

### 8.1.2 Display caps

| Surface | Cap |
|---|---|
| Check My Case | 10 most recent, with a count of the remainder |
| `/cases`, `/urgent`, `/search` | 20 rows |
| FAQ topic browsing | 8 per page, paged |
| FAQ search picker | Top 8, unpaged (ranked results — paging is not meaningful) |
| `/announce` failure list | First 20 recipient IDs |
| `onEdit` manual-edit notification | 50 rows per edit; a larger paste notifies nobody and logs |

### 8.2 Menu structure

**Main menu:** 4 topic shortcuts (Visa, Travel and Arrival, Contract Signing,
Accommodation) + All FAQ topics · Submit Documents · Check My Case · Contact
Support · Change Language · Urgent Case.

**FAQ hub:** all 11 topics + Main Menu.

Both are generated from `FAQ_TOPICS`. Adding a topic there makes it appear in the
hub, become valid in `isKnownCategory_`, and route correctly — no other edit.

### 8.3 Callback protocol

| Prefix | Meaning |
|---|---|
| `MENU:MAIN` / `MENU:FAQ` | Main menu / topic hub |
| `MENU:<ACTION>` | `SUBMIT_DOCS`, `CHECK_CASE`, `CONTACT_SUPPORT`, `CHANGE_LANGUAGE`, `URGENT_CASE` |
| `MENU:<TOPIC_KEY>` | Enter an FAQ topic |
| `CASETOPIC:<key>` | Contact Support topic chosen (`VISA`/`TRAVEL`/`CONTRACT`/`ACCOMMODATION`/`OTHER`) — re-checks maintenance and verification before prompting for detail |
| `QTOPIC:<key>` | Topic chosen for a remembered typed question — answers it there without retyping |
| `FAQOK:<CODE>` / `FAQBAD:<CODE>` | ✅/❌ answer feedback — logged as `FAQ_HELPFUL` / `FAQ_NOT_HELPFUL`; ❌ offers Contact Support |
| `CAT:<label>` | Back to a topic (validated against `FAQ_TOPICS`) |
| `FAQPG:<page>:<label>` | Paged topic browsing |
| `FAQANS:<CODE>` | Send one FAQ answer |
| `DOC:<key>` | Send a document form link |

`callback_data` is capped at **64 bytes** by Telegram. Unknown callbacks fall
back to the main menu rather than doing nothing.

---

## 9. FAQ engine

### 9.0 Free-text matching is scoped to one topic — there is no global search

**This is the single most surprising constraint in the system, so it is stated
first.** `answerFaqQuery` is reachable from exactly one place: the `CATEGORY`
branch of `handleTextMessage_`. A teacher must be **inside a topic** for typed
questions to be matched at all.

Typing a question anywhere else — at the main menu, at the FAQ hub, right after
`/start`, or after any screen that clears the state — does **not** search the
answer bank. But it is no longer a dead end: the question is remembered
(`AWAITING_TOPIC_FOR_QUERY`, logged as `QUERY_WITHOUT_TOPIC`) and the teacher is
shown the full topic list; tapping one answers the remembered question inside
that topic without retyping. A teacher who types "how much tax" at the main menu
now reaches the salary answer in two taps.

This scoping is deliberate (proposal §4.2: precision over recall — a visa
question must never be answered from the accommodation bank). Adding global
search would mean scoring the whole bank at once and accepting cross-topic false
positives. That trade has not been made.

**Answer feedback:** every confidently-returned answer carries ✅ *That helped* /
❌ *Not what I meant* buttons (dropped only if the `CODE` would push
`callback_data` past 64 bytes, with a logged warning). ❌ logs `FAQ_NOT_HELPFUL`
against the `CODE` and offers Contact Support — the signal that an answer was
returned *confidently and was still wrong*, which no other log row captures.
Together with `FAQ_NO_MATCH`/`FAQ_LOW_CONFIDENCE` (logged on misses and shaky
matches) this is the content feedback loop; RUNBOOK Part 4 defines the monthly
review that reads it.

### 9.1 Matching

Scoring is **token-based, not substring** — `query.indexOf(keyword)` once matched
"fee" inside "coffee" and returned that as an approved answer.

| Evidence | Score |
|---|---|
| Multi-word keyword found as a phrase | +2 |
| Single-word keyword equals a query token | +2 |
| Query token within edit distance of a keyword | +1 |

Typo tolerance scales with word length: ≥8 chars → 2 edits, ≥5 → 1, shorter → 0
(at 4 characters, distance 1 makes "visa" match "visit").

**Answer selection:** a single answer is returned only when exactly one row holds
the top score **and** that score is ≥ 2. Anything else — a tie, or evidence that
was only fuzzy — produces a picker. The bot never guesses.

### 9.2 Caching

The FAQ sheet is cached for **6 hours**, split across numbered chunk keys
because `CacheService` has a hard 100 KB per-value limit and the answer bank
exceeds it. A partial chunk set is treated as a miss. Every cache operation
degrades to a direct sheet read on failure — a slow bot beats a silent one.

Editing the FAQ tab fires `onEdit` → `clearFaqCache()`, so approved corrections
reach teachers immediately rather than after up to 6 hours.

### 9.3 Keyboard safety

Before rendering, every row is checked: blank `BUTTON_TEXT` or `callback_data`
over 64 **bytes** would make Telegram reject the *entire* message with HTTP 400,
not just that button. Offending rows are skipped and logged with their `CODE`.

Category browsing is paginated at 8 per page. Search pickers show the top 8
matches without paging — those are ranked results, so paging is not meaningful.

---

## 10. Document submission

**The feature hides itself until a real form exists.** `FORM_URLS` ships with
`PLACEHOLDER_` URLs; `documentSubmissionEnabled_()` (FormRouter.gs) treats a doc
type as real only once its URL stops being a placeholder. With zero real forms
the 📤 button and its `/help` line disappear entirely, a stale button from an
earlier deployment gets a polite "not open yet" reply, and `formUrlForDocType_`
refuses placeholder URLs outright. Filling in one real `FORM_URLS` entry brings
the feature back, offering only that doc type — no other change needed.

1. Teacher taps **Submit Documents** → verification gate → doc-type list
2. `formUrlForDocType_()` returns the form URL, appending
   `&entry.<id>=<chatId>` when that doc type has a prefill entry ID
3. Teacher submits the Google Form
4. `handleFormSubmit` resolves the doc type from the form ID (stored in Script
   Properties at trigger-install time) and the chat ID from the response
5. If the chat ID resolves **and** is verified → case created + confirmation sent
6. Otherwise → case created under an `UNRESOLVED:<id>` sentinel for manual triage

**The chat-ID field is a normal, visible, editable form question** — Google Forms
has no hidden fields. It is therefore treated as a hint, never as identity, and
is trusted only when it resolves to an already-verified chat.

**Seven doc types:** Visa · Contract · Passport · Ticket · Reimbursement ·
Certificate · Correction.

---

## 11. Triggers and scheduled jobs

Installed by `installTriggers()`. All handlers are **public-named** (no trailing
underscore) — Apps Script treats trailing-underscore functions as private and
binding triggers to them is unsupported.

| Handler | Type | Purpose |
|---|---|---|
| `handleSheetEdit` | Spreadsheet `onEdit` | FAQ cache invalidation · **ADMINS hand-edit alert** · USERS cache invalidation · CASES manual-edit notification |
| `handleSheetChange` | Spreadsheet `onChange` | Row deletions → bump verification epoch |
| `runArchive` | Time-driven, 14 days | Archive old rows · sweep expired urgent codes |
| `runDailyDigest` | Time-driven, daily 07:00 | Per-admin overdue-case worklist (§7.1.2) |
| `handleFormSubmit` | Per-form `onFormSubmit` | **Installed separately**, once per real form |

**ADMINS hand-edit alert:** any direct edit of the ADMINS tab messages every
active System Admin (🔐, with editor email where the Workspace domain exposes it,
and the edited range) and logs `ADMINS_SHEET_EDITED`. The bot's own
`/add_admin` / `/set_role` / `/remove_admin` writes set a 60-second suppression
marker first — mirroring `CaseManager.gs`'s `onEditSuppressKey_` — and
`upsertAdminRow_` writes the whole row in **one** `setValues` call so a single
command is a single edit event, not eight.

These must be **installable** triggers, never the reserved simple-trigger names
`onEdit(e)`/`onFormSubmit(e)` — simple triggers run in restricted auth mode and
cannot call `UrlFetchApp`, so they would silently fail to notify anyone.

`handleSheetEdit` skips programmatic writes: `updateCaseFields_` sets a
short-lived suppression marker before writing, so the teacher is not notified
twice for the same change. Multi-row edits are handled up to a 50-row cap.

---

## 12. Concurrency model

Google Sheets has no row-level locking, and webhook executions run concurrently.
Every read-then-write path takes `LockService.getScriptLock()`.

Every path that writes **teacher-facing or high-frequency** data takes
`LockService.getScriptLock()`. Coverage is not universal — see the unlocked rows
below and the rationale that follows.

| Path | Lock | Timeout |
|---|---|---|
| `createCase` (dedup → append) | ✅ | 5 s (throws on failure) |
| `updateCaseFields_` (find row → write) | ✅ | 5 s (throws on failure) |
| `attemptVerify_` (roster match → bind) | ✅ | 5 s |
| `logInteraction` (append) | ✅ | 3 s (drops the row on failure) |
| `setSettingValue_` (find row → write/append) | ✅ | 5 s (throws on failure) |
| `updateAnnouncementStatus_` | ✅ | 10 s |
| Archive sweeps | ✅ per sheet | 30 s (skips the pass) |
| `upsertAdminRow_` (`/add_admin`) | ❌ | — |
| `setAdminTierQueue_` (`/set_role`) | ❌ | — |
| `appendAnnouncementRow_` | ❌ | — |
| `consumeUrgentCode_` (get → delete) | ❌ | — |

**The unlocked paths are a deliberate, bounded exception, not an oversight.** All
four are low-frequency and human-paced: admin-role writes happen a handful of
times in the system's life and only a System Admin can trigger them, and an
urgent code is typed once by one teacher. The theoretical races are a lost
role-write when two System Admins edit the same admin in the same second, and a
code consumed twice if two chats submit the same 6-character code simultaneously
— the latter also requires guessing a UUID-derived code inside its window. If
either path ever becomes concurrent, wrap it the way `setSettingValue_` is.

**Locks are never nested.** `logInteraction` takes the same script lock, so it
must never be called from inside another critical section — the inner
`releaseLock()` would drop the outer caller's protection early. `attemptVerify_`
performs all logging and messaging *after* releasing.

**This is a global mutex, not per-row.** It is the throughput ceiling of the
whole bot (see §15).

---

## 13. Security model

| Control | Implementation |
|---|---|
| Webhook authenticity | Shared secret required as a URL query parameter; mismatches are dropped silently with no explanation |
| Update replay | `update_id` deduplicated for 10 minutes |
| Identity | Roster match required before any case action |
| Brute force | 5 verification attempts per session |
| Group exposure | Non-private chats rejected; the bot actively leaves groups it is added to |
| Injection | No `parse_mode` is ever sent, so teacher text cannot break message formatting |
| Callback forgery | `CAT:` and `FAQPG:` categories validated against `FAQ_TOPICS`; `DOC:` keys resolved with `hasOwnProperty` so a crafted `DOC:constructor` cannot reach an inherited prototype member; `FAQANS:` codes resolve to a real row or a clean "no longer available" reply; unknown callbacks fall back to the main menu |
| Secret storage | Script Properties only — no secrets in source |
| Data minimisation | Identifiers stored once; failed attempts logged redacted |
| Internal data | `DETAIL` never surfaced to teachers; `getCasesForChatId` strips it structurally; excluded from `/export` and from new-case notifications |
| Privilege probing | **Every** authorization denial — queue, region, capability, or system — logs `ADMIN_DENIED` with the command and the caller's permission shape |
| Impersonation visibility | A second chat verifying an already-held identifier alerts System Admins and the prior holder (`IDENTITY_DUPLICATE_BINDING`) — detected, not blocked |
| Permission-boundary bypass | The ADMINS sheet is the real access boundary (Drive sharing). Hand edits cannot be prevented from Apps Script, but they alert every System Admin and are logged (`ADMINS_SHEET_EDITED`) |
| Bulk exfiltration | `/export` requires a recorded reason (≥10 chars) and notifies the other System Admins; mass sends require an explicit `/announce confirm` after a preview |

**Not protected against:** an admin with sheet access seeing everything (by
design — they are staff); Telegram itself; a teacher forwarding their own form
link to someone else (mitigated by verification-on-submit, not prevented);
identity impersonation via a known roster email (made visible by the
duplicate-binding alert, prevented only by per-person one-time codes — an open
product decision).

---

## 14. Error handling

**`doPost` never throws.** Every path is wrapped; it always returns HTTP 200. If
it did throw, Telegram would retry the update indefinitely.

**`TelegramAPI.gs` never throws.** Network failures, HTTP errors and non-JSON
bodies all return `{ok: false, description}`. **Therefore every caller that tells
a human "sent" must check `.ok` first** — a `try/catch` around `sendMessage`
catches nothing.

**Messages over 4096 characters** are split at 3900 with paragraph-preferring
breaks; `reply_markup` attaches only to the final chunk.

**Admin mutations** that fail to take the lock report the failure to the admin
rather than vanishing into the `doPost` catch.

---

## 15. Known limits and quotas

| Limit | Value | Consequence |
|---|---|---|
| Apps Script execution | 6 min | `/announce` self-caps at 4.5 min |
| Global script lock | 1 concurrent writer | Throughput ceiling |
| `CacheService` value | 100 KB | FAQ cache is chunked |
| `CacheService` TTL | 6 h max | Urgent-detail state cannot exceed 6 h |
| Telegram message | 4096 chars | Auto-split at 3900 |
| Telegram `callback_data` | 64 bytes | FAQ `CODE` must stay under ~57 |
| Telegram bulk send | ~30 msg/s | `/announce` paced at 60 ms |
| `UrlFetchApp` | Daily quota | Bounds total messages/day |

---

## 16. Deferred / not built

- **Multilingual content.** `LANGUAGE` columns exist; only `EN` is populated.
- **Drive file retention.** The bot never touches Drive; submitted files live in
  each Form's own folder. Purging is deferred until real forms exist.
- **Asynchronous `/announce`.** The send loop (behind `/announce confirm`) is
  still synchronous inside the webhook; safe because of `update_id` dedup, but
  the request may time out on very large audiences. Queue it if the roster
  passes ~500 (UPGRADE-PLAN Task 6.3).
- **Global free-text FAQ search.** Matching is scoped to one topic by design
  (§9.0); the topic picker softens the dead end without changing the trade.
  Cross-topic search would need a false-positive policy that has not been agreed.
- **Locking on admin-role writes and urgent-code consumption** (§12). Bounded and
  low-frequency; listed so it is a decision rather than an omission.
- **System Admin revocation by command.** Sheet edit only (and now alerted).
- **Per-person one-time verification codes.** Email identifiers stay guessable
  by colleagues; duplicate bindings are detected (§5) but not prevented.
- **Dedicated queues for the seven newer FAQ topics.** Deliberately mapped onto
  the four existing queues instead (`queueForCategory_`) — resolved, not pending.

*(Built since v1.1 of this document and no longer deferred: topic-aware case
creation with queue+region scoping, new-case notification, the overdue digest,
admin lifecycle commands, the ordered-role capability table, two-step
`/announce`, `/export` justification, FAQ miss logging and answer feedback.)*

### Superseded documents

`bot_spec.md` and `proposal_gap_analysis.md` were **deleted on 2026-07-27**.

The first described `MessageHandler.gs`, `CallbackHandler.gs`, `FormGenerator.gs`,
`EmailParser.gs`, `CAND-0042` deep links and a 7-column flat sheet — none of
which exists. The second was a mid-build status table that was wrong in both
directions: it marked as RESOLVED at least seven features that were never built,
and as NOT DONE two that were (`/maintenance`, token revocation).

Neither should be reinstated. **This document is the specification**, `RUNBOOK.md`
is how to operate the system, and `UPGRADE-PLAN.md` is what remains to be done.
`DEPENDENCY_TREE.md` is still current.

> Source-comment debt, recorded rather than fixed: `CaseManager.gs:8` still names
> `proposal_gap_analysis.md`, and `PLAN.md` — the build-order document, also gone
> — is cited 32 times across eight `.gs` files, usually as the justification for
> a lock or a guard. The reasoning those comments point at now lives in §12 of
> this document. Retargeting them is a mechanical pass worth doing, but it
> changes no behaviour and is not scheduled.
