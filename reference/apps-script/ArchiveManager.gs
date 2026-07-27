/**
 * ArchiveManager.gs — Phase 5: archives old CASES rows and MESSAGES log
 * entries into lazily-created "<SHEET>_ARCHIVE" tabs in the same
 * spreadsheet, once they're older than a retention period.
 *
 * Retention period is a genuine open business decision (PLAN.md "Blocking
 * decision", proposal §7) — not invented here. It's read from the SETTINGS
 * sheet (KEY = 'RETENTION_DAYS'), the same placeholder-until-decided
 * pattern Config.gs already uses for FORM_URLS/SUPPORT_CONTACT_INFO, rather
 * than a hardcoded number that would silently encode an undecided policy
 * as fact. Until someone sets that row, runArchiveManager_ logs and exits
 * without touching any sheet.
 *
 * Writes are BATCHED (one setValues for the archive block, contiguous
 * deleteRows runs for the source) rather than row-by-row appendRow +
 * deleteRow. Proposal §8 asks explicitly to "write records in batches where
 * possible"; row-at-a-time also risked hitting the 6-minute execution limit
 * partway through a large sweep, leaving rows copied but not deleted.
 *
 * Uploaded document files (Drive) are explicitly OUT of scope here: this
 * bot never touches Drive directly — submitted files land in whatever
 * folder each real Google Form is configured to use, and this project has
 * no Form IDs yet to even look that folder up (same "forms don't exist
 * yet" blocker as Triggers.gs's onFormSubmit binding). Purging old files
 * is deferred until real forms exist and their Drive folders are known —
 * see PLAN.md "Open items". This function only ever archives sheet rows.
 */

// Built lazily inside a function, not as a top-level const, for the same
// load-order reason CaseManager.gs's casePrefixForCategory_ documents:
// "ArchiveManager.gs" sorts before "CaseManager.gs" alphabetically, so
// CASE_STATUS wouldn't exist yet if this ran at top-level load time.
function archivableCaseStatuses_() {
  return [CASE_STATUS.CLOSED, CASE_STATUS.COMPLETED, CASE_STATUS.DUPLICATE];
}

function getRetentionDays_() {
  const raw = getSettingValue_('RETENTION_DAYS');
  const n = parseInt(raw, 10);
  return isNaN(n) || n <= 0 ? null : n;
}

function runArchiveManager_() {
  let retentionDays;
  try {
    retentionDays = getRetentionDays_();
  } catch (err) {
    console.error('runArchiveManager_: could not read SETTINGS — skipping. ' + err);
    return;
  }
  if (!retentionDays) {
    console.error('runArchiveManager_: no positive RETENTION_DAYS set in SETTINGS sheet — skipping. See PLAN.md "Blocking decision".');
    return;
  }
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  withArchiveLock_('CASES', function () { archiveOldCases_(cutoff); });
  withArchiveLock_('MESSAGES', function () { archiveOldMessages_(cutoff); });
}

/**
 * Archiving is a read-then-delete over the same sheets that live webhook
 * executions are writing to, and this file previously took no lock at all —
 * the half of review item C15 that never landed.
 *
 * The exposure is real: CaseManager.updateCaseFields_ takes a snapshot read
 * and then writes BY ROW INDEX under the script lock. A deleteRows landing
 * between that read and that write shifts every row beneath it up, so the
 * write lands on the wrong case — silently, with no error anywhere. Logger.gs
 * appending to MESSAGES concurrently is the same shape of race.
 *
 * The lock is taken per sheet rather than once around the whole sweep, so a
 * long CASES pass doesn't hold up webhook logging while MESSAGES is still to
 * be processed. Failing to acquire it is not an error worth retrying inline:
 * the trigger runs again on its own schedule.
 *
 * NOTE: nothing called from inside here may call logInteraction() — that takes
 * the same script lock, and nested acquisition is not documented as re-entrant
 * (see Logger.gs). The archive helpers use the built-in Logger.log instead.
 */
const ARCHIVE_LOCK_TIMEOUT_MS_ = 30 * 1000;

