/**
 * Integration tests for the staff table — the table that has existed since
 * stage 2 with no reader and no writer.
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
import { QUEUE } from './queues.js';
import {
  StaffAlreadyExistsError,
  addStaff,
  countActiveSystem,
  deactivateStaff,
  findAnyStaff,
  findStaff,
  listStaff,
  setStaffRole,
  systemStaffIds,
} from './repository.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const ID = '870001';
const OTHER = '870002';
const ACTOR = '879999';

describe.skipIf(!TEST_DATABASE_URL)('the staff repository', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`TRUNCATE staff, audit_log CASCADE`);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('finding', () => {
    it('does not return a deactivated member from the authorization lookup', async () => {
      // findStaff is the gate. findAnyStaff is for management commands, which
      // must still be able to address a deactivated row or /staff_remove is
      // irreversible from inside the bot (AdminCommands.gs:1160).
      await addStaff(db, { telegramId: ID, role: 'Support', queue: QUEUE.VISA, actor: ACTOR });
      await deactivateStaff(db, ID, ACTOR);

      expect(await findStaff(db, ID)).toBeNull();
      expect(await findAnyStaff(db, ID)).not.toBeNull();
    });

    it('returns null for a chat with no staff row at all', async () => {
      // The ordinary case: a teacher. Must be null, not an error.
      expect(await findStaff(db, '999999')).toBeNull();
      expect(await findAnyStaff(db, '999999')).toBeNull();
    });

    it('returns the role and queue the row was created with', async () => {
      await addStaff(db, { telegramId: ID, role: 'Lead', queue: QUEUE.TRAVEL, actor: ACTOR });
      const found = await findStaff(db, ID);
      expect(found?.role).toBe('Lead');
      expect(found?.queue).toBe(QUEUE.TRAVEL);
      expect(found?.active).toBe(true);
    });
  });

  describe('adding', () => {
    it('refuses to add somebody who already has a row', async () => {
      // /add_admin used to upsert, and its defaulting fourth argument stripped
      // IS_SYSTEM_ADMIN from existing rows — including the caller's own
      // (AdminCommands.gs:1089). Adding is adding.
      await addStaff(db, { telegramId: ID, role: 'Support', queue: QUEUE.ALL, actor: ACTOR });
      await expect(
        addStaff(db, { telegramId: ID, role: 'System', queue: QUEUE.ALL, actor: ACTOR }),
      ).rejects.toThrow(StaffAlreadyExistsError);
    });

    it('refuses to add somebody who exists but is deactivated', async () => {
      // Otherwise "add" silently becomes "reactivate with a new role", which is
      // the upsert behaviour above wearing a different hat. Reactivation is
      // setStaffRole, and it is deliberately a different verb.
      await addStaff(db, { telegramId: ID, role: 'Support', queue: QUEUE.ALL, actor: ACTOR });
      await deactivateStaff(db, ID, ACTOR);
      await expect(
        addStaff(db, { telegramId: ID, role: 'Support', queue: QUEUE.ALL, actor: ACTOR }),
      ).rejects.toThrow(StaffAlreadyExistsError);
    });

    it('reports a duplicate as a duplicate when two callers race', async () => {
      // A staff command runs under the SENDER's chat lock, so two System members
      // adding the same person take two different locks and both see no row.
      // The primary key is what actually prevents it; the caller must still get
      // StaffAlreadyExistsError rather than a raw constraint error that
      // bot.catch swallows into silence.
      const add = (): Promise<void> =>
        addStaff(db, { telegramId: ID, role: 'Support', queue: QUEUE.ALL, actor: ACTOR });

      const outcomes = await Promise.allSettled([add(), add()]);
      const rejected = outcomes.filter((o) => o.status === 'rejected');

      expect(rejected.length).toBe(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(StaffAlreadyExistsError);
      expect((await listStaff(db)).length).toBe(1);
    });

    it('records who added them', async () => {
      await addStaff(db, { telegramId: ID, role: 'Support', queue: QUEUE.ALL, actor: ACTOR });
      const found = await findAnyStaff(db, ID);
      expect(found?.addedBy).toBe(ACTOR);
    });

    it('writes an audit row, in the same transaction', async () => {
      // D18. The table has existed since stage 2 with no caller outside tests.
      await addStaff(db, { telegramId: ID, role: 'Program', queue: QUEUE.ALL, actor: ACTOR });
      const rows = await db.execute(sql`SELECT action, actor FROM audit_log`);
      expect(rows.rows.length).toBe(1);
      expect(String(rows.rows[0]?.['actor'])).toBe(ACTOR);
    });

    it('stores regions as given, and an empty list means every region', async () => {
      // schema.ts:281 — "Empty array means every region, so adding this column
      // cannot narrow existing access."
      await addStaff(db, { telegramId: ID, role: 'Support', queue: QUEUE.ALL, actor: ACTOR });
      expect((await findStaff(db, ID))?.regions).toEqual([]);

      await addStaff(db, {
        telegramId: OTHER,
        role: 'Support',
        queue: QUEUE.ALL,
        regions: ['Tashkent', 'Samarkand'],
        actor: ACTOR,
      });
      expect((await findStaff(db, OTHER))?.regions).toEqual(['Tashkent', 'Samarkand']);
    });
  });

  describe('changing a role', () => {
    it('reactivates a deactivated member when their role is set', async () => {
      // The one obvious way back from /staff_remove.
      await addStaff(db, { telegramId: ID, role: 'Support', queue: QUEUE.ALL, actor: ACTOR });
      await deactivateStaff(db, ID, ACTOR);
      await setStaffRole(db, ID, 'Lead', ACTOR);

      const found = await findStaff(db, ID);
      expect(found).not.toBeNull();
      expect(found?.role).toBe('Lead');
      expect(found?.active).toBe(true);
    });

    it('reports when there is nobody to change', async () => {
      // A typo'd id must not silently succeed — the R3 lesson, applied to staff
      // rather than to case owners.
      expect(await setStaffRole(db, '404404', 'Support', ACTOR)).toBe(false);
    });
  });

  describe('deactivating', () => {
    it('keeps the row so history stays readable', async () => {
      await addStaff(db, { telegramId: ID, role: 'Support', queue: QUEUE.ALL, actor: ACTOR });
      await deactivateStaff(db, ID, ACTOR);
      expect(await findAnyStaff(db, ID)).not.toBeNull();
    });

    it('reports when there is nobody to deactivate', async () => {
      expect(await deactivateStaff(db, '404404', ACTOR)).toBe(false);
    });
  });

  describe('counting System members', () => {
    it('counts only active ones', async () => {
      await addStaff(db, { telegramId: ID, role: 'System', queue: QUEUE.ALL, actor: ACTOR });
      await addStaff(db, { telegramId: OTHER, role: 'System', queue: QUEUE.ALL, actor: ACTOR });
      expect(await countActiveSystem(db)).toBe(2);

      await deactivateStaff(db, OTHER, ACTOR);
      expect(await countActiveSystem(db)).toBe(1);
    });

    it('does not count a lesser rank', async () => {
      // The guard behind "/staff_remove must refuse to remove the last System
      // member" (D13) — recovery from getting it wrong is a trip to the database.
      await addStaff(db, { telegramId: ID, role: 'Program', queue: QUEUE.ALL, actor: ACTOR });
      expect(await countActiveSystem(db)).toBe(0);
    });

    it('lists active System ids for the alert fan-out', async () => {
      // D12. The ops chat stays the floor; these are added on top.
      await addStaff(db, { telegramId: ID, role: 'System', queue: QUEUE.ALL, actor: ACTOR });
      await addStaff(db, { telegramId: OTHER, role: 'System', queue: QUEUE.ALL, actor: ACTOR });
      await deactivateStaff(db, OTHER, ACTOR);
      expect(await systemStaffIds(db)).toEqual([ID]);
    });
  });

  describe('listing', () => {
    it('lists active members by default and all of them on request', async () => {
      await addStaff(db, { telegramId: ID, role: 'Support', queue: QUEUE.ALL, actor: ACTOR });
      await addStaff(db, { telegramId: OTHER, role: 'Support', queue: QUEUE.ALL, actor: ACTOR });
      await deactivateStaff(db, OTHER, ACTOR);

      expect((await listStaff(db)).map((s) => s.telegramId)).toEqual([ID]);
      expect((await listStaff(db, { includeInactive: true })).length).toBe(2);
    });
  });
});
