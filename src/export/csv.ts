/**
 * Turning rows into a file somebody opens in a spreadsheet.
 *
 * Pure — no database, no Telegram, no clock beyond the zone every timestamp in
 * this project is rendered in. What makes this worth its own module rather than
 * a `join(',')` at the call site is that three separate things here are wrong by
 * default and each fails quietly:
 *
 *   A value containing a comma, a quote or a newline silently shifts every
 *   column after it, so a report reads as though a case were in a different
 *   region.
 *
 *   A cell beginning `=`, `+`, `-` or `@` is executed as a formula the moment
 *   the file is opened. Plan D43 keeps teachers' words out of the export, but
 *   region names, staff names and case references are still text somebody typed.
 *
 *   A UTF-8 file with no byte order mark is read by Excel on Windows as the
 *   system codepage, which turns every non-ASCII name into rubbish. The person
 *   opening this file is on Windows.
 */
import { TIMEZONE } from '../config/constants.js';

/**
 * What a cell may hold. Deliberately narrow: anything richer than this is a
 * shape decision the caller has to make, where it can be seen.
 */
export type CsvValue = string | number | Date | null | undefined;

/**
 * Excel and LibreOffice both evaluate a cell that begins with one of these.
 * Tab and carriage return are included because both are stripped by the
 * spreadsheet before it looks at the first character, which is how a guard that
 * checks only `=+-@` is walked straight past.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * Rendered by hand rather than with `toISOString`, for the reason every other
 * timestamp in this project is: a reader in Tashkent should not be doing
 * arithmetic. `sv-SE` is used only because its locale format is already
 * `YYYY-MM-DD HH:mm`, which sorts correctly as text in a spreadsheet column.
 */
function renderDate(value: Date): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);
}

function renderCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return renderDate(value);
  return String(value);
}

/**
 * One field, quoted if it has to be and neutralised if it is dangerous.
 *
 * The formula guard prefixes an apostrophe, which every spreadsheet reads as
 * "treat what follows as text" and which is visible in the cell — a reader can
 * see the value was changed. Silently stripping the character would be worse:
 * a case reference that begins with a hyphen would come back different from the
 * one in the system.
 */
function field(value: CsvValue): string {
  const rendered = renderCell(value);
  const guarded = FORMULA_LEAD.test(rendered) ? `'${rendered}` : rendered;

  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/**
 * A CSV, headers first.
 *
 * The header row is always written, including for an empty result: a file with
 * no header cannot be told apart from a broken export. Whether an empty result
 * should be sent as a file at all is the calling command's decision.
 *
 * CRLF throughout, because that is what the format specifies and what Excel
 * expects; a lone newline inside a quoted field is left as it is, which is
 * legal and is how a multi-line value survives.
 */
export function toCsv<K extends string>(
  headers: readonly K[],
  rows: readonly Readonly<Record<K, CsvValue>>[],
): string {
  const lines = [headers.map(field).join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => field(row[header])).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}
