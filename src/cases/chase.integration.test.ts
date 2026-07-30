/**
 * Integration tests for chasing the teacher.
 *
 * The rule that matters most is the reset: a case whose status moves starts its
 * reminder clock again, and that lives in `updateCase` rather than in the
 * command — the same place and shape as the `closed_at` fix, because
 * `updateCase` is the one write path that sees every status change.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CASE_CATEGORY, TEACHER_CHASE_AFTER_DAYS, TEACHER_CHASE_MAX } from '../config/constants.js';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import { casesAwaitingTeacher, casesExhaustedChasing } from './queries.js';
import { markChaseReported, markTeacherChased, updateCase } from './service.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const CHAT = '910001';
const IDENTIFIER = 'chase.tester@example.com';
const ACTOR = '919001';
const REF = 'VISA-2026-00001';

describe.skipIf(!TEST_DATABASE_URL)('chasing the teacher', () => {
  let pool: pg.Pool;
  let db: Database;

  const seedCase = async (
    reference: string,
    over: {
      status?: string;
      chasedDaysAgo?: number | null;
      chaseCount?: number;
      snoozedDays?: number | null;
      chatId?: string;
    } = {},
  ): Promise<void> => {
    const chased = over.chasedDaysAgo;
    await db.execute(sql`
      INSERT INTO cases (reference, category, teacher_chat_id, status, public_update,
                         teacher_chased_at, teacher_chase_count, snoozed_until)
      VALUES (
        ${reference},
        ${CASE_CATEGORY.VISA},
        ${over.chatId ?? CHAT},
        ${over.status ?? 'Action required'}::case_status,
        'Please send your visa page.',
        ${chased === null || chased === undefined ? null : sql`now() - make_interval(days => ${chased})`},
        ${over.chaseCount ?? 0},
        ${over.snoozedDays === null || over.snoozedDays === undefined ? null : sql`now() + make_interval(days => ${over.snoozedDays})`}
      )
    `);
  };

  const chaseState = async (
    reference: string,
  ): Promise<{ count: number; chasedAt: Date | null }> => {
    const rows = await db.execute<{ teacher_chase_count: number; teacher_chased_at: Date | null }>(
      sql`SELECT teacher_chase_count, teacher_chased_at FROM cases WHERE reference = ${reference}`,
    );
    return {
      count: rows.rows[0]!.teacher_chase_count,
      chasedAt: rows.rows[0]!.teacher_chased_at,
    };
  };

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`TRUNCATE cases, teachers, roster_entries, staff CASCADE`);
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active)
      VALUES (${IDENTIFIER}, 'Chase Tester', 'Tashkent', true)
    `);
    await db.execute(sql`
      INSERT INTO teachers (chat_id, verification_state, identifier, name, region)
      VALUES (${CHAT}, 'Verified', ${IDENTIFIER}, 'Chase Tester', 'Tashkent')
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('the reset, which lives in updateCase', () => {
    it('clears the clock when the status changes', async () => {
      /**
       * The same shape as the `closed_at` fix in `8f2b84c`. A case that leaves
       * `Action required` and comes back must start its reminders again, and a
       * command written in a later stage inherits this by writing a status.
       */
      await seedCase(REF, { chasedDaysAgo: 1, chaseCount: 2 });
      await updateCase(db, REF, { status: 'Under review' }, ACTOR);

      await expect(chaseState(REF)).resolves.toEqual({ count: 0, chasedAt: null });
    });

    it('clears it when /await asks for something new', async () => {
      // Re-awaiting is a fresh request to the teacher, so the cycle restarts.
      // It falls out of the same rule rather than needing its own.
      await seedCase(REF, { chasedDaysAgo: 1, chaseCount: TEACHER_CHASE_MAX });
      await updateCase(db, REF, { status: 'Action required', publicUpdate: 'Send it again' }, ACTOR);

      await expect(chaseState(REF)).resolves.toMatchObject({ count: 0 });
    });

    it('leaves the clock alone when nothing about the status moves', async () => {
      await seedCase(REF, { chasedDaysAgo: 1, chaseCount: 2 });
      await updateCase(db, REF, { publicUpdate: 'still waiting' }, ACTOR);

      await expect(chaseState(REF)).resolves.toMatchObject({ count: 2 });
    });
  });

  describe('markTeacherChased', () => {
    it('stamps and counts in one statement', async () => {
      await seedCase(REF, { chaseCount: 1 });
      await expect(markTeacherChased(db, REF)).resolves.toBe(true);

      const after = await chaseState(REF);
      expect(after.count).toBe(2);
      expect(after.chasedAt).not.toBeNull();
    });

    it('reports a reference that no longer exists', async () => {
      // Retention can remove a case between a read and this write.
      await expect(markTeacherChased(db, 'VISA-2026-09999')).resolves.toBe(false);
    });
  });

  describe('casesAwaitingTeacher', () => {
    const due = () => casesAwaitingTeacher(db, TEACHER_CHASE_AFTER_DAYS, TEACHER_CHASE_MAX);

    it('finds a case never chased', async () => {
      await seedCase(REF, { chasedDaysAgo: null });
      expect((await due()).map((c) => c.reference)).toEqual([REF]);
    });

    it('finds one chased longer ago than the interval', async () => {
      await seedCase(REF, { chasedDaysAgo: TEACHER_CHASE_AFTER_DAYS + 1, chaseCount: 1 });
      expect(await due()).toHaveLength(1);
    });

    it('leaves one chased recently alone', async () => {
      // Three days rather than one: a teacher may need a document, an
      // appointment or a trip to an office.
      await seedCase(REF, { chasedDaysAgo: 1, chaseCount: 1 });
      expect(await due()).toHaveLength(0);
    });

    it('only chases a case that is actually waiting on the teacher', async () => {
      // D26. A case at `Under review` is waiting on staff, and the person
      // holding it is not somebody to nag.
      await seedCase(REF, { status: 'Under review' });
      await seedCase('VISA-2026-00002', { status: 'Escalated' });
      expect(await due()).toHaveLength(0);
    });

    it('stops at the cap', async () => {
      await seedCase(REF, { chasedDaysAgo: 10, chaseCount: TEACHER_CHASE_MAX });
      expect(await due()).toHaveLength(0);
    });

    it('respects a snooze, exactly as casesPastDue does', async () => {
      // A snooze suppresses chasing and never the case itself.
      await seedCase(REF, { chasedDaysAgo: 10, snoozedDays: 5 });
      expect(await due()).toHaveLength(0);
    });

    it('skips a teacher who cannot receive anything', async () => {
      /**
       * R29. A revoked teacher at `Action required` is a case to close
       * unresolved, not a case to chase — and messaging them costs a send and
       * tells nobody anything.
       */
      await seedCase(REF, { chasedDaysAgo: null });
      await db.execute(
        sql`UPDATE teachers SET verification_state = 'Revoked', revoked_at = now() WHERE chat_id = ${CHAT}`,
      );
      expect(await due()).toHaveLength(0);
    });

    it('skips a teacher whose roster row was deactivated', async () => {
      await seedCase(REF, { chasedDaysAgo: null });
      await db.execute(
        sql`UPDATE roster_entries SET active = false WHERE identifier = ${IDENTIFIER}`,
      );
      expect(await due()).toHaveLength(0);
    });

    it('puts the longest-ignored first', async () => {
      await seedCase('VISA-2026-00003', { chasedDaysAgo: 4, chaseCount: 1 });
      await seedCase('VISA-2026-00004', { chasedDaysAgo: 20, chaseCount: 1 });
      expect((await due()).map((c) => c.reference)).toEqual([
        'VISA-2026-00004',
        'VISA-2026-00003',
      ]);
    });
  });

  describe('casesExhaustedChasing', () => {
    it('finds a case at the cap whose owner has not been told', async () => {
      await seedCase(REF, { chasedDaysAgo: 1, chaseCount: TEACHER_CHASE_MAX });
      expect((await casesExhaustedChasing(db, TEACHER_CHASE_MAX)).map((c) => c.reference)).toEqual([
        REF,
      ]);
    });

    it('does not find one whose owner has already been told', async () => {
      // One past the cap is the marker, so the owner is told exactly once and a
      // sixth column is not needed to say so.
      await seedCase(REF, { chasedDaysAgo: 1, chaseCount: TEACHER_CHASE_MAX });
      await markChaseReported(db, REF);
      expect(await casesExhaustedChasing(db, TEACHER_CHASE_MAX)).toHaveLength(0);
    });

    it('does not find one still being chased', async () => {
      await seedCase(REF, { chaseCount: TEACHER_CHASE_MAX - 1 });
      expect(await casesExhaustedChasing(db, TEACHER_CHASE_MAX)).toHaveLength(0);
    });
  });
});
