/**
 * The announcement sweeper — Task 69, and the last thing standing between a
 * drafted broadcast and 1,800 teachers.
 *
 * Four properties matter more than the rest, and each has a test named after it:
 *
 *   **One batch a run.** The worker is `concurrency: 1`, and a run that paces
 *   itself through 1,800 sends starves the ten-minute sync and the five-minute
 *   heartbeat — whose first symptom is a *false* alarm that the sheet sync has
 *   stopped (D42, R27).
 *
 *   **Nobody is messaged twice.** A restart mid-broadcast resumes; it does not
 *   repeat. That is the whole reason there is no job to enqueue.
 *
 *   **A teacher who lost access between the draft and the send is `Skipped`,
 *   never `Failed`** (D41). They are two different things to do something about.
 *
 *   **A broadcast with nobody in it still finishes.** Left at `Queued` it is
 *   invisible for ever.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDraft, findAnnouncement, markQueued, tally } from '../../announcements/store.js';
import { ANNOUNCEMENT_BATCH } from '../../config/constants.js';
import type { Database } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { announcementMessage } from '../../digest/format.js';
import type { SendResult } from '../../telegram/send.js';
import { CRONTAB } from '../main.js';
import {
  ANNOUNCEMENT_TASK,
  type AnnouncementSender,
  runSweep,
} from './announcements.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const SENDER = '994001';
const TEACHER_A = '994101';
const TEACHER_B = '994102';
const TEACHER_C = '994103';

const ok: SendResult = { ok: true, messageId: 1 };
const blocked: SendResult = {
  ok: false,
  failure: { kind: 'blocked', description: 'bot was blocked by the user' },
};
const rateLimited: SendResult = {
  ok: false,
  failure: { kind: 'rate_limited', retryAfterSeconds: 30, description: 'Too Many Requests' },
};

/**
 * Every message the sweeper tried to send, with a scripted answer per chat id.
 *
 * The report to the drafter goes through this same sender, which is deliberate:
 * a test that asserts a report arrived is asserting it through the one path that
 * actually delivers it.
 */
const recordingSender = (
  scripted: Readonly<Record<string, SendResult>> = {},
): { sender: AnnouncementSender; sent: { chatId: string; text: string }[] } => {
  const sent: { chatId: string; text: string }[] = [];
  return {
    sent,
    sender: {
      send: async (chatId, text) => {
        const answer = scripted[chatId] ?? ok;
        if (answer.ok) sent.push({ chatId, text });
        return answer;
      },
    },
  };
};

