# MoPSE Teacher Support Bot — Fix and Upgrade Plan

**Version:** 1.1 · **Date:** 2026-07-27 · **Status:** ✅ **Code executed 2026-07-27** — deploy & in-bot verification pending

> **Execution status.** Every code task in Phases 0–5 plus Task 6.1 has been
> implemented and committed to git (one commit per task, baseline `dbbc500`).
> `BOT-SPEC.md`, `RUNBOOK.md` and `CONCERNS-AND-IT-ACTIONS.md` have been updated
> per each task's **Docs to update** block. What this plan's checkboxes call
> **Deploy and verify** cannot be done from this machine — Apps Script runs only
> in Google's editor — so the remaining work is: paste the `.gs` files into the
> Apps Script project, deploy a new version, re-run `createAllSheets` and
> `installTriggers` (and hand-fix `CASES_ARCHIVE!J1` if that tab exists), then
> run the RUNBOOK Part 3 smoke test (steps 1–35). Task 6.2 (content review) is
> MoPSE's, and Task 6.3 (scale work) stays trigger-conditioned. Syntax of all
> fourteen files was verified with Node (individually and concatenated, no
> duplicate top-level declarations).

> **What changed in 1.1.** A full code review of all fourteen `.gs` files against
> this plan. Every line-number reference was confirmed accurate and every helper
> the plan calls was confirmed to exist. Three defects in the plan itself were
> fixed: Task 2.1 called `logInteraction` and `sendMessage` from inside
> `attemptVerify_`'s `LockService` critical section, reintroducing a bug
> `Logger.gs` documents by name; Task 3.2's `adminCanSeeCase_` performed a
> whole-USERS-sheet read per case row, which would exhaust the six-minute
> execution limit on `/cases`; and Task 6.1 mis-stated the `callback_data` byte
> budget (`FAQANS:` and `FAQBAD:` are both 7 bytes — the limit stays 57).
> Phase 0 was resequenced so `denyAdminAction_` is defined before it is used,
> Task 0.4 was rewritten because its two target documents have since been
> deleted, and seven tasks that changed a command, a column or a permission
> without saying so gained **Docs to update** blocks. Four gaps were closed:
> Task 5.2 would have alerted on the bot's own writes, Task 5.3 shipped a
> permission column no command could set, Task 1.3 made deactivation
> irreversible from inside the bot, and Task 3.2's notifier signature change was
> specified but never written out.

**Goal:** Close every defect and design gap identified in the July 27 product and
permissions reviews, in an order that makes the bot safe to launch first and
well-governed second.

**Architecture:** No rewrite. Every change is additive or surgical against the
existing 14-file Apps Script project. The one structural change — passing an
originating topic into `createCase()` (Phase 3) — is the keystone that activates
the dormant queue/routing model, so everything that depends on it is sequenced
after it.

**Tech stack:** Google Apps Script (V8), Google Sheets, Telegram Bot API. No
build step, no package manager, no test framework.

---

## How to execute this plan

**This project has no test runner and no version control.** Apps Script cannot be
run locally and `D:\Telegram Bot` is not a git repository. Standard TDD steps are
therefore replaced with:

1. **Edit** the named file(s)
2. **Deploy** — Apps Script editor → Deploy → Manage deployments → Edit → New version
3. **Verify** — run the stated check in the bot or the editor, and compare against
   the stated expected result
4. **Checkpoint** — copy the changed `.gs` files into a dated folder before moving
   to the next task, so any task can be rolled back individually

> ⚠️ **Set up version control before starting.** Run `git init` in `D:\Telegram Bot`
> and commit the current state as a baseline. Every task below then ends with a
> real commit instead of a manual file copy. This costs five minutes and is the
> single highest-leverage thing to do before touching any code.

**Reference documents:** `BOT-SPEC.md` (what the system does), `RUNBOOK.md`
(how to deploy and operate it), `CONCERNS-AND-IT-ACTIONS.md` (accepted risks).
All three must be updated as tasks land — each task names the doc sections it
invalidates. **These three plus this file are the only documentation in scope.**
`bot_spec.md` and `proposal_gap_analysis.md` were deleted on 2026-07-27 and must
not be reinstated (Task 0.4).

**Command count, tracked here so it cannot drift.** Sixteen admin commands ship
today (`BOT-SPEC.md` §6.5 says "All sixteen"). Task 1.3 adds `/admins` and
`/remove_admin` → **18**. Task 4.1 adds `/mycases` → **19**. `/help` (shipped)
and `/privacy` (Task 2.2) are teacher-facing, handled in `Webhook.gs` ahead of
the admin dispatcher, and are deliberately counted separately. Any task that
adds a command must update this line and `BOT-SPEC.md` §6.5's heading together.

---

## Finding-to-task index

Every concern raised in the two reviews, and where it is addressed.

| # | Finding | Task | Phase |
|---|---|---|---|
| R1 | `/add_admin` silently demotes System Admins; self-lockout | 0.2 | 0 |
| P3 | Submit Documents ships broken and cannot be disabled | 0.3 | 0 |
| R6a | Only 1 of 12 authorization denials is logged | 0.1 | 0 |
| P7 | `proposal_gap_analysis.md` is misleading | 0.4 — **closed by deletion**; cleanup only | 0 |
| P1 | **No admin is notified when a case is created** | 1.1 | 1 |
| P4a | FAQ misses are not logged — no content feedback loop | 1.2 | 1 |
| R6b | ADMINS has no name, no lifecycle, no `/admins`, no removal | 1.3 | 1 |
| R9 | Hygiene: truthy parsing, double sheet read, dead parameter | 1.4 | 1 |
| P2 | Identity is an email; duplicate chat binding undetected | 2.1 | 2 |
| P8 | No privacy notice; no data-subject route | 2.2 | 2 |
| R2 | **Queue dimension inert — delegation impossible** | 3.1 | 3 |
| R5 | Region modelled on teachers but not staff | 3.2 | 3 |
| R4 | `OWNER` decorative; no tasking | 4.1–4.2 | 4 |
| P1b | No SLA loop — cases can rot; `OVERDUE_DAYS` only affects a command's output | 4.3 | 4 |
| R8 | `/announce` and `/export` ungoverned | 5.1, 5.4 | 5 |
| R7 | Sheet access silently grants System Admin | 5.2 | 5 |
| R3 | Tier is a category pretending to be a rank | 5.3 | 5 |
| P4b | FAQ findability: typed questions dead-end at the main menu | 6.1 | 6 |
| P4c | No "did this resolve your question?" — proposal §3.1, falsely marked built | 6.1 step 4 | 6 |
| R3b | `Finance` tier and `Recruitment`/`Technical` queues map to nothing | 3.3, 5.3 | 3, 5 |
| P5 | Answer bank hedges where teachers need numbers | 6.2 | 6 |
| P6 | Load spike at arrival week | 6.3 | 6 |

---

# PHASE 0 — Pre-launch blockers

**Effort:** ~3 hours. **Do not launch without these.**

> **Order matters in this phase.** Task 0.1 defines `denyAdminAction_`, which
> Task 0.2 calls. Do them in the numbered order. (An earlier revision of this
> plan had the two the other way round and relied on a footnote to catch it.)

---

### Task 0.1: Log every authorization denial

Of twelve authorization checks in `AdminCommands.gs`, only one logs. Every tier
and queue rejection sends a message and records nothing, so a registered admin
probing for privileges they do not have is invisible.

**Files:**
- Modify: `AdminCommands.gs` — add one helper, replace 11 call sites

- [ ] **Step 1: Add the helper below `adminCanActOnCategory_`**

```javascript
/**
 * One place that both tells the admin no and records that it happened.
 * Previously only routeAdminCommand_'s "not registered" branch logged; every
 * tier and queue rejection was silent, so an existing admin probing for
 * privileges left no trace at all. Failed authorization is precisely what an
 * audit trail is for.
 */
function denyAdminAction_(chatId, adminRow, cmd, message) {
  sendMessage(chatId, message);
  const shape = adminRow
    ? 'system=' + (isSystemAdminRow_(adminRow) ? 'Y' : 'N') +
      ' tier=' + (adminRow.TIER || 'None') + ' queue=' + (adminRow.QUEUE || 'None')
    : 'not-an-admin';
  logInteraction(chatId, 'ADMIN_DENIED', cmd + ' [' + shape + ']');
}
```

- [ ] **Step 2: Replace the six queue rejections**

Lines 302, 374, 396, 419, 435, 448 all read:

```javascript
if (!adminCanActOnCategory_(adminRow, c.CATEGORY)) { sendMessage(chatId, "You are not authorized for this case's queue."); return; }
```

Replace each with the command's own name substituted:

```javascript
if (!adminCanActOnCategory_(adminRow, c.CATEGORY)) { denyAdminAction_(chatId, adminRow, '/case', "You are not authorized for this case's queue."); return; }
```

Use `/case` at line 302, `/reply` at 374, `/close` at 396, `/assign` at 419,
`/note` at 435, `/reopen` at 448.

- [ ] **Step 3: Replace the five tier and system rejections**

```javascript
// line 474-477, handleExport_
if (!checkPermission(chatId, ADMIN_TIER.PROGRAM, null)) {
  denyAdminAction_(chatId, adminRow, '/export', 'Only Program-tier admins can export.');
  return;
}
// line 561-564, handleAnnounce_
if (!checkPermission(chatId, ADMIN_TIER.PROGRAM, null)) {
  denyAdminAction_(chatId, adminRow, '/announce', 'Only Program-tier admins can send announcements.');
  return;
}
// line 681-684, handleGenerateUrgentCode_
if (!checkPermission(chatId, ADMIN_TIER.REGIONAL, null)) {
  denyAdminAction_(chatId, adminRow, '/generate_urgent_code', 'Only Regional-tier admins can generate an urgent code.');
  return;
}
// line 651, handleSetRole_
if (!isSystemAdminRow_(adminRow)) { denyAdminAction_(chatId, adminRow, '/set_role', 'Only a System Admin can run /set_role.'); return; }
// line 832, handleMaintenance_
if (!isSystemAdminRow_(adminRow)) { denyAdminAction_(chatId, adminRow, '/maintenance', 'Only a System Admin can run /maintenance.'); return; }
```

`/add_admin`'s own check (line 630) is deliberately left alone here — Task 0.2
replaces that entire function and wires `denyAdminAction_` in as part of the
rewrite. Eleven call sites here, plus that one, is the twelve.

- [ ] **Step 4: Deploy and verify**

From an admin with `TIER=Regional`, run `/export`. Expected: the refusal message,
**and** a new MESSAGES row with `ACTION = ADMIN_DENIED` and
`DETAIL = /export [system=N tier=Regional queue=…]`.

- [ ] **Step 5: Commit**

```bash
git add AdminCommands.gs && git commit -m "feat: log every authorization denial, not just unregistered senders"
```

**Docs to update:** `BOT-SPEC.md` §13 — add a "Privilege probing" row.

---

### Task 0.2: Stop `/add_admin` from demoting System Admins

`/add_admin` upserts, and `IS_SYSTEM_ADMIN` defaults to `false` when the fourth
argument is omitted. Re-running it against an existing System Admin silently
strips their privileges — including the caller's own, and including the last
System Admin, which locks everyone out with no in-bot recovery.

**Files:**
- Modify: `AdminCommands.gs:629-644` (`handleAddAdmin_`)

- [ ] **Step 1: Replace `handleAddAdmin_` entirely**

```javascript
// /add_admin ADDS. It used to upsert — and because isSystem defaults to false
// when the 4th argument is omitted, re-running it against an existing System
// Admin silently stripped that flag. Aimed at yourself it was self-demotion;
// aimed at the last System Admin it locked everyone out of the bot, with the
// only recovery being a hand edit of the ADMINS sheet. An existing target is
// now refused outright and pointed at /set_role.
function handleAddAdmin_(chatId, adminRow, rest) {
  if (!isSystemAdminRow_(adminRow)) {
    denyAdminAction_(chatId, adminRow, '/add_admin', 'Only a System Admin can run /add_admin.');
    return;
  }
  const parts = rest.trim().split(/\s+/).filter(Boolean);
  const targetId = parts[0];
  const tier = parts[1] || ADMIN_TIER.NONE;
  const queue = parts[2] || ADMIN_QUEUE.NONE;
  const isSystem = String(parts[3] || 'false').toLowerCase() === 'true';

  if (!targetId) {
    sendMessage(chatId, 'Usage: /add_admin <telegram_id> [tier] [queue] [true|false]');
    return;
  }
  if (!/^\d+$/.test(String(targetId))) {
    sendMessage(chatId, 'A Telegram ID is all digits. Ask the person to message @userinfobot to find theirs.');
    return;
  }
  if (!isValidTier_(tier) || !isValidQueue_(queue)) {
    sendMessage(chatId, 'Invalid tier/queue. Tiers: ' + Object.values(ADMIN_TIER).join(', ') +
      '. Queues: ' + Object.values(ADMIN_QUEUE).join(', '));
    return;
  }
  if (findAnyAdminRow_(targetId)) {
    sendMessage(chatId, targetId + ' is already an admin.\n\n' +
      'Use /set_role ' + targetId + ' <tier> <queue> to change their tier or queue.\n' +
      'Changing System Admin on an existing row is a deliberate edit in the ADMINS tab — ' +
      'no command does it, so it can never happen by accident.');
    return;
  }

  upsertAdminRow_(targetId, isSystem, tier, queue);
  logInteraction(chatId, 'ADMIN_ADDED', targetId + ' tier=' + tier + ' queue=' + queue + ' system=' + isSystem);
  sendMessage(chatId, 'Admin ' + targetId + ' added — tier=' + tier + ', queue=' + queue +
    ', System Admin=' + (isSystem ? 'YES' : 'no') + '.');
}
```

> `denyAdminAction_` comes from Task 0.1, which is already done by the time you
> reach here. `findAnyAdminRow_` does not arrive until Task 1.3 — until then use
> `findAdminRow_(targetId)` on the "already an admin" line; the two behave
> identically until the `ACTIVE` column exists.

- [ ] **Step 2: Deploy and verify the guard**

From a System Admin account, with a second admin `999999999` already present:

```
/add_admin 999999999 Program All
```

Expected: *"999999999 is already an admin…"* and the ADMINS sheet is unchanged —
confirm `IS_SYSTEM_ADMIN` still reads whatever it read before.

- [ ] **Step 3: Verify a genuinely new admin still works**

```
/add_admin 111111111 Regional Visa
```

Expected: *"Admin 111111111 added — tier=Regional, queue=Visa, System Admin=no."*
and a new row in ADMINS. Delete the test row afterwards.

- [ ] **Step 4: Verify the digit check**

```
/add_admin banana Program All
```

Expected: *"A Telegram ID is all digits…"*, no row written.

- [ ] **Step 5: Commit**

```bash
git add AdminCommands.gs && git commit -m "fix: /add_admin no longer demotes existing System Admins"
```

**Docs to update:** `BOT-SPEC.md` §6.4 and `RUNBOOK.md` §4.5 currently describe
the fourth argument as working on any target. Both must now say it applies to
**new rows only**.

---

### Task 0.3: Hide Submit Documents while the forms are placeholders

`FORM_URLS` holds seven `https://forms.gle/PLACEHOLDER_*` strings. Those are
truthy, so a teacher who passes the verification gate is handed a dead link.
`RUNBOOK.md` §1.5 claims launching without the button is "one config change" —
there is no such config; the button is hardcoded.

**Files:**
- Modify: `FormRouter.gs` (add placeholder detection)
- Modify: `MenuHandler.gs:83-96` (`mainMenuKeyboard_`), `:103-119` (`teacherHelpText_`), `:410`

- [ ] **Step 1: Add placeholder detection to `FormRouter.gs`**

Insert directly below `DOC_TYPE_DEFS_`:

```javascript
// Config.gs ships seven placeholder URLs until real Google Forms exist (see
// RUNBOOK.md §6.3). They are truthy, so without this check the bot handed a
// teacher a dead forms.gle link after making them verify their identity to
// get it. A doc type is "real" only once its URL stops being a placeholder.
const FORM_URL_PLACEHOLDER_MARKER_ = 'PLACEHOLDER_';

function isRealFormUrl_(url) {
  return !!url && String(url).indexOf(FORM_URL_PLACEHOLDER_MARKER_) === -1;
}

/** Doc types with a real form behind them. Empty until MoPSE creates the forms. */
function realDocTypeList_() {
  return DOC_TYPE_DEFS_.filter(d =>
    Object.prototype.hasOwnProperty.call(FORM_URLS, d.key) && isRealFormUrl_(FORM_URLS[d.key]));
}

/** True when at least one doc type is submittable — gates the whole feature. */
function documentSubmissionEnabled_() {
  return realDocTypeList_().length > 0;
}
```

- [ ] **Step 2: Make `docTypeList_` and `formUrlForDocType_` placeholder-aware**

Replace both functions:

```javascript
function docTypeList_() {
  return realDocTypeList_();
}

/**
 * `key` arrives straight off a 'DOC:<key>' callback, which anyone can hand-craft.
 * A bare FORM_URLS[key] lookup resolves inherited Object.prototype members, so
 * 'DOC:constructor' returned a truthy function instead of undefined and the
 * `base.indexOf` below threw — swallowed by doPost, leaving the tap doing
 * nothing at all. hasOwnProperty confines both lookups to real entries.
 */
function formUrlForDocType_(chatId, key) {
  if (!Object.prototype.hasOwnProperty.call(FORM_URLS, key)) return null;
  const base = FORM_URLS[key];
  if (!isRealFormUrl_(base)) return null;
  const entryId = Object.prototype.hasOwnProperty.call(FORM_CHAT_ID_ENTRY_IDS_, key)
    ? FORM_CHAT_ID_ENTRY_IDS_[key]
    : null;
  if (!entryId) return base;
  const sep = base.indexOf('?') === -1 ? '?' : '&';
  return base + sep + entryId + '=' + encodeURIComponent(chatId);
}
```

- [ ] **Step 3: Drop the main-menu button when the feature is off**

In `MenuHandler.gs`, replace the unconditional push at line 89:

```javascript
  rows.push([{ text: '❓ All FAQ topics', callback_data: 'MENU:FAQ' }]);
  // Hidden entirely until a real Google Form exists — offering it would send a
  // teacher a dead link after making them verify to reach it.
  if (documentSubmissionEnabled_()) {
    rows.push([{ text: '📤 Submit Documents', callback_data: 'MENU:SUBMIT_DOCS' }]);
  }
  rows.push([{ text: '🔍 Check My Case', callback_data: 'MENU:CHECK_CASE' }]);
```

- [ ] **Step 4: Guard the callback route**

A stale button from an earlier deployment can still arrive. In
`handleMenuCallback_`, replace line 410:

```javascript
  if (data === 'MENU:SUBMIT_DOCS') {
    if (!documentSubmissionEnabled_()) {
      sendMessage(chatId, 'Document submission is not open yet. Please use Contact Support and we will tell you what to send.', backToMenuKeyboard_());
      return;
    }
    startCaseFeature_(chatId, 'SUBMIT_DOCS');
    return;
  }
```

- [ ] **Step 5: Drop the help line too**

In `teacherHelpText_`, replace the fixed array with a built one:

```javascript
function teacherHelpText_() {
  const lines = [
    'MoPSE Teacher Support Bot — quick help:',
    '/start or /menu — show the main menu',
    FAQ_TOPICS.filter(t => t.onMainMenu).map(t => t.emoji + ' ' + t.label).join(' / ') +
      ' — browse FAQ answers by topic',
    '❓ All FAQ topics — the full list (' + FAQ_TOPICS.length +
      ' topics, including salary, workload, leave, placement, health and living in Uzbekistan)'
  ];
  if (documentSubmissionEnabled_()) {
    lines.push('📤 Submit Documents — get the right form link for visa, contract, passport, ticket, reimbursement, certificate, or correction documents');
  }
  lines.push('🔍 Check My Case — see the status of cases you have opened');
  lines.push('📞 Contact Support — open a new case with our support team');
  lines.push('🚨 Urgent Case — only if you already have a one-time code from a MoPSE Regional admin');
  lines.push('🌐 Change Language — English only for now');
  return lines.join('\n');
}
```

- [ ] **Step 6: Deploy and verify**

As a teacher, `/start`. Expected: **no 📤 Submit Documents button**, and `/help`
does not mention it. Then in `Config.gs` temporarily set
`FORM_URLS.VISA = 'https://forms.gle/realtest'`, redeploy, `/start` again.
Expected: the button reappears and offers **only** "Visa documents". Revert the
temporary edit.

- [ ] **Step 7: Commit**

```bash
git add FormRouter.gs MenuHandler.gs && git commit -m "fix: hide Submit Documents until a real form exists"
```

**Docs to update:** `RUNBOOK.md` §1.5 risk row and §1.2 item 7 — the button now
hides itself, so no manual step is needed. `BOT-SPEC.md` §10.

---

### Task 0.4: Retire the pointers to the two deleted specification documents

**Status change from v1.0 of this plan.** `proposal_gap_analysis.md` and
`bot_spec.md` were **deleted outright** on 2026-07-27, not quarantined. That is a
stronger resolution than this task originally proposed: the risk in finding P7
was a misleading document being read as authoritative, and a deleted file cannot
be read at all. `CONCERNS-AND-IT-ACTIONS.md` A3 offered exactly this choice
("delete it, or rename to `bot_spec.OBSOLETE.md`") and the first branch was
taken. **A3 is satisfied. P7 is closed.**

Three documents now divide the work with no overlap: `BOT-SPEC.md` describes what
the system *is*, `RUNBOOK.md` how to *run* it, `UPGRADE-PLAN.md` what is *left*.

What remains is dead pointers to files that no longer exist.

**Files:**
- Modify: `BOT-SPEC.md` (the "Superseded documents" section, and line 6)
- Modify: `CONCERNS-AND-IT-ACTIONS.md` (A3)

- [x] **Step 1: Fix `BOT-SPEC.md`'s "Superseded documents" section** ✅ done 2026-07-27

It currently describes `bot_spec.md` in the present tense and recommends deleting
it — advice that has already been taken. Replace the section body with:

```markdown
### Superseded documents

`bot_spec.md` and `proposal_gap_analysis.md` were deleted on 2026-07-27. The
first documented an architecture that was never built (`MessageHandler.gs`,
`CallbackHandler.gs`, `FormGenerator.gs`, `EmailParser.gs`, `CAND-0042` deep
links, a 7-column flat sheet); the second was a mid-build status table that was
wrong in both directions. Neither is recoverable from this folder and neither
should be reinstated. This document is the specification.
```

Also soften line 6, which reads "It supersedes `bot_spec.md`, which describes an
architecture that was…" — present tense about a file that is gone. Past tense.

- [x] **Step 2: Close out A3 in `CONCERNS-AND-IT-ACTIONS.md`** ✅ done 2026-07-27

Change the A3 heading from 🔴 to ✅ and replace its action line with:

```markdown
**Action:** ✅ **Done — 2026-07-27.** `bot_spec.md` was deleted rather than
renamed, along with `proposal_gap_analysis.md` for the same reason. `BOT-SPEC.md`
is now the only specification in this folder.
```

- [ ] **Step 3: Commit**

```bash
git add BOT-SPEC.md CONCERNS-AND-IT-ACTIONS.md && git commit -m "docs: close out the two deleted specification documents"
```

> **Known and deliberately not fixed here.** `CaseManager.gs:8` still names
> `proposal_gap_analysis.md` in a comment, and `PLAN.md` — which also no longer
> exists — is cited **32 times across eight `.gs` files** (`CaseManager` ×9,
> `Triggers` ×6, `AdminCommands` ×5, `ArchiveManager`/`FormRouter`/`UserSession`
> ×3 each, `MenuHandler` ×2, `Webhook` ×1), often as the justification for why a
> lock or a guard exists. Those are source-comment edits across the whole
> codebase and are **out of scope for this plan**, which touches `.gs` files only
> where behaviour changes. `DEPENDENCY_TREE.md` is still present, so its six
> citations remain valid. Retarget the `PLAN.md` references at `BOT-SPEC.md` §12
> as a separate, self-contained pass whenever it is convenient.

---

# PHASE 1 — Make it an actual support system

**Effort:** ~1 day. **Task 1.1 is the most important change in this plan.**

---

### Task 1.1: Notify admins when a case is created

Proposal §1.1 requires *"Notify authorized staff of new or urgent cases."* It was
never built. Today an escalated case — after the teacher phoned a Regional admin,
obtained a single-use code, and typed it in — produces a spreadsheet row and
silence. Nobody is told anything until an admin independently runs `/cases`.

**Files:**
- Modify: `AdminCommands.gs` (add the notifier)
- Modify: `MenuHandler.gs:288-331` (`handleCaseDetailMessage_`)
- Modify: `Triggers.gs:162-180` (`fileDocumentSubmissionCase_`)

- [ ] **Step 1: Add the notifier to `AdminCommands.gs`**

Place it directly after `adminCanActOnCategory_`:

```javascript
// A broadcast to every admin would be noise, so recipients are only those who
// could actually act on this case: its queue, All-queue, or System Admin. Until
// Phase 3 lands, every case maps to All — so in practice this reaches All-queue
// and System Admins, which is exactly who can work it today.
const NEW_CASE_NOTIFY_MAX_ADMINS_ = 20;

/**
 * Proposal §1.1: "Notify authorized staff of new or urgent cases." Never built —
 * a case, including an escalated one, was filed to the sheet and nobody was
 * told. This is the difference between a support system and a suggestion box.
 *
 * The case DETAIL is deliberately NOT included. Admins read it with /case; a
 * teacher's free text should not be copied into N separate Telegram histories.
 *
 * Never throws: a notification failure must not undo a case that was filed
 * successfully. Must NOT be called from inside a LockService critical section
 * (it calls logInteraction — see Logger.gs).
 */
function notifyAdminsOfNewCase_(reference, category, urgent) {
  try {
    const recipients = getAllAdminRows_()
      .filter(r => String(r.TELEGRAM_ID || '').trim())
      .filter(r => adminCanActOnCategory_(r, category));

    if (!recipients.length) {
      console.error('notifyAdminsOfNewCase_: no admin is authorized for category "' + category +
        '" — case ' + reference + ' was filed but NOBODY was notified. Check the ADMINS sheet.');
      return;
    }

    const text = [
      (urgent ? '🚨 URGENT case ' : '🆕 New case ') + reference,
      'Category: ' + category,
      'Opened: ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'),
      '',
      '/case ' + reference + ' — read it',
      '/assign ' + reference + ' <your_telegram_id> — take it'
    ].join('\n');

    let delivered = 0;
    recipients.slice(0, NEW_CASE_NOTIFY_MAX_ADMINS_).forEach(r => {
      const result = sendMessage(r.TELEGRAM_ID, text);
      if (result.ok) {
        delivered++;
      } else {
        console.error('notifyAdminsOfNewCase_: could not reach admin ' + r.TELEGRAM_ID +
          ' about ' + reference + ': ' + (result.description || 'unknown error'));
      }
    });

    // 'SYSTEM' rather than a chat id: this is a bot-initiated event, not a
    // teacher interaction, and putting a case reference in the CHAT_ID column
    // would make the log ambiguous. Same convention as Task 5.2.
    logInteraction('SYSTEM', urgent ? 'ADMINS_NOTIFIED_URGENT' : 'ADMINS_NOTIFIED_NEW',
      reference + ' — delivered ' + delivered + '/' + recipients.length);
  } catch (err) {
    console.error('notifyAdminsOfNewCase_ failed for ' + reference + ': ' + err);
  }
}
```

- [ ] **Step 2: Call it from the Contact Support / Urgent Case path**

In `MenuHandler.gs`, `handleCaseDetailMessage_`, add one call in the new-case
branch and one in the escalated-duplicate branch:

```javascript
  if (result.isNew) {
    if (urgent) {
      try {
        updateCaseFields_(result.reference, { STATUS: CASE_STATUS.ESCALATED });
      } catch (err) {
        console.error('handleCaseDetailMessage_: escalation failed for ' + result.reference + ': ' + err);
      }
    }
    logInteraction(chatId, 'CASE_CREATED', result.reference);
    notifyAdminsOfNewCase_(result.reference, CATEGORIES.CONTACT_SUPPORT, urgent);
    sendMessage(chatId,
      'Case opened' + (urgent ? ' and marked urgent' : '') + '. Your reference is ' + result.reference +
      '. Use Check My Case to see its status.', backToMenuKeyboard_());
    return;
  }
```

and, in the urgent-duplicate branch, immediately after the `logInteraction` line:

```javascript
    logInteraction(chatId, escalated ? 'CASE_ESCALATED_EXISTING' : 'CASE_DUPLICATE_RETURNED', result.reference);
    if (escalated) notifyAdminsOfNewCase_(result.reference, CATEGORIES.CONTACT_SUPPORT, true);
```

- [ ] **Step 3: Call it from the document-submission path**

In `Triggers.gs`, `fileDocumentSubmissionCase_`:

```javascript
  const chatId = String(chatIdRaw || '').trim();
  if (chatId && isVerified_(chatId)) {
    const result = createCase(chatId, CATEGORIES.SUBMIT_DOCS, 'Doc type: ' + docKey);
    if (result.isNew) {
      sendFormSubmissionConfirmation_(chatId, docKey);
      notifyAdminsOfNewCase_(result.reference, CATEGORIES.SUBMIT_DOCS, false);
    }
    return;
  }

  const sentinel = 'UNRESOLVED:' + (formResponseId || Utilities.getUuid());
  const unresolved = createCase(
    sentinel,
    CATEGORIES.SUBMIT_DOCS,
    'Doc type: ' + docKey + ' — unresolved submitter (raw chat_id field value: "' + chatId + '")',
    { skipVerification: true }
  );
  // An unresolved submitter cannot be notified, which makes telling an admin
  // more important here than anywhere else — this case can only be triaged
  // by a human who knows it exists.
  if (unresolved.isNew) notifyAdminsOfNewCase_(unresolved.reference, CATEGORIES.SUBMIT_DOCS, false);
```

- [ ] **Step 4: Deploy and verify the ordinary path**

As a verified teacher: **Contact Support** → describe an issue. Expected: the
teacher gets their reference **and** every All-queue/System Admin receives
`🆕 New case SUPPORT-2026-000NN` within seconds.

- [ ] **Step 5: Verify the urgent path**

Admin: `/generate_urgent_code`. Teacher: **Urgent Case** → code → describe.
Expected: admins receive `🚨 URGENT case …`. Confirm MESSAGES has an
`ADMINS_NOTIFIED_URGENT` row with a delivered count.

- [ ] **Step 6: Verify the no-recipient warning**

Temporarily set the only admin's `QUEUE` to `Visa`, redeploy, open a case.
Expected: the case is still created, the teacher still gets their reference, and
**Executions → View logs** shows *"no admin is authorized for category…"*. Restore
`QUEUE = All`.

- [ ] **Step 7: Commit**

```bash
git add AdminCommands.gs MenuHandler.gs Triggers.gs && git commit -m "feat: notify authorized admins when a case is created (proposal 1.1)"
```

**Docs to update:** `BOT-SPEC.md` §7 (add a notification subsection) and §6.5;
`RUNBOOK.md` Part 3 smoke test — add a step confirming admins are notified;
`CONCERNS-AND-IT-ACTIONS.md`.

---

### Task 1.2: Log FAQ misses so content gaps become visible

`answerFaqQuery`'s zero-match branch sends a picker and records nothing. The
single most valuable content signal — which questions the approved bank cannot
answer — is invisible. Proposal §1.1 asked for interactions recorded *"for
reporting and quality improvement"*; the reporting half does not exist.

**Files:**
- Modify: `QAEngine.gs:246-282` (`answerFaqQuery`)

- [ ] **Step 1: Add two log lines**

