/**
 * Reading the Google Sheet.
 *
 * Read-only, deliberately and at every level: the scope requested is
 * `spreadsheets.readonly`, and the service account should hold Viewer on that
 * one spreadsheet and nothing else. The bot never writes to Sheets — the
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
  /** Every cell of one tab, as rows of strings. Row 0 is the header. */
  readTab(tab: string): Promise<string[][]>;
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

export function createSheetReader(): SheetReader {
  return {
    async readTab(tab: string): Promise<string[][]> {
      const sheetId = env().GOOGLE_SHEET_ID;
      if (!sheetId) {
        throw new SheetsConfigurationError('GOOGLE_SHEET_ID is not set, so there is nothing to sync from.');
      }
      const { email, key } = credentials();
      const auth = new JWT({ email, key, scopes: [SCOPE] });
      const token = await auth.getAccessToken();
      if (!token.token) {
        throw new SheetsConfigurationError('Google refused an access token for the service account.');
      }

      const url =
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
        `/values/${encodeURIComponent(tab)}` +
        // UNFORMATTED_VALUE keeps a locale from turning a date or a number into
        // something we then have to parse back. FORMATTED_STRING on the wire
        // would also silently apply the sheet's display formatting.
        `?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;

      const response = await fetch(url, { headers: { Authorization: `Bearer ${token.token}` } });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `Google Sheets returned ${response.status} for tab "${tab}". ` +
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
