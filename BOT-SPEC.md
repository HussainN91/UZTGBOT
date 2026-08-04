# MoPSE Teacher Support Bot — System Specification

**Version:** 1.7 · **Date:** 2026-08-02 · **Status:** Pre-launch — updated after the 2 August audit fixes

> **What changed in 1.6.** §5 gains identity disputes: a duplicate binding no
> longer only raises an alarm, it opens a record both accounts can act on and a
> System administrator settles. §16 loses one line from "Later" as a result — the
> one-time-codes entry, which is narrowed rather than removed, because disputes
> protect a teacher who has already signed in and do nothing about an address
> claimed before they ever do.

> **What changed in 1.5.** §10 is rewritten: document submission is **built**, and
> the "not built" heading it carried for five stages is gone. §11.0's sync line,
> §16's deferred list and the non-goals at the top all follow from that. **The
> rebuild now has no unbuilt planned feature.**

This document describes what the bot is, how it is built, and how every layer
behaves. It superseded `bot_spec.md`, which described an architecture that was
never built; that file has since been deleted (see §16).

> ### Read this before trusting any section
>
> **This document is being converted stage by stage, and parts of it still
> describe the Google Apps Script system that is being replaced.** The rebuilt
> sections are the ones that have been rewritten as each stage landed —
> §1, §5, §6, §7.1, §8.1.1, §10, §13 and §16 are current as of 29 July 2026.
>
> **§2 (platform), §4.1–§4.5 (the spreadsheet tabs), §11 (triggers) and §12
> still describe Apps Script**: script locks, `CacheService`, `PropertiesService`,
> spreadsheet triggers and an eight-tab data model. None of that exists in what
> runs now — it is TypeScript on a rented server against PostgreSQL, with two
> spreadsheet tabs read and never written. Those sections are kept because the
> reasoning in them is still the reasoning behind the replacement, and they are
> flagged here rather than half-corrected, because a document that is wrong in
> places nobody has marked is worse than one that says where it is wrong.
>
> **Where a rewritten section and an old one disagree, the rewritten one is
> right.** The clearest case is permissions: §4.5 describes an `ADMINS`
> spreadsheet tab that **no longer grants anything at all** — see §6.

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
   against an official roster, and gives staff the commands to work them.
3. **Will route document submissions** to the correct Google Form — planned, not
   built; see §10, where the direction has been settled and reversed.

**Explicit non-goals:**

- Not a chat relay to human staff — staff act through commands, not live chat.
- **Not a file store.** The bot never accepts, holds or stores a file; all
  documents go through Google Forms. Settled rather than interim, and **built
  that way in Stage 6** — see §10, which reverses a planned move to Telegram
  upload. `sendDocument` exists for `/export` and has no receive path.
- Not multilingual at launch. English only; the language button exists and says so.
- **Not a group-chat bot.** Private chats only; it leaves any group it is added
  to, except the operations chat. **Built in this stage** — this line described
  the control for two versions of this document while nothing implemented it
  (§8.1.1, §13).

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

### 4.5 `ADMINS` — **this tab no longer grants anything**

> **Nothing below is live.** Permissions are in the `staff` table on the server
> and the bot reads two spreadsheet tabs — the roster and the FAQ. **Typing a
> Telegram id into this tab gives that person no access whatsoever**, which is
> the single most important correction in this document: it was the route by
> which anybody who could edit the spreadsheet could make themselves a full
> administrator. See §6, and `RUNBOOK.md` §1.3, which says to delete the tab if
> the original document is being reused. A tab that looks like it works and does
> not is worse than no tab, and this is the one somebody will reach for.
>
> Kept below because the *shape* of it is what §6 replaced, and the reasoning for
> each column is the reasoning for its replacement.

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
| `MAINTENANCE_MODE` | When truthy, pauses Contact Support, Ask for Priority and Submit Documents. FAQ browsing **and Check My Case** stay live — pausing submissions is not the same as locking teachers out of their own case status |
| `OVERDUE_DAYS` | Enables the overdue half of `/urgent` **and** the daily digest (§7.1.2). **Unset, `/urgent` says the feature is switched off** rather than showing an empty list |
| `CASE_RETENTION_DAYS` | Days a resolved ordinary case is kept (§7.1.3) |
| `URGENT_CASE_RETENTION_DAYS` | Days a resolved Urgent or Critical case is kept |
| `MESSAGE_RETENTION_DAYS` | Days the interaction log is kept |

`RETENTION_DAYS` is replaced by the three keys above, because one number cannot
carry three different promises. **Unset means delete nothing**, for every one of
them, and for the same reason `OVERDUE_DAYS` reports itself as switched off: a job
that invents a retention period deletes real records against a number nobody
chose, and there is no undo.

Settings are read through a **60-second cache**, because the maintenance gate is
checked on every case-feature tap. Every write clears it, so `/maintenance` takes
effect on the next message; a value changed by hand in the database takes up to a
minute.

### 4.7 `MESSAGES` and `ANNOUNCEMENTS`

`MESSAGES`: `TIMESTAMP` · `CHAT_ID` · `ACTION` · `DETAIL` — the interaction log.
`ANNOUNCEMENTS`: `ID` · `CONTENT` · `AUDIENCE` · `STATUS` · `CREATED_BY` · `CREATED_AT`.

### 4.8 Archive tabs — **gone**

`CASES_ARCHIVE` and `MESSAGES_ARCHIVE` do not exist. They were a Google Sheets
artefact: rows were moved out of the live tab to keep it small enough to read
quickly, which is not a problem an indexed table has.

**Old rows are now deleted rather than moved** (§7.1.3), and "archive" is the
wrong word for what happens throughout this document.

---

## 5. Identity model — teachers

Two-factor by design: possessing a Telegram account is not identity.

```
Teacher taps a gated feature, or the Sign in button
  → menuAccessFor(chatId)?
      signedIn      → proceed
      accessEnded   → "your access has ended" — NEVER the prompt
      signInOffered → state = AWAITING_IDENTIFIER, prompt for identifier
                      (the prompt includes the full privacy notice — §5.2)
                        → next message checked against ROSTER
                            match    → bind, VERIFIED, resume the original action
                            no match → attempt counter +1, retry (max 5)
```

> **One function answers this for every door — Part 5F.** Sign-in is reachable
> from `/start`, from the Sign in button on the menu, from any of the four gated
> actions, and from `verifyIdentifier` at the end. `menuAccessFor` is the single
> expression of who may pass, and it is the same answer that decides which of the
> three menus (§8.2) a chat is drawn. Four doors sharing one rule cannot drift
> apart; four copies of it eventually will, and the copy that drifts will be the
> one nobody was looking at.
>
> **There are two ways to have lost access and only one of them is `Revoked`.** A
> teacher whose roster row was deactivated — which is what every administrator
> assumes removing a row from the sheet does — keeps `verificationState =
> 'Verified'` and fails on the roster flag. Testing for `Revoked` alone hands that
> teacher the prompt, which is the loop this exists to avoid.

**Duplicate identity bindings are detected, not blocked.** `bindUser_` reads,
before writing, which *other* chats are already `VERIFIED` against the same
roster identifier. When any exist, `attemptVerify_` — after releasing the
script lock — logs an `IDENTITY_DUPLICATE_BINDING` row (identifier redacted),
alerts every active System Admin, and sends the prior holder(s) a security
notice. The new binding still succeeds: a teacher switching phones produces
exactly this signal, and locking them out would be worse than a false alarm a
human can dismiss. This makes impersonation *visible*; only per-person one-time
codes would prevent it (an open product decision).

> ### ✅ A duplicate binding now opens a dispute — Feature A, 2 August 2026
>
> The paragraph above is still exactly what happens, and it was, until now, *all*
> that happened: an alarm reached the operations chat, the prior holder got a
> notice that led nowhere, and the two people it was actually about were never
> asked anything.
>
> A duplicate binding now also **opens an `identity_disputes` record**, and both
> chats receive a message with one button — ⚠️ *This wasn't me* for a prior
> holder, ✅ *This is me — I changed phone* for the new chat.
>
> **Neither button decides anything, and the dispute does not gate access.** The
> new chat signs in and keeps working; the argument runs alongside. Blocking it
> would lock out any teacher who changes phone and would let anyone holding a
> leaked recruitment address lock the real teacher out permanently — the same
> reasoning that made duplicates detected rather than blocked in the first place.
>
> A tap tells the staff who cover **the region on the roster row for the disputed
> identifier** — never the region either chat carries, because a chat's region can
> be overridden and an impostor could otherwise choose their own adjudicator. A
> reviewer (`dispute.review`, floored at `Support`) checks and forwards; a System
> administrator (`dispute.resolve`) chooses which chat keeps the identity. Every
> other chat is `Revoked` and its open cases are **closed with a stated reason,
> not deleted** — if the losing chat was the impostor, its cases are the evidence.
>
> A third chat signing in **joins the existing dispute**, keyed on the identifier;
> there is never a second record for one argument. Nothing expires on its own —
> unsettled disputes stay in `/disputes` and in the morning digest.
>
> `docs/plans/2026-08-02-feature-a-identity-disputes.md` is the design of record.
> **The operations alarm above is unchanged and still fires**, because it is what
> reports a duplicate when *neither* party ever taps anything.

**Gated (requires verification):** Contact Support, Check My Case, Ask for Priority,
Submit Documents.
**Open to anyone:** all FAQ browsing and in-topic question matching (§9.0),
`/start`, `/menu`, `/help`, Change Language.

Submit Documents is gated because `onFormSubmit` calls `createCase()`, which
hard-requires verification — an unverified teacher would otherwise reach a form
only for their submission to become an untraceable "unresolved submitter" case.

### 5.1 Verification is not cached — ✅ rebuilt

There is no verification cache, and no verification epoch. Both existed only
because reading a spreadsheet was expensive; `teachers` is a table with a primary
key, so every check reads the current state.

The whole mechanism the epoch existed to work around goes with it. Revoking a
teacher takes effect on their next message rather than up to thirty minutes
later, and there is no longer a class of bug in which a stale marker outlives the
row it describes.

**Eligibility is checked against the copied roster, not the live sheet.** The
sync deactivates roster rows, it never deletes them, so sign-in reads
`roster_entries.active` — without that, removing a teacher from the spreadsheet,
which every administrator will assume revokes access, would do nothing at all. A
row restored by accident restores access silently within ten minutes.

> **Corrected.** The paragraph above was true only of *signing in*, and this
> document, `RUNBOOK.md` §4.3 and `CONCERNS` A2 all read it as being true of
> access generally. It was not. A teacher who has signed in **never signs in
> again**, and nothing else read that column — so deactivating or deleting a
> roster row changed nothing at all for anybody already using the bot,
> indefinitely, while three documents said otherwise.

**Access is now re-checked on every gated action, and there are two ways to lose
it.** One function answers both questions, because before it existed there were
two answers and they disagreed:

- **`/revoke <chat id>`** writes a revoked state with a name and a time against
  it, which a spreadsheet edit cannot record. **`/restore <chat id>`** is its
  counterpart at the same rank (§6.5).
- **The roster row** being deactivated or removed, which is the route an operator
  will actually use, and which now takes effect on the teacher's next message.

**A missing roster row counts as revoked**, and that risk is accepted
deliberately: the sync refuses any run that would deactivate more than a fifth of
active rows, so a cleared or filtered tab cannot cut everybody off, and a single
row removed by mistake affects one teacher, is visible in the sync history, and is
undone by putting the row back.

