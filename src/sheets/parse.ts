/**
 * Turning raw spreadsheet cells into records, or into a reason the row was
 * rejected.
 *
 * Pure functions with no database and no network, because this is where the
 * decisions that matter live and they need to be cheap to test exhaustively.
 *
 * Two failure modes are handled very differently on purpose:
 *
 *   A renamed or missing COLUMN stops the whole sync. Something structural
 *   changed and carrying on would mean writing wrong data into every row.
 *
 *   A bad VALUE in one row rejects that row and reports it, leaving the other
 *   rows to sync normally. One misspelled topic must not stop the FAQ updating.
 *
 * The Apps Script version had neither. A renamed column silently disabled
 * whichever feature read it, and a misspelled topic made that answer permanently
 * unreachable with no error anywhere.
 */
import { faqTopicByLabel, faqTopicLabels } from '../config/constants.js';
import { normaliseText } from '../faq/normalise.js';

/** One row that could not be used, and why — reported to whoever owns the content. */
export interface Rejection {
  /** 1-based row number as it appears in the spreadsheet, so it can be found. */
  readonly row: number;
  readonly reason: string;
  readonly value: string;
}

export interface ParseResult<T> {
  readonly rows: readonly T[];
  readonly rejections: readonly Rejection[];
}

export class HeaderMismatchError extends Error {
  constructor(
    readonly tab: string,
    readonly missing: readonly string[],
    readonly found: readonly string[],
  ) {
    super(
      `The ${tab} tab is missing required column(s): ${missing.join(', ')}. ` +
        `Found: ${found.join(', ') || '(no header row)'}. ` +
        `Nothing was synced — a renamed or deleted column would otherwise write wrong values into every row. ` +
        `Restore the column name and the next sync will recover on its own.`,
    );
    this.name = 'HeaderMismatchError';
  }
}

export interface FaqRow {
  /**
   * The 1-based row this answer occupies in the spreadsheet.
   *
   * Carried through purely so listings can be ordered the way the content owner
   * arranged them. It is also what the rejection messages quote, so the two
   * cannot drift apart.
   */
  readonly sheetRow: number;
  readonly code: string;
  readonly topicCode: string;
  readonly buttonText: string;
  readonly keywords: readonly string[];
  readonly officialAnswer: string;
  readonly language: string;
  readonly active: boolean;
  readonly lastApprovedBy: string | null;
  readonly lastApprovedDate: string | null;
}

export interface RosterRow {
  readonly identifier: string;
  readonly name: string;
  readonly region: string | null;
}

const FAQ_COLUMNS = [
  'CODE',
  'CATEGORY',
  'BUTTON_TEXT',
  'KEYWORDS',
  'OFFICIAL_ANSWER',
  'LANGUAGE',
  'ACTIVE',
] as const;

const ROSTER_COLUMNS = ['IDENTIFIER', 'NAME'] as const;

/**
 * A Sheets checkbox yields a boolean; a typed cell yields a string. An operator
 * following the runbook types TRUE, but Yes, Y and 1 are the natural
 * alternatives — and in the Apps Script version they granted nothing, silently,
 * with no error anywhere. Blank means active so that adding this column to an
 * existing sheet cannot deactivate every row.
 */
const FALSEY = new Set(['FALSE', 'NO', 'N', '0']);
export function parseActive(cell: string): boolean {
  return !FALSEY.has(cell.trim().toUpperCase());
}

/**
 * The roster's identifier is a recruitment email, and it is compared against
 * whatever a teacher types. Normalising both ends means a trailing space in a
 * pasted cell no longer makes a teacher unable to sign in with nothing to show
 * why.
 */
export function normaliseIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

function indexHeaders(
  tab: string,
  raw: readonly string[][],
  required: readonly string[],
): Map<string, number> {
  const header = (raw[0] ?? []).map((h) => h.trim().toUpperCase());
  const index = new Map<string, number>();
  header.forEach((name, i) => {
    if (!index.has(name)) index.set(name, i);
  });
  const missing = required.filter((c) => !index.has(c));
  if (missing.length > 0) throw new HeaderMismatchError(tab, missing, header);
  return index;
}

const cell = (row: readonly string[], at: number | undefined): string =>
  at === undefined ? '' : (row[at] ?? '').trim();

