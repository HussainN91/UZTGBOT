/**
 * The five reading commands — Task 33.
 *
 * Driven through `route`, not through the handlers, because half of what these
 * tests are checking happens outside the handler: the dispatcher supplies the
 * scope, and the router logs the command before it runs. Both are properties of
 * the pipeline rather than of the command.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addNote } from '../../cases/notes.js';
import { CASE_CATEGORY, TELEGRAM_MESSAGE_MAX_CHARS } from '../../config/constants.js';
import { clearSettingsCache } from '../../config/settings.js';
import { withChatLock } from '../../conversation/lock.js';
import type { Database } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { route, type InboundUpdate, type RouterOutcome } from '../router.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const SUPPORT = '+998 71 000 0000';

/** Staff. Names say what each is for. */
const VISA_TASHKENT = '994001';
const ACCOM_EVERYWHERE = '994002';
const OBSERVER = '994003';
const SYSTEM = '994004';

/** Teachers. */
const TASHKENT_TEACHER = '994101';
const SAMARKAND_TEACHER = '994102';

const TASHKENT_ID = 'reader.tashkent@example.com';
const SAMARKAND_ID = 'reader.samarkand@example.com';

const VISA_DETAIL = 'the embassy has kept my passport for six weeks';
const ACCOM_DETAIL = 'the landlord changed the locks while I was at school';

