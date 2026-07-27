/**
 * UserSession.gs — identity binding via roster-matched two-factor check.
 * Pulled forward from Phase 2 (PLAN.md) because case creation/lookup
 * ("Check My Case", "Contact Support") needs identity to be safe, and the
 * plan's "Accepted risk" section explicitly rejected chat_id-only identity:
 * a bare chat_id would let anyone who reaches the bot create a case.
 *
 * Flow: on first contact, the chat is asked for a roster identifier (email
 * or one-time code from the teacher's offer/contract paperwork). It's
 * checked against the ROSTER sheet (seeded by hand/CSV import — see
 * PLAN.md "Open items"). Only a match binds chat_id -> USERS row with
 * VERIFICATION_STATE = VERIFIED. No match = "contact HR" message, no bind,
 * no menu.
 *
 * PRIVACY (proposal §7, "collect only information necessary"): the
 * identifier a teacher types is an email address. It is never written to the
 * MESSAGES log in full — the authoritative copy already lives in their USERS
 * row, so logging it again only widens exposure. Failed attempts log a
 * redacted hint (enough to debug a typo, not enough to harvest addresses)
 * and successes log nothing beyond the chat_id the log row already carries.
 */

const VERIFICATION_STATE = {
  VERIFIED: 'VERIFIED'
};

// isVerified_ is called several times per interaction (menu gate, resume
// path, createCase's defence-in-depth check) and each call previously read
// the entire USERS sheet. Only the POSITIVE result is cached: verification
// never flips back to unverified in this codebase, so a cached "yes" can't
// go stale, whereas caching "no" would lock a teacher out for the TTL
// immediately after they successfully verified.
const VERIFIED_CACHE_TTL_SECONDS_ = 30 * 60;

/**
 * Cached "verified" markers are namespaced by an epoch so they can all be
 * invalidated at once. Triggers.gs's onEdit handler covers a VERIFICATION_STATE
 * cell being cleared, but onEdit does NOT fire when a row is DELETED — and
 * deleting the USERS row was the revocation method this file's comments
 * promised would work. onChange does fire on deletion, but it reports neither
 * the sheet nor the row, so a blanket invalidation is the only correct
 * response; bumping the epoch is that, at O(1) cost.
 */
const VERIFY_EPOCH_PROP_ = 'VERIFY_EPOCH';

// Memoized per execution. An Apps Script execution handles a single update, so
// this costs at most one PropertiesService read per interaction — far cheaper
// than the USERS sheet read the cache exists to avoid.
let VERIFY_EPOCH_MEMO_ = null;

function verificationEpoch_() {
  if (VERIFY_EPOCH_MEMO_ !== null) return VERIFY_EPOCH_MEMO_;
  try {
    VERIFY_EPOCH_MEMO_ = PropertiesService.getScriptProperties().getProperty(VERIFY_EPOCH_PROP_) || '0';
  } catch (err) {
    console.error('verificationEpoch_ read failed (treating as epoch 0): ' + err);
    VERIFY_EPOCH_MEMO_ = '0';
  }
  return VERIFY_EPOCH_MEMO_;
}

/** Invalidate every cached "verified" marker at once. */
function bumpVerificationEpoch_() {
  try {
    PropertiesService.getScriptProperties().setProperty(VERIFY_EPOCH_PROP_, String(Date.now()));
    VERIFY_EPOCH_MEMO_ = null;
  } catch (err) {
    console.error('bumpVerificationEpoch_ failed: ' + err);
  }
}

function verifiedCacheKey_(chatId) {
  return 'verified_' + verificationEpoch_() + '_' + chatId;
}

function getUsersSheet_() {
  const sheet = getSpreadsheet().getSheetByName(SHEETS.USERS);
  if (!sheet) throw new Error('USERS sheet not found — run SetupSheets.createAllSheets() first');
  return sheet;
}

function findUserRow_(chatId) {
  const values = getUsersSheet_().getDataRange().getValues();
  if (values.length < 2) return null;
  const headers = values.shift();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(chatId)) {
      const obj = { _rowNumber: i + 2 };
      headers.forEach((h, c) => { obj[h] = values[i][c]; });
      return obj;
    }
  }
  return null;
}

function isVerified_(chatId) {
  try {
    if (CacheService.getScriptCache().get(verifiedCacheKey_(chatId))) return true;
  } catch (err) {
    console.error('isVerified_ cache read failed (falling through to sheet): ' + err);
  }
  const row = findUserRow_(chatId);
  const verified = !!row && row.VERIFICATION_STATE === VERIFICATION_STATE.VERIFIED;
  if (verified) {
    try {
      CacheService.getScriptCache().put(verifiedCacheKey_(chatId), '1', VERIFIED_CACHE_TTL_SECONDS_);
    } catch (err) {
      console.error('isVerified_ cache write failed (harmless): ' + err);
    }
  }
  return verified;
}

