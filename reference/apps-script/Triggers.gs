/**
 * Triggers.gs — Phase 5: onFormSubmit (files a case from a document
 * submission), onEdit (proactive notification for genuine manual sheet
 * edits only), and the time-driven archive trigger.
 *
 * Both onEdit and onFormSubmit MUST run as installable triggers, never as
 * the reserved simple-trigger function names `onEdit(e)`/`onFormSubmit(e)`
 * — simple triggers run in restricted auth mode and cannot call
 * UrlFetchApp, so a simple trigger would silently fail to notify a
 * candidate over Telegram (PLAN.md "Concurrency" section). installTriggers()
 * below is a one-time manual run, same pattern as SetWebhook.gs's
 * setWebhook() and SetupSheets.gs's createAllSheets().
 *
 * Handler names deliberately do NOT end in an underscore. Apps Script treats
 * a trailing underscore as "private" and excludes such functions from the
 * editor's Run menu and from client-side calls; binding triggers to them is
 * not documented as supported. The three handlers registered below are
 * therefore public-named (handleSheetEdit / runArchive / handleFormSubmit)
 * while their internal helpers keep the underscore convention.
 *
 * onFormSubmit's installation is intentionally NOT part of installTriggers():
 * binding an onFormSubmit trigger to a specific Google Form requires that
 * form's real Form ID (from its edit URL), and none of the 7 doc-type forms
 * exist yet — FORM_URLS (Config.gs) is still placeholders (PLAN.md "Open
 * items"). installFormSubmitTrigger() below is the one-time call to make,
 * once per real form, when that day comes.
 */

function installTriggers() {
  removeExistingTriggers_(['handleSheetEdit', 'runArchive', 'handleSheetChange', 'runDailyDigest',
    'handleSheetEdit_', 'runArchive_']);
  const ss = getSpreadsheet();
  ScriptApp.newTrigger('handleSheetEdit').forSpreadsheet(ss).onEdit().create();
  // onEdit does not fire on row DELETION, which is exactly how an operator
  // would expect to revoke a teacher's access. onChange does — see
  // handleSheetChange below.
  ScriptApp.newTrigger('handleSheetChange').forSpreadsheet(ss).onChange().create();
  // Apps Script's time-driven trigger builder tops out at 15-day intervals;
  // "bi-monthly" (ambiguous — twice a month, or every two months) is
  // implemented as every 14 days as a working default. Adjust once the
  // retention/cadence policy is actually decided (PLAN.md "Open items").
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

function removeExistingTriggers_(handlerNames) {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (handlerNames.indexOf(t.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(t);
    }
  });
}

// ---- onFormSubmit ----

// Every real Google Form must have a short-answer question titled exactly
// this, pre-filled via FormRouter.gs's FORM_CHAT_ID_ENTRY_IDS_ mechanism —
// see that file's header comment for the full design (and its caveat: this
// is a normal editable field, not a hidden one, so it's a best-effort
// resolution, not a guarantee — see fileDocumentSubmissionCase_ below).
const TELEGRAM_CHAT_ID_QUESTION_TITLE_ = 'Telegram Chat ID';

/**
 * Run once per real Google Form, after that doc type's FORM_URLS entry and
 * FORM_CHAT_ID_ENTRY_IDS_ entry (FormRouter.gs) are filled in. Stores the
 * form -> docKey mapping in Script Properties since the onFormSubmit event
 * itself carries no doc-type information beyond which form fired it.
 *
 * Public name (no trailing underscore) on purpose: this is meant to be run by
 * hand, and Apps Script hides underscore-suffixed functions from the editor's
 * Run menu. It takes arguments, which the Run menu can't supply, so call it
 * from a throwaway wrapper — e.g.
 *   function installVisaForm() { installFormSubmitTrigger('1AbC...', 'VISA'); }
 * — and run that.
 */
function installFormSubmitTrigger(formId, docKey) {
  const form = FormApp.openById(formId);
  ScriptApp.newTrigger('handleFormSubmit').forForm(form).onFormSubmit().create();
  PropertiesService.getScriptProperties().setProperty('FORM_DOC_TYPE_' + formId, docKey);
}

/**
 * Pull the Telegram chat ID out of a form-submit event.
 *
 * The two form-submit trigger flavours hand over COMPLETELY DIFFERENT event
 * objects, and this is where the previous version was broken:
 *
 *   - Form-bound   (ScriptApp.newTrigger(...).forForm(...)):
 *       { authMode, response, source, triggerUid }   ← NO namedValues
 *   - Sheet-bound  (ScriptApp.newTrigger(...).forSpreadsheet(...)):
 *       { authMode, namedValues, range, values, triggerUid }
 *
 * installFormSubmitTrigger binds .forForm(), so the old
 * `e.namedValues[TELEGRAM_CHAT_ID_QUESTION_TITLE_]` read was always
 * undefined. Every submission — including a correctly pre-filled one from a
 * verified teacher — therefore fell into the "unresolved submitter"
 * fallback, silently, with no confirmation ever sent. The FormResponse path
 * below is the correct one for a form-bound trigger; namedValues is kept as
 * a fallback so a sheet-bound binding also works if anyone sets one up.
 */