> **A revoked teacher cannot sign in again to undo it**, and this is load-bearing
> rather than incidental. Binding a chat to a roster identity clears the revoked
> mark as a side effect — which is correct for a teacher who changed phone, and
> would otherwise make `/revoke` reversible by anybody it was used on. So the
> sign-in prompt is not offered to a revoked chat, and the binding itself refuses
> one. `/restore` is that door being opened by somebody with the authority to open
> it.
>
> **The two causes have one symptom, and only one has an undo in the bot.** A
> teacher whose roster row went is *not* revoked — their record still says
> verified — so `/restore` cannot help them and recruitment has to put the row
> back. `/restore` reads the roster before it reports anything and names which of
> the two situations it found, because a command that reports success while the
> teacher stays locked out is worse than having no command.

### 5.2 Privacy

**A privacy notice is shown before any data is collected.** `PRIVACY_NOTICE_TEXT`
(Config.gs — flagged for manual review before go-live) is embedded in the
verification prompt, and ~~replying with~~ **sending** an identifier is treated as
acknowledgement. It is retrievable at any time with `/privacy`, which is
teacher-facing and handled ahead of the staff dispatcher (same pattern as
`/help`). The notice names the data held, its use, its audience, and the contact
route for access/removal requests.

> **Reworded 3 August 2026, at `PRIVACY_NOTICE_VERSION` `2026-08-03.1`.** The
> instruction now comes **before** the notice rather than after it, and says
> *"Enter your email address"* — it used to say *"reply with"*, which reads as a
> Telegram reply, a real thing a teacher can do and the wrong one. The notice
> still travels in the same message, so sending the address is still the
> acknowledgement and cannot be separated from what was shown.
>
> **The access-and-removal route changed.** It named the support contact alone
> and now names **the regional admin first** — a person a teacher can reach, and
> the one already handling their cases. The support contact stays underneath it
> for the teacher who has no recorded region, for whom the first line names
> nobody.
>
> Everything else is the same promise in plainer words. See
> `docs/plans/2026-08-03-buttons-for-cases-and-staff-design.md` §7.

**The notice is now generated from the retention settings, and no number is
typed into its text.** A settings row and a hard-coded sentence can disagree; a
sentence produced from the row cannot, and it cannot disagree *silently* the next
time somebody edits a period. **A test reads the module's own source and fails if
a number of days appears in it.** With no period set the notice says so — that the
records are kept until the Ministry sets one — which is exactly what the system is
then doing.

**Every teacher who signed in under the old wording is asked to accept the new
one**, once, in front of Contact Support, Ask for Priority and Check My Case. The FAQ,
`/privacy`, `/help` and `/start` are untouched: the answer bank has always been
open, maintenance mode deliberately leaves it running, and a teacher looking up a
public answer is not somebody anything is being collected from. One tap, and the
teacher lands back on what they were trying to do.

**When a teacher is asked again is computed, never remembered by a person**, and
the rule is deliberately **asymmetric**:

- The **wording version** changed, **or**
- any current period is **longer** than the one that teacher accepted.

**Shortening never asks anybody.** Deleting sooner than promised breaks no
commitment, and putting 1,800 people through a re-consent to be told their data
goes sooner is a cost with no beneficiary. `null` — kept indefinitely — is treated
as the longest period there is, in both directions.

> **Why not a hash of the notice text**, which is the obvious cheap answer: any
> hash changes when a period is *shortened* too, and a hash cannot express an
> asymmetric rule. It would cost 1,800 taps to tell people good news.
>
> **Why not the version string alone:** the notice is generated, so its text can
> now change without a deploy. A rule in code cannot forget to notice that; a
> person editing a settings row can. `PRIVACY_NOTICE_VERSION` keeps its name and
> now versions **the wording only** — the periods each teacher accepted are
> recorded on their own row beside it.

The accept button carries the wording version **and the three periods it was shown
with**. If either has moved between the notice being displayed and the button
being tapped, the notice is shown again rather than an acceptance being recorded
for text the teacher never saw.

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

Without this the redaction above was decorative: the raw email was logged in full
by the webhook a few lines before `attemptVerify_` redacted it, and the free-text
case description that §4.2 keeps out of Check My Case was logged in full too.

**One rule was added for staff, and it is on the prefix rather than on a list.**
Any message beginning with `/` is logged as its command word and its first
argument only; the rest is dropped. Staff have no conversation state, so the table
above does not apply to them, and `/note VISA-2026-00001 <the internal note>`
would otherwise be written almost verbatim into a table with a different retention
story from the one that text belongs to. A *list* of commands to redact is a thing
somebody forgets to extend; the prefix covers a command added later on the day it
is written, and leaves `/start`, `/privacy` and `/help` — which carry no arguments
— logged exactly as they were.

**This log is deleted, not archived**, on the schedule in §7.1.3. Anything written
there lasts three days.

FAQ queries and everything else are logged verbatim — they carry no identity.

### 5.3 The regional manager a teacher is shown

A teacher can ask **"who covers my region?"** from the main menu. They are shown
the **name**, and where one is published the **Telegram handle**, of the most
junior active staff member holding `case.update` whose queue and region cover
them.

**It is deliberately behind neither gate** — not the sign-in gate and not the
re-consent one. Somebody who cannot sign in and needs a person to say so to is
exactly who asks this, and "please sign in first" is the one answer that does not
help them.

**The lowest rank that covers them, not a list.** Five names is a teacher deciding
who to bother, and the senior people are the ones they will choose.

**Nobody who cannot act is ever named**, so an Observer covering a region is not
shown. When there is nobody, the teacher is given the support address and **is
told nothing about staffing** — "no manager is assigned to your region" is an
operational fact a teacher can do nothing with, and it is not theirs to worry
about.

**The region is resolved the way everything else resolves it** — the staff-set
override first, then the roster — and never from the snapshot taken at sign-in. A
teacher shown last year's manager is worse than a teacher shown nobody.

**When nobody names the teacher's region explicitly**, somebody covering every
region answers instead: an empty region list means *everywhere*, which is what
lets a small team cover the country. Whoever names the region explicitly is
preferred over whoever covers them all, and rank breaks the remaining tie. **Until
the regions are entered by hand, every staff member covers everywhere and the
answer is therefore decided by rank alone** — see `RUNBOOK.md` §2.6.

> #### The published handle is verified, never trusted
>
> **A Telegram username is not an identifier. It is a label its owner can
> release** — and once released, anybody can claim it. So the bot checks that the
> handle still resolves to that staff member's own Telegram id: once when it is
> set, and again every morning. A handle that stops matching is cleared, and both
> the staff member and the operations chat are told.
>
> **Every other stale value in this system degrades towards nothing happening.
> This one degrades towards the wrong thing happening** — 1,800 teachers pointed
> at a stranger by the Ministry's own bot, confidently, silently, for months. The
> check is one API call against a value that changes about never, and it turns a
> silent wrong answer into an alarm.
>
> The bot deliberately does **not** read handles from Telegram and keep them
> current by itself: a lookup by numeric id does not reliably return a username,
> and a mechanism that silently sometimes works is worse than one a person
> maintains.

**One cost has no technical answer and is recorded rather than solved.** A teacher
who can message a manager directly will sometimes do that instead of opening a
case, and that work then has no reference, no queue, no owner, no promised date,
no retention rule and nothing for the next person to read. The wording sends
anything needing a record back to Contact Support, and wording is the only control
there is. **A fall in case volume after this shipped should be read as work moving
rather than as work disappearing.**

---

## 6. Identity model — staff

Completely separate from teacher verification. The two gates must never be
merged: a verified teacher has no staff rights, and a staff member's rank says
nothing about whether they are a verified teacher.

**Permissions live in the `staff` table on the server**, and there is no other
route to them. In the Apps Script version they lived in a spreadsheet tab, so
anybody who could edit the spreadsheet could make themselves a full
administrator. That tab is now inert; if the original document is reused it
should be deleted (`RUNBOOK.md` §1.3).

### 6.1 The dimensions

**Authorization is decided by an ordered rank and a capability table**
(`src/staff/roles.ts`). One table is read both by the gates and by `/whoami`, so
what the bot reports can never disagree with what it enforces — the Apps Script
version drifted precisely because those were two lists.

| Dimension | Values | Meaning |
|---|---|---|
| `role` | `Observer` < `Support` < `Lead` < `Program` < `System` | What class of action is permitted (table below) |
| `queue` | `Visa`, `Travel`, `Contract`, `Accommodation`, `All`, `None` | Which kinds of case are visible (one axis of two — §6.2) |
| `regions` | a list; **empty means every region**, never none | Which teachers' cases are visible (the other axis) |
| `active` | true / false | A deactivated member is not staff; the row stays so history is readable |

### Who a case belongs to — Part 5H, 1 August 2026

**A case is given an owner as it is filed**, and the owner is **whoever has the
fewest open cases** among the staff whose queue and region already reach it.
Nobody claims work; the system distributes it.

- **Open cases only.** The question is who has capacity now, not who has ever
  been busy — counting finished work would push new cases away from whoever has
  been clearing theirs.
- **Ties go to whoever has waited longest for work**, then to the earliest id.
  Both steps are deliberate: without the first, one person takes every case until
  they are no longer tied; without the second the answer is not repeatable, and
  a retried write could put one case in two names.
- **Candidates must hold `case.update`** — the capability for *working* a case.
  **An Observer may read a case and may never own one.**
- **A System member is never given a case by this.** System sees every case in
  the country, which is what stops one in an uncovered region reaching nobody —
  but seeing everything is not the same as working it.

**A case nobody covers is left unowned, deliberately.** That is what
`/cases unassigned` and the digest's third section now report, and the meaning
has changed with it: not *nobody has picked this up*, but **no active staff
member holds this queue in this region** — a staffing gap somebody has to close.

**Moving a case afterwards is `case.assign`, which floors at `Program`** — raised
from `Lead` on 1 August 2026. Distribution is no longer what this command does;
overriding the distribution is, and that is a rarer act. Raising the floor was
only safe once assignment was automatic, because before that a manual `/assign`
was the only thing that ever set an owner.

| Capability | Observer | Support | Lead | Program | System |
|---|---|---|---|---|---|
| `case.view` — `/cases` `/mycases` `/urgent` `/case` `/search` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `case.update` — `/reply` `/await` `/close` `/reopen` `/note` `/due` `/snooze` | | ✅ | ✅ | ✅ | ✅ |
| `case.mark` — `/mark` | | ✅ | ✅ | ✅ | ✅ |
| `case.assign` — `/assign` | | | | ✅ | ✅ |
| `urgent.issue` — `/urgent_pending`, the confirm-urgent button | | ✅ | ✅ | ✅ | ✅ |
| `teacher.region` — `/region` `/regions` | | | ✅ | ✅ | ✅ |
| `teacher.revoke` — `/revoke` `/restore` | | | | ✅ | ✅ |
| `staff.manage` — `/staff` `/staff_add` `/staff_role` **`/staff_queue`** `/staff_region` `/staff_remove`, and the staff menu buttons | | | | | ✅ |
| `maintenance` — `/maintenance` `/retention` | | | | | ✅ |
| `teacher.forget` — `/forget` | | | | | ✅ |
| `announce` — `/announce` `/announce_send` `/announce_cancel` `/announcements` | | | | ✅ | ✅ |
| `export` — `/export` | | | | ✅ | ✅ |

