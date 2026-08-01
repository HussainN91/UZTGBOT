/**
 * Integration tests for the urgent-priority gate.
 *
 * **This file used to test one-time codes and now tests nothing of the sort.**
 * The route it covered — telephone a Regional admin, be read six characters,
 * type them correctly, and only then describe the problem — was withdrawn on
 * 1 August 2026. Everything about spending, expiring, guessing and stranding a
 * code went with it.
 *
 * What replaced it is harder to get right in one specific way, and most of these
 * tests are about that one way: **a request must not grant the thing it is
 * asking for.** A teacher can ask for anything; only a coordinator's tap moves
 * `importance`, and `importance` is what buys six months of retention.
 *
 * Three of these could not have been written against the old platform: two
 * coordinators tapping the same button at the same moment, a second request
 * landing on a case that already has one pending, and a request landing on a
 * case somebody has already judged `Critical`.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withChatLock } from '../conversation/lock.js';
import { loadState, saveState } from '../conversation/state.js';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import { confirmUrgentRequest, pendingUrgentRequests, requestUrgentCase } from './urgent.js';
import { createCase } from './service.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const CHAT = '960001';
const COORDINATOR = '970001';
const OTHER_COORDINATOR = '970002';
const IDENTIFIER = 'urgent.tester@example.com';
const DETAIL = 'My residence card appointment is on Tuesday and the letter has not arrived';

describe.skipIf(!TEST_DATABASE_URL)('the urgent gate', () => {
  let pool: pg.Pool;
  let db: Database;

  const caseRow = async (
    reference: string,
  ): Promise<{
    importance: string;
    status: string;
    requested: boolean;
    confirmed_by: string | null;
    detail: string;
  }> => {
    const rows = await db.execute<{
      importance: string;
      status: string;
      requested: boolean;
      confirmed_by: string | null;
      detail: string;
    }>(sql`
      SELECT importance, status, urgent_requested_at IS NOT NULL AS requested,
             urgent_confirmed_by AS confirmed_by, detail
      FROM cases WHERE reference = ${reference}
    `);
    return rows.rows[0]!;
  };

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    /**
     * `staff` joined this list in Part 5H.1, and its absence was a real fault
     * that only became visible when it did.
     *
     * A staff row left behind by another test file used to be harmless here,
     * because nothing on this path read the staff table. Automatic assignment
     * made staff rows load-bearing inside `createCase` — and the leaked row was
     * promptly chosen as the owner of a case this file believed nobody covered,
     * so a test asserting "no owner" failed against a person it had never heard
     * of.
     */
    await db.execute(sql`
      TRUNCATE cases, teachers, roster_entries, case_sequences,
               conversation_states, audit_log, staff CASCADE
    `);
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active)
      VALUES (${IDENTIFIER}, 'Urgent Tester', 'Tashkent', true)
    `);
    await db.execute(sql`
      INSERT INTO teachers (chat_id, verification_state, identifier, name, region)
      VALUES (${CHAT}, 'Verified', ${IDENTIFIER}, 'Urgent Tester', 'Tashkent')
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('asking', () => {
    it('files a new case at Normal and stamps the request', async () => {
      const result = await requestUrgentCase(db, { chatId: CHAT, detail: DETAIL });

      expect(result.isNew).toBe(true);
      expect(result.alreadyUrgent).toBe(false);
      expect(result.alreadyRequested).toBe(false);

      const row = await caseRow(result.reference);
      /**
       * The single most important assertion in this file.
       *
       * Retention keys off `importance` and keeps urgent cases for six months
       * against the ordinary week. A request that stamped the marker on the way
       * in would let anybody grant themselves half a year of retention by
       * tapping a button, and the symptom would be invisible for six months.
       */
      expect(row.importance).toBe('Normal');
      expect(row.status).toBe('New');
      expect(row.requested).toBe(true);
      expect(row.confirmed_by).toBeNull();
    });

    it('keeps the teacher’s own words as the case detail', async () => {
      const result = await requestUrgentCase(db, { chatId: CHAT, detail: DETAIL });
      expect((await caseRow(result.reference)).detail).toBe(DETAIL);
    });

    it('appends to an open case rather than opening a second one', async () => {
      const first = await createCase(db, {
        chatId: CHAT,
        category: 'Contact Support',
        detail: 'The heating in my flat does not work',
      });

      const result = await requestUrgentCase(db, { chatId: CHAT, detail: DETAIL });

      // The common path, not an edge case: a priority request has no topic
      // picker, so it files under the same category every Contact Support case
      // does and always deduplicates against one the teacher already had.
      expect(result.isNew).toBe(false);
      expect(result.reference).toBe(first.reference);

      const row = await caseRow(result.reference);
      expect(row.detail).toContain('The heating in my flat does not work');
      expect(row.detail).toContain('URGENT REQUEST');
      expect(row.detail).toContain(DETAIL);
      // Appending must not escalate. If it did, the request would grant itself.
      expect(row.importance).toBe('Normal');

      const count = await db.execute<{ count: number }>(
        sql`SELECT count(*)::int AS count FROM cases WHERE teacher_chat_id = ${CHAT}`,
      );
      expect(count.rows[0]?.count).toBe(1);
    });

    it('reports a second request on the same case as already pending', async () => {
      const first = await requestUrgentCase(db, { chatId: CHAT, detail: DETAIL });
      const second = await requestUrgentCase(db, { chatId: CHAT, detail: 'Still nothing' });

      expect(second.reference).toBe(first.reference);
      expect(second.alreadyRequested).toBe(true);
      expect(second.alreadyUrgent).toBe(false);
      // The words are kept either way — new information about a live problem.
      expect((await caseRow(second.reference)).detail).toContain('Still nothing');
    });

    it('does not move the waiting clock when asked a second time', async () => {
      const first = await requestUrgentCase(db, { chatId: CHAT, detail: DETAIL });
      const before = await db.execute<{ at: string }>(
        sql`SELECT urgent_requested_at::text AS at FROM cases WHERE reference = ${first.reference}`,
      );

      await requestUrgentCase(db, { chatId: CHAT, detail: 'Asking again' });

      const after = await db.execute<{ at: string }>(
        sql`SELECT urgent_requested_at::text AS at FROM cases WHERE reference = ${first.reference}`,
      );
      /**
       * The difference between the two stamps is the only measure this system
       * has of how long a teacher waited. Re-stamping on every nudge would let
       * a case that has been waiting a week report as new.
       */
      expect(after.rows[0]?.at).toBe(before.rows[0]?.at);
    });

    it('reports a case that is already urgent, and asks nobody again', async () => {
      const first = await requestUrgentCase(db, { chatId: CHAT, detail: DETAIL });
      await confirmUrgentRequest(db, first.reference, COORDINATOR);

      const second = await requestUrgentCase(db, { chatId: CHAT, detail: 'One more thing' });

      expect(second.alreadyUrgent).toBe(true);
      expect((await caseRow(second.reference)).detail).toContain('One more thing');
    });

    it('does not demote a case somebody has judged Critical', async () => {
      const first = await requestUrgentCase(db, { chatId: CHAT, detail: DETAIL });
      await db.execute(
        sql`UPDATE cases SET importance = 'Critical' WHERE reference = ${first.reference}`,
      );

      const second = await requestUrgentCase(db, { chatId: CHAT, detail: 'And another thing' });

      expect(second.alreadyUrgent).toBe(true);
      expect((await caseRow(second.reference)).importance).toBe('Critical');
    });
  });

  describe('confirming', () => {
    it('raises importance, escalates, stamps who decided, and audits', async () => {
      const asked = await requestUrgentCase(db, { chatId: CHAT, detail: DETAIL });
      const outcome = await confirmUrgentRequest(db, asked.reference, COORDINATOR);

      expect(outcome.kind).toBe('confirmed');
      if (outcome.kind !== 'confirmed') throw new Error('unreachable');
      expect(outcome.teacherChatId).toBe(CHAT);
      // No staff row covers this case, so automatic assignment left it unowned —
      // which is the answer that keeps `/cases unassigned` meaningful. The
      // owned path is the next test down.
      expect(outcome.owner).toBeNull();

      const row = await caseRow(asked.reference);
      expect(row.importance).toBe('Urgent');
      expect(row.status).toBe('Escalated');
      expect(row.confirmed_by).toBe(COORDINATOR);

      const audit = await db.execute<{ action: string; subject: string; actor: string }>(
        sql`SELECT action, subject, actor FROM audit_log WHERE action = 'URGENT_CONFIRMED'`,
      );
      // In the same transaction as the change, never after it.
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]?.subject).toBe(asked.reference);
      expect(audit.rows[0]?.actor).toBe(COORDINATOR);
    });

    it('reports the case’s owner, so they can be told', async () => {
      await db.execute(sql`
        INSERT INTO staff (telegram_id, role, queue) VALUES (${COORDINATOR}, 'Support', 'All')
      `);
      const asked = await requestUrgentCase(db, { chatId: CHAT, detail: DETAIL });
      await db.execute(
        sql`UPDATE cases SET owner = ${COORDINATOR} WHERE reference = ${asked.reference}`,
      );

      const outcome = await confirmUrgentRequest(db, asked.reference, OTHER_COORDINATOR);
      expect(outcome.kind === 'confirmed' && outcome.owner).toBe(COORDINATOR);
    });

    it('makes a second tap a no-op that names who decided', async () => {
      const asked = await requestUrgentCase(db, { chatId: CHAT, detail: DETAIL });
      await confirmUrgentRequest(db, asked.reference, COORDINATOR);

      const again = await confirmUrgentRequest(db, asked.reference, OTHER_COORDINATOR);

      expect(again.kind).toBe('alreadyConfirmed');
      expect(again.kind === 'alreadyConfirmed' && again.by).toBe(COORDINATOR);
      // The second tapper must not overwrite the first decision, and the teacher
      // must not be told twice.
      expect((await caseRow(asked.reference)).confirmed_by).toBe(COORDINATOR);

      const audit = await db.execute<{ count: number }>(
        sql`SELECT count(*)::int AS count FROM audit_log WHERE action = 'URGENT_CONFIRMED'`,
      );
      expect(audit.rows[0]?.count).toBe(1);
    });

    it('lets exactly one of two simultaneous taps win', async () => {
      const asked = await requestUrgentCase(db, { chatId: CHAT, detail: DETAIL });

      /**
       * Two coordinators, two connections, no coordination between them.
       *
       * The guarantee is the `urgent_confirmed_at IS NULL` in the `WHERE`
       * clause and nothing else — there is no lock here, because a staff
       * command runs under the *sender's* chat lock and two senders take two
       * different locks.
       */
      const [a, b] = await Promise.all([
        confirmUrgentRequest(db, asked.reference, COORDINATOR),
        confirmUrgentRequest(db, asked.reference, OTHER_COORDINATOR),
      ]);

      const kinds = [a.kind, b.kind].sort();
      expect(kinds).toEqual(['alreadyConfirmed', 'confirmed']);
    });

    it('refuses a case nobody asked about', async () => {
      const plain = await createCase(db, {
        chatId: CHAT,
        category: 'Contact Support',
        detail: 'An ordinary question',
      });

      const outcome = await confirmUrgentRequest(db, plain.reference, COORDINATOR);

      expect(outcome.kind).toBe('notRequested');
      expect((await caseRow(plain.reference)).importance).toBe('Normal');
    });

    it('refuses a reference that does not exist', async () => {
      const outcome = await confirmUrgentRequest(db, 'SUPPORT-2026-99999', COORDINATOR);
      expect(outcome.kind).toBe('unknown');
    });
  });

  describe('what is still waiting', () => {
    it('lists pending requests oldest first and drops confirmed ones', async () => {
      const asked = await requestUrgentCase(db, { chatId: CHAT, detail: DETAIL });

      expect(await pendingUrgentRequests(db, 20)).toHaveLength(1);

      await confirmUrgentRequest(db, asked.reference, COORDINATOR);
      expect(await pendingUrgentRequests(db, 20)).toHaveLength(0);
    });

    it('ignores a case that was marked urgent some other way', async () => {
      const plain = await createCase(db, {
        chatId: CHAT,
        category: 'Contact Support',
        detail: 'An ordinary question a person judged serious',
      });
      await db.execute(
        sql`UPDATE cases SET importance = 'Urgent' WHERE reference = ${plain.reference}`,
      );

      // `/mark` does not stamp a request, so there is no decision outstanding.
      expect(await pendingUrgentRequests(db, 20)).toHaveLength(0);
    });
  });

  describe('surviving a restart', () => {
    it('picks the teacher up where they were with no credential to lose', async () => {
      /**
       * The state used to carry a spent one-time code, and losing it cost the
       * teacher a telephone call. It carries nothing now, which is the point:
       * a restart mid-description costs them the words they had not sent yet
       * and nothing else.
       */
      await withChatLock(db, CHAT, async (tx) => {
        await saveState(tx, CHAT, { kind: 'AwaitingUrgentDetail', attempts: 0 });
      });

      const state = await loadState(db, CHAT);
      expect(state?.kind).toBe('AwaitingUrgentDetail');

      const result = await requestUrgentCase(db, { chatId: CHAT, detail: DETAIL });
      expect(result.isNew).toBe(true);
      expect((await caseRow(result.reference)).requested).toBe(true);
    });
  });
});
