# MoPSE Teacher Support Bot — Deployment and Operations Runbook

**Version:** 1.3 · **Date:** 2026-07-27 — reflects the executed UPGRADE-PLAN v1.1
(Phases 0–6.1), plus the full Apps Script setup, settings and update procedures

**Part 1** is for the head of project — no technical knowledge assumed.
**Parts 2–6** are for whoever deploys and operates the bot.

---

# PART 1 — For the head of project

## 1.1 What this is

A Telegram bot that answers teachers' questions from your approved answer bank,
opens support cases for teachers whose identity is confirmed against the
official roster, and hands out the correct document-submission form links.

It runs on Google's infrastructure (Apps Script + Google Sheets). There is no
server to buy, no hosting bill, and no software to install. **All data lives in
one Google Spreadsheet that your team owns and can read at any time.**

## 1.2 What has to happen before it can go live

Deployment itself is about **two hours** of IT work. The blockers are not
technical — they are decisions and content only MoPSE can supply:

| # | Needed | Who provides it | Blocking? |
|---|---|---|---|
| 1 | A Telegram bot account | IT (2 minutes, free) | ✅ Yes |
| 2 | A Google account to own the spreadsheet | IT / MoPSE | ✅ Yes |
| 3 | **A real support contact** — email or phone | **Head of project** | ✅ **Yes** |
| 4 | **The teacher roster** — email, name, region per teacher | **Recruitment team** | ✅ **Yes** |
| 5 | At least one named System Administrator | **Head of project** | ✅ Yes |
| 6 | Approved FAQ content | ✅ Already prepared (112 answers) | No |
| 7 | 7 Google Forms for document submission | **MoPSE** | ⚠️ Partly |
| 8 | A data-retention period in days | **Head of project** | No |

**Items 3, 4 and 5 are hard blockers.** Without a support contact, every teacher
whose verification fails is shown placeholder text. Without a roster, *nobody*
can verify — meaning nobody can open a case. Without a System Administrator, no
staff member can use any admin command.

**Item 7 is not a blocker.** Until a real Google Form exists, the Submit
Documents button (and its `/help` line) **hides itself automatically** — no
teacher can reach a dead link, and no manual step is needed to launch without
it. Filling in one real form URL brings the button back for that doc type. See
§6.3.

## 1.3 What teachers will be able to do on day one

- Browse **112 approved answers** across 11 topics — visa, salary, workload,
  leave, accommodation, placement, health, contract, conduct, living in
  Uzbekistan, travel
- **Open a topic, then type a question in their own words** and get the approved
  answer back. Matching happens *inside* a topic — the bot searches one topic at
  a time so a visa question can never be answered from the accommodation bank.
  A question typed at the main menu is remembered and answered after one tap on
  a topic picker, so nobody dead-ends
- Rate every answer ✅/❌ — a ❌ offers Contact Support and feeds the monthly
  content review (§4.11)
- Open a support case **under a chosen topic** (Visa / Travel / Contract /
  Accommodation / other) and receive a reference number; the right team is
  notified within seconds
- Check the status of their cases
- Read the privacy notice at verification and any time via `/privacy`
- Escalate an urgent case using a one-time code issued by an admin

Teachers who are not on the roster can still browse and search the FAQ. They
cannot open cases.

## 1.4 What your staff will be able to do

Nineteen commands, typed into the same bot: list open cases (including the
unassigned backlog and their own worklist), read one case, reply to a teacher,
close/reopen/assign, add internal notes, search, export to CSV (with a recorded
reason), broadcast an announcement (draft + confirm), issue urgent codes,
manage other admins (add, list, deactivate, restore), and pause submissions for
maintenance. New cases and overdue cases are **pushed** to the right admins —
nobody has to poll.

The full list with syntax is in **§4.9** below, and in §6.5 of `BOT-SPEC.md`.

Permissions are an ordered **role** (`ReadOnly` < `Agent` < `Manager` <
`SystemAdmin`) deciding what class of action is allowed, a **queue** deciding
which case topics are visible, and an optional **region list** narrowing that to
particular regions — see §6 of `BOT-SPEC.md`. Agents work cases and issue urgent
codes; Managers additionally assign, broadcast and export; System Admins manage
staff. Appointing a single System Administrator works, but naming roles
deliberately is better practice — see §4.5.

## 1.5 Honest risk summary

| Risk | Severity | Mitigation |
|---|---|---|
| Roster not ready at launch | **High** | Nobody can open a case. Purely a content dependency |
| Forms not ready at launch | **Low** | The Submit Documents button hides itself until a real form URL exists — no manual step |
| Volume exceeds Apps Script limits | **Medium** | Fine for hundreds of teachers. The ceiling and what to do about it are in `CONCERNS-AND-IT-ACTIONS.md` §B1–B3 |
| Answer bank content becomes stale | **Medium** | Any staff member with sheet access can correct an answer; it goes live immediately |
| Someone edits the sheet badly | **Medium** | Header names are contracts. See "Needs attention from IT" |
| Teachers expect to type a question anywhere | **Low** | Matching is scoped to a topic (§1.3), but a typed question now gets a one-tap topic picker instead of a dead end |

---

# PART 2 — Deployment (IT)

Follow in order. Each step depends on the previous one.

## Step 1 — Create the Telegram bot

1. In Telegram, message **@BotFather**
2. `/newbot` → choose a display name and a username ending in `bot`
3. **Copy the token.** It looks like `8123456789:AAH...`. Treat it as a password
4. `/setprivacy` → select the bot → **Enable** (the bot then only sees commands and direct messages)
5. `/setjoingroups` → select the bot → **Disable** (this bot is private-chat only)
6. Optional: `/setdescription`, `/setuserpic`

## Step 2 — Create the spreadsheet