A `System` member bypasses every capability, queue and region check.

**`/username` has no capability at all**, deliberately. Every active staff member
may publish their own Telegram handle and nobody may publish anybody else's, which
is a rule about *whose row* rather than about rank. It is therefore listed in
`/help` directly, because a command with no capability has no row in the table
above to be described from.

**`teacher.forget` floors at System, one rank above `teacher.revoke`.** Revoking
is reversible — that is the whole argument for `/restore` — and this has no undo
whatsoever. The cost is real and is accepted: a Support member who takes a removal
request cannot action it themselves, and escalates to one of the two System
members the launch checklist requires.

`announce` and `export` sat in this table for a whole stage with no command behind
them, which is why building them added commands rather than a permission model,
and why `/whoami` did not have to change twice. `/whoami` lists such a capability
as "no command for this yet" rather than hiding it — hiding it would make the bot
describe a smaller permission model than the one in force.

**Two ranks are worth explaining.**

**`Observer` is the look-but-do-not-touch rank**, added on request for senior
ministry staff, auditors, and new hires in their first week. It is not the Apps
Script `ReadOnly` rank carried over: that was the "we do not know what this row
is" bucket produced by a migration fallback, and it has nothing to hold here,
because every staff row is created by a command that requires an explicit rank.

**The rank once called `Regional` is now `Lead`, and this is not cosmetic.** That
rank had nothing to do with regions — region is, and always was, a separate
setting on every row. A MoPSE "regional admin" is usually `Support` rank with a
region set, which is to say a regional admin did not hold the rank called
Regional, and the rank called Regional did not imply a region. One word meant two
unrelated things, in a system where confusing the two is how the old bot ended up
making everybody a full administrator.

> **The teacher-facing phrase "Regional admin" is MoPSE's job title for a person
> and is left exactly as it is**, in the bot's own words to teachers and in the
> runbook. It was never the rank name, and disentangling the two is the entire
> point of the rename. Do not "correct" it.

**One consequence of the observer rank, which is where it will go wrong if it
goes wrong.** `case.view` is not the same question as "should this person be told
when a case arrives". An observer paged about every new case is being paged about
work they cannot do. New-case notification therefore filters on `case.update`,
not on `case.view`.

### 6.2 Case visibility — queue AND region, as one SQL predicate

`visibleToStaff` (`src/staff/visibility.ts`) is the single visibility rule, and
it is **a SQL fragment applied to every staff-facing query**, never a filter over
rows already fetched. A System member sees everything; anyone else must match the
case's queue **and** cover the teacher's region.

Evaluating it in SQL is what deletes the entire apparatus the Apps Script version
needed: `caseRegionMap_`'s memoisation, whose own comment called it *"not an
optimisation — it is a correctness requirement for the execution limit"*, existed
only because there was no join. Filtering after fetching also meant a twenty-row
limit could not be pushed into the query — every case had to be read in order to
display twenty.

**Two properties are load-bearing and neither is obvious:**

- **An unknown region hides a case from nobody.** A teacher whose region is
  recorded nowhere would otherwise file cases no region-scoped staff member can
  see. In SQL that is an explicit `IS NULL` branch, with a test.
- **A staff member with no regions covers all of them.** An empty list means every
  region and never means none, so that adding the column could not narrow
  anybody's existing access.

The region a case is judged by is resolved live — a staff correction if one
exists, otherwise the recruitment spreadsheet read **through a join** rather than
from the copy taken when the teacher signed in. See §5.2.

Contact Support asks the teacher what their case is about, so cases file under
real categories and queue-scoped staff see real traffic. Ask for Priority skips
the picker and files generic, routing to `All`, which is the correct destination
for something nobody has classified yet.

> The seven FAQ-topic mappings the Apps Script version carried in
> `queueForCategory_` are **deleted as structurally impossible**, not dropped. A
> case's category is now one of six values because nothing else can create one; in
> Apps Script a case could be filed under an FAQ topic *label*, and here it cannot.

### 6.3 Bootstrapping — one hand-written row, deliberately

Every staff command requires `System` rank, so **the first System row cannot come
from inside the bot.** It is a documented `INSERT` run over the server connection
(`RUNBOOK.md` §2.5), in the same shape as the settings insert that document
already carries.

There is no bootstrap command and no bootstrap environment variable, because
every alternative is worse. An environment variable is a permanent back door
granting System access to whoever can edit a file — and moving permissions out of
a file anybody could edit is the whole point of §13's permission-boundary row. A
"first caller becomes System" rule is a race with the public internet. The Apps
Script answer was a hand edit of a spreadsheet tab; the equivalent here needs
server access rather than document access, and that is the improvement.

**Consequence:** `/staff_remove` refuses to deactivate the last active System
member and `/staff_role` refuses to demote them, because the recovery from either
is another trip to the database. Two named System members is a launch-checklist
item for the same reason.

### 6.4 Staff lifecycle

Renamed from `/admins`, `/add_admin`, `/set_role`, `/remove_admin`. The word
"admin" does not appear in the data model any more — the table is `staff`, the
rank is a staff role, the column is `staff.telegram_id` — and keeping the old
names would mean the documents and the interface saying different words for one
concept. The system has never launched and nobody has been trained on the old
names, so the rename costs nothing now and could not be made cheaply later.

- **`/staff`** — everybody, with rank, queue and regions. Deactivated members are
  listed separately rather than hidden: `/assign` tells people to check an id
  here, and an id absent because a row is deactivated looks exactly like one that
  was mistyped.
- **`/staff_add <chat id> <rank> <queue> [regions]`** — **adds only.** An existing
  target is refused and pointed at `/staff_role`. `/add_admin` used to upsert, and
  its defaulting fourth argument silently stripped the System flag from whatever
  row it landed on, including the caller's own.
  - **Rank and queue are required, never defaulted.** The schema defaults both so
    that adding those columns could not break existing rows; a command inheriting
    those defaults grants Support over every queue to somebody the caller may have
    meant to restrict, and nothing in what they typed would show it.
  - **Regions are validated against regions the system has actually seen**, and
    written back in the spelling the roster uses. A typo would give a staff member
    a region no teacher is in — a silently empty queue, which looks like a quiet
    week. Omitting regions means every region, and the confirmation says so.
- **`/staff_role <chat id> <rank>`** — changes a rank, and **reactivates** a
  deactivated member, which is the one obvious way back from `/staff_remove`. It
  refuses to demote the last active System member (§6.3). The target is notified.
- **`/staff_queue <chat id> <queue>`** — changes which kinds of case somebody
  works, and **does not reactivate**, for `/staff_region`'s reason below. The
  target is notified, because their `/cases` list changes underneath them.
  > **Added 1 August 2026 with Part 5H.3, and it closed the same shape of gap the
  > note below describes.** A queue was written by `/staff_add` and by nothing
  > else, so it could be set once and never changed — the third axis of the
  > visibility model with no writer, while the other two had one. It went
  > unnoticed while a queue only decided what somebody *saw*. Since automatic
  > assignment it decides what they are **given**, so a stale queue no longer
  > means reading a list you do not need; it means work routed to you and sitting
  > there under your name.
- **`/staff_region <chat id> <regions|clear>`** — changes which regions somebody
  covers, and **does not reactivate**, unlike `/staff_role` one line above. Moving
  where a person works is not a decision to bring them back, and restoring access
  as a side effect of an unrelated edit is how a removed person returns unnoticed.
  Region names are checked against the ones teachers are actually in. `clear`
  returns them to covering everywhere and is spelled out rather than implied by an
  empty argument.
  > **Added 31 July 2026 by the runbook↔code audit, and it closed a real gap.**
  > `regions` was written by `/staff_add` and by nothing else, so coverage could be
  > set once and never changed — while `RUNBOOK.md` §2.6 both told the operator to
  > set regions *after* launch and named this command as the way. The failure had
  > no symptom: an empty region list means **every** region, so nobody would have
  > seen an error, and every staff member would have kept seeing the whole country.
- **`/staff_remove <chat id>`** — deactivates; **never deletes**, because case
  notes and audit rows name these people. Refuses self-deactivation. **Reports the
  open cases the person still owns and leaves them assigned** — deactivated staff
  are never deleted, so those cases stay in their name and appear in nobody's
  `/mycases`, and silently unassigning them would destroy the only record of who
  was working them. The target is notified.

Every one of these writes an audit row in the same transaction as the change
(§13).

### 6.5 Command reference

> **Since 3 August 2026 almost none of these has to be typed.** Every case action
> and the adding of a staff member are buttons (§8.2), and a staff member working
> normally never types a case reference. **The commands below all still work,
> unchanged** — the buttons run them rather than replacing them, which is why
> every rule stated here still holds however the action was started.

**Recognition happens inside the message pipeline**, not in a separate command
handler, so every command inherits the update claim, the chat lock and the
interaction log. A handler registered outside it would mean a redelivered
`/close` closes a case twice, and two staff acting at once are not serialised at
all.

**Two rules govern the dispatcher, and both depart from the Apps Script
behaviour this section used to describe.**

A command word this build does not have **is not a command**: it falls through to
ordinary text handling, which is what lets a teacher describing a broken boiler
start a sentence with a slash.

**A sender with no active staff row is told nothing.** The denial is logged and
the message *still* falls through. `routeAdminCommand_` answered *"You are not
registered as an admin"* and consumed the message, which confirmed to any
stranger that the command exists — precisely what §13's privilege-probing control
is meant to make expensive — and cost a teacher part-way through describing a case
everything they had typed. A staff member whose *rank* is too low is a different
person and is answered plainly, naming the rank required: they already know the
command exists, and silence would send a Lead's `/maintenance` to the teacher
topic picker.

`/help` and `/privacy` are teacher-facing and are matched before the staff
dispatcher, so a teacher typing them gets an answer. Staff get the teacher help
with their own command list appended, generated from the capability table.

**Thirty-three staff commands**, counted as command words in the registry — the
table below groups the four `/staff*` ones onto one row. Twenty-five after the
staff stage, plus the eight that close the last of the deferred list:
`/announce`, `/announce_send`, `/announce_cancel`, `/announcements`, `/export`,
`/retention`, `/forget` and `/username`. `/announce` and `/export` had been
deferred since the rebuild began, with the permissions for both sitting in place
and no command behind them.

