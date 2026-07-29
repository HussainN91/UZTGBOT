/**
 * Integration tests for importance, promised dates and snoozes.
 *
 * The urgent-path tests are R13. Importance has to be written in the same
 * statement as the status on all three routes into an escalated case, or the
 * commonest urgent case is the one stage 5's retention throws away first.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CASE_CATEGORY, MAX_SNOOZE_DAYS } from '../config/constants.js';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import { QUEUE } from '../staff/queues.js';
import type { StaffScope } from '../staff/visibility.js';
import { casesPastDue } from './queries.js';
import {
  SnoozeTooLongError,
  appendUrgentFollowUp,
  createCase,
  markImportance,
  setDue,
  setSnooze,
  updateCase,
} from './service.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const CHAT = '910001';
const IDENTIFIER = 'importance.tester@example.com';
const ACTOR = '919999';

const scope: StaffScope = { role: 'Support', queue: QUEUE.ALL, regions: [] };

describe.skipIf(!TEST_DATABASE_URL)('importance, due dates and snoozes', () => {
  let pool: pg.Pool;
  let db: Database;

  const importanceOf = async (reference: string): Promise<string> => {
    const rows = await db.execute(
      sql`SELECT importance FROM cases WHERE reference = ${reference}`,
    );
    return String(rows.rows[0]?.['importance']);
  };

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(
      sql`TRUNCATE cases, case_notes, teachers, roster_entries, case_sequences CASCADE`,
    );
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active)
      VALUES (${IDENTIFIER}, 'Importance Tester', 'Tashkent', true)
    `);
    await db.execute(sql`
      INSERT INTO teachers (chat_id, verification_state, identifier, name, region)
      VALUES (${CHAT}, 'Verified', ${IDENTIFIER}, 'Importance Tester', 'Tashkent')
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('the urgent path', () => {
    it('marks a case urgent when it is filed with a code', async () => {
      // In the same insert as the status, not a second write. A code spent for a
      // case that is not marked as what the code bought is the same shape of
      // fault as a code spent with no case at all.
      const { reference } = await createCase(db, {
        chatId: CHAT,
        category: CASE_CATEGORY.VISA,
        detail: 'my flight is tomorrow',
        escalate: true,
      });

      expect(await importanceOf(reference)).toBe('Urgent');
    });

    it('leaves an ordinary case Normal', async () => {
      const { reference } = await createCase(db, {
        chatId: CHAT,
        category: CASE_CATEGORY.VISA,
        detail: 'a question about my visa',
      });

      expect(await importanceOf(reference)).toBe('Normal');
    });

    it('raises importance when an urgent follow-up escalates an EXISTING case', async () => {
      // R13, third order, and the one most likely to be missed: urgent plus
      // deduplicated is the common path, not an edge case. If appendUrgentFollowUp
      // escalates the status but leaves importance at Normal, the commonest
      // urgent case is the one retention throws away first.
      const { reference } = await createCase(db, {
        chatId: CHAT,
        category: CASE_CATEGORY.VISA,
        detail: 'a question about my visa',
      });
      expect(await importanceOf(reference)).toBe('Normal');

      await appendUrgentFollowUp(db, reference, 'my flight is tomorrow', CHAT);

      expect(await importanceOf(reference)).toBe('Urgent');
    });

    it('never lowers importance on the deduplicated path', async () => {
      // A Critical case that receives an urgent follow-up stays Critical. An
      // automatic path must not undo a judgement a person made.
      const { reference } = await createCase(db, {
        chatId: CHAT,
        category: CASE_CATEGORY.VISA,
        detail: 'a question about my visa',
      });
      await markImportance(db, reference, 'Critical', ACTOR);

      await appendUrgentFollowUp(db, reference, 'my flight is tomorrow', CHAT);

      expect(await importanceOf(reference)).toBe('Critical');
    });
  });

  describe('markImportance', () => {
    it('keeps the marker through close and reopen', async () => {
      // The whole reason importance is not a status.
      const { reference } = await createCase(db, {
        chatId: CHAT,
        category: CASE_CATEGORY.VISA,
        detail: 'a question',
      });
      await markImportance(db, reference, 'Critical', ACTOR);

      await updateCase(db, reference, { status: 'Completed' }, ACTOR);
      expect(await importanceOf(reference)).toBe('Critical');

      await updateCase(db, reference, { status: 'Under review' }, ACTOR);
      expect(await importanceOf(reference)).toBe('Critical');
    });

    it('may lower a marker, because that is a judgement too', async () => {
      const { reference } = await createCase(db, {
        chatId: CHAT,
        category: CASE_CATEGORY.VISA,
        detail: 'a question',
        escalate: true,
      });
      await markImportance(db, reference, 'Normal', ACTOR);
      expect(await importanceOf(reference)).toBe('Normal');
    });

    it('reports when there is no such case', async () => {
      expect(await markImportance(db, 'VISA-2026-99999', 'Urgent', ACTOR)).toBe(false);
    });
  });

  describe('due dates and snoozes', () => {
    const openCase = async (): Promise<string> => {
      const { reference } = await createCase(db, {
        chatId: CHAT,
        category: CASE_CATEGORY.VISA,
        detail: 'a question',
      });
      return reference;
    };

    it('lists a case whose promised date has passed', async () => {
      const reference = await openCase();
      await setDue(db, reference, new Date(Date.now() - 86_400_000), ACTOR);

      expect((await casesPastDue(db, scope)).map((c) => c.reference)).toEqual([reference]);
    });

    it('does not list a case whose date is still ahead', async () => {
      const reference = await openCase();
      await setDue(db, reference, new Date(Date.now() + 86_400_000), ACTOR);

      expect(await casesPastDue(db, scope)).toEqual([]);
    });

    it('does not list a case with no promised date at all', async () => {
      await openCase();
      expect(await casesPastDue(db, scope)).toEqual([]);
    });

    it('suppresses chasing while a snooze is running, without closing the case', async () => {
      const reference = await openCase();
      await setDue(db, reference, new Date(Date.now() - 86_400_000), ACTOR);
      await setSnooze(db, reference, 7, ACTOR);

      expect(await casesPastDue(db, scope)).toEqual([]);

      // The case is still open and still owned — a snooze suppresses the
      // chasing, not the work.
      const rows = await db.execute(sql`SELECT status FROM cases WHERE reference = ${reference}`);
      expect(String(rows.rows[0]?.['status'])).toBe('New');
    });

    it('chases again once the snooze has passed', async () => {
      const reference = await openCase();
      await setDue(db, reference, new Date(Date.now() - 86_400_000), ACTOR);
      await db.execute(
        sql`UPDATE cases SET snoozed_until = now() - make_interval(days => 1) WHERE reference = ${reference}`,
      );

      expect((await casesPastDue(db, scope)).map((c) => c.reference)).toEqual([reference]);
    });

    it('does not chase a closed case', async () => {
      const reference = await openCase();
      await setDue(db, reference, new Date(Date.now() - 86_400_000), ACTOR);
      await updateCase(db, reference, { status: 'Completed' }, ACTOR);

      expect(await casesPastDue(db, scope)).toEqual([]);
    });

    it('refuses a snooze longer than the cap', async () => {
      // The cap is what stops a snooze becoming a way to make an inconvenient
      // case disappear, so it is enforced here rather than at the command.
      const reference = await openCase();
      await expect(setSnooze(db, reference, MAX_SNOOZE_DAYS + 1, ACTOR)).rejects.toThrow(
        SnoozeTooLongError,
      );
    });

    it('refuses a zero or negative snooze', async () => {
      const reference = await openCase();
      await expect(setSnooze(db, reference, 0, ACTOR)).rejects.toThrow(SnoozeTooLongError);
      await expect(setSnooze(db, reference, -5, ACTOR)).rejects.toThrow(SnoozeTooLongError);
    });

    it('clears a promised date when given null', async () => {
      const reference = await openCase();
      await setDue(db, reference, new Date(Date.now() - 86_400_000), ACTOR);
      await setDue(db, reference, null, ACTOR);

      expect(await casesPastDue(db, scope)).toEqual([]);
    });

    it('applies visibility to the past-due list', async () => {
      const reference = await openCase();
      await setDue(db, reference, new Date(Date.now() - 86_400_000), ACTOR);

      expect(await casesPastDue(db, { ...scope, queue: QUEUE.ACCOMMODATION })).toEqual([]);
    });
  });
});
