/**
 * CaseManager.gs — case creation, dedup, and lookup against the CASES sheet.
 * Pulled forward from Phase 2 (PLAN.md) so "Check My Case" and "Contact
 * Support" are functional alongside the rest of the Phase 1 menu, per
 * explicit build-order decision on 2026-07-26.
 *
 * Status levels are the 8 from the original proposal §3.5 (still valid —
 * neither PLAN.md nor proposal_gap_analysis.md redefines them).
 */

const CASE_STATUS = {
  NEW: 'New',
  RECEIVED: 'Received',
  UNDER_REVIEW: 'Under review',
  ACTION_REQUIRED: 'Action required',
  ESCALATED: 'Escalated',
  COMPLETED: 'Completed',
  CLOSED: 'Closed',
  DUPLICATE: 'Duplicate'
};

// Statuses that count as "still open" for dedup purposes.
const OPEN_CASE_STATUSES = [
  CASE_STATUS.NEW, CASE_STATUS.RECEIVED, CASE_STATUS.UNDER_REVIEW,
  CASE_STATUS.ACTION_REQUIRED, CASE_STATUS.ESCALATED
];

const CASE_DEDUP_WINDOW_HOURS = 24;

/**
 * Reference prefix per category, e.g. VISA-2026-00482 (proposal §3.1 example).
 * Built lazily inside a function, not as a top-level const, because Apps
 * Script concatenates .gs files and runs top-level code in filename order
 * ("CaseManager.gs" sorts before "Config.gs") — a top-level object built
 * from CATEGORIES would throw ReferenceError at load time. Safe here since
 * this only runs when a case is actually created, long after every file's
 * top-level code has finished running.
 */
function casePrefixForCategory_(category) {
  const map = {};
  map[CATEGORIES.VISA] = 'VISA';
  map[CATEGORIES.TRAVEL] = 'TRAVEL';
  map[CATEGORIES.CONTRACT] = 'CONTRACT';
  map[CATEGORIES.ACCOMMODATION] = 'ACCOM';
  map[CATEGORIES.CONTACT_SUPPORT] = 'SUPPORT';
  map[CATEGORIES.SUBMIT_DOCS] = 'DOCS'; // Phase 5: onFormSubmit files every doc-type key under this one category
  return map[category] || 'CASE';
}

function getCasesSheet_() {
  const sheet = getSpreadsheet().getSheetByName(SHEETS.CASES);
  if (!sheet) throw new Error('CASES sheet not found — run SetupSheets.createAllSheets() first');
  return sheet;
}

