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
import { verifyIdentifier as verifyWithPeriods } from './verify.js';

/**
 * Stage 5 gave `verifyIdentifier` a fifth argument: the retention periods the
 * notice stated when the teacher read it, recorded as part of the acceptance.
 * These tests are not about consent, so they pass the periods every teacher
 * bound before stage 5 accepted under — all three unset, which is what "kept
 * until the Ministry sets a period" means.
 */
const verify = (
  db: Database,
  chatId: string,
  raw: string,
  attempts: number,
): ReturnType<typeof verifyWithPeriods> =>
  verifyWithPeriods(db, chatId, raw, attempts, {
    caseDays: null,
    urgentCaseDays: null,
    messageDays: null,
  });

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
      await verify(db, CHAT, IDENTIFIER, 0);
      await setRosterRegion(IDENTIFIER, 'Samarkand');

      expect(await regionFor(db, CHAT)).toBe('Samarkand');
    });

    it('leaves teachers.region as the record of what we believed at sign-in', async () => {
      // The column is kept and is now honestly what it always was. If this ever
      // starts equalling the live roster value, something has started writing it
      // again and the join has quietly stopped being the source of truth.
      await verify(db, CHAT, IDENTIFIER, 0);
      await setRosterRegion(IDENTIFIER, 'Samarkand');

      expect((await findTeacher(db, CHAT))?.region).toBe('Tashkent');
      expect(await regionFor(db, CHAT)).toBe('Samarkand');
    });

    it('returns null when neither the override nor the roster has one', async () => {
      // D10 depends on this: an unknown region hides a case from nobody.
      await setRosterRegion(IDENTIFIER, null);
      await verify(db, CHAT, IDENTIFIER, 0);

      expect(await regionFor(db, CHAT)).toBeNull();
    });

    it('returns null for a chat that has never signed in', async () => {
      expect(await regionFor(db, '404404')).toBeNull();
    });
  });

  describe('an override by a named person', () => {
    it('lets a manager override the roster', async () => {
      await verify(db, CHAT, IDENTIFIER, 0);
      await setRegionOverride(db, CHAT, 'Bukhara', MANAGER);
      await setRosterRegion(IDENTIFIER, 'Samarkand');

      expect(await regionFor(db, CHAT)).toBe('Bukhara');
    });

    it('keeps the override when the teacher signs in again from a new phone', async () => {
      // R11. bindTeacher upserts with onConflictDoUpdate and its `set` writes
      // region from the roster. A manager's correction must not be undone by a
      // teacher buying a phone — and changing phone is the commonest legitimate
      // reason anyone re-verifies.
      await verify(db, CHAT, IDENTIFIER, 0);
      await setRegionOverride(db, CHAT, 'Bukhara', MANAGER);

      await verify(db, CHAT, IDENTIFIER, 0);

      expect(await regionFor(db, CHAT)).toBe('Bukhara');
    });

    it('refuses to re-verify a revoked chat, leaving the revocation standing', async () => {
      /**
       * **This test replaces one that asserted the opposite, and the inversion is
       * deliberate — see D27 and Task 36.**
       *
       * It used to read "still un-revokes a chat that verifies again", guarding
       * the fix for R11 against widening by one field: `bindTeacher`'s `set`
       * object clears `revoked_at` in the same statement that writes the region,
       * and the concern was that a careless fix would drop it.
       *
       * That behaviour is now the hole rather than the property. A revoked
       * teacher who could sign in again would undo a staff member's deliberate
       * decision by typing an email address, which is why `/restore` exists at
       * `teacher.revoke` rather than being something the teacher can do for
       * themselves. `verifyIdentifier` therefore refuses a revoked chat before it
       * reaches `bindTeacher` at all.
       *
       * `bindTeacher` still clears the columns and that line is still correct —
       * nothing stale should survive a rebind — but no revoked row can now reach
       * it, so the guard the old test provided has nothing left to guard.
       */
      await verify(db, CHAT, IDENTIFIER, 0);
      await db.execute(
        sql`UPDATE teachers SET verification_state = 'Revoked', revoked_at = now(), revoked_by = ${MANAGER} WHERE chat_id = ${CHAT}`,
      );

      const outcome = await verify(db, CHAT, IDENTIFIER, 0);

      expect(outcome.kind).toBe('refused');
      const teacher = await findTeacher(db, CHAT);
      expect(teacher?.verificationState).toBe('Revoked');
      expect(teacher?.revokedAt).not.toBeNull();
    });

    it('does not spend a sign-in attempt refusing a revoked chat', async () => {
      // Nothing was guessed. The chat is presenting an identity, usually its own,
      // and the answer would be the same every time — so counting it would lock
      // somebody out of a prompt they cannot pass anyway, and would make the
      // attempt budget mean two different things.
      await verify(db, CHAT, IDENTIFIER, 0);
      await db.execute(
        sql`UPDATE teachers SET verification_state = 'Revoked', revoked_at = now() WHERE chat_id = ${CHAT}`,
      );

      const outcome = await verify(db, CHAT, IDENTIFIER, 0);

      expect(outcome.kind === 'refused' && outcome.consumedAttempt).toBe(false);
    });

    it('returns to the roster value when the override is cleared', async () => {
      await verify(db, CHAT, IDENTIFIER, 0);
      await setRegionOverride(db, CHAT, 'Bukhara', MANAGER);
      await setRosterRegion(IDENTIFIER, 'Samarkand');

      await clearRegionOverride(db, CHAT, MANAGER);

      expect(await regionFor(db, CHAT)).toBe('Samarkand');
    });

    it('records who set it and when', async () => {
      await verify(db, CHAT, IDENTIFIER, 0);
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
      await verify(db, CHAT, IDENTIFIER, 0);
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
      await verify(db, CHAT, IDENTIFIER, 0);
      await flagRegionMismatch(db, CHAT);

      expect(await regionFor(db, CHAT)).toBe('Tashkent');
      expect((await listRegionFlags(db)).map((f) => f.chatId)).toEqual([CHAT]);
    });

    it('clears the flag when a manager sets the region', async () => {
      await verify(db, CHAT, IDENTIFIER, 0);
      await flagRegionMismatch(db, CHAT);
      await setRegionOverride(db, CHAT, 'Bukhara', MANAGER);

      expect(await listRegionFlags(db)).toEqual([]);
    });

    it('lists only flagged teachers', async () => {
      await verify(db, CHAT, IDENTIFIER, 0);
      await verify(db, OTHER_CHAT, OTHER_IDENTIFIER, 0);
      await flagRegionMismatch(db, OTHER_CHAT);

      expect((await listRegionFlags(db)).map((f) => f.chatId)).toEqual([OTHER_CHAT]);
    });

    it('reports the region currently held, so a manager can judge it', async () => {
      await verify(db, CHAT, IDENTIFIER, 0);
      await setRosterRegion(IDENTIFIER, 'Samarkand');
      await flagRegionMismatch(db, CHAT);

      expect((await listRegionFlags(db))[0]?.region).toBe('Samarkand');
    });
  });
});