function resolveChatIdFromFormEvent_(e) {
  try {
    if (e && e.response && typeof e.response.getItemResponses === 'function') {
      const items = e.response.getItemResponses();
      for (let i = 0; i < items.length; i++) {
        const title = String(items[i].getItem().getTitle() || '').trim();
        if (title === TELEGRAM_CHAT_ID_QUESTION_TITLE_) {
          const answer = items[i].getResponse();
          return String(Array.isArray(answer) ? (answer[0] || '') : (answer || '')).trim();
        }
      }
    }
  } catch (err) {
    console.error('resolveChatIdFromFormEvent_: FormResponse read failed: ' + err);
  }

  try {
    if (e && e.namedValues) {
      const v = e.namedValues[TELEGRAM_CHAT_ID_QUESTION_TITLE_];
      if (v && v.length) return String(v[0] || '').trim();
    }
  } catch (err) {
    console.error('resolveChatIdFromFormEvent_: namedValues read failed: ' + err);
  }

  return '';
}

function handleFormSubmit(e) {
  try {
    const sourceId = e && e.source && typeof e.source.getId === 'function' ? e.source.getId() : '';
    if (!sourceId) {
      console.error('handleFormSubmit: event has no identifiable source — cannot map to a doc type.');
      return;
    }
    const docKey = PropertiesService.getScriptProperties().getProperty('FORM_DOC_TYPE_' + sourceId);
    if (!docKey) {
      console.error('handleFormSubmit: no doc type registered for source ' + sourceId + ' — run installFormSubmitTrigger for it first.');
      return;
    }
    const chatIdRaw = resolveChatIdFromFormEvent_(e);
    let formResponseId = '';
    try {
      formResponseId = e.response && typeof e.response.getId === 'function' ? e.response.getId() : '';
    } catch (err) {
      formResponseId = '';
    }
    fileDocumentSubmissionCase_(chatIdRaw, docKey, formResponseId);
  } catch (err) {
    console.error('handleFormSubmit failed: ' + err);
  }
}

/**
 * PLAN.md Phase 5 CONFLICT resolution, sub-decisions 2+3: the chat_id field
 * is a normal editable form question, not a binding identity, so it's only
 * trusted when it resolves to an already roster-verified chat_id. Anything
 * else (blank, edited to nonsense, or a chat_id that was never verified)
 * files as an "unresolved submitter" case instead of throwing — via
 * createCase()'s skipVerification bypass — so nothing is silently dropped,
 * it just needs an ALL-queue/System Admin to triage it.
 */