1. Create a new Google Spreadsheet on the account that will own this system
2. From the URL, copy the ID — the long string between `/d/` and `/edit`
3. Do **not** create any tabs by hand. Step 5 does that.

## Step 3 — Create the Apps Script project

1. In the spreadsheet: **Extensions → Apps Script**
2. Delete the default `Code.gs`
3. Create one file per `.gs` in this repository and paste the contents. **Names
   must match exactly** — Apps Script executes top-level code in filename
   alphabetical order and several files depend on it:

```
AdminCommands.gs   ArchiveManager.gs   CaseManager.gs   Config.gs
FormRouter.gs      Logger.gs           MenuHandler.gs   QAEngine.gs
SetWebhook.gs      SetupSheets.gs      TelegramAPI.gs   Triggers.gs
UserSession.gs     Webhook.gs
```

4. Save.

### Step 3a — Doing that in the editor

Opening the script from **Extensions → Apps Script** creates a *container-bound*
project: it belongs to this spreadsheet, and deleting the spreadsheet deletes the
script with it. That is the intended setup — `getSpreadsheet()` still opens the
sheet by `SPREADSHEET_ID` (Step 4) rather than relying on the binding, so the two
are independent in code.

**To add each file:** click **＋** beside **Files** in the left sidebar →
**Script** → type the name. **Type the bare name — the editor appends `.gs`
itself**, so enter `AdminCommands`, not `AdminCommands.gs`.

Six things worth knowing before you start:

- **The web editor has no bulk upload.** This is fourteen manual create-and-paste
  operations. Budget ten minutes and do them in one sitting.
- **Creation order does not matter.** The alphabetical rule in Step 3 is about
  how Apps Script *executes* top-level code at runtime, not the order you add
  files in. The editor sorts them for display anyway.
- **Save each file** (Ctrl/Cmd-S). The editor autosaves, but an unsaved file is
  not compiled, and a syntax error in one file breaks *every* file — all `.gs`
  files share a single global scope.
- **Delete the stock `Code.gs`.** Left in place it is harmless only by luck; any
  top-level `const` in it that collides with one of ours is a load-time error
  that takes the whole bot down.
- **Do not create `.html` files or a `Code.gs` of your own.** There are exactly
  fourteen files and no HTML in this project.
- **Editing here does not affect the live bot** until you deploy a new version
  (Step 6, and §4.12 for later changes). This surprises everyone once.

**Verify before moving on:** the sidebar lists exactly the fourteen names above,
nothing else, and no red error markers.

> **CLI alternative.** If you would rather push from this folder than paste,
> Google's `clasp` does that (`npm i -g @google/clasp`, `clasp login`,
> `clasp clone <scriptId>`, `clasp push`). This repository does **not** ship
> `.clasp.json` or `appsscript.json`, so `clasp clone` against the project you
> just created is the way in — it writes both. Everything below assumes the web
> editor; `clasp` changes only how files arrive, not any other step.

## Step 4 — Set the script properties

**Project Settings → Script Properties → Add script property.**

| Property | Value |
|---|---|
| `BOT_TOKEN` | The token from Step 1 |
| `SPREADSHEET_ID` | The ID from Step 2 |
| `WEBHOOK_SECRET` | A random string you generate. 32+ characters. Any generator is fine |

Leave `WEBAPP_URL` for Step 7.

> ⚠️ **If any of these three is missing the bot is 100% silent** — no error, no
> reply, nothing in the chat. `getProp_` throws, `doPost` catches it, and the
> update is dropped. If the bot appears dead, check here first.

### Step 4a — Project settings

Same screen, above the script properties: **⚙ Project Settings** in the left
sidebar. Three of these matter, and the first one matters far more than it looks.

**1. Time zone — set it deliberately.**

It defaults to the time zone of whoever created the project, which is very often
not Uzbekistan. Set it to the zone the support team actually works in
(**`(GMT+05:00) Tashkent`** for MoPSE). Nothing errors if you leave it wrong —
it is just quietly incorrect forever, in four places:

| What | Where | Symptom if the zone is wrong |
|---|---|---|
| Daily overdue digest | `runDailyDigest`, installed `.atHour(7)` | "07:00" means 07:00 *in the script's zone*. On a US-default project the morning worklist arrives in the middle of the night |
| New-case notification | The `Opened:` line admins receive | Wrong clock time on every alert |
| `/note` timestamps | Written into case `DETAIL` | **Permanent** — stamps are stored text, not rendered on read |
| Urgent follow-up stamps | Appended to `DETAIL` on escalation | **Permanent**, same reason |

The last two cannot be corrected retroactively without editing case history by
hand, which is the reason to get this right *before* launch rather than after.

> 🔁 **If you change the time zone after Step 8, re-run `installTriggers`** so the
> digest is rescheduled against the new zone.

**2. Runtime — confirm it says V8.**

New projects default to V8 and there is nothing to do; check anyway, because this
is a ten-second confirmation that rules out a whole class of confusing failure.
On the legacy Rhino runtime this project does not merely misbehave, it **fails to
parse** — every file uses `const`/`let`, arrow functions and `Object.values`. If
you ever inherit or copy a project showing Rhino, switch it to V8 before pasting
anything.

**3. "Show `appsscript.json` manifest file in editor" — tick it (optional).**

This surfaces the project manifest as a fourteenth-plus file in the editor. It is
where the time zone and the granted OAuth scopes actually live, so it is the
fastest way to review both at a glance, and the only way to keep them under
version control alongside the `.gs` files. Nothing in this runbook requires it.

**Leave the Google Cloud Platform project alone.** The auto-created default is
correct; nothing here needs a standard GCP project.

Per-trigger **failure notifications** are configured separately, on the Triggers
page — see Step 8.

