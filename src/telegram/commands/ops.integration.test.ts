/**
 * `/maintenance` and `/generate_urgent_code` — Task 37.
 *
 * The second of these drives both halves of a feature whose two ends have never
 * met. Urgent codes have only ever been inserted by hand through the runbook, so
 * nothing has ever proved that the format a person would issue is the format the
 * teacher flow accepts. That test runs the command and then the teacher path,
 * end to end, which is the only way to find out.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { URGENT_CODE_ALPHABET, URGENT_CODE_LENGTH } from '../../config/constants.js';
import { generateUrgentCode } from '../../cases/urgent.js';
import { clearSettingsCache, isMaintenanceMode } from '../../config/settings.js';
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

  const teacherTaps = async (data: string): Promise<string> =>
    (await send({ chatId: TEACHER, kind: 'callback', text: data })).messages[0]?.text ?? '';

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
      // there would throw away what they typed and an urgent code they had
      // spent. Without this sentence the first System member to use it reports
      // the trickle of cases as a bug.
      const body = await run('/maintenance on');

      expect(body).toMatch(/keep arriving/i);
      expect(body).toMatch(/urgent code/i);
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

  describe('/generate_urgent_code', () => {
    const codeFrom = (body: string): string => {
      const match = /Urgent code: ([A-Z0-9]+)/.exec(body);
      if (match === null) throw new Error(`no code in: ${body}`);
      return match[1]!;
    };

    it('issues a code that the teacher flow will accept', async () => {
      // The two halves have never met: codes have only ever been inserted by
      // hand (RUNBOOK 4.4). This drives the issuing command and then the teacher
      // path, end to end, which is the only way to prove the formats agree.
      const code = codeFrom(await run('/generate_urgent_code', SUPPORT_MEMBER));

      await teacherTaps(encodeCallback(CALLBACK.MENU, MENU_ACTION.URGENT_CASE));
      expect(await teacherTypes(code)).toContain('Code accepted');

      const filed = await teacherTypes('the dormitory is locked and we are outside');
      expect(filed).toContain('marked urgent');

      const rows = await db.execute<{ status: string }>(sql`SELECT status FROM cases`);
      expect(rows.rows[0]?.status).toBe('Escalated');
    });

    it('is accepted after being typed back in lower case', async () => {
      // The code is read aloud down a telephone and typed on a phone keyboard
      // that capitalises for you. `normaliseUrgentCode` upper-cases what arrives,
      // and this is what keeps the generated alphabet on the right side of that.
      const code = codeFrom(await run('/generate_urgent_code', SUPPORT_MEMBER));

      await teacherTaps(encodeCallback(CALLBACK.MENU, MENU_ACTION.URGENT_CASE));
      expect(await teacherTypes(code.toLowerCase())).toContain('Code accepted');
    });

    it('records who issued it', async () => {
      // urgent_codes.issued_by is notNull and has held '0' for every hand-issued
      // code. The stranded-code alarm names the issuer; '0' names nobody.
      const code = codeFrom(await run('/generate_urgent_code', SUPPORT_MEMBER));

      const rows = await db.execute<{ issued_by: string }>(
        sql`SELECT issued_by FROM urgent_codes WHERE code = ${code}`,
      );
      expect(rows.rows[0]?.issued_by).toBe(SUPPORT_MEMBER);

      const audit = await db.execute<{ actor: string; action: string; subject: string }>(
        sql`SELECT actor, action, subject FROM audit_log`,
      );
      expect(audit.rows).toEqual([
        { actor: SUPPORT_MEMBER, action: 'URGENT_CODE_ISSUED', subject: code },
      ]);
    });

    it('shows an expiry a person can read, in Tashkent time', async () => {
      const body = await run('/generate_urgent_code', SUPPORT_MEMBER);

      // The failure this guards is a `timestamptz` read through db.execute
      // arriving as a string rather than a Date, which formats as "Invalid Date"
      // — or throws inside a command, which bot.catch turns into silence.
      expect(body).not.toMatch(/invalid date/i);
      expect(body).toMatch(/\d{2} \w{3} \d{4}/);
    });

    it('issues a different code every time', async () => {
      const first = codeFrom(await run('/generate_urgent_code', SUPPORT_MEMBER));
      const second = codeFrom(await run('/generate_urgent_code', SUPPORT_MEMBER));

      expect(first).not.toBe(second);
    });

    it('is not available to an Observer', async () => {
      expect(await run('/generate_urgent_code', OBSERVER)).toMatch(/rank/i);

      const rows = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM urgent_codes`);
      expect(Number(rows.rows[0]?.n)).toBe(0);
    });
  });

  describe('the generated code itself', () => {
    it('is the agreed length and drawn only from the agreed alphabet', () => {
      for (let i = 0; i < 200; i += 1) {
        const code = generateUrgentCode();
        expect(code).toHaveLength(URGENT_CODE_LENGTH);
        expect([...code].every((ch) => URGENT_CODE_ALPHABET.includes(ch))).toBe(true);
      }
    });

    it('leaves out the characters people mishear down a telephone', () => {
      // 0/O and 1/I. The code's whole job is to survive being read aloud and
      // typed by somebody under stress; those two pairs are where that fails,
      // and it fails as a rejected code with no explanation.
      expect(URGENT_CODE_ALPHABET).not.toMatch(/[01OI]/);
    });
  });
});
