/**
 * The URL `readTab` builds.
 *
 * Worth its own test for one reason: which spreadsheet a form's answers are read
 * from is now a value from the sheet rather than a constant, and getting it
 * wrong reads somebody else's spreadsheet or none at all. The credentials path
 * is unchanged and is not what this covers.
 */
import { describe, expect, it } from 'vitest';
import { spreadsheetValuesUrl } from './client.js';

describe('which spreadsheet a tab is read from', () => {
  const MAIN = 'MAIN_SHEET_ID';

  it('reads from the configured spreadsheet when no other is named', () => {
    const url = spreadsheetValuesUrl(MAIN, null, 'ROSTER');
    expect(url).toContain('/spreadsheets/MAIN_SHEET_ID/');
    expect(url).toContain('/values/ROSTER');
  });

  it('reads from the form’s own spreadsheet when one is named', () => {
    const url = spreadsheetValuesUrl(MAIN, 'FORM_SHEET_ID', 'Form Responses 1');
    expect(url).toContain('/spreadsheets/FORM_SHEET_ID/');
    expect(url).not.toContain('MAIN_SHEET_ID');
  });

  /**
   * A tab name with a space is the normal case here — every one of MoPSE's live
   * forms writes to a tab called "Form Responses 1" — and an unencoded space
   * makes Google reject the whole request.
   */
  it('encodes a tab name containing spaces', () => {
    const url = spreadsheetValuesUrl(MAIN, null, 'Form Responses 1');
    expect(url).toContain('Form%20Responses%201');
    expect(url).not.toMatch(/values\/Form Responses/);
  });

  /**
   * ⚠️ The one that `??` gets wrong on its own.
   *
   * `override ?? configuredId` falls back only on null and undefined, so an
   * empty string is an answer somebody meant and the request goes out against a
   * spreadsheet with no id — a 404 for every form that has it, rather than the
   * main spreadsheet that was intended.
   *
   * `parseFormsTab` already turns a blank cell into null, so nothing that comes
   * through the sheet arrives here empty. This is the second line, and it is
   * here rather than only in the parser because this function is what would be
   * wrong: anything reaching it by another route — a row edited straight into
   * the database, a caller written later — gets the same answer.
   */
  it('falls back to the configured spreadsheet when the id is blank', () => {
    for (const blank of ['', '   ']) {
      const url = spreadsheetValuesUrl(MAIN, blank, 'Form Responses 1');
      expect(url).toContain('/spreadsheets/MAIN_SHEET_ID/');
    }
  });

  /** And surrounding space on a real id is trimmed rather than encoded into it. */
  it('trims a spreadsheet id that arrived with space around it', () => {
    const url = spreadsheetValuesUrl(MAIN, '  FORM_SHEET_ID  ', 'FAQ');
    expect(url).toContain('/spreadsheets/FORM_SHEET_ID/');
    expect(url).not.toContain('%20');
  });

  it('keeps the render options that stop a locale rewriting values', () => {
    const url = spreadsheetValuesUrl(MAIN, null, 'FAQ');
    expect(url).toContain('valueRenderOption=UNFORMATTED_VALUE');
    expect(url).toContain('dateTimeRenderOption=FORMATTED_STRING');
  });
});
