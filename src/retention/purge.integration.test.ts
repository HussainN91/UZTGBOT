/**
 * Integration tests for the deletion pass.
 *
 * Every function under test destroys records and nothing undoes any of it, so
 * the tests are ordered the way the risk is: the ones asserting **nothing** is
 * deleted come before the ones asserting something is.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CASE_CATEGORY } from '../config/constants.js';
import type { RetentionPeriods } from '../config/retention.js';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import {
  deleteOldMessages,
  deleteResolvedCases,
  pruneAnnouncementRecipients,
  pruneConversationStates,
  pruneUrgentCodeAttempts,
  scrubSyncRunRejections,
} from './purge.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const CHAT = '970001';
const IDENTIFIER = 'purge.tester@example.com';

const PERIODS: RetentionPeriods = { caseDays: 7, urgentCaseDays: 180, messageDays: 3 };
const NOTHING_SET: RetentionPeriods = { caseDays: null, urgentCaseDays: null, messageDays: null };

describe.skipIf(!TEST_DATABASE_URL)('the retention pass', () => {
  let pool: pg.Pool;
  let db: Database;

  const seedCase = async (
    reference: string,
    over: {
      status?: string;
      importance?: string;
      closedDaysAgo?: number | null;
      createdDaysAgo?: number;
    } = {},
  ): Promise<void> => {
    const created = over.createdDaysAgo ?? 30;
    const closed = over.closedDaysAgo;
    await db.execute(sql`
      INSERT INTO cases (reference, category, teacher_chat_id, status, importance, created_at, updated_at, closed_at)
      VALUES (
        ${reference},
        ${CASE_CATEGORY.VISA},
        ${CHAT},
        ${over.status ?? 'Completed'},
        ${over.importance ?? 'Normal'}::case_importance,
        now() - make_interval(days => ${created}),
        now() - make_interval(days => ${created}),
        ${closed === null || closed === undefined ? null : sql`now() - make_interval(days => ${closed})`}
      )
    `);
  };

  const caseExists = async (reference: string): Promise<boolean> => {
    const rows = await db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM cases WHERE reference = ${reference}`,
    );
    return Number(rows.rows[0]?.n ?? 0) > 0;
  };

  const noteCount = async (reference: string): Promise<number> => {
    const rows = await db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM case_notes WHERE case_reference = ${reference}`,
    );
    return Number(rows.rows[0]?.n ?? 0);
  };

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`
      TRUNCATE cases, case_notes, teachers, roster_entries, messages, conversation_states,
               urgent_code_attempts, sync_runs, announcements, announcement_recipients,
               case_sequences CASCADE
    `);
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active)
      VALUES (${IDENTIFIER}, 'Purge Tester', 'Tashkent', true)
    `);
    await db.execute(sql`
      INSERT INTO teachers (chat_id, verification_state, identifier, name, region)
      VALUES (${CHAT}, 'Verified', ${IDENTIFIER}, 'Purge Tester', 'Tashkent')
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('deleteResolvedCases', () => {
    it('deletes nothing at all when no period is set', async () => {
      /**
       * Plan D30, and the first test in this file deliberately. This is the
       * behaviour that protects every record in the database from a settings
       * row nobody has filled in — which is the state the system is in between
       * the deploy and the runbook's launch insert.
       */
      await seedCase('VISA-2026-00001', { closedDaysAgo: 400 });
      await seedCase('VISA-2026-00002', { closedDaysAgo: 400, importance: 'Critical' });

      expect(await deleteResolvedCases(db, NOTHING_SET)).toBe(0);
      expect(await caseExists('VISA-2026-00001')).toBe(true);
      expect(await caseExists('VISA-2026-00002')).toBe(true);
    });

    it('keeps an unresolved case for ever, however old', async () => {
      // D28. A case nobody resolved is kept indefinitely, and "indefinitely"
      // has to mean it however long the case has been open.
      await seedCase('VISA-2026-00003', {
        status: 'Action required',
        createdDaysAgo: 900,
        closedDaysAgo: null,
      });

      await deleteResolvedCases(db, PERIODS);
      expect(await caseExists('VISA-2026-00003')).toBe(true);
    });

    it('reads importance and NEVER status', async () => {
      /**
       * D22, R13, and the single most important assertion in the stage. A case
       * marked Critical that gets resolved becomes `Completed`, and nothing
       * about `Completed` remembers it was ever an emergency — a job reading
       * status would delete exactly the cases most worth keeping, at the
       * shortest interval, and nobody would notice for six months.
       */
      await seedCase('VISA-2026-00004', { closedDaysAgo: 30, importance: 'Critical' });
      await seedCase('VISA-2026-00005', { closedDaysAgo: 30, importance: 'Urgent' });
      await seedCase('VISA-2026-00006', { closedDaysAgo: 30, importance: 'Normal' });

      expect(await deleteResolvedCases(db, PERIODS)).toBe(1);

      expect(await caseExists('VISA-2026-00004')).toBe(true); // 30 < 180
      expect(await caseExists('VISA-2026-00005')).toBe(true); // 30 < 180
      expect(await caseExists('VISA-2026-00006')).toBe(false); // 30 > 7
    });

    it('deletes an urgent case once its own period has passed', async () => {
      await seedCase('VISA-2026-00007', { closedDaysAgo: 200, importance: 'Urgent' });
      expect(await deleteResolvedCases(db, PERIODS)).toBe(1);
      expect(await caseExists('VISA-2026-00007')).toBe(false);
    });

    it('measures from closed_at, not from created_at or updated_at', async () => {
      // A case opened last year and closed on Tuesday has one more week, not
      // none. This is the assertion the `closed_at` fix in Stage 4 exists for.
      await seedCase('VISA-2026-00008', { createdDaysAgo: 400, closedDaysAgo: 2 });
      await deleteResolvedCases(db, PERIODS);
      expect(await caseExists('VISA-2026-00008')).toBe(true);
    });

    it('honours one period when the other is unset', async () => {
      // The likeliest real misconfiguration. Ordinary cases must still go on the
      // period MoPSE did set, and urgent ones must be kept rather than guessed.
      await seedCase('VISA-2026-00009', { closedDaysAgo: 30, importance: 'Normal' });
      await seedCase('VISA-2026-00010', { closedDaysAgo: 400, importance: 'Critical' });

      expect(await deleteResolvedCases(db, { ...PERIODS, urgentCaseDays: null })).toBe(1);
      expect(await caseExists('VISA-2026-00009')).toBe(false);
      expect(await caseExists('VISA-2026-00010')).toBe(true);
    });

    it('takes the notes with the case', async () => {
      /**
       * D8's `ON DELETE CASCADE`. Case notes hold staff writing about teachers
       * and must not outlive the case. Asserted rather than assumed, because the
       * cascade lives in the schema and this is the only thing depending on it.
       */
      await seedCase('VISA-2026-00011', { closedDaysAgo: 30 });
      await db.execute(sql`
        INSERT INTO case_notes (case_reference, author_chat_id, body)
        VALUES ('VISA-2026-00011', '979001', 'unreachable since March, three attempts')
      `);
      expect(await noteCount('VISA-2026-00011')).toBe(1);

      await deleteResolvedCases(db, PERIODS);
      expect(await noteCount('VISA-2026-00011')).toBe(0);
    });

    it('leaves case_sequences alone, so a reference can never be reissued', async () => {
      /**
       * R30. The Apps Script version derived the next number by scanning the
       * sheet for the current maximum, which under-counted the moment the
       * archive job moved rows out — and could therefore reissue a reference
       * already in use. The counter table is what makes deletion safe, so
       * nothing may prune it.
       */
      await db.execute(
        sql`INSERT INTO case_sequences (prefix, year, last_value) VALUES ('VISA', 2026, 482)`,
      );
      await seedCase('VISA-2026-00012', { closedDaysAgo: 30 });

      await deleteResolvedCases(db, PERIODS);

      const rows = await db.execute<{ last_value: number }>(
        sql`SELECT last_value FROM case_sequences WHERE prefix = 'VISA' AND year = 2026`,
      );
      expect(rows.rows[0]?.last_value).toBe(482);
    });

    it('leaves the teacher row standing', async () => {
      // `cases.teacher_chat_id` is ON DELETE restrict, which is about deleting a
      // teacher and never blocked deleting a case. The teacher stays because
      // their other history does.
      await seedCase('VISA-2026-00013', { closedDaysAgo: 30 });
      await deleteResolvedCases(db, PERIODS);

      const rows = await db.execute<{ n: string }>(
        sql`SELECT count(*) AS n FROM teachers WHERE chat_id = ${CHAT}`,
      );
      expect(Number(rows.rows[0]?.n)).toBe(1);
    });
  });

  describe('deleteOldMessages', () => {
    const seedMessage = async (daysAgo: number): Promise<void> => {
      await db.execute(sql`
        INSERT INTO messages (chat_id, action, detail, at)
        VALUES (${CHAT}, 'MESSAGE', 'a question about visas', now() - make_interval(days => ${daysAgo}))
      `);
    };

    it('deletes nothing when the period is unset', async () => {
      await seedMessage(400);
      expect(await deleteOldMessages(db, null)).toBe(0);
    });

    it('deletes rows past the period and keeps the rest', async () => {
      await seedMessage(5);
      await seedMessage(1);
      expect(await deleteOldMessages(db, 3)).toBe(1);

      const rows = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM messages`);
      expect(Number(rows.rows[0]?.n)).toBe(1);
    });
  });

  describe('pruneConversationStates', () => {
    const seedState = async (chatId: string, expiresInMinutes: number): Promise<void> => {
      await db.execute(sql`
        INSERT INTO conversation_states (chat_id, state, payload, expires_at)
        VALUES (
          ${chatId},
          'AwaitingQuestionTopic',
          ${sql`'{"kind":"AwaitingQuestionTopic","query":"when will my visa arrive"}'::jsonb`},
          now() + make_interval(mins => ${expiresInMinutes})
        )
      `);
    };

    it('never touches a state that has not expired', async () => {
      /**
       * R25. A teacher part-way through an urgent case has a state with a
       * 24-hour life, and deleting it costs them a spent single-use code and
       * everything they had typed — which is the failure `URGENT_DETAIL_TTL_HOURS`
       * exists to prevent.
       */
      await seedState('970101', 30);
      expect(await pruneConversationStates(db, 3)).toBe(0);
    });

    it('never touches a state that expired recently', async () => {
      // Expired is already invisible to the router (D4). Deleting it early buys
      // nothing and removes a row somebody investigating a complaint may want.
      await seedState('970102', -60);
      expect(await pruneConversationStates(db, 3)).toBe(0);
    });

    it('deletes a state that expired longer ago than the period', async () => {
      // The teacher's typed question lives in the payload, so this is the same
      // class of content as `messages` and goes on the same period.
      await seedState('970103', -60 * 24 * 10);
      expect(await pruneConversationStates(db, 3)).toBe(1);
    });

    it('deletes nothing when the period is unset', async () => {
      await seedState('970104', -60 * 24 * 10);
      expect(await pruneConversationStates(db, null)).toBe(0);
    });
  });

  describe('pruneUrgentCodeAttempts', () => {
    it('deletes wrong-guess rows past the period', async () => {
      // Meaningful only inside a 60-minute window, and nothing has ever deleted
      // one. A chat id and a timestamp is the same class of content as messages.
      await db.execute(sql`
        INSERT INTO urgent_code_attempts (chat_id, at)
        VALUES (${CHAT}, now() - make_interval(days => 10)), (${CHAT}, now())
      `);
      expect(await pruneUrgentCodeAttempts(db, 3)).toBe(1);
    });

    it('deletes nothing when the period is unset', async () => {
      await db.execute(
        sql`INSERT INTO urgent_code_attempts (chat_id, at) VALUES (${CHAT}, now() - make_interval(days => 400))`,
      );
      expect(await pruneUrgentCodeAttempts(db, null)).toBe(0);
    });
  });

  describe('scrubSyncRunRejections', () => {
    const seedRun = async (daysAgo: number): Promise<string> => {
      const rows = await db.execute<{ id: string }>(sql`
        INSERT INTO sync_runs (source, outcome, rows_seen, rows_rejected, rejections, started_at)
        VALUES (
          'ROSTER', 'applied', 100, 1,
          ${sql`'[{"row":4,"reason":"IDENTIFIER appears more than once","value":"a.karimov@example.com"}]'::jsonb`},
          now() - make_interval(days => ${daysAgo})
        )
        RETURNING id
      `);
      return rows.rows[0]!.id;
    };

    it('empties the rejections and keeps the row and its count', async () => {
      /**
       * R24. `Rejection.value` holds the teacher's recruitment email for a
       * duplicate roster row, the sync runs every ten minutes, and nothing has
       * ever deleted a `sync_runs` row — so one bad spreadsheet line puts that
       * address into 144 rows a day, for ever. `rows_rejected` is a separate
       * column, so the operational signal survives the scrub.
       */
      const id = await seedRun(30);
      expect(await scrubSyncRunRejections(db, 3)).toBe(1);

      const rows = await db.execute<{ rejections: unknown; rows_rejected: number }>(
        sql`SELECT rejections, rows_rejected FROM sync_runs WHERE id = ${id}`,
      );
      expect(rows.rows[0]?.rejections).toEqual([]);
      expect(rows.rows[0]?.rows_rejected).toBe(1);
    });

    it('leaves a recent run alone, because somebody is still acting on it', async () => {
      await seedRun(1);
      expect(await scrubSyncRunRejections(db, 3)).toBe(0);
    });

    it('does not rewrite a run it has already scrubbed', async () => {
      // Otherwise every nightly run reports work it did not do, and a count
      // nobody can trust is a count nobody reads.
      await seedRun(30);
      await scrubSyncRunRejections(db, 3);
      expect(await scrubSyncRunRejections(db, 3)).toBe(0);
    });

    it('scrubs nothing when the period is unset', async () => {
      await seedRun(400);
      expect(await scrubSyncRunRejections(db, null)).toBe(0);
    });
  });

  describe('pruneAnnouncementRecipients', () => {
    const seedAnnouncement = async (finishedDaysAgo: number | null): Promise<string> => {
      const rows = await db.execute<{ id: string }>(sql`
        INSERT INTO announcements (content, audience, status, created_by, finished_at)
        VALUES (
          'The office is closed on Thursday.', 'all',
          ${finishedDaysAgo === null ? 'Sending' : 'Sent'}::announcement_status,
          '979001',
          ${finishedDaysAgo === null ? null : sql`now() - make_interval(days => ${finishedDaysAgo})`}
        )
        RETURNING id
      `);
      const id = rows.rows[0]!.id;
      await db.execute(sql`
        INSERT INTO announcement_recipients (announcement_id, chat_id, state)
        VALUES (${id}, ${CHAT}, 'Sent')
      `);
      return id;
    };

    it('keeps the announcement itself for ever, and drops the recipient rows', async () => {
      // The announcement is the record of what MoPSE told teachers and is
      // audit-class. The 1,800 chat ids beside it answer no question anybody
      // asks a month later.
      const id = await seedAnnouncement(60);
      expect(await pruneAnnouncementRecipients(db, 30)).toBe(1);

      const kept = await db.execute<{ n: string }>(
        sql`SELECT count(*) AS n FROM announcements WHERE id = ${id}`,
      );
      expect(Number(kept.rows[0]?.n)).toBe(1);
    });

    it('never touches one that has not finished', async () => {
      // Deleting the recipient rows of a send in flight is deleting the record
      // of who has already been messaged, which is what makes a restart safe.
      await seedAnnouncement(null);
      expect(await pruneAnnouncementRecipients(db, 30)).toBe(0);
    });

    it('never touches one that finished recently', async () => {
      await seedAnnouncement(2);
      expect(await pruneAnnouncementRecipients(db, 30)).toBe(0);
    });
  });
});