```javascript
  if (scored.length === 0) {
    // A question the approved bank cannot answer is the most valuable content
    // signal there is, and it was previously recorded nowhere — RECEIVED_MESSAGE
    // captures the text but not the fact that it failed, so gaps were
    // unfindable. Truncated because a MESSAGES cell is not a transcript.
    logInteraction(chatId, 'FAQ_NO_MATCH', category + ' | ' + String(queryText).slice(0, 200));
    sendFaqPicker_(chatId, rows, category,
      "I couldn't match that to an approved answer. Did you mean one of these, or tap Contact Support to reach a person:", true);
    return;
  }

  const topScore = scored[0].score;
  const topMatches = scored.filter(s => s.score === topScore).map(s => s.row);

  if (topMatches.length === 1 && topScore >= FAQ_CONFIDENT_SCORE) {
    sendFaqAnswer_(chatId, topMatches[0]);
    return;
  }

  // Logged separately from a clean miss: a tie or fuzzy-only match usually means
  // two answers need distinguishing keywords, not that content is missing.
  logInteraction(chatId, 'FAQ_LOW_CONFIDENCE',
    category + ' | ' + String(queryText).slice(0, 200) + ' | top=' + topScore + ' ties=' + topMatches.length);

  const prompt = topScore < FAQ_CONFIDENT_SCORE
    ? 'I am not certain I understood that. Did you mean one of these?'
    : 'I found a few things that might match — pick the closest one:';
  sendFaqPicker_(chatId, topMatches, category, prompt, topScore < FAQ_CONFIDENT_SCORE);
```

- [ ] **Step 2: Deploy and verify**

Enter any topic, type `qwertyuiop`. Expected: a MESSAGES row with
`ACTION = FAQ_NO_MATCH` and the topic plus query in DETAIL.

- [ ] **Step 3: Commit**

```bash
git add QAEngine.gs && git commit -m "feat: log unmatched and low-confidence FAQ queries"
```

**Operational follow-up:** add to `RUNBOOK.md` Part 4 — *"Monthly: filter MESSAGES
for `FAQ_NO_MATCH`, group by topic, and write the missing answers."* This is the
content feedback loop the proposal asked for; the log alone does nothing without
someone reading it.

---

### Task 1.3: Give ADMINS an identity and a lifecycle

ADMINS is `TELEGRAM_ID · IS_SYSTEM_ADMIN · TIER · QUEUE`. There is no name, no
record of who granted access or when, no way to suspend someone, no `/admins`
listing, and no `/remove_admin`. Six months on, *"who is 483920184 and why do
they have All-queue access?"* is unanswerable from the system.

**New columns are appended, never inserted**, so existing positional writes keep
working and `createAllSheets()` extends the tab safely.

**Files:**
- Modify: `SetupSheets.gs:35-37`
- Modify: `AdminCommands.gs` (lookup helpers, two new commands)
- Modify: `Config.gs` — none

- [ ] **Step 1: Extend the ADMINS headers**

```javascript
  createSheetWithHeaders_(ss, SHEETS.ADMINS, [
    'TELEGRAM_ID', 'IS_SYSTEM_ADMIN', 'TIER', 'QUEUE',
    // Appended, never inserted: existing rows keep their column positions and
    // createSheetWithHeaders_ simply extends the header row. Inserting NAME at
    // position 2 would have written it over live IS_SYSTEM_ADMIN data.
    'NAME', 'ACTIVE', 'ADDED_BY', 'ADDED_AT'
  ]);
```

- [ ] **Step 2: Add lifecycle helpers to `AdminCommands.gs`**

Replace `findAdminRow_` and add the rest below it:

```javascript
/** Every ADMINS row, active or not. Use for management commands. */
function findAnyAdminRow_(chatId) {
  return getAllAdminRows_().find(r => String(r.TELEGRAM_ID) === String(chatId)) || null;
}

// ACTIVE is blank on every row that predates this column, so blank must mean
// active — otherwise deploying this task would lock out every existing admin.
function isActiveAdminRow_(row) {
  return !!row && String(row.ACTIVE === undefined || row.ACTIVE === null ? '' : row.ACTIVE)
    .trim().toUpperCase() !== 'FALSE';
}

/** The authorization lookup: a deactivated admin is not an admin. */
function findAdminRow_(chatId) {
  const row = findAnyAdminRow_(chatId);
  return isActiveAdminRow_(row) ? row : null;
}

function countActiveSystemAdmins_() {
  return getAllAdminRows_().filter(r => isActiveAdminRow_(r) && isSystemAdminRow_(r)).length;
}

/** Write one named column on one ADMINS row, by header name rather than index. */
function setAdminField_(rowNumber, columnName, value) {
  const sheet = getAdminsSheet_();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const col = headers.indexOf(columnName);
  if (col === -1) throw new Error('setAdminField_: ADMINS has no ' + columnName + ' column — re-run createAllSheets().');
  sheet.getRange(rowNumber, col + 1).setValue(value);
}
```

- [ ] **Step 3: Record provenance on new admin rows**

Replace `upsertAdminRow_`:

```javascript
// Header-based rather than positional: the sheet now has eight columns and a
// getRange(row, 1, 1, 4) write would silently stop covering the new ones.
function upsertAdminRow_(targetId, isSystem, tier, queue, addedBy, name) {
  const sheet = getAdminsSheet_();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const existing = findAnyAdminRow_(targetId);
  const values = {
    TELEGRAM_ID: targetId,
    IS_SYSTEM_ADMIN: isSystem,
    TIER: tier,
    QUEUE: queue,
    NAME: name || '',
    ACTIVE: 'TRUE',
    ADDED_BY: String(addedBy || ''),
    ADDED_AT: new Date()
  };
  const rowNumber = existing ? existing._rowNumber : sheet.getLastRow() + 1;
  headers.forEach((h, i) => {
    if (h in values) sheet.getRange(rowNumber, i + 1).setValue(values[h]);
  });
}
```

Update the call in `handleAddAdmin_` (Task 0.2) to pass the new arguments:

```javascript
  const name = parts.slice(4).join(' ');
  upsertAdminRow_(targetId, isSystem, tier, queue, chatId, name);
```

and extend its usage string to
`'/add_admin <telegram_id> [tier] [queue] [true|false] [name]'`.

- [ ] **Step 4: Add `/admins`**

```javascript
function handleListAdmins_(chatId, adminRow) {
  if (!isSystemAdminRow_(adminRow)) {
    denyAdminAction_(chatId, adminRow, '/admins', 'Only a System Admin can list admins.');
    return;
  }
  const rows = getAllAdminRows_();
  if (!rows.length) { sendMessage(chatId, 'No admins on file.'); return; }
  const lines = rows.map(r => {
    const flags = [];
    if (isSystemAdminRow_(r)) flags.push('SYSTEM');
    if (!isActiveAdminRow_(r)) flags.push('DEACTIVATED');
    return r.TELEGRAM_ID + (r.NAME ? ' — ' + r.NAME : '') +
      ' — tier=' + (r.TIER || 'None') + ' queue=' + (r.QUEUE || 'None') +
      (flags.length ? ' [' + flags.join(', ') + ']' : '') +
      (r.ADDED_BY ? '\n    added by ' + r.ADDED_BY + (r.ADDED_AT ? ' on ' + r.ADDED_AT : '') : '');
  });
  sendMessage(chatId, 'Admins (' + rows.length + '):\n' + lines.join('\n') +
    '\n\nActive System Admins: ' + countActiveSystemAdmins_());
}
```

- [ ] **Step 5: Add `/remove_admin`**

```javascript
// Deactivates, never deletes. Deleting the row destroys the identity mapping
// that makes every historical MESSAGES row readable — "who was 483920184?"
// becomes unanswerable the moment the row is gone.
function handleRemoveAdmin_(chatId, adminRow, rest) {
  if (!isSystemAdminRow_(adminRow)) {
    denyAdminAction_(chatId, adminRow, '/remove_admin', 'Only a System Admin can run /remove_admin.');
    return;
  }
  const targetId = rest.trim().split(/\s+/)[0];
  if (!targetId) { sendMessage(chatId, 'Usage: /remove_admin <telegram_id>'); return; }
  if (String(targetId) === String(chatId)) {
    sendMessage(chatId, 'You cannot deactivate your own access. Ask another System Admin to do it.');
    return;
  }
  const target = findAnyAdminRow_(targetId);
  if (!target) { sendMessage(chatId, 'No admin found with Telegram ID ' + targetId + '.'); return; }
  if (!isActiveAdminRow_(target)) { sendMessage(chatId, targetId + ' is already deactivated.'); return; }
  if (isSystemAdminRow_(target) && countActiveSystemAdmins_() <= 1) {
    sendMessage(chatId, 'Refusing: ' + targetId + ' is the last active System Admin. ' +
      'Add another System Admin first, or nobody will be able to administer the bot.');
    return;
  }
  setAdminField_(target._rowNumber, 'ACTIVE', 'FALSE');
  logInteraction(chatId, 'ADMIN_DEACTIVATED', String(targetId));
  sendMessage(chatId, 'Admin ' + targetId + ' deactivated. Their history is preserved — ' +
    'set ACTIVE back to TRUE in the ADMINS tab to restore them.');
  const notice = sendMessage(targetId, 'Your MoPSE Support Bot admin access has been deactivated.');
  if (!notice.ok) console.error('handleRemoveAdmin_: could not notify ' + targetId);
}
```

- [ ] **Step 6: Register both commands**

In `ADMIN_COMMAND_NAMES_` add `'/admins'` and `'/remove_admin'`, and in the
`routeAdminCommand_` switch:

```javascript
    case '/admins': handleListAdmins_(chatId, adminRow); break;
    case '/remove_admin': handleRemoveAdmin_(chatId, adminRow, rest); break;
```

- [ ] **Step 7: Exclude deactivated admins from case notifications**

Task 1.1's `notifyAdminsOfNewCase_` filters on category only, because `ACTIVE`
did not exist when it was written. Add the filter now, or a deactivated admin
keeps receiving new-case alerts:

```javascript
    const recipients = getAllAdminRows_()
      .filter(r => String(r.TELEGRAM_ID || '').trim())
      .filter(r => isActiveAdminRow_(r))
      .filter(r => adminCanActOnCategory_(r, category));
```

- [ ] **Step 7b: Keep reactivation possible**

Redefining `findAdminRow_` to skip deactivated rows creates a dead end that no
command can escape: `/set_role` looks the target up with `findAdminRow_`
(`AdminCommands.gs:661`) and so reports *"No admin found… Use /add_admin first"*,
while Task 0.2's `/add_admin` refuses because `findAnyAdminRow_` **does** find
them. A deactivated admin then becomes un-restorable by any command, and the only
route back is a hand edit of the ADMINS sheet — which Task 5.2 later reports as a
security event. Point `handleSetRole_`'s lookup at the lifecycle-aware helper:

```javascript
  // findAnyAdminRow_, not findAdminRow_: a deactivated admin must still be
  // addressable by management commands, or /remove_admin becomes irreversible
  // from inside the bot. Authorization of the CALLER is unaffected — that is
  // routeAdminCommand_'s findAdminRow_ lookup, which correctly excludes them.
  const existing = findAnyAdminRow_(targetId);
```

and have `/set_role` reactivate as it goes, so there is one obvious way back:

```javascript
  if (!isActiveAdminRow_(existing)) {
    setAdminField_(existing._rowNumber, 'ACTIVE', 'TRUE');
    logInteraction(chatId, 'ADMIN_REACTIVATED', String(targetId));
  }
```

Then amend `/remove_admin`'s confirmation message — it currently offers only the
sheet edit:

```javascript
  sendMessage(chatId, 'Admin ' + targetId + ' deactivated. Their history is preserved — ' +
    'use /set_role ' + targetId + ' <tier> <queue> to restore them.');
```

- [ ] **Step 8: Notify on role change**

At the end of `handleSetRole_`, after the existing `sendMessage`:

```javascript
  const notice = sendMessage(targetId, 'Your MoPSE Support Bot permissions changed: tier=' + tier + ', queue=' + queue + '.');
  if (!notice.ok) console.error('handleSetRole_: could not notify ' + targetId + ' of their role change.');
```

- [ ] **Step 9: Migrate and verify**

Run `createAllSheets` from the editor. Expected: ADMINS gains `NAME`, `ACTIVE`,
`ADDED_BY`, `ADDED_AT` with existing rows untouched. Then:

- `/admins` → lists every admin with flags and provenance
- `/remove_admin <your_own_id>` → refused
- `/remove_admin <the only System Admin>` → refused with the last-admin message
- `/remove_admin <a non-system admin>` → deactivated; that person's `/cases` now
  returns *"You are not registered as an admin."*
- `/set_role <that same id> None All` → **restores** them (Step 7b); confirm
  their `/cases` works again and `/admins` no longer shows `[DEACTIVATED]`

- [ ] **Step 10: Commit**

```bash
git add SetupSheets.gs AdminCommands.gs && git commit -m "feat: ADMINS identity, provenance, deactivation, /admins and /remove_admin"
```

**Docs to update:** `BOT-SPEC.md` §4.5 and §6.5 (now 18 commands);
`RUNBOOK.md` §4.5 and §4.9; `CONCERNS-AND-IT-ACTIONS.md` A4 and A8.

---

### Task 1.4: Authorization hygiene

Three small correctness and consistency problems: `IS_SYSTEM_ADMIN` accepts only
`TRUE`/`true`, so an operator typing `Yes` gets silently no access;
`checkPermission` re-reads the whole ADMINS sheet despite every caller already
holding the row; and its `requiredQueue` parameter is `null` at all three call
sites — dead authorization code that reads as if it protects something.

**Files:**
- Modify: `AdminCommands.gs:105-121`, `:474`, `:561`, `:681`

- [ ] **Step 1: Accept the spellings an operator will actually type**

```javascript
// A Sheets checkbox yields boolean true; a typed cell yields a string. An
// operator following the runbook types TRUE, but Yes/Y/1 are the natural
// alternatives and previously granted nothing, silently, with no error anywhere.
const TRUTHY_CELL_VALUES_ = ['TRUE', 'YES', 'Y', '1'];

function isSystemAdminRow_(row) {
  if (!row) return false;
  if (row.IS_SYSTEM_ADMIN === true) return true;
  return TRUTHY_CELL_VALUES_.indexOf(
    String(row.IS_SYSTEM_ADMIN).trim().toUpperCase()) !== -1;
}
```

- [ ] **Step 2: Replace `checkPermission` with a row-based tier check**

```javascript
/**
 * Tier gate for commands that are not about one specific case. Takes the admin
 * row the caller already holds rather than re-reading the whole ADMINS sheet —
 * two reads in one command could disagree, and it was a wasted round-trip.
 *
 * The old signature had a `requiredQueue` third parameter that every one of its
 * three call sites passed as null. Dead authorization code is the worst kind to
 * keep: it reads as though something is being enforced. Queue scoping is, and
 * always was, adminCanActOnCategory_'s job.
 *
 * NOTE: tier is an exact match, not a rank — Program does not imply Regional.
 * See UPGRADE-PLAN.md Task 5.3 for the ordered-role replacement.
 */
function adminHasTier_(adminRow, requiredTier) {
  if (!adminRow) return false;
  if (isSystemAdminRow_(adminRow)) return true;
  return String(adminRow.TIER).trim() === requiredTier;
}
```

- [ ] **Step 3: Update the three call sites**

```javascript
  if (!adminHasTier_(adminRow, ADMIN_TIER.PROGRAM)) {      // handleExport_
  if (!adminHasTier_(adminRow, ADMIN_TIER.PROGRAM)) {      // handleAnnounce_
  if (!adminHasTier_(adminRow, ADMIN_TIER.REGIONAL)) {     // handleGenerateUrgentCode_
```

Delete the old `checkPermission` function.

- [ ] **Step 4: Make `/whoami` say what the person can do**

```javascript
function handleWhoAmI_(chatId, adminRow) {
  const can = [];
  if (isSystemAdminRow_(adminRow)) {
    can.push('Everything — you are a System Admin');
  } else {
    can.push('View and work cases in queue: ' + (adminRow.QUEUE || 'None'));
    if (adminHasTier_(adminRow, ADMIN_TIER.PROGRAM)) can.push('/announce and /export');
    if (adminHasTier_(adminRow, ADMIN_TIER.REGIONAL)) can.push('/generate_urgent_code');
  }
  sendMessage(chatId, [
    'Telegram ID: ' + adminRow.TELEGRAM_ID,
    (adminRow.NAME ? 'Name: ' + adminRow.NAME : null),
    'System Admin: ' + (isSystemAdminRow_(adminRow) ? 'Yes' : 'No'),
    'Tier: ' + (adminRow.TIER || 'None'),
    'Queue: ' + (adminRow.QUEUE || 'None'),
    '',
    'You can:',
    can.map(c => ' • ' + c).join('\n')
  ].filter(l => l !== null).join('\n'));
}
```

