/**
 * New-case notification — D11, the largest missing endpoint in the system.
 *
 * Before this, a teacher filed a case and nothing anywhere was told: not a staff
 * member, not the operations chat, not the log. The case sat in a table nobody
 * queried.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CASE_CATEGORY, NEW_CASE_NOTIFY_CAP } from '../config/constants.js';
import { withChatLock } from '../conversation/lock.js';
import { saveState } from '../conversation/state.js';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import { route, type InboundUpdate, type RouterOutcome } from '../telegram/router.js';
import { createCase } from './service.js';
import { notifyNewCase, type NotificationOutcome } from './notify.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const SUPPORT = '+998 71 000 0000';

/** Staff. The names say what each one is for. */
const VISA_SUPPORT_TASHKENT = '992001';
const VISA_SUPPORT_SAMARKAND = '992002';
const ACCOM_SUPPORT_EVERYWHERE = '992003';
const OBSERVER_EVERYTHING = '992004';
const SYSTEM_NARROW = '992005';
const DEACTIVATED_SUPPORT = '992006';

/** Teachers. */
const TASHKENT_TEACHER = '992101';
const NOWHERE_TEACHER = '992102';

const TASHKENT_ID = 'tashkent.teacher@example.com';
const NOWHERE_ID = 'nowhere.teacher@example.com';

const DETAIL = 'the landlord has changed the locks and my passport is inside';