| Command | Syntax | Requires |
|---|---|---|
| `/whoami` | `/whoami` | Any active staff row — reports rank, queue, regions and the exact capability list |
| `/cases` | `/cases` · `/cases unassigned` · `/cases <status>` | `case.view` |
| `/mycases` | `/mycases` | `case.view` — open cases you own |
| `/urgent` | `/urgent` | `case.view` |
| `/case` | `/case <reference>` | `case.view` + visibility of that case |
| `/search` | `/search <text>` | `case.view` — matches reference or the teacher's words, including closed cases |
| `/reply` | `/reply <ref> <message>` | `case.update` + visibility → **Under review** |
| `/await` | `/await <ref> <what is needed>` | `case.update` + visibility → **Action required** |
| `/close` | `/close <ref> <message>` · `/close <ref> unresolved <reason>` | `case.update` + visibility → **Completed** / **Closed** |
| `/reopen` | `/reopen <ref>` | `case.update` + visibility → **Under review** |
| `/note` | `/note <ref> <text>` | `case.update` + visibility — internal, no teacher ever sees it |
| `/mark` | `/mark <ref> Normal\|Urgent\|Critical` | `case.mark` + visibility |
| `/due` | `/due <ref> <date>` · `/due <ref> clear` | `case.update` + visibility |
| `/snooze` | `/snooze <ref> <days>` · `/snooze <ref> clear` | `case.update` + visibility |
| `/assign` | `/assign <ref> <chat id>` | `case.assign` (**Program**, raised from Lead — §5.5) + visibility; the assignee must be active staff who can **also** see the case |
| `/region` | `/region <chat id> <region>` · `/region <chat id> clear` | `teacher.region`, and coverage of **both** regions in the move |
| `/regions` | `/regions` | `teacher.region` — teachers who reported a wrong region, in regions you hold |
| `/revoke` | `/revoke <chat id>` | `teacher.revoke` |
| `/restore` | `/restore <chat id>` | `teacher.revoke` — the same rank as `/revoke`, deliberately |
| `/urgent_pending` | `/urgent_pending` | `urgent.issue` — priority requests nobody has decided. Deliberately **not** scoped to your queue and regions: a supervisor filtered to their own region cannot see that another region has stopped answering. Every row shows the **case's status**, because a case can be closed while its request is still undecided (§8.4) |
| `/staff` `/staff_add` `/staff_role` `/staff_queue` `/staff_region` `/staff_remove` | §6.4 | `staff.manage` |
| `/maintenance` | `/maintenance on\|off` · `/maintenance` to ask | `maintenance` |
| `/retention` | `/retention` to read all three · `/retention case\|urgent\|message <days>` | `maintenance`, which floors at **System** — a period governs deletion with no undo. With no argument it prints the periods **and the notice's own retention paragraph**, rather than describing them in its own words |
| `/forget` | `/forget <chat id> FORGET` | `teacher.forget`, floored at **System**. The confirmation word is typed, not tapped |
| `/username` | `/username @handle` · `/username clear` | **No capability** — any active staff row, on their own row only. A handle published under somebody's name is theirs to publish |
| `/announce` | `/announce all\|region:<name> <message>` | `announce` (Program and above). **Sends nothing**; drafts and freezes the audience |
| `/announce_send` | `/announce_send <id>` | `announce`, **and only the person who drafted it** — confirming somebody else's draft is confirming words you did not write |
| `/announce_cancel` | `/announce_cancel <id>` | `announce`, **anybody who holds it**. Stopping is the recoverable direction; a bad broadcast going out while the only person who can halt it is asleep is the worse failure |
| `/announcements` | `/announcements` | `announce` |
| `/export` | `/export` | `export` (Program and above), scoped by the same visibility rule. **No teacher's words in the file** |

**The four words staff type, and what each writes.** Eight statuses exist; staff
type four verbs and the system writes the rest. Which four is in the table above.

> ### `Action required` means **the teacher** must act
>
> Not us. It is a **request to the teacher, never a note to ourselves**, and the
> definition belongs here because the phrase reads both ways to anyone meeting it
> cold — and the wrong reading routes work to the wrong person. A case sitting in
> `Action required` is waiting on the *teacher*, so chasing the staff member about
> it chases somebody who is correctly doing nothing.
>
> Whatever follows `/await` is written to the teacher's own case update, so it
> reaches them rather than sitting in a column only staff read. A case marked
> "you must act" with the instruction invisible is an instruction nobody follows.
>
> **A taxonomy of action types is agreed and not built** — send a document, attend
> an appointment, confirm an address. Until it exists `/await` carries free text
> and nothing pretends otherwise. Whoever builds it should find this decision
> rather than inventing a second one.

**Why `Closed` and `Completed` are different words.** `Completed` is "we fixed
it"; `Closed` is "we gave up" — a teacher who has left the country, stopped
replying, or withdrawn the request. The difference is the single most useful thing
a later reader can know and it disappears if both write the same status. The
reason for an unresolved close is **required, free text, and goes to a case note
rather than to the teacher**: it is written for whoever reads the case afterwards,
and staff being candid is what makes it worth having. The teacher is told their
case is closed and how to raise it again, which is neither silence nor a blunt
internal judgement.

The four nobody types: `New` at filing, `Received` when a notification actually
reaches a staff member, `Escalated` by a confirmed priority request, `Duplicate`
by the 24-hour duplicate rule.

**Behaviour worth knowing:**

- **Every authorization denial is logged** with the caller's shape, so working
  through the command list from a stranger's account leaves a trace (§13).
- **A staff command's arguments are never written to the interaction log.** Any
  message beginning with `/` is logged as its command word and first argument
  only. `/note VISA-2026-00001 <the internal note>` would otherwise be copied
  almost verbatim into a table with a different retention story from the one it
  belongs to. The rule is on the prefix rather than on a list of commands, so a
  command added later is covered the day it is written.
- **Every command that changes a case resolves it through the visibility rule
  first.** The underlying write functions take a bare reference and do not check
  who is asking, so this is what stops a Support member holding one queue from
  closing a case in another by typing its reference.
- `/cases` with no argument lists **open cases only**. `/cases unassigned` is the
  intake backlog. A status argument may contain spaces (`/cases Under review`) —
  the remainder is one phrase, not split, which is a filter the Apps Script
  version made silently unmatchable.
- Lists cap at **20 rows and always report the total**. Showing twenty and saying
  nothing further made a backlog of two hundred look exactly like a backlog of
  twenty, and which of those it is, is the only reason to look at a queue.
- `/urgent` shows escalated cases and, separately, cases nobody has touched for
  `OVERDUE_DAYS`. **When that setting is unset it says so** rather than showing an
  empty list — "nothing is overdue" and "nobody has said what overdue means" are
  the same empty list and opposite conclusions.
- `/assign` validates the assignee twice: active staff, **and** able to see the
  case. The second is the check a foreign key cannot make — a real staff member
  holding the wrong queue takes the case off the unassigned list and puts it
  somewhere nobody is looking, which is worse than leaving it unassigned.
- `/case` shows the teacher's chat id, because that is the argument `/revoke` and
  `/region` take, and where their region came from, because the fix for a wrong
  region differs depending on the answer.
- `/reply` to a teacher who can no longer use the bot **warns the sender and sends
  it anyway**. Telegram will deliver it; the teacher simply cannot open the bot to
  read the case or answer. Refusing would leave a staff member believing they had
  answered somebody.
- `/note` is an insert and never touches the case row. A note is not progress: if
  it moved the case's timestamp, a case being discussed internally would look
  freshly worked to the overdue query, which is exactly the case most worth
  surfacing.
- `/mark` is allowed on a finished case, unlike `/due` and `/snooze`. Importance
  is a judgement somebody makes after reading, and the reader who realises
  afterwards that a resolved case was an emergency is the person the column exists
  for — retention reads the marker and never the status.
- `/due` **refuses a slashed date rather than guessing.** `15/08` and `08/15` are
  both in ordinary use and mean different days, and a date read the wrong way
  round is not visibly wrong; it is a promise to a teacher on the wrong day. It
  lands on the end of the day, in Tashkent.
- Every case write is a **single statement**. The chat lock is the *sender's*, so
  two staff acting on one case hold two different locks and any read-modify-write
  would race.

### 6.6 The urgent gate — ✅ rebuilt, then replaced

> **Withdrawn on 1 August 2026: the one-time code, in its entirety.** This
> section previously described a six-character credential a teacher had to be
> read over the telephone before the bot would let them describe an urgent
> problem — issued by `/generate_urgent_code`, stored in `urgent_codes`, checked
> without being spent, consumed in the same transaction as the case insert, and
> guarded by a five-guess-per-hour cap in `urgent_code_attempts`.
>
> Every one of those mechanisms was correct and none of them is here any more.
> The reason is not that the machinery failed; it is that it rationed **speech**.
> A teacher could not report a problem at all until an admin answered the phone.
>
> The two tables remain in the database as history and nothing reads or writes
> them.

**"Urgent" means high priority, not emergency.** The bot is not a crisis line and
does not present itself as one. This is the correction the whole redesign rests
on, and it is why no message in this flow names emergency services.

The flow spans a teacher and a regional coordinator:

1. The teacher taps **⏫ Ask for Priority**, passes the verification and consent
   gates, and is asked for the problem **immediately** — nothing stands between
   the button and the writing
2. The chat enters `AwaitingUrgentDetail` for **24 hours**. It carries no
   credential; the state is a place, not a token
3. The case is filed at **`New`/`Normal`**, with `urgent_requested_at` stamped
4. The coordinators for the teacher's **roster region** are told, by name and
   roster identifier, with one button
5. They check however they normally would. Nothing is automated and nothing
   chases them
6. On **⏫ Confirm urgent**: importance → `Urgent`, status → `Escalated`,
   `urgent_confirmed_by`/`_at` stamped, an audit row written **in the same
   transaction**, and the teacher, the owner and Program upward all told

**A pending request is `Normal`, and that is the property the whole feature turns
on.** Retention keys off `importance` and keeps urgent cases for 180 days against
seven. A request that stamped the marker on the way in would let anybody grant
themselves six months of retention by tapping a button, and the symptom would be
invisible for six months. `importance` is raised in exactly one place —
`confirmUrgentRequest` — and `createCase` lost the `escalate` flag that used to
be able to open a case above `Normal`.

**Confirmation is one statement that can succeed exactly once.** The guard is
`WHERE urgent_requested_at IS NOT NULL AND urgent_confirmed_at IS NULL`, which is
the same shape of single-statement guarantee the code consumption used to rely
on, and for the same reason: a staff command runs under the *sender's* chat lock,
so two coordinators tapping one button hold two different locks. The second tap
is a no-op that names who decided.

**Every tap re-validates.** A Telegram message sits in a chat for ever, so the
payload is a promise about the world made when the message was built. The tapper
is re-checked for an active staff row, for `urgent.issue`, and the case is
resolved through `findCase` so the visibility scope applies — somebody demoted or
moved to another region since cannot act on a button they still hold.

**Nobody covering the region falls through to System**, and the message says so,
because a System member deciding something *because nobody covers that region* is
a staffing gap rather than a routing quirk. Nobody at all raises a critical alert.

**If the case deduplicates** (§7.3) the words are appended to the existing case
and the request is stamped on **it**. This is the common path, not an edge case:
priority requests have no topic picker, so they file under the same general
category as every ordinary Contact Support case. The append deliberately does
**not** escalate — an appending write that raised importance would grant the very
thing it was asking a coordinator to decide.

**A case that is already urgent asks nobody again.** The teacher's words are
still kept; no second message goes out. Neither does a second request on a case
whose first is still pending, and the original `urgent_requested_at` is not
re-stamped — the gap between the two stamps is the only measure this system has
of how long a teacher waited.

**There is no decline button and no auto-escalation.** Auto-escalation would push
every frivolous request up to Program anyway, which defeats the gate; visibility
was chosen instead, and `/urgent_pending` is what makes it visible.

**The prompt gives up after three tries.** A teacher who sends a photograph
instead of text is asked again twice, and on the third is told to start from the
menu and given the support contact. Before 2 August 2026 there was no limit, and
somebody sending photographs was held at that prompt until the conversation
expired half an hour later.

**A request whose case has since been closed stays on `/urgent_pending`, marked
with the case's status.** Closing a case does not answer the teacher who asked
for priority on it, and dropping the row would mean the one list whose job is to
make an unanswered request visible had quietly stopped mentioning it. Confirming
one reopens the case — and the coordinator is told, in the confirmation, that
their tap did so. Before 2 August 2026 confirming a closed case reopened it while
leaving its end date in place, and the nightly retention pass then deleted it.

