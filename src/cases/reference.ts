/**
 * Allocating the reference a teacher quotes on the phone.
 *
 * `VISA-2026-00001`. One statement, so twenty teachers tapping confirm at once
 * get twenty distinct numbers: the conflicting inserts queue on the row lock and
 * each returns its own incremented value.
 *
 * The Apps Script version could not do this. `maxExistingSequence_`
 * (`CaseManager.gs:91`) scanned every existing case row with a regular
 * expression to find the highest number, under a global script lock — so the
 * cost of filing a case grew with the number of cases ever filed, and the
 * correctness rested entirely on that lock being held.
 */
import { sql } from 'drizzle-orm';
import {
  CASE_REFERENCE_PREFIX,
  CASE_REFERENCE_PREFIX_FALLBACK,
  type CaseCategory,
  TIMEZONE,
} from '../config/constants.js';
import type { Database } from '../db/index.js';

/** Five digits, as the Apps Script version wrote them (`CaseManager.gs:108`). */
const SEQUENCE_DIGITS = 5;

/**
 * Take the next reference for this category.
 *
 * Gaps are acceptable and expected — a case that is rolled back has still
 * consumed its number, and a reference nobody holds costs nothing. Reuse is not
 * acceptable: a reissued reference is a teacher quoting a number that now
 * belongs to somebody else's case. Never "tidy" the counter downwards to close a
 * gap.
 *
 * The year is computed by the database in Tashkent rather than from the Node
 * clock. A case filed at 00:30 on 1 January belongs to the new year; a UTC clock
 * would still say December, and that error would sit undetected for twelve
 * months before producing a duplicate-looking run of numbers.
 */
export async function allocateReference(db: Database, category: CaseCategory): Promise<string> {
  const prefix = CASE_REFERENCE_PREFIX[category] ?? CASE_REFERENCE_PREFIX_FALLBACK;

  const result = await db.execute<{ year: number; last_value: number }>(sql`
    INSERT INTO case_sequences (prefix, year, last_value)
    VALUES (
      ${prefix},
      EXTRACT(YEAR FROM now() AT TIME ZONE ${TIMEZONE})::int,
      1
    )
    ON CONFLICT (prefix, year) DO UPDATE
      SET last_value = case_sequences.last_value + 1
    RETURNING year, last_value
  `);

  const row = result.rows[0];
  if (row === undefined) {
    // Unreachable: the statement either inserts or updates, and both return a
    // row. Named rather than silently coerced, because a reference is the one
    // thing a teacher is asked to keep.
    throw new Error(`could not allocate a case reference for ${prefix}`);
  }

  return `${prefix}-${row.year}-${String(row.last_value).padStart(SEQUENCE_DIGITS, '0')}`;
}
