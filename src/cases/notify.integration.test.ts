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
import { requestUrgentCase } from './urgent.js';
import {
  notifyNewCase,
  notifyUrgentRequestOnCase,
  type NotificationOutcome,
} from './notify.js';

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
  ): Promise<{ reference: string; owner: string | null; outcome: NotificationOutcome }> =>
    withChatLock(db, chatId, async (tx) => {
      const created = await createCase(tx, {
        chatId,
        category: category as never,
        detail: DETAIL,
      });
      const outcome = await notifyNewCase(tx, {
        reference: created.reference,
        category,
        teacherChatId: chatId,
        owner: created.owner,
      });
      return { reference: created.reference, owner: created.owner, outcome };
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
               processed_updates, settings, staff, audit_log, form_links CASCADE
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
    /**
     * **This block asserted a fan-out until 5 August 2026 and now asserts its
     * opposite** — D1. A new case reached everybody whose queue and region
     * covered it, capped at twenty. On a four-person ministry team that was three
     * or four phones for one teacher's problem, and the MoPSE employee using it
     * described the result as overwhelming and threatening.
     *
     * The questions the old tests asked have not gone away, they have moved.
     * "Who may work this case" is the assigner's question now and
     * `assignment.integration.test.ts` asks it there. What belongs here is
     * narrower: does exactly one person hear, and is it the right one.
     */
    it('writes to the owner and to nobody else', async () => {
      const { outcome, owner } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.VISA);

      expect(owner).toBe(VISA_SUPPORT_TASHKENT);
      expect(outcome.messages).toHaveLength(1);
      expect(outcome.messages[0]?.chatId).toBe(VISA_SUPPORT_TASHKENT);
    });

    it('does not tell a System member, who is no longer in the rotation', async () => {
      /**
       * **The reverse of what this file asserted until 5 August 2026**, and the
       * bypass it tested is untouched. A System member still *sees* every case in
       * the country, which `visibility.integration.test.ts` proves. Being able to
       * see everything was never a reason to be paged about each thing, and D2
       * says so: they see everything and are told almost nothing.
       */
      const { outcome } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.VISA);

      expect(outcome.messages.map((m) => m.chatId)).not.toContain(SYSTEM_NARROW);
    });

    it('tells neither an Observer nor a deactivated member, who can never own one', async () => {
      // R14 still holds and is structural now rather than filtered: the assigner
      // cannot choose either of them, so neither can be the single recipient.
      const { outcome } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.VISA);
      const told = outcome.messages.map((m) => m.chatId);

      expect(told).not.toContain(OBSERVER_EVERYTHING);
      expect(told).not.toContain(DEACTIVATED_SUPPORT);
    });

    it('still reaches a person when the teacher’s region is unknown', async () => {
      // D10, and the property most likely to break. A teacher with no region on
      // either the override or the roster must still reach somebody. What keeps
      // that true is now the assigner rather than a wide fan-out, so it is worth
      // asserting from this end as well.
      const { outcome, owner } = await fileAndNotify(NOWHERE_TEACHER, CASE_CATEGORY.VISA);

      expect(owner).not.toBeNull();
      expect(outcome.messages).toHaveLength(1);
    });

    it('sends an uncategorised case to the general desk', async () => {
      // D6 as a person feels it. Contact Support belongs to Accommodation now,
      // so the one person told is the one who covers that.
      const { outcome } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.CONTACT_SUPPORT);

      expect(outcome.messages).toHaveLength(1);
      expect(outcome.messages[0]?.chatId).toBe(ACCOM_SUPPORT_EVERYWHERE);
    });

    it('writes one message however many people cover the case', async () => {
      /**
       * What the recipient cap used to guard, asserted from the other side.
       *
       * R9's reasoning was that `deliver` sends sequentially inside a webhook
       * request with a 25-second timeout, so twenty-five sends could exhaust it.
       * One send cannot. The cap still exists and still applies to the two urgent
       * messages, which do go to more than one person.
       */
      const extra = Array.from({ length: NEW_CASE_NOTIFY_CAP + 5 }, (_, i) => 993000 + i);
      for (const id of extra) {
        await db.execute(sql`
          INSERT INTO staff (telegram_id, role, queue, regions, active)
          VALUES (${String(id)}, 'Support', 'All', ARRAY[]::text[], true)
        `);
      }

      const { outcome } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.VISA);

      expect(outcome.messages).toHaveLength(1);
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

    it('says three lines, and carries the case on a button', async () => {
      /**
       * Seven lines became three. The two it used to end with were instructions
       * to type `/case` and `/assign` with a nineteen-character reference in
       * them, which is what a message looked like before anything could be
       * tapped.
       */
      const { reference, outcome } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.VISA);
      const body = outcome.messages[0]?.text ?? '';

      expect(body).toContain('New case for you');
      expect(body).toContain(CASE_CATEGORY.VISA);
      expect(body).toContain('Tashkent');
      expect(body).not.toContain(`/case ${reference}`);
      expect(body).not.toContain(`/assign ${reference}`);
      expect(body.split('\n').filter((line) => line.trim() !== '')).toHaveLength(3);

      expect(outcome.messages[0]?.keyboard?.[0]?.[0]?.callback_data).toBe(`CO:${reference}`);
    });

    it('says "for you", which it could not say when it went to everybody', async () => {
      // The single most useful word in the message, and it is only sayable
      // because exactly one person receives it now.
      const { outcome } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.VISA);

      expect(outcome.messages[0]?.text).toContain('for you');
    });

    it('has no em dash in it', async () => {
      // §7 of the design. The humanizer bans them outright, and they are most of
      // what made these messages read like a machine explaining itself.
      const { outcome } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.VISA);

      expect(outcome.messages[0]?.text).not.toContain('—');
    });

    it('says what every message is, so a failed send names the right thing', async () => {
      // R10. Until `purpose` existed, `deliver` described every message after
      // the first as a duplicate sign-in notice — which was true only while that
      // was the only such message.
      const ordinary = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.VISA);
      expect(ordinary.outcome.messages.every((m) => m.purpose !== undefined)).toBe(true);
      expect(ordinary.outcome.messages[0]?.purpose).toMatch(/new case/i);
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
      /**
       * `Escalated` is what puts a case in `/urgent` while it is open, and
       * overwriting it here would take a confirmed priority case out of the one
       * list that exists to show them.
       *
       * The case is escalated by hand rather than through the request path: no
       * caller can open a case at `Escalated` any more — `createCase` lost the
       * flag that allowed it on 1 August 2026 — so the only way to reach this
       * state in a test is the way the confirmation reaches it in production,
       * which is a later write.
       */
      const { reference } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.TRAVEL);
      await db.execute(
        sql`UPDATE cases SET status = 'Escalated' WHERE reference = ${reference}`,
      );

      await withChatLock(db, TASHKENT_TEACHER, (tx) =>
        notifyNewCase(tx, {
          reference,
          category: CASE_CATEGORY.TRAVEL,
          teacherChatId: TASHKENT_TEACHER,
          owner: VISA_SUPPORT_TASHKENT,
        }),
      );

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

    it('names an urgent-request fan-out differently from a new case', async () => {
      /**
       * Two different events, and the log has to tell them apart or "how many
       * priority requests went unanswered" cannot be asked of it — which is the
       * question the accepted "it waits on one coordinator" risk needs an answer
       * to.
       */
      await withChatLock(db, TASHKENT_TEACHER, async (tx) => {
        const asked = await requestUrgentCase(tx, {
          chatId: TASHKENT_TEACHER,
          detail: 'my appointment is on Tuesday',
        });
        await notifyUrgentRequestOnCase(tx, {
          reference: asked.reference,
          category: CASE_CATEGORY.CONTACT_SUPPORT,
          teacherChatId: TASHKENT_TEACHER,
          isNew: asked.isNew,
          owner: asked.owner,
        });
      });

      const actions = (await systemLog()).map((r) => r.action);
      expect(actions).toContain('STAFF_NOTIFIED_URGENT_REQUEST');
      expect(actions).toContain('STAFF_NOTIFIED_NEW');
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

    it('announces a priority request on a case staff already know about', async () => {
      /**
       * The dedup path, and it is the *common* one. A priority request has no
       * topic picker, so every one of them files under the general category —
       * and so does every ordinary Contact Support case, which means a teacher
       * who opened one yesterday always deduplicates against it. If notification
       * fired only on an insert, the request nobody hears about would be the one
       * from the teacher who had already been in touch.
       */
      await saveState(db, TASHKENT_TEACHER, {
        kind: 'AwaitingCaseDetail',
        category: CASE_CATEGORY.CONTACT_SUPPORT,
        attempts: 0,
      });
      await send({ chatId: TASHKENT_TEACHER, kind: 'text', text: 'the water has been off a week' });

      await saveState(db, TASHKENT_TEACHER, { kind: 'AwaitingUrgentDetail', attempts: 0 });
      const asked = await send({
        chatId: TASHKENT_TEACHER,
        kind: 'text',
        text: 'it is now a burst pipe and the flat is flooding',
      });

      const staffTold = asked.messages.slice(1);
      expect(staffTold.length).toBeGreaterThan(0);
      expect(staffTold[0]?.purpose).toMatch(/urgent|priority/i);
      // The teacher's own words stay behind /case, which records who read them.
      expect(staffTold.every((m) => !m.text.includes('burst pipe'))).toBe(true);
      // And the buttons are what make the message actionable. Two now: open the
      // case, or grant the priority without opening it.
      const buttons = (staffTold[0]?.keyboard?.[0] ?? []).map((b) => b.callback_data);
      expect(buttons.some((data) => data.startsWith('CO:'))).toBe(true);
      expect(buttons.some((data) => data.startsWith('UC:'))).toBe(true);
    });

    it('sends one message, not two, when a case is filed and made urgent at once', async () => {
      /**
       * **The failure this whole phase would otherwise have introduced.**
       *
       * Both notices go to the owner now, so without the overlap strip in
       * `notifyUrgentRequestOnCase` a teacher filing a case and asking for
       * priority in the same breath would put two messages in one person's chat a
       * second apart. That is the exact thing D1 exists to stop, arriving through
       * the change that implements it.
       */
      await saveState(db, TASHKENT_TEACHER, { kind: 'AwaitingUrgentDetail', attempts: 0 });

      const asked = await send({
        chatId: TASHKENT_TEACHER,
        kind: 'text',
        text: 'the landlord has locked me out and it is dark',
      });

      // messages[0] is the teacher's own confirmation.
      const staffTold = asked.messages.slice(1);
      expect(staffTold).toHaveLength(1);
      expect(staffTold[0]?.text).toContain('Priority asked for');
    });

    it('asks the owner about priority, and says nothing about staffing', async () => {
      await saveState(db, TASHKENT_TEACHER, { kind: 'AwaitingUrgentDetail', attempts: 0 });

      const asked = await send({ chatId: TASHKENT_TEACHER, kind: 'text', text: 'no heating' });
      const body = asked.messages[1]?.text ?? '';

      // §7. Nothing in capitals, no warning block, no dash, and no sentence
      // telling a caseworker about a staffing gap they cannot do anything about.
      expect(body).not.toContain('—');
      expect(body).not.toMatch(/staffing gap|NO active staff/);
      expect(body).toContain('Tashkent Teacher');
      expect(body.split('\n').filter((line) => line.trim() !== '')).toHaveLength(3);
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

  /**
   * A complaint raised in a form area. Whether the paperwork has arrived is what
   * decides the recipient's next move — chase the teacher, or read what they
   * sent — so it is on the notice rather than one command away.
   */
  describe('a complaint raised in a form area', () => {
    const ACCOM_TEACHER_CHAT = TASHKENT_TEACHER;

    /** File a case in an area and announce it, in one transaction. */
    const fileInArea = async (
      formType: string,
      category: string,
    ): Promise<NotificationOutcome> =>
      withChatLock(db, ACCOM_TEACHER_CHAT, async (tx) => {
        const created = await createCase(tx, {
          chatId: ACCOM_TEACHER_CHAT,
          category: category as never,
          detail: DETAIL,
          formType,
        });
        return notifyNewCase(tx, {
          reference: created.reference,
          category,
          teacherChatId: ACCOM_TEACHER_CHAT,
          owner: created.owner,
        });
      });

    beforeEach(async () => {
      await db.execute(sql`
        INSERT INTO form_links (type, sheet_row, button_text, url, category, prepare, active)
        VALUES ('REIMBURSE', 1, 'Reimbursement', 'https://forms.gle/abc',
                'Accommodation', 'Receipts as one PDF.', true)
      `);
    });

    it('tells staff the paperwork has not arrived yet', async () => {
      const notices = await fileInArea('REIMBURSE', CASE_CATEGORY.ACCOMMODATION);
      const body = notices.messages[0]?.text ?? '';

      expect(body).toContain('Reimbursement');
      expect(body).toMatch(/not sent yet/i);
    });

    it('says the form is in once the submission has been filed against the case', async () => {
      const notices = await withChatLock(db, ACCOM_TEACHER_CHAT, async (tx) => {
        const created = await createCase(tx, {
          chatId: ACCOM_TEACHER_CHAT,
          category: CASE_CATEGORY.ACCOMMODATION,
          detail: DETAIL,
          formType: 'REIMBURSE',
        });
        // What the response sync does when the package turns up.
        await tx.execute(
          sql`UPDATE cases SET awaiting_form = false WHERE reference = ${created.reference}`,
        );
        return notifyNewCase(tx, {
          reference: created.reference,
          category: CASE_CATEGORY.ACCOMMODATION,
          teacherChatId: ACCOM_TEACHER_CHAT,
          owner: created.owner,
        });
      });

      const body = notices.messages[0]?.text ?? '';
      expect(body).toMatch(/Reimbursement, sent/i);
      expect(body).not.toMatch(/not sent yet/i);
    });

    it('says nothing about paperwork on a case raised any other way', async () => {
      const { outcome } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.ACCOMMODATION);
      const body = outcome.messages[0]?.text ?? '';
      expect(body).not.toMatch(/📄|not sent yet|, sent/);
    });

    /**
     * An area MoPSE retires must not stop its existing cases notifying, which is
     * why `cases.form_type` is deliberately not a foreign key. The notice falls
     * back to the raw code — worse to read than "Reimbursement", and very much
     * better than no notice at all.
     */
    it('still notifies, naming the raw code, when the area has left the sheet', async () => {
      const notices = await fileInArea('GONE_AWAY', CASE_CATEGORY.ACCOMMODATION);
      const body = notices.messages[0]?.text ?? '';

      expect(notices.messages.length).toBeGreaterThan(0);
      expect(body).toContain('GONE_AWAY');
      expect(body).toMatch(/not sent yet/i);
    });
  });
});