/** Drop a cached "verified" marker — call after any change that could revoke
 * access (e.g. a row removed from USERS by hand). */
function invalidateVerifiedCache_(chatId) {
  try {
    CacheService.getScriptCache().remove(verifiedCacheKey_(chatId));
  } catch (err) {
    console.error('invalidateVerifiedCache_ failed: ' + err);
  }
}

function findRosterRowByIdentifier_(identifier) {
  const sheet = getSpreadsheet().getSheetByName(SHEETS.ROSTER);
  if (!sheet) return null;
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return null;
  const headers = values.shift();
  const needle = String(identifier || '').trim().toLowerCase();
  if (!needle) return null;
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim().toLowerCase() === needle) {
      const obj = {};
      headers.forEach((h, c) => { obj[h] = values[i][c]; });
      return obj;
    }
  }
  return null;
}

/**
 * Enough of the submitted identifier to diagnose a typo, not enough to
 * reconstruct it. An email keeps its domain (useful: "they used their
 * personal address, not the one on the roster") but loses the local part.
 */
function redactIdentifier_(identifier) {
  const s = String(identifier || '').trim();
  if (!s) return '(empty)';
  const at = s.indexOf('@');
  if (at > 0) return s.charAt(0) + '***@' + s.slice(at + 1);
  if (s.length <= 2) return '**';
  return s.charAt(0) + '***' + s.charAt(s.length - 1);
}

/**
 * Sends the "please verify" prompt. Whether the next text message is
 * treated as an identifier attempt is decided by the caller (Webhook.gs)
 * from isVerified_() — not from any ephemeral flag here — since a cache
 * flag can expire mid-conversation and leave routing with no reliable
 * signal for what the next message means.
 */
function startVerification_(chatId) {
  sendMessage(chatId,
    'Welcome to the MoPSE Teacher Support Bot. To open a case or check an existing one, please reply with ' +
    'the email address or one-time code from your offer/contract paperwork so we can verify you.\n\n' +
    PRIVACY_NOTICE_TEXT + '\n\n' +
    'Replying with your identifier confirms you have read this. Type /privacy at any time to see it again.');
}

/**
 * Roster-match-then-bind is a read-then-write, so it runs under a script
 * lock (PLAN.md "Concurrency" section) — otherwise two near-simultaneous
 * /start attempts with the same identifier could both succeed in binding.
 *
 * Everything that is NOT part of that critical section — logging and the
 * Telegram replies — happens after the lock is released. logInteraction()
 * takes the script lock itself, and nesting the same script lock inside this
 * one risked the inner releaseLock() dropping this function's protection
 * early. Sending Telegram messages under a lock is also just wasteful: it
 * held a global lock across a network round-trip on every verification.
 */
/**
 * @returns {string} one of 'VERIFIED' | 'NO_MATCH' | 'ERROR' | 'BUSY'.
 *
 * The transient outcomes ('ERROR', 'BUSY') explain themselves to the teacher
 * here. 'NO_MATCH' deliberately does NOT — the caller (MenuHandler.gs) tracks
 * how many attempts have been made and so is the only place that knows whether
 * to invite another try or stop, and a message sent from both places would
 * double up on the final attempt.
 */
function attemptVerify_(chatId, identifierText) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    sendMessage(chatId, 'Please try again in a moment.');
    return 'BUSY';
  }

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

  if (bindError) {
    sendMessage(chatId, 'Something went wrong verifying you — please try again in a moment.');
    return 'ERROR';
  }

  if (!rosterRow) {
    logInteraction(chatId, 'VERIFY_FAILED', 'identifier ' + redactIdentifier_(identifierText));
    return 'NO_MATCH';
  }

  // No identifier in the log line — the chat_id column already identifies
  // the row, and the identifier itself is stored once, in USERS.
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
  // The main menu is NOT sent from here. When verification was triggered by a
  // menu button the caller resumes that action instead, and sending the menu
  // in between produced three messages back to back with the middle one
  // ("Choose a topic") contradicting the prompt that immediately followed it.
  return 'VERIFIED';
}

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
  // Make the new "verified" state visible to isVerified_ immediately rather
  // than waiting for its own read — the resume path in MenuHandler.gs calls
  // isVerified_ within milliseconds of this returning.
  try {
    CacheService.getScriptCache().put(verifiedCacheKey_(chatId), '1', VERIFIED_CACHE_TTL_SECONDS_);
  } catch (err) {
    console.error('bindUser_ cache write failed (harmless): ' + err);
  }

  return otherHolders;
}

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
