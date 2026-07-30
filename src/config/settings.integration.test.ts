/**
 * Integration tests for the settings reader.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 *
 * The schema is applied once by src/test/global-setup.ts, not here — see the
 * note there about why migrating per file raced.
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import {
  SETTING,
  clearSettingsCache,
  getSetting,
  getSettingNumber,
  isMaintenanceMode,
  retentionPeriods,
  setSetting,
} from './settings.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

describe.skipIf(!TEST_DATABASE_URL)('settings', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`TRUNCATE settings`);
    clearSettingsCache();
  });

  afterAll(async () => {
    await pool?.end();
  });

  /**
   * These three used to exercise `RETENTION_DAYS`, which stage 5 deleted rather
   * than renamed (plan D34) — it was never read by anything, and one number
   * could not carry three different promises. They are re-pointed at
   * `OVERDUE_DAYS` rather than dropped: what they test is the *reader*, not the
   * key, and the reader's three behaviours are still worth pinning.
   */
  it('returns the fallback when a setting has never been set', async () => {
    // A bot that refuses to serve because a settings row is missing is a worse
    // failure than one that assumes normal operation.
    await expect(getSetting(db, SETTING.OVERDUE_DAYS, '365')).resolves.toBe('365');
  });

  it('returns a value once it is set', async () => {
    await setSetting(db, SETTING.OVERDUE_DAYS, '180');
    await expect(getSetting(db, SETTING.OVERDUE_DAYS, '365')).resolves.toBe('180');
  });

  it('drops the cache on write, so a change takes effect immediately', async () => {
    await getSetting(db, SETTING.OVERDUE_DAYS, '365');
    await setSetting(db, SETTING.OVERDUE_DAYS, '90');
    await expect(getSetting(db, SETTING.OVERDUE_DAYS, '365')).resolves.toBe('90');
  });

  describe('maintenance mode', () => {
    it('is off when nothing is set', async () => {
      await expect(isMaintenanceMode(db)).resolves.toBe(false);
    });

    it.each(['TRUE', 'true', 'Yes', 'Y', '1', 'on'])('treats %j as on', async (value) => {
      await setSetting(db, SETTING.MAINTENANCE_MODE, value);
      await expect(isMaintenanceMode(db)).resolves.toBe(true);
    });

    it.each(['FALSE', 'no', '0', ''])('treats %j as off', async (value) => {
      await setSetting(db, SETTING.MAINTENANCE_MODE, value);
      await expect(isMaintenanceMode(db)).resolves.toBe(false);
    });
  });

  describe('numeric settings', () => {
    it('parses a number', async () => {
      await setSetting(db, SETTING.OVERDUE_DAYS, '3');
      await expect(getSettingNumber(db, SETTING.OVERDUE_DAYS, 7)).resolves.toBe(3);
    });

    it('falls back rather than propagating NaN when the value is not a number', async () => {
      // A typo in a settings row must not turn into an overdue window of NaN
      // days, which would silently match either everything or nothing.
      await setSetting(db, SETTING.OVERDUE_DAYS, 'three');
      await expect(getSettingNumber(db, SETTING.OVERDUE_DAYS, 7)).resolves.toBe(7);
    });
  });

  describe('the retention periods', () => {
    it('is all-null when nothing has been set, which deletes nothing', async () => {
      /**
       * Plan D30, and the state the system is in between the deploy and the
       * runbook's settings insert. It must be `null` rather than a default:
       * there is no undo for a deletion, and a job that invents a period
       * removes real records against a number nobody chose.
       */
      await expect(retentionPeriods(db)).resolves.toEqual({
        caseDays: null,
        urgentCaseDays: null,
        messageDays: null,
      });
    });

    it('reads all three when all three are set', async () => {
      await setSetting(db, SETTING.CASE_RETENTION_DAYS, '7');
      await setSetting(db, SETTING.URGENT_CASE_RETENTION_DAYS, '180');
      await setSetting(db, SETTING.MESSAGE_RETENTION_DAYS, '3');
      await expect(retentionPeriods(db)).resolves.toEqual({
        caseDays: 7,
        urgentCaseDays: 180,
        messageDays: 3,
      });
    });

    it.each(['0', 'abc', '', '-7', '7.5'])(
      'reads %j as delete-nothing without disturbing the other two',
      async (bad) => {
        // The likeliest real misconfiguration: two keys seeded correctly and the
        // third mistyped. Cases must still be deleted on the period MoPSE did
        // set, and the notice must still say so.
        await setSetting(db, SETTING.CASE_RETENTION_DAYS, '7');
        await setSetting(db, SETTING.URGENT_CASE_RETENTION_DAYS, '180');
        await setSetting(db, SETTING.MESSAGE_RETENTION_DAYS, bad);

        await expect(retentionPeriods(db)).resolves.toEqual({
          caseDays: 7,
          urgentCaseDays: 180,
          messageDays: null,
        });
      },
    );

    it('takes effect immediately after a change, because setSetting drops the cache', async () => {
      await setSetting(db, SETTING.CASE_RETENTION_DAYS, '7');
      await retentionPeriods(db);
      await setSetting(db, SETTING.CASE_RETENTION_DAYS, '30');
      await expect(retentionPeriods(db)).resolves.toMatchObject({ caseDays: 30 });
    });
  });
});