## Step 5 — Create the sheets

In the Apps Script editor, select **`createAllSheets`** from the function
dropdown and click **Run**.

**This is the first Run, so it triggers authorisation.** What you will see:

1. **Review permissions** → pick the Google account to authorise with
2. **"Google hasn't verified this app"** — an interstitial with no obvious way
   forward. Click **Advanced**, then **Go to \<your project name\> (unsafe)**
3. **Allow** the requested scopes

> ⚠️ **The "unverified app" warning is expected and is not a fault.** It appears
> because this is your own unpublished script rather than a Marketplace add-on
> Google has reviewed. There is no way to remove it for a private project, and
> nothing is wrong. This screen stops more first-time deployments than any other
> step — people reasonably conclude they have done something wrong and stop.

**Authorise with the account that owns the spreadsheet**, and treat that choice
as permanent-ish: **everything then executes as that account** — the webhook, all
four triggers, and every sheet read and write. If that is a personal account
rather than a MoPSE organisational one, fix it now rather than later
(`CONCERNS-AND-IT-ACTIONS.md` A5).

The scopes requested are Sheets (read/write the spreadsheet), external requests
(`UrlFetchApp`, i.e. calling Telegram) and script triggers. A **Forms** scope is
requested later and separately, the first time you run `installFormSubmitTrigger`
(§6.3) — not now.

Confirm 8 tabs now exist: `FAQ` `CASES` `USERS` `MESSAGES` `ADMINS` `SETTINGS`
`ANNOUNCEMENTS` `ROSTER`. Safe to re-run.

> 🔁 **Upgrading an existing deployment?** Re-run `createAllSheets` — it appends
> the newer columns (`CASES.LAST_ACTOR`; `ADMINS.NAME/ACTIVE/ADDED_BY/ADDED_AT/`
> `REGIONS/ROLE`) without touching existing rows. One manual step: if a
> `CASES_ARCHIVE` tab already exists, type `LAST_ACTOR` into its cell **J1** —
> the archive copies headers only at creation time.

### Step 5a — Exact tab layout

This is what `createAllSheets` writes, column by column. **Header names and
their order are contracts**: code looks columns up by name, a renamed header
silently disables the feature that reads it, and every tab gets row 1 frozen.
Do not insert columns — new ones are always **appended**.

**`FAQ`** — the answer bank. Filled by the Step 12 CSV import; edited by content staff.

| Col | Header | Rules |
|---|---|---|
| A | `CODE` | Unique ID. Reaches Telegram as `FAQANS:<CODE>` etc., so **≤ 57 bytes** |
| B | `CATEGORY` | Must **exactly** equal one of the 11 `FAQ_TOPICS` labels (`Visa`, `Travel and Arrival`, `Contract Signing`, `Accommodation`, `Salary and Payment`, `Workload and Hours`, `Leave and Holidays`, `Placement and School`, `Health and Insurance`, `Conduct and Development`, `Living in Uzbekistan`) — a mismatch makes the row unreachable |
| C | `BUTTON_TEXT` | Inline-button label. **Must not be blank** |
| D | `KEYWORDS` | Comma-separated match terms |
| E | `OFFICIAL_ANSWER` | Sent verbatim to teachers |
| F | `LANGUAGE` | `EN` at launch |
| G | `ACTIVE` | Row loads only when this reads `TRUE` (case-insensitive) |
| H | `LAST_APPROVED_BY` | Audit only — never read by code |
| I | `LAST_APPROVED_DATE` | Audit only — starts the content-review clock |

**`CASES`** — written by the bot; hand-editing `STATUS`/`PUBLIC_UPDATE` messages the teacher (≤50 rows per edit).

| Col | Header | Rules |
|---|---|---|
| A | `REFERENCE` | `PREFIX-YYYY-NNNNN` (`VISA`/`TRAVEL`/`CONTRACT`/`ACCOM`/`SUPPORT`/`DOCS`/`CASE`). Immutable |
| B | `CATEGORY` | The topic the case was filed under |
| C | `CHAT_ID` | Telegram chat, or `UNRESOLVED:<id>` sentinel |
| D | `STATUS` | `New` · `Received` · `Under review` · `Action required` · `Escalated` · `Completed` · `Closed` · `Duplicate` |
| E | `OWNER` | Assigned admin's Telegram ID (set via `/assign`) |
| F | `CREATED_AT` | Timestamp |
| G | `UPDATED_AT` | Timestamp, stamped on every mutation |
| H | `DETAIL` | **Internal only** — never shown to teachers, excluded from `/export` |
| I | `PUBLIC_UPDATE` | Teacher-visible note (written by `/reply`, `/close <reason>`) |
| J | `LAST_ACTOR` | Telegram ID of the admin whose command last changed the row |

**`USERS`** — written by the bot at verification. To revoke a teacher: clear E or delete the row.

| Col | Header | Rules |
|---|---|---|
| A | `CHAT_ID` | Telegram chat ID |
| B | `LANGUAGE` | `EN` |
| C | `FIRST_SEEN` / D `LAST_SEEN` | Timestamps |
| E | `VERIFICATION_STATE` | `VERIFIED` or empty |
| F | `IDENTIFIER` | The roster identifier they verified with |
| G | `NAME` / H `REGION` | Copied from ROSTER — `REGION` drives region-scoped admin visibility and `/announce <region>` |

**`ROSTER`** — seeded by hand or CSV from recruitment records (Step 10). The only tab teachers are matched against.

| Col | Header | Rules |
|---|---|---|
| A | `IDENTIFIER` | What the teacher types — matching is case-insensitive, trimmed |
| B | `NAME` | Used in the verification greeting |
| C | `REGION` | Must use the same spellings as admin `REGIONS` lists and `/announce` audiences |

