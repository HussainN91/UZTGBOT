# Dependency Tree — MoPSE Telegram Bot

Maintained by Agent 1 ("Dependency Tree Keeper"). Covers every module PLAN.md
calls for across Phases 0-6, whether or not it's built yet.

## How to update this
Refresh this file after each execution step (each time a .gs file is added,
renamed, or has its sheet/Config contract changed). Process:
1. Re-read PLAN.md's Progress section to see what moved from "planned" to "built".
2. For any new/changed file: update its entry's Depends-on / Depended-on-by /
   Data contract, and check off any "needs from already-built modules" item
   under planned modules that the new file now satisfies.
3. If a shared sheet's columns change (CASES, USERS, ROSTER, ADMINS,
   ANNOUNCEMENTS, FAQ, MESSAGES), update the "Sheet contracts" section — this
   is the part most likely to silently drift and break a later phase.
4. Re-check the "Notable / flag" list at the bottom — cross off anything now
   resolved, add anything new noticed during the step.
Keep it a plain indented list. Clarity over polish; this is a working
reference, not a deliverable.

---

## Status snapshot (as of 2026-07-26, Phase 6 complete — all 6 phases code-complete)
- **Built:** Config.gs, TelegramAPI.gs, Webhook.gs, SetupSheets.gs,
  SetWebhook.gs, Logger.gs (Phase 0) · MenuHandler.gs, QAEngine.gs (Phase 1)
  · UserSession.gs, CaseManager.gs (Phase 2, pulled forward) ·
  AdminCommands.gs (Phase 3) · FormRouter.gs (Phase 4) · Triggers.gs,
  ArchiveManager.gs (Phase 5). **This step (Phase 6, edits only — no new
  files):** `TelegramAPI.gs` (new `leaveChat_`), `Webhook.gs` (`my_chat_member`
  handling, `describeNonTextMessage_`, `/help` → `handleHelpCommand_`),
  `MenuHandler.gs` (new `teacherHelpText_`, `startCaseFeature_` now
  maintenance-gated), `AdminCommands.gs` (`/maintenance`,
  `adminCommandsHelpText_`, generic SETTINGS read/write helpers,
  `isMaintenanceMode_`), `QAEngine.gs` (`sendFaqPicker_`'s new
  `includeContactSupport` param). See their entries below for what changed.
- **Not fully built (unblocked only by external/manual steps, not code):**
  `Triggers.gs`'s `onFormSubmit` binding — the trigger handler code
  (`handleFormSubmit_`/`fileDocumentSubmissionCase_`) exists and is ready, but
  `installFormSubmitTrigger_(formId, docKey)` hasn't been (and can't yet be)
  called for any real form — no Google Form exists, `FORM_URLS` is still
  placeholders (PLAN.md "Open items"). Also still open: FAQ content
  population, ROSTER seeding, at least one System Admin row in ADMINS, and
  the `RETENTION_DAYS` business decision — all manual/content tasks, not
  missing code. With Phase 6 done, every phase in PLAN.md is now code-complete;
  what remains is exclusively the manual setup items under PLAN.md's "Open
  items" and the live-deployment exit checks Phase 0/6 both flag as
  unverifiable from code alone.

---

## Tree (depends-on direction: parent → child it calls)

