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
import { CALLBACK, callbackPartProblem } from '../telegram/callback-data.js';

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

export interface ResponseRow {
  /** 1-based row in the responses tab. The idempotency key — see `form_submissions`. */
  readonly sheetRow: number;
  /** Normalised exactly as a roster identifier is, because it is compared against one. */
  readonly email: string;
  /** Google's own timestamp, kept as the text it wrote. Null if the column is absent. */
  readonly submittedAt: string | null;
}

export interface FormRow {
  readonly type: string;
  readonly sheetRow: number;
  readonly buttonText: string;
  readonly url: string;
  readonly responsesTab: string | null;
  readonly active: boolean;
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
 * `RESPONSES_TAB` is deliberately absent from the required list (D39). A form
 * whose responses nobody has linked yet still shows its button — teachers can
 * submit, and the bot simply cannot read the answers back. That is what lets a
 * form be published before the plumbing is finished rather than after.
 */
const FORMS_COLUMNS = ['TYPE', 'BUTTON_TEXT', 'URL'] as const;

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

/**
 * A link a teacher will be sent to, checked before it can reach one.
 *
 * `https` only, and parsed rather than pattern-matched. Two separate reasons,
 * and the second is the one that bites:
 *
 *   A plain-`http` link to 1,800 people is not something to ship by accident.
 *
 *   A malformed URL makes Telegram REFUSE THE WHOLE MESSAGE. The forms list is
 *   one message carrying every button, so a single mistyped cell would take the
 *   entire list away from every teacher — not just its own row.
 *
 * The host is deliberately NOT restricted to Google. Only staff can edit the
 * spreadsheet, MoPSE may move to another form host, and a check that has to be
 * changed by a developer is the thing D24 is getting away from.
 */
function urlProblem(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'it is not a web address';
  }
  if (parsed.protocol !== 'https:') return `it must start with https:// and starts with ${parsed.protocol}//`;
  return null;
}

/**
 * The responses tab does not name its own email column, and cannot.
 *
 * Google heads each column with the QUESTION as it was typed when the form was
 * built, so the email column is "Your email address" in one form and
 * "Recruitment email" in the next. There is no fixed name to require.
 *
 * The rule is therefore: **exactly one** column heading may contain the word
 * "email", and that is the one.
 *
 * Two matches is an error rather than a guess, and that is the point of this
 * class. A form asking both "Your email" and "Your supervisor's email" would
 * otherwise be read by position — and filing a teacher's documents under their
 * supervisor is a silent, plausible, wrong answer, which is the worst kind this
 * system produces. Nought matches is the same refusal for the opposite reason.
 *
 * The runbook states the whole rule in one sentence: the email question must
 * have the word "email" in its title, and no other question may.
 */
export class EmailColumnError extends Error {
  constructor(
    readonly tab: string,
    readonly matches: readonly string[],
  ) {
    super(
      matches.length === 0
        ? `The "${tab}" tab has no column whose heading contains "email", so no submission in it ` +
          `can be matched to a teacher. Add an email question to the form — its title must contain ` +
          `the word "email" — or correct RESPONSES_TAB if this is the wrong tab. Nothing was filed.`
        : `The "${tab}" tab has ${matches.length} columns whose headings contain "email": ` +
          `${matches.join(', ')}. Only one may, or the bot cannot tell which address identifies the ` +
          `teacher — and filing their documents under somebody else is worse than not filing them. ` +
          `Reword the others. Nothing was filed.`,
    );
    this.name = 'EmailColumnError';
  }
}

/**
 * Find the one column that identifies the teacher.
 *
 * Exported for its own test: this is the rule the whole upward pipeline hangs
 * on, and it deserves to be provable without a spreadsheet.
 */
export function findEmailColumn(tab: string, header: readonly string[]): number {
  const matches: string[] = [];
  let found = -1;
  header.forEach((name, i) => {
    /**
     * Letters only before the comparison, so "E-mail", "E‑MAIL" and
     * "Your e mail address" all match. A plain `includes('email')` reads the
     * hyphen as a difference and refuses a heading a person would call obviously
     * correct — which would turn the runbook's one simple rule into a trap.
     */
    if (name.toLowerCase().replace(/[^a-z]/g, '').includes('email')) {
      matches.push(name.trim());
      if (found === -1) found = i;
    }
  });
  if (matches.length !== 1) throw new EmailColumnError(tab, matches);
  return found;
}