- [ ] **Step 5: Deploy and verify**

Set an admin's `IS_SYSTEM_ADMIN` to `Yes`. Expected: `/whoami` reports
*"System Admin: Yes"*. Then as a Regional admin run `/whoami` and confirm the
"You can" block names `/generate_urgent_code` but not `/export`.

- [ ] **Step 6: Commit**

```bash
git add AdminCommands.gs && git commit -m "refactor: row-based tier check, truthy parsing, informative /whoami"
```

**Docs to update:** `BOT-SPEC.md` §6.1 — `IS_SYSTEM_ADMIN` now accepts
`TRUE`/`YES`/`Y`/`1` and a Sheets checkbox, not `TRUE` alone; §6.5 — the
`/whoami` row now reports capabilities, not just fields. `RUNBOOK.md` §4.5 —
Step 9's instruction to type exactly `TRUE` can be relaxed, and §4.9's `/whoami`
description. Note that `checkPermission` is deleted: if any doc names it, it is
now `adminHasTier_`.

---

# PHASE 2 — Identity hardening

**Effort:** ~half a day. Can ship in launch week 1 rather than pre-launch.

---

### Task 2.1: Detect duplicate identity bindings

`ROSTER.IDENTIFIER` is a teacher's email address, and colleagues know each
other's emails. `bindUser_` looks up by `chat_id`, so **two different Telegram
accounts can both bind to the same roster identifier** and both read as
`VERIFIED`. Nothing detects it, nothing alerts the real teacher, and no admin
view exists.

This task does not fix impersonation — only per-person one-time codes do that
(see "Deferred decisions"). It makes impersonation **visible**.

**Files:**
- Modify: `UserSession.gs:231-258` (`bindUser_`)
- Modify: `UserSession.gs:191-229` (`attemptVerify_`)

> ⚠️ **Read this before writing any code.** `bindUser_` is called from
> `attemptVerify_` at line 202 — **inside its `LockService` critical section**,
> before `lock.releaseLock()`. So `bindUser_` must not log and must not send.
> `logInteraction` takes the same script lock, and [Logger.gs:29-33](Logger.gs:29)
> names this exact call path as a bug that was already found and fixed:
> *"never call this from inside another LockService critical section… the inner
> releaseLock() would drop the outer caller's protection early. UserSession.gs's
> attemptVerify_ used to do exactly that and now logs outside its lock instead."*
> Sending one Telegram message per System Admin plus one per prior holder while
> holding a **global** mutex is the second half of the same mistake.
>
> `bindUser_` therefore only *detects*. `attemptVerify_` *reports*, after the
> lock is released. This is the same split the file already uses for
> `VERIFY_FAILED` and `USER_VERIFIED`.

- [ ] **Step 1: Detect prior holders inside `bindUser_`, and return them**

```javascript
/**
 * @returns {string[]} chat IDs that were ALREADY verified against this
 *   identifier before this call. The caller reports them once it is outside
 *   the lock — see attemptVerify_. This function must stay silent: it runs
 *   inside a LockService critical section (Logger.gs's warning applies).
 */
function bindUser_(chatId, rosterRow) {
  const sheet = getUsersSheet_();
  const existing = findUserRow_(chatId);

  // Identity here is "types a string that appears in ROSTER", and that string is
  // an email address colleagues routinely know. Two chats binding to one roster
  // identifier is therefore a plausible impersonation, not a freak event — and
  // it was previously invisible to everyone including the real teacher.
  // Read BEFORE the write below, so this chat's own row is never in the result.
  const otherHolders = findOtherChatsForIdentifier_(rosterRow.IDENTIFIER, chatId);

  const now = new Date();
  const rowValues = [
    chatId,
    (existing && existing.LANGUAGE) || 'EN',
    (existing && existing.FIRST_SEEN) || now,
    now,
    VERIFICATION_STATE.VERIFIED,
    rosterRow.IDENTIFIER || '',
    rosterRow.NAME || '',
    rosterRow.REGION || ''
  ];
  if (existing) {
    sheet.getRange(existing._rowNumber, 1, 1, rowValues.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }
  try {
    CacheService.getScriptCache().put(verifiedCacheKey_(chatId), '1', VERIFIED_CACHE_TTL_SECONDS_);
  } catch (err) {
    console.error('bindUser_ cache write failed (harmless): ' + err);
  }

  return otherHolders;
}
```

- [ ] **Step 1b: Report from `attemptVerify_`, outside the lock**

Capture the return value inside the `try`, then act on it after
`lock.releaseLock()` has run — alongside the existing `logInteraction` calls,
which are already there for precisely this reason:

```javascript
  let rosterRow = null;
  let bindError = null;
  let duplicateHolders = [];
  try {
    rosterRow = findRosterRowByIdentifier_(identifierText);
    if (rosterRow) duplicateHolders = bindUser_(chatId, rosterRow) || [];
  } catch (err) {
    bindError = err;
    console.error('attemptVerify_ failed for chat ' + chatId + ': ' + err);
  } finally {
    lock.releaseLock();
  }

  // ... existing bindError / !rosterRow branches are unchanged ...

  logInteraction(chatId, 'USER_VERIFIED', '');
  // Tolerant of failure: a missed alert must never block a legitimate teacher
  // from verifying, and by this point the binding has already been committed.
  if (duplicateHolders.length) {
    try {
      reportDuplicateIdentityBinding_(chatId, rosterRow, duplicateHolders);
    } catch (err) {
      console.error('attemptVerify_: duplicate-binding alert failed: ' + err);
    }
  }
  sendMessage(chatId, 'Thanks, ' + (rosterRow.NAME || 'there') + ' — you are verified.');
  return 'VERIFIED';
```

/** Chat IDs already verified against this identifier, excluding `exceptChatId`. */
function findOtherChatsForIdentifier_(identifier, exceptChatId) {
  const needle = String(identifier || '').trim().toLowerCase();
  if (!needle) return [];
  const values = getUsersSheet_().getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values.shift();
  const idIdx = headers.indexOf('IDENTIFIER');
  const chatIdx = headers.indexOf('CHAT_ID');
  const stateIdx = headers.indexOf('VERIFICATION_STATE');
  if (idIdx === -1 || chatIdx === -1) return [];
  return values
    .filter(r => String(r[idIdx]).trim().toLowerCase() === needle)
    .filter(r => String(r[chatIdx]) !== String(exceptChatId))
    .filter(r => stateIdx === -1 || r[stateIdx] === VERIFICATION_STATE.VERIFIED)
    .map(r => String(r[chatIdx]));
}

/**
 * Tells the System Admins, and tells the chat that already held this identity.
 * Deliberately does NOT block the new binding: a teacher legitimately switching
 * phones produces exactly this signal, and locking them out would be worse than
 * a false alarm a human can dismiss.
 */
function reportDuplicateIdentityBinding_(chatId, rosterRow, otherHolders) {
  logInteraction(chatId, 'IDENTITY_DUPLICATE_BINDING',
    'identifier ' + redactIdentifier_(rosterRow.IDENTIFIER) + ' also held by ' + otherHolders.join(', '));

  const adminText = [
    '⚠️ Duplicate identity binding',
    'Roster name: ' + (rosterRow.NAME || '(unknown)'),
    'Identifier: ' + redactIdentifier_(rosterRow.IDENTIFIER),
    'New chat: ' + chatId,
    'Already verified: ' + otherHolders.join(', '),
    '',
    'This is a new phone, or an impersonation. Confirm with the teacher before acting.'
  ].join('\n');

  getAllAdminRows_()
    .filter(r => isActiveAdminRow_(r) && isSystemAdminRow_(r))
    .forEach(r => sendMessage(r.TELEGRAM_ID, adminText));

  otherHolders.forEach(other => {
    sendMessage(other, 'Security notice: another Telegram account has just verified using your ' +
      'MoPSE identifier. If this was you on a new phone, no action is needed. If it was not, ' +
      'contact ' + SUPPORT_CONTACT_INFO + ' immediately.');
  });
}
```

- [ ] **Step 2: Deploy and verify**

Verify a roster identifier from Telegram account A, then verify the **same**
identifier from account B. Expected: B verifies successfully; every System Admin
receives the ⚠️ alert; account A receives the security notice; MESSAGES gains an
`IDENTITY_DUPLICATE_BINDING` row with the identifier **redacted**.

- [ ] **Step 3: Verify the lock discipline held**

The failure mode this task's ⚠️ note guards against is silent, so check it
directly. In **Executions → View logs** for the run above, confirm there is no
`logInteraction: could not acquire lock` line, and confirm the
`IDENTITY_DUPLICATE_BINDING` row actually reached MESSAGES rather than being
dropped. Then verify a **fresh** identifier from a third account and confirm its
ordinary `USER_VERIFIED` row still lands — a dropped log row there is the tell
that reporting has crept back inside the lock.

- [ ] **Step 4: Commit**

```bash
git add UserSession.gs && git commit -m "feat: detect and report duplicate identity bindings"
```

**Docs to update:** `BOT-SPEC.md` §5 and §13; `CONCERNS-AND-IT-ACTIONS.md` B7 —
downgrade from "accepted, invisible" to "accepted, detected".

---

### Task 2.2: Privacy notice and data-subject route

Proposal §7 requires *"a privacy notice before collecting data."* What exists is
one sentence inside `startVerification_`. There is no stated retention period
(`RETENTION_DAYS` unset means indefinite) and no way for a teacher to ask what is
held or have it removed — for a ministry processing international workers' data,
some of it EU-resident.

**Files:**
- Modify: `UserSession.gs:163-168` (`startVerification_`)
- Modify: `MenuHandler.gs` (`teacherHelpText_`)
- Modify: `Webhook.gs:158+` (`routeUpdate_` — add `/privacy`)
- Modify: `Config.gs` (add the notice text)

- [ ] **Step 1: Put the notice in `Config.gs` where non-developers can edit it**

Append below `SUPPORT_CONTACT_INFO`:

```javascript
// ---- MANUAL REVIEW REQUIRED before go-live ----
// Proposal §7 requires a privacy notice before data collection. This text is
// shown at verification and via /privacy. It must be reviewed by whoever is
// accountable for MoPSE's data handling — the wording below is a starting
// point written by an engineer, not legal advice.
const PRIVACY_NOTICE_TEXT = [
  'How we use your information',
  '',
  'We store: your Telegram chat ID, the identifier you verify with, and your name and region as they appear on the official teacher roster.',
  'We also store the text of support cases you open, and a log of your interactions with this bot.',
  '',
  'We use this only to confirm you are an enrolled teacher, to answer your questions, and to track your support cases.',
  'It is visible to authorised MoPSE support staff. It is not shared with anyone else and is never sold.',
  '',
  'To ask what we hold about you, or to have it removed, contact ' + SUPPORT_CONTACT_INFO + '.'
].join('\n');
```

- [ ] **Step 2: Show it before collecting the identifier**

```javascript
function startVerification_(chatId) {
  sendMessage(chatId,
    'Welcome to the MoPSE Teacher Support Bot. To open a case or check an existing one, please reply with ' +
    'the email address or one-time code from your offer/contract paperwork so we can verify you.\n\n' +
    PRIVACY_NOTICE_TEXT + '\n\n' +
    'Replying with your identifier confirms you have read this. Type /privacy at any time to see it again.');
}
```

- [ ] **Step 3: Add the `/privacy` command**

In `Webhook.gs`'s `routeUpdate_`, immediately after the `/help` branch:

```javascript
    // Its own branch, not routed through AdminCommands.gs's dispatcher, for the
    // same reason /help is: routeAdminCommand_ rejects any non-admin outright,
    // which would turn a teacher's privacy request into an admin rejection.
    if (text === '/privacy') {
      logInteraction(chatId, 'PRIVACY_NOTICE_REQUESTED', '');
      sendMessage(chatId, PRIVACY_NOTICE_TEXT, { reply_markup: mainMenuKeyboard_() });
      return;
    }
```

- [ ] **Step 4: List it in teacher help**

Task 0.3 already converted `teacherHelpText_` from a fixed array into sequential
`lines.push()` calls, so insert this **between the Urgent Case push and the
Change Language push**, keeping Change Language last:

```javascript
  lines.push('/privacy — what information we hold about you and how to have it removed');
```

- [ ] **Step 5: Deploy and verify**

`/privacy` from a teacher account returns the notice plus the menu. Tapping
**Check My Case** while unverified shows the notice before asking for the
identifier.

- [ ] **Step 6: Commit**

```bash
git add Config.gs UserSession.gs Webhook.gs MenuHandler.gs && git commit -m "feat: privacy notice at verification and /privacy command"
```

**Docs to update:** `BOT-SPEC.md` §5.2 (privacy — the notice is now shown before
collection and is retrievable on demand) and §6.5, whose preamble says "`/help` is
deliberately **not** in this list"; `/privacy` is the second such teacher-facing
command handled in `Webhook.gs` ahead of the admin dispatcher, so say so there.
`RUNBOOK.md` §1.3 (what teachers can do on day one) and §4.9.

**Blocking decision for the head of project:** the notice text must be reviewed,
and `RETENTION_DAYS` must be set (`RUNBOOK.md` Step 13). Until it is set, data is
retained indefinitely, which contradicts the notice's implication that it is not.
`CONCERNS-AND-IT-ACTIONS.md` B2 makes the same point from the performance side —
one decision closes both.

---

# PHASE 3 — The keystone: make cases routable

**Effort:** ~1 day. **Nothing in Phases 4–5 is meaningful until this lands.**

---

### Task 3.1: Ask what the case is about, and file it under that topic

Every case files under `Contact Support` or `Submit Documents`, both of which
`queueForCategory_` maps to `All`. So an admin whose queue is Visa, Contract,
Travel, Accommodation, Recruitment or Technical **can see and act on zero cases**.
Six of eight queue values are decorative and delegation is impossible.

The plumbing already exists on both sides — `CATEGORIES` has the topic values,
and `casePrefixForCategory_` and `queueForCategory_` both already handle them.
What is missing is that Contact Support never asks.

**Files:**
- Modify: `MenuHandler.gs:257-260` (`handleContactSupportStart_`), `:288-331`, `:407-455`
- Modify: `AdminCommands.gs:125-132` (`queueForCategory_`)

- [ ] **Step 1: Replace `handleContactSupportStart_` with a topic picker**

```javascript
// Categories a case can be filed under. The four FAQ topics that have a matching
// ADMIN_QUEUE, plus a general fallback — deliberately not all eleven FAQ topics,
// because the seven newer ones have no queue to route to (see Task 3.3).
function caseTopicChoices_() {
  return [
    { key: 'VISA', label: CATEGORIES.VISA, emoji: '🛂' },
    { key: 'TRAVEL', label: CATEGORIES.TRAVEL, emoji: '✈️' },
    { key: 'CONTRACT', label: CATEGORIES.CONTRACT, emoji: '📝' },
    { key: 'ACCOMMODATION', label: CATEGORIES.ACCOMMODATION, emoji: '🏠' },
    { key: 'OTHER', label: CATEGORIES.CONTACT_SUPPORT, emoji: '💬' }
  ];
}

function caseTopicByKey_(key) {
  return caseTopicChoices_().filter(t => t.key === key)[0] || null;
}

