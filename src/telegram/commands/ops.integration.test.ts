/**
 * `/maintenance`, `/urgent_pending` and `/retention` — Task 37, revised.
 *
 * The second of these was `/generate_urgent_code` until 1 August 2026, and its
 * tests drove both halves of a feature whose two ends had never met: urgent
 * codes had only ever been inserted by hand through the runbook, so nothing had
 * ever proved that the format a person would issue was the format the teacher
 * flow accepted. The route is gone, so there is nothing left to join up — what
 * is tested now is that a request nobody has decided is findable.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PRIVACY_NOTICE_VERSION, retentionParagraph } from '../../config/privacy.js';
import { recordAcceptance } from '../../teachers/privacy.js';
import { clearSettingsCache, isMaintenanceMode, retentionPeriods } from '../../config/settings.js';
import type { Database } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { withChatLock } from '../../conversation/lock.js';
import { CALLBACK, encodeCallback } from '../callback-data.js';
import { MENU_ACTION } from '../keyboards.js';
import { route, type InboundUpdate, type RouterOutcome } from '../router.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const SUPPORT = '+998 71 000 0000';

const SYSTEM = '999001';
const SUPPORT_MEMBER = '999002';
const OBSERVER = '999003';

const TEACHER = '999101';
const IDENTIFIER = 'ops.teacher@example.com';

describe.skipIf(!TEST_DATABASE_URL)('operational commands', () => {
  let pool: pg.Pool;
  let db: Database;

  const send = (update: InboundUpdate): Promise<RouterOutcome> =>
    withChatLock(db, update.chatId, (tx) => route(tx, update, { supportContact: SUPPORT }));

  const run = async (text: string, chatId = SYSTEM): Promise<string> =>
    (await send({ chatId, kind: 'text', text })).messages[0]?.text ?? '';

  const teacherTypes = async (text: string): Promise<string> =>
    (await send({ chatId: TEACHER, kind: 'text', text })).messages[0]?.text ?? '';

  const teacherTaps = async (data: string, chatId = TEACHER): Promise<string> =>
    (await send({ chatId, kind: 'callback', text: data })).messages[0]?.text ?? '';

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`
      TRUNCATE cases, case_notes, teachers, roster_entries, case_sequences,
               conversation_states, messages, faq_entries, urgent_codes,
               urgent_code_attempts, processed_updates, settings, staff,
               audit_log CASCADE
    `);
    clearSettingsCache();

    await db.execute(sql`
      INSERT INTO staff (telegram_id, name, role, queue, regions, active) VALUES
        (${SYSTEM},         'System Admin',   'System',   'All', ARRAY[]::text[], true),
        (${SUPPORT_MEMBER}, 'Support Person', 'Support',  'All', ARRAY[]::text[], true),
        (${OBSERVER},       'New Starter',    'Observer', 'All', ARRAY[]::text[], true)
    `);
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active)
      VALUES (${IDENTIFIER}, 'Ops Test Teacher', 'Tashkent', true)
    `);
    await db.execute(sql`
      INSERT INTO teachers (chat_id, identifier, name, region, verification_state)
      VALUES (${TEACHER}, ${IDENTIFIER}, 'Ops Test Teacher', 'Tashkent', 'Verified')
    `);

    /**
     * This teacher has accepted the current notice, because every `Verified`
     * teacher has — `bindTeacher` writes the version and the periods as part of
     * signing in, so a verified row with no acceptance is one this system cannot
     * produce.
     *
     * Without it the re-consent gate (D32) stands in front of Urgent Case, and
     * the tests below about `/maintenance` and urgent codes would be measuring
     * the privacy notice instead. That is the gate working; this is the fixture
     * catching up with it.
     */
    await recordAcceptance(db, TEACHER, PRIVACY_NOTICE_VERSION, await retentionPeriods(db));
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('/maintenance', () => {
    it('pauses new cases, and the teacher path sees it immediately', async () => {
      // setSetting drops the cached value, which is the whole reason the writer
      // lives beside the cache. Without that a pause would take up to a minute
      // to bite, during which the person who typed it watches cases arrive.
      await run('/maintenance on');

      expect(await isMaintenanceMode(db)).toBe(true);
      expect(await teacherTaps(encodeCallback(CALLBACK.MENU, MENU_ACTION.CONTACT_SUPPORT))).toMatch(
        /paused/i,
      );
    });

    it('says plainly that cases already being written still arrive', async () => {
      // R6. The router checks maintenance when a case is started and when a topic
      // is chosen, not when the detail is submitted, because stopping a teacher
      // there would throw away what they had typed. Without this sentence the
      // first System member to use it reports the trickle of cases as a bug.
      const body = await run('/maintenance on');

      expect(body).toMatch(/keep arriving/i);
      expect(body).toMatch(/not interrupted/i);
    });

    it('does not interrupt a teacher part-way through writing a case', async () => {
      // The behaviour the sentence above describes, asserted rather than
      // promised.
      await teacherTaps(encodeCallback(CALLBACK.MENU, MENU_ACTION.CONTACT_SUPPORT));
      await teacherTaps(encodeCallback(CALLBACK.CASE_TOPIC, 'OTHER'));

      await run('/maintenance on');

      const filed = await teacherTypes('my contract has not arrived');
      expect(filed).toMatch(/reference/i);

      const rows = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM cases`);
      expect(Number(rows.rows[0]?.n)).toBe(1);
    });

    it('lets cases through again', async () => {
      await run('/maintenance on');
      await run('/maintenance off');

      expect(await isMaintenanceMode(db)).toBe(false);
      expect(await teacherTaps(encodeCallback(CALLBACK.MENU, MENU_ACTION.CONTACT_SUPPORT))).not.toMatch(
        /paused/i,
      );
    });

    it('reports the current state without changing it', async () => {
      const body = await run('/maintenance');

      expect(body).toMatch(/running normally/i);
      expect(await isMaintenanceMode(db)).toBe(false);
    });

    it('refuses a word it does not understand rather than guessing', async () => {
      // "on" and "off" differ by one character and mean opposite things. A fuzzy
      // match would turn a typo into an outage.
      const body = await run('/maintenance of');

      expect(body).toMatch(/do not understand/i);
      expect(await isMaintenanceMode(db)).toBe(false);
    });

    it('says so and records nothing when it is already in that state', async () => {
      await run('/maintenance on');
      const body = await run('/maintenance on');

      expect(body).toMatch(/already paused/i);

      const rows = await db.execute<{ n: string }>(
        sql`SELECT count(*) AS n FROM audit_log WHERE action = 'MAINTENANCE_SET'`,
      );
      expect(Number(rows.rows[0]?.n)).toBe(1);
    });

    it('records who changed it', async () => {
      // D18. "Who paused the bot at three in the morning" is the question this
      // table exists to answer.
      await run('/maintenance on');

      const rows = await db.execute<{ actor: string; action: string }>(
        sql`SELECT actor, action FROM audit_log`,
      );
      expect(rows.rows).toEqual([{ actor: SYSTEM, action: 'MAINTENANCE_SET' }]);
    });

    it('is not available below System', async () => {
      expect(await run('/maintenance on', SUPPORT_MEMBER)).toMatch(/rank/i);
      expect(await isMaintenanceMode(db)).toBe(false);
    });
  });

  /**
   * `/urgent_pending`, which replaced `/generate_urgent_code`.
   *
   * The command it replaced issued the six-character credential a teacher had to
   * be read down the telephone before the bot would let them describe an urgent
   * problem. Its tests drove both halves of that route end to end, because the
   * two halves had never met — codes had only ever been inserted by hand through
   * `RUNBOOK.md` §4.4. There is no route left to join up.
   *
   * What this covers instead is the property the plan bought with the change:
   * the request is filed and **nobody has to remember it**, because it is
   * listable.
   */
  describe('/urgent_pending', () => {
    const askForPriority = async (): Promise<void> => {
      await teacherTaps(encodeCallback(CALLBACK.MENU, MENU_ACTION.URGENT_CASE));
      await teacherTypes('my residence card appointment is on Tuesday');
    };

    it('says plainly when nothing is waiting', async () => {
      expect(await run('/urgent_pending', SUPPORT_MEMBER)).toMatch(/no priority requests/i);
    });

    it('lists a request a teacher has just made', async () => {
      await askForPriority();

      const body = await run('/urgent_pending', SUPPORT_MEMBER);

      const rows = await db.execute<{ reference: string }>(sql`SELECT reference FROM cases`);
      expect(body).toContain(rows.rows[0]?.reference);
      expect(body).toMatch(/waiting for a decision/i);
    });

    it('never prints the teacher’s own words', async () => {
      // They stay behind /case, which checks permissions and records who read
      // them. A supervision list is not a reading route.
      await askForPriority();

      expect(await run('/urgent_pending', SUPPORT_MEMBER)).not.toContain('residence card');
    });

    it('drops a request once somebody has confirmed it', async () => {
      await askForPriority();
      const rows = await db.execute<{ reference: string }>(sql`SELECT reference FROM cases`);
      await teacherTaps(
        encodeCallback(CALLBACK.URGENT_CONFIRM, rows.rows[0]!.reference),
        SUPPORT_MEMBER,
      );

      expect(await run('/urgent_pending', SUPPORT_MEMBER)).toMatch(/no priority requests/i);
    });

    it('is not available to an Observer', async () => {
      expect(await run('/urgent_pending', OBSERVER)).toMatch(/rank/i);
    });

    it('shows the status of each case beside the request', async () => {
      // `Received`, not `New` — the case reached its queue when it was filed.
      await askForPriority();
      const rows = await db.execute<{ reference: string }>(sql`SELECT reference FROM cases`);

      const body = await run('/urgent_pending', SUPPORT_MEMBER);

      expect(body).toContain(`${rows.rows[0]?.reference} — Received — asked `);
    });

    /**
     * The request that used to sit here for ever with nothing marking it out.
     *
     * The query asks whether a request was made and not decided, and closing a
     * case does neither of those things — so the row stayed, correctly, and
     * looked exactly like the ones still waiting on somebody. A supervision list
     * where the permanent entries are indistinguishable from the live ones is a
     * list people stop reading.
     */
    it('keeps a request whose case was closed, and marks it as closed', async () => {
      await askForPriority();
      const rows = await db.execute<{ reference: string }>(sql`SELECT reference FROM cases`);
      await db.execute(
        sql`UPDATE cases SET status = 'Completed', closed_at = now() WHERE reference = ${rows.rows[0]!.reference}`,
      );

      const body = await run('/urgent_pending', SUPPORT_MEMBER);

      expect(body).toContain(rows.rows[0]?.reference);
      expect(body).toContain('Completed');
      expect(body).toMatch(/since been closed/i);
    });

    it('says nothing about closed cases when there are none', async () => {
      await askForPriority();

      expect(await run('/urgent_pending', SUPPORT_MEMBER)).not.toMatch(/since been closed/i);
    });
  });

  /**
   * The confirm-urgent button — the first callback in this system a staff member
   * taps rather than a teacher.
   *
   * A Telegram message sits in a chat for ever, so every one of these is about
   * the same thing: the payload is a promise about the world made when the
   * message was built, and none of it may be trusted on the way back in.
   */
  describe('the confirm-urgent button', () => {
    const askForPriority = async (): Promise<string> => {
      await teacherTaps(encodeCallback(CALLBACK.MENU, MENU_ACTION.URGENT_CASE));
      await teacherTypes('my residence card appointment is on Tuesday');
      const rows = await db.execute<{ reference: string }>(sql`SELECT reference FROM cases`);
      return rows.rows[0]!.reference;
    };

    const importanceOf = async (reference: string): Promise<string> => {
      const rows = await db.execute<{ importance: string; status: string }>(
        sql`SELECT importance, status FROM cases WHERE reference = ${reference}`,
      );
      return `${rows.rows[0]?.importance}/${rows.rows[0]?.status}`;
    };

    it('raises the case, tells the teacher, and confirms to the tapper', async () => {
      const reference = await askForPriority();

      const outcome = await send({
        chatId: SUPPORT_MEMBER,
        kind: 'callback',
        text: encodeCallback(CALLBACK.URGENT_CONFIRM, reference),
      });

      expect(await importanceOf(reference)).toBe('Urgent/Escalated');
      // messages[0] is always the answer to whoever acted — `deliver` words its
      // failure alarm from that position.
      expect(outcome.messages[0]?.chatId).toBe(SUPPORT_MEMBER);
      const toTeacher = outcome.messages.find((m) => m.chatId === TEACHER);
      expect(toTeacher?.text.toLowerCase()).toContain('marked urgent');
    });

    /**
     * The tap that arrives after somebody closed the case.
     *
     * Telegram keeps the button in the coordinator's chat for ever, so this is an
     * ordinary sequence rather than an exotic one. Two things have to be true
     * afterwards: the case is genuinely open again — no leftover end date for the
     * nightly retention pass to read as "this ended a week ago" — and the
     * coordinator is told that their tap undid somebody else's close.
     */
    it('tells the tapper when confirming has reopened a closed case', async () => {
      const reference = await askForPriority();
      await db.execute(
        sql`UPDATE cases SET status = 'Completed', closed_at = now() WHERE reference = ${reference}`,
      );

      const outcome = await send({
        chatId: SUPPORT_MEMBER,
        kind: 'callback',
        text: encodeCallback(CALLBACK.URGENT_CONFIRM, reference),
      });

      expect(outcome.messages[0]?.text ?? '').toMatch(/had been closed/i);

      const rows = await db.execute<{ closed_at: string | null }>(
        sql`SELECT closed_at FROM cases WHERE reference = ${reference}`,
      );
      expect(rows.rows[0]?.closed_at).toBeNull();
    });

    it('says nothing about reopening on an ordinary confirmation', async () => {
      const reference = await askForPriority();

      const outcome = await send({
        chatId: SUPPORT_MEMBER,
        kind: 'callback',
        text: encodeCallback(CALLBACK.URGENT_CONFIRM, reference),
      });

      expect(outcome.messages[0]?.text ?? '').not.toMatch(/had been closed/i);
    });

    it('says nothing useful to a chat with no staff row', async () => {
      // The dispatcher's rule: an answer that says "you are not staff" tells a
      // stranger that the button they guessed at is real.
      const reference = await askForPriority();

      const outcome = await send({
        chatId: TEACHER,
        kind: 'callback',
        text: encodeCallback(CALLBACK.URGENT_CONFIRM, reference),
      });

      // `Received`, not `New` — the case reached its queue when it was filed.
      // What must not have moved is the importance.
      expect(await importanceOf(reference)).toBe('Normal/Received');
      expect(outcome.messages[0]?.text ?? '').not.toMatch(/staff|rank|permission/i);
    });

    it('refuses an Observer plainly, because they can see the button', async () => {
      const reference = await askForPriority();

      const outcome = await send({
        chatId: OBSERVER,
        kind: 'callback',
        text: encodeCallback(CALLBACK.URGENT_CONFIRM, reference),
      });

      expect(outcome.messages[0]?.text ?? '').toMatch(/rank/i);
      // `Received`, not `New` — the case reached its queue when it was filed.
      // What must not have moved is the importance.
      expect(await importanceOf(reference)).toBe('Normal/Received');
    });

    it('does nothing twice, and names who decided the first time', async () => {
      const reference = await askForPriority();
      const data = encodeCallback(CALLBACK.URGENT_CONFIRM, reference);

      await send({ chatId: SUPPORT_MEMBER, kind: 'callback', text: data });
      const again = await send({ chatId: SYSTEM, kind: 'callback', text: data });

      expect(again.messages[0]?.text ?? '').toContain('already marked urgent');
      expect(again.messages[0]?.text ?? '').toContain(SUPPORT_MEMBER);
      // Nobody is told a second time, least of all the teacher.
      expect(again.messages.some((m) => m.chatId === TEACHER)).toBe(false);

      const audit = await db.execute<{ count: number }>(
        sql`SELECT count(*)::int AS count FROM audit_log WHERE action = 'URGENT_CONFIRMED'`,
      );
      expect(audit.rows[0]?.count).toBe(1);
    });

    describe('the not urgent button — D8', () => {
      /**
       * The counterpart, and the reason it exists: `urgent.issue` floors at
       * Support, so one person can raise a case above every other case in the
       * country alone and with no second signature. The people told that happened
       * need a way to disagree with it.
       */
      const confirmed = async (): Promise<string> => {
        const reference = await askForPriority();
        await send({
          chatId: SUPPORT_MEMBER,
          kind: 'callback',
          text: encodeCallback(CALLBACK.URGENT_CONFIRM, reference),
        });
        return reference;
      };

      it('is refused for the Support member who marked it, naming the rank', async () => {
        // Support grants urgency; taking it back is a Program act, the same rank
        // that may reassign somebody else's case.
        const reference = await confirmed();

        const outcome = await send({
          chatId: SUPPORT_MEMBER,
          kind: 'callback',
          text: encodeCallback(CALLBACK.URGENT_UNMARK, reference),
        });

        expect(outcome.messages[0]?.text ?? '').toContain('Program');
        expect(await importanceOf(reference)).toBe('Urgent/Escalated');
      });

      it('answers a chat with no staff row with the menu, never with a refusal', async () => {
        // The dispatcher's rule again. Confirming the button is real is itself
        // information a stranger should not get.
        const reference = await confirmed();

        const outcome = await send({
          chatId: TEACHER,
          kind: 'callback',
          text: encodeCallback(CALLBACK.URGENT_UNMARK, reference),
        });

        expect(outcome.messages[0]?.text ?? '').not.toMatch(/rank|permission/i);
        expect(await importanceOf(reference)).toBe('Urgent/Escalated');
      });

      it('is obeyed for System, and the teacher is told nothing', async () => {
        const reference = await confirmed();

        const outcome = await send({
          chatId: SYSTEM,
          kind: 'callback',
          text: encodeCallback(CALLBACK.URGENT_UNMARK, reference),
        });

        expect(await importanceOf(reference)).toBe('Normal/Received');
        expect(outcome.messages[0]?.chatId).toBe(SYSTEM);
        // D8, stated outright: they were told it had been prioritised, and they
        // are not told it has been un-prioritised.
        expect(outcome.messages.some((m) => m.chatId === TEACHER)).toBe(false);
      });

      it('tells the person whose decision was reversed', async () => {
        const reference = await confirmed();

        const outcome = await send({
          chatId: SYSTEM,
          kind: 'callback',
          text: encodeCallback(CALLBACK.URGENT_UNMARK, reference),
        });

        expect(outcome.messages.some((m) => m.chatId === SUPPORT_MEMBER)).toBe(true);
      });

      it('leaves a closed case alone and says why in plain words', async () => {
        // The retention guard, reached through the button rather than the store.
        const reference = await confirmed();
        await db.execute(
          sql`UPDATE cases SET status = 'Completed', closed_at = now() WHERE reference = ${reference}`,
        );

        const outcome = await send({
          chatId: SYSTEM,
          kind: 'callback',
          text: encodeCallback(CALLBACK.URGENT_UNMARK, reference),
        });

        const body = outcome.messages[0]?.text ?? '';
        expect(body).toMatch(/closed/i);
        expect(body).toMatch(/deleted/i);
        // No jargon: a person reading this has never heard of a retention period.
        expect(body).not.toMatch(/retention|importance/i);
        expect(await importanceOf(reference)).toBe('Urgent/Completed');
      });

      it('sits on the oversight message, which is where it is any use', async () => {
        const reference = await askForPriority();

        const outcome = await send({
          chatId: SUPPORT_MEMBER,
          kind: 'callback',
          text: encodeCallback(CALLBACK.URGENT_CONFIRM, reference),
        });

        const oversight = outcome.messages.find((m) => m.chatId === SYSTEM);
        const buttons = (oversight?.keyboard ?? []).flatMap((row) =>
          row.map((b) => b.callback_data),
        );
        expect(buttons).toContain(encodeCallback(CALLBACK.URGENT_UNMARK, reference));
      });
    });

    it('refuses a case nobody asked about', async () => {
      await teacherTaps(encodeCallback(CALLBACK.MENU, MENU_ACTION.CONTACT_SUPPORT));
      await teacherTaps(encodeCallback(CALLBACK.CASE_TOPIC, 'OTHER'));
      await teacherTypes('an ordinary question about my contract');
      const rows = await db.execute<{ reference: string }>(sql`SELECT reference FROM cases`);

      const outcome = await send({
        chatId: SUPPORT_MEMBER,
        kind: 'callback',
        text: encodeCallback(CALLBACK.URGENT_CONFIRM, rows.rows[0]!.reference),
      });

      expect(outcome.messages[0]?.text ?? '').toMatch(/nothing to confirm/i);
      expect(await importanceOf(rows.rows[0]!.reference)).toBe('Normal/Received');
    });

    it('refuses a reference that no longer exists', async () => {
      const outcome = await send({
        chatId: SUPPORT_MEMBER,
        kind: 'callback',
        text: encodeCallback(CALLBACK.URGENT_CONFIRM, 'SUPPORT-2026-99999'),
      });

      expect(outcome.messages[0]?.text ?? '').toMatch(/cannot find/i);
    });
  });

  describe('/retention', () => {
    const periodOf = async (key: string): Promise<string | null> => {
      const rows = await db.execute<{ value: string }>(
        sql`SELECT value FROM settings WHERE key = ${key}`,
      );
      return rows.rows[0]?.value ?? null;
    };

    it('reports all three and changes nothing', async () => {
      const body = await run('/retention');

      expect(body).toMatch(/retention periods/i);
      expect(body).toMatch(/resolved cases/i);
      expect(body).toMatch(/urgent or critical/i);
      expect(body).toMatch(/interaction log/i);

      const rows = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM settings`);
      expect(Number(rows.rows[0]?.n)).toBe(0);
    });

    it('says in so many words that an unset period deletes nothing', async () => {
      // D30's consequence. At launch, before the runbook's insert has been run,
      // the job runs nightly and deletes nothing — which is the safe direction
      // and looks exactly like a job that does not work. If the command shows a
      // blank there, the first System member to read it reports a fault.
      const body = await run('/retention');

      expect(body).toMatch(/not set/i);
      expect(body).toMatch(/is being deleted/i);
    });

    it('quotes the paragraph the privacy notice will actually show', async () => {
      // Not a second description of the periods written for staff. The point of
      // generating the notice is that there is one copy of this text, and a
      // command that paraphrased it would drift on the first wording change.
      await run('/retention case 7');
      const body = await run('/retention');

      expect(body).toContain(retentionParagraph({ caseDays: 7, urgentCaseDays: null, messageDays: null })[1]!);
    });

    it('sets one period and leaves the other two alone', async () => {
      const body = await run('/retention case 7');

      expect(body).toContain('7 days');
      expect(await periodOf('CASE_RETENTION_DAYS')).toBe('7');
      expect(await periodOf('URGENT_CASE_RETENTION_DAYS')).toBeNull();
      expect(await periodOf('MESSAGE_RETENTION_DAYS')).toBeNull();
    });

    it('refuses zero rather than reading it as “delete everything closed”', async () => {
      // The dangerous value, and one keystroke from 7. parsePeriod decides, so
      // the command and the job cannot disagree about what a bad value means.
      const body = await run('/retention case 0');

      expect(body).toMatch(/not a number of days/i);
      expect(body).toMatch(/zero is refused/i);
      expect(await periodOf('CASE_RETENTION_DAYS')).toBeNull();
    });

    it('refuses a word and restates the current value', async () => {
      await run('/retention case 7');
      const body = await run('/retention case abc');

      expect(body).toMatch(/not a number of days/i);
      expect(body).toContain('7 days');
      expect(await periodOf('CASE_RETENTION_DAYS')).toBe('7');
    });

    it('refuses a class it does not recognise rather than guessing', async () => {
      // `urgent` and `case` govern periods twenty-five times apart. A fuzzy match
      // that resolved a typo to the wrong one would delete six months of
      // emergency cases in a week.
      const body = await run('/retention urgnet 180');

      expect(body).toMatch(/do not understand/i);
      expect(await periodOf('URGENT_CASE_RETENTION_DAYS')).toBeNull();
    });

    it('warns that lengthening asks 1,800 teachers to read the notice again', async () => {
      // R20. The write still happens — it is a System member's decision — but
      // they should not learn its cost from the outbound message count.
      await run('/retention case 7');
      const body = await run('/retention case 30');

      expect(body).toMatch(/1,800/);
      expect(body).toMatch(/privacy notice again/i);
      expect(await periodOf('CASE_RETENTION_DAYS')).toBe('30');
    });

    it('does not warn when a period is shortened', async () => {
      // D28: deleting sooner than promised breaks no commitment to anybody.
      await run('/retention case 30');
      const body = await run('/retention case 7');

      expect(body).not.toMatch(/1,800/);
    });

    it('does not warn when a period is set for the first time', async () => {
      // Unset means kept indefinitely, which is the longest period there is — so
      // seeding all three at launch is a shortening and asks nobody anything.
      // The stage's one re-consent comes from the wording bump instead.
      expect(await run('/retention case 7')).not.toMatch(/1,800/);
      expect(await run('/retention urgent 180')).not.toMatch(/1,800/);
      expect(await run('/retention messages 3')).not.toMatch(/1,800/);
    });

    it('records who changed what, from what, to what', async () => {
      // D18. "Who shortened this to one day, and when" is the question.
      await run('/retention case 7');
      await run('/retention case 30');

      const rows = await db.execute<{
        actor: string;
        action: string;
        subject: string;
        detail: { from: number | null; to: number };
        // `at`, never `id`. The primary key is a random uuid, so ordering by it
        // is arbitrary — this assertion passed once by luck before it was
        // noticed. Each command is its own transaction, so `at` really does
        // separate them.
      }>(sql`SELECT actor, action, subject, detail FROM audit_log ORDER BY at`);

      expect(rows.rows).toEqual([
        {
          actor: SYSTEM,
          action: 'RETENTION_SET',
          subject: 'CASE_RETENTION_DAYS',
          detail: { from: null, to: 7 },
        },
        {
          actor: SYSTEM,
          action: 'RETENTION_SET',
          subject: 'CASE_RETENTION_DAYS',
          detail: { from: 7, to: 30 },
        },
      ]);
    });

    it('records nothing when the value is already what was typed', async () => {
      await run('/retention case 7');
      expect(await run('/retention case 7')).toMatch(/already kept/i);

      const rows = await db.execute<{ n: string }>(
        sql`SELECT count(*) AS n FROM audit_log WHERE action = 'RETENTION_SET'`,
      );
      expect(Number(rows.rows[0]?.n)).toBe(1);
    });

    it('takes effect immediately, because setSetting drops the cached value', async () => {
      // The same property /maintenance depends on. The confirmation a System
      // member reads has to be the value that was written, not a minute-old one.
      await run('/retention case 7');
      expect(await retentionPeriods(db)).toEqual({
        caseDays: 7,
        urgentCaseDays: null,
        messageDays: null,
      });
    });

    it('is not available below System', async () => {
      // A period governs a deletion with no undo.
      expect(await run('/retention case 7', SUPPORT_MEMBER)).toMatch(/rank/i);
      expect(await periodOf('CASE_RETENTION_DAYS')).toBeNull();
    });
  });

  /**
   * A block tested "the generated code itself" — its length, its alphabet, and
   * that it left out `0 O 1 I` because those are the characters people mishear
   * when a code is read aloud down a bad telephone line.
   *
   * All of it went on 1 August 2026 with the code generator. It is recorded
   * rather than deleted silently because the reasoning was good and would have
   * to be rebuilt from scratch if anything in this system ever needs a string a
   * person reads to another person over the telephone.
   */
});
