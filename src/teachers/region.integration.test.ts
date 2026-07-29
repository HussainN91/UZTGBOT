/**
 * Integration tests for region resolution.
 *
 * The first test in here is the one that matters: it fails against the code as
 * stage 3 left it. A region correction made in the spreadsheet has never reached
 * a teacher who had already signed in, and both documented routes for changing
 * one were dead (R12, and the plan's endpoint table).
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import { findTeacher } from './repository.js';
import {
  clearRegionOverride,
  flagRegionMismatch,
  listRegionFlags,
  regionFor,
  setRegionOverride,
} from './region.js';
import { verifyIdentifier } from './verify.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const CHAT = '960001';
const OTHER_CHAT = '960002';
const IDENTIFIER = 'region.tester@example.com';
const OTHER_IDENTIFIER = 'region.other@example.com';
const MANAGER = '969999';

describe.skipIf(!TEST_DATABASE_URL)('region resolution', () => {
  let pool: pg.Pool;
  let db: Database;

  /** As the sheet sync would, ten minutes after recruitment edits the tab. */
  const setRosterRegion = async (identifier: string, region: string | null): Promise<void> => {
    await db.execute(
      sql`UPDATE roster_entries SET region = ${region} WHERE identifier = ${identifier}`,
    );
  };

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`TRUNCATE cases, teachers, roster_entries, audit_log CASCADE`);
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active)
      VALUES (${IDENTIFIER}, 'Region Tester', 'Tashkent', true),
             (${OTHER_IDENTIFIER}, 'Other Tester', 'Tashkent', true)
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('following the roster', () => {
    it('follows the roster when recruitment corrects a region', async () => {
      // R12. There is no code path from a corrected roster row to a teacher who
      // has already signed in: teachers.region is written once, by bindTeacher,
      // and a verified teacher never verifies again. Recruitment's edits reach
      // nobody. This is the test that proves the old behaviour wrong.
      await verifyIdentifier(db, CHAT, IDENTIFIER, 0);
      await setRosterRegion(IDENTIFIER, 'Samarkand');

      expect(await regionFor(db, CHAT)).toBe('Samarkand');
    });

    it('leaves teachers.region as the record of what we believed at sign-in', async () => {
      // The column is kept and is now honestly what it always was. If this ever
      // starts equalling the live roster value, something has started writing it
      // again and the join has quietly stopped being the source of truth.
      await verifyIdentifier(db, CHAT, IDENTIFIER, 0);
      await setRosterRegion(IDENTIFIER, 'Samarkand');

      expect((await findTeacher(db, CHAT))?.region).toBe('Tashkent');
      expect(await regionFor(db, CHAT)).toBe('Samarkand');
    });

    it('returns null when neither the override nor the roster has one', async () => {
      // D10 depends on this: an unknown region hides a case from nobody.
      await setRosterRegion(IDENTIFIER, null);
      await verifyIdentifier(db, CHAT, IDENTIFIER, 0);

      expect(await regionFor(db, CHAT)).toBeNull();
    });

    it('returns null for a chat that has never signed in', async () => {
      expect(await regionFor(db, '404404')).toBeNull();
    });
  });

  describe('an override by a named person', () => {
    it('lets a manager override the roster', async () => {
      await verifyIdentifier(db, CHAT, IDENTIFIER, 0);
      await setRegionOverride(db, CHAT, 'Bukhara', MANAGER);
      await setRosterRegion(IDENTIFIER, 'Samarkand');

      expect(await regionFor(db, CHAT)).toBe('Bukhara');
    });

    it('keeps the override when the teacher signs in again from a new phone', async () => {
      // R11. bindTeacher upserts with onConflictDoUpdate and its `set` writes
      // region from the roster. A manager's correction must not be undone by a
      // teacher buying a phone — and changing phone is the commonest legitimate
      // reason anyone re-verifies.
      await verifyIdentifier(db, CHAT, IDENTIFIER, 0);
      await setRegionOverride(db, CHAT, 'Bukhara', MANAGER);

      await verifyIdentifier(db, CHAT, IDENTIFIER, 0);

      expect(await regionFor(db, CHAT)).toBe('Bukhara');
    });

    it('still un-revokes a chat that verifies again', async () => {
      // The same `set` object deliberately clears revoked_at. Fixing R11 must not
      // break that — they are two columns in one statement and it is easy to
      // widen the fix by one field too many.
      await verifyIdentifier(db, CHAT, IDENTIFIER, 0);
      await db.execute(
        sql`UPDATE teachers SET verification_state = 'Revoked', revoked_at = now(), revoked_by = ${MANAGER} WHERE chat_id = ${CHAT}`,
      );

      await verifyIdentifier(db, CHAT, IDENTIFIER, 0);

      const teacher = await findTeacher(db, CHAT);
      expect(teacher?.verificationState).toBe('Verified');
      expect(teacher?.revokedAt).toBeNull();
    });

    it('returns to the roster value when the override is cleared', async () => {
      await verifyIdentifier(db, CHAT, IDENTIFIER, 0);
      await setRegionOverride(db, CHAT, 'Bukhara', MANAGER);
      await setRosterRegion(IDENTIFIER, 'Samarkand');

      await clearRegionOverride(db, CHAT, MANAGER);

      expect(await regionFor(db, CHAT)).toBe('Samarkand');
    });

    it('records who set it and when', async () => {
      await verifyIdentifier(db, CHAT, IDENTIFIER, 0);
      await setRegionOverride(db, CHAT, 'Bukhara', MANAGER);

      const rows = await db.execute(
        sql`SELECT region_set_by, region_set_at FROM teachers WHERE chat_id = ${CHAT}`,
      );
      expect(String(rows.rows[0]?.['region_set_by'])).toBe(MANAGER);
      expect(rows.rows[0]?.['region_set_at']).not.toBeNull();
    });

    it('writes an audit row for both setting and clearing', async () => {
      // D18. "Who moved this teacher, and when" is an audit question, and a
      // roster edit cannot answer it.
      await verifyIdentifier(db, CHAT, IDENTIFIER, 0);
      await setRegionOverride(db, CHAT, 'Bukhara', MANAGER);
      await clearRegionOverride(db, CHAT, MANAGER);

      const rows = await db.execute(sql`SELECT action FROM audit_log ORDER BY at`);
      expect(rows.rows.map((r) => String(r['action']))).toEqual([
        'TEACHER_REGION_SET',
        'TEACHER_REGION_CLEARED',
      ]);
    });

    it('reports when there is nobody to set it on', async () => {
      expect(await setRegionOverride(db, '404404', 'Bukhara', MANAGER)).toBe(false);
    });
  });

  describe('the teacher saying the region is wrong', () => {
    it('raises a flag and changes nothing else', async () => {
      // D21. The teacher is the best source of the signal and the worst source
      // of the record — region decides who receives their emergency, so a menu
      // of regions is a menu of whose problem this becomes.
      await verifyIdentifier(db, CHAT, IDENTIFIER, 0);
      await flagRegionMismatch(db, CHAT);

      expect(await regionFor(db, CHAT)).toBe('Tashkent');
      expect((await listRegionFlags(db)).map((f) => f.chatId)).toEqual([CHAT]);
    });

    it('clears the flag when a manager sets the region', async () => {
      await verifyIdentifier(db, CHAT, IDENTIFIER, 0);
      await flagRegionMismatch(db, CHAT);
      await setRegionOverride(db, CHAT, 'Bukhara', MANAGER);

      expect(await listRegionFlags(db)).toEqual([]);
    });

    it('lists only flagged teachers', async () => {
      await verifyIdentifier(db, CHAT, IDENTIFIER, 0);
      await verifyIdentifier(db, OTHER_CHAT, OTHER_IDENTIFIER, 0);
      await flagRegionMismatch(db, OTHER_CHAT);

      expect((await listRegionFlags(db)).map((f) => f.chatId)).toEqual([OTHER_CHAT]);
    });

    it('reports the region currently held, so a manager can judge it', async () => {
      await verifyIdentifier(db, CHAT, IDENTIFIER, 0);
      await setRosterRegion(IDENTIFIER, 'Samarkand');
      await flagRegionMismatch(db, CHAT);

      expect((await listRegionFlags(db))[0]?.region).toBe('Samarkand');
    });
  });
});