describe.skipIf(!TEST_DATABASE_URL)('new-case notification', () => {
  let pool: pg.Pool;
  let db: Database;

  /** File a case as the teacher would, and announce it, in one transaction. */
  const fileAndNotify = async (
    chatId: string,
    category: string,
    urgent = false,
  ): Promise<{ reference: string; outcome: NotificationOutcome }> =>
    withChatLock(db, chatId, async (tx) => {
      const created = await createCase(tx, {
        chatId,
        category: category as never,
        detail: DETAIL,
        ...(urgent ? { escalate: true } : {}),
      });
      const outcome = await notifyNewCase(tx, {
        reference: created.reference,
        category,
        teacherChatId: chatId,
        urgent,
      });
      return { reference: created.reference, outcome };
    });

  const statusOf = async (reference: string): Promise<string> => {
    const rows = await db.execute<{ status: string }>(
      sql`SELECT status FROM cases WHERE reference = ${reference}`,
    );
    return rows.rows[0]?.status ?? '(no such case)';
  };

  const systemLog = async (): Promise<{ action: string; detail: string }[]> => {
    const rows = await db.execute<{ action: string; detail: string }>(
      sql`SELECT action, detail FROM messages WHERE chat_id = 'SYSTEM'`,
    );
    return rows.rows;
  };

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`
      TRUNCATE cases, teachers, roster_entries, case_sequences, conversation_states,
               messages, faq_entries, urgent_codes, urgent_code_attempts,
               processed_updates, settings, staff, audit_log CASCADE
    `);

    await db.execute(sql`
      INSERT INTO staff (telegram_id, name, role, queue, regions, active) VALUES
        (${VISA_SUPPORT_TASHKENT},   'Visa Tashkent',  'Support',  'Visa',          ARRAY['Tashkent']::text[],  true),
        (${VISA_SUPPORT_SAMARKAND},  'Visa Samarkand', 'Support',  'Visa',          ARRAY['Samarkand']::text[], true),
        (${ACCOM_SUPPORT_EVERYWHERE},'Accom Anywhere', 'Support',  'Accommodation', ARRAY[]::text[],            true),
        (${OBSERVER_EVERYTHING},     'The Observer',   'Observer', 'All',           ARRAY[]::text[],            true),
        (${SYSTEM_NARROW},           'System Person',  'System',   'None',          ARRAY['Nukus']::text[],     true),
        (${DEACTIVATED_SUPPORT},     'Gone Away',      'Support',  'All',           ARRAY[]::text[],            false)
    `);

    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active) VALUES
        (${TASHKENT_ID}, 'Tashkent Teacher', 'Tashkent', true),
        (${NOWHERE_ID},  'Nowhere Teacher',  NULL,       true)
    `);
    await db.execute(sql`
      INSERT INTO teachers (chat_id, identifier, name, region, verification_state) VALUES
        (${TASHKENT_TEACHER}, ${TASHKENT_ID}, 'Tashkent Teacher', 'Tashkent', 'Verified'),
        (${NOWHERE_TEACHER},  ${NOWHERE_ID},  'Nowhere Teacher',  NULL,       'Verified')
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('who is told', () => {
    it('tells the staff who can see the case, and nobody else', async () => {
      const { outcome } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.VISA);
      const told = outcome.messages.map((m) => m.chatId);

      expect(told).toContain(VISA_SUPPORT_TASHKENT);
      // Right queue, wrong region.
      expect(told).not.toContain(VISA_SUPPORT_SAMARKAND);
      // Right region, wrong queue.
      expect(told).not.toContain(ACCOM_SUPPORT_EVERYWHERE);
    });

    it('does not notify an Observer, who could not act on it', async () => {
      // R14. `case.view` is not the same question as "should this person be
      // paged". An observer notified about every case that arrives is being
      // paged about work they are not permitted to do.
      const { outcome } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.VISA);

      expect(outcome.messages.map((m) => m.chatId)).not.toContain(OBSERVER_EVERYTHING);
    });

    it('never notifies a deactivated member', async () => {
      const { outcome } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.VISA);

      expect(outcome.messages.map((m) => m.chatId)).not.toContain(DEACTIVATED_SUPPORT);
    });

    it('tells a System member whatever their queue and region say', async () => {
      // The bypass in the visibility rule, and it has to hold here too: a System
      // member with a queue of None and one unrelated region still covers
      // everything (AdminCommands.gs:290-294).
      const { outcome } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.VISA);

      expect(outcome.messages.map((m) => m.chatId)).toContain(SYSTEM_NARROW);
    });

    it('hides a case from nobody when the teacher’s region is unknown', async () => {
      // D10, and the property most likely to break: a teacher with no region on
      // either the override or the roster must reach every region-scoped staff
      // member, or they file cases nobody sees and nobody finds out.
      const { outcome } = await fileAndNotify(NOWHERE_TEACHER, CASE_CATEGORY.VISA);
      const told = outcome.messages.map((m) => m.chatId);

      expect(told).toContain(VISA_SUPPORT_TASHKENT);
      expect(told).toContain(VISA_SUPPORT_SAMARKAND);
    });

    it('sends an uncategorised case to every queue', async () => {
      // Contact Support is by definition the case that has not been classified.
      // Routing it to a specialist would be guessing.
      const { outcome } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.CONTACT_SUPPORT);
      const told = outcome.messages.map((m) => m.chatId);

      expect(told).toContain(VISA_SUPPORT_TASHKENT);
      expect(told).toContain(ACCOM_SUPPORT_EVERYWHERE);
    });

    it('caps the recipients', async () => {
      // R9. `deliver` sends sequentially inside the webhook request, which is
      // configured with a 25-second timeout and onTimeout: 'return'.
      const extra = Array.from({ length: NEW_CASE_NOTIFY_CAP + 5 }, (_, i) => 993000 + i);
      for (const id of extra) {
        await db.execute(sql`
          INSERT INTO staff (telegram_id, role, queue, regions, active)
          VALUES (${String(id)}, 'Support', 'All', ARRAY[]::text[], true)
        `);
      }

      const { outcome } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.VISA);

      expect(outcome.messages).toHaveLength(NEW_CASE_NOTIFY_CAP);
    });
  });

  describe('what they are told', () => {
    it('never includes the case detail', async () => {
      // A teacher's free text is not copied into twenty Telegram histories
      // (AdminCommands.gs:325). Staff read it with /case, which checks
      // permissions first and leaves a row saying who read it.
      const { outcome } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.VISA);

      expect(outcome.messages.length).toBeGreaterThan(0);
      expect(outcome.messages.every((m) => !m.text.includes(DETAIL))).toBe(true);
      expect(outcome.messages.every((m) => !m.text.includes('locks'))).toBe(true);
    });

    it('carries the reference, the category and a way to open the case', async () => {
      const { reference, outcome } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.VISA);
      const body = outcome.messages[0]?.text ?? '';

      expect(body).toContain(reference);
      expect(body).toContain(CASE_CATEGORY.VISA);
      expect(body).toContain(`/case ${reference}`);
      expect(body).toContain(`/assign ${reference}`);
    });

    it('says what every message is, so a failed send names the right thing', async () => {
      // R10. Until `purpose` existed, `deliver` described every message after
      // the first as a duplicate sign-in notice — which was true only while that
      // was the only such message.
      const ordinary = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.VISA);
      expect(ordinary.outcome.messages.every((m) => m.purpose !== undefined)).toBe(true);
      expect(ordinary.outcome.messages[0]?.purpose).toMatch(/new case/i);

      const urgent = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.TRAVEL, true);
      expect(urgent.outcome.messages[0]?.purpose).toMatch(/urgent/i);
    });

    it('marks an urgent case as urgent where a person will see it', async () => {
      const { outcome } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.TRAVEL, true);

      expect(outcome.messages[0]?.text ?? '').toMatch(/urgent/i);
    });
  });

  describe('when nobody can act', () => {
    it('raises a critical alert naming the category', async () => {
      // Apps Script wrote console.error and returned (AdminCommands.gs:355-359);
      // the case then sat unseen and the only trace was in a log nobody opens.
      await db.execute(sql`DELETE FROM staff WHERE role <> 'Observer'`);

      const { outcome } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.ACCOMMODATION);

      expect(outcome.messages).toHaveLength(0);
      expect(outcome.alerts[0]?.severity).toBe('critical');
      expect(outcome.alerts[0]?.body).toContain(CASE_CATEGORY.ACCOMMODATION);
    });

    it('alarms when a queue is covered only by Observers', async () => {
      // R14 colliding with R4. A queue where cases arrive and nobody is able to
      // work them must alarm rather than look staffed — the alert says so in
      // those words, because "no staff at all" and "staff who may only look" are
      // different problems with different fixes.
      await db.execute(sql`DELETE FROM staff WHERE role <> 'Observer'`);

      const { outcome } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.ACCOMMODATION);

      expect(outcome.alerts[0]?.body.toLowerCase()).toContain('observer');
    });

    it('distinguishes nobody at all from nobody who may act', async () => {
      await db.execute(sql`DELETE FROM staff`);

      const { outcome } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.ACCOMMODATION);

      expect(outcome.alerts[0]?.severity).toBe('critical');
      expect(outcome.alerts[0]?.body.toLowerCase()).not.toContain('observer');
    });
  });

  describe('the status the notification writes', () => {
    it('moves a new case to Received once somebody has been told', async () => {
      // D25. This is what gives `Received` a writer — it has never had one — and
      // it makes "filed, and somebody can see it" distinguishable from "filed,
      // and nobody could" without asking any staff member to maintain it.
      const { reference } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.VISA);

      expect(await statusOf(reference)).toBe('Received');
    });

    it('leaves a case at New when nobody was told', async () => {
      // The two states cannot both be true: either somebody can see it, or the
      // critical alert above fired.
      await db.execute(sql`DELETE FROM staff`);

      const { reference } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.VISA);

      expect(await statusOf(reference)).toBe('New');
    });

    it('never demotes an escalated case to Received', async () => {
      // The urgent path files at Escalated, and Escalated is what puts a case in
      // /urgent while it is open. Overwriting it here would take an emergency
      // out of the list that exists to show emergencies.
      const { reference } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.TRAVEL, true);

      expect(await statusOf(reference)).toBe('Escalated');
    });
  });

  describe('the log row', () => {
    it('records the fan-out against SYSTEM, never against a case reference', async () => {
      // schema.ts:459 reserves 'SYSTEM' for bot-initiated events precisely so a
      // reference never lands in the chat id column.
      const { reference } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.VISA);

      const rows = await systemLog();
      expect(rows.map((r) => r.action)).toContain('STAFF_NOTIFIED_NEW');
      expect(rows.some((r) => r.detail.includes(reference))).toBe(true);
    });

    it('names an urgent fan-out differently', async () => {
      await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.TRAVEL, true);

      expect((await systemLog()).map((r) => r.action)).toContain('STAFF_NOTIFIED_URGENT');
    });

    it('records the zero, so a case nobody saw is visible in the log too', async () => {
      await db.execute(sql`DELETE FROM staff`);

      await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.VISA);

      expect((await systemLog()).some((r) => r.detail.includes('0'))).toBe(true);
    });
  });

  describe('through the whole pipeline', () => {
    const send = (update: InboundUpdate): Promise<RouterOutcome> =>
      withChatLock(db, update.chatId, (tx) => route(tx, update, { supportContact: SUPPORT }));

    const describing = (): Promise<void> =>
      saveState(db, TASHKENT_TEACHER, {
        kind: 'AwaitingCaseDetail',
        category: CASE_CATEGORY.VISA,
        attempts: 0,
      });

    it('tells staff when a teacher actually files a case', async () => {
      await describing();

      const outcome = await send({
        chatId: TASHKENT_TEACHER,
        kind: 'text',
        text: DETAIL,
      });

      // messages[0] is the teacher's confirmation; everything after it is staff.
      expect(outcome.messages.length).toBeGreaterThan(1);
      expect(outcome.messages.slice(1).map((m) => m.chatId)).toContain(VISA_SUPPORT_TASHKENT);
      expect(outcome.messages.slice(1).every((m) => !m.text.includes(DETAIL))).toBe(true);
    });

    it('announces an urgent escalation of a case staff already know about', async () => {
      /**
       * The dedup path, and it is the *common* one. Urgent cases have no topic
       * picker, so every one of them files under the general category — and so
       * does every ordinary Contact Support case, which means a teacher who
       * opened one yesterday always deduplicates against it. If notification
       * fired only on an insert, the escalation nobody hears about would be the
       * one a teacher spent a single-use code on.
       */
      await saveState(db, TASHKENT_TEACHER, {
        kind: 'AwaitingCaseDetail',
        category: CASE_CATEGORY.CONTACT_SUPPORT,
        attempts: 0,
      });
      await send({ chatId: TASHKENT_TEACHER, kind: 'text', text: 'the water has been off a week' });

      await db.execute(sql`
        INSERT INTO urgent_codes (code, issued_by, expires_at)
        VALUES ('QQ42ZZ', ${VISA_SUPPORT_TASHKENT}, now() + interval '48 hours')
      `);
      await saveState(db, TASHKENT_TEACHER, { kind: 'AwaitingUrgentCode', attempts: 0 });
      await send({ chatId: TASHKENT_TEACHER, kind: 'text', text: 'QQ42ZZ' });

      const escalated = await send({
        chatId: TASHKENT_TEACHER,
        kind: 'text',
        text: 'it is now a burst pipe and the flat is flooding',
      });

      const staffTold = escalated.messages.slice(1);
      expect(staffTold.length).toBeGreaterThan(0);
      expect(staffTold.map((m) => m.chatId)).toContain(VISA_SUPPORT_TASHKENT);
      expect(staffTold[0]?.text ?? '').toMatch(/urgent/i);
      expect(staffTold[0]?.purpose).toMatch(/urgent/i);
      expect(staffTold.every((m) => !m.text.includes('burst pipe'))).toBe(true);
    });

    it('does not page everybody again when a teacher taps twice', async () => {
      // The 24-hour duplicate window returns the case that already exists.
      // Announcing it again would train twenty people to ignore the alert.
      await describing();
      const first = await send({ chatId: TASHKENT_TEACHER, kind: 'text', text: DETAIL });
      expect(first.messages.length).toBeGreaterThan(1);

      await describing();
      const second = await send({ chatId: TASHKENT_TEACHER, kind: 'text', text: DETAIL });

      expect(second.messages).toHaveLength(1);
    });
  });
});