// One extra tap buys queue-based routing for the whole system: without it every
// case files under one generic category, which maps to the All queue, which
// means no admin can ever be given a narrower scope than "everything".
function handleContactSupportStart_(chatId) {
  const rows = caseTopicChoices_().map(t => [{
    text: t.emoji + ' ' + (t.key === 'OTHER' ? 'Something else' : t.label),
    callback_data: 'CASETOPIC:' + t.key
  }]);
  rows.push([{ text: '🏠 Main Menu', callback_data: 'MENU:MAIN' }]);
  sendMessage(chatId, 'What is your question about? This makes sure the right team sees it.',
    { reply_markup: { inline_keyboard: rows } });
}
```

- [ ] **Step 2: Route the new callback**

In `handleMenuCallback_`, before the `DOC:` branch:

```javascript
  if (data.indexOf('CASETOPIC:') === 0) {
    const topic = caseTopicByKey_(data.substring(10));
    if (!topic) { showMainMenu(chatId); return; }
    // Re-gated: verification and maintenance were checked when Contact Support
    // was tapped, but the teacher may have sat on this keyboard for a while.
    if (isMaintenanceMode_()) {
      sendMessage(chatId, 'Submissions are temporarily paused for maintenance. FAQ browsing is still available — please try again later.', backToMenuKeyboard_());
      return;
    }
    if (!isVerified_(chatId)) {
      setChatState_(chatId, { mode: 'AWAITING_IDENTIFIER', pendingAction: 'CONTACT_SUPPORT' });
      startVerification_(chatId);
      return;
    }
    setChatState_(chatId, { mode: 'AWAITING_CASE_DETAIL', category: topic.label });
    sendMessage(chatId, 'Briefly describe your issue in one message and I will open a ' +
      topic.label + ' case for you.', backToMenuKeyboard_());
    return;
  }
```

- [ ] **Step 3: Carry the category through the state machine**

In `handleTextMessage_`:

```javascript
  if (state.mode === 'AWAITING_CASE_DETAIL') {
    const urgent = !!state.urgent;
    // Urgent Case has no topic picker — the teacher is already in an emergency
    // and one more tap is one too many — so it falls back to the generic
    // category, which routes to the All queue. That is the correct destination
    // for something urgent enough to warrant a code.
    const category = state.category || CATEGORIES.CONTACT_SUPPORT;
    clearChatState_(chatId);
    handleCaseDetailMessage_(chatId, text, urgent, category);
    return;
  }
```

- [ ] **Step 4: Use the category in `handleCaseDetailMessage_`**

Change the signature and the three places that hardcode `CONTACT_SUPPORT`:

```javascript
function handleCaseDetailMessage_(chatId, text, urgent, category) {
  category = category || CATEGORIES.CONTACT_SUPPORT;
  let result;
  try {
    result = createCase(chatId, category, (urgent ? '[URGENT] ' : '') + text);
  } catch (err) {
    console.error('handleCaseDetailMessage_ failed: ' + err);
    sendMessage(chatId, 'Something went wrong opening your case — please try again in a moment.', backToMenuKeyboard_());
    return;
  }

  if (result.isNew) {
    if (urgent) {
      try {
        updateCaseFields_(result.reference, { STATUS: CASE_STATUS.ESCALATED });
      } catch (err) {
        console.error('handleCaseDetailMessage_: escalation failed for ' + result.reference + ': ' + err);
      }
    }
    logInteraction(chatId, 'CASE_CREATED', result.reference);
    notifyAdminsOfNewCase_(result.reference, category, urgent);
    sendMessage(chatId,
      'Case opened' + (urgent ? ' and marked urgent' : '') + '. Your reference is ' + result.reference +
      '. Use Check My Case to see its status.', backToMenuKeyboard_());
    return;
  }

  if (urgent) {
    let escalated = false;
    try {
      escalated = escalateExistingCase_(result.reference, text);
    } catch (err) {
      console.error('handleCaseDetailMessage_: could not escalate existing ' + result.reference + ': ' + err);
    }
    logInteraction(chatId, escalated ? 'CASE_ESCALATED_EXISTING' : 'CASE_DUPLICATE_RETURNED', result.reference);
    if (escalated) notifyAdminsOfNewCase_(result.reference, category, true);
    sendMessage(chatId, escalated
      ? 'You already have an open case on this topic (' + result.reference + '), so I have added your urgent details to it and marked it urgent rather than opening a second case.'
      : 'You already have an open case on this topic: ' + result.reference + '. Please contact your Regional admin if it needs urgent attention.',
      backToMenuKeyboard_());
    return;
  }

  logInteraction(chatId, 'CASE_DUPLICATE_RETURNED', result.reference);
  sendMessage(chatId, 'You already have an open case on this topic: ' + result.reference + '. It has not been duplicated.', backToMenuKeyboard_());
}
```

- [ ] **Step 5: Deploy and verify routing**

As a verified teacher: **Contact Support** → **🛂 Visa** → describe an issue.
Expected: reference `VISA-2026-00001`, not `SUPPORT-…`.

Then set a second admin to `TIER=None, QUEUE=Visa` and confirm they can now run
`/cases` and see it — **this is the first time a queue-scoped admin has ever been
able to see any case.** Confirm an admin with `QUEUE=Contract` cannot.

- [ ] **Step 6: Verify dedup still scopes correctly**

Open a Visa case, then immediately open an Accommodation case. Expected: **two
distinct references** — dedup is per-category, so different topics no longer
collapse into one case the way they did when everything was `Contact Support`.

- [ ] **Step 7: Commit**

```bash
git add MenuHandler.gs && git commit -m "feat: file cases under their originating topic, activating queue routing"
```

**Docs to update:** `BOT-SPEC.md` §6.2 (delete the "queue scoping is effectively
disabled" caveat), §7.2, §7.3, §8.1, §8.3, §16; `RUNBOOK.md` Part 3 smoke test
and §6.2; `CONCERNS-AND-IT-ACTIONS.md`.

---

### Task 3.2: Give ADMINS a region and route on it

`ROSTER` and `USERS` both carry `REGION`, and `/announce <region>` targets
teachers by region — but `ADMINS` has no region column. Despite an entire tier
named **Regional**, a teacher's case cannot be routed to the admin responsible
for their region.

**Files:**
- Modify: `SetupSheets.gs:35-37`
- Modify: `AdminCommands.gs` (`adminCanActOnCategory_` → `adminCanSeeCase_`, and
  the Task 1.1 notifier's signature)
- Modify: `MenuHandler.gs` (two `notifyAdminsOfNewCase_` call sites from Task 1.1
  Step 2 / Task 3.1 Step 4)
- Modify: `Triggers.gs` (two `notifyAdminsOfNewCase_` call sites from Task 1.1
  Step 3)

- [ ] **Step 1: Add the column**

```javascript
  createSheetWithHeaders_(ss, SHEETS.ADMINS, [
    'TELEGRAM_ID', 'IS_SYSTEM_ADMIN', 'TIER', 'QUEUE',
    'NAME', 'ACTIVE', 'ADDED_BY', 'ADDED_AT', 'REGIONS'
  ]);
```

`REGIONS` is comma-separated, or `All`, or blank. **Blank means all regions**, so
every existing row keeps working unchanged.

- [ ] **Step 2: Add region matching and a combined visibility check**

```javascript
// Blank means "all regions" so that adding this column cannot narrow an existing
// admin's access as a side effect of deployment.
function adminCoversRegion_(adminRow, region) {
  const raw = String(adminRow.REGIONS === undefined || adminRow.REGIONS === null ? '' : adminRow.REGIONS).trim();
  if (!raw || raw.toUpperCase() === 'ALL') return true;
  if (!region) return true; // unknown teacher region — do not hide the case from anyone
  const wanted = String(region).trim().toLowerCase();
  return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).indexOf(wanted) !== -1;
}

/**
 * The teacher's region, from their USERS row. '' when the chat is a sentinel.
 *
 * MEMOIZED, and that is not an optimisation — it is a correctness requirement
 * for the execution limit. findUserRow_ reads the ENTIRE USERS sheet on every
 * call, and adminCanSeeCase_ below is used inside .filter() over case lists and
 * inside per-admin loops. Unmemoized, /cases with 50 open cases performs 50
 * whole-sheet reads, and Task 4.3's digest performs admins × cases of them —
 * which will hit the 6-minute ceiling long before the data does (CONCERNS B2).
 *
 * One map per execution is safe: an Apps Script execution handles a single
 * update, and a teacher's region cannot change inside one.
 */
let CASE_REGION_MEMO_ = null;

function caseRegionMap_() {
  if (CASE_REGION_MEMO_) return CASE_REGION_MEMO_;
  const map = {};
  try {
    const values = getUsersSheet_().getDataRange().getValues();
    if (values.length >= 2) {
      const headers = values.shift();
      const chatIdx = headers.indexOf('CHAT_ID');
      const regionIdx = headers.indexOf('REGION');
      if (chatIdx !== -1 && regionIdx !== -1) {
        values.forEach(r => { map[String(r[chatIdx])] = r[regionIdx] || ''; });
      }
    }
  } catch (err) {
    // An empty map means adminCoversRegion_ sees '' for every case, which it
    // treats as "unknown region — do not hide it from anyone". Failing open is
    // correct here: a sheet read error must not blank out every admin's queue.
    console.error('caseRegionMap_ failed, region scoping disabled this run: ' + err);
  }
  CASE_REGION_MEMO_ = map;
  return map;
}

function regionForCaseChatId_(chatId) {
  if (!chatId || String(chatId).indexOf('UNRESOLVED:') === 0) return '';
  const map = caseRegionMap_();
  return Object.prototype.hasOwnProperty.call(map, String(chatId)) ? map[String(chatId)] : '';
}

/**
 * The single visibility rule: queue AND region must both permit it. Replaces
 * bare adminCanActOnCategory_ at every case-facing call site so the two
 * dimensions can never be checked inconsistently.
 */