function fileDocumentSubmissionCase_(chatIdRaw, docKey, formResponseId) {
  const chatId = String(chatIdRaw || '').trim();
  if (chatId && isVerified_(chatId)) {
    const result = createCase(chatId, CATEGORIES.SUBMIT_DOCS, 'Doc type: ' + docKey);
    if (result.isNew) {
      sendFormSubmissionConfirmation_(chatId, docKey);
      notifyAdminsOfNewCase_(result.reference, false);
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
  // No sendFormSubmissionConfirmation_ here — there is no verified chat_id
  // to send it to. Accepted gap (PLAN.md Phase 5): an unresolved submitter
  // isn't notified because there's no verified chat to notify.
  // An unresolved submitter cannot be notified, which makes telling an admin
  // more important here than anywhere else — this case can only be triaged
  // by a human who knows it exists.
  // The unresolved row's CHAT_ID is an UNRESOLVED: sentinel; regionForCaseChatId_
  // returns '' for it, which adminCoversRegion_ treats as "do not hide from
  // anyone" — an unresolved case has no region to scope by and most needs a
  // human to find it.
  if (unresolved.isNew) notifyAdminsOfNewCase_(unresolved.reference, false);
}

// ---- onEdit ----

/**
 * PLAN.md Phase 5 CONFLICT resolution: Phase 3's AdminCommands.gs already
 * notifies the candidate directly for /reply /close /reopen, so this must
 * skip any edit that was actually made by updateCaseFields_() (CaseManager.gs
 * sets a short-lived suppress marker right before writing) and only notify
 * on a genuine manual edit made directly in the spreadsheet UI.
 *
 * Also handles FAQ edits: an approved content correction would otherwise sit
 * behind the 6-hour FAQ cache TTL before any teacher saw it.
 */
function handleSheetEdit(e) {
  try {
    if (!e || !e.range) return;
    const sheet = e.range.getSheet();
    const sheetName = sheet.getName();

    if (sheetName === SHEETS.FAQ) {
      clearFaqCache();
      return;
    }

    // The bot's role model is subordinate to Google Drive sharing: anyone who
    // can edit this spreadsheet can make themselves a System Admin, and no code
    // here can stop them. It can make it loud, which is most of the value.
    if (sheetName === SHEETS.ADMINS) {
      notifyAdminsOfAdminSheetEdit_(e);
      return;
    }

    // isVerified_ caches a positive result for 30 minutes, so revoking access
    // by hand would otherwise keep working for up to that long. Editing a
    // USERS row (e.g. clearing VERIFICATION_STATE) drops that chat's cached
    // marker immediately, here. Row DELETION does not reach this handler at
    // all — onEdit never fires for it — and is covered by handleSheetChange
    // below instead. Earlier comments here claimed deletion was handled by
    // this branch; it was not.
    // An edit can span many rows and columns — pasting a block of updates is
    // the normal admin workflow. Reading only e.range.getRow()/getColumn()
    // handled exactly one cell of it and silently ignored the rest.
    const firstRow = e.range.getRow();
    const lastRow = firstRow + e.range.getNumRows() - 1;
    const firstCol = e.range.getColumn();
    const lastCol = firstCol + e.range.getNumColumns() - 1;

    if (sheetName === SHEETS.USERS) {
      const userHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      const chatIdCol = userHeaders.indexOf('CHAT_ID');
      if (chatIdCol === -1) return;
      for (let r = Math.max(firstRow, 2); r <= lastRow; r++) {
        const editedChatId = sheet.getRange(r, chatIdCol + 1).getValue();
        if (editedChatId) invalidateVerifiedCache_(editedChatId);
      }
      return;
    }

    if (sheetName !== SHEETS.CASES) return;
    if (lastRow < 2) return; // header row only

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const refCol = headers.indexOf('REFERENCE');
    if (refCol === -1) return;

    let touchesNotifiableColumn = false;
    for (let c = firstCol; c <= lastCol; c++) {
      const name = headers[c - 1];
      if (name === 'STATUS' || name === 'PUBLIC_UPDATE') { touchesNotifiableColumn = true; break; }
    }
    if (!touchesNotifiableColumn) return;

    // A very large paste would otherwise try to send one Telegram message per
    // row inside a single onEdit execution and hit the 6-minute limit partway,
    // notifying an arbitrary prefix of the block.
    const rowCount = lastRow - Math.max(firstRow, 2) + 1;
    if (rowCount > MAX_EDIT_NOTIFY_ROWS_) {
      console.error('handleSheetEdit: edit spans ' + rowCount + ' rows, over the ' +
        MAX_EDIT_NOTIFY_ROWS_ + '-row notification cap — no messages sent. Use /reply or ' +
        'edit in smaller blocks so each teacher is notified.');
      return;
    }

    for (let r = Math.max(firstRow, 2); r <= lastRow; r++) {
      notifyCaseRowEdited_(sheet, headers, refCol, r);
    }
  } catch (err) {
    console.error('handleSheetEdit failed: ' + err);
  }
}

const MAX_EDIT_NOTIFY_ROWS_ = 50;

function notifyCaseRowEdited_(sheet, headers, refCol, rowNumber) {
  const reference = sheet.getRange(rowNumber, refCol + 1).getValue();
  if (!reference) return;
  // Programmatic write from updateCaseFields_ — its caller already notified.
  if (CacheService.getScriptCache().get(onEditSuppressKey_(reference))) return;

  const c = findCaseByReference_(reference);
  if (!c || !c.CHAT_ID || String(c.CHAT_ID).indexOf('UNRESOLVED:') === 0) return; // no real chat to notify

  const result = sendMessage(c.CHAT_ID, 'Update on your case ' + reference + ': status is now ' + c.STATUS + (c.PUBLIC_UPDATE ? ' — ' + c.PUBLIC_UPDATE : ''));
  logInteraction(c.CHAT_ID, result.ok ? 'CASE_MANUAL_EDIT_NOTIFIED' : 'CASE_MANUAL_EDIT_NOTIFY_FAILED', reference);
}

// ---- onChange (structural edits onEdit cannot see) ----

/**
 * onEdit fires for cell edits only. Deleting a row — the obvious way to revoke
 * a teacher's access by hand — never reaches handleSheetEdit, so a deleted
 * USERS row left that chat verified for up to VERIFIED_CACHE_TTL_SECONDS_
 * (30 minutes) despite the code claiming otherwise.
 *
 * onChange does fire on deletion, but its event carries neither the affected
 * sheet nor the affected row — only a changeType. Blanket invalidation is
 * therefore the only correct response, which is what bumping the verification
 * epoch does (UserSession.gs). It is O(1) and costs a re-read of the USERS
 * sheet on each chat's next interaction, which is the safe direction to err.
 */
function handleSheetChange(e) {
  try {
    const changeType = e && e.changeType;
    if (changeType === 'REMOVE_ROW' || changeType === 'REMOVE_GRID' || changeType === 'OTHER') {
      bumpVerificationEpoch_();
    }
  } catch (err) {
    console.error('handleSheetChange failed: ' + err);
  }
}

// ---- Archive (time-driven) ----

function runArchive() {
  runArchiveManager_();
  sweepExpiredUrgentCodes_();
}

// e.user.getEmail() returns a value only when the editing account is in the
// same Workspace domain as the script owner. Outside that it is blank, which is
// itself worth knowing — an edit from an unidentifiable account is more
// suspicious, not less.
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