describe.skipIf(!TEST_DATABASE_URL)('the case-reading commands', () => {
  let pool: pg.Pool;
  let db: Database;

  const send = (update: InboundUpdate): Promise<RouterOutcome> =>
    withChatLock(db, update.chatId, (tx) => route(tx, update, { supportContact: SUPPORT }));

  /** One command, as the staff member types it, returning what they are shown. */
  const run = async (text: string, chatId = VISA_TASHKENT): Promise<string> => {
    const outcome = await send({ chatId, kind: 'text', text });
    return outcome.messages[0]?.text ?? '';
  };

  const logFor = async (chatId: string): Promise<string[]> => {
    const rows = await db.execute<{ detail: string }>(
      sql`SELECT detail FROM messages WHERE chat_id = ${chatId}`,
    );
    return rows.rows.map((r) => r.detail);
  };

  /**
   * Insert a case directly: these are read tests, and filing is covered
   * elsewhere.
   *
   * `updatedDaysAgo` is a number rather than a SQL string, because a string is
   * bound as a *parameter* — `now() - interval '9 days'` arrives at PostgreSQL
   * as text to be parsed as a timestamp, not as an expression to evaluate. The
   * interval is built in SQL here, from a bound integer.
   */
  const givenCase = async (fields: {
    reference: string;
    teacher: string;
    category: string;
    status?: string;
    importance?: string;
    owner?: string | null;
    detail?: string;
    publicUpdate?: string;
    updatedDaysAgo?: number;
  }): Promise<void> => {
    const updatedAt =
      fields.updatedDaysAgo === undefined
        ? sql`now()`
        : sql`now() - make_interval(days => ${fields.updatedDaysAgo})`;

    await db.execute(sql`
      INSERT INTO cases (reference, category, teacher_chat_id, status, importance,
                         owner, detail, public_update, updated_at)
      VALUES (
        ${fields.reference}, ${fields.category}, ${fields.teacher},
        ${fields.status ?? 'New'}::case_status,
        ${fields.importance ?? 'Normal'}::case_importance,
        ${fields.owner ?? null},
        ${fields.detail ?? ''}, ${fields.publicUpdate ?? ''},
        ${updatedAt}
      )
    `);
  };

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
        (${VISA_TASHKENT},   'Visa Tashkent',  'Support',  'Visa',          ARRAY['Tashkent']::text[], true),
        (${ACCOM_EVERYWHERE},'Accom Anywhere', 'Support',  'Accommodation', ARRAY[]::text[],           true),
        (${OBSERVER},        'The Observer',   'Observer', 'All',           ARRAY[]::text[],           true),
        (${SYSTEM},          'System Person',  'System',   'None',          ARRAY['Nukus']::text[],    true)
    `);
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active) VALUES
        (${TASHKENT_ID},  'Tashkent Teacher',  'Tashkent',  true),
        (${SAMARKAND_ID}, 'Samarkand Teacher', 'Samarkand', true)
    `);
    await db.execute(sql`
      INSERT INTO teachers (chat_id, identifier, name, region, verification_state) VALUES
        (${TASHKENT_TEACHER},  ${TASHKENT_ID},  'Tashkent Teacher',  'Tashkent',  'Verified'),
        (${SAMARKAND_TEACHER}, ${SAMARKAND_ID}, 'Samarkand Teacher', 'Samarkand', 'Verified')
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('/cases', () => {
    it('shows what the caller may see, and nothing else', async () => {
      // The visibility rule, reached through the query rather than re-derived
      // here. Right queue wrong region, and right region wrong queue, both hide.
      await givenCase({ reference: 'VISA-2026-00001', teacher: TASHKENT_TEACHER, category: CASE_CATEGORY.VISA });
      await givenCase({ reference: 'VISA-2026-00002', teacher: SAMARKAND_TEACHER, category: CASE_CATEGORY.VISA });
      await givenCase({ reference: 'ACCOM-2026-00001', teacher: TASHKENT_TEACHER, category: CASE_CATEGORY.ACCOMMODATION });

      const body = await run('/cases');

      expect(body).toContain('VISA-2026-00001');
      expect(body).not.toContain('VISA-2026-00002');
      expect(body).not.toContain('ACCOM-2026-00001');
    });

    it('hides finished cases, which is what makes the list actionable', async () => {
      // handleListCases_ listed completed and closed cases too, which buried the
      // work under the finished work — and the finished work grows without limit.
      await givenCase({ reference: 'VISA-2026-00001', teacher: TASHKENT_TEACHER, category: CASE_CATEGORY.VISA });
      await givenCase({ reference: 'VISA-2026-00002', teacher: TASHKENT_TEACHER, category: CASE_CATEGORY.VISA, status: 'Completed' });

      const body = await run('/cases');

      expect(body).toContain('VISA-2026-00001');
      expect(body).not.toContain('VISA-2026-00002');
    });

    it('gives the intake backlog its standing view', async () => {
      // R4. The new-case alert catches "nobody can act on this" as it happens;
      // this is how somebody finds it afterwards.
      await givenCase({ reference: 'VISA-2026-00001', teacher: TASHKENT_TEACHER, category: CASE_CATEGORY.VISA, owner: VISA_TASHKENT });
      await givenCase({ reference: 'VISA-2026-00002', teacher: TASHKENT_TEACHER, category: CASE_CATEGORY.VISA });

      const body = await run('/cases unassigned');

      expect(body).toContain('VISA-2026-00002');
      expect(body).not.toContain('VISA-2026-00001');
    });

    it('accepts a status containing a space', async () => {
      // The entire reason ParsedCommand.rest is a phrase. AdminCommands.gs:501
      // split arguments on whitespace and compared the first word, which made
      // this filter silently unmatchable — it worked, returned nothing, and
      // looked exactly like an empty queue.
      await givenCase({ reference: 'VISA-2026-00001', teacher: TASHKENT_TEACHER, category: CASE_CATEGORY.VISA, status: 'Under review' });
      await givenCase({ reference: 'VISA-2026-00002', teacher: TASHKENT_TEACHER, category: CASE_CATEGORY.VISA });

      const body = await run('/cases Under review');

      expect(body).toContain('VISA-2026-00001');
      expect(body).not.toContain('VISA-2026-00002');
    });

    it('takes a status however it was capitalised', async () => {
      await givenCase({ reference: 'VISA-2026-00001', teacher: TASHKENT_TEACHER, category: CASE_CATEGORY.VISA, status: 'Under review' });

      expect(await run('/cases under REVIEW')).toContain('VISA-2026-00001');
    });

    it('refuses a status it does not know, and names the ones it does', async () => {
      // Never a silent empty list. A staff member who mistypes a status and is
      // shown "no cases" concludes something false about the queue.
      const body = await run('/cases Undr review');

      expect(body).toContain('Undr review');
      expect(body).toContain('Under review');
      expect(body).toContain('Duplicate');
    });

    it('says how much it is not showing', async () => {
      // handleListCases_ showed twenty and said nothing, which made a backlog of
      // two hundred look identical to a backlog of twenty.
      for (let i = 1; i <= 25; i += 1) {
        await givenCase({
          reference: `VISA-2026-${String(i).padStart(5, '0')}`,
          teacher: TASHKENT_TEACHER,
          category: CASE_CATEGORY.VISA,
        });
      }

      const body = await run('/cases');

      expect(body).toContain('showing 20 of 25');
    });

    it('says plainly when there is nothing, rather than showing an empty heading', async () => {
      expect(await run('/cases')).toMatch(/nothing is open/i);
    });
  });

  describe('/mycases', () => {
    it('shows only cases this person owns, and only open ones', async () => {
      await givenCase({ reference: 'VISA-2026-00001', teacher: TASHKENT_TEACHER, category: CASE_CATEGORY.VISA, owner: VISA_TASHKENT });
      await givenCase({ reference: 'VISA-2026-00002', teacher: TASHKENT_TEACHER, category: CASE_CATEGORY.VISA, owner: OBSERVER });
      await givenCase({ reference: 'VISA-2026-00003', teacher: TASHKENT_TEACHER, category: CASE_CATEGORY.VISA, owner: VISA_TASHKENT, status: 'Completed' });

      const body = await run('/mycases');

      expect(body).toContain('VISA-2026-00001');
      expect(body).not.toContain('VISA-2026-00002');
      expect(body).not.toContain('VISA-2026-00003');
    });

    it('points at the backlog when nothing is assigned', async () => {
      expect(await run('/mycases')).toContain('/cases unassigned');
    });
  });

  describe('/urgent', () => {
    it('lists escalated cases, which is what makes an emergency visible while it is open', async () => {
      await givenCase({ reference: 'VISA-2026-00001', teacher: TASHKENT_TEACHER, category: CASE_CATEGORY.VISA, status: 'Escalated' });
      await givenCase({ reference: 'VISA-2026-00002', teacher: TASHKENT_TEACHER, category: CASE_CATEGORY.VISA });

      const body = await run('/urgent');

      expect(body).toContain('VISA-2026-00001');
    });

    it('says the overdue half is switched off rather than showing it empty', async () => {
      // The difference between "nothing is overdue" and "nobody has said what
      // overdue means" is the same empty array and the opposite conclusion.
      // OVERDUE_DAYS has never been set in this database.
      const body = await run('/urgent');

      expect(body).toMatch(/not switched on/i);
      expect(body).toContain('OVERDUE_DAYS');
    });

    it('lists untouched cases once somebody has said what overdue means', async () => {
      await db.execute(sql`INSERT INTO settings (key, value) VALUES ('OVERDUE_DAYS', '3')`);
      clearSettingsCache();
      await givenCase({
        reference: 'VISA-2026-00001',
        teacher: TASHKENT_TEACHER,
        category: CASE_CATEGORY.VISA,
        updatedDaysAgo: 9,
      });

      const body = await run('/urgent');

      expect(body).toContain('VISA-2026-00001');
      expect(body).toContain('3 days');
      expect(body).not.toMatch(/not switched on/i);
    });

    it('keeps the two kinds of late apart', async () => {
      // A case can be escalated, stale, both or neither. One merged list would
      // answer neither question.
      await db.execute(sql`INSERT INTO settings (key, value) VALUES ('OVERDUE_DAYS', '3')`);
      clearSettingsCache();

      const body = await run('/urgent');

      expect(body).toContain('Escalated');
      expect(body).toMatch(/untouched/i);
    });
  });

  describe('/case', () => {
    it('shows the teacher’s own words, and the chat id the other commands take', async () => {
      await givenCase({
        reference: 'VISA-2026-00001',
        teacher: TASHKENT_TEACHER,
        category: CASE_CATEGORY.VISA,
        detail: VISA_DETAIL,
      });

      const body = await run('/case VISA-2026-00001');

      expect(body).toContain(VISA_DETAIL);
      expect(body).toContain(TASHKENT_TEACHER);
      expect(body).toContain('Tashkent Teacher');
    });

    it('accepts a reference typed in lower case', async () => {
      // A teacher reads it out over the telephone and a staff member types what
      // they heard.
      await givenCase({ reference: 'VISA-2026-00001', teacher: TASHKENT_TEACHER, category: CASE_CATEGORY.VISA });

      expect(await run('/case visa-2026-00001')).toContain('VISA-2026-00001');
    });

    it('answers “not yours” exactly as it answers “no such case”', async () => {
      // Telling somebody a reference exists but belongs to a queue they do not
      // hold confirms that a teacher filed something, which is the disclosure
      // the visibility rule exists to prevent.
      await givenCase({ reference: 'ACCOM-2026-00001', teacher: TASHKENT_TEACHER, category: CASE_CATEGORY.ACCOMMODATION });

      const hidden = await run('/case ACCOM-2026-00001');
      const absent = await run('/case VISA-2026-99999');

      expect(hidden.replace('ACCOM-2026-00001', 'X')).toBe(absent.replace('VISA-2026-99999', 'X'));
    });

    it('shows the promised date and the snooze whether or not they are set', async () => {
      // R15. Both columns are written from Task 45 and nothing chases them until
      // stage 5, so this display is the whole difference between two fields a
      // person can act on and two fields invisible until the stage after next.
      await givenCase({ reference: 'VISA-2026-00001', teacher: TASHKENT_TEACHER, category: CASE_CATEGORY.VISA });

      const body = await run('/case VISA-2026-00001');

      expect(body).toMatch(/promised by/i);
      expect(body).toMatch(/snoozed until/i);
    });

    it('shows the last few notes and says how many more there are', async () => {
      // D8. The count of the rest is what stops this reproducing the failure
      // where an internal thread grew inside `detail` until reading a case
      // exceeded what Telegram would deliver.
      await givenCase({ reference: 'VISA-2026-00001', teacher: TASHKENT_TEACHER, category: CASE_CATEGORY.VISA });
      for (let i = 1; i <= 8; i += 1) {
        await addNote(db, 'VISA-2026-00001', `note number ${i}`, VISA_TASHKENT);
      }

      const body = await run('/case VISA-2026-00001');

      expect(body).toContain('5 of 8');
      expect(body).toContain('note number 8');
      expect(body).not.toContain('note number 1');
    });

    it('never shows a note to a teacher, and says so where staff will read it', async () => {
      await givenCase({ reference: 'VISA-2026-00001', teacher: TASHKENT_TEACHER, category: CASE_CATEGORY.VISA });

      expect(await run('/case VISA-2026-00001')).toMatch(/no teacher ever sees them/i);
    });

    it('stays inside what Telegram will deliver, however long the case is', async () => {
      // The failure handleCaseDetail_ carried a comment about. `detail` has no
      // length limit and the urgent path appends to it; notes have none either.
      // Over 4096 characters Telegram returns a 400, `send` throws, and the
      // staff member gets nothing while an operator gets an alarm.
      await givenCase({
        reference: 'VISA-2026-00001',
        teacher: TASHKENT_TEACHER,
        category: CASE_CATEGORY.VISA,
        detail: 'x'.repeat(9000),
        publicUpdate: 'y'.repeat(3000),
      });
      for (let i = 1; i <= 6; i += 1) {
        await addNote(db, 'VISA-2026-00001', 'z'.repeat(2000), VISA_TASHKENT);
      }

      const body = await run('/case VISA-2026-00001');

      expect(body.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_CHARS);
      // Truncated, never silently: a staff member who cannot see the rest must
      // know there is a rest.
      expect(body).toMatch(/more characters/i);
    });

    it('asks for a reference rather than guessing', async () => {
      expect(await run('/case')).toMatch(/which case/i);
    });

    it('leaves a row saying who read which case', async () => {
      // BOT-SPEC §13. The router logs every command and D16 keeps the word and
      // the reference — so "who looked at this teacher's words" is answerable
      // without this command doing anything.
      await givenCase({ reference: 'VISA-2026-00001', teacher: TASHKENT_TEACHER, category: CASE_CATEGORY.VISA });

      await run('/case VISA-2026-00001');

      expect(await logFor(VISA_TASHKENT)).toContain('/case VISA-2026-00001');
    });
  });

  describe('/search', () => {
    it('finds a case by the teacher’s words and by its reference', async () => {
      await givenCase({
        reference: 'VISA-2026-00001',
        teacher: TASHKENT_TEACHER,
        category: CASE_CATEGORY.VISA,
        detail: VISA_DETAIL,
      });

      expect(await run('/search embassy')).toContain('VISA-2026-00001');
      expect(await run('/search VISA-2026')).toContain('VISA-2026-00001');
    });

    it('searches finished cases too', async () => {
      // Somebody searching is usually looking for something already dealt with.
      await givenCase({
        reference: 'VISA-2026-00001',
        teacher: TASHKENT_TEACHER,
        category: CASE_CATEGORY.VISA,
        detail: VISA_DETAIL,
        status: 'Completed',
      });

      expect(await run('/search embassy')).toContain('VISA-2026-00001');
    });

    it('never returns a case the caller may not see', async () => {
      await givenCase({
        reference: 'ACCOM-2026-00001',
        teacher: TASHKENT_TEACHER,
        category: CASE_CATEGORY.ACCOMMODATION,
        detail: ACCOM_DETAIL,
      });

      expect(await run('/search locks')).not.toContain('ACCOM-2026-00001');
      expect(await run('/search locks', ACCOM_EVERYWHERE)).toContain('ACCOM-2026-00001');
    });

    it('never prints the words it matched on', async () => {
      // Twenty matches would be twenty teachers' accounts of their problems in
      // one message. The way to read one is /case, which leaves a row saying so.
      await givenCase({
        reference: 'VISA-2026-00001',
        teacher: TASHKENT_TEACHER,
        category: CASE_CATEGORY.VISA,
        detail: VISA_DETAIL,
      });

      expect(await run('/search embassy')).not.toContain(VISA_DETAIL);
    });

    it('does not treat a percent sign as a wildcard', async () => {
      await givenCase({ reference: 'VISA-2026-00001', teacher: TASHKENT_TEACHER, category: CASE_CATEGORY.VISA, detail: VISA_DETAIL });

      expect(await run('/search %')).toMatch(/nothing matched/i);
    });

    it('refuses an empty term rather than dumping the backlog', async () => {
      expect(await run('/search')).toMatch(/what am I looking for/i);
    });

    it('writes only the command and its first word to the log', async () => {
      // R1 meeting D16. /search carries staff free text, and without the prefix
      // rule the whole search term — which can be a teacher's name — would land
      // in `messages` verbatim.
      await run('/search embassy appointment in Tashkent for Nodira');

      const rows = await logFor(VISA_TASHKENT);
      expect(rows).toContain('/search embassy');
      expect(rows.some((r) => r.includes('Nodira'))).toBe(false);
    });

    it('masks an address typed as a search term', async () => {
      await run('/search nodira@school.uz');

      const rows = await logFor(VISA_TASHKENT);
      expect(rows.some((r) => r.includes('nodira@school.uz'))).toBe(false);
      expect(rows.some((r) => r.includes('n***@school.uz'))).toBe(true);
    });
  });

  describe('who may read', () => {
    it('lets an Observer read every command in this file', async () => {
      // The whole point of the rank: sight without the power to alter.
      await givenCase({ reference: 'VISA-2026-00001', teacher: TASHKENT_TEACHER, category: CASE_CATEGORY.VISA, detail: VISA_DETAIL });

      expect(await run('/cases', OBSERVER)).toContain('VISA-2026-00001');
      expect(await run('/case VISA-2026-00001', OBSERVER)).toContain(VISA_DETAIL);
      expect(await run('/search embassy', OBSERVER)).toContain('VISA-2026-00001');
      expect(await run('/mycases', OBSERVER)).toMatch(/nothing is assigned/i);
      expect(await run('/urgent', OBSERVER)).toContain('Escalated');
    });

    it('lets a System member see past their own queue and region', async () => {
      // A System member with a queue of None and one unrelated region still
      // sees everything (AdminCommands.gs:290-294).
      await givenCase({ reference: 'ACCOM-2026-00001', teacher: SAMARKAND_TEACHER, category: CASE_CATEGORY.ACCOMMODATION });

      expect(await run('/cases', SYSTEM)).toContain('ACCOM-2026-00001');
    });

    it('tells a stranger nothing, and does not consume their message', async () => {
      // D9 still holds for every command added since. A stranger typing /cases
      // gets the ordinary reply to any other text.
      const outcome = await send({ chatId: '994999', kind: 'text', text: '/cases' });

      expect(outcome.messages[0]?.text ?? '').not.toMatch(/queue|case|permission/i);
      expect(await logFor('994999')).toContain('/cases');
    });
  });
});