---

## 7. Case lifecycle

### 7.1 Statuses

| Status | Open? | Written by | Meaning |
|---|---|---|---|
| `New` | ✅ | the system, at filing | Nobody has it yet |
| `Received` | ✅ | the system, when notification reaches a staff member | Filed **and** seen — distinguishable from filed and seen by nobody |
| `Under review` | ✅ | `/reply`, `/reopen` | Somebody has it and is working it |
| `Action required` | ✅ | `/await` | **The teacher** must do something before it can move — §6.5 |
| `Escalated` | ✅ | a confirmed priority request | A case somebody has decided comes first, while it is open |
| `Completed` | ❌ | `/close <ref> <message>` | Resolved |
| `Closed` | ❌ | `/close <ref> unresolved <reason>` | Shut without being resolved |
| `Duplicate` | ❌ | the 24-hour duplicate rule | Merged into an existing case |

**Staff type four words; the system writes the other four.** Eight statuses
offered to a staff member mid-conversation would be a vocabulary nobody asked
for; four verbs that each write one status is the same information with nothing
to learn.

The enum is deliberately not trimmed to four. `Duplicate` is what the duplicate
window writes, and `Escalated` is how an emergency stays visible while it is open
— which is a different job from remembering that a *resolved* case was once an
emergency. That memory is `importance` (§7.1.4), because a status moves and a
marker does not.

**Terminal statuses (`Completed`, `Closed`, `Duplicate`) stamp the closing date**,
and that column is what retention measures from (§7.1.3). A case leaving a
terminal status has it cleared again — a case that has not ended must not carry
an end date, or reopening one would leave it scheduled for deletion.

### 7.1.1 New-case notification

**Built, and it had never existed.** Until this stage a case was filed and
*nothing anywhere was told* — not a staff member, not the operations chat, not
the log.

Every created case now notifies the staff who can actually act on it: active
rows matching the case's queue and covering the teacher's region, resolved by the
same rule every case query uses. The message carries the reference, the category,
the time and ready-to-tap `/case` and `/assign` lines, but **never the case
detail** — staff read that with `/case`, which leaves a record of who read it, and
a teacher's free text is not copied into a dozen Telegram histories.

**Recipients are filtered on `case.update`, not on `case.view`.** An observer who
can read every case is not somebody who should be paged about work they cannot do
(§6.1).

**Zero authorised recipients raises a critical alert naming the category**, rather
than writing a line to a log nobody opens, which is what the Apps Script version
did. A case nobody can see is the exact failure this feature exists to prevent.

A case that actually reaches somebody moves to `Received`, which gives that status
a writer for the first time and makes "filed but seen by nobody" a queryable
condition instead of an assumption.

**Escalating an existing case notifies too.** That is the common path rather than
an edge case: urgent cases have no topic picker, so they file under the same
general category as every ordinary Contact Support case, and a teacher who opened
one yesterday will always deduplicate against it.

### 7.1.2 Overdue push — the daily digest

**Not built. The queries are.**

Two different ideas of "late" exist, they carry one name each, and merging them
would make one list that answers neither question:

| | Means | Reads |
|---|---|---|
| Stale | Open, and nobody has touched it for `OVERDUE_DAYS` | the case's last-touched time |
| Past due | Somebody promised a date and missed it | the promised date, and any snooze |

A case can be either, both or neither. `/urgent` asks the first by hand today;
`/due` and `/snooze` write the second. What is missing is only the schedule, so
the next stage adds a trigger rather than a trigger and a query.

**Chasing must chase the right person.** A case sitting in `Action required` is
waiting on the *teacher*, so a digest that nags the staff member about it nags
somebody who is correctly doing nothing — and a digest people learn to ignore
costs the cases that genuinely are their fault.

### 7.1.3 Retention — cases are **deleted**, not archived

**Decided 2026-07-29.** The word "archive" appears elsewhere in this document
describing the Apps Script design, where old rows were moved to extra spreadsheet
tabs to keep the live sheet small. There are no archive tabs and no archive job.
Rows are **removed**.

| What | Kept | Setting |
|---|---|---|
| A case that is **not resolved** | **Indefinitely** | — |
| A resolved case, importance `Normal` | **7 days** after it closed | `CASE_RETENTION_DAYS` |
| A resolved case, importance `Urgent` or `Critical` | **180 days** after it closed | `URGENT_CASE_RETENTION_DAYS` |
| The interaction log | **3 days** | `MESSAGE_RETENTION_DAYS` |
| The audit trail | **Never pruned** | — |

**The job reads `importance` and never `status`.** A case marked `Critical` that
gets resolved becomes `Completed`, and nothing about `Completed` remembers it was
ever an emergency — a job reading status would delete exactly the cases most worth
keeping, at the shortest interval, and nobody would notice for six months.

**They are settings, not constants**, so MoPSE can change a period without a
deployment. **Unset means delete nothing**, in every case: a job that invents a
retention period deletes real records against a number nobody chose, and there is
no undo. `RUNBOOK.md` §4.11 is the operator's version, including the rule that
*lengthening* a period requires teachers to re-accept the privacy notice while
shortening one does not.

**Built, and it ships as one release** — the nightly job, the three settings, the
notice generated from them, the bumped wording version and the re-consent gate. No
part of it goes out alone: a job with no notice deletes data against a promise to
keep it, and a notice with no job promises deletion that nothing performs.

**The rule covers twelve tables, and no further setting was invented for any of
them.** Each is tied to a period already chosen or to a stated reason for keeping
it, because three periods are three sentences in a notice and twelve would be a
document.

| Table | Rule | Why |
|---|---|---|
| `cases` | 7 days after `closed_at`, or 180 if `importance` is not `Normal` | Above |
| `case_notes` | Cascades from the case | Staff writing about teachers must not outlive it |
| `messages` | `MESSAGE_RETENTION_DAYS` | The interaction log |
| `conversation_states` | The same period, measured after `expires_at` | Holds **a teacher's typed question** on the abandoned path. An expired state is already treated as absent, so deleting one changes no behaviour |
| `urgent_code_attempts` | The same period | A chat id per wrong guess of a one-time code. **The route was withdrawn on 1 August 2026**, so nothing writes here any more and the pruning runs against a table that can only shrink |
| `processed_updates` | 24 hours | Far longer than Telegram retries for |
| `sync_runs.rejections` | The jsonb is emptied after the same period; **the row stays** | Held **teacher email addresses**, every ten minutes, for ever. `rows_rejected` is a separate count, so the operational history survives the scrub |
| `announcement_recipients` | 30 days after the announcement finished | After a month, per-person delivery state answers no question anybody asks |
| `announcements` | **Never pruned** | The record of what the Ministry told teachers. Staff-written, no teacher's words |
| `urgent_codes` | **Never pruned** | Audit-class: who authorised an escalation, and for whom. **The route was withdrawn on 1 August 2026** and nothing writes here any more; the rows are kept because they are the record of who issued what to whom |
| `audit_log` | **Never pruned** | Who granted what |
| `job_runs`, `case_sequences` | **Never pruned** | Bounded. `case_sequences` in particular *must* survive a deletion, or a reference could be reissued and two cases would share one number |

**Three consequences, stated so they are inherited rather than rediscovered.** A
week after a case is closed its reference stops resolving, so a teacher
telephoning about one gets "no such case" and there is nothing to reopen. Notes
on a case are removed with it. And a three-day interaction log ends the monthly
content review that ran thirty-day queries over it — deleted from the runbook
rather than left to return empty results that read like good news.

### 7.1.4 Importance — a permanent marker, separate from status

`Normal` / `Urgent` / `Critical`, set by `/mark`, and a confirmed priority request sets
`Urgent` at creation.

**It cannot be a status, and the reason is retention.** A status moves: an
escalated case that gets resolved becomes `Completed`, and its history of having
been an emergency disappears with it. A marker is set once and stays, which is
what makes "six months for the urgent ones" possible at all.

`Critical` exists alongside `Urgent` because they come from different places.
Urgent is what a teacher's one-time code buys and is set by the flow; critical is
a judgement a person makes after reading the case. Collapsing them would mean
either every code-holder's case is critical or no staff member can mark one.

### 7.2 Reference generation

`PREFIX-YYYY-NNNNN`. Prefix by category: `VISA`, `TRAVEL`, `CONTRACT`, `ACCOM`,
`SUPPORT`, `DOCS`, else `CASE`.

The counter lives in the **`case_sequences`** table, one row per prefix and year,
and a reference is taken in a single statement:

```sql
INSERT INTO case_sequences (prefix, year, last_value) VALUES (…, …, 1)
ON CONFLICT (prefix, year) DO UPDATE SET last_value = case_sequences.last_value + 1
RETURNING year, last_value
```

Twenty teachers tapping confirm at once get twenty distinct numbers: the
conflicting inserts queue on the row lock and each returns its own incremented
value. `maxExistingSequence_` scanned every case ever filed, under a global lock,
so the cost of filing a case grew with the number of cases — and the correctness
rested entirely on that lock being held.

**Gaps are acceptable; reuse is not.** A rolled-back case has still consumed its
number, and a reference nobody holds costs nothing. A reissued reference is a
teacher quoting a number that now belongs to somebody else's case, so the counter
is never tidied downwards.

**The year comes from PostgreSQL in Tashkent**, not from the Node clock. A case
filed at 00:30 on 1 January belongs to the new year; a UTC clock would file it
under the old one, and that error would sit undetected for twelve months before
producing a duplicate-looking run of numbers.

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

One row per chat in **`conversation_states`**, so a teacher can only ever be in
one place, and the state survives a restart. The payload is parsed rather than
cast on every read: a row written by a newer build, or by an older one whose
payload differed, is an ordinary consequence of forward-only migrations and must
never throw.

| State | Set by | Next text message is treated as | TTL |
|---|---|---|---|
| *(none)* | default | A question → topic picker (`QT:`), question remembered | — |
| `AwaitingQuestionTopic` | Typing a question with no topic | A newer question, replacing the remembered one | 30 min |
| `AwaitingIdentifier` | Gated feature, unverified | A roster identifier (max 5 attempts) | 30 min |
| `AwaitingCaseTopic` | Contact Support | *(buttons, not text — the prompt is repeated)* | 30 min |
| `AwaitingCaseDetail` | A filing topic chosen | The case description — carries `category` | 30 min |
| `AwaitingUrgentDetail` | Ask for Priority | The problem, and why it cannot wait its turn. Carries nothing — the `AwaitingUrgentCode` state above it, and the accepted code this one used to hold, went on 1 August 2026 | **24 h** |

**Expiry is enforced when the state is read, never by a sweeper.** The read
filters on the stored deadline, so an expired state is indistinguishable from no
state at all. Without that, Stage 3 would be quietly incorrect until the Stage 5
clean-up job shipped: an abandoned case from two days ago would capture the
teacher's next FAQ question as its description. The clean-up job is a disk-space
job, not a correctness one.

**The urgent-detail state gets 24 hours** because a teacher who takes longer no
longer loses anything — the code is not spent until the case is filed (§6.6).

**With no state, typed text is still never matched against the FAQ directly.**
The question is logged, remembered in `AwaitingQuestionTopic`, and answered in
whichever topic the teacher then taps. See §9.0 — the one-topic constraint
stands.

