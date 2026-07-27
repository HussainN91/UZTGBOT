/**
 * SetupSheets.gs — one-time provisioning of every tab this bot reads/writes.
 * Run createAllSheets() manually once from the Apps Script editor (select the
 * function in the dropdown, click Run) against the target spreadsheet
 * (SPREADSHEET_ID script property). Safe to re-run: existing tabs with the
 * same name are left alone, only missing tabs/headers are added.
 */

function createAllSheets() {
  const ss = getSpreadsheet();

  createSheetWithHeaders_(ss, SHEETS.FAQ, [
    'CODE', 'CATEGORY', 'BUTTON_TEXT', 'KEYWORDS', 'OFFICIAL_ANSWER',
    'LANGUAGE', 'ACTIVE', 'LAST_APPROVED_BY', 'LAST_APPROVED_DATE'
  ]);

  // If CASES_ARCHIVE already exists, fix its header by hand: ArchiveManager's
  // getOrCreateArchiveSheet_ copies the source header only when it CREATES the
  // tab, so an archive tab created before LAST_ACTOR keeps its 9-column header
  // while moveRowsToArchive_ writes 10-column rows. Type LAST_ACTOR into
  // CASES_ARCHIVE!J1 after running createAllSheets.
  createSheetWithHeaders_(ss, SHEETS.CASES, [
    'REFERENCE', 'CATEGORY', 'CHAT_ID', 'STATUS', 'OWNER',
    'CREATED_AT', 'UPDATED_AT', 'DETAIL', 'PUBLIC_UPDATE',
    'LAST_ACTOR'   // appended, so existing appendRow positions are unaffected
  ]);

  createSheetWithHeaders_(ss, SHEETS.USERS, [
    'CHAT_ID', 'LANGUAGE', 'FIRST_SEEN', 'LAST_SEEN', 'VERIFICATION_STATE',
    'IDENTIFIER', 'NAME', 'REGION'
  ]);

  createSheetWithHeaders_(ss, SHEETS.ROSTER, [
    'IDENTIFIER', 'NAME', 'REGION'
  ]);

  createSheetWithHeaders_(ss, SHEETS.MESSAGES, [
    'TIMESTAMP', 'CHAT_ID', 'ACTION', 'DETAIL'
  ]);

  createSheetWithHeaders_(ss, SHEETS.ADMINS, [
    'TELEGRAM_ID', 'IS_SYSTEM_ADMIN', 'TIER', 'QUEUE',
    // Appended, never inserted: existing rows keep their column positions and
    // createSheetWithHeaders_ simply extends the header row. Inserting NAME at
    // position 2 would have written it over live IS_SYSTEM_ADMIN data.
    // REGIONS is comma-separated, or 'All', or blank — blank means all regions,
    // so adding the column cannot narrow an existing admin's access.
    'NAME', 'ACTIVE', 'ADDED_BY', 'ADDED_AT', 'REGIONS', 'ROLE'
  ]);

  createSheetWithHeaders_(ss, SHEETS.SETTINGS, [
    'KEY', 'VALUE', 'NOTES'
  ]);

  createSheetWithHeaders_(ss, SHEETS.ANNOUNCEMENTS, [
    'ID', 'CONTENT', 'AUDIENCE', 'STATUS', 'CREATED_BY', 'CREATED_AT'
  ]);

  Logger.log('All sheets verified/created.');
}

function createSheetWithHeaders_(spreadsheet, sheetName, headers) {
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }
  const existingHeaderRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const headersAlreadyPresent = headers.every((h, i) => existingHeaderRow[i] === h);
  if (!headersAlreadyPresent) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}
