/**
 * Logger.gs — minimal interaction/error log, written to the MESSAGES sheet.
 * Called by every handler from Phase 1 onward so logging isn't bolted on later.
 * Kept deliberately dumb: one append per call, no reads, so it never becomes
 * the bottleneck under Apps Script quotas (proposal §8).
 *
 * Concurrency: Google Sheets has no row-level locking. Two webhook executions
 * racing on appendRow() (or any read-modify-write) can interleave and clobber
 * each other. LockService.getScriptLock() serializes access to the sheet for
 * the brief moment we're writing to it, which is Google's documented pattern
 * for exactly this problem. This is a solo append so the exposure is small,
 * but the same lock pattern is REQUIRED (not optional) in CaseManager.gs
 * (Phase 2) — case dedup does a read-then-write and a race there means two
 * teachers hitting "Contact Support" at the same moment can create duplicate
 * cases instead of being deduped.
 */

/**
 * Log one interaction.
 * @param {string|number} chatId  Telegram chat_id (identity, not PII beyond that)
 * @param {string} action         short machine-readable action name, e.g. 'MENU_VISA', 'CASE_CREATED'
 * @param {string} detail         free-text detail, kept short — never put full passport numbers,
 *                                 contract text, or other sensitive record content here (proposal §1.2, §7)
 */
function logInteraction(chatId, action, detail) {
  const lock = LockService.getScriptLock();
  let acquired = false;
  try {
    // NOTE: never call this from inside another LockService critical section.
    // Nested acquisition of the same script lock in one execution is not
    // documented as re-entrant, and the inner releaseLock() would drop the
    // outer caller's protection early. UserSession.gs's attemptVerify_ used
    // to do exactly that and now logs outside its lock instead.
    acquired = lock.tryLock(3000);
    if (!acquired) {
      console.error('logInteraction: could not acquire lock, dropping log row for chat ' + chatId);
      return;
    }
    const sheet = getSpreadsheet().getSheetByName(SHEETS.MESSAGES);
    if (!sheet) {
      console.error('logInteraction: MESSAGES sheet not found — run SetupSheets.createAllSheets() first');
      return;
    }
    sheet.appendRow([
      new Date(),
      chatId,
      action,
      detail || ''
    ]);
  } catch (err) {
    // Logging must never throw and break the calling handler.
    console.error('logInteraction failed: ' + err);
  } finally {
    // Only release a lock we actually took — releasing one we never acquired
    // is meaningless at best and can interfere with whoever does hold it.
    if (acquired) lock.releaseLock();
  }
}