**`MESSAGES`** — the interaction log, bot-written. `TIMESTAMP` · `CHAT_ID` ·
`ACTION` · `DETAIL` (A–D). `CHAT_ID` is `SYSTEM` for bot-initiated events
(notifications, sheet-edit alerts). Sensitive bodies are redacted placeholders.

**`ADMINS`** — seed row 2 by hand (Step 9); afterwards use the commands (hand edits alert every System Admin).

| Col | Header | Rules |
|---|---|---|
| A | `TELEGRAM_ID` | All digits (ask @userinfobot) |
| B | `IS_SYSTEM_ADMIN` | `TRUE` / `YES` / `Y` / `1` / checkbox — anything else is no |
| C | `TIER` | `Program` · `Finance` · `Regional` · `None` (legacy; feeds the role fallback) |
| D | `QUEUE` | `Visa` · `Contract` · `Travel` · `Accommodation` · `Recruitment` · `Technical` · `All` · `None` |
| E | `NAME` | Human name — keep it filled |
| F | `ACTIVE` | Blank or anything except `FALSE` = active. `FALSE` = deactivated |
| G | `ADDED_BY` / H `ADDED_AT` | Provenance, written by `/add_admin` |
| I | `REGIONS` | Blank or `All` = all regions; else comma-separated list matching ROSTER spellings |
| J | `ROLE` | `ReadOnly` · `Agent` · `Manager` · `SystemAdmin`; blank = derived from B+C (`Program`→Manager, `Regional`/`Finance`→Agent, else ReadOnly; B truthy→SystemAdmin) |

**`SETTINGS`** — `KEY` · `VALUE` · `NOTES` (A–C). Recognised keys:
`RETENTION_DAYS`, `OVERDUE_DAYS`, `MAINTENANCE_MODE` (Step 13 / §4.8). Reads are
cached 60 s; unknown keys are ignored; a duplicate key's **first** row wins.

**`ANNOUNCEMENTS`** — bot-written send log. `ID` (`ANN-<timestamp>`) · `CONTENT`
· `AUDIENCE` · `STATUS` (`SENDING` → `SENT`/`PARTIAL`/`FAILED`) · `CREATED_BY` ·
`CREATED_AT` (A–F).

**`CASES_ARCHIVE` / `MESSAGES_ARCHIVE`** — do **not** create these by hand. The
archive job creates each on first use and copies the source tab's header row at
that moment (which is why an archive tab created before an appended column needs
its header extended by hand — the `CASES_ARCHIVE!J1` note above).

## Step 6 — Deploy as a Web App

1. **Deploy → New deployment → ⚙ → Web app**
2. Description: `v1`
3. **Execute as: Me**
4. **Who has access: Anyone** — required; Telegram's servers are anonymous
5. **Deploy**, authorise, and copy the **Web app URL** (ends in `/exec`)

> **Who has access: Anyone** does not mean the bot is unprotected. Every request
> must carry the shared secret; anything else is dropped without a reply.

## Step 7 — Register the webhook

1. Add the script property `WEBAPP_URL` = the `/exec` URL from Step 6
   — **without any query string.** `setWebhook()` appends the secret itself
2. Run **`setWebhook`**
3. Run **`getWebhookInfo`** and check the execution log:
   - `"url"` should be your `/exec` URL with `?secret=…`
   - `"pending_update_count"` should be `0`
   - `"last_error_message"` should be absent

> 🔁 **Re-run `setWebhook` after every deployment that changes the URL.** Using
> "Manage deployments → Edit → New version" keeps the same URL; creating a *new*
> deployment does not.

## Step 8 — Install the triggers

Run **`installTriggers`**.

This installs **four** triggers: `handleSheetEdit` (onEdit), `handleSheetChange`
(onChange), `runArchive` (every 14 days), and `runDailyDigest` (daily at 07:00 —
the overdue-case worklist). Verify under the ⏰ **Triggers** tab in the left
sidebar.

> ⚠️ **If you deployed an earlier build, re-run `installTriggers`** — it removes
> and re-adds its own handlers, and older installs are missing
> `handleSheetChange` and `runDailyDigest`.

**While you are on the Triggers page, turn on failure notifications.** For each
of the four rows: **⋮ → Configure notifications → Notify me immediately** (daily
is the default, and is fine if immediate mail would be noise). A trigger that
starts failing — an expired authorisation, a quota exhaustion, a renamed header —
otherwise fails **silently and indefinitely**; the archive job and the digest run
unattended, so nobody would notice. This is the cheapest available answer to
`CONCERNS-AND-IT-ACTIONS.md` A7, and it takes about a minute.

> Triggers belong to **the account that installed them**, not to the project. If
> the person who ran `installTriggers` loses access or leaves, the triggers stop.
> Whoever re-runs it becomes the new owner (A5 again).

## Step 9 — Create the first System Administrator

**This cannot be done through the bot.** `/add_admin` requires an existing System
Admin, so the first one is seeded by hand.

In the **ADMINS** tab, add a row:

| TELEGRAM_ID | IS_SYSTEM_ADMIN | TIER | QUEUE | NAME |
|---|---|---|---|---|
| `123456789` | `TRUE` | `Program` | `All` | `Their Name` |

`IS_SYSTEM_ADMIN` accepts `TRUE`, `YES`, `Y`, `1`, or a Sheets checkbox. The
remaining columns (`ACTIVE`, `ADDED_BY`, `ADDED_AT`, `REGIONS`, `ROLE`) can stay
blank — blank `ACTIVE` means active, blank `REGIONS` means all regions, blank
`ROLE` falls back to the tier.

To find a Telegram numeric ID, have the person message **@userinfobot**.

