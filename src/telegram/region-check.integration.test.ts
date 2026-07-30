/**
 * Asking a teacher whether the region we hold is still right — Task 46, D21.
 *
 * The only teacher-visible change in stage 4, added to a teacher path that was
 * finished and working. Most of what is asserted here is therefore about what the
 * question does **not** do: it does not change a region, it does not replace the
 * menu, it does not appear twice, and it never turns up while somebody is
 * describing a problem.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CASE_TOPIC_CHOICES } from '../config/constants.js';
import { PRIVACY_NOTICE_VERSION } from '../config/privacy.js';
import { retentionPeriods } from '../config/settings.js';
import { withChatLock } from '../conversation/lock.js';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import { recordAcceptance } from '../teachers/privacy.js';
import { regionFor } from '../teachers/region.js';
import { CALLBACK, encodeCallback } from './callback-data.js';
import { MENU_ACTION } from './keyboards.js';
import { route, type InboundUpdate, type RouterOutcome } from './router.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const SUPPORT = '+998 71 000 0000';

const TEACHER = '997101';
const UNPLACED = '997102';
const STRANGER = '997103';

const TEACHER_ID = 'regioncheck.teacher@example.com';
const UNPLACED_ID = 'regioncheck.unplaced@example.com';

const MAIN_MENU = encodeCallback(CALLBACK.MENU, MENU_ACTION.MAIN);
const CONTACT_SUPPORT = encodeCallback(CALLBACK.MENU, MENU_ACTION.CONTACT_SUPPORT);
const STILL_RIGHT = encodeCallback(CALLBACK.REGION_CONFIRMED);
const I_HAVE_MOVED = encodeCallback(CALLBACK.REGION_MOVED);

describe.skipIf(!TEST_DATABASE_URL)('asking a teacher about their region', () => {
  let pool: pg.Pool;
  let db: Database;

  const send = (update: InboundUpdate): Promise<RouterOutcome> =>
    withChatLock(db, update.chatId, (tx) => route(tx, update, { supportContact: SUPPORT }));

  const text = (body: string, chatId = TEACHER): Promise<RouterOutcome> =>
    send({ chatId, kind: 'text', text: body });

  const tap = (data: string, chatId = TEACHER): Promise<RouterOutcome> =>
    send({ chatId, kind: 'callback', text: data });

  /** The region question, if it was asked at all. */
  const regionAsk = (outcome: RouterOutcome): string | undefined =>
    outcome.messages.find((m) => m.text.includes('We have you in'))?.text;

  const flaggedAt = async (chatId: string): Promise<string | null> => {
    const rows = await db.execute<{ region_flagged_at: string | null }>(
      sql`SELECT region_flagged_at FROM teachers WHERE chat_id = ${chatId}`,
    );
    return rows.rows[0]?.region_flagged_at ?? null;
  };

  const askedAt = async (chatId: string): Promise<string | null> => {
    const rows = await db.execute<{ region_asked_at: string | null }>(
      sql`SELECT region_asked_at FROM teachers WHERE chat_id = ${chatId}`,
    );
    return rows.rows[0]?.region_asked_at ?? null;
  };

  /** Wind the clock back on the record rather than on the process. */
  const askedDaysAgo = (chatId: string, days: number): Promise<unknown> =>
    db.execute(
      sql`UPDATE teachers SET region_asked_at = now() - make_interval(days => ${days}) WHERE chat_id = ${chatId}`,
    );

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`
      TRUNCATE cases, case_notes, teachers, roster_entries, case_sequences,
               conversation_states, messages, faq_entries, urgent_codes,
               urgent_code_attempts, processed_updates, settings, staff,
               audit_log CASCADE
    `);

    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active) VALUES
        (${TEACHER_ID},  'The Teacher',      'Tashkent', true),
        (${UNPLACED_ID}, 'Unplaced Teacher', NULL,       true)
    `);
    await db.execute(sql`
      INSERT INTO teachers (chat_id, identifier, name, region, verification_state) VALUES
        (${TEACHER},  ${TEACHER_ID},  'The Teacher',      'Tashkent', 'Verified'),
        (${UNPLACED}, ${UNPLACED_ID}, 'Unplaced Teacher', NULL,       'Verified')
    `);

    /**
     * These teachers have accepted the current notice, because every `Verified`
     * teacher has — `bindTeacher` writes the version and the periods as part of
     * signing in, so a verified row with no acceptance is a row this system
     * cannot produce.
     *
     * Without it the re-consent gate (D32) correctly stands in front of Contact
     * Support and Urgent Case, and every test below about the *region* question
     * would be measuring the privacy notice instead.
     */
    for (const chatId of [TEACHER, UNPLACED]) {
      await recordAcceptance(db, chatId, PRIVACY_NOTICE_VERSION, await retentionPeriods(db));
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('when it is asked', () => {
    it('comes with the menu, never instead of it', async () => {
      // "Never as a blocker" is the whole shape of D21. The menu stays the first
      // message and works exactly as it did; the question sits beside it and can
      // be left alone for ever.
      const outcome = await text('/start');

      expect(outcome.messages).toHaveLength(2);
      expect(outcome.messages[0]?.text).toBe('What would you like to do?');
      expect(outcome.messages[0]?.keyboard).toBeDefined();
      expect(regionAsk(outcome)).toContain('Tashkent');
    });

    it('names what the answer is for, not just the region', async () => {
      // A question with no stated purpose is one people answer carelessly, and
      // this one decides who receives their emergency.
      const asked = regionAsk(await text('/start')) ?? '';

      expect(asked).toMatch(/which of our staff sees your case/i);
      expect(asked).toMatch(/nothing changes automatically/i);
    });

    it('is asked from the Main Menu button as well as /start', async () => {
      expect(regionAsk(await tap(MAIN_MENU))).toContain('Tashkent');
    });

    it('does not ask again the next day', async () => {
      await text('/start');
      await askedDaysAgo(TEACHER, 1);

      const second = await text('/start');
      expect(second.messages).toHaveLength(1);
      expect(regionAsk(second)).toBeUndefined();
    });

    it('asks again once the interval has passed', async () => {
      await text('/start');
      await askedDaysAgo(TEACHER, 200);

      expect(regionAsk(await text('/start'))).toContain('Tashkent');
    });

    it('stops asking whether or not the teacher answered', async () => {
      // Stamped when shown, not when answered. Stamped on answer, somebody who
      // ignores the question is asked again every time they open the menu —
      // which for 1,800 people is a question tapped through unread.
      await text('/start');
      expect(await askedAt(TEACHER)).not.toBeNull();

      expect(regionAsk(await tap(MAIN_MENU))).toBeUndefined();
    });

    it('does not ask a teacher whose region we do not hold', async () => {
      // There is nothing to confirm, and their cases are already visible to every
      // staff member — over-routed rather than misrouted.
      expect(regionAsk(await text('/start', UNPLACED))).toBeUndefined();
      expect(await askedAt(UNPLACED)).toBeNull();
    });

    it('does not ask a chat that has not signed in', async () => {
      const outcome = await text('/start', STRANGER);

      expect(outcome.messages).toHaveLength(1);
      expect(regionAsk(outcome)).toBeUndefined();
    });

    it('does not ask a revoked teacher to maintain our records', async () => {
      await db.execute(
        sql`UPDATE teachers SET verification_state = 'Revoked', revoked_at = now() WHERE chat_id = ${TEACHER}`,
      );

      expect(regionAsk(await text('/start'))).toBeUndefined();
    });
  });

  describe('never interrupts a teacher part-way through a case', () => {
    it('stays out of the whole filing path, from the first tap to the case being filed', async () => {
      // This teacher is due to be asked — asked_at is null — so if the question
      // were leaking into any of these three steps it would appear here.
      const topic = CASE_TOPIC_CHOICES[0]!.key;

      const picker = await tap(CONTACT_SUPPORT);
      const prompt = await tap(encodeCallback(CALLBACK.CASE_TOPIC, topic));
      const filed = await text('the embassy still has my passport');

      expect(regionAsk(picker)).toBeUndefined();
      expect(regionAsk(prompt)).toBeUndefined();
      expect(regionAsk(filed)).toBeUndefined();

      const cases = await db.execute<{ count: string }>(sql`SELECT count(*) FROM cases`);
      expect(Number(cases.rows[0]?.count)).toBe(1);
    });

    it('leaves a typed question alone', async () => {
      const outcome = await text('how long does a visa take');
      expect(regionAsk(outcome)).toBeUndefined();
    });
  });

  describe('what the two answers do', () => {
    it('does not change the region when a teacher says it is wrong', async () => {
      // D21. The teacher is the best source of the signal and the worst source of
      // the record — region decides who receives their emergency, so a menu of
      // regions is a menu of "who gets my problem". They report; staff decide.
      await text('/start');
      await tap(I_HAVE_MOVED);

      expect(await regionFor(db, TEACHER)).toBe('Tashkent');
      expect(await flaggedAt(TEACHER)).not.toBeNull();
    });

    it('tells the teacher a person will deal with it, and that they need do nothing', async () => {
      const body = (await tap(I_HAVE_MOVED)).messages[0]?.text ?? '';

      expect(body).toMatch(/one of our staff will check/i);
      expect(body).toMatch(/nothing you need to do/i);
    });

    it('writes nothing at all when the teacher says it is right', async () => {
      await text('/start');
      await tap(STILL_RIGHT);

      expect(await regionFor(db, TEACHER)).toBe('Tashkent');
      expect(await flaggedAt(TEACHER)).toBeNull();
    });

    it('withdraws an earlier report when the teacher later says it is right', async () => {
      // Otherwise /regions keeps showing a manager work that the person who
      // raised it no longer wants done.
      await tap(I_HAVE_MOVED);
      expect(await flaggedAt(TEACHER)).not.toBeNull();

      await tap(STILL_RIGHT);
      expect(await flaggedAt(TEACHER)).toBeNull();
    });

    it('answers a stranger’s tap exactly as it answers a teacher’s', async () => {
      // The button survives in a teacher's scrollback for ever and arrives from
      // the network, so it can be hand-crafted. Neither answer moves a case, and
      // saying "no such teacher" would tell a stranger whether we hold a record.
      const stranger = (await tap(I_HAVE_MOVED, STRANGER)).messages[0]?.text ?? '';
      const teacher = (await tap(I_HAVE_MOVED)).messages[0]?.text ?? '';

      expect(stranger).toBe(teacher);
      expect(await flaggedAt(STRANGER)).toBeNull();
    });
  });
});