function adminCanSeeCase_(adminRow, caseRow) {
  if (isSystemAdminRow_(adminRow)) return true;
  if (!adminCanActOnCategory_(adminRow, caseRow.CATEGORY)) return false;
  return adminCoversRegion_(adminRow, regionForCaseChatId_(caseRow.CHAT_ID));
}
```

- [ ] **Step 3: Switch every case-facing check**

Replace `adminCanActOnCategory_(adminRow, c.CATEGORY)` with
`adminCanSeeCase_(adminRow, c)` in `handleCaseDetail_`, `handleReply_`,
`handleClose_`, `handleAssign_`, `handleNote_`, `handleReopen_`, and the
`.filter()` calls in `handleListCases_`, `handleUrgentList_`, `handleSearch_` and
`handleExport_` (pass the whole row, not just the category).

- [ ] **Step 4: Re-sign the Task 1.1 notifier to take the whole case row**

Region scoping needs the case's `CHAT_ID`, which a bare category does not carry.
Replace the head of `notifyAdminsOfNewCase_` — everything else in that function
is unchanged:

```javascript
// Signature changed in Task 3.2: was (reference, category, urgent). A category
// alone cannot answer "which region is this teacher in", so the whole row is
// passed now and reference/category are read off it.
function notifyAdminsOfNewCase_(caseRow, urgent) {
  try {
    if (!caseRow) { console.error('notifyAdminsOfNewCase_: called with no case row.'); return; }
    const reference = caseRow.REFERENCE;
    const category = caseRow.CATEGORY;

    const recipients = getAllAdminRows_()
      .filter(r => String(r.TELEGRAM_ID || '').trim())
      .filter(r => isActiveAdminRow_(r))
      .filter(r => adminCanSeeCase_(r, caseRow));
    // ... the rest of the function body is unchanged ...
```

- [ ] **Step 5: Update all four call sites**

Every caller currently passes a reference and a category. Each must now resolve
the row first. **`findCaseByReference_` reads the whole CASES sheet**, so do it
once and reuse it:

| File | Call site | Was | Becomes |
|---|---|---|---|
| `MenuHandler.gs` | `handleCaseDetailMessage_`, new-case branch | `notifyAdminsOfNewCase_(result.reference, category, urgent)` | `notifyAdminsOfNewCase_(findCaseByReference_(result.reference), urgent)` |
| `MenuHandler.gs` | `handleCaseDetailMessage_`, escalated-duplicate branch | `notifyAdminsOfNewCase_(result.reference, category, true)` | `notifyAdminsOfNewCase_(findCaseByReference_(result.reference), true)` |
| `Triggers.gs` | `fileDocumentSubmissionCase_`, verified path | `notifyAdminsOfNewCase_(result.reference, CATEGORIES.SUBMIT_DOCS, false)` | `notifyAdminsOfNewCase_(findCaseByReference_(result.reference), false)` |
| `Triggers.gs` | `fileDocumentSubmissionCase_`, unresolved path | `notifyAdminsOfNewCase_(unresolved.reference, CATEGORIES.SUBMIT_DOCS, false)` | `notifyAdminsOfNewCase_(findCaseByReference_(unresolved.reference), false)` |

The unresolved-submitter row's `CHAT_ID` is an `UNRESOLVED:` sentinel;
`regionForCaseChatId_` returns `''` for it and `adminCoversRegion_` treats `''`
as "do not hide from anyone", so those cases stay visible to every queue-matching
admin. That is the intended behaviour — an unresolved case has no region to scope
by and most needs a human to find it.

- [ ] **Step 6: Deploy and verify**

Run `createAllSheets`. Set an admin to `QUEUE=Visa, REGIONS=Tashkent`. Open a
Visa case as a teacher whose ROSTER region is `Samarkand`. Expected: that admin
does **not** see it in `/cases`; a `REGIONS=All` admin does. Repeat with a
Tashkent teacher and confirm the reverse.

Then confirm the memoization is doing its job: run `/cases all` with at least
twenty cases on file and check **Executions** shows a single-digit-second
runtime. A run that takes tens of seconds means `caseRegionMap_` is being rebuilt
per row — check that `CASE_REGION_MEMO_` is a file-level `let`, not declared
inside the function.

- [ ] **Step 7: Commit**

```bash
git add SetupSheets.gs AdminCommands.gs MenuHandler.gs Triggers.gs && git commit -m "feat: region-scoped case visibility for admins"
```

**Docs to update:** `BOT-SPEC.md` §4.5 (ADMINS gains `REGIONS`; blank means all)
and §6.2 (visibility is now queue **and** region); `RUNBOOK.md` §4.5 — adding
staff now involves a region decision, and §4.9's `/cases` row should say results
are region-scoped.

---

### Task 3.3: Map the seven newer FAQ topics to queues

`ADMIN_QUEUE` has no entry for Salary, Workload, Leave, Placement, Health,
Conduct or Living in Uzbekistan. They fall back to `All`.

**Corrected from v1.0 of this plan**, which said "Task 3.1 changes that
assumption". It does not: `caseTopicChoices_` deliberately offers only the four
topics that already have a queue, plus a general fallback, so no case can be
filed under any of the seven. These mappings are therefore **unreachable today**
and this task is pre-emptive, not corrective.

Do it anyway, and do it now, for one reason: the moment anyone adds a seventh
entry to `caseTopicChoices_` — the obvious, one-line, apparently safe change —
those cases silently route to `All` and every queue-scoped admin sees traffic
that is not theirs. Encoding the decision while the context is fresh costs
minutes; rediscovering it later costs an incident.

**Files:**
- Modify: `AdminCommands.gs:48-57` (`ADMIN_QUEUE`), `:125-132` (`queueForCategory_`)

- [ ] **Step 1: Decide, then encode the decision**

The recommendation is **not** to add seven more queues — that fragments a small
support team. Instead map them onto the existing ones and record why:

```javascript
// The seven FAQ topics added after the original four have no queue of their own
// on purpose: a support team of a handful of people does not want eleven
// queues. They are mapped onto the closest existing queue, and anything
// genuinely unmapped still defaults to All so a case is never hidden from
// everyone. Revisit only if a topic grows its own dedicated staff.
function queueForCategory_(category) {
  const map = {};
  map[CATEGORIES.VISA] = ADMIN_QUEUE.VISA;
  map[CATEGORIES.TRAVEL] = ADMIN_QUEUE.TRAVEL;
  map[CATEGORIES.CONTRACT] = ADMIN_QUEUE.CONTRACT;
  map[CATEGORIES.ACCOMMODATION] = ADMIN_QUEUE.ACCOMMODATION;
  map['Salary and Payment'] = ADMIN_QUEUE.CONTRACT;
  map['Workload and Hours'] = ADMIN_QUEUE.CONTRACT;
  map['Leave and Holidays'] = ADMIN_QUEUE.CONTRACT;
  map['Placement and School'] = ADMIN_QUEUE.RECRUITMENT;
  map['Health and Insurance'] = ADMIN_QUEUE.ACCOMMODATION;
  map['Conduct and Development'] = ADMIN_QUEUE.RECRUITMENT;
  map['Living in Uzbekistan'] = ADMIN_QUEUE.ACCOMMODATION;
  return map[category] || ADMIN_QUEUE.ALL;
}
```

- [ ] **Step 2: Commit**

```bash
git add AdminCommands.gs && git commit -m "feat: map the seven newer FAQ topics onto existing admin queues"
```

**Docs to update:** `RUNBOOK.md` §6.2 — this closes it; `BOT-SPEC.md` §16.

---

# PHASE 4 — Tasking

**Effort:** ~half a day. Depends on Phase 3.

---

### Task 4.1: Make `/assign` mean something

`/assign` writes `OWNER` and nothing reads it. It grants nothing, restricts
nothing, never notifies the assignee, accepts any string as a target, and there
is no `/mycases`. `findCasesBy_` already supports `filter.owner` — built and
unused.

**Files:**
- Modify: `AdminCommands.gs:412-423` (`handleAssign_`), `ADMIN_COMMAND_NAMES_`, `routeAdminCommand_`

- [ ] **Step 1: Validate and notify**

```javascript
function handleAssign_(chatId, adminRow, rest) {
  const parts = rest.trim().split(/\s+/).filter(Boolean);
  const reference = parts[0];
  const assigneeId = parts[1];
  if (!reference || !assigneeId) { sendMessage(chatId, 'Usage: /assign <reference> <telegram_id>'); return; }
  const c = findCaseByReference_(reference);
  if (!c) { sendMessage(chatId, 'No case found with reference ' + reference); return; }
  if (!adminCanSeeCase_(adminRow, c)) {
    denyAdminAction_(chatId, adminRow, '/assign', "You are not authorized for this case's queue.");
    return;
  }

  // Previously any string was accepted, so cases were routinely assigned to
  // typos and to people who are not admins — the case then looked handled and
  // nobody was working it.
  const assignee = findAdminRow_(assigneeId);
  if (!assignee) {
    sendMessage(chatId, assigneeId + ' is not an active admin. Use /admins to see the list.');
    return;
  }
  if (!adminCanSeeCase_(assignee, c)) {
    sendMessage(chatId, 'Refusing: ' + assigneeId + ' cannot see this case (queue=' +
      (assignee.QUEUE || 'None') + '). Assign it to someone in the right queue, or widen theirs with /set_role.');
    return;
  }

  if (!tryUpdateCaseFields_(chatId, reference, { OWNER: assigneeId })) return;
  logInteraction(chatId, 'CASE_ASSIGNED', reference + ' -> ' + assigneeId);
  sendMessage(chatId, 'Case ' + reference + ' assigned to ' + assigneeId +
    (assignee.NAME ? ' (' + assignee.NAME + ')' : '') + '.');

  const notice = sendMessage(assigneeId, '📋 Case ' + reference + ' has been assigned to you by ' +
    (adminRow.NAME || adminRow.TELEGRAM_ID) + '.\n\n/case ' + reference + ' — read it');
  if (!notice.ok) {
    sendMessage(chatId, 'Assigned, but ' + assigneeId + ' could not be notified (' +
      (notice.description || 'unknown error') + '). Tell them another way.');
  }
}
```

- [ ] **Step 2: Add `/mycases`**

```javascript
// findCasesBy_ has supported an owner filter since Phase 3 and no command ever
// used it, so an admin had no way to see their own workload.
function handleMyCases_(chatId, adminRow) {
  const rows = findCasesBy_({ owner: chatId, openOnly: true })
    .filter(r => adminCanSeeCase_(adminRow, r));
  if (!rows.length) { sendMessage(chatId, 'Nothing is assigned to you right now.'); return; }
  sendMessage(chatId, 'Assigned to you (' + rows.length + ' open):\n' + formatCaseList_(rows.slice(0, 20)));
}
```

- [ ] **Step 3: Add an `unassigned` filter to `/cases`**

In `handleListCases_`, after the `all` branch:

```javascript
  } else if (arg.toLowerCase() === 'unassigned') {
    // The intake backlog: open cases nobody has picked up. This is the view a
    // supervisor needs first thing in the morning and there was no way to get it.
    rows = findCasesBy_({ openOnly: true }).filter(r => !String(r.OWNER || '').trim());
    heading = 'Unassigned open cases';
  } else {
```

and extend the help text:

```javascript
function adminCommandsHelpText_() {
  return 'Admin commands:\n' + ADMIN_COMMAND_NAMES_.join('  ') +
    '\n\n/cases — open cases only. /cases all — every case. /cases unassigned — nobody has taken them. /cases <status> — one status.' +
    '\n/mycases — cases assigned to you.';
}
```

- [ ] **Step 4: Register `/mycases`**

Add `'/mycases'` to `ADMIN_COMMAND_NAMES_` and
`case '/mycases': handleMyCases_(chatId, adminRow); break;` to the switch.

- [ ] **Step 5: Deploy and verify**

`/assign SUPPORT-2026-00001 banana` → refused. `/assign <ref> <a real admin id>`
→ that admin receives a 📋 notification. `/mycases` from that admin lists it.
`/cases unassigned` no longer shows it.

- [ ] **Step 6: Commit**

```bash
git add AdminCommands.gs && git commit -m "feat: validated assignment, assignee notification, /mycases, /cases unassigned"
```

**Docs to update:** `BOT-SPEC.md` §6.5 — `/mycases` is a new command and
`/cases unassigned` a new form, so the heading is now **"All nineteen commands"**
(16 shipped + `/admins` + `/remove_admin` from Task 1.3 + `/mycases` here; `/help`
and `/privacy` are counted separately as teacher-facing). Also §7 — `OWNER` is no
longer decorative, so the statement that nothing reads it is wrong.
`RUNBOOK.md` §4.9 (full command list) and a new §4.10 on triaging the unassigned
backlog. `CONCERNS-AND-IT-ACTIONS.md` — nothing to change.

---

### Task 4.2: Record who changed each case

`/reply`, `/close`, `/reopen` and `/assign` leave no actor on the case row — only
`UPDATED_AT`. Reconstructing who closed a case means timestamp-correlating
against MESSAGES.

**Files:**
- Modify: `SetupSheets.gs:17-20` (CASES headers)
- Modify: `CaseManager.gs:219` (`CASE_UPDATABLE_FIELDS_`), `:248-279` (`updateCaseFields_`)
- Modify: `AdminCommands.gs` (`tryUpdateCaseFields_`)

- [ ] **Step 1: Append the column**

```javascript
  createSheetWithHeaders_(ss, SHEETS.CASES, [
    'REFERENCE', 'CATEGORY', 'CHAT_ID', 'STATUS', 'OWNER',
    'CREATED_AT', 'UPDATED_AT', 'DETAIL', 'PUBLIC_UPDATE',
    'LAST_ACTOR'   // appended, so existing appendRow positions are unaffected
  ]);
```

> **If `CASES_ARCHIVE` already exists, fix its header by hand.**
> `getOrCreateArchiveSheet_` (`ArchiveManager.gs:98-109`) copies the source
> header **only when it creates the tab**. An archive tab created before this
> change keeps its 9-column header, while `moveRowsToArchive_` will start writing
> 10-column rows into it — so `LAST_ACTOR` values land in an unlabelled column J.
> Nothing throws and no data is lost, but the archive stops being self-describing.
> Type `LAST_ACTOR` into `CASES_ARCHIVE!J1` after running `createAllSheets`.

- [ ] **Step 2: Let `updateCaseFields_` stamp it**

```javascript
const CASE_UPDATABLE_FIELDS_ = ['STATUS', 'OWNER', 'DETAIL', 'PUBLIC_UPDATE', 'LAST_ACTOR'];
```

and inside the write loop, immediately after the `UPDATED_AT` line:

```javascript
        sheet.getRange(rowNumber, headers.indexOf('UPDATED_AT') + 1).setValue(new Date());
        // Column is absent on a sheet that predates this change — skip rather
        // than throw, so an un-migrated deployment still works.
        const actorCol = headers.indexOf('LAST_ACTOR');
        if (actorCol !== -1 && fields.LAST_ACTOR === undefined && opts && opts.actor) {
          sheet.getRange(rowNumber, actorCol + 1).setValue(String(opts.actor));
        }
```

Change the signature to `updateCaseFields_(reference, fields, opts)`.

- [ ] **Step 3: Pass the actor from every admin mutation**

```javascript
function tryUpdateCaseFields_(chatId, reference, fields) {
  try {
    updateCaseFields_(reference, fields, { actor: chatId });
    return true;
  } catch (err) {
    console.error('tryUpdateCaseFields_ failed for ' + reference + ': ' + err);
    sendMessage(chatId, 'Could not update ' + reference + ' — the sheet was busy. ' +
      'Nothing has been changed; please try again in a moment.');
    return false;
  }
}
```

- [ ] **Step 4: Show it in `/case`**

Add to the `handleCaseDetail_` array, after `'Updated: '`:

```javascript
    'Last changed by: ' + (c.LAST_ACTOR || '(not recorded)'),
```

- [ ] **Step 5: Deploy and verify**

Run `createAllSheets`. `/close <ref> Resolved`, then `/case <ref>`. Expected:
*"Last changed by: &lt;your telegram id&gt;"*.

- [ ] **Step 6: Commit**

```bash
git add SetupSheets.gs CaseManager.gs AdminCommands.gs && git commit -m "feat: record LAST_ACTOR on every case mutation"
```

**Docs to update:** `BOT-SPEC.md` §4.2 (CASES gains `LAST_ACTOR`; blank on rows
that predate it) and §6.5's `/case` row (it now shows who last changed it).
`RUNBOOK.md` Step 5 — `createAllSheets` must be re-run, and §5.4's
data-corruption procedure gains a column to check. `CONCERNS-AND-IT-ACTIONS.md`
B6 — one more header whose name is a silent contract; add it to the list of tabs
worth protecting.

---

### Task 4.3: Push overdue cases instead of waiting to be asked

`OVERDUE_DAYS` only changes what `/urgent` prints when someone runs it. Nothing
pushes, so a case can sit untouched indefinitely.

**Files:**
- Modify: `Triggers.gs:29-43` (`installTriggers`), and add `runDailyDigest` as a
  new public-named handler beside `runArchive` — `runArchive` itself is not
  touched, but the trailing-underscore rule in that file's header applies to the
  new function too
- Modify: `AdminCommands.gs` (add `sendOverdueDigest_` beside `getOverdueDays_`)

- [ ] **Step 1: Add a daily digest**

```javascript
/**
 * The overdue list existed only as output from a command nobody was obliged to
 * run. This pushes it. Sent to each admin scoped to what they can actually see,
 * so it is a personal worklist rather than a wall of everyone's cases.
 */
function sendOverdueDigest_() {
  const overdueDays = getOverdueDays_();
  if (!overdueDays) {
    console.error('sendOverdueDigest_: no OVERDUE_DAYS in SETTINGS — skipping.');
    return;
  }
  const cutoff = new Date(Date.now() - overdueDays * 24 * 60 * 60 * 1000);
  const stale = findCasesBy_({ openOnly: true })
    .filter(r => r.UPDATED_AT && new Date(r.UPDATED_AT) < cutoff);
  if (!stale.length) return;

  getAllAdminRows_().filter(r => isActiveAdminRow_(r)).forEach(admin => {
    const mine = stale.filter(c => adminCanSeeCase_(admin, c));
    if (!mine.length) return;
    const unassigned = mine.filter(c => !String(c.OWNER || '').trim()).length;
    sendMessage(admin.TELEGRAM_ID, [
      '⏰ ' + mine.length + ' case(s) have had no update for over ' + overdueDays + ' days' +
        (unassigned ? ' — ' + unassigned + ' of them unassigned' : '') + ':',
      formatCaseList_(mine.slice(0, 20)),
      '',
      '/mycases — just yours · /cases unassigned — the backlog'
    ].join('\n'));
  });
}
```

- [ ] **Step 2: Install a daily trigger**

```javascript
function installTriggers() {
  removeExistingTriggers_(['handleSheetEdit', 'runArchive', 'handleSheetChange', 'runDailyDigest',
    'handleSheetEdit_', 'runArchive_']);
  const ss = getSpreadsheet();
  ScriptApp.newTrigger('handleSheetEdit').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('handleSheetChange').forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger('runArchive').timeBased().everyDays(14).create();
  // 07:00 local, so it lands before the working day rather than overnight.
  ScriptApp.newTrigger('runDailyDigest').timeBased().everyDays(1).atHour(7).create();
  Logger.log('onEdit, onChange, archive and daily-digest triggers installed. ' +
    'Run installFormSubmitTrigger(formId, docKey) separately once real Google Forms exist.');
}

function runDailyDigest() {
  try {
    sendOverdueDigest_();
  } catch (err) {
    console.error('runDailyDigest failed: ' + err);
  }
}
```

- [ ] **Step 3: Deploy and verify**

Set `OVERDUE_DAYS = 1` in SETTINGS, backdate a case's `UPDATED_AT` by two days,
run `runDailyDigest` by hand from the editor. Expected: the ⏰ digest arrives.
Restore `OVERDUE_DAYS`.

- [ ] **Step 4: Commit**

```bash
git add Triggers.gs AdminCommands.gs && git commit -m "feat: daily overdue-case digest pushed to each admin"
```

**Docs to update:** `RUNBOOK.md` Step 8 — `installTriggers` now creates four
triggers, and must be re-run.

---

# PHASE 5 — Governance

**Effort:** ~1 day. Post-launch is acceptable; before the roster passes ~200 is not.

---

### Task 5.1: Two-step `/announce`

`/announce ALL <message>` reaches every verified teacher immediately. No preview,
no confirmation, no recall. One typo goes to the whole cohort on behalf of a
Ministry. The proposal called this *"prepare broadcast"*, and the ANNOUNCEMENTS
sheet already has a `STATUS` column that supports a draft flow.

**Files:**
- Modify: `AdminCommands.gs:560-607` (`handleAnnounce_`)

- [ ] **Step 1: Split into draft and confirm**

```javascript
// Drafts live in Script Properties rather than a chat-state cache entry because
// they must survive the admin closing Telegram, and they are per-admin so two
// people preparing announcements cannot confirm each other's.
const ANNOUNCE_DRAFT_TTL_MS_ = 60 * 60 * 1000;

function announceDraftKey_(chatId) { return 'ANNOUNCE_DRAFT_' + chatId; }

function handleAnnounce_(chatId, adminRow, rest) {
  if (!adminHasTier_(adminRow, ADMIN_TIER.PROGRAM)) {
    denyAdminAction_(chatId, adminRow, '/announce', 'Only Program-tier admins can send announcements.');
    return;
  }
  const arg = (rest || '').trim();

  // Bare "confirm"/"cancel" only. A region genuinely named "Confirm" is absurd,
  // but "/announce cancel <message>" is a plausible typo-slip and must not be
  // swallowed as a control word — requiring no remainder keeps the two
  // vocabularies from overlapping at all.
  if (arg.toLowerCase() === 'confirm') { confirmAnnouncement_(chatId, adminRow); return; }
  if (arg.toLowerCase() === 'cancel') {
    PropertiesService.getScriptProperties().deleteProperty(announceDraftKey_(chatId));
    sendMessage(chatId, 'Draft announcement discarded.');
    return;
  }

  const spaceIdx = arg.indexOf(' ');
  const audience = spaceIdx === -1 ? arg : arg.slice(0, spaceIdx).trim();
  const content = spaceIdx === -1 ? '' : arg.slice(spaceIdx + 1).trim();
  if (!audience || !content) {
    sendMessage(chatId, 'Usage: /announce <ALL|region-name> <message>\nThen /announce confirm to send, or /announce cancel.');
    return;
  }

  const targets = getAnnouncementTargets_(audience);
  if (targets.length === 0) { sendMessage(chatId, 'No verified users match audience "' + audience + '".'); return; }

  PropertiesService.getScriptProperties().setProperty(announceDraftKey_(chatId), JSON.stringify({
    audience: audience, content: content, count: targets.length, createdAt: Date.now()
  }));
  // Logged at DRAFT time, not only at send time: an announcement that was
  // prepared and then abandoned is exactly the thing an audit trail should show,
  // and previously only completed sends left any trace.
  logInteraction(chatId, 'ANNOUNCEMENT_DRAFTED', audience + ' — ' + targets.length + ' recipients');

  sendMessage(chatId, [
    '📋 DRAFT — nothing has been sent yet.',
    '',
    'Audience: ' + audience + ' (' + targets.length + ' verified teachers)',
    '',
    '--- message preview ---',
    '📢 ' + content,
    '--- end of preview ---',
    '',
    'Check the wording, then send /announce confirm — or /announce cancel to discard.',
    'The draft expires in one hour.'
  ].join('\n'));
}

function confirmAnnouncement_(chatId, adminRow) {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(announceDraftKey_(chatId));
  if (!raw) { sendMessage(chatId, 'No draft to send. Start with /announce <ALL|region> <message>.'); return; }

  let draft;
  try {
    draft = JSON.parse(raw);
  } catch (err) {
    props.deleteProperty(announceDraftKey_(chatId));
    sendMessage(chatId, 'That draft was unreadable and has been discarded. Please start again.');
    return;
  }
  props.deleteProperty(announceDraftKey_(chatId));
  if (Date.now() - draft.createdAt > ANNOUNCE_DRAFT_TTL_MS_) {
    sendMessage(chatId, 'That draft has expired. Please start again.');
    return;
  }

  deliverAnnouncement_(chatId, draft.audience, draft.content);
}
```

- [ ] **Step 2: Move the existing send loop into `deliverAnnouncement_`**

Take the body of the old `handleAnnounce_` from `const id = 'ANN-' + Date.now();`
to the end, and wrap it unchanged as:

```javascript
function deliverAnnouncement_(chatId, audience, content) {
  const targets = getAnnouncementTargets_(audience);
  if (targets.length === 0) { sendMessage(chatId, 'No verified users match audience "' + audience + '" any more.'); return; }
  const id = 'ANN-' + Date.now();
  appendAnnouncementRow_(id, content, audience, 'SENDING', chatId);
  sendMessage(chatId, 'Sending to ' + targets.length + ' users… I will report back when finished.');

  const startedAt = Date.now();
  let sent = 0, failed = 0, notAttempted = 0;
  const failedIds = [];

  for (let i = 0; i < targets.length; i++) {
    if (Date.now() - startedAt > ANNOUNCE_MAX_RUNTIME_MS_) {
      notAttempted = targets.length - i;
      console.error('deliverAnnouncement_: stopping at ' + i + '/' + targets.length + ' to stay inside the Apps Script execution limit.');
      break;
    }
    const result = sendMessage(targets[i], '📢 ' + content);
    if (result.ok) { sent++; } else { failed++; if (failedIds.length < 20) failedIds.push(String(targets[i])); }
    if (i < targets.length - 1) Utilities.sleep(ANNOUNCE_SEND_DELAY_MS_);
  }

  const status = (failed === 0 && notAttempted === 0) ? 'SENT' : (sent === 0 ? 'FAILED' : 'PARTIAL');
  updateAnnouncementStatus_(id, status);
  logInteraction(chatId, 'ANNOUNCEMENT_' + status, id + ' sent=' + sent + ' failed=' + failed + ' skipped=' + notAttempted);

  let report = 'Announcement ' + id + ': ' + status + '.\nDelivered: ' + sent + '/' + targets.length;
  if (failed) report += '\nFailed: ' + failed + (failedIds.length ? ' (' + failedIds.join(', ') + (failed > failedIds.length ? ', …' : '') + ')' : '');
  if (notAttempted) report += '\nNot attempted (ran out of execution time): ' + notAttempted + '. Re-run for the remainder.';
  sendMessage(chatId, report);
}
```

- [ ] **Step 3: Deploy and verify**

`/announce ALL Test message` → a DRAFT preview and **nothing delivered**.
`/announce confirm` → delivery. `/announce ALL Another` then `/announce cancel`
→ *"discarded"*, and a subsequent `/announce confirm` says there is no draft.

- [ ] **Step 4: Commit**

```bash
git add AdminCommands.gs && git commit -m "feat: two-step /announce with preview and explicit confirmation"
```

**Docs to update:** `BOT-SPEC.md` §6.5; `RUNBOOK.md` §4.7.

---

### Task 5.2: Alert on ADMINS sheet edits

Anyone with edit access to the spreadsheet can grant themselves System Admin by
typing their Telegram ID into the ADMINS tab, and `handleSheetEdit` does not
watch that tab. The real access boundary is the Drive sharing list, not the
bot — which cannot be fixed inside Apps Script, but **can** be made noisy.

**Files:**
- Modify: `Triggers.gs:194-262` (`handleSheetEdit`)
- Modify: `AdminCommands.gs` (`upsertAdminRow_`, `setAdminField_` — suppression)

> ⚠️ **Without suppression this fires on the bot's own writes.** An *installable*
> onEdit trigger runs for programmatic `setValue()` calls — that is exactly why
> `CaseManager.gs` carries `onEditSuppressKey_` and why `notifyCaseRowEdited_`
> checks it. Task 1.3's `upsertAdminRow_` writes **one cell per header**, so a
> single `/add_admin` would send eight "🔐 the ADMINS sheet was edited directly"
> alerts to every System Admin, and `/set_role` and `/remove_admin` would each
> add their own. Admins would learn to ignore the alert within a day, which
> destroys the only thing this task is for. Do Step 0 first.

- [ ] **Step 0: Make the bot's own ADMINS writes quiet and atomic**

In `AdminCommands.gs`, add a suppression marker mirroring `CaseManager.gs`:

```javascript
// Same pattern and same reason as CaseManager.gs's onEditSuppressKey_: an
// installable onEdit trigger cannot tell a hand edit from a setValue(), and
// Task 5.2's alert is worthless if the bot's own commands set it off.
const ADMINS_EDIT_SUPPRESS_KEY_ = 'suppress_onedit_admins';
const ADMINS_EDIT_SUPPRESS_TTL_SECONDS_ = 60;

function suppressAdminsSheetAlert_() {
  try {
    CacheService.getScriptCache().put(ADMINS_EDIT_SUPPRESS_KEY_, '1', ADMINS_EDIT_SUPPRESS_TTL_SECONDS_);
  } catch (err) {
    console.error('suppressAdminsSheetAlert_ failed (an extra alert may fire): ' + err);
  }
}
```

Call `suppressAdminsSheetAlert_()` as the first line of `upsertAdminRow_`,
`setAdminTierQueue_` and `setAdminField_`. Then collapse `upsertAdminRow_`'s
per-column loop into **one** `setValues` write, so it is a single edit event
rather than eight:

```javascript
  const rowNumber = existing ? existing._rowNumber : sheet.getLastRow() + 1;
  // One write, not one per column: eight setValue calls are eight onEdit events,
  // eight revisions in the sheet's history, and eight chances to interleave with
  // another admin's write. Headers drive the order, so an added column is picked
  // up automatically and an unknown one is left untouched.
  const row = headers.map(h => (h in values) ? values[h] : (existing ? existing[h] : ''));
  sheet.getRange(rowNumber, 1, 1, headers.length).setValues([row]);
```

- [ ] **Step 1: Add an ADMINS branch**

Insert immediately after the `SHEETS.FAQ` branch:

```javascript
    // The bot's role model is subordinate to Google Drive sharing: anyone who
    // can edit this spreadsheet can make themselves a System Admin, and no code
    // here can stop them. It can make it loud, which is most of the value.
    if (sheetName === SHEETS.ADMINS) {
      notifyAdminsOfAdminSheetEdit_(e);
      return;
    }
```

and add the handler at the end of the file:

```javascript
function notifyAdminsOfAdminSheetEdit_(e) {
  try {
    // The bot's own /add_admin, /set_role and /remove_admin writes set this
    // marker immediately before writing. Only genuine hand edits get through.
    if (CacheService.getScriptCache().get(ADMINS_EDIT_SUPPRESS_KEY_)) return;
    const editor = (e.user && e.user.getEmail && e.user.getEmail()) || '(unknown Google account)';
    const text = [
      '🔐 The ADMINS sheet was edited directly.',
      'Edited by: ' + editor,
      'Range: ' + e.range.getA1Notation(),
      '',
      'Permission changes made in the sheet bypass every check in the bot. ' +
      'If this was not you or an agreed change, review the ADMINS tab now — /admins.'
    ].join('\n');
    getAllAdminRows_()
      .filter(r => isActiveAdminRow_(r) && isSystemAdminRow_(r))
      .forEach(r => sendMessage(r.TELEGRAM_ID, text));
    logInteraction('SYSTEM', 'ADMINS_SHEET_EDITED', editor + ' ' + e.range.getA1Notation());
  } catch (err) {
    console.error('notifyAdminsOfAdminSheetEdit_ failed: ' + err);
  }
}
```

> `e.user.getEmail()` returns a value only when the editing account is in the
> same Workspace domain as the script owner. Outside that it is blank, which is
> itself worth knowing — an edit from an unidentifiable account is more
> suspicious, not less.

- [ ] **Step 2: Deploy and verify the alert fires on a hand edit**

Edit any ADMINS cell by hand. Expected: every System Admin receives the 🔐 alert
and MESSAGES gains an `ADMINS_SHEET_EDITED` row.

- [ ] **Step 3: Verify it does NOT fire on the bot's own writes**

Run `/add_admin 111111111 Regional Visa Test Person`, then
`/set_role 111111111 None Contract`, then `/remove_admin 111111111`. Expected:
**zero** 🔐 alerts across all three, and zero `ADMINS_SHEET_EDITED` rows. If
alerts appear, `suppressAdminsSheetAlert_()` is missing from one of the three
write helpers. Delete the test row afterwards — by hand, which should itself
produce exactly one alert, confirming suppression expired correctly.

- [ ] **Step 4: Commit**

```bash
git add Triggers.gs AdminCommands.gs && git commit -m "feat: alert System Admins when the ADMINS sheet is edited directly"
```

**Docs to update:** `BOT-SPEC.md` §11 (a new behaviour on the onEdit trigger) and
§13 (this is the mitigation for R7 — the sheet is the real access boundary).
`RUNBOOK.md` §4.5 — warn that hand-editing ADMINS is now noisy by design, and
§5.4. `CONCERNS-AND-IT-ACTIONS.md` A8: keep the action open — restricting Drive
access is still the actual fix — but note that unauthorised edits are now
detected.

---

### Task 5.3: Replace tier with an ordered role and a capability table

Tier is exact-match, so Program does not imply Regional and nobody can hold two.
`Finance` is required by no command and grants exactly what `None` grants. The
only escape is `IS_SYSTEM_ADMIN`, which is all-or-nothing — which is why the
recommended deployment is "two people with total power", defeating the model.

**Do this last.** It is a consolidation, and Tasks 3.1–4.3 will have settled what
the rules actually need to be.

**Files:**
- Modify: `SetupSheets.gs` (add `ROLE`), `AdminCommands.gs` (capability table)

- [ ] **Step 1: Add the ROLE column**

```javascript
  createSheetWithHeaders_(ss, SHEETS.ADMINS, [
    'TELEGRAM_ID', 'IS_SYSTEM_ADMIN', 'TIER', 'QUEUE',
    'NAME', 'ACTIVE', 'ADDED_BY', 'ADDED_AT', 'REGIONS', 'ROLE'
  ]);
```

- [ ] **Step 2: Add the capability table**

```javascript
/**
 * Ordered roles replacing the flat Tier, which was a category pretending to be
 * a rank: a Program admin could not issue an urgent code and a Regional admin
 * could not export, because the check was exact string equality with no
 * seniority. The only way to hold both was System Admin, so everyone became a
 * System Admin and the role model stopped meaning anything.
 */
const ADMIN_ROLE = {
  READONLY: 'ReadOnly',
  AGENT: 'Agent',
  MANAGER: 'Manager',
  SYSTEM: 'SystemAdmin'
};

const CAPABILITIES_ = {
  'case.view':    [ADMIN_ROLE.READONLY, ADMIN_ROLE.AGENT, ADMIN_ROLE.MANAGER, ADMIN_ROLE.SYSTEM],
  'case.update':  [ADMIN_ROLE.AGENT, ADMIN_ROLE.MANAGER, ADMIN_ROLE.SYSTEM],
  'case.assign':  [ADMIN_ROLE.MANAGER, ADMIN_ROLE.SYSTEM],
  'urgent.issue': [ADMIN_ROLE.AGENT, ADMIN_ROLE.MANAGER, ADMIN_ROLE.SYSTEM],
  'announce':     [ADMIN_ROLE.MANAGER, ADMIN_ROLE.SYSTEM],
  'export':       [ADMIN_ROLE.MANAGER, ADMIN_ROLE.SYSTEM],
  'admin.manage': [ADMIN_ROLE.SYSTEM],
  'maintenance':  [ADMIN_ROLE.SYSTEM]
};

/**
 * Migration: ROLE is blank on every row that predates it, so fall back to the
 * old Tier/IS_SYSTEM_ADMIN pair. Both models therefore work simultaneously and
 * the ROLE column can be filled in at leisure rather than in a flag day.
 */
function roleForAdmin_(adminRow) {
  const explicit = String(adminRow.ROLE || '').trim();
  if (explicit) return explicit;
  if (isSystemAdminRow_(adminRow)) return ADMIN_ROLE.SYSTEM;
  const tier = String(adminRow.TIER || '').trim();
  if (tier === ADMIN_TIER.PROGRAM) return ADMIN_ROLE.MANAGER;
  if (tier === ADMIN_TIER.REGIONAL || tier === ADMIN_TIER.FINANCE) return ADMIN_ROLE.AGENT;
  return ADMIN_ROLE.READONLY;
}

function can_(adminRow, capability) {
  if (!adminRow || !isActiveAdminRow_(adminRow)) return false;
  const allowed = Object.prototype.hasOwnProperty.call(CAPABILITIES_, capability)
    ? CAPABILITIES_[capability] : [];
  return allowed.indexOf(roleForAdmin_(adminRow)) !== -1;
}
```

- [ ] **Step 3: Switch the gates**

| Site | Was | Becomes |
|---|---|---|
| `handleExport_` | `adminHasTier_(adminRow, PROGRAM)` | `can_(adminRow, 'export')` |
| `handleAnnounce_` | `adminHasTier_(adminRow, PROGRAM)` | `can_(adminRow, 'announce')` |
| `handleGenerateUrgentCode_` | `adminHasTier_(adminRow, REGIONAL)` | `can_(adminRow, 'urgent.issue')` |
| `handleAssign_` | *(none)* | `can_(adminRow, 'case.assign')` |
| `handleReply_`/`Close`/`Note`/`Reopen` | *(none)* | `can_(adminRow, 'case.update')` |
| `handleAddAdmin_`/`SetRole`/`RemoveAdmin`/`ListAdmins` | `isSystemAdminRow_(adminRow)` | `can_(adminRow, 'admin.manage')` |
| `handleMaintenance_` | `isSystemAdminRow_(adminRow)` | `can_(adminRow, 'maintenance')` |

- [ ] **Step 3b: Give `ROLE` a setter — otherwise it is unreachable**

Nothing written so far assigns `ROLE`. `upsertAdminRow_`'s `values` object does
not include it, `/add_admin` does not take it, and `/set_role` writes only
`TIER`/`QUEUE`. So the **only** way to set the column that now governs every
authorization decision would be a hand edit of the ADMINS sheet — which Task 5.2
correctly reports as a security event. Shipping a permission model whose sole
management path is the one the bot flags as suspicious is not acceptable.

Extend `/set_role` to take an optional fourth argument:

```javascript
// Usage becomes: /set_role <telegram_id> <tier> <queue> [role]
// Tier and queue are retained rather than dropped — roleForAdmin_ falls back to
// them for any row whose ROLE is blank, so both models must stay writable until
// every row has been migrated.
  const role = parts[3];
  if (role && Object.values(ADMIN_ROLE).indexOf(role) === -1) {
    sendMessage(chatId, 'Invalid role. Roles: ' + Object.values(ADMIN_ROLE).join(', '));
    return;
  }
  setAdminTierQueue_(existing._rowNumber, tier, queue);
  if (role) setAdminField_(existing._rowNumber, 'ROLE', role);
  logInteraction(chatId, 'ADMIN_ROLE_CHANGED',
    targetId + ' -> tier=' + tier + ' queue=' + queue + (role ? ' role=' + role : ''));
```

Add `ROLE: role || ''` to `upsertAdminRow_`'s `values` object and accept a role
argument in `/add_admin` the same way.

- [ ] **Step 3c: Re-point `/whoami` at the capability table**

Task 1.4's `handleWhoAmI_` answers "what can I do?" from `adminHasTier_`. Left
alone it would describe the **old** model while the **new** one is enforced —
an admin told they can `/export` and then refused. Rewrite the `can` block:

```javascript
  const can = [];
  can.push('View and work cases in queue: ' + (adminRow.QUEUE || 'None'));
  if (can_(adminRow, 'case.update')) can.push('Reply, close, note and reopen cases');
  if (can_(adminRow, 'case.assign')) can.push('/assign cases to other admins');
  if (can_(adminRow, 'urgent.issue')) can.push('/generate_urgent_code');
  if (can_(adminRow, 'announce')) can.push('/announce');
  if (can_(adminRow, 'export')) can.push('/export');
  if (can_(adminRow, 'admin.manage')) can.push('/add_admin, /set_role, /remove_admin, /admins');
  if (can_(adminRow, 'maintenance')) can.push('/maintenance');
```

and add a `'Role: ' + roleForAdmin_(adminRow)` line to the printed fields, marked
`(inherited from Tier)` when `adminRow.ROLE` is blank — otherwise the fallback is
invisible and nobody will ever know to migrate a row.

- [ ] **Step 4: Deploy and verify**

Set an admin's `ROLE = ReadOnly` **via `/set_role <id> None All ReadOnly`**, not
by hand, and confirm `/cases` works but `/close` is refused and logged. Set
`ROLE = Agent` and confirm `/close` works but `/assign` is refused. Leave another
admin's `ROLE` blank and confirm the Tier fallback still gives them their
previous access unchanged, and that `/whoami` shows
`Role: Manager (inherited from Tier)` for them.

Finally, confirm the two models cannot disagree silently: run `/whoami` as each
of the three and check every line of the "You can" block against the table in
Step 3. A capability listed but refused (or refused but listed) means Step 3c was
missed.

- [ ] **Step 5: Commit**

```bash
git add SetupSheets.gs AdminCommands.gs && git commit -m "refactor: ordered roles and a single capability table"
```

**Docs to update:** `BOT-SPEC.md` §6 in full; `RUNBOOK.md` §4.5 and §4.9.

---

### Task 5.4: Require a reason for `/export`

One command sends a CSV of every case out of the platform. It is logged and it
correctly excludes `DETAIL`, but there is no justification and nobody else is told.

**Files:**
- Modify: `AdminCommands.gs:473-489` (`handleExport_`), `routeAdminCommand_`

- [ ] **Step 1: Take a reason and tell the other System Admins**

```javascript
function handleExport_(chatId, adminRow, rest) {
  if (!can_(adminRow, 'export')) {
    denyAdminAction_(chatId, adminRow, '/export', 'Only Manager-role admins can export.');
    return;
  }
  const reason = (rest || '').trim();
  if (reason.length < 10) {
    sendMessage(chatId, 'Usage: /export <reason>\n\nExample: /export monthly report for the Recruitment Council\n\n' +
      'A bulk export of case data leaves the platform, so the reason is recorded and other System Admins are notified.');
    return;
  }
  const rows = getAllCaseRows_().filter(r => adminCanSeeCase_(adminRow, r));
  if (rows.length === 0) { sendMessage(chatId, 'No cases to export.'); return; }

  const headers = ['REFERENCE', 'CATEGORY', 'CHAT_ID', 'STATUS', 'OWNER', 'CREATED_AT', 'UPDATED_AT', 'PUBLIC_UPDATE'];
  const csvLines = [headers.join(',')].concat(rows.map(r => headers.map(h => csvEscape_(r[h])).join(',')));
  const blob = Utilities.newBlob(csvLines.join('\n'), 'text/csv', 'cases_export_' + Date.now() + '.csv');
  const result = sendDocument(chatId, blob, rows.length + ' cases exported.');
  if (!result.ok) {
    sendMessage(chatId, 'Export FAILED to send (' + (result.description || 'unknown error') + ').');
    return;
  }
  logInteraction(chatId, 'CASES_EXPORTED', rows.length + ' rows — reason: ' + reason.slice(0, 200));

  const notice = '📤 ' + (adminRow.NAME || adminRow.TELEGRAM_ID) + ' exported ' + rows.length +
    ' case records.\nReason given: ' + reason;
  getAllAdminRows_()
    .filter(r => isActiveAdminRow_(r) && isSystemAdminRow_(r) && String(r.TELEGRAM_ID) !== String(chatId))
    .forEach(r => sendMessage(r.TELEGRAM_ID, notice));
}
```

- [ ] **Step 2: Pass `rest` to the handler**

```javascript
    case '/export': handleExport_(chatId, adminRow, rest); break;
```

- [ ] **Step 3: Deploy and verify**

`/export` alone → usage message, no file. `/export monthly council report` → the
CSV arrives and every **other** System Admin is notified.

- [ ] **Step 4: Commit**

```bash
git add AdminCommands.gs && git commit -m "feat: /export requires a recorded reason and notifies other System Admins"
```

**Docs to update:** `BOT-SPEC.md` §6.5 — `/export`'s syntax becomes
`/export <reason>` and its requirement changes from Program tier to the `export`
capability; §13 — bulk export is now justified and peer-notified.
`RUNBOOK.md` §4.9. `CONCERNS-AND-IT-ACTIONS.md` A8 — a second, narrower control
on the same exposure the action describes.

---

# PHASE 6 — Content, findability and scale

**Effort:** ongoing. Post-launch, informed by real usage data from Task 1.2.

---

### Task 6.1: Improve FAQ findability

112 answers across 11 topics, only 4 reachable from the main menu, and typed
questions match only inside a topic. A stressed teacher's instinct is to type,
and they get *"I didn't understand that."*

**Do this after Task 1.2 has collected a month of `FAQ_NO_MATCH` data**, which
tells you whether the real problem is findability or missing content.

**Files:**
- Modify: `MenuHandler.gs:335-405` (`handleTextMessage_`), `QAEngine.gs`

- [ ] **Step 1: Offer a topic picker instead of a dead end**

Replace the final fallback in `handleTextMessage_`:

```javascript
  // A typed question with no topic selected used to get a flat "I didn't
  // understand that", which is the wrong answer to the most natural thing a
  // teacher can do. Matching across all topics at once is deliberately still
  // refused (proposal §4.2 — a visa question must never be answered from the
  // accommodation bank), but the question is remembered so the teacher does not
  // have to type it twice.
  logInteraction(chatId, 'QUERY_WITHOUT_TOPIC', String(text).slice(0, 200));
  setChatState_(chatId, { mode: 'AWAITING_TOPIC_FOR_QUERY', pendingQuery: text });
  const rows = FAQ_TOPICS.map(t => [{ text: t.emoji + ' ' + t.label, callback_data: 'QTOPIC:' + t.key }]);
  rows.push([{ text: '📞 None of these — Contact Support', callback_data: 'MENU:CONTACT_SUPPORT' }]);
  sendMessage(chatId, 'Which topic is that about? I will look up your question there.',
    { reply_markup: { inline_keyboard: rows } });
```

- [ ] **Step 2: Answer once the topic is chosen**

In `handleMenuCallback_`:

```javascript
  if (data.indexOf('QTOPIC:') === 0) {
    const topic = faqTopicByKey_(data.substring(7));
    if (!topic) { showFaqHub_(chatId); return; }
    const pending = getChatState_(chatId).pendingQuery;
    setChatState_(chatId, { mode: 'CATEGORY', category: topic.label });
    if (pending) { answerFaqQuery(chatId, topic.label, pending); return; }
    enterCategory_(chatId, topic.label);
    return;
  }
```

- [ ] **Step 3: Deploy and verify**

From the main menu, type `how much tax`. Expected: a topic picker, and tapping
**💵 Salary and Payment** returns the SAL-006 answer **without retyping**.

- [ ] **Step 4: Add the "did this resolve your question?" follow-up**

Proposal §3.1 specified this and `proposal_gap_analysis.md` falsely marked it
RESOLVED. It is the other half of the content feedback loop Task 1.2 starts: a
`FAQ_NO_MATCH` tells you the bank has no answer, while a ❌ on an answer that
*was* returned confidently tells you the answer is wrong or unclear — a
completely different and otherwise invisible failure.

In `QAEngine.gs`, replace `sendFaqAnswer_`:

```javascript
function sendFaqAnswer_(chatId, row) {
  logInteraction(chatId, 'FAQ_ANSWERED', row.CODE);
  const nav = faqNavKeyboard_(row.CATEGORY, false).reply_markup.inline_keyboard;
  // These two buttons are built here rather than through faqButtonRows_, which
  // is the only place that enforces Telegram's 64-byte callback_data ceiling.
  // Breaking it rejects the ENTIRE sendMessage with a 400, and because
  // callTelegramApi_ never throws the symptom is an answer that simply never
  // arrives — so the ceiling is re-checked here instead of assumed.
  const feedbackFits =
    byteLength_('FAQBAD:' + row.CODE) <= TELEGRAM_CALLBACK_DATA_MAX_BYTES_;
  if (!feedbackFits) {
    console.error('sendFaqAnswer_: CODE "' + row.CODE + '" is too long for feedback ' +
      'callback_data — answer sent without the ✅/❌ buttons. Shorten that CODE cell.');
  }
  const keyboard = (feedbackFits ? [[
    { text: '✅ That helped', callback_data: 'FAQOK:' + row.CODE },
    { text: '❌ Not what I meant', callback_data: 'FAQBAD:' + row.CODE }
  ]] : []).concat(nav);
  sendMessage(chatId, row.OFFICIAL_ANSWER, { reply_markup: { inline_keyboard: keyboard } });
}
```

> **Corrected from v1.0 of this plan**, which claimed `FAQBAD:` was one byte
> longer than `FAQANS:` and that the safe `CODE` length therefore dropped from 57
> to 56. It does not. `'FAQANS:'` and `'FAQBAD:'` are **both 7 characters**, and
> `'FAQOK:'` is 6. The budget is unchanged at 64 − 7 = **57 bytes**, and
> `BOT-SPEC.md` §4.1 is already correct — do not "fix" it to 56. The longest code
> in `FAQ-import.csv` is 7 characters, so there is no practical risk either way;
> the guard in the code above exists so a future long `CODE` degrades to "answer
> without feedback buttons" instead of "no answer at all".

In `MenuHandler.gs`'s `handleMenuCallback_`, before the `FAQANS:` branch:

```javascript
  if (data.indexOf('FAQOK:') === 0) {
    logInteraction(chatId, 'FAQ_HELPFUL', data.substring(6));
    sendMessage(chatId, 'Good — glad that helped.', { reply_markup: mainMenuKeyboard_() });
    return;
  }
  if (data.indexOf('FAQBAD:') === 0) {
    // The most actionable content signal of all: this answer was returned
    // confidently and was still wrong for the person who asked.
    logInteraction(chatId, 'FAQ_NOT_HELPFUL', data.substring(7));
    sendMessage(chatId, 'Sorry about that. Tap Contact Support and describe what you need — ' +
      'a person will pick it up.', {
        reply_markup: { inline_keyboard: [
          [{ text: '📞 Contact Support', callback_data: 'MENU:CONTACT_SUPPORT' }],
          [{ text: '❓ Try another topic', callback_data: 'MENU:FAQ' }],
          [{ text: '🏠 Main Menu', callback_data: 'MENU:MAIN' }]
        ] }
      });
    return;
  }
```

- [ ] **Step 5: Deploy and verify**

Open any answer. Expected: ✅ / ❌ appear above Back and Home. Tapping ❌ offers
Contact Support and writes a `FAQ_NOT_HELPFUL` row naming the `CODE`.

- [ ] **Step 6: Commit**

```bash
git add MenuHandler.gs QAEngine.gs && git commit -m "feat: topic picker for untargeted questions, and answer feedback buttons"
```

**Docs to update:** `BOT-SPEC.md` §9.0 (the constraint stands, but the dead end is
gone) and §8.3 (three new callback prefixes: `QTOPIC:`, `FAQOK:`, `FAQBAD:`).
**§4.1 needs no change** — the 57-byte `CODE` budget is unaffected.
`RUNBOOK.md` §1.3, §4.2 and Part 3 step 9.

**Operational follow-up:** add `FAQ_NOT_HELPFUL` to the monthly content review
alongside `FAQ_NO_MATCH` — grouped by `CODE`, it ranks the answers most in need
of rewriting.

---

### Task 6.2: Content review — for MoPSE, not IT

**This is not an engineering task.** Spot-checking the salary bank, SAL-001
answers *"is salary gross or net?"* with *"normally gross unless the final
approved offer clearly states otherwise… the exact net amount may depend on the
authorised payroll process."* Institutionally defensible, useless to someone
deciding whether to move country. The bot's whole value is authority; hedged
answers spend it and push teachers to Contact Support.

- [ ] **Step 1:** Name a content owner and a review interval (`CONCERNS` A6)
- [ ] **Step 2:** Review the 19 salary and 11 contract answers specifically for
  hedging, and either commit to a number or say plainly what the teacher must do
  to get one
- [ ] **Step 3:** Fix `DOC-001`'s third-person voice (`CONCERNS` B9)
- [ ] **Step 4:** Populate `LAST_APPROVED_BY` / `LAST_APPROVED_DATE` so the
  staleness clock starts
- [ ] **Step 5:** After one month, review the `FAQ_NO_MATCH` log from Task 1.2 and
  write the missing answers

---

### Task 6.3: Scale work — only if the numbers demand it

`CONCERNS` B1–B3 describe the global lock, whole-sheet reads, and synchronous
`/announce`. The load curve is a **spike**: one cohort arriving together, so peak
concurrency is arrival week — when archiving, the stated pressure valve, does
nothing because the sheet is still small.

**Trigger conditions — do not do this work pre-emptively:**

- [ ] **If the roster passes ~500:** move `/announce` to a queue drained by a
  time-driven trigger (~1 day)
- [ ] **If MESSAGES shows `logInteraction` lock failures during a burst:** buffer
  log rows in `CacheService` and flush from a trigger (~half a day)
- [ ] **If CASES passes ~5,000 rows:** set `RETENTION_DAYS` and confirm archiving
  is running; revisit whole-sheet reads only after that

---

## Deferred decisions — for the head of project, not IT

These are recorded so they are decisions rather than omissions.

| Decision | Consequence of not deciding | Owner |
|---|---|---|
| **Per-person one-time verification codes** instead of email identifiers | Impersonation stays possible; Task 2.1 makes it visible but does not prevent it | Head of project + Recruitment |
| **`RETENTION_DAYS`** | Data retained indefinitely, contradicting the privacy notice added in Task 2.2 | Head of project |
| **Privacy notice wording** | Task 2.2 ships engineer-drafted text | Head of project |
| **Global FAQ search** | Cross-topic false positives were judged worse than the dead end; Task 6.1 softens the dead end without changing the trade | Head of project |
| **Locking on the four admin write paths** | `BOT-SPEC` §12 documents them as an accepted bounded exception | IT, if concurrency rises |

---

## Recommended sequencing

| When | Phases | Why |
|---|---|---|
| **Before launch** | 0, 1 | 0 stops a lockout and a broken button; 1 makes it a support system rather than a suggestion box |
| **Launch week 1** | 2 | Identity and privacy — needed once real teachers are on it |
| **Launch weeks 2–3** | 3, 4 | The keystone and tasking. Do not attempt during arrival week itself |
| **Month 2** | 5 | Governance, once real usage has shown what the roles need to be |
| **Ongoing** | 6 | Driven by the data Task 1.2 starts collecting |

**Total engineering effort: roughly 4–5 days**, of which Phases 0 and 1 — about
1.5 days — carry most of the risk reduction.