**Every state carries its own redaction.** The interaction log reads the state
*before* any handler mutates it, so an address typed at the identifier prompt is
masked whether or not sign-in has since completed. Reading it afterwards is how
the original leak came back.

### 8.1.1 Non-standard inbound messages

| Input | Behaviour |
|---|---|
| **Edited message** | Acknowledged, never acted on. The teacher is told *"I only read new messages"* and asked to resend. Silence here previously meant a re-edited case description filed a second time |
| **Photo / file / voice / sticker / location / contact** | Refused with a message naming that specific type, pointing at Submit Documents. The bot never accepts uploads in chat |
| **Photo or file with a caption** | The caption is treated as the message text and routed normally; the attachment is still refused. Subject to §9.0 — a caption question is only *answered* if the chat is inside a topic |
| **`/start <payload>`** (deep link) | Treated as `/start`. No payload carries meaning yet |
| **`/foo`** (unknown command) | Falls through to ordinary text handling, not a staff rejection |
| **Message from a group** | **Ignored, and the bot leaves — except the operations chat, which it stays in and still ignores.** Built in this stage; this row described the control while nothing implemented it. The gate runs before the update is claimed or any lock is taken, because a group's chat id is negative and would fail the digits check on conversation state inside a transaction that rolls back silently |
| **Being added to a group** | It leaves immediately, saying nothing. Caught on the addition itself rather than on the first message, so it is never sitting in a group it should not be in. Nothing is said because a bot that answers has confirmed it is listening |
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
Support · Change Language · Ask for Priority · **Who covers my region?**

The last of those is deliberately **not** behind the sign-in gate or the
re-consent gate — §5.3.

#### The menu has three forms — Part 5F, 1 August 2026

The list above is what a **signed-in** teacher sees. There are two others, and
the difference is not cosmetic.

| Who | What they get |
|---|---|
| Verified, roster row live | The full menu above |
| No teacher row, or never verified | 4 shortcuts · All FAQ topics · Who covers my region? · **🔐 Sign in**, and a line saying what signing in unlocks |
| Revoked, or verified with the roster row gone | The same reduced menu, **without** the Sign in button and without that line |

**Why the third row exists.** `bindTeacher` clears `revoked_at`, so any route
into sign-in is a route by which a revoked teacher undoes a staff member's
decision by typing an email address. The Sign in button is a *fourth* door — after
`/start`, `requireSignIn` and `verifyIdentifier` — and it is refused by being
routed through `requireSignIn` itself rather than by a fourth copy of the rule.
See §5.1.

**Hiding a button is never the gate.** All four gated actions are still refused
on tap, because a keyboard sits in a teacher's scrollback for ever and a button
drawn last year is as live as one drawn this morning. The hiding is on top of the
gate, not instead of it.

**`/start` no longer asks for an address.** It used to hand an unknown chat the
privacy notice and a sign-in prompt, and hold them in `AwaitingIdentifier` — which
made the answer bank, deliberately open to everybody, unreachable through the
front door. The notice is still shown at the moment of sign-in, and replying with
an address is still the acknowledgement; it moved off the *first screen*, not off
the *acceptance*.

**FAQ hub:** all 11 topics + Main Menu.

Both are generated from `FAQ_TOPICS`. Adding a topic there makes it appear in the
hub, become valid in `isKnownCategory_`, and route correctly — no other edit.

### Staff management by button — Part 5H.3, 1 August 2026

`/staff` lists everybody as text **and** puts a button under each person. The
journey is three taps:

```
/staff  →  [ Nodira K. — Lead · Visa ]      choose a person
        →  [ 🎖 Change rank ] [ 📁 Change queue ]
           [ 📍 Change regions ] [ 🚫 Remove from staff ]
        →  [ Observer ] [ Support ] [ ✅ Lead ] [ Program ] [ System ]
```

A tick marks what they hold now. **Regions toggle rather than choose**, because
they are a list — a tap adds one they do not hold and removes one they do, and
removing the last means every region.

**Nothing in the menu decides anything.** An acting tap is turned back into the
typed command it is equivalent to and run through the ordinary dispatcher, so
every refusal, notice and audit row comes from the one place that has ever had
them: the last active System member keeps their rank, nobody removes themselves,
and the person whose access changed is told. **A tap that changes a rank is not
merely as authorised as `/staff_role`; it is `/staff_role`.**

**The subject travels in the button, not in the bot's memory.** ~~There is no
staff-facing conversation state in this system and this part deliberately did not
add one~~ — a menu left for an hour would otherwise act on whoever was chosen an
hour ago. Every tap is a complete instruction, re-authorised and re-read from the
database when it arrives.

> **Corrected 3 August 2026.** There *is* a staff-facing conversation state now,
> and it holds two things: which case somebody is writing about, and a chat id
> being typed to add a staff member. See §8.2.1.
>
> **The rule this sentence was making still stands, and it is why the state holds
> so little.** Nothing that a button can carry is ever remembered — every subject,
> rank, queue, region and importance level still travels in the payload. Memory is
> used only for the one thing a button cannot carry, which is a sentence somebody
> is about to type.

**Deactivate and reactivate share one slot**, showing opposite words, because
they are one question. `/staff` still lists deactivated rows so they can be
reached.

### Adding a staff member — Part 5I, 3 August 2026

`/staff_add` was the one staff command still typed in full. The list now carries
`[ ➕ Add somebody ]` under it:

```
[ ➕ Add somebody ]  →  "Send me their Telegram chat id."
                    →  you type   995500
                    →  [ Observer ] [ Support ] [ Lead ] [ Program ] [ System ]
                    →  [ Visa ] [ Travel ] [ Contract ] [ Accommodation ] [ All ] [ None ]
```

**The chat id is typed because it is the one thing only the person adding knows.**
Everything after it is chosen, and each choice carries every choice before it in
the payload.

**Queue is asked, never guessed.** It decides which teachers' problems that person
can read, and `/staff_add` has always refused to default it: doing so "would give
somebody more than you asked for, and nothing in what you typed would show it".
The refusal stands and answering it is now a tap.

**Regions are not asked.** The new member covers every region, which is exactly
what a typed `/staff_add 991001 Support Visa` does today with no regions given —
so this grants nothing a typed command did not. `📍 Change regions` is on their
row immediately afterwards.

The last tap runs `/staff_add`, so the answer to a chat id that already has a row,
and the notice telling the new member they have access, both come from the one
place that has ever had them.

### The case menu — Part 5I, 3 August 2026

Opening a case now shows what can be done to it. Every action a staff member has
is a button, and **no case reference is ever typed again**:

```
VISA-2026-00311
Under review · Visa · importance Normal
… the case in full …

[ 💬 Reply to teacher ]          [ 📥 Ask them for something ]
[ ✅ Close it ]                  [ 📝 Add a note ]
[ 👤 Give it an owner ]          [ ❗ How serious is it ]
[ 📅 Promised by ]               [ 😴 Snooze ]
[ ⬅️ Back to my cases ]
```

**The keyboard is built from the rank of whoever is looking at it**, using `can()`
— the same function that does the refusing. `case.assign` floors at Program while
`case.update` floors at Support, so two people opening the same case see different
buttons. A button shown and then refused is worse than no button.

**The case's own state is the second filter.** `Reopen` is drawn only on a finished
case and `Close` only on an open one, because they are the two answers to one
question. `Add a note` and `How serious is it` are drawn on both: a note is a
record rather than progress, and importance is the judgement most often made after
a case is over — retention reads the marker and never the status.

Four actions act on the tap or on one more tap: **Reopen**, **Give it an owner**
(showing the staff who cover that queue and region), **How serious is it**
(Normal / Urgent / Critical), and **Snooze** (7 / 14 / 30 days, or stop snoozing).

Five need the staff member's words, and prompt for them: **Reply**, **Ask them for
something**, **Add a note**, **Promised by**, and **Close**, which asks first
whether the case was resolved.

After any action the case comes back with its keyboard, so the next thing is
another tap rather than another `/cases`.

**Every typed command still works, unchanged.** Nothing was removed, and `/help`
and `/whoami` still list them all.

### 8.2.1 Waiting for words — the staff conversation state

The first staff-facing conversation state in this system. It exists because a
button cannot carry a sentence.

Tapping `💬 Reply to teacher` stores one row saying *this chat is writing a reply
to VISA-2026-00311*, and the staff member's next message becomes the reply. The
row lives in `conversation_states` beside the teacher states, expires after
`CONVERSATION_TTL_MINUTES` like everything else there, and needed no migration
because `conversation_states.state` is free text on purpose.

**While the bot is waiting, the next message is the words — even if it starts with
a slash.** `/close the window in her flat is broken` reaches the teacher as
written. Matched as a command it would be refused for having no reference and the
sentence would be lost, so the check runs ahead of the command dispatcher, which
nothing else in the router does.

The cost is that no command works while the bot is waiting. There are three ways
out: the Cancel button on the prompt, typing `/cancel`, and the expiry. The state
is cleared **before** the command runs, so a command that fails cannot leave a
chat still waiting.

A teacher can never enter this state, so the teacher state machine is untouched.

### 8.3 Callback protocol

Every prefix in this table changed in the rebuild — the ones below are the ones
the code actually emits, and the suite asserts the worst realistic payload
against the byte ceiling with real values rather than trusting an estimate.

| Prefix | Meaning |
|---|---|
| `MENU:MAIN` / `MENU:FAQ` | Main menu / topic hub |
| `MENU:<ACTION>` | `CHECK_CASE`, `CONTACT_SUPPORT`, `URGENT_CASE`, `SUBMIT_DOCS`, `MY_MANAGER` |
| `SM:<chat id>[:<action>[:<value>]]` | Staff management by button (§8.2). Three depths in one prefix: a person, an action, a value. Re-authorised on every tap, and an acting tap runs the equivalent typed command rather than a copy of it |
| `SA[:<chat id>[:<rank>[:<queue>]]]` | Adding a staff member (§8.2). The chat id is typed once; every choice after it carries the choices before it |
| `CO:<reference>` | Open one case from a list |
| `CA:<reference>[:<action>[:<value>]]` | One action on one case (§8.2). Same three depths as `SM`, and the same rule: an acting tap runs the equivalent typed command. `CA::MINE` carries no reference and means "back to my cases" |
| `MENU:SIGN_IN` | Start sign-in — routed through the same `requireSignIn` that guards the gated actions, so a revoked chat is refused here too (§8.2) |
| `CAT:<CODE>` | Enter an FAQ topic (`VISA`, `LIVING`, …) |
| `PG:<CODE>:<page>` | Paged topic browsing |
| `ANS:<CODE>` | Send one approved answer |
| `OK:<CODE>` / `BAD:<CODE>` | ✅/❌ answer feedback — logged as `ANSWER_HELPFUL` / `ANSWER_UNHELPFUL`; ❌ offers Contact Support |
| `CASE:<key>` | Filing topic chosen (`VISA`/`TRAVEL`/`CONTRACT`/`ACCOMMODATION`/`OTHER`) — re-checks maintenance and verification before prompting for detail |
| `QT:<CODE>` | Topic chosen for a remembered typed question — answers it there without retyping |
| `DOC:<key>` | Reserved for Stage 6; nothing emits it yet |

**Topic codes travel, never display labels.** The Apps Script version embedded
the human-readable label, which tied the payload's size to translated text — in
Cyrillic, at two bytes a character, the promised Russian and Uzbek menus would
have silently grown every button past the limit. Translating the interface is now
a display change with no effect on routing.