> ℹ️ Once the bot is live, every direct edit of this tab alerts all System
> Admins (🔐). That is by design — this first seed row predates the bot running,
> so it alerts nobody.

## Step 10 — Seed the roster

In the **ROSTER** tab, one row per teacher:

| IDENTIFIER | NAME | REGION |
|---|---|---|
| `jane.doe@example.com` | `Jane Doe` | `Tashkent` |

`IDENTIFIER` is what the teacher types to verify — the email or one-time code
from their offer paperwork. Matching is case-insensitive and trimmed.

**Until this tab has rows, no teacher can open a case.**

## Step 11 — Set the support contact

Open `Config.gs`, find `SUPPORT_CONTACT_INFO` (near the bottom), and replace the
placeholder with a real MoPSE support email or phone number. Save.

This string is shown to every teacher whose verification fails.

## Step 12 — Import the FAQ content

1. Open the **FAQ** tab
2. **File → Import → Upload → `FAQ-import.csv`**
3. Import location: **Replace current sheet**
4. Separator: **Comma**
5. **Untick "Convert text to numbers, dates and formulas"**
6. Import

> Use **Replace current sheet**, not "Append". `FAQ-import.csv` carries its own
> header row, so appending inserts a second header as a data row. It is harmless
> — the bot skips it because its `ACTIVE` cell does not read `TRUE` — but it
> throws the row count off and confuses anyone auditing the tab later. Replace
> gives you the header exactly once. The header names are identical to the ones
> `createAllSheets` wrote, so nothing is lost.

Confirm **112 rows** below the header. Spot-check that column A is `CODE` and
column G is `ACTIVE`, all reading `TRUE`.

Then **edit any cell once and undo** — that fires the FAQ cache invalidation so
content is live immediately instead of after up to 6 hours.

Optionally fill `LAST_APPROVED_BY` / `LAST_APPROVED_DATE` now. Nothing in the code
reads them, but they are the only record of when an answer was last signed off,
and the content-review clock (`CONCERNS-AND-IT-ACTIONS.md` A6) starts here.

## Step 13 — Configure settings

In the **SETTINGS** tab:

| KEY | VALUE | Effect |
|---|---|---|
| `RETENTION_DAYS` | e.g. `365` | Archiving does nothing until set. **Also a privacy commitment** — the `/privacy` notice implies data is not kept forever |
| `OVERDUE_DAYS` | e.g. `7` | Enables the overdue half of `/urgent` **and** the daily 07:00 overdue digest |

## Step 14 — Google Forms (deferrable)

Only needed to make **Submit Documents** functional. See §6.3.

---

# PART 3 — Smoke test

Run these in order from a normal (non-admin) Telegram account.

> ⚠️ **Steps 6–8 depend on step 5.** Typed questions are matched **only while the
> chat is inside a topic** — there is no global search. Any tap on Main Menu or
> All FAQ topics ends that state; typing afterwards gets a topic picker that
> remembers the question (`BOT-SPEC.md` §9.0). Do not skip step 5.

| # | Action | Expected |
|---|---|---|
| 1 | Visit the `/exec` URL in a browser | `MoPSE Telegram Bot webhook is running.` |
| 2 | `/start` | Welcome + main menu |
| 3 | Tap **Visa** | Question list (8 answers, so no paging controls) |
| 4 | Tap a question | The approved answer + ✅/❌ feedback buttons + Back/Home |
| 4b | Tap **❌ Not what I meant** | Apology + Contact Support offer; MESSAGES gains a `FAQ_NOT_HELPFUL` row naming the CODE |
| 5 | Tap **All FAQ topics**, then tap **💵 Salary and Payment** | All 11 topics, then the salary question list with **Next ➡️** (19 answers = 3 pages) |
| 6 | Tap **Next ➡️** | Page 2 of 3, with **⬅️ Previous** |
| 7 | Type `how much tax` | The **SAL-006** answer, *"How much tax is deducted?"* |
| 8 | Type `qwertyuiop` | A picker, **never** a wrong answer; MESSAGES gains a `FAQ_NO_MATCH` row |
| 9 | Tap **🏠 Main Menu**, then type `how much tax` | A **topic picker** ("Which topic is that about?"); tapping **💵 Salary and Payment** returns SAL-006 **without retyping** |
| 10 | Tap **Check My Case** | Verification prompt **including the privacy notice** |
| 10b | `/privacy` | The privacy notice + menu |
| 11 | Type a wrong identifier | "doesn't match… 4 attempt(s) left" |
| 12 | Type a **roster** identifier | "you are verified" → straight into Check My Case |
| 13 | Tap **Contact Support** | A topic picker ("What is your question about?") |
| 13b | Tap **🛂 Visa**, describe an issue | A reference like `VISA-2026-00001` — **and every All-queue/System Admin receives 🆕 New case within seconds** |
| 14 | Repeat 13–13b immediately with the same topic | Same reference, "not duplicated" |
| 15 | Send a photo | Refusal naming "photo", pointing at Submit Documents |
| 16 | Tap **Visa**, then send a photo **captioned** `visa fee` | "I can't accept the photo…" **then** the matching visa answer |
| 17 | Edit any earlier message | *"I only read new messages"* — the edit is not re-processed |
| 18 | `/help` | Teacher help only, no admin commands |

From the **System Admin** account:

| # | Action | Expected |
|---|---|---|
| 19 | `/whoami` | Your role, tier, queue, system-admin flag **and the exact "You can" capability list** |
| 20 | `/cases` | The case from step 13b (open cases only) |
| 21 | `/case VISA-2026-00001` | Full detail including `DETAIL` and `Last changed by` |
| 22 | `/note VISA-2026-00001 Checked with visa desk` | "Note added (internal only)" — teacher gets **nothing** |
| 23 | `/reply VISA-2026-00001 We are looking into this` | Teacher receives it; you get "Reply sent and case updated" |
| 24 | `/help` | Teacher help **plus** the admin list |
| 25 | `/maintenance on`, then tap **Contact Support** as the teacher | "Submissions are temporarily paused"; **Check My Case still works** |
| 26 | `/maintenance off` | "Maintenance mode is OFF" |
| 27 | `/generate_urgent_code` | A 6-character code (System Admin bypasses the Agent-role gate) |
| 28 | As the teacher: **Urgent Case** → that code → describe the issue | Urgent cases file generic (`SUPPORT-…`); if an open generic case exists it **deduplicates and escalates**; admins receive 🚨 |
| 29 | `/urgent` | The escalated case from step 28 |
| 30 | `/export` | The **usage message** — a reason is now required |
| 30b | `/export smoke test of the export path` | A CSV arrives — confirm **no `DETAIL` column**; any *other* System Admin receives the 📤 notice |
| 31 | `/close VISA-2026-00001 Resolved` | Teacher notified |
| 32 | `/announce ALL Test message` | A 📋 DRAFT preview — **nothing delivered** |
| 33 | `/announce cancel` | "Draft announcement discarded" |
| 34 | From a `TIER=Regional` admin: `/export a reason here` | Refusal, **and** MESSAGES gains `ADMIN_DENIED` `/export [system=N tier=Regional …]` |
| 35 | `/admins` | Every admin listed with flags, provenance and the active-System-Admin count |

Then check the **MESSAGES** tab. Every interaction should be logged — and confirm
that steps 11, 12, 13 and 28 recorded **placeholders**, not the teacher's email
address, case description or urgent code. Seeing a real email in `DETAIL` there
means the redaction in `Webhook.gs` is not deployed.

---

# PART 4 — Routine operations

## 4.1 Updating an answer

Edit the `OFFICIAL_ANSWER` cell. **It goes live immediately** — the edit clears
the cache. To retire an answer, set `ACTIVE` to anything other than `TRUE`.

## 4.2 Adding an answer

Append a row. Requirements:
- `CATEGORY` must **exactly** match one of the 11 topic labels
- `BUTTON_TEXT` must not be blank
- `CODE` must be unique and under ~55 characters
- `ACTIVE` must be `TRUE`

A row breaking the first three is skipped and logged rather than taking the menu
down.

## 4.3 Adding a teacher

Append to **ROSTER**. Takes effect immediately.

## 4.4 Revoking a teacher

Either clear `VERIFICATION_STATE` in their **USERS** row, or delete the row.
Both now work — deletion is caught by `handleSheetChange`.

## 4.5 Adding, changing and removing staff

`/add_admin <telegram_id> [tier] [queue] [true|false] [role] [name]` from a
System Admin. Tier and queue default to `None`. Include the person's **name** —
six months from now "who is 483920184?" should be answerable. Provenance (who
added them, when) is recorded automatically. Adding staff now also involves a
**region decision**: leave `REGIONS` blank for all regions, or set a
comma-separated list in the sheet to scope their case visibility.

**`/add_admin` adds only.** Run against an existing admin it refuses and points
at `/set_role` — it can no longer accidentally strip anyone's System Admin flag.

**To grant System Admin on a new row**, pass `true` as the fourth argument:

```
/add_admin 123456789 Program All true SystemAdmin Jane Doe
```

Only an existing System Admin can run the command at all, so this is delegation
rather than escalation — but it *is* a live path to full privileges, so treat
the fourth argument with the same care as the sheet itself. **Changing** System
Admin on an existing row is a deliberate sheet edit; no command does it.

`/set_role <telegram_id> <tier> <queue> [role]` changes tier, queue and
(optionally) the ordered role; it can never touch `IS_SYSTEM_ADMIN`. Run against
a deactivated admin it **restores** them. The target is notified of any change.

`/remove_admin <telegram_id>` **deactivates** (never deletes — history stays
readable). It refuses self-removal and refuses to remove the last active System
Admin. `/admins` lists everyone with flags and provenance.

> 🔐 **Hand edits of the ADMINS tab are noisy by design** — every direct edit
> alerts all System Admins. Use the commands; they suppress the alert for their
> own writes. `IS_SYSTEM_ADMIN` accepts `TRUE`/`YES`/`Y`/`1` or a checkbox.

## 4.6 Issuing an urgent code

1. An admin with **Agent role or above** (or any System Admin) runs `/generate_urgent_code`
2. Pass the 6-character code to the teacher **by phone or in person** — never
   through the bot, which would defeat the point
3. The teacher taps **🚨 Urgent Case** and types it

The code is **single-use and expires in 48 hours.** It is destroyed the moment it
is typed, valid or not, so it cannot be replayed. The teacher then has **6 hours**
to describe the issue; past that the code is gone and you must issue a new one.

If the teacher already has an open case on the same topic from the last 24 hours,
the urgent detail is added to that case and it is escalated, rather than a second
case being opened. The code is never consumed for nothing.

## 4.7 Announcements — two-step, on purpose

`/announce ALL <message>` or `/announce <region> <message>` prepares a **draft**:
you get a preview and the recipient count, and **nothing is sent**. Check the
wording, then `/announce confirm` to deliver, or `/announce cancel` to discard.
Drafts are per-admin and expire after one hour. Manager role or above.

Only verified teachers are targeted. The bot reports actual delivery counts and
names failed recipients.

On a large audience the send may run out of execution time and report *"not
attempted"* for the remainder — re-draft and confirm again to finish. Nothing is
sent twice: duplicate updates are ignored for 10 minutes.

## 4.8 Pausing submissions