function getAllCaseRows_() {
  const values = getCasesSheet_().getDataRange().getValues();
  const headers = values.shift();
  return values.map((row, idx) => {
    const obj = { _rowNumber: idx + 2 };
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

/**
 * Persistent per-prefix-per-year sequence counter (Script Properties),
 * replacing the old CASES-sheet scan — resolves the Phase 5 CONFLICT
 * PLAN.md flagged: a sheet-scan-derived sequence under-counts (and can
 * reissue an already-used reference) the moment ArchiveManager.gs removes
 * current-year rows out of CASES mid-year. This function never re-scans
 * the sheet once a prefix/year has a stored counter, so it's unaffected by
 * archiving. Not itself lock-protected: it only ever runs from inside
 * createCase()'s existing LockService critical section, so it doesn't
 * need (and shouldn't try to acquire) a second lock.
 */
function nextCaseSequence_(prefix, year) {
  const props = PropertiesService.getScriptProperties();
  const key = 'CASE_SEQ_' + prefix + '_' + year;
  const stored = props.getProperty(key);
  // First use of this prefix/year since the persistent-counter switch (or
  // ever): seed from the sheet's current max so we never reissue a
  // reference that predates this counter. After this, the sheet is never
  // scanned again for this prefix/year, so archiving old rows is safe.
  const current = stored !== null ? parseInt(stored, 10) : maxExistingSequence_(prefix, year);
  const next = current + 1;
  props.setProperty(key, String(next));
  return next;
}

function maxExistingSequence_(prefix, year) {
  const re = new RegExp('^' + prefix + '-' + year + '-(\\d{5})$');
  let max = 0;
  getAllCaseRows_().forEach(r => {
    const m = re.exec(r.REFERENCE);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  });
  return max;
}

function generateCaseReference_(category) {
  const prefix = casePrefixForCategory_(category);
  const year = new Date().getFullYear();
  const seq = nextCaseSequence_(prefix, year);
  return prefix + '-' + year + '-' + String(seq).padStart(5, '0');
}

/**
 * Create a case, or return the existing open one if this chat_id already
 * has an open case in the same category within the dedup window.
 *
 * Dedup-check-then-create is a read-then-write, so it runs under a script
 * lock (PLAN.md "Concurrency" section) — without it, two near-simultaneous
 * submissions from different teachers (or double-taps from one) could race
 * past the dedup check and create duplicate cases.
 *
 * Defense in depth: refuses to create a case for a chat_id that isn't
 * roster-verified, even though MenuHandler.gs already gates the Contact
 * Support flow behind verification — PLAN.md treats "no case-creation for
 * unverified users" as a hard guardrail, not just a UI nicety.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.skipVerification] - Phase 5 only: used exclusively
 *   by Triggers.gs's "unresolved submitter" fallback, when a form's chat_id
 *   field is missing/edited/unverified and there is no real verified
 *   identity to check. chatId in that case is a sentinel string, not a real
 *   Telegram chat_id — see Triggers.gs's fileDocumentSubmissionCase_.
 * @returns {{reference: string, isNew: boolean}}
 */
function createCase(chatId, category, detail, opts) {
  opts = opts || {};
  if (!opts.skipVerification && !isVerified_(chatId)) {
    throw new Error('createCase: chat ' + chatId + ' is not verified');
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    throw new Error('createCase: could not acquire lock for chat ' + chatId);
  }
  try {
    const rows = getAllCaseRows_();
    const cutoff = new Date(Date.now() - CASE_DEDUP_WINDOW_HOURS * 60 * 60 * 1000);
    const existing = rows.filter(r =>
      String(r.CHAT_ID) === String(chatId) &&
      r.CATEGORY === category &&
      OPEN_CASE_STATUSES.indexOf(r.STATUS) !== -1 &&
      new Date(r.CREATED_AT) >= cutoff
    )[0];
    if (existing) {
      return { reference: existing.REFERENCE, isNew: false };
    }

    const reference = generateCaseReference_(category);
    const now = new Date();
    getCasesSheet_().appendRow([
      reference, category, chatId, CASE_STATUS.NEW, '',
      now, now, detail || '', ''
    ]);
    return { reference: reference, isNew: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Cases for one teacher, newest first. Only the fields safe to surface to
 * the teacher (reference, category, status, public update) are ever read
 * here — DETAIL can hold sensitive free text and must never be echoed back
 * through Check My Case (guardrail, PLAN.md Phase 2 "case half").
 */
function getCasesForChatId(chatId) {
  return getAllCaseRows_()
    .filter(r => String(r.CHAT_ID) === String(chatId))
    .sort((a, b) => new Date(b.CREATED_AT) - new Date(a.CREATED_AT))
    .map(r => ({
      reference: r.REFERENCE,
      category: r.CATEGORY,
      status: r.STATUS,
      publicUpdate: r.PUBLIC_UPDATE || ''
    }));
}

/** Full row for one case, or null. Callers needing admin-facing detail
 * (DETAIL included) should use this rather than getCasesForChatId, which
 * deliberately strips DETAIL. */
function findCaseByReference_(reference) {
  return getAllCaseRows_().find(r => r.REFERENCE === reference) || null;
}

/**
 * Read-only filtered scan, shared by every future caller that needs to list
 * cases by some combination of status/category/owner/chat_id (Phase 3's
 * /cases, /urgent, /search) instead of each command hand-rolling its own
 * sheet scan — flagged as a "recommend" item in DEPENDENCY_TREE.md.
 *
 * @param {Object} [filter]
 * @param {string} [filter.status]    exact status match
 * @param {boolean} [filter.openOnly] any non-terminal status (see
 *   OPEN_CASE_STATUSES). Used by /cases, which proposal §6 defines as
 *   "show OPEN cases" — it previously listed closed and completed ones too.
 */
function findCasesBy_(filter) {
  filter = filter || {};
  return getAllCaseRows_()
    .filter(r => !filter.status || r.STATUS === filter.status)
    .filter(r => !filter.openOnly || OPEN_CASE_STATUSES.indexOf(r.STATUS) !== -1)
    .filter(r => !filter.category || r.CATEGORY === filter.category)
    .filter(r => !filter.owner || String(r.OWNER) === String(filter.owner))
    .filter(r => !filter.chatId || String(r.CHAT_ID) === String(filter.chatId))
    .sort((a, b) => new Date(b.CREATED_AT) - new Date(a.CREATED_AT));
}

// Columns a caller is allowed to write via updateCaseFields_. REFERENCE,
// CATEGORY, CHAT_ID and CREATED_AT are identity/history and must never be
// rewritten after creation; UPDATED_AT is set automatically below, not
// passed in by callers.
const CASE_UPDATABLE_FIELDS_ = ['STATUS', 'OWNER', 'DETAIL', 'PUBLIC_UPDATE', 'LAST_ACTOR'];

// How long a programmatic write is "remembered" so Phase 5's onEdit trigger
// can tell it apart from a genuine manual sheet edit and skip notifying the
// candidate a second time (PLAN.md Phase 5 onEdit CONFLICT resolution).
// setValue() calls fire onEdit synchronously, so a few seconds of TTL is
// generous, not tight.
const ONEDIT_SUPPRESS_TTL_SECONDS_ = 60;

function onEditSuppressKey_(reference) {
  return 'suppress_onedit_' + reference;
}

/**
 * Shared read-modify-write for any path that mutates an existing CASES row —
 * Phase 3's /assign /reply /note /close /reopen and (per PLAN.md's explicit
 * note) Phase 5's onFormSubmit/onEdit. One function owns the column layout
 * and the lock discipline instead of each caller hand-rolling a sheet write
 * with its own (possibly inconsistent) locking — PLAN.md's Phase 3 oracle
 * note and DEPENDENCY_TREE.md finding #1 both call this out explicitly.
 *
 * @param {string} reference
 * @param {Object} fields - subset of CASE_UPDATABLE_FIELDS_ to overwrite
 * @returns {boolean} always true — a missing reference THROWS rather than
 *   returning false, so callers never need to branch on the return value.
 *   (The old signature documented a false return that could not occur.)
 * @throws if the reference doesn't exist, a field isn't updatable, or the
 *   lock can't be acquired.
 */
function updateCaseFields_(reference, fields, opts) {
  Object.keys(fields).forEach(key => {
    if (CASE_UPDATABLE_FIELDS_.indexOf(key) === -1) {
      throw new Error('updateCaseFields_: field not updatable: ' + key);
    }
  });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    throw new Error('updateCaseFields_: could not acquire lock for ' + reference);
  }
  try {
    const sheet = getCasesSheet_();
    const values = sheet.getDataRange().getValues();
    const headers = values[0];
    const refCol = headers.indexOf('REFERENCE');
    for (let i = 1; i < values.length; i++) {
      if (values[i][refCol] === reference) {
        const rowNumber = i + 1;
        CacheService.getScriptCache().put(onEditSuppressKey_(reference), '1', ONEDIT_SUPPRESS_TTL_SECONDS_);
        Object.keys(fields).forEach(key => {
          sheet.getRange(rowNumber, headers.indexOf(key) + 1).setValue(fields[key]);
        });
        sheet.getRange(rowNumber, headers.indexOf('UPDATED_AT') + 1).setValue(new Date());
        // Column is absent on a sheet that predates this change — skip rather
        // than throw, so an un-migrated deployment still works.
        const actorCol = headers.indexOf('LAST_ACTOR');
        if (actorCol !== -1 && fields.LAST_ACTOR === undefined && opts && opts.actor) {
          sheet.getRange(rowNumber, actorCol + 1).setValue(String(opts.actor));
        }
        return true;
      }
    }
    throw new Error('updateCaseFields_: no case found with reference ' + reference);
  } finally {
    lock.releaseLock();
  }
}