describe('the sweeper is the only sender, and it runs every minute', () => {
  it('is scheduled every minute', () => {
    // D37 and D42. Every minute, one batch, and no ad-hoc enqueue — which is
    // what keeps announcements out of `job_runs` as an on-demand row that would
    // raise a critical alarm every hour nobody sent one (R22).
    expect(CRONTAB).toContain(`* * * * * ${ANNOUNCEMENT_TASK}`);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('the announcement sweeper', () => {
  let pool: pg.Pool;
  let db: Database;

  const addTeacher = async (chatId: string, region = 'Tashkent'): Promise<void> => {
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active)
      VALUES (${`t${chatId}@example.com`}, ${`Teacher ${chatId}`}, ${region}, true)
    `);
    await db.execute(sql`
      INSERT INTO teachers (chat_id, identifier, name, region, verification_state)
      VALUES (${chatId}, ${`t${chatId}@example.com`}, ${`Teacher ${chatId}`}, ${region}, 'Verified')
    `);
  };

  /** A queued broadcast with its audience already frozen, through the real store. */
  const queueBroadcast = async (content = 'The office is closed on Friday.'): Promise<string> => {
    const { id } = await createDraft(db, {
      content,
      audience: { kind: 'all' },
      createdBy: SENDER,
    });
    await markQueued(db, id);
    return id;
  };

  const stateOf = async (id: string, chatId: string): Promise<string> => {
    const rows = await db.execute<{ state: string }>(sql`
      SELECT state FROM announcement_recipients
      WHERE announcement_id = ${id} AND chat_id = ${chatId}
    `);
    return rows.rows[0]?.state ?? 'missing';
  };

  const lastErrorOf = async (id: string, chatId: string): Promise<string | null> => {
    const rows = await db.execute<{ last_error: string | null }>(sql`
      SELECT last_error FROM announcement_recipients
      WHERE announcement_id = ${id} AND chat_id = ${chatId}
    `);
    return rows.rows[0]?.last_error ?? null;
  };

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`
      TRUNCATE cases, case_notes, teachers, roster_entries, case_sequences,
               conversation_states, messages, faq_entries, urgent_codes,
               urgent_code_attempts, processed_updates, settings, staff,
               audit_log, announcements, announcement_recipients CASCADE
    `);
    await db.execute(sql`
      INSERT INTO staff (telegram_id, name, role, queue, regions, active)
      VALUES (${SENDER}, 'The Sender', 'Program', 'All', ARRAY[]::text[], true)
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('an ordinary broadcast', () => {
    it('does nothing at all when there is nothing queued', async () => {
      // Most minutes of most days. It has to be cheap and it has to be silent:
      // one indexed read and a return.
      const { sender, sent } = recordingSender();

      const report = await runSweep(db, sender);

      expect(report.announcementId).toBeNull();
      expect(sent).toHaveLength(0);
    });

    it('picks up a queued broadcast and moves it to Sending', async () => {
      await addTeacher(TEACHER_A);
      await addTeacher(TEACHER_B);
      const id = await queueBroadcast();

      const { sender, sent } = recordingSender();
      await runSweep(db, sender);

      expect(sent.map((m) => m.chatId)).toEqual(
        expect.arrayContaining([TEACHER_A, TEACHER_B]),
      );
      expect(await stateOf(id, TEACHER_A)).toBe('Sent');
    });

    it('delivers the message the sender approved, character for character', async () => {
      // One rendering, in `announcementMessage`. Two renderings of one message is
      // how a preview stops being a preview.
      await addTeacher(TEACHER_A);
      await queueBroadcast('Passport collection moves to Tuesday.');

      const { sender, sent } = recordingSender();
      await runSweep(db, sender);

      expect(sent.find((m) => m.chatId === TEACHER_A)?.text).toBe(
        announcementMessage('Passport collection moves to Tuesday.'),
      );
    });
  });

  describe('one batch a run, and never the same teacher twice', () => {
    it(`sends at most ${ANNOUNCEMENT_BATCH} in a single run`, async () => {
      /**
       * D42 and R27, and the reason this is a sweeper rather than a job that
       * paces itself. A run that worked through 1,800 sends would hold the only
       * worker slot for minutes, and the first symptom would be a false alarm
       * that the sheet sync had stopped.
       */
      await db.execute(sql`
        INSERT INTO roster_entries (identifier, name, region, active)
        SELECT 'bulk' || i || '@example.com', 'Teacher ' || i, 'Tashkent', true
        FROM generate_series(1, ${ANNOUNCEMENT_BATCH + 1}) i
      `);
      await db.execute(sql`
        INSERT INTO teachers (chat_id, identifier, name, region, verification_state)
        SELECT (900000 + i)::text, 'bulk' || i || '@example.com', 'Teacher ' || i,
               'Tashkent', 'Verified'
        FROM generate_series(1, ${ANNOUNCEMENT_BATCH + 1}) i
      `);
      await queueBroadcast();

      const first = recordingSender();
      const firstReport = await runSweep(db, first.sender);
      expect(firstReport.sent).toBe(ANNOUNCEMENT_BATCH);
      expect(firstReport.finished).toBe(false);

      const second = recordingSender();
      const secondReport = await runSweep(db, second.sender);
      expect(secondReport.sent).toBe(1);
      expect(secondReport.finished).toBe(true);

      // The whole point: resumed, not repeated.
      const everyone = [...first.sent, ...second.sent].map((m) => m.chatId);
      const teachers = everyone.filter((c) => c !== SENDER);
      expect(new Set(teachers).size).toBe(teachers.length);
      expect(teachers).toHaveLength(ANNOUNCEMENT_BATCH + 1);
      /**
       * Longer than the default five seconds, and the number is worth knowing
       * rather than hiding: two hundred recipients is two hundred access
       * re-checks and two hundred marks, sequentially, which is a few seconds of
       * round trips before Telegram is involved at all. Comfortably inside a
       * one-minute sweep, and the reason the batch is 200 rather than 2,000.
       */
    }, 30_000);

    it('does not message anybody twice when two sweeps overlap', async () => {
      // R27, second order. The claim is one conditional UPDATE, never a read
      // followed by a write, so the next minute's run cannot take a recipient
      // this one is still working on.
      await addTeacher(TEACHER_A);
      await addTeacher(TEACHER_B);
      await addTeacher(TEACHER_C);
      await queueBroadcast();

      const a = recordingSender();
      const b = recordingSender();
      await Promise.all([runSweep(db, a.sender), runSweep(db, b.sender)]);

      const teachers = [...a.sent, ...b.sent]
        .map((m) => m.chatId)
        .filter((c) => c !== SENDER);
      expect(new Set(teachers).size).toBe(teachers.length);
    });
  });

  describe('what happens to a recipient who cannot be reached', () => {
    it('skips a teacher who lost access between the draft and the send', async () => {
      /**
       * D41, and the distinction the handoff singles out. A draft can sit for a
       * day. Somebody revoked this morning was correctly frozen into the audience
       * last night and must not be messaged — and must not be recorded as a
       * delivery failure either, because a failure is something to chase and this
       * is not.
       */
      await addTeacher(TEACHER_A);
      await addTeacher(TEACHER_B);
      const id = await queueBroadcast();

      await db.execute(sql`
        UPDATE teachers SET verification_state = 'Revoked', revoked_at = now()
        WHERE chat_id = ${TEACHER_A}
      `);

      const { sender, sent } = recordingSender();
      const report = await runSweep(db, sender);

      expect(sent.map((m) => m.chatId)).not.toContain(TEACHER_A);
      expect(await stateOf(id, TEACHER_A)).toBe('Skipped');
      expect(report.skipped).toBe(1);
      expect(report.failed).toBe(0);
    });

    it('skips a teacher whose roster row went, not only one who was revoked', async () => {
      // `teacherHasAccess` is the single answer to "may this person use the bot",
      // and it is both halves. The re-check must ask it rather than re-express it.
      await addTeacher(TEACHER_A);
      const id = await queueBroadcast();

      await db.execute(sql`UPDATE roster_entries SET active = false`);

      const { sender } = recordingSender();
      await runSweep(db, sender);

      expect(await stateOf(id, TEACHER_A)).toBe('Skipped');
    });

    it('writes off a teacher who has blocked the bot', async () => {
      await addTeacher(TEACHER_A);
      const id = await queueBroadcast();

      const { sender } = recordingSender({ [TEACHER_A]: blocked });
      const report = await runSweep(db, sender);

      expect(await stateOf(id, TEACHER_A)).toBe('Failed');
      expect(await lastErrorOf(id, TEACHER_A)).toContain('blocked');
      expect(report.failed).toBe(1);
      expect(report.skipped).toBe(0);
    });

    it('hands a rate-limited teacher back for the next sweep', async () => {
      /**
       * `isRetryable` is the only thing that decides retry versus write-off. A
       * rate limit is Telegram asking us to wait, not a teacher who cannot be
       * reached, and writing one off would silently drop them from a broadcast.
       */
      await addTeacher(TEACHER_A);
      const id = await queueBroadcast();

      const first = recordingSender({ [TEACHER_A]: rateLimited });
      const firstReport = await runSweep(db, first.sender);

      expect(await stateOf(id, TEACHER_A)).toBe('Pending');
      expect(firstReport.retrying).toBe(1);
      expect(await findAnnouncement(db, id).then((r) => r?.status)).toBe('Sending');

      const second = recordingSender();
      await runSweep(db, second.sender);
      expect(await stateOf(id, TEACHER_A)).toBe('Sent');
    });

    it('stops the batch when Telegram starts rate-limiting, and returns the rest', async () => {
      // Hammering a 429 earns a longer one. The remainder of the claimed batch
      // goes back Pending rather than being spent against a limit we have just
      // been told about.
      await addTeacher(TEACHER_A);
      await addTeacher(TEACHER_B);
      await addTeacher(TEACHER_C);
      const id = await queueBroadcast();

      const { sender } = recordingSender({
        [TEACHER_A]: rateLimited,
        [TEACHER_B]: rateLimited,
        [TEACHER_C]: rateLimited,
      });
      await runSweep(db, sender);

      const counts = await tally(db, id);
      expect(counts.sent).toBe(0);
      expect(counts.failed).toBe(0);
      expect(counts.pending).toBe(3);
    });
  });

  describe('finishing, and saying so', () => {
    it('reports to whoever drafted it, once, when the last recipient is resolved', async () => {
      // D41. Three counts, never one — sent, skipped and failed need different
      // things done about them.
      await addTeacher(TEACHER_A);
      await addTeacher(TEACHER_B);
      const id = await queueBroadcast();

      const { sender, sent } = recordingSender({ [TEACHER_B]: blocked });
      const report = await runSweep(db, sender);

      expect(report.finished).toBe(true);
      expect(await findAnnouncement(db, id).then((r) => r?.status)).toBe('Sent');

      const reports = sent.filter((m) => m.chatId === SENDER);
      expect(reports).toHaveLength(1);
      expect(reports[0]?.text).toContain('Sent: 1 of 2');
      expect(reports[0]?.text).toContain('Failed: 1');
    });

    it('does not report a second time on the next sweep', async () => {
      await addTeacher(TEACHER_A);
      await queueBroadcast();

      const first = recordingSender();
      await runSweep(db, first.sender);
      expect(first.sent.filter((m) => m.chatId === SENDER)).toHaveLength(1);

      const second = recordingSender();
      const secondReport = await runSweep(db, second.sender);
      expect(secondReport.announcementId).toBeNull();
      expect(second.sent).toHaveLength(0);
    });

    it('finishes a broadcast that nobody was in', async () => {
      /**
       * The failure that is invisible rather than loud. "Nobody is in that
       * region" is a thing `/announce` reports at draft time, and a broadcast
       * left at `Queued` for ever afterwards is one nothing will ever mention
       * again — including the sweeper, which would pick it up every minute and
       * find nothing to do.
       */
      const id = await queueBroadcast();

      const { sender, sent } = recordingSender();
      const report = await runSweep(db, sender);

      expect(report.finished).toBe(true);
      expect(await findAnnouncement(db, id).then((r) => r?.status)).toBe('Sent');
      expect(sent.filter((m) => m.chatId === SENDER)).toHaveLength(1);
    });

    it('takes the oldest queued broadcast first', async () => {
      await addTeacher(TEACHER_A);
      const older = await queueBroadcast('The first thing.');
      await db.execute(sql`
        UPDATE announcements SET created_at = now() - make_interval(hours => 1)
        WHERE id = ${older}
      `);
      await queueBroadcast('The second thing.');

      const { sender } = recordingSender();
      const report = await runSweep(db, sender);

      expect(report.announcementId).toBe(older);
    });

    it('leaves a cancelled broadcast alone', async () => {
      // `/announce_cancel` marks the remaining recipients `Skipped` and the row
      // `Cancelled`. Neither is a state the sweeper looks for, and this asserts
      // that rather than assuming it.
      await addTeacher(TEACHER_A);
      const id = await queueBroadcast();
      await db.execute(sql`UPDATE announcements SET status = 'Cancelled' WHERE id = ${id}`);

      const { sender, sent } = recordingSender();
      const report = await runSweep(db, sender);

      expect(report.announcementId).toBeNull();
      expect(sent).toHaveLength(0);
      expect(await stateOf(id, TEACHER_A)).toBe('Pending');
    });
  });
});