`/maintenance on` — pauses **Contact Support, Urgent Case and Submit Documents**.
FAQ browsing **and Check My Case** stay live: pausing new submissions is not the
same as locking teachers out of their own case status. `/maintenance off` to
resume.

A `MAINTENANCE_MODE` value changed by hand in the SETTINGS sheet takes up to a
minute to take effect (settings are cached for 60 seconds). The command itself is
immediate.

## 4.9 Full command list

Nineteen commands. Syntax and permissions are in `BOT-SPEC.md` §6.5; this is the
summary. "Visibility" = the case's queue **and** the teacher's region must both
match your row.

| Command | Syntax | Requires |
|---|---|---|
| `/whoami` | `/whoami` | Any admin — reports your role and exact capability list |
| `/cases` | `/cases` · `/cases all` · `/cases unassigned` · `/cases <status>` | Any admin (visibility-filtered) |
| `/mycases` | `/mycases` | Any admin — open cases assigned to you |
| `/urgent` | `/urgent` | Any admin (visibility-filtered) |
| `/case` | `/case <reference>` | Visibility |
| `/reply` | `/reply <reference> <message>` | Agent+ and visibility |
| `/close` | `/close <reference> [reason]` | Agent+ and visibility |
| `/reopen` | `/reopen <reference>` | Agent+ and visibility |
| `/assign` | `/assign <reference> <telegram_id>` | Manager+ and visibility; assignee validated and notified |
| `/note` | `/note <reference> <note>` | Agent+ and visibility |
| `/search` | `/search <term>` | Any admin (visibility-filtered) |
| `/export` | `/export <reason>` | Manager+; reason recorded, peers notified |
| `/announce` | `/announce <ALL\|region> <msg>` → `confirm`/`cancel` | Manager+ (two-step, §4.7) |
| `/generate_urgent_code` | `/generate_urgent_code` | Agent+ |
| `/add_admin` | `/add_admin <id> [tier] [queue] [true\|false] [role] [name]` | System Admin (new rows only) |
| `/set_role` | `/set_role <id> <tier> <queue> [role]` | System Admin (also restores deactivated admins) |
| `/remove_admin` | `/remove_admin <id>` | System Admin (deactivates, never deletes) |
| `/admins` | `/admins` | System Admin |
| `/maintenance` | `/maintenance on\|off` | System Admin |

A System Admin bypasses every role, queue and region check. Any admin can run
`/help` to see this list in the bot. Every refused command is logged
(`ADMIN_DENIED`), so privilege probing is visible in MESSAGES.

**Two easily-confused pairs:**

- `/note` is **internal** — it appends to `DETAIL`, which the teacher never sees.
  `/reply` is **external** — it writes `PUBLIC_UPDATE` and messages the teacher.
- `/cases` with no argument shows **open cases only**. Use `/cases all` to include
  closed and completed ones.

`/cases`, `/urgent` and `/search` show at most 20 rows; narrow with `/search`.
`/export` omits the `DETAIL` column deliberately — read detail per-case with
`/case` instead.

## 4.10 Triaging the backlog

Each morning (or on the 07:00 ⏰ digest):

1. `/cases unassigned` — open cases nobody has picked up
2. `/assign <ref> <admin_id>` each to someone who can see it — the assignee is
   notified and it appears in their `/mycases`
3. `/urgent` for anything escalated or overdue

The digest is per-admin and scoped to what each admin can see, so an empty
morning means genuinely nothing is stale — not that nobody was told.

## 4.11 Monthly content review

Filter the MESSAGES tab and hand the result to the content owner:

- `FAQ_NO_MATCH` — questions the bank could not answer at all. Group by topic;
  write the missing answers
- `FAQ_LOW_CONFIDENCE` — near-misses and ties; usually two answers needing
  distinguishing keywords, not missing content
- `FAQ_NOT_HELPFUL` — answers returned **confidently that still failed the
  asker**, grouped by `CODE`; these rank the answers most in need of rewriting
- `QUERY_WITHOUT_TOPIC` — what teachers type at the main menu; tells you which
  topics deserve a shortcut

This is the feedback loop the proposal asked for — the logs do nothing unless
someone reads them.

## 4.12 Deploying a code update

**Saving in the editor changes nothing.** The live bot runs the code captured in
the deployed *version*; edits sit in the editor until you publish a new one. A
change that "has no effect" is almost always this.

1. **Paste the changed `.gs` files** and save each (Ctrl/Cmd-S). Fix any red
   error marker before continuing — one bad file breaks all fourteen.