export function parseFaqTab(raw: readonly string[][]): ParseResult<FaqRow> {
  const headers = indexHeaders('FAQ', raw, FAQ_COLUMNS);
  const rows: FaqRow[] = [];
  const rejections: Rejection[] = [];
  const seen = new Set<string>();

  for (let i = 1; i < raw.length; i++) {
    const raw_row = raw[i];
    if (!raw_row) continue;
    const rowNumber = i + 1;
    const code = cell(raw_row, headers.get('CODE'));
    const category = cell(raw_row, headers.get('CATEGORY'));

    // A blank line in the middle of a sheet is normal and is not an error.
    if (code === '' && category === '' && cell(raw_row, headers.get('OFFICIAL_ANSWER')) === '') continue;

    if (code === '') {
      rejections.push({ row: rowNumber, reason: 'CODE is empty', value: '' });
      continue;
    }
    if (seen.has(code)) {
      rejections.push({
        row: rowNumber,
        reason: `CODE "${code}" appears more than once — the later row was ignored so it cannot overwrite the earlier one`,
        value: code,
      });
      continue;
    }

    /**
     * The typo check the plan calls for. In the Apps Script version the FAQ
     * lookup filtered on an exact string match against the CATEGORY cell, so a
     * single misspelling meant that answer was silently unreachable forever.
     */
    const topic = faqTopicByLabel(category);
    if (!topic) {
      rejections.push({
        row: rowNumber,
        reason:
          `CATEGORY "${category}" is not a known topic, so this answer would never be reachable. ` +
          `Valid topics: ${faqTopicLabels().join(', ')}`,
        value: category,
      });
      continue;
    }

    const answer = cell(raw_row, headers.get('OFFICIAL_ANSWER'));
    if (answer === '') {
      rejections.push({ row: rowNumber, reason: `CODE "${code}" has an empty OFFICIAL_ANSWER`, value: code });
      continue;
    }
    const buttonText = cell(raw_row, headers.get('BUTTON_TEXT'));
    if (buttonText === '') {
      rejections.push({ row: rowNumber, reason: `CODE "${code}" has an empty BUTTON_TEXT`, value: code });
      continue;
    }

    seen.add(code);
    const approvedBy = cell(raw_row, headers.get('LAST_APPROVED_BY'));
    const approvedDate = cell(raw_row, headers.get('LAST_APPROVED_DATE'));
    rows.push({
      sheetRow: rowNumber,
      code,
      topicCode: topic.code,
      buttonText,
      // Normalised exactly as a teacher's query will be — see faq/normalise.ts.
      // Lowercasing alone left every keyword containing punctuation unmatchable.
      keywords: cell(raw_row, headers.get('KEYWORDS'))
        .split(',')
        .map((k) => normaliseText(k))
        .filter((k) => k.length > 0),
      officialAnswer: answer,
      language: cell(raw_row, headers.get('LANGUAGE')) || 'EN',
      active: parseActive(cell(raw_row, headers.get('ACTIVE'))),
      lastApprovedBy: approvedBy === '' ? null : approvedBy,
      lastApprovedDate: approvedDate === '' ? null : approvedDate,
    });
  }

  return { rows, rejections };
}

export function parseRosterTab(raw: readonly string[][]): ParseResult<RosterRow> {
  const headers = indexHeaders('ROSTER', raw, ROSTER_COLUMNS);
  const rows: RosterRow[] = [];
  const rejections: Rejection[] = [];
  const seen = new Set<string>();

  for (let i = 1; i < raw.length; i++) {
    const raw_row = raw[i];
    if (!raw_row) continue;
    const rowNumber = i + 1;
    const rawIdentifier = cell(raw_row, headers.get('IDENTIFIER'));
    const name = cell(raw_row, headers.get('NAME'));

    if (rawIdentifier === '' && name === '') continue;

    if (rawIdentifier === '') {
      rejections.push({ row: rowNumber, reason: 'IDENTIFIER is empty, so nobody could sign in with this row', value: '' });
      continue;
    }
    const identifier = normaliseIdentifier(rawIdentifier);
    if (seen.has(identifier)) {
      rejections.push({
        row: rowNumber,
        reason: `IDENTIFIER "${identifier}" appears more than once — two teachers cannot share one identity`,
        value: identifier,
      });
      continue;
    }
    if (name === '') {
      rejections.push({ row: rowNumber, reason: `IDENTIFIER "${identifier}" has no NAME`, value: identifier });
      continue;
    }

    seen.add(identifier);
    const region = cell(raw_row, headers.get('REGION'));
    rows.push({ identifier, name, region: region === '' ? null : region });
  }

  return { rows, rejections };
}