/**
 * One form's submissions.
 *
 * Unlike every other parser here, a duplicate is NOT rejected. The same teacher
 * submitting the same form twice is legitimate and common — corrected documents,
 * a second passport page — and each submission is its own row and its own case.
 * Identity here is the row number, never the address, which is also why
 * `form_submissions` is keyed on it.
 */
export function parseResponsesTab(tab: string, raw: readonly string[][]): ParseResult<ResponseRow> {
  const header = (raw[0] ?? []).map((h) => h.trim());
  const emailAt = findEmailColumn(tab, header);
  const timestampAt = header.findIndex((h) => h.toLowerCase() === 'timestamp');

  const rows: ResponseRow[] = [];
  const rejections: Rejection[] = [];

  for (let i = 1; i < raw.length; i++) {
    const raw_row = raw[i];
    if (!raw_row) continue;
    const rowNumber = i + 1;
    const rawEmail = cell(raw_row, emailAt);

    // A wholly blank row is spacing, not a submission.
    if (raw_row.every((c) => c.trim() === '')) continue;

    if (rawEmail === '') {
      rejections.push({
        row: rowNumber,
        reason: 'no email address, so this submission cannot be matched to a teacher',
        value: '',
      });
      continue;
    }

    const timestamp = timestampAt === -1 ? '' : cell(raw_row, timestampAt);
    rows.push({
      sheetRow: rowNumber,
      email: normaliseIdentifier(rawEmail),
      submittedAt: timestamp === '' ? null : timestamp,
    });
  }

  return { rows, rejections };
}

export function parseFormsTab(raw: readonly string[][]): ParseResult<FormRow> {
  const headers = indexHeaders('FORMS', raw, FORMS_COLUMNS);
  const rows: FormRow[] = [];
  const rejections: Rejection[] = [];
  const seen = new Set<string>();

  for (let i = 1; i < raw.length; i++) {
    const raw_row = raw[i];
    if (!raw_row) continue;
    const rowNumber = i + 1;
    const type = cell(raw_row, headers.get('TYPE'));
    const buttonText = cell(raw_row, headers.get('BUTTON_TEXT'));
    const url = cell(raw_row, headers.get('URL'));

    // A blank line in the middle of a sheet is normal and is not an error.
    if (type === '' && buttonText === '' && url === '') continue;

    if (type === '') {
      rejections.push({ row: rowNumber, reason: 'TYPE is empty', value: '' });
      continue;
    }
    if (seen.has(type)) {
      rejections.push({
        row: rowNumber,
        reason: `TYPE "${type}" appears more than once — the later row was ignored so it cannot overwrite the earlier one`,
        value: type,
      });
      continue;
    }

    /**
     * The check that stops one cell breaking the list for everybody. `TYPE`
     * travels inside a button's payload, and `encodeCallback` throws on a value
     * it cannot carry — at render time, far from the sheet that caused it.
     */
    const payloadProblem = callbackPartProblem(CALLBACK.DOC_TYPE, type);
    if (payloadProblem !== null) {
      rejections.push({
        row: rowNumber,
        reason: `TYPE "${type}" cannot be used because ${payloadProblem}. Use a short code with no punctuation, e.g. PASSPORT`,
        value: type,
      });
      continue;
    }

    if (buttonText === '') {
      rejections.push({ row: rowNumber, reason: `TYPE "${type}" has an empty BUTTON_TEXT`, value: type });
      continue;
    }
    if (url === '') {
      rejections.push({ row: rowNumber, reason: `TYPE "${type}" has an empty URL, so the button would go nowhere`, value: type });
      continue;
    }
    const badUrl = urlProblem(url);
    if (badUrl !== null) {
      rejections.push({
        row: rowNumber,
        reason: `TYPE "${type}" has a URL that cannot be used because ${badUrl}. No form buttons would be shown at all until it is fixed`,
        value: url,
      });
      continue;
    }

    seen.add(type);
    const responsesTab = cell(raw_row, headers.get('RESPONSES_TAB'));
    rows.push({
      type,
      sheetRow: rowNumber,
      buttonText,
      url,
      responsesTab: responsesTab === '' ? null : responsesTab,
      active: parseActive(cell(raw_row, headers.get('ACTIVE'))),
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
