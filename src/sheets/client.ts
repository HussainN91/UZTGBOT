/**
 * Reading the Google Sheet.
 *
 * Read-only, deliberately and at every level: the scope requested is
 * `spreadsheets.readonly`, and the service account should hold Viewer on the
 * spreadsheets it is meant to read and nothing else. That stopped being one
 * spreadsheet on 6 August 2026, when each live form turned out to keep its
 * answers in a file Google made for it. The bot never writes to Sheets — the
 * spreadsheet owns the FAQ bank and the roster, the database owns everything
 * else, and information flows one way so the two can never disagree about which
 * copy is correct.
 */
import { JWT } from 'google-auth-library';
import { z } from 'zod';
import { env } from '../config/env.js';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

/**
 * The tabs the sync reads. Nothing else in the spreadsheet is touched.
 *
 * `FORMS` carries the document links (D24). The response tabs are NOT listed
 * here: there is one per form, each named by its own `FORMS` row, so they are
 * discovered at run time rather than known at compile time.
 */
export const SHEET_TABS = {
  FAQ: 'FAQ',
  ROSTER: 'ROSTER',
  FORMS: 'FORMS',
} as const;

const serviceAccountSchema = z.object({
  client_email: z.string().min(1),
  private_key: z.string().min(1),
});

export class SheetsConfigurationError extends Error {}

function credentials(): { email: string; key: string } {
  const raw = env().GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new SheetsConfigurationError(
      'GOOGLE_SERVICE_ACCOUNT_JSON is not set, so the FAQ and roster cannot be synced.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SheetsConfigurationError(
      'GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. It must be the whole key file on one line.',
    );
  }
  const result = serviceAccountSchema.safeParse(parsed);
  if (!result.success) {
    throw new SheetsConfigurationError(
      'GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key.',
    );
  }
  return {
    email: result.data.client_email,
    // Newlines survive most environment plumbing as the two characters \ and n.
    key: result.data.private_key.replace(/\\n/g, '\n'),
  };
}

export interface SheetReader {
  /**
   * Every cell of one tab, as rows of strings. Row 0 is the header.
   *
   * `spreadsheetId` names the spreadsheet to read from, and is optional because
   * only the response sync ever needs it. Google's default when a form is linked
   * to Sheets is a **new** spreadsheet, so each of MoPSE's live forms keeps its
   * answers in a file of its own — the FAQ, the roster and the forms list are
   * all in the configured one and pass nothing.
   */
  readTab(tab: string, spreadsheetId?: string | null): Promise<string[][]>;
}

/**
 * One cell, as text, without `String()` on something that is not a primitive.
 *
 * `values` is typed `unknown[][]` because that is honestly what arrives, and
 * `String(cell)` over it would turn any object into the literal text
 * `[object Object]` — a cell that looks filled in, compares equal to nothing,
 * and explains nothing to whoever has to find out why. That is this project's
 * recurring shape, and oxlint named this exact line.
 *
 * It is not currently reachable — with `UNFORMATTED_VALUE` the Sheets API sends
 * primitives — with one real exception: **a cell holding a formula error comes
 * back as an object**, e.g. `{ errorType, message }`. Stage 6 made that more
 * likely rather than less, because a form's responses tab is a live sheet that
 * people put formulas in. Serialising it means the reason appears in the
 * rejection message instead of being flattened away.
 */
function cellToText(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'number' || typeof cell === 'boolean' || typeof cell === 'bigint') {
    return String(cell);
  }
  try {
    return JSON.stringify(cell) ?? '';
  } catch {
    return '';
  }
}

/**
 * "Does this actually name a spreadsheet?", answered once.
 *
 * `??` alone is not that question. It falls back only on null and undefined, so
 * an empty string is an answer somebody meant — and a form whose
 * `RESPONSES_SHEET_ID` cell was filled in and then cleared would send every
 * request to a spreadsheet with no id rather than to the configured one. That is
 * a 404 for that form for ever, reported as "could not be read", with the sheet
 * looking blank and correct to whoever goes to check it.
 *
 * `parseFormsTab` already turns a blank cell into null, so nothing arriving
 * through the sheet is empty by the time it reaches here. This is the second
 * line, and it lives here rather than only in the parser because this is the
 * function that would be wrong: a row edited straight into the database, or a
 * caller written a year from now, gets the same answer without having to know
 * the rule. Both callers below go through it, so there is one expression of it
 * rather than two that can drift.
 */
function namedSpreadsheet(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The values URL for one tab, of one spreadsheet.
 *
 * Exported so it can be tested without credentials or a network. `override` is
 * the spreadsheet a form's own row names; null — or, see above, anything blank —
 * means the configured one, which is what every caller but the response sync
 * passes.
 */
export function spreadsheetValuesUrl(
  configuredId: string,
  override: string | null,
  tab: string,
): string {
  const sheetId = namedSpreadsheet(override) ?? configuredId;
  return (
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
    `/values/${encodeURIComponent(tab)}` +
    // UNFORMATTED_VALUE keeps a locale from turning a date or a number into
    // something we then have to parse back. FORMATTED_STRING on the wire
    // would also silently apply the sheet's display formatting.
    `?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`
  );
}

export function createSheetReader(): SheetReader {
  return {
    async readTab(tab: string, spreadsheetId: string | null = null): Promise<string[][]> {
      const configured = env().GOOGLE_SHEET_ID;
      /**
       * A missing `GOOGLE_SHEET_ID` only stops the reads that need it. A form
       * naming its own spreadsheet can still be read, which matters because the
       * response sync is the one caller that does not depend on the configured
       * spreadsheet at all.
       */
      if (!configured && spreadsheetId === null) {
        throw new SheetsConfigurationError('GOOGLE_SHEET_ID is not set, so there is nothing to sync from.');
      }
      const { email, key } = credentials();
      const auth = new JWT({ email, key, scopes: [SCOPE] });
      const token = await auth.getAccessToken();
      if (!token.token) {
        throw new SheetsConfigurationError('Google refused an access token for the service account.');
      }

      const url = spreadsheetValuesUrl(configured ?? '', spreadsheetId, tab);

      const response = await fetch(url, { headers: { Authorization: `Bearer ${token.token}` } });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `Google Sheets returned ${response.status} for tab "${tab}"` +
            (spreadsheetId === null ? '' : ` in spreadsheet ${spreadsheetId}`) + `. ` +
            `Check the sheet id and that the service account has Viewer access. ${body.slice(0, 300)}`,
        );
      }

      const payload = (await response.json()) as { values?: unknown[][] };
      const values = payload.values ?? [];
      // A short row simply stops early in the API response, so every row is
      // padded to the header width by the parser rather than here.
      return values.map((row) => row.map(cellToText));
    },
  };
}