`callback_data` is capped at **64 bytes** by Telegram, measured in one place.
Building an over-long payload throws rather than truncating — silent truncation
routes a tap somewhere else — except when listing answers, where a single
over-long content code hides one button and raises an alarm instead of taking
down the whole listing.

Unknown and malformed callbacks fall back to the main menu rather than doing
nothing. Both are ordinary: the payload arrives from the network, so it can be
hand-crafted, and a teacher's scrollback keeps every button they were ever sent.

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

### 9.2 There is no FAQ cache — ✅ rebuilt

The chunked six-hour cache is gone, along with the edit watcher that existed to
invalidate it. Answers are read from `faq_entries` on every query.

What replaces the six-hour delay is a **ten-minute sync**: an edit in the
spreadsheet reaches teachers at the next sync, not immediately. That is slower
than the old edit-watcher path and faster than its cache expiry, and it is the
single most likely thing for staff to report as a bug on day one — it is called
out in the runbook for that reason.

Rows are ordered explicitly, by the sheet row the content owner arranged, with
the code breaking ties. Both were implicit in the spreadsheet and both broke in
the move: SQL without an `ORDER BY` returns rows arbitrarily, so paging through a
topic could repeat and skip answers between taps.

Withdrawn answers are filtered on every read, not just at listing time. The sync
deactivates rather than deletes, and a teacher's scrollback keeps yesterday's
buttons forever — so tapping one must not deliver an answer that content owners
have since withdrawn.

### 9.3 Keyboard safety

Before rendering, every row is checked: blank `BUTTON_TEXT` or `callback_data`
over 64 **bytes** would make Telegram reject the *entire* message with HTTP 400,
not just that button. Offending rows are skipped and logged with their `CODE`.

Category browsing is paginated at 8 per page. Search pickers show the top 8
matches without paging — those are ranked results, so paging is not meaningful.

---

## 10. Document submission — ✅ **rebuilt in Stage 6**

**Documents stay in Google Forms. The bot never accepts, holds or stores a file.**

That reverses a planned direction and is recorded here because two documents said
the opposite: an earlier `RUNBOOK.md` called Telegram upload *"the only genuinely
new feature in the rebuild"*, while this section described the Apps Script Forms
flow as current. Both were corrected in Stage 5, and Stage 6 built what they
describe.

**What exists, in the order the data moves:**

1. Form links live in the **`FORMS` tab**, synced exactly as the roster and the
   FAQ are — a half-ready row is rejected with its row number and cannot reach a
   teacher. Columns: `TYPE`, `BUTTON_TEXT`, `URL`, `RESPONSES_TAB`, `ACTIVE`,
   `CATEGORY`, `PREPARE`, `EMAIL_COLUMN`. The last three are optional and are what
   make a form an *area* — see §10.1.
2. A teacher taps **Submit Documents**, passes the sign-in and re-consent gates,
   picks a document type and is given that form's link.
3. Every form writes its responses into a tab of the same spreadsheet. The bot
   reads each one and matches submissions to teachers **by the recruitment email
   the form collects**, checked against the roster.
4. A match either **joins the complaint the teacher already opened in that area**,
   or — when there is none — files a `Submit Documents` case under that teacher.
   Either way a note names the form. The documents themselves stay in Google.

**A form is only read while its row is on the sheet.** Removing the row stops the
bot reading that form's responses immediately, which is what ends the critical
alert a retired form used to raise every ten minutes for ever. The cost is stated
rather than hidden and was chosen knowingly: a submission arriving between the
last sweep and the moment the row goes is never filed and nobody is told.
`RUNBOOK.md` §4.18 carries the habit that mitigates it — leave the row for a day
— and a habit is a process rather than a guarantee.

**Two rows in the `FORMS` tab are worth understanding as a pair.** `URL` is what
a teacher is sent to; `RESPONSES_TAB` is where their answers land. A row with a
`URL` and no `RESPONSES_TAB` **still shows its button** — teachers can submit and
the bot simply does not read the answers back. That split is deliberate: it lets
a form be published before its plumbing is finished rather than after.

**Three things are refused rather than guessed at**, each reported with its row
or its tab, because each would otherwise fail far from its cause:

- A `TYPE` holding a colon, or long enough to overflow Telegram's 64-byte button
  payload. It would throw while the list was being rendered, taking the whole
  list away from every teacher.
- A `URL` that is not `https`, or is not a web address at all. Telegram refuses a
  message containing a malformed button URL, and the forms list is **one message
  carrying every button** — so one bad cell would take the list from everybody,
  not just its own row. The host is deliberately not restricted to Google.
- A responses tab with no email column, **or more than one that nothing has
  chosen between**. With `EMAIL_COLUMN` empty the rule is that exactly one column
  heading may contain the word "email"; with it set, that heading is the answer
  and is matched exactly after trimming, with nothing inferred. Guessing between a
  teacher's address and their supervisor's would file somebody's documents under
  the wrong person, which is a silent, plausible, wrong answer.

  **All four of MoPSE's real forms have several email columns and none of them
  could be read before `EMAIL_COLUMN` existed.** Google's "Collect email
  addresses" setting adds a column, each form also asks for the address as a
  question, and two of them ask for a school contact email and an emergency
  contact email besides — all reasonable questions that all contain the word. The
  refusal to guess was never the fault; the absence of anywhere to put the answer
  was.

**Reading a submission twice must file one case, and this is the only event-shaped
sync in the system.** The FAQ and the roster are records: upsert on a key,
deactivate what vanished, run twice and nothing changes. A response is an event.
`form_submissions` holds one row per response the bot has looked at — keyed on
`(form_type, sheet_row)`, written **in the same transaction as the case** — and
that marker is the only thing between this design and a duplicate case every ten
minutes.

> ⚠️ **The row number is the identity, so a responses tab must not have rows
> deleted or reordered.** Deleting one shifts every row below it up by one and
> the bot re-files all of them. It is the only stable identifier Google gives us;
> a content hash would survive deletion but collide legitimately, because two
> teachers submitting the same form on the same day with the same answers is
> ordinary.

**Retention anonymises that marker; it never deletes it** (D44). When a case is
purged the marker survives with its `case_reference` nulled, and the nightly job
clears the email. What remains is *"row 42 of the passport form has been dealt
with"*, which identifies nobody. Deleting the marker instead would make the
response row look new on the very next sync — for ever.

**A submission that cannot be filed is reported, never invented.** Three
outcomes, and the middle one is its own message:

| Outcome | What it means | What happens |
|---|---|---|
| `Filed` | The address matches a roster row **and** a signed-in teacher | A case, plus a note naming the form |
| `RosterNoChat` | On the roster, but has never opened the bot | **No case is possible** — `cases.teacher_chat_id` is a non-null foreign key. Staff are told the name and address so a person can chase them |
| `Unmatched` | On no active roster row at all | Staff are told the address and which form |

`RosterNoChat` deliberately does **not** say "we do not know this email". We know
exactly who they are, which is precisely why somebody can act on it.

**Matching on the roster identifier is stronger than the mechanism it replaces**,
and this is the substantive change rather than a detail. Google Forms has no
hidden fields, so the Apps Script version pre-filled the teacher's chat id into a
**visible, editable** question and could therefore never trust it as identity —
which is why it needed an `UNRESOLVED:` sentinel for submissions it could not
place. An email checked against the roster is the same identity check as signing
in.

> **The sentinel is not coming back, and it cannot be.** The case table requires a
> real teacher behind every case, so an unidentifiable submitter cannot be stored
> at all — and under the matching above, nothing will produce one either. Commands
> written now must not carry a branch for a state that is both forbidden and
> unreachable.

### 10.1 Form areas — a complaint and its paperwork, together — 3 August 2026

**A form area is a button with a name of its own that files under a case category
the bot already has.** It is deliberately not a new category: a new category needs
its own queue, its own reference prefix and its own retention rule, and a button
needs none of those.

Three optional cells on the form's own row describe one, so MoPSE can change any
of them without a deployment:

| Column | What it does |
|---|---|
| `CATEGORY` | The existing case category a complaint here files under. Empty means `Contact Support` |
| `PREPARE` | What the teacher should gather, shown above the link. **Filling this in is what makes the form an area** |
| `EMAIL_COLUMN` | The exact heading of the teacher's own email column in the responses tab |

`CATEGORY` names a category and never a queue, because `QUEUE_FOR_CATEGORY`
already turns one into the other and a second answer to "who works this" would
drift from the first. **A row naming a category this build does not have is
rejected with its row number** and the other rows still sync — the same rule a
misspelled FAQ topic already meets.

**With `PREPARE` set, tapping the button produces one message** — the area's name,
what to gather, the link, the email warning, and a request to say what is needed.
What the teacher types next opens a case in that area, through `createCase`, so
the 24-hour de-duplication, the access re-check and the new-case alert all apply
unchanged. **The area is re-read when the message arrives, never trusted from the
conversation state**: a form withdrawn while the teacher was typing must not still
file under it, and they are told rather than left with silence.

A form with no `PREPARE` behaves exactly as it always did, which is what keeps
plain document forms unchanged.

**Two columns on `cases` carry it.** `form_type` is the area, and is deliberately
**not** a foreign key to `form_links` — an area MoPSE retires must not take its
existing cases with it. `awaiting_form` is true from the moment the teacher writes
until their submission turns up.

**Staff are told immediately, and the notice says whether the paperwork has
arrived.** That was chosen over waiting to see whether a form followed, because a
complaint invisible to staff while the teacher believes it is being handled is the
worse failure. The line names the button text, falling back to the raw `form_type`
when the area has left the sheet.

**A submission is matched to the area, not merely to the teacher.** A teacher with
an open Accommodation complaint and an open Reimbursement complaint must not have
their reimbursement package attached to the accommodation case. Where an open case
exists in the same area, the submission joins it — a note recording its sheet row,
`awaiting_form` cleared, and the marker written in the same transaction, so the
idempotency that governs the create path governs the attach path identically.

> **Holiday Leave and Medical Leave are buttons over `Contact Support` and are
> therefore indistinguishable from any other Contact Support case by category
> alone.** They carry the area tag, so they are findable, but `/cases` filters on
> status rather than on area. "Show me every medical leave case" would need a real
> category, which is the work this deliberately did not do.

---

## 11. Triggers and scheduled jobs

### 11.0 The rebuild's schedule — and the crontab is UTC

Four scheduled jobs, run by `graphile-worker` in the worker process. Nothing
scheduled runs inside the webhook.

| Entry | Job | What |
|---|---|---|
| `*/10 * * * *` | sync | Copy the answer bank, the roster and the form links out of the spreadsheet, then read each form's responses and file what arrived |
| `*/5 * * * *` | heartbeat | Alarm on any job that has stopped |
| `0 21 * * *` | retention | The nightly deletion pass — **02:00 Tashkent** |
| `0 2 * * *` | digest | The morning lists, the teacher chase, the handle re-check — **07:00 Tashkent** |
| `* * * * *` | announcements | Send the next batch of any confirmed announcement |

