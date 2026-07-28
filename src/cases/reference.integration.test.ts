/**
 * Integration tests for case reference allocation.
 *
 * The property that matters is that two cases can never be given the same
 * reference. That is a guarantee of `INSERT … ON CONFLICT DO UPDATE` taking a
 * row lock, not of anything in the TypeScript, so it can only be shown against a
 * real database with real concurrency.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CASE_CATEGORY } from '../config/constants.js';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import { allocateReference } from './reference.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

describe.skipIf(!TEST_DATABASE_URL)('case reference allocation', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`TRUNCATE case_sequences`);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('starts a prefix at one, zero-padded to five digits', async () => {
    const reference = await allocateReference(db, CASE_CATEGORY.VISA);
    expect(reference).toMatch(/^VISA-\d{4}-00001$/);
  });

  it('counts up', async () => {
    await allocateReference(db, CASE_CATEGORY.VISA);
    const second = await allocateReference(db, CASE_CATEGORY.VISA);
    expect(second).toMatch(/^VISA-\d{4}-00002$/);
  });

  /**
   * `INSERT … ON CONFLICT`, not `UPDATE`: there are no seed rows, so an `UPDATE`
   * would silently affect zero rows for the first case of every prefix in every
   * new year — and the first case of the year is exactly when nobody is looking.
   */
  it('needs no seed row for a prefix it has never seen', async () => {
    const rows = await db.execute(sql`SELECT prefix FROM case_sequences`);
    expect(rows.rows).toHaveLength(0);
    await expect(allocateReference(db, CASE_CATEGORY.ACCOMMODATION)).resolves.toMatch(
      /^ACCOM-\d{4}-00001$/,
    );
  });

  it('never reissues a reference under concurrent allocation', async () => {
    // The one that matters. Twenty teachers tapping confirm at once must produce
    // twenty distinct references — a duplicate is a case that overwrites another.
    const allocated = await Promise.all(
      Array.from({ length: 20 }, () => allocateReference(db, CASE_CATEGORY.VISA)),
    );
    expect(new Set(allocated).size).toBe(20);
  });

  it('keeps a separate run of numbers per category', async () => {
    await allocateReference(db, CASE_CATEGORY.VISA);
    await allocateReference(db, CASE_CATEGORY.VISA);
    await expect(allocateReference(db, CASE_CATEGORY.TRAVEL)).resolves.toMatch(
      /^TRAVEL-\d{4}-00001$/,
    );
  });

  it('stamps the year in Tashkent, not in the server’s own zone', async () => {
    // A case filed at 00:30 on 1 January is a case from the new year. Reading the
    // year from a UTC clock would file it under the old one, five hours late —
    // and the mistake would be invisible for twelve months.
    const expected = await db.execute<{ year: number }>(
      sql`SELECT EXTRACT(YEAR FROM now() AT TIME ZONE 'Asia/Tashkent')::int AS year`,
    );
    const reference = await allocateReference(db, CASE_CATEGORY.VISA);
    expect(reference).toContain(`-${String(expected.rows[0]?.year)}-`);
  });

  /**
   * Gaps are acceptable and expected: a rolled-back case still consumed its
   * number. Reuse is not. Documented here so nobody "tidies" the counter back
   * down to close a gap and reissues a reference a teacher is already quoting.
   */
  it('does not reuse a number after a gap', async () => {
    await allocateReference(db, CASE_CATEGORY.VISA);
    await db.execute(sql`UPDATE case_sequences SET last_value = last_value + 5`);
    const next = await allocateReference(db, CASE_CATEGORY.VISA);
    expect(next).toMatch(/^VISA-\d{4}-00007$/);
  });
});