```
Config.gs                          [no deps — pure constants + PropertiesService/Sheet accessors]
 ├─ depended on by: every other file (getProp_, SHEETS, CATEGORIES,
 │   FAQ_CACHE_TTL_SECONDS, SUPPORT_CONTACT_INFO, getSpreadsheet()) — now
 │   including AdminCommands.gs (SHEETS.ADMINS, SHEETS.ANNOUNCEMENTS,
 │   SHEETS.USERS, CATEGORIES for queueForCategory_/queue filters)
 ├─ **FORM_URLS is now FormRouter.gs's private data, not a public contract
 │   (Phase 4, confirmed by grep — see "Notable" #5, RESOLVED).**
 │   FormRouter.gs is the only reader of `FORM_URLS` anywhere in the
 │   codebase; MenuHandler.gs's old direct read was deleted along with its
 │   `DOC_TYPES_` array. If a future file (Triggers.gs?) needs a doc type's
 │   URL, it should go through FormRouter.gs's `formUrlForDocType_`, not read
 │   `FORM_URLS` itself — flag it here if that discipline ever slips.
 ├─ Triggers.gs and ArchiveManager.gs (Phase 5, now built) are real
 │   dependents as forecast: SHEETS.CASES, SHEETS.MESSAGES, SHEETS.SETTINGS —
 │   confirmed by reading both files.
 └─ **NEW — Script Properties key namespace, worth tracking here since
     Config.gs's PROP_KEYS is the only other code-owned inventory of Script
     Property key names.** Phase 5 adds two new key patterns outside
     PROP_KEYS: CaseManager.gs's `CASE_SEQ_<prefix>_<year>` (persistent
     reference-sequence counters) and Triggers.gs's `FORM_DOC_TYPE_<formId>`
     (per-form doc-type lookup for `handleFormSubmit_`). Checked against
     PROP_KEYS (BOT_TOKEN, WEBHOOK_SECRET, SPREADSHEET_ID, WEBAPP_URL) — no
     collision today. Nothing enforces this at runtime; if a future property
     key is ever chosen starting with `CASE_SEQ_` or `FORM_DOC_TYPE_` it
     would silently collide. Not a bug, just an unenforced convention worth
     remembering (see "Notable" #14 below).

TelegramAPI.gs                     [deps: Config.gs (getBotToken)]
 ├─ EXTENDED Phase 3: sendDocument(chatId, blob, caption) — deliberately
 │   bypasses callTelegramApi_ because sendDocument needs a multipart body
 │   (UrlFetchApp auto-encodes multipart when the payload contains a Blob),
 │   not JSON. Used only by AdminCommands.gs's /export.
 ├─ EXTENDED this step (Phase 6): new leaveChat_(chatId) — thin wrapper over
 │   Telegram's leaveChat method, routed through callTelegramApi_ like
 │   sendMessage (a plain JSON call, no multipart needed here). Its only
 │   caller is Webhook.gs's doPost, when a my_chat_member update shows the
 │   bot was added to a non-private chat — see Webhook.gs entry below.
 └─ depended on by: Webhook.gs (sendMessage everywhere, now also
     leaveChat_ — NEW), MenuHandler.gs, QAEngine.gs, UserSession.gs,
     CaseManager.gs (indirectly, via callers), SetWebhook.gs, AdminCommands.gs
     (sendMessage — every command that replies or notifies a teacher;
     sendDocument — /export only), and Triggers.gs (Phase 5): sendMessage,
     called from handleSheetEdit_'s manual-edit ping. Confirmed installed as
     a real ScriptApp installable trigger, never the reserved simple-trigger
     name, so the UrlFetchApp-under-restricted-auth-mode problem this file
     forecast never materializes (see Triggers.gs entry below).

Logger.gs                          [deps: Config.gs (SHEETS.MESSAGES), LockService]
 └─ depended on by: Webhook.gs (every message/callback), MenuHandler.gs,
     QAEngine.gs, UserSession.gs, CaseManager.gs (indirectly via MenuHandler),
     and now AdminCommands.gs — confirmed it logs every mutating/notable
     action through logInteraction() rather than writing its own log rows,
     per the plan this file recommended: ADMIN_COMMAND_DENIED, CASE_REPLY,
     CASE_CLOSED, CASE_ASSIGNED, CASE_NOTE, CASE_REOPENED, CASES_EXPORTED,
     ANNOUNCEMENT_SENT, ADMIN_ADDED, ADMIN_ROLE_CHANGED,
     URGENT_CODE_GENERATED all go through the same MESSAGES sheet.

Webhook.gs                         [deps: Config.gs (getWebhookSecret), TelegramAPI.gs
                                     (sendMessage everywhere; leaveChat_ — NEW,
                                     Phase 6, doPost's my_chat_member branch),
                                     Logger.gs, MenuHandler.gs (mainMenuKeyboard_,
                                     showMainMenu, handleTextMessage_,
                                     handleMenuCallback_, and now
                                     teacherHelpText_ — NEW, Phase 6,
                                     handleHelpCommand_), AdminCommands.gs
                                     (routeAdminCommand_, and now
                                     findAdminRow_ + adminCommandsHelpText_ —
                                     NEW, Phase 6, handleHelpCommand_)]
 ├─ depended on by: nothing built calls into Webhook.gs — it's the entry point.
 ├─ CHANGED Phase 3: `routeUpdate_()` calls `routeAdminCommand_(chatId, text)`
 │   for any `/`-prefixed text, before falling through to the `/start`/`/menu`
 │   check and normal `handleTextMessage_`. Note a discrepancy from what this
 │   file previously forecast: it expected Webhook.gs would need one new
 │   text-command branch PER admin command (/cases, /urgent, /case, ...).
 │   In practice a single generic branch was enough — routeAdminCommand_
 │   itself owns the full ADMIN_COMMAND_NAMES_ list and dispatches
 │   internally, so Webhook.gs never needs to change again when a new admin
 │   command is added, only AdminCommands.gs does.
 ├─ CHANGED this step (Phase 6) — three genuinely new behaviors, all inside
 │   this file:
 │   1. `doPost` now also reads `update.my_chat_member`. The private-chat
 │      guard (`chat.type !== 'private'`) is unchanged in spirit but now also
 │      derives `chat` from `myChatMember.chat` when there's no message/
 │      callback. If the resulting chat is non-private AND the update is the
 │      bot itself being added (`myChatMember.new_chat_member.status` not in
 │      `['left', 'kicked']`), it calls TelegramAPI.gs's new `leaveChat_(chat.id)`
 │      before returning the empty response — active leave, not just silent
 │      ignore, for the group-chat-unsupported case (proposal §7). A stray
 │      message/callback from a group (not a my_chat_member event) is still
 │      just silently ignored, as before.
 │   2. `routeUpdate_`'s `if (!text)` branch (previously a single generic
 │      "please send text" reply) now calls new `describeNonTextMessage_(message)`
 │      for a type-specific noun (photo/sticker/voice message/video note/
 │      video/file/audio message/location/contact card/"that kind of
 │      message" fallback) and points the teacher at Submit Documents instead
 │      of a bare "send text" instruction.
 │   3. New `/help` branch, checked BEFORE the `routeAdminCommand_` call
 │      (deliberately — see "Notable" #15 below): `handleHelpCommand_(chatId)`
 │      sends `MenuHandler.gs`'s `teacherHelpText_()`, with
 │      `AdminCommands.gs`'s `adminCommandsHelpText_()` appended only when
 │      `findAdminRow_(chatId)` is truthy — a teacher never sees a command
 │      list they can't use and can't infer who else is an admin from it.
 │      `/maintenance` (the other Phase 6 command) deliberately went the
 │      OPPOSITE way — added to `ADMIN_COMMAND_NAMES_`/`routeAdminCommand_`
 │      instead of getting its own Webhook.gs branch, because it genuinely is
 │      admin-only and should get the uniform non-admin rejection every other
 │      admin command gets; see AdminCommands.gs entry below.
 └─ still-planned: none — Phase 6 was the last phase in PLAN.md; nothing left
     forecast for Webhook.gs.

SetupSheets.gs                     [deps: Config.gs (SHEETS, getSpreadsheet)]
 └─ depended on by: nothing at runtime (one-time manual run) — but it is the
     SOURCE OF TRUTH for every sheet's header row / column order that every
     other file assumes. AdminCommands.gs's column reads/writes (ADMINS:
     TELEGRAM_ID, IS_SYSTEM_ADMIN, TIER, QUEUE; ANNOUNCEMENTS: ID, CONTENT,
     AUDIENCE, STATUS, CREATED_BY, CREATED_AT) match this file's header order
     exactly — verified by reading both files side by side during this
     update, no drift found.

SetWebhook.gs                      [deps: Config.gs (getWebhookSecret, getWebAppUrl),
                                     TelegramAPI.gs (callSetWebhook_, callDeleteWebhook_,
                                     callGetWebhookInfo_)]
 └─ depended on by: nothing (one-time manual run). Independent of everything
     else phase-wise; also holds deleteWebhook() — the "emergency stop" half
     of proposal §7 — Phase 6 maintenance mode is a *softer* version of this
     (pause submissions, keep FAQ live) and should NOT reuse deleteWebhook()
     (that kills the whole bot, not just submissions).

UserSession.gs                     [deps: Config.gs (SHEETS.USERS, SHEETS.ROSTER,
                                     SUPPORT_CONTACT_INFO), TelegramAPI.gs (sendMessage),
                                     Logger.gs (logInteraction), LockService,
                                     MenuHandler.gs (showMainMenu — called after verify)]
 ├─ depended on by: MenuHandler.gs (isVerified_, startVerification_, attemptVerify_),
 │   CaseManager.gs (isVerified_ — defense-in-depth check inside createCase),
 │   and now AdminCommands.gs — but NOT via isVerified_. AdminCommands.gs's
 │   /announce (getAnnouncementTargets_) reads the USERS sheet directly and
 │   filters by the VERIFICATION_STATE.VERIFIED constant that UserSession.gs
 │   defines, so an announcement only ever reaches verified teachers. This is
 │   a real cross-file dependency on UserSession.gs's VERIFICATION_STATE enum
 │   (a shared value contract), separate from and not to be confused with
 │   calling isVerified_() itself. Confirmed (per finding #7 below):
 │   checkPermission()/AdminCommands.gs never call isVerified_() to gate an
 │   admin action — admin identity stays entirely ADMINS-sheet-based.
 └─ **RESOLVED, differently than forecast (Phase 5).** Triggers.gs's
     fileDocumentSubmissionCase_ doesn't need a new lookup-by-identifier — the
     chat_id itself is captured directly on the form (a pre-filled question,
     per FormRouter.gs's Phase 4 design) rather than some other identifier
     needing translation. It calls isVerified_(chatId) directly to decide
     whether the submission is trustworthy — a third direct caller of
     isVerified_, alongside MenuHandler.gs's startCaseFeature_ and
     createCase()'s own internal guard.

CaseManager.gs                     [deps: Config.gs (SHEETS.CASES, CATEGORIES),
                                     UserSession.gs (isVerified_), LockService,
                                     PropertiesService (Phase 5, NEW — the
                                     persistent case-sequence counter)]
 ├─ EXTENDED Phase 3 with the three functions this file previously
 │   recommended (see "Notable" #1, resolved): findCaseByReference_,
 │   findCasesBy_, updateCaseFields_ (lock-protected read-modify-write
 │   against allow-list CASE_UPDATABLE_FIELDS_ = STATUS, OWNER, DETAIL,
 │   PUBLIC_UPDATE).
 ├─ **CHANGED significantly this step (Phase 5) — real behavior changes every
 │   existing/future caller should know about:**
 │   1. `casePrefixForCategory_` gained `CATEGORIES.SUBMIT_DOCS -> 'DOCS'`.
 │      Checked every entry against Config.gs's CATEGORIES — VISA, TRAVEL,
 │      CONTRACT, ACCOMMODATION, CONTACT_SUPPORT, SUBMIT_DOCS are all now
 │      mapped; CHECK_CASE and FAQ (menu-only categories, never passed to
 │      createCase) correctly still fall through to the generic 'CASE' prefix.
 │   2. `nextCaseSequence_(prefix, year)` / `generateCaseReference_(category)`
 │      were REWRITTEN, not just extended. Old signature scanned CASES for the
 │      highest existing reference on every call; the new one takes no `rows`
 │      parameter and instead reads/writes a persistent
 │      `CASE_SEQ_<prefix>_<year>` Script Property, self-seeding once per
 │      prefix/year from a new `maxExistingSequence_(prefix, year)` sheet scan
 │      the FIRST time that prefix/year is touched, then never re-scanning the
 │      sheet again. **Checked for breakage:** grepped the whole codebase for
 │      `generateCaseReference_(` and `nextCaseSequence_(` — CaseManager.gs is
 │      the only file that calls either (both only from inside `createCase`),
 │      so the signature change has zero external call sites to break. Not
 │      lock-protected on its own by design (the code's own comment explains
 │      why: it only ever runs inside createCase's existing LockService
 │      section).
 │   3. `createCase(chatId, category, detail, opts)` gained a 4th parameter.
 │      `opts.skipVerification` bypasses the `isVerified_` guardrail — used
 │      ONLY by Triggers.gs's `fileDocumentSubmissionCase_` fallback branch,
 │      confirmed by grep (its only other call site, MenuHandler.gs's
 │      `handleCaseDetailMessage_`, still calls it 3-arg — `opts = opts || {}`
 │      makes that safe, no existing 3-arg caller breaks).
 │   4. `updateCaseFields_` now sets a 60-second CacheService suppress marker
 │      (`onEditSuppressKey_(reference)`, `ONEDIT_SUPPRESS_TTL_SECONDS_` = 60)
 │      immediately before writing, for Triggers.gs's `handleSheetEdit_` to
 │      check and skip re-notifying a candidate who was already messaged by
 │      whatever admin command triggered the write.
 ├─ depended on by: MenuHandler.gs (createCase, getCasesForChatId,
 │   updateCaseFields_), AdminCommands.gs (findCaseByReference_, findCasesBy_,
 │   updateCaseFields_, getAllCaseRows_, CASE_STATUS — unchanged from Phase 3),
 │   and now **Triggers.gs (Phase 5, NEW):** createCase (both branches of
 │   fileDocumentSubmissionCase_), findCaseByReference_ (handleSheetEdit_),
 │   onEditSuppressKey_ (handleSheetEdit_ reads the exact key format this file
 │   writes, rather than reimplementing the string) — **and ArchiveManager.gs
 │   (Phase 5, NEW):** getCasesSheet_ (archiveOldCases_ reuses it instead of
 │   opening SHEETS.CASES a second way) and the CASE_STATUS enum
 │   (archivableCaseStatuses_ only ever compares against CASE_STATUS.CLOSED/
 │   COMPLETED/DUPLICATE, never a literal string).
 └─ still-planned: none. Both forecasted Phase-5 callers (Triggers.gs,
     ArchiveManager.gs) are now built and confirmed reusing this file's
     shared write/read paths rather than hand-rolling a second one — exactly
     what "Notable" #1 called for.

QAEngine.gs                        [deps: Config.gs (SHEETS.FAQ, FAQ_CACHE_TTL_SECONDS),
                                     TelegramAPI.gs (sendMessage), Logger.gs (logInteraction),
                                     CacheService, MenuHandler.gs (backToMenuKeyboard_ —
                                     circular-ish: MenuHandler also calls INTO QAEngine's
                                     getFaqRowsForCategory_ for enterCategory_'s button list)]
 ├─ CHANGED this step (Phase 6, "did you mean" refinement): `sendFaqPicker_`
 │   gained a 4th param, `includeContactSupport`. When true, it pushes a
 │   "📞 None of these — Contact Support" button (`callback_data:
 │   'MENU:CONTACT_SUPPORT'`) into the keyboard before the "Main Menu" row.
 │   `answerFaqQuery`'s no-match branch (`scored.length === 0`) now passes
 │   `true` — its prompt text already promised a Contact Support option in
 │   words, this backs it with a real tap target. The multi-match branch
 │   (`sendFaqPicker_(chatId, topMatches, ...)`, 3-arg call) is unchanged —
 │   `includeContactSupport` defaults falsy there, by design: several
 │   plausible FAQ matches isn't the same signal as zero matches, so it
 │   doesn't get the same escape hatch.
 ├─ depended on by: MenuHandler.gs (answerFaqQuery, getFaqRowsForCategory_,
 │   handleFaqAnswerCallback_)
 └─ planned: the deferred "did this resolve your question?" follow-up
     (PLAN.md "Deferred, not forgotten") will sit between QAEngine.gs's
     sendFaqAnswer_ and CaseManager.gs's createCase() — when built, it must
     pass the *originating FAQ category* into createCase() (not the generic
     CONTACT_SUPPORT category) for correct reference-prefix + Phase 3 queue
     routing (see AdminCommands.gs's queueForCategory_ below — this is the
     exact function whose ALL-queue default this would fix). No planned
     admin/trigger module needs QAEngine.gs directly.

MenuHandler.gs                     [deps: Config.gs (CATEGORIES — no longer FORM_URLS,
                                     see below), TelegramAPI.gs (sendMessage), Logger.gs,
                                     CacheService (chat_state_*), UserSession.gs
                                     (isVerified_, startVerification_, attemptVerify_),
                                     CaseManager.gs (createCase, getCasesForChatId,
                                     updateCaseFields_), QAEngine.gs
                                     (getFaqRowsForCategory_, answerFaqQuery,
                                     handleFaqAnswerCallback_),
                                     AdminCommands.gs (consumeUrgentCode_, and now
                                     isMaintenanceMode_ — NEW, Phase 6,
                                     startCaseFeature_'s gate),
                                     FormRouter.gs (docTypeList_, formUrlForDocType_,
                                     Phase 4)]
 ├─ depended on by: Webhook.gs (showMainMenu, mainMenuKeyboard_,
 │   handleTextMessage_, handleMenuCallback_), UserSession.gs (showMainMenu,
 │   called after successful verify)
 ├─ CHANGED this step (Submit Documents formalized, Phase 4): private
 │   `DOC_TYPES_` array deleted entirely. `showSubmitDocsMenu_()` now calls
 │   `docTypeList_()` and `sendDocFormLink_()` now calls
 │   `formUrlForDocType_(chatId, docKey)` — both from FormRouter.gs — instead
 │   of reading `Config.gs`'s `FORM_URLS` directly. Confirmed by grep: no
 │   remaining reference to `FORM_URLS` or `DOC_TYPES_` anywhere in this file.
 │   This resolves "Notable" #5 below and is exactly what that note called
 │   for. Note `sendDocFormLink_` now passes `chatId` through to
 │   `formUrlForDocType_` (not just `docKey`) — needed for the new
 │   chat-id-prefill mechanism FormRouter.gs owns (see its entry below); this
 │   file doesn't need to know that mechanism exists, it just forwards the arg.
 ├─ CHANGED this step (Submit Documents verification gate, Phase 5):
 │     `MENU:SUBMIT_DOCS` in `handleMenuCallback_` now calls
 │     `startCaseFeature_(chatId, 'SUBMIT_DOCS')` instead of calling
 │     `showSubmitDocsMenu_(chatId)` directly; `runCaseFeature_()` gained a
 │     fourth branch (`SUBMIT_DOCS` → `showSubmitDocsMenu_`) alongside
 │     CHECK_CASE/CONTACT_SUPPORT/URGENT_CASE. Net effect: Submit Documents is
 │     now identity-gated exactly like the other three case-creation buttons
 │     (see this file's own amended "Verification scope" header comment) — a
 │     teacher must pass roster verification before ever seeing the doc-type
 │     picker, closing the gap Phase 5's oracle note flagged (Triggers.gs's
 │     onFormSubmit hard-requires isVerified_ via createCase, so an unverified
 │     teacher reaching the form would always have landed in the "unresolved
 │     submitter" fallback).
 ├─ CHANGED this step (Urgent Case re-add, Phase 3):
 │     mainMenuKeyboard_() has the 🚨 Urgent Case button back (MENU:URGENT_CASE).
 │     runCaseFeature_() gained a third branch (URGENT_CASE →
 │       promptUrgentCode_) alongside CHECK_CASE/CONTACT_SUPPORT.
 │     New AWAITING_URGENT_CODE chat state: handleTextMessage_ routes text in
 │       this state to consumeUrgentCode_() (AdminCommands.gs) — valid code →
 │       AWAITING_CASE_DETAIL with `urgent: true` in chat state; invalid/
 │       expired → back to main menu with a message telling the teacher to
 │       ask their Regional admin or use Contact Support instead.
 │     handleCaseDetailMessage_() gained a third `urgent` parameter: on a
 │       genuinely NEW case (result.isNew — a deduped return is left alone)
 │       it calls updateCaseFields_(reference, {STATUS: CASE_STATUS.ESCALATED})
 │       right after createCase() returns CASE_STATUS.NEW, and the DETAIL text
 │       is prefixed '[URGENT] '.
 │   This is a genuinely new edge in the graph: a Phase-1-era file
 │   (MenuHandler.gs) now calls into a Phase-3 file (AdminCommands.gs). It's
 │   safe under Apps Script's file-concatenation model (function declarations
 │   are hoisted regardless of source-file order, same reasoning already
 │   documented in CaseManager.gs's casePrefixForCategory_ comment), but it's
 │   worth flagging explicitly here so nobody "fixes" it as an apparent
 │   layering violation — Urgent Case's whole design is menu-triggers-consume-
 │   admin-issued-code, so the edge is intentional. See "Notable" below.
 ├─ CHANGED this step (Phase 6, maintenance mode): `startCaseFeature_(chatId,
 │     action)` now checks `isMaintenanceMode_()` (AdminCommands.gs) FIRST,
 │     before the existing `isVerified_` check — skipped only when
 │     `action === 'CHECK_CASE'` (read-only, not a submission, per this
 │     file's own updated header comment). If maintenance is on, it
 │     short-circuits with a "paused for maintenance" message and returns
 │     without ever reaching the verification/case-creation branches below
 │     it. Net effect: Contact Support, Urgent Case, and Submit Documents are
 │     all paused from one gate (all three route through this function);
 │     Check My Case and FAQ browsing (which never calls startCaseFeature_ at
 │     all) stay live, exactly matching PLAN.md's "pause submissions, keep
 │     FAQ live." New `teacherHelpText_()` also added this step — plain
 │     function, no dependency on `mainMenuKeyboard_`'s button list, called
 │     only by Webhook.gs's `handleHelpCommand_` (see that entry above).
 ├─ **BUG found and fixed same day (Oracle review):** the maintenance gate
 │     above only lived in `startCaseFeature_` — but `handleTextMessage_`'s
 │     `AWAITING_IDENTIFIER` branch, after a successful verification, called
 │     `runCaseFeature_(chatId, state.pendingAction)` directly, skipping
 │     `startCaseFeature_` (and its `isMaintenanceMode_()` check) entirely.
 │     A teacher who started verifying before maintenance mode was switched
 │     ON could still complete Contact Support/Urgent Case/Submit Documents
 │     right after verifying, bypassing the pause. Fixed: that branch now
 │     calls `startCaseFeature_(chatId, state.pendingAction)` instead — since
 │     `isVerified_` is already true at that point, this only re-does a cheap,
 │     harmless check before falling through to the same `runCaseFeature_`
 │     call, but now the maintenance check is never skippable via this path.
 └─ still-planned: none — Phase 6 was PLAN.md's last phase. The FormRouter.gs
     hand-off, the Submit Documents verification gate, and the maintenance
     gate are all done (see CHANGED notes above).

AdminCommands.gs (Phase 3, NEW)    [deps: Config.gs (SHEETS.ADMINS, SHEETS.ANNOUNCEMENTS,
                                     SHEETS.USERS, SHEETS.SETTINGS — NEW, Phase 6,
                                     CATEGORIES), TelegramAPI.gs (sendMessage,
                                     sendDocument), Logger.gs (logInteraction), CaseManager.gs
                                     (findCaseByReference_, findCasesBy_, updateCaseFields_,
                                     getAllCaseRows_, CASE_STATUS), UserSession.gs
                                     (VERIFICATION_STATE enum only — see UserSession.gs
                                     entry above), CacheService (urgent codes), LockService
                                     (indirectly, via CaseManager.gs's updateCaseFields_)]
 ├─ owns two new enums, defined here (not Config.gs) per this file's own
 │   earlier note that they'd never been formalized:
 │     ADMIN_TIER = {PROGRAM, FINANCE, REGIONAL, NONE}
 │     ADMIN_QUEUE = {VISA, CONTRACT, TRAVEL, ACCOMMODATION, RECRUITMENT,
 │       TECHNICAL, ALL, NONE} — RECRUITMENT/TECHNICAL don't map to any
 │       CATEGORIES value today (no such menu/FAQ category exists); an admin
 │       can still be assigned one, they'll just see zero cases under it.
 ├─ owns checkPermission(chatId, requiredTier, requiredQueue) — general
 │   tier/queue gate for commands not about one specific case (/announce,
 │   /export, /generate_urgent_code); System Admin bypasses both checks.
 ├─ owns adminCanActOnCategory_(adminRow, category) — the per-CASE gate used
 │   by every case-mutating command (/case, /reply, /close, /assign, /note,
 │   /reopen, /search, /cases, /urgent), via queueForCategory_(category)
 │   which maps a case's CATEGORY to the ADMIN_QUEUE it belongs to.
 ├─ **queueForCategory_() only maps VISA/TRAVEL/CONTRACT/ACCOMMODATION to
 │   their named queues; everything else (today: only CONTACT_SUPPORT, since
 │   that's the only category createCase() is ever called with) falls through
 │   to ADMIN_QUEUE.ALL.** This is the "Known scope limit, by design" PLAN.md
 │   already documents — see "Notable" below for why it's worth restating
 │   here for whoever plans Phase 4/5.
 ├─ owns consumeUrgentCode_(code) — single-use, cache-backed (48h TTL),
 │   removed from cache the moment it's checked whether valid or not (so a
 │   guessed/leaked code can't be replayed even on a failed attempt). This is
 │   the function MenuHandler.gs's Urgent Case flow calls (see above).
 ├─ new sheet contract it OWNS (real reader/writer now, not just headers):
 │   ADMINS (TELEGRAM_ID, IS_SYSTEM_ADMIN, TIER, QUEUE — read by
 │   findAdminRow_/getAllAdminRows_, written by upsertAdminRow_/
 │   setAdminTierQueue_) and ANNOUNCEMENTS (ID, CONTENT, AUDIENCE, STATUS,
 │   CREATED_BY, CREATED_AT — appended by appendAnnouncementRow_, STATUS
 │   column patched by updateAnnouncementStatus_ after send).
 ├─ ALSO reads USERS (CHAT_ID, VERIFICATION_STATE, REGION) for /announce
 │   targeting — a new reader of a sheet UserSession.gs owns for writing;
 │   see UserSession.gs entry above.
 ├─ routeAdminCommand_(chatId, text) is the single entry point Webhook.gs
 │   calls for any `/`-prefixed text; returns false for anything not in
 │   ADMIN_COMMAND_NAMES_ (so an unrecognized "/foo" still falls through to
 │   ordinary "I didn't understand that" handling) and true for everything
 │   else, including a clean, uniform rejection of non-admins before any
 │   individual command handler runs.
 ├─ CHANGED this step (Phase 6, maintenance mode) — new sheet contract, new
 │   generic accessor pair, new command:
 │   `'/maintenance'` was added to `ADMIN_COMMAND_NAMES_` and to
 │   `routeAdminCommand_`'s switch (→ `handleMaintenance_`), so it gets the
 │   same uniform non-admin rejection every other admin command gets — the
 │   opposite choice from `/help` (see Webhook.gs entry above for why the two
 │   went different ways).
 │   New: `SETTINGS_KEY_MAINTENANCE_MODE_` const, `getSettingsSheet_()`,
 │   `getSettingValue_(key)`, `setSettingValue_(key, value, notes)` — the
 │   **first generic KEY/VALUE/NOTES accessor pair for the SETTINGS sheet
 │   anywhere in the codebase.** `isMaintenanceMode_()` wraps
 │   `getSettingValue_` (defaults OFF if the row doesn't exist yet).
 │   `handleMaintenance_(chatId, adminRow, rest)` is System-Admin-gated (not
 │   `checkPermission`'s tier/queue model — this file's own new comment
 │   explains why: pausing submissions system-wide is an operational control,
 │   not a per-queue action) and supports `on`/`off`/bare-usage-with-status.
 │   New `adminCommandsHelpText_()` — a one-line admin-command list, joined
 │   straight from `ADMIN_COMMAND_NAMES_` so it can never drift from what
 │   commands actually exist; called only by Webhook.gs's `handleHelpCommand_`.
 │   **Worth flagging: ArchiveManager.gs (Phase 5) already reads the same
 │   SETTINGS sheet, but with its own separate inline KEY/VALUE scan
 │   (`getRetentionDays_()`), not through these new helpers.** Two independent
 │   code paths now read SETTINGS by scanning for a KEY match — see "Notable"
 │   #15 below for whether this is worth fixing.
 │   **FIXED same day (Oracle review) — this entry corrected 2026-07-26 after
 │   a stale-write race with the agent that drafted the note above:**
 │   `setSettingValue_` was an unlocked read-then-write (scan for KEY, then
 │   update-in-place or `appendRow`), unlike `CaseManager.gs`'s
 │   `updateCaseFields_` or `Logger.gs`'s append. It is now wrapped in
 │   `LockService.getScriptLock()` (verified directly against AdminCommands.gs
 │   lines 542-562) — the concurrent-duplicate-KEY-row risk this note
 │   originally described no longer applies. See "Notable" #17 below, also
 │   corrected.
 ├─ depended on by: Webhook.gs (routeAdminCommand_, and now findAdminRow_ +
 │   adminCommandsHelpText_ — NEW, Phase 6, handleHelpCommand_), MenuHandler.gs
 │   (consumeUrgentCode_, and now isMaintenanceMode_ — NEW, Phase 6)
 └─ **Speculative Phase-5 caller did NOT materialize.** Triggers.gs's
     `handleSheetEdit_` (built this step) does not call `findAdminRow_` or
     attribute the edit to any admin identity — it only checks the suppress
     marker and, if absent, sends a generic "status is now X" ping. Confirmed
     by reading the code: zero references to AdminCommands.gs anywhere in
     Triggers.gs. Not a problem — just noting the speculative edge this file
     forecast was never built, so a future reader doesn't go looking for it.
     **Gap found and fixed same day (see "Notable" #13):** AdminCommands.gs's
     `/reply /close /reopen` used to unconditionally `sendMessage(c.CHAT_ID, ...)`
     with no check for the `UNRESOLVED:` sentinel CHAT_ID Triggers.gs can
     write — now guarded via `hasNotifiableChatId_()`.

FormRouter.gs (Phase 4, NEW)       [deps: Config.gs (FORM_URLS — now this file's
                                     private data, see Config.gs entry above),
                                     TelegramAPI.gs (sendMessage — used only by
                                     the unwired sendFormSubmissionConfirmation_
                                     stub, see below)]
 ├─ owns `DOC_TYPE_DEFS_` (the 7 doc-type key+label pairs: VISA, CONTRACT,
 │   PASSPORT, TICKET, REIMBURSEMENT, CERTIFICATE, CORRECTION) and
 │   `docTypeList_()` — a defensive `.slice()` copy, not the live array —
 │   formalizing what used to be MenuHandler.gs's private `DOC_TYPES_`.
 ├─ owns `formUrlForDocType_(chatId, key)` — looks up `FORM_URLS[key]` and,
 │   if `FORM_CHAT_ID_ENTRY_IDS_[key]` is set, appends
 │   `&entry.<id>=<chatId>` (or `?entry...` if the base URL has no query
 │   string yet) to pre-fill a "Telegram Chat ID" field on the real Google
 │   Form. Returns `null` if `key` isn't a known doc type (MenuHandler.gs's
 │   `sendDocFormLink_` falls back to `showMainMenu` in that case).
 ├─ **`FORM_CHAT_ID_ENTRY_IDS_` is empty for every key today** — this is the
 │   settled design for how Phase 5's onFormSubmit will resolve a form
 │   response back to a Telegram chat_id (see PLAN.md Phase 4 "Progress" and
 │   "Open items"), but it has no effect until real Google Forms exist and
 │   their field entry IDs are filled in by hand. See "Notable" #6/#11 below
 │   for a gap in this design worth flagging now, before Phase 5 is planned.
 ├─ owns `sendFormSubmissionConfirmation_(chatId, docKey)` — **RESOLVED
 │   (Phase 5): now has a real call site.** Triggers.gs's
 │   `fileDocumentSubmissionCase_` calls it exactly once, only on the
 │   verified branch (`result.isNew` — a deduped return doesn't re-send a
 │   confirmation), right after `createCase()` succeeds. The
 │   unresolved-submitter branch deliberately never calls it — no verified
 │   chat_id to send to (see Triggers.gs entry and "Notable" #11).
 ├─ depended on by: MenuHandler.gs (`docTypeList_` in `showSubmitDocsMenu_`,
 │   `formUrlForDocType_` in `sendDocFormLink_` — confirmed both call sites,
 │   no other file reads `FORM_URLS` or duplicates this mapping)
 └─ **RESOLVED (Phase 5):** Triggers.gs is now a real dependent —
     `sendFormSubmissionConfirmation_` as described above. The "map a form
     response back to a doc-type key" question resolved differently than
     forecast: `installFormSubmitTrigger_(formId, docKey)` stores the
     doc-type key itself in a `FORM_DOC_TYPE_<formId>` Script Property at
     install time, so `handleFormSubmit_` never needs
     `docTypeList_`/`DOC_TYPE_DEFS_` to reverse-map anything — FormRouter.gs's
     only real runtime dependent remains MenuHandler.gs. The deferred
     "originating category" pass-through (see QAEngine.gs entry above) is
     still unbuilt and unrelated — Submit Documents and Contact Support
     remain independent flows; FormRouter.gs still never touches
     CaseManager.gs directly (Triggers.gs is the bridge, not FormRouter.gs).

Triggers.gs (Phase 5, NEW)         [deps: Config.gs (SHEETS.CASES —
                                     handleSheetEdit_'s sheet-name guard,
                                     CATEGORIES.SUBMIT_DOCS —
                                     fileDocumentSubmissionCase_),
                                     TelegramAPI.gs (sendMessage —
                                     handleSheetEdit_'s manual-edit ping),
                                     Logger.gs (logInteraction —
                                     CASE_MANUAL_EDIT_NOTIFIED),
                                     UserSession.gs (isVerified_ — called
                                     directly by fileDocumentSubmissionCase_,
                                     a third direct caller alongside
                                     MenuHandler.gs and createCase()'s own
                                     guard — see "Notable" #7), CaseManager.gs
                                     (createCase, findCaseByReference_,
                                     onEditSuppressKey_ — reads the exact
                                     suppress-key format updateCaseFields_
                                     writes rather than reimplementing the
                                     string), FormRouter.gs
                                     (sendFormSubmissionConfirmation_ — now
                                     actually called, see "Notable" #11),
                                     ArchiveManager.gs (runArchive_ delegates
                                     straight to runArchiveManager_),
                                     CacheService, PropertiesService
                                     (FORM_DOC_TYPE_<formId>)]
 ├─ `installTriggers()` installs `onEdit` (handleSheetEdit_) and the 14-day
 │   archive trigger (runArchive_) as real installable triggers — confirmed
 │   both are registered via `ScriptApp.newTrigger(...).create()`, never the
 │   reserved simple-trigger names, exactly as PLAN.md's Concurrency section
 │   requires. NOT installed by installTriggers(): onFormSubmit.
 │   `installFormSubmitTrigger_(formId, docKey)` is a separate, manual,
 │   per-form call — stores a `FORM_DOC_TYPE_<formId>` Script Property so
 │   `handleFormSubmit_` can recover which doc type fired, since the
 │   onFormSubmit event itself only identifies the form, not the doc type.
 │   Not callable yet — no real Google Form exists (`FORM_URLS` is still
 │   placeholders, PLAN.md "Open items").
 ├─ **Genuinely new architecture point: Triggers.gs's entry points (onEdit,
 │   onFormSubmit, the time-driven archive trigger) never go through
 │   Webhook.gs at all** — installable triggers run in their own execution
 │   context, not through doPost(). Worth stating explicitly since every
 │   other file in this tree eventually traces back to Webhook.gs as the
 │   entry point; Triggers.gs is the first one that doesn't.
 ├─ `fileDocumentSubmissionCase_(chatIdRaw, docKey, formResponseId)` —
 │   verified path calls `createCase(chatId, CATEGORIES.SUBMIT_DOCS, ...)`
 │   normally; anything else (blank/edited/unverified chat_id field) calls
 │   `createCase(..., {skipVerification: true})` with a sentinel CHAT_ID of
 │   the form `UNRESOLVED:<formResponseId>` — see CaseManager.gs entry above
 │   and "Sheet contracts" / "Notable" #13 below for what this sentinel means
 │   to every OTHER reader of CASES.CHAT_ID, not just this file.
 ├─ `handleSheetEdit_(e)` checks CaseManager.gs's suppress marker before
 │   notifying, and separately guards against notifying an `UNRESOLVED:`
 │   sentinel row (no real chat to message). **AdminCommands.gs's
 │   /reply /close /reopen now have the same guard (`hasNotifiableChatId_`)
 │   — see "Notable" #13, resolved.**
 └─ depended on by: nothing (installable-trigger entry points, invoked by the
     Apps Script trigger service, not called by any other file in this
     codebase).

ArchiveManager.gs (Phase 5, NEW)   [deps: Config.gs (SHEETS.MESSAGES,
                                     SHEETS.SETTINGS, getSpreadsheet),
                                     CaseManager.gs (getCasesSheet_ —
                                     archiveOldCases_ reuses it rather than
                                     opening the CASES sheet a second way;
                                     CASE_STATUS enum — archivableCaseStatuses_
                                     only ever compares against CASE_STATUS.
                                     CLOSED/COMPLETED/DUPLICATE, never a
                                     literal string)]
 ├─ `getRetentionDays_()` reads the SETTINGS sheet's `KEY=RETENTION_DAYS`
 │   row; `runArchiveManager_` logs and no-ops (never touches a sheet) if
 │   it's unset or ≤ 0 — confirmed by reading the code, matches PLAN.md's
 │   "Blocking decision" framing exactly.
 ├─ `getOrCreateArchiveSheet_(sourceSheet)` lazily creates a `<name>_ARCHIVE`
 │   tab (header row copied from the source sheet) the FIRST time archiving
 │   actually moves a row — **CASES_ARCHIVE and MESSAGES_ARCHIVE do not exist
 │   yet and are not part of SetupSheets.gs** (confirmed: createAllSheets()
 │   has no ARCHIVE entries) — see "Sheet contracts" below.
 ├─ `archiveOldCases_(cutoff)` — only CASE_STATUS.CLOSED/COMPLETED/DUPLICATE
 │   rows, by UPDATED_AT (not CREATED_AT — an old-but-still-open case is
 │   never swept). `archiveOldMessages_(cutoff)` — every MESSAGES row by
 │   TIMESTAMP regardless of content (MESSAGES has no status concept to
 │   filter on). Both walk bottom-up (deleteRow) so index-shifting from an
 │   earlier delete can't skip a row.
 └─ depended on by: Triggers.gs (runArchive_ → runArchiveManager_, the
     14-day time-driven trigger's only job).

Phase 6 (DONE this step, no new files) [edits to TelegramAPI.gs, Webhook.gs,
                                     MenuHandler.gs, AdminCommands.gs, QAEngine.gs only]
 ├─ non-text message handling → done, Webhook.gs's `describeNonTextMessage_`
 │   (see Webhook.gs entry above) — matches the forecast exactly.
 ├─ group chat handling → done, and went further than forecast: the
 │   private-chat-only silent-ignore from Phase 0 is unchanged, but Webhook.gs
 │   now also actively calls TelegramAPI.gs's new `leaveChat_` when a
 │   `my_chat_member` update shows the bot was added to a non-private chat —
 │   "ignore" became "ignore + leave."
 ├─ /help → done, differently than forecast in one respect: this file's own
 │   earlier note said `/help` "should read ADMIN_COMMAND_NAMES_ directly" —
 │   it does, but indirectly, via AdminCommands.gs's new
 │   `adminCommandsHelpText_()` rather than Webhook.gs reading the array
 │   itself. Same effect (can't drift from what commands actually exist),
 │   ownership just sits one file over from forecast. Also routes through a
 │   dedicated Webhook.gs branch checked BEFORE `routeAdminCommand_`, per the
 │   Phase 3 constraint (a non-admin typing /help must not get "You are not
 │   registered as an admin").
 └─ /maintenance → done, opposite routing choice from /help and consistent
     with the Phase 3 constraint: added to AdminCommands.gs's
     ADMIN_COMMAND_NAMES_/routeAdminCommand_ (admin-only by design, so it
     SHOULD get the uniform non-admin rejection), not a separate Webhook.gs
     branch. Gates MenuHandler.gs's `startCaseFeature_` (Contact
     Support/Urgent Case/Submit Documents), leaving Check My Case and FAQ
     browsing untouched — matches "pause submissions, keep FAQ live" exactly.
     Backed by a new generic SETTINGS KEY/VALUE/NOTES accessor pair in
     AdminCommands.gs (`getSettingValue_`/`setSettingValue_`) — see that
     file's entry above and "Sheet contracts" below for the duplication this
     creates against ArchiveManager.gs's separate inline SETTINGS reader.
```

---

## Sheet contracts (the shapes future modules must not violate)

- **CASES** — `REFERENCE, CATEGORY, CHAT_ID, STATUS, OWNER, CREATED_AT,
  UPDATED_AT, DETAIL, PUBLIC_UPDATE`. Owner: CaseManager.gs (create, read,
  and now the shared update path `updateCaseFields_`). STATUS values are the
  CASE_STATUS enum in CaseManager.gs (8 levels) — confirmed AdminCommands.gs's
  /close, /reopen, and MenuHandler.gs's urgent-escalation write all use the
  enum (CASE_STATUS.CLOSED / UNDER_REVIEW / ESCALATED), never a literal
  string; `/cases`'s status filter (`normalizeStatusArg_`) also validates
  against `Object.values(CASE_STATUS)` rather than accepting an arbitrary
  string. DETAIL is never surfaced to the teacher (guardrail) — confirmed
  AdminCommands.gs's /export deliberately excludes DETAIL from its CSV
  columns for the same reason, even though a single admin can still read it
  per-case via `/case`. PUBLIC_UPDATE is the only case-status free text safe
  to show a teacher or send in a Telegram ping — confirmed `/reply` writes
  exactly PUBLIC_UPDATE and nothing else. **NEW (Phase 5): CHAT_ID can now
  hold a non-numeric sentinel value of the form `UNRESOLVED:<formResponseId-
  or-uuid>`** — written only by Triggers.gs's `fileDocumentSubmissionCase_`
  fallback branch, when a form's chat_id field is blank/edited/unverified.
  Every reader of CASES.CHAT_ID that assumes a real Telegram chat_id must
  check for this prefix first: `handleSheetEdit_` does (skips notifying), and
  **AdminCommands.gs's `/reply`, `/close`, `/reopen` now do too**, via the new
  `hasNotifiableChatId_()` guard (see "Notable" #13, resolved).

- **USERS** — `CHAT_ID, LANGUAGE, FIRST_SEEN, LAST_SEEN, VERIFICATION_STATE,
  IDENTIFIER, NAME, REGION`. Owner (writer): UserSession.gs.
  VERIFICATION_STATE only currently has one real value ('VERIFIED'), now
  formalized as UserSession.gs's `VERIFICATION_STATE` enum. **New reader as
  of Phase 3:** AdminCommands.gs's `/announce` reads CHAT_ID +
  VERIFICATION_STATE + REGION to build its audience list (only verified rows
  are ever targeted, filtered further by REGION unless audience is "ALL").
  No new columns were needed for this — REGION already existed in the
  contract from Phase 2.

- **ROSTER** — `IDENTIFIER, NAME, REGION`. Owner: UserSession.gs (read-only
  at runtime; seeded manually/CSV by MoPSE per PLAN.md Open Items). Matched
  case-insensitively, trimmed, against USERS.IDENTIFIER on verify. Untouched
  by Phase 3.

- **ADMINS** — `TELEGRAM_ID, IS_SYSTEM_ADMIN, TIER, QUEUE`. Sheet exists
  (SetupSheets.gs); **now has a real consumer as of Phase 3:**
  AdminCommands.gs reads it via `findAdminRow_`/`getAllAdminRows_` for every
  admin command's gate check, and writes it via `upsertAdminRow_` (/add_admin)
  and `setAdminTierQueue_` (/set_role, TIER+QUEUE columns only — never
  IS_SYSTEM_ADMIN, so /set_role can't be used to mint a new System Admin).
  Tier ∈ {Program, Finance, Regional, None} and Queue ∈ {Visa, Contract,
  Travel, Accommodation, Recruitment, Technical, All, None} are now a real JS
  enum (`ADMIN_TIER`/`ADMIN_QUEUE` in AdminCommands.gs), as this file
  previously recommended.

- **ANNOUNCEMENTS** — `ID, CONTENT, AUDIENCE, STATUS, CREATED_BY,
  CREATED_AT`. Sheet exists; **now used as of Phase 3:** AdminCommands.gs's
  `/announce` appends a row per announcement (STATUS starts 'SENDING'),
  fans the message out to the audience via TelegramAPI.gs's `sendMessage`,
  then patches STATUS to 'SENT' or 'PARTIAL' depending on delivery count.
  Column order in the append matches SetupSheets.gs exactly (verified).

- **MESSAGES** — `TIMESTAMP, CHAT_ID, ACTION, DETAIL`. Owner: Logger.gs
  (append-only, lock-protected). Every handler across every phase should
  route through logInteraction() rather than appending directly — confirmed
  AdminCommands.gs does this for every mutating/notable action (see Logger.gs
  entry above) — this is also the sheet ArchiveManager.gs will purge/archive
  by age once the retention decision is made.

- **FAQ** — `CODE, CATEGORY, BUTTON_TEXT, KEYWORDS, OFFICIAL_ANSWER,
  LANGUAGE, ACTIVE, LAST_APPROVED_BY, LAST_APPROVED_DATE`. Owner:
  QAEngine.gs (cached read, 6h TTL via CacheService key 'faq_rows'). Untouched
  by Phase 3; still no write path exists anywhere, so the stale-cache risk
  noted below hasn't materialized.

- **SETTINGS** — `KEY, VALUE, NOTES`. Sheet exists (SetupSheets.gs). **Two
  real consumers now, added in different phases, each with its OWN read
  path:**
  1. ArchiveManager.gs (Phase 5) — `getRetentionDays_()` reads `KEY=RETENTION_DAYS`
     and no-ops (never touches CASES/MESSAGES) until a positive integer value
     exists there, via its own inline `getDataRange()` + header-index scan.
     Read-only; no code writes `RETENTION_DAYS` anywhere — that row must
     still be added by hand.
  2. AdminCommands.gs (Phase 6, NEW) — `getSettingValue_(key)`/
     `setSettingValue_(key, value, notes)` are a **generic** KEY/VALUE/NOTES
     read/write pair (find-or-append), and `isMaintenanceMode_()`/
     `handleMaintenance_()` are built on top of them for `KEY=MAINTENANCE_MODE`
     ('TRUE'/'FALSE'). This is the first and only code path that WRITES to
     SETTINGS.
  **Worth flagging (new, Phase 6):** these are two independently-written
  KEY-column scans over the same sheet, not one shared accessor used twice.
  Functionally safe today — they never touch the same KEY (`RETENTION_DAYS`
  vs `MAINTENANCE_MODE`) and both tolerate a missing row — but it's
  duplicated logic that could silently diverge (e.g. if SETTINGS' column
  order ever changed, one reader might get patched and the other missed).
  Not urgent enough to justify a refactor mid-Phase-6 (ArchiveManager.gs's
  reader is read-only and stable), but the next time either file is touched,
  consider having `getRetentionDays_()` call AdminCommands.gs's
  `getSettingValue_()` instead of re-scanning — see "Notable" #15 below.

- **CASES_ARCHIVE / MESSAGES_ARCHIVE — NEW (Phase 5), not part of
  SetupSheets.gs.** ArchiveManager.gs's `getOrCreateArchiveSheet_` lazily
  creates a `<name>_ARCHIVE` tab (header row copied verbatim from the source
  sheet) the first time the 14-day archive trigger actually finds a row old
  enough to move — which itself only happens once `SETTINGS.RETENTION_DAYS`
  is set. Confirmed by reading SetupSheets.gs's `createAllSheets()`: no
  ARCHIVE entries exist there. Practical effect: these two tabs won't exist
  in a freshly-provisioned spreadsheet, and won't exist in this project's
  spreadsheet either until `installTriggers()` has run AND `RETENTION_DAYS`
  has been set AND the trigger has fired at least once past the retention
  window — don't treat their absence as a bug during Phase 5 testing.

---

## Notable / worth flagging

1. ~~**Shared case-write function doesn't exist yet...**~~ **RESOLVED (Phase
   3).** `CaseManager.gs` now has `updateCaseFields_(reference, fields)` and
   `findCaseByReference_(reference)`, exactly as recommended: lock-protected,
   same pattern as `createCase()`, allow-listed field names. Both
   AdminCommands.gs (`/assign /reply /note /close /reopen`) and
   MenuHandler.gs (urgent-case escalation) call the shared function instead
   of hand-rolling sheet writes. **Phase 5 confirmed this held:**
   Triggers.gs's `handleFormSubmit_` calls `createCase()` (the shared
   function) for both the verified and unresolved-submitter branches — no
   second hand-rolled write path was opened.

2. ~~**ADMINS sheet has zero code touching it today.**~~ **RESOLVED (Phase
   3).** AdminCommands.gs is now the real, and so far only, consumer —
   SetupSheets.gs's column order (TELEGRAM_ID, IS_SYSTEM_ADMIN, TIER, QUEUE)
   was verified to match AdminCommands.gs's reads/writes exactly.

3. **FAQ cache (6h TTL) has no invalidation hook.** Still true after Phase 3
   — no admin command reads or writes FAQ (AdminCommands.gs's command list
   has no FAQ-editing verb). Still fine today; still worth flagging if one
   gets proposed later.

4. **CASE_STATUS and CATEGORIES enums are the two contracts most likely to
   be silently violated by new code.** Re-checked against Phase 3's actual
   code and held: every AdminCommands.gs status write goes through
   `CASE_STATUS`, every category comparison goes through `CATEGORIES` (via
   CaseManager.gs's `casePrefixForCategory_` and AdminCommands.gs's
   `queueForCategory_`). No literal status/category strings found in
   AdminCommands.gs or MenuHandler.gs's new urgent-case code. **Re-checked
   again against Phase 5:** ArchiveManager.gs's `archivableCaseStatuses_`
   and Triggers.gs's `fileDocumentSubmissionCase_` both go through
   `CASE_STATUS`/`CATEGORIES` exclusively too — still held.

5. ~~**Config.gs's FORM_URLS is reached into directly by MenuHandler.gs
   today.**~~ **RESOLVED (Phase 4).** FormRouter.gs is now the sole reader of
   `FORM_URLS` anywhere in the codebase (confirmed by grep). MenuHandler.gs's
   `DOC_TYPES_` array is deleted; `showSubmitDocsMenu_`/`sendDocFormLink_`
   call `docTypeList_`/`formUrlForDocType_` instead.

6. ~~**Triggers.gs's exact case-matching key for onFormSubmit — PARTIALLY
   RESOLVED (Phase 4).**~~ **FULLY RESOLVED (Phase 5).** Decision: option (a)
   — forms stay case-independent. Each verified submission creates its OWN
   new case via `createCase(chatId, CATEGORIES.SUBMIT_DOCS, ...)` rather than
   linking to an existing CASES row; no case-linking field was added to any
   form. `handleFormSubmit_` reads the pre-filled "Telegram Chat ID" question
   straight off `e.namedValues`, exactly as forecast.

7. **checkPermission (Phase 3) and isVerified_ (built) are separate, parallel
   gates over separate sheets (ADMINS vs USERS/ROSTER) — don't merge them.**
   **Confirmed held** by reading the actual code: `checkPermission()` and
   `adminCanActOnCategory_()` only ever read the ADMINS sheet via
   `findAdminRow_`; neither calls `isVerified_()` anywhere in
   AdminCommands.gs. The one place the two systems touch at all is
   `/announce` reading UserSession.gs's `VERIFICATION_STATE` enum value for
   audience filtering (see USERS sheet contract above) — that's a shared
   *value*, not a shared *gate*, and doesn't blur the checkPermission /
   isVerified_ boundary this note was protecting.

8. **NEW — `queueForCategory_()`'s ALL-queue fallback means every case today
   is effectively unscoped.** Because `createCase()` is only ever invoked
   with `CATEGORIES.CONTACT_SUPPORT` (the deferred FAQ-category pass-through
   from PLAN.md's "Deferred, not forgotten" isn't built), every case in the
   CASES sheet falls through `queueForCategory_()`'s map to `ADMIN_QUEUE.ALL`.
   Practical effect: a Visa/Contract/Travel/Accommodation-queue admin who is
   *not* also System-Admin or All-queue can currently see and act on **zero**
   cases — `/cases`, `/urgent`, `/search`, `/case`, `/reply`, `/close`,
   `/assign`, `/note`, `/reopen` all gate on `adminCanActOnCategory_()`, which
   only passes for ALL-queue or System-Admin rows until real per-category
   cases exist. Whoever plans Phase 4/5 should treat "wire the originating
   FAQ category into createCase()" as effectively a prerequisite for
   queue-scoped admin roles to do anything at all, not just a nice-to-have —
   right now the queue model is built but structurally idle for anyone
   assigned a specific queue. **Phase 5 update:** `CATEGORIES.SUBMIT_DOCS`
   was deliberately added to this same ALL-queue bucket — `queueForCategory_`
   still has no SUBMIT_DOCS entry, by design (PLAN.md Phase 5 sub-decision 1:
   "no per-doc-type ADMIN_QUEUE value" — 4 of 7 doc types have no natural
   queue counterpart). The specific doc-type key is preserved in DETAIL
   ("Doc type: <key>") so an ALL-queue admin can still tell what was
   submitted even though it's unscoped. This doesn't make the underlying
   problem worse, but it does mean a second category now depends on the same
   still-unbuilt "originating category" fix before queue-scoped admins have
   anything to do.

9. **NEW — MenuHandler.gs (Phase 1) now calls into AdminCommands.gs (Phase
   3)** via `consumeUrgentCode_()`, a genuinely new "earlier phase depends on
   later phase" edge in this graph (previously the only comparable case was
   MenuHandler.gs ↔ QAEngine.gs's mutual calls within the same phase). Safe
   under Apps Script's file-concatenation/function-hoisting model — same
   reasoning CaseManager.gs's `casePrefixForCategory_` comment already
   documents — but worth recording explicitly so a future reader doesn't
   read the phase numbering as an implied load-order or layering rule that
   this edge appears to violate.

10. **NEW — Webhook.gs needed only one generic branch for all 15 admin
    commands, not one per command.** This file's earlier "planned modules"
    section for AdminCommands.gs predicted Webhook.gs would need a new
    text-command branch per command name. The actual implementation is a
    single `if (text.charAt(0) === '/' && routeAdminCommand_(chatId, text))`
    check — `routeAdminCommand_` owns the full `ADMIN_COMMAND_NAMES_` list
    and internal dispatch. Net effect: adding a 16th admin command later
    should require zero changes to Webhook.gs, only to AdminCommands.gs. Not
    a problem, just a discrepancy between what was forecast and what got
    built, worth knowing so nobody goes looking for per-command branches in
    Webhook.gs that don't exist.

11. ~~**NEW — `sendFormSubmissionConfirmation_` (FormRouter.gs, Phase 4) is
    written but has zero call sites today.**~~ **RESOLVED (Phase 5).**
    Triggers.gs's `fileDocumentSubmissionCase_` now calls it, exactly on the
    verified branch, right after `createCase()` succeeds — see FormRouter.gs
    and Triggers.gs entries above.

12. **the `FORM_CHAT_ID_ENTRY_IDS_` prefill design has a real gap: a "hidden
    field" isn't actually hidden.** FormRouter.gs's own header comment (and
    PLAN.md's Phase 4 "Progress" note) both describe the Telegram-Chat-ID
    field as a "pre-filled hidden field," but Google Forms' `entry.<id>=value`
    URL prefill mechanism only pre-populates a normal, visible, still-editable
    short-answer question — nothing stops a teacher from clearing/editing it,
    or opening the form via a saved/forwarded link with no prefill at all.
    **Resolved via option (a), Phase 5:** the field is now treated as
    advisory only — `fileDocumentSubmissionCase_` falls back to the
    "unresolved submitter" path (`createCase(..., {skipVerification: true})`
    with a sentinel `UNRESOLVED:` CHAT_ID) whenever the field is
    missing/edited/unverified, rather than trusting it or throwing. This is
    a real, working fallback, not just a documented risk — but see "Notable"
    #13 below for a gap in how that fallback's resulting CASES rows are
    handled downstream. Also still true: this field doesn't exist on any
    real form yet (`FORM_CHAT_ID_ENTRY_IDS_` is empty for every key) — see
    PLAN.md "Open items."

13. **RESOLVED (same day, independently caught by both the Oracle review and
    this pass) — AdminCommands.gs's `/reply`, `/close`, `/reopen` now guard
    against the `UNRESOLVED:` sentinel CHAT_ID.** All three previously called
    `sendMessage(c.CHAT_ID, ...)` unconditionally, silently failing against a
    sentinel while still reporting success to the admin. Fixed via a new
    shared `hasNotifiableChatId_(c)` helper in AdminCommands.gs (checks
    `String(c.CHAT_ID).indexOf('UNRESOLVED:') !== 0`) — all three handlers
    now skip the Telegram send and reply to the admin honestly ("no chat to
    notify — this is an unresolved submitter case") when it's false, mirroring
    `handleSheetEdit_`'s existing guard. Added to PLAN.md's Phase 5 "Progress"
    note.

14. **NEW — Script Properties key-prefix collision risk, low but real.**
    Phase 5 introduces two ad hoc Script Property key prefixes outside
    Config.gs's `PROP_KEYS` inventory: CaseManager.gs's
    `CASE_SEQ_<prefix>_<year>` and Triggers.gs's `FORM_DOC_TYPE_<formId>`.
    Checked against `PROP_KEYS` (BOT_TOKEN, WEBHOOK_SECRET, SPREADSHEET_ID,
    WEBAPP_URL) — no collision exists today. Nothing enforces this at
    runtime, though: Script Properties is a single flat namespace per
    project, so a future manually-set property (e.g. someone hand-adding a
    key during setup) that happens to start with either prefix would
    silently collide with a real counter/lookup. Not a bug today, just an
    unenforced convention worth remembering the next time a new persistent
    property is introduced.

15. **NEW (Phase 6) — SETTINGS sheet now has two independent read paths that
    happen not to collide today, but aren't protected from doing so.**
    ArchiveManager.gs's `getRetentionDays_()` (Phase 5) and AdminCommands.gs's
    `getSettingValue_()`/`setSettingValue_()` (Phase 6) each do their own
    `getDataRange()` + header-index-of-'KEY' scan over the same SETTINGS
    sheet, rather than the newer generic pair being reused by the older
    reader. Today this is safe — different KEY values (`RETENTION_DAYS` vs
    `MAINTENANCE_MODE`), both handle a missing row/sheet gracefully, and
    `getSettingValue_`/`setSettingValue_` are the only writer either way. Risk
    is specifically about future drift: a header-order change or a KEY
    rename would need to be applied in two places, and nothing would flag it
    if one got missed. Recommend, next time either file is touched for an
    unrelated reason, refactoring `getRetentionDays_()` to call
    `getSettingValue_('RETENTION_DAYS')` instead of re-scanning — low
    priority, not a Phase 6 blocker.

17. **RESOLVED same day — this item's original text (written by an earlier
    pass of this file) was already stale by the time it was published, due to
    a race between two concurrent updates to this file; corrected here on a
    direct re-check of the actual code.** `setSettingValue_` was flagged as
    an unlocked read-then-write, unlike every other read-modify-write path in
    this codebase (`CaseManager.gs`'s `updateCaseFields_`, `UserSession.gs`'s
    roster-match-then-bind, `Logger.gs`'s append — all `LockService`-protected
    per PLAN.md's Concurrency section). **Verified directly against
    AdminCommands.gs (lines 542-562): `setSettingValue_` now acquires
    `LockService.getScriptLock()` before its scan-then-write and releases it
    in a `finally` block, exactly the same pattern `updateCaseFields_` uses.**
    The concurrent-duplicate-KEY-row risk this item originally described no
    longer applies.

16. **NEW (Phase 6) — `my_chat_member` "added as admin vs added as member"
    edge case checked, confirmed handled correctly by the actual guard used.**
    Webhook.gs's leave-on-add logic checks
    `['left', 'kicked'].indexOf(myChatMember.new_chat_member.status) === -1`
    rather than checking for a specific "added" status — so it doesn't matter
    whether the bot lands in the chat with status `member`, `administrator`,
    or `restricted`; every non-left/non-kicked status triggers `leaveChat_`
    the same way. No gap found for the admin-vs-member case specifically.
    Two narrower things worth noting, not fixing: (a) Telegram's `leaveChat`
    API works the same regardless of the bot's own role in the chat, so being
    added as admin doesn't change whether the leave call itself succeeds;
    (b) `my_chat_member` also fires for private chats (e.g. a teacher
    blocking/unblocking the bot) — those never reach the leave-check because
    `chat.type === 'private'` skips the whole non-private branch, and
    `routeUpdate_` has no `message`/`callbackQuery` to act on in that case
    either, so a block/unblock event is a silent no-op today. That's
    consistent with the bot doing nothing special on block/unblock — not a
    bug, just worth knowing if a future phase ever wants to react to it (e.g.
    to stop retrying sends to a chat that blocked the bot).
