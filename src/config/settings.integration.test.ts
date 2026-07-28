/**
 * Integration tests for the settings reader.
 *
 *   docker compose up -d postgres
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
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
  setSetting,
} from './settings.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

describe.skipIf(!TEST_DATABASE_URL)('settings', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await migrate(db, { migrationsFolder });
    await db.execute(sql`TRUNCATE settings`);
    clearSettingsCache();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('returns the fallback when a setting has never been set', async () => {
    // A bot that refuses to serve because a settings row is missing is a worse
    // failure than one that assumes normal operation.
    await expect(getSetting(db, SETTING.RETENTION_DAYS, '365')).resolves.toBe('365');
  });

  it('returns a value once it is set', async () => {
    await setSetting(db, SETTING.RETENTION_DAYS, '180');
    await expect(getSetting(db, SETTING.RETENTION_DAYS, '365')).resolves.toBe('180');
  });

  it('drops the cache on write, so a change takes effect immediately', async () => {
    await getSetting(db, SETTING.RETENTION_DAYS, '365');
    await setSetting(db, SETTING.RETENTION_DAYS, '90');
    await expect(getSetting(db, SETTING.RETENTION_DAYS, '365')).resolves.toBe('90');
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
});