function withArchiveLock_(label, fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(ARCHIVE_LOCK_TIMEOUT_MS_)) {
    console.error('withArchiveLock_: could not acquire the script lock for ' + label +
      ' — skipping this pass. The next scheduled run will pick it up.');
    return;
  }
  try {
    fn();
  } catch (err) {
    console.error('withArchiveLock_: ' + label + ' pass failed: ' + err);
  } finally {
    lock.releaseLock();
  }
}

function getOrCreateArchiveSheet_(sourceSheet) {
  const ss = getSpreadsheet();
  const name = sourceSheet.getName() + '_ARCHIVE';
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    const headerRow = sourceSheet.getRange(1, 1, 1, sourceSheet.getLastColumn()).getValues();
    sheet.getRange(1, 1, 1, headerRow[0].length).setValues(headerRow);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Copy `rows` into the archive tab in a single write, then remove the
 * corresponding source rows. `rowNumbers` must be 1-based sheet row numbers.
 *
 * Deletion walks bottom-up and collapses consecutive runs into one
 * deleteRows call — both because it's far fewer API calls and because
 * deleting bottom-up means an earlier delete never shifts the index of a row
 * still to be visited.
 */
function moveRowsToArchive_(sourceSheet, rows, rowNumbers) {
  if (!rows.length) return 0;

  const archiveSheet = getOrCreateArchiveSheet_(sourceSheet);
  const width = rows[0].length;
  // Guard against a ragged block (a row read before a column was added).
  const normalized = rows.map(r => {
    if (r.length === width) return r;
    const copy = r.slice(0, width);
    while (copy.length < width) copy.push('');
    return copy;
  });

  archiveSheet.getRange(archiveSheet.getLastRow() + 1, 1, normalized.length, width).setValues(normalized);
  // Flush before deleting: if the execution dies between the two, we would
  // rather have a duplicate in the archive than have dropped the only copy.
  SpreadsheetApp.flush();

  const descending = rowNumbers.slice().sort((a, b) => b - a);
  let i = 0;
  while (i < descending.length) {
    const start = descending[i];
    let count = 1;
    while (i + count < descending.length && descending[i + count] === start - count) count++;
    sourceSheet.deleteRows(start - count + 1, count);
    i += count;
  }
  return normalized.length;
}

// Only terminal-status cases are ever archived, and by UPDATED_AT (when it
// became terminal) rather than CREATED_AT — an old but still-open case must
// never be swept away just because it's old.
function archiveOldCases_(cutoff) {
  const sheet = getCasesSheet_();
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return;
  const headers = values[0];
  const statusCol = headers.indexOf('STATUS');
  const updatedCol = headers.indexOf('UPDATED_AT');
  if (statusCol === -1 || updatedCol === -1) {
    console.error('archiveOldCases_: CASES sheet is missing STATUS/UPDATED_AT — skipping.');
    return;
  }

  const terminal = archivableCaseStatuses_();
  const rows = [];
  const rowNumbers = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (terminal.indexOf(row[statusCol]) === -1) continue;
    const updated = row[updatedCol] ? new Date(row[updatedCol]) : null;
    if (!updated || isNaN(updated.getTime()) || updated >= cutoff) continue;
    rows.push(row);
    rowNumbers.push(i + 1);
  }

  const moved = moveRowsToArchive_(sheet, rows, rowNumbers);
  if (moved) Logger.log('Archived ' + moved + ' CASES rows.');
}

function archiveOldMessages_(cutoff) {
  const sheet = getSpreadsheet().getSheetByName(SHEETS.MESSAGES);
  if (!sheet) return;
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return;
  const headers = values[0];
  const tsCol = headers.indexOf('TIMESTAMP');
  if (tsCol === -1) {
    console.error('archiveOldMessages_: MESSAGES sheet is missing TIMESTAMP — skipping.');
    return;
  }

  const rows = [];
  const rowNumbers = [];
  for (let i = 1; i < values.length; i++) {
    const ts = values[i][tsCol] ? new Date(values[i][tsCol]) : null;
    if (!ts || isNaN(ts.getTime()) || ts >= cutoff) continue;
    rows.push(values[i]);
    rowNumbers.push(i + 1);
  }

  const moved = moveRowsToArchive_(sheet, rows, rowNumbers);
  if (moved) Logger.log('Archived ' + moved + ' MESSAGES rows.');
}