2. **Deploy → Manage deployments**
3. Select the **active** deployment → ✏️ **Edit**
4. **Version → New version**, write a one-line description (e.g. *"upgrade plan
   phases 0–5"*)
5. **Deploy**

**The URL does not change**, so you do **not** re-run `setWebhook`. Creating a
*new* deployment instead of editing the existing one does change the URL, and
then you must (Step 7).

**Then, only if the change requires it:**

| If the change… | Also run | Why |
|---|---|---|
| adds or renames a sheet column | `createAllSheets` | It appends missing headers; existing rows are untouched |
| adds, removes or reschedules a trigger | `installTriggers` | It clears its own handlers and re-adds them |
| alters the time zone | `installTriggers` | Reschedules the 07:00 digest (Step 4a) |

**Verify with a real message, not the editor.** Send `/start` from a teacher
account and run `/whoami` from an admin one. For anything touching cases or
permissions, run the relevant slice of the Part 3 smoke test.

> ⚠️ **The "Test deployments" `/dev` URL is not what Telegram calls.** It always
> runs the latest *saved* code, so it can pass while the live `/exec` deployment
> is still serving the old version — and it requires a logged-in Google session,
> which Telegram's servers do not have. Never treat a `/dev` check as proof the
> bot is updated.

Rolling back is the same dialog with an older version selected — §5.5, which also
covers what to do if the new version is actively misbehaving.

---

# PART 5 — Emergency procedures

## 5.1 Stop the bot immediately

Run **`deleteWebhook`** in the Apps Script editor. Telegram stops delivering
updates instantly. Run `setWebhook` to resume.

For a full stop, also **`/revoke`** the token via @BotFather — this invalidates
the token everywhere and requires updating `BOT_TOKEN` before restarting.

## 5.2 The bot is silent

In order:

1. `getWebhookInfo` — check `last_error_message` and `pending_update_count`
2. **Executions** tab in Apps Script (left sidebar) — are `doPost` runs
   appearing? This is the only log surface; filter to **Failed** to see errors
3. Script Properties — are `BOT_TOKEN`, `SPREADSHEET_ID`, `WEBHOOK_SECRET` all set?
4. Did the deployment URL change without `setWebhook` being re-run?
5. Do all 8 tabs still exist with correct headers?
6. Has the authorisation been revoked, or did the owning account lose access?
   Re-run any function from the editor and re-accept the prompt (Step 5)

## 5.3 A menu button does nothing

Almost always a bad FAQ row: blank `BUTTON_TEXT`, or a `CODE` too long. Check
**Executions → View logs** for `faqButtonRows_` warnings naming the `CODE`.

## 5.4 Suspected data corruption

`CASES_ARCHIVE` and `MESSAGES_ARCHIVE` hold archived rows. Google Sheets keeps
full version history: **File → Version history → See version history.**

When auditing a CASES row, `LAST_ACTOR` names the admin whose command last
changed it (blank = changed by hand or predates the column — cross-check with
version history and MESSAGES). An unexpected ADMINS change should have a
matching 🔐 alert and `ADMINS_SHEET_EDITED` log row; a change *without* one was
made by the bot's own commands.

## 5.5 Roll back a bad deployment

Apps Script keeps every deployed version.

1. **Deploy → Manage deployments**
2. Select the active deployment → ✏️ **Edit**
3. **Version** → choose the last known-good version
4. **Deploy**

The URL is unchanged by this, so **you do not need to re-run `setWebhook`.** The
rollback takes effect on the next update Telegram delivers.

If the bot is actively misbehaving — sending wrong messages, looping — run
`deleteWebhook` **first** (§5.1) to stop delivery, then roll back, then
`setWebhook` to resume.

Code edits in the editor do **not** go live until you deploy a new version. If a
change appears to have no effect, that is usually why — the routine update
procedure is **§4.12**.

## 5.6 Back up and restore

Nothing is backed up automatically. Version history covers accidental edits; it
does **not** survive the Google account being lost.

**Backup — monthly, 2 minutes:**

1. **File → Download → Microsoft Excel (.xlsx)** — captures all tabs at once
2. Store it wherever MoPSE keeps operational records, not on the same account
3. Separately, note the values of `BOT_TOKEN`, `SPREADSHEET_ID` and
   `WEBHOOK_SECRET` in your password manager — these are **not** in the
   spreadsheet and cannot be recovered from it

The `.gs` source is in this repository; keep it under version control.

**Restore:**

1. Create a new spreadsheet, import each tab from the backup, keeping tab names
   and header rows **exactly** as they were — headers are contracts (§B6 of
   `CONCERNS-AND-IT-ACTIONS.md`)
2. Create a new Apps Script project and paste every `.gs` file (Step 3)
3. Set the three script properties (Step 4)
4. Deploy (Step 6), set `WEBAPP_URL`, run `setWebhook` (Step 7)
5. Run `installTriggers` (Step 8)
6. **Check the case counters.** `CASE_SEQ_<PREFIX>_<YEAR>` script properties do
   not travel with the spreadsheet. On a fresh project they are absent, so the
   first new case of each prefix re-seeds from the highest reference in the
   restored CASES sheet. That is correct **provided the restored sheet still holds
   this year's cases** — if archiving has already moved them out, set the
   properties by hand to at least the highest number ever issued, or references
   will be reused.

---

# PART 6 — Deferred setup

## 6.1 Data retention

Set `RETENTION_DAYS` in SETTINGS. Until then, `runArchive` logs and exits.

## 6.2 `ADMIN_QUEUE` and the newer topics — ✅ resolved

The seven newer FAQ topics are now explicitly mapped onto the closest existing
queue in `queueForCategory_` (Salary/Workload/Leave → Contract, Placement/
Conduct → Recruitment, Health/Living → Accommodation), with anything unmapped
still defaulting to `All`. The decision was deliberate: a small support team
does not want eleven queues. Revisit only if a topic grows dedicated staff.

## 6.3 The seven Google Forms

For each of Visa, Contract, Passport, Ticket, Reimbursement, Certificate,
Correction:

1. Create the Form
2. Add a **required short-answer** question titled **exactly** `Telegram Chat ID`
3. Get its prefill entry ID: **⋮ → Get pre-filled link**, fill anything, copy the
   link, and read the `entry.XXXXXXXXX` parameter
4. Put the form's share URL in `FORM_URLS` in `Config.gs`
5. Put the entry ID in `FORM_CHAT_ID_ENTRY_IDS_` in `FormRouter.gs`
6. Get the Form ID from its **edit** URL (between `/d/` and `/edit`)
7. Add a temporary wrapper in the editor and run it once:

```javascript
function installVisaForm() {
  installFormSubmitTrigger('THE_FORM_ID', 'VISA');
}
```

Repeat per form with the matching doc key. Delete the wrappers afterwards.

> The chat-ID field is **visible and editable** — Google Forms has no hidden
> fields. The bot therefore trusts it only when it resolves to an
> already-verified chat; anything else files as an "unresolved submitter" case
> for manual triage. This is by design, not a gap.