> ⚠️ **Absolute times are written in UTC, whatever the container says, and this is
> the one thing here that fails silently.** `graphile-worker` matches its crontab
> with `getUTCHours()`. `docker-compose.yml` sets `TZ: Asia/Tashkent` on both
> services, which changes `Date#getHours()`, the log timestamps and every
> `AT TIME ZONE` reader — **and does not change cron matching at all**, so the
> timezone setting makes this look handled when it is not. A digest written the
> obvious way as `0 7 * * *` arrives at noon, five hours into the working day,
> looking like nothing at all. Use `tashkentCron()`; the arithmetic is asserted in
> a test rather than described in a comment.
>
> Uzbekistan is UTC+5 all year with no daylight saving, so a fixed offset is safe
> here in a way it would not be in most places. **Do not copy this pattern
> somewhere it breaks twice a year.**

**Only scheduled work records a run.** Nothing triggered by a person does, and the
reason is the heartbeat: it alarms on any job whose last success is older than 1.5
times its expected interval, so an on-demand job would raise a critical alarm
**every hour in which nobody used it** — which is most hours. The alarm that
exists to make silence audible would have become the noisiest thing in the
channel, and the fix people reach for is to stop reading it.

**That is why an announcement is swept rather than enqueued.** Confirming one
marks a row, and a scheduled sweeper picks it up. One path, watched by the
heartbeat, and resumable after a restart by construction rather than through a
second recovery mechanism.

**Each sweep takes one batch of 200 and returns.** The worker is `concurrency: 1`,
so a run that paced itself through 1,800 sends would hold the only slot for
minutes — during which the ten-minute sync and the five-minute heartbeat do not
run, and the first symptom would be a *false* alarm that the sheet sync had
stopped, raised late by the heartbeat that was itself starved.

### 11.1 The Apps Script triggers — historical

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

**The lock table that stood here is obsolete.** It listed eleven paths, four of
them deliberately unlocked, because the only tool available was one global mutex
and taking it was expensive. None of that survives.

**One lock, taken in one place.** Every update runs inside
`pg_advisory_xact_lock(hashtext(chat_id))`, acquired at the top of the pipeline
and released when the transaction ends, however it ends. A handler that throws or
a process that is killed cannot strand it.

```
claim the update → take the chat's lock → read the state once
                 → log the interaction → dispatch → COMMIT → speak
```

**Per chat, not global.** Two teachers can never block each other. Apps Script's
own notes named the global script lock as the throughput ceiling of the whole
bot; that ceiling is gone rather than raised.

**Exactly one lock, on purpose.** Case dedup and conversation state are two
tables that both need serialising for the same chat. Locking them separately
would mean two locks acquired in different orders on different paths, which is
the classic deadlock recipe. Nothing below the pipeline takes a lock of its own —
`createCase`, `verifyIdentifier` and `fileUrgentCase` are all read-then-write and
all documented as requiring the caller's transaction.

**Correctness that used to rest on holding a lock now rests on the statement.**
Three cases where a single statement replaced a critical section entirely:

| Guarantee | How |
|---|---|
| An update is processed once | `INSERT … ON CONFLICT DO NOTHING RETURNING` |
| A reference is never reissued | `INSERT … ON CONFLICT DO UPDATE … RETURNING` |
| A code is spent once | `UPDATE … WHERE used_at IS NULL AND expires_at > now()` |

**Commit before you speak.** The transaction commits and *then* Telegram is
called. A send that fails after a good commit is recoverable — the case exists,
Check My Case will show it — and it raises an alarm, because the teacher believes
nothing happened. A commit that fails after a confirmation message has gone out
is not recoverable by anything: the teacher is holding a reference for a case
that does not exist.

For the same reason nothing announces from inside the transaction. The
duplicate-identity alarm is returned to the router and sent afterwards, rather
than announcing a binding that can still roll back.

**Logging never rolls anything back.** The interaction log is best-effort and
swallows its own errors: a failure to write a log row must not undo a case a
teacher has just filed. Apps Script took the global lock to append a log row and
gave up after three seconds, discarding entries exactly when the system was
busiest — which is when you most want to read them back.

---

## 13. Security model

| Control | Implementation |
|---|---|
| Webhook authenticity | Shared secret in the **`X-Telegram-Bot-Api-Secret-Token` header**, compared on every request; mismatches are rejected with no explanation. It is no longer in the URL, where it leaked into every proxy log, access log and `getWebhookInfo` output in the path |
| Update replay | `update_id` claimed in `processed_updates` with one statement, before the chat lock, and kept for 24 hours — Telegram gives up retrying long before that |
| Identity | Roster match required before any case action, checked in the program as well as by the foreign key: the key proves a `teachers` row exists, not that its state is `Verified` |
| Brute force — sign-in | 5 attempts, counted in the conversation state so they expire with it. Deliberately self-healing: no Stage 3 command exists to release a teacher, so a durable counter would strand one |
| Brute force — urgent codes | **No longer applicable.** The credential this defended was withdrawn on 1 August 2026, so there is nothing left to guess. Priority is now rationed by a coordinator's decision after the fact, which cannot be brute-forced because asking for it is free and being granted it is not automatic |
| Group exposure | Non-private chats rejected; the bot actively leaves groups it is added to. **Built in this stage** — this row described the control for two versions of this document while nothing implemented it, the same class of loss as `update_id` deduplication before it. `OPS_ALERT_CHAT_ID` is exempt from leaving, by chat id, read from one function shared with the ignore path so the two cannot disagree; an unset value exempts nothing |
| Injection | No `parse_mode` is ever sent, so teacher text cannot break message formatting |
| Callback forgery | `CAT:`, `PG:` and `QT:` codes resolved through a fixed map, never used as a lookup key on an object; `CASE:` keys likewise; `ANS:` codes resolve to a real active row or a clean "no longer available" reply; unknown and malformed callbacks fall back to the main menu |
| Secret storage | Environment only, validated at start-up — the web process refuses to run with a placeholder support contact rather than serving teachers a number nobody answers. No secrets in source; `.env` is `chmod 600` and gitignored |
| Database exposure | PostgreSQL is published on loopback only and is not reachable from outside the host; administration is over an SSH tunnel |
| Transport | TLS terminated by Caddy with an automatically renewed certificate; port 80 carries only the ACME challenge and the redirect |
| Data minimisation | Identifiers stored once; failed attempts logged redacted |
| Internal data | `DETAIL` never surfaced to teachers; `getCasesForChatId` strips it structurally; excluded from `/export` and from new-case notifications |
| Privilege probing | **Every** authorization denial — queue, region, capability, or rank — is logged with the command and the caller's permission shape. A sender with no staff row is told **nothing at all** and the message falls through, so the deny path is not an oracle for which commands exist |
| Privileged actions | Staff lifecycle changes, maintenance changes, teacher revocation and restoration, case assignment and urgent-code issuance each write an audit row **in the same transaction as the action**. That write propagates its errors on purpose: a grant that cannot be recorded does not happen. The audit trail is never pruned. **There is deliberately no command to read it** — it is read by somebody with database access during an investigation, and a command would need its own permission model to avoid becoming the thing it audits |
| Audit honesty | A command that changed nothing writes nothing. `/restore` on a teacher who was never revoked, `/maintenance on` when it is already on, and `/revoke` on somebody already revoked all say so and leave no row — an audit trail with entries for events that did not happen is worse than a short one |
| Staff free text | Any message beginning with `/` is logged as its command word and first argument only, so internal case notes and replies are not copied into the interaction log (§5.2) |
| Impersonation visibility | A second chat verifying an already-held identifier alerts the operations chat, every System member and the prior holder — detected, not blocked |
| Self-service privilege escalation | None. A revoked teacher cannot sign in again to undo it (§5.1); the first System member is a hand-written database row (§6.3); and no command grants a rank above the caller's own reach, because managing staff at all requires the highest rank |
| Permission-boundary bypass | The `staff` table is the access boundary, and it is inside the database rather than in a shared spreadsheet — so granting yourself staff access now requires server access, not edit access to a document. The spreadsheet is read-only to the bot and holds only the roster and the answer bank; nothing about permissions is reachable from it |
| Bulk exfiltration | Deferred with the commands themselves (§16). When they arrive, `export` and `announce` are already permissions rather than a new model |

**Not protected against:** staff with database access seeing everything (by
design — they are staff); Telegram itself; identity impersonation via a known
roster email (made visible by the duplicate-binding alert, prevented only by
per-person one-time codes — an open product decision that gets cheaper to change
now than at any later point).

**One thing the rebuild made worse, and it is still open:**

- **Data is collected before the notice is shown.** FAQ browsing is open to
  anyone and every inbound message writes a log row. Apps Script had the identical
  flaw. The difference is that the recorded acceptance now makes it *auditable*:
  messages whose chat has never accepted the notice are a directly queryable list.

> **The erasure item that used to sit here was based on a misreading of our own
> schema, and is removed.** It said the case foreign key blocks deleting a case.
> It does not: the constraint refuses the deletion of a **teacher** who still has
> cases, and deleting the case itself was never obstructed — notes attached to it
> go with it. Retention therefore deletes cases outright (§7.1.3). Anonymisation
> is what a teacher's *own* removal request needs, which is a smaller and
> different job, and it ships with the retention work.

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

**✅ Everything this list held under "next stage" is now built** — `/announce` and
`/export`, the daily digest and the teacher chase, the retention job with its
three settings and the generated notice, the gate that asks every teacher to
accept it again, and `/forget`. §6.5 has the commands, §7.1.3 the retention rules
and §11.0 the schedule.

**Later:**

- **Document submission** through Google Forms, matched on the recruitment email
  (§10). The bot will never accept a file.
- **A taxonomy of action types**, so a case can say *what kind* of thing the
  teacher must do. Until then `/await` carries free text (§6.5).
- **Multilingual content.** Language columns exist; only English is populated.
- **Global free-text FAQ search.** Matching is scoped to one topic by design
  (§9.0); the topic picker softens the dead end without changing the trade.
  Cross-topic search would need a false-positive policy that has not been agreed.
- **Per-person one-time verification codes.** Email identifiers stay guessable
  by colleagues; duplicate bindings are detected (§5) but not prevented. **This
  decision gets more expensive at launch**, not more wrong.

  **Narrowed, not closed, by Feature A on 2 August 2026.** A duplicate binding now
  reaches a person who decides, so an impersonation of a teacher who is *already
  signed in* is visible, actionable and reversible. What is untouched is the
  land-grab: an attacker who binds a leaked roster address **before the real
  teacher ever signs in** wins silently, and there is nobody yet on that account
  for the dispute to be with. One-time enrolment tokens are still the only thing
  that closes it, and it is still a decision for MoPSE.

**Deliberately never:**

- **A command to read the audit trail** (§13). It is read during an investigation
  by somebody with database access, and a command would need its own permission
  model to avoid becoming the thing it audits.
- **A button to decline a priority request.** Not tapping is the decline. A
  request nobody grants stays in `/urgent_pending`, which is where somebody
  notices it — a decline button would let a request be closed with no record of
  who judged it and no way for a teacher to be told anything at all.
- **Dedicated queues for the seven newer FAQ topics.** Not deferred — impossible.
  A case's category is one of six values because nothing else can produce one.

*(Built since the last version of this document and no longer deferred: the whole
staff command set, the ordered-rank capability table, staff lifecycle commands,
new-case notification, case notes, importance, promised dates and snoozes, region
correction and the teacher's region prompt, teacher revocation and restoration,
`/maintenance`, urgent-code issuance, the group gate, alarms fanning out to
System staff, and — in Stage 6 — **document submission through Google Forms**,
which is §10 and is the last feature the rebuild was carrying.)*

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
