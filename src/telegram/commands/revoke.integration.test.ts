/**
 * A teacher's access, ended and returned — Task 36, over D17's command half and D27.
 *
 * The interesting half of this file is `/restore`, and specifically R16: there
 * are **two** ways a teacher loses the bot and only one of them is `Revoked`.
 * A command that reports success while the teacher stays locked out is worse
 * than having no command, because the staff member stops looking.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CASE_CATEGORY } from '../../config/constants.js';
import { createCase } from '../../cases/service.js';
import type { Database } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { withChatLock } from '../../conversation/lock.js';
import { findTeacher, teacherHasAccess } from '../../teachers/repository.js';
import { route, type InboundUpdate, type RouterOutcome } from '../router.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const SUPPORT = '+998 71 000 0000';

const PROGRAM = '997001';
const LEAD = '997002';
const SYSTEM = '997003';

const TEACHER = '997101';
const OTHER_TEACHER = '997102';
const NEWCOMER = '997103';

const IDENTIFIER = 'revoke.tester@example.com';
const OTHER_ID = 'revoke.other@example.com';

describe.skipIf(!TEST_DATABASE_URL)('/revoke and /restore', () => {
  let pool: pg.Pool;
  let db: Database;

  const send = (update: InboundUpdate): Promise<RouterOutcome> =>
    withChatLock(db, update.chatId, (tx) => route(tx, update, { supportContact: SUPPORT }));

  const run = async (text: string, chatId = PROGRAM): Promise<string> =>
    (await send({ chatId, kind: 'text', text })).messages[0]?.text ?? '';

  const teacherTypes = (text: string, chatId = TEACHER): Promise<RouterOutcome> =>
    send({ chatId, kind: 'text', text });

  const canUseBot = async (chatId: string): Promise<boolean> =>
    teacherHasAccess(await findTeacher(db, chatId));

  const auditRowsFor = async (subject: string): Promise<{ action: string; actor: string }[]> => {
    const rows = await db.execute<{ action: string; actor: string }>(
      sql`SELECT action, actor FROM audit_log WHERE subject = ${subject} ORDER BY at`,
    );
    return rows.rows;
  };

  const deactivateRosterRow = (identifier: string): Promise<unknown> =>
    db.execute(sql`UPDATE roster_entries SET active = false WHERE identifier = ${identifier}`);

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
      INSERT INTO staff (telegram_id, name, role, queue, regions, active) VALUES
        (${PROGRAM}, 'Programme Manager', 'Program', 'All', ARRAY[]::text[], true),
        (${LEAD},    'Regional Lead',     'Lead',    'All', ARRAY[]::text[], true),
        (${SYSTEM},  'System Admin',      'System',  'All', ARRAY[]::text[], true)
    `);
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active) VALUES
        (${IDENTIFIER}, 'Revoke Tester', 'Tashkent', true),
        (${OTHER_ID},   'Other Teacher', 'Tashkent', true)
    `);
    await db.execute(sql`
      INSERT INTO teachers (chat_id, identifier, name, region, verification_state) VALUES
        (${TEACHER},       ${IDENTIFIER}, 'Revoke Tester', 'Tashkent', 'Verified'),
        (${OTHER_TEACHER}, ${OTHER_ID},   'Other Teacher', 'Tashkent', 'Verified'),
        (${NEWCOMER},      NULL,          NULL,            NULL,       'Unverified')
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('/revoke', () => {
    it('ends a verified teacher’s access', async () => {
      await run(`/revoke ${TEACHER}`);

      expect(await canUseBot(TEACHER)).toBe(false);
    });

    it('records who did it, in the columns and in the audit log', async () => {
      await run(`/revoke ${TEACHER}`);

      const rows = await db.execute(
        sql`SELECT verification_state, revoked_by FROM teachers WHERE chat_id = ${TEACHER}`,
      );
      expect(String(rows.rows[0]?.['verification_state'])).toBe('Revoked');
      expect(String(rows.rows[0]?.['revoked_by'])).toBe(PROGRAM);
      expect(await auditRowsFor(TEACHER)).toEqual([{ action: 'TEACHER_REVOKED', actor: PROGRAM }]);
    });

    it('reports the teacher’s open cases, because a reply to them will not be readable', async () => {
      // R5. Revoking somebody with open cases strands a staff member replying to
      // a teacher who cannot open the bot to read it.
      await createCase(db, { chatId: TEACHER, category: CASE_CATEGORY.VISA, detail: 'visa refused' });

      const body = await run(`/revoke ${TEACHER}`);

      expect(body).toMatch(/1 open case/i);
      expect(body).toContain('VISA-');
    });

    it('says so, and records nothing, when they are already revoked', async () => {
      await run(`/revoke ${TEACHER}`);
      const body = await run(`/revoke ${TEACHER}`);

      expect(body).toMatch(/already revoked/i);
      expect(await auditRowsFor(TEACHER)).toHaveLength(1);
    });

    it('refuses a chat that has never signed in', async () => {
      // Otherwise `/revoke` writes Revoked onto a chat with no roster identity,
      // and `/restore` would then be able to write Verified onto it — a command
      // pair that between them grants access rather than returning it.
      const body = await run(`/revoke ${NEWCOMER}`);

      expect(body).toMatch(/never signed in/i);
      const rows = await db.execute(
        sql`SELECT verification_state FROM teachers WHERE chat_id = ${NEWCOMER}`,
      );
      expect(String(rows.rows[0]?.['verification_state'])).toBe('Unverified');
    });

    it('says plainly when there is no such teacher', async () => {
      expect(await run('/revoke 404404')).toMatch(/no teacher with chat id/i);
    });

    it('is not available at Lead rank', async () => {
      const body = await run(`/revoke ${TEACHER}`, LEAD);

      expect(body).toMatch(/rank/i);
      expect(await canUseBot(TEACHER)).toBe(true);
    });

    it('leaves other teachers alone', async () => {
      await run(`/revoke ${TEACHER}`);

      expect(await canUseBot(OTHER_TEACHER)).toBe(true);
    });
  });

  describe('/restore', () => {
    it('gives a wrongly revoked teacher their access back', async () => {
      // D27. Before this the only route was a database session over the SSH
      // tunnel, for what is an ordinary mistake.
      await run(`/revoke ${TEACHER}`);
      expect(await canUseBot(TEACHER)).toBe(false);

      await run(`/restore ${TEACHER}`);
      expect(await canUseBot(TEACHER)).toBe(true);
    });

    it('does not let a restore be faked by signing in again', async () => {
      // The reason /restore has to exist at all. `bindTeacher` clears revoked_at,
      // so letting a revoked teacher back into sign-in would let them undo their
      // own revocation. That refusal is load-bearing and this test is what keeps
      // it.
      await run(`/revoke ${TEACHER}`);

      await teacherTypes('/start');
      await teacherTypes(IDENTIFIER);

      expect(await canUseBot(TEACHER)).toBe(false);
    });

    it('tells a revoked teacher why, rather than asking them to sign in again', async () => {
      // The sign-in prompt would send them round a loop, and would say nothing
      // about why they are stuck.
      await run(`/revoke ${TEACHER}`);

      const outcome = await teacherTypes('/start');
      expect(outcome.messages[0]?.text ?? '').toMatch(/access.*has ended/i);
    });

    it('says so, and changes nothing, when the teacher was never revoked', async () => {
      // R16, second order. An audit trail with entries for events that did not
      // happen is worse than a short one.
      const body = await run(`/restore ${TEACHER}`);

      expect(body).toMatch(/not revoked/i);
      expect(await auditRowsFor(TEACHER)).toHaveLength(0);
    });

    it('warns when the roster is the reason they are locked out, not the revocation', async () => {
      // R16, and the failure this command must not have. A teacher whose roster
      // row was deactivated is still Verified and still fails teacherHasAccess,
      // because the gate re-checks the roster live (D17). /restore cannot help
      // them — recruitment has to put the row back — and reporting success while
      // they stay locked out is worse than having no command.
      await deactivateRosterRow(IDENTIFIER);
      await run(`/revoke ${TEACHER}`);

      const body = await run(`/restore ${TEACHER}`);

      expect(body).toMatch(/roster/i);
      expect(body).toMatch(/still cannot use the bot/i);
      expect(await canUseBot(TEACHER)).toBe(false);
    });

    it('names the roster as the problem for a teacher who was never revoked either', async () => {
      // The same two-reasons trap, reached from the other branch: nothing to
      // restore, and still locked out. Saying only "not revoked" would leave the
      // staff member with no idea what to do next.
      await deactivateRosterRow(IDENTIFIER);

      const body = await run(`/restore ${TEACHER}`);

      expect(body).toMatch(/not revoked/i);
      expect(body).toMatch(/roster/i);
    });

    it('writes exactly one audit row when it actually restores somebody', async () => {
      await run(`/revoke ${TEACHER}`);
      await run(`/restore ${TEACHER}`);

      expect(await auditRowsFor(TEACHER)).toEqual([
        { action: 'TEACHER_REVOKED', actor: PROGRAM },
        { action: 'TEACHER_RESTORED', actor: PROGRAM },
      ]);
    });

    it('touches nothing but the revocation', async () => {
      // Restoring somebody undoes one act; it does not re-run their sign-in.
      await db.execute(
        sql`UPDATE teachers SET region_override = 'Samarkand', privacy_notice_version = 'v-test' WHERE chat_id = ${TEACHER}`,
      );
      await run(`/revoke ${TEACHER}`);
      await run(`/restore ${TEACHER}`);

      const rows = await db.execute(
        sql`SELECT identifier, region_override, privacy_notice_version, revoked_at, revoked_by
            FROM teachers WHERE chat_id = ${TEACHER}`,
      );
      expect(rows.rows[0]?.['identifier']).toBe(IDENTIFIER);
      expect(rows.rows[0]?.['region_override']).toBe('Samarkand');
      expect(rows.rows[0]?.['privacy_notice_version']).toBe('v-test');
      expect(rows.rows[0]?.['revoked_at']).toBeNull();
      expect(rows.rows[0]?.['revoked_by']).toBeNull();
    });

    it('reports the teacher’s open cases, because they become answerable again', async () => {
      // R5 from the other side: restoring is the moment those cases can be
      // finished, and the person doing it should know there are some.
      await createCase(db, { chatId: TEACHER, category: CASE_CATEGORY.VISA, detail: 'visa refused' });
      await run(`/revoke ${TEACHER}`);

      const body = await run(`/restore ${TEACHER}`);

      expect(body).toMatch(/1 open case/i);
    });

    it('says plainly when there is no such teacher', async () => {
      expect(await run('/restore 404404')).toMatch(/no teacher with chat id/i);
    });

    it('is not available at Lead rank', async () => {
      await run(`/revoke ${TEACHER}`);

      expect(await run(`/restore ${TEACHER}`, LEAD)).toMatch(/rank/i);
      expect(await canUseBot(TEACHER)).toBe(false);
    });
  });

  /**
   * `/forget` — Task 64.
   *
   * Here rather than in its own file because it is the third command about a
   * teacher's access, and the thing worth reading is how it differs from the two
   * above it: `/revoke` is undone by `/restore`, and this is undone by nothing.
   */
  describe('/forget', () => {
    const nameOf = async (chatId: string): Promise<string | null> => {
      const rows = await db.execute<{ name: string | null }>(
        sql`SELECT name FROM teachers WHERE chat_id = ${chatId}`,
      );
      return rows.rows[0]?.name ?? null;
    };

    it('explains and changes nothing without the confirmation word', async () => {
      const body = await run(`/forget ${TEACHER}`, SYSTEM);

      expect(body).toMatch(/nothing has changed/i);
      expect(body).toMatch(/no undo/i);
      expect(await nameOf(TEACHER)).toBe('Revoke Tester');
    });

    it('states what it cannot remove, before it is run and after', async () => {
      // D44. Whoever types this is the person who then tells a teacher their
      // data has been removed, and they must be able to say what that means.
      for (const body of [
        await run(`/forget ${TEACHER}`, SYSTEM),
        await run(`/forget ${TEACHER} FORGET`, SYSTEM),
      ]) {
        expect(body).toMatch(/chat id/i);
        expect(body).toMatch(/retention/i);
      }
    });

    it('anonymises the person and keeps the case history', async () => {
      // Design decision 8: the problem they reported is the record that stays;
      // the person is what goes.
      await createCase(db, { chatId: TEACHER, category: CASE_CATEGORY.VISA, detail: 'visa refused' });

      const body = await run(`/forget ${TEACHER} FORGET`, SYSTEM);

      expect(body).toMatch(/has been removed/i);
      expect(await nameOf(TEACHER)).toBeNull();
      expect(await canUseBot(TEACHER)).toBe(false);

      const cases = await db.execute<{ n: string }>(
        sql`SELECT count(*) AS n FROM cases WHERE teacher_chat_id = ${TEACHER}`,
      );
      expect(Number(cases.rows[0]?.n)).toBe(1);
    });

    it('deletes their own messages, which are not case history', async () => {
      await teacherTypes('a question I typed into the bot');
      const body = await run(`/forget ${TEACHER} FORGET`, SYSTEM);

      expect(body).toMatch(/log entr/i);

      const rows = await db.execute<{ n: string }>(
        sql`SELECT count(*) AS n FROM messages WHERE chat_id = ${TEACHER}`,
      );
      expect(Number(rows.rows[0]?.n)).toBe(0);
    });

    it('reports the open cases, as /revoke does', async () => {
      // R5 and R32. Those cases stay open and stay visible, with no name on
      // them, and somebody has to finish them.
      await createCase(db, { chatId: TEACHER, category: CASE_CATEGORY.VISA, detail: 'visa refused' });

      expect(await run(`/forget ${TEACHER} FORGET`, SYSTEM)).toMatch(/1 open case/i);
    });

    it('records who did it, in the table that is never pruned', async () => {
      await run(`/forget ${TEACHER} FORGET`, SYSTEM);

      expect(await auditRowsFor(TEACHER)).toContainEqual({
        action: 'TEACHER_FORGOTTEN',
        actor: SYSTEM,
      });
    });

    it('tells "already removed" apart from "no such teacher"', async () => {
      // Departure 3 of this stage. Reporting the latter for somebody removed
      // last month sends an operator looking for a row behaving correctly.
      await run(`/forget ${TEACHER} FORGET`, SYSTEM);

      const again = await run(`/forget ${TEACHER} FORGET`, SYSTEM);
      expect(again).toMatch(/already removed/i);
      expect(again).not.toMatch(/no teacher with chat id/i);

      expect(await run('/forget 404404 FORGET', SYSTEM)).toMatch(/no teacher with chat id/i);
    });

    it('records nothing the second time', async () => {
      await run(`/forget ${TEACHER} FORGET`, SYSTEM);
      await run(`/forget ${TEACHER} FORGET`, SYSTEM);

      const rows = await db.execute<{ n: string }>(
        sql`SELECT count(*) AS n FROM audit_log WHERE action = 'TEACHER_FORGOTTEN'`,
      );
      expect(Number(rows.rows[0]?.n)).toBe(1);
    });

    it('is refused to a Program member, naming System', async () => {
      // The cost D44 accepted, stated as a test: a Support member who takes the
      // request cannot action it, and neither can the rank that can revoke.
      const body = await run(`/forget ${TEACHER} FORGET`, PROGRAM);

      expect(body).toMatch(/rank/i);
      expect(body).toMatch(/System/);
      expect(await nameOf(TEACHER)).toBe('Revoke Tester');
    });
  });
});
