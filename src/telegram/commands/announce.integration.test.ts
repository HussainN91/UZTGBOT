/**
 * `/announce`, its three companions, and `/export` — Tasks 62 and 63.
 *
 * Two features that have never had both ends. `announcements` and
 * `announcement_recipients` were built in stage 2 and nothing has ever written a
 * row to either; `CAPABILITY.ANNOUNCE` and `CAPABILITY.EXPORT` have been in the
 * ladder since stage 4 with `/whoami` reporting "no command for this yet".
 *
 * The assertions that matter most here are the two that are about what does
 * *not* happen: an audience frozen at the draft cannot grow before it is sent,
 * and an export cannot carry a teacher's words however the column list changes.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { clearSettingsCache } from '../../config/settings.js';
import type { Database } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { withChatLock } from '../../conversation/lock.js';
import { route, type InboundUpdate, type RouterOutcome } from '../router.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const SUPPORT = '+998 71 000 0000';

const SYSTEM = '999001';
const PROGRAM = '999002';
const OTHER_PROGRAM = '999003';
const SUPPORT_MEMBER = '999004';
/**
 * Region-scoped, and **Program rather than Lead**, because `export` floors at
 * Program on the ladder Stage 4 built. The plan's sketch of this test said "a
 * Lead's export omits another region"; under the built ladder a Lead cannot
 * export at all, which is the stronger property and is asserted separately
 * below. What is worth proving here is that holding the capability does not
 * widen the scope — a region-scoped member exports their region and no other.
 */
const BUKHARA_PROGRAM = '999005';
const BUKHARA_LEAD = '999006';

const BUKHARA_TEACHER = '999101';
const TASHKENT_TEACHER = '999102';
const REVOKED_TEACHER = '999103';

describe.skipIf(!TEST_DATABASE_URL)('announcements and export', () => {
  let pool: pg.Pool;
  let db: Database;

  const send = (update: InboundUpdate): Promise<RouterOutcome> =>
    withChatLock(db, update.chatId, (tx) => route(tx, update, { supportContact: SUPPORT }));

  const run = async (text: string, chatId = PROGRAM): Promise<string> =>
    (await send({ chatId, kind: 'text', text })).messages[0]?.text ?? '';

  const outcomeOf = (text: string, chatId = PROGRAM): Promise<RouterOutcome> =>
    send({ chatId, kind: 'text', text });

  /** The uuid out of a draft confirmation, so the tests read as a person works. */
  const draftId = (body: string): string => {
    const match = /Draft ([0-9a-f-]{36})/.exec(body);
    if (match === null) throw new Error(`no draft id in: ${body}`);
    return match[1]!;
  };

  const statusOf = async (id: string): Promise<string> => {
    const rows = await db.execute<{ status: string }>(
      sql`SELECT status FROM announcements WHERE id = ${id}`,
    );
    return rows.rows[0]?.status ?? 'missing';
  };

  const recipientsOf = async (id: string): Promise<string[]> => {
    const rows = await db.execute<{ chat_id: string }>(
      sql`SELECT chat_id FROM announcement_recipients WHERE announcement_id = ${id} ORDER BY chat_id`,
    );
    return rows.rows.map((r) => r.chat_id);
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
    clearSettingsCache();

    await db.execute(sql`
      INSERT INTO staff (telegram_id, name, role, queue, regions, active) VALUES
        (${SYSTEM},         'System Admin',   'System',  'All', ARRAY[]::text[],          true),
        (${PROGRAM},        'Program Lead',   'Program', 'All', ARRAY[]::text[],          true),
        (${OTHER_PROGRAM},  'Other Program',  'Program', 'All', ARRAY[]::text[],          true),
        (${SUPPORT_MEMBER},  'Support Person',  'Support', 'All', ARRAY[]::text[],          true),
        (${BUKHARA_PROGRAM}, 'Bukhara Program', 'Program', 'All', ARRAY['Bukhara']::text[], true),
        (${BUKHARA_LEAD},    'Bukhara Lead',    'Lead',    'All', ARRAY['Bukhara']::text[], true)
    `);

    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active) VALUES
        ('bukhara@example.com',  'Bukhara Teacher',  'Bukhara',  true),
        ('tashkent@example.com', 'Tashkent Teacher', 'Tashkent', true),
        ('revoked@example.com',  'Revoked Teacher',  'Bukhara',  true)
    `);
    await db.execute(sql`
      INSERT INTO teachers (chat_id, identifier, name, region, verification_state, revoked_at) VALUES
        (${BUKHARA_TEACHER},  'bukhara@example.com',  'Bukhara Teacher',  'Bukhara',  'Verified', NULL),
        (${TASHKENT_TEACHER}, 'tashkent@example.com', 'Tashkent Teacher', 'Tashkent', 'Verified', NULL),
        (${REVOKED_TEACHER},  'revoked@example.com',  'Revoked Teacher',  'Bukhara',  'Revoked',  now())
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  // -------------------------------------------------------------------------
  // Task 62
  // -------------------------------------------------------------------------

  describe('/announce', () => {
    it('reports the exact count it froze, and sends nothing', async () => {
      const body = await run('/announce all Term starts on Monday.');

      expect(body).toContain('*2* teachers');
      expect(body).toContain('Nothing has been sent');
      expect(await statusOf(draftId(body))).toBe('Draft');
    });

    it('shows the message as the teacher will see it, not as it was typed', async () => {
      // Step 3. Somebody about to message 1,800 people should read what will
      // arrive, including the heading and the "this will not reach the sender"
      // line, because those are part of what they are approving.
      const body = await run('/announce all Term starts on Monday.');

      expect(body).toContain('A message from the Ministry');
      expect(body).toContain('Term starts on Monday.');
      expect(body).toContain('Contact Support');
    });

    it('freezes the audience, so a teacher who verifies afterwards is not added', async () => {
      // The flaw in the schema's own words: the old version counted once for the
      // preview and looked the audience up again when sending, so the number
      // approved was not the number that received it.
      const id = draftId(await run('/announce all Term starts on Monday.'));

      await db.execute(sql`
        INSERT INTO roster_entries (identifier, name, region, active)
        VALUES ('late@example.com', 'Late Teacher', 'Bukhara', true)
      `);
      await db.execute(sql`
        INSERT INTO teachers (chat_id, identifier, name, region, verification_state)
        VALUES ('999999', 'late@example.com', 'Late Teacher', 'Bukhara', 'Verified')
      `);

      expect(await recipientsOf(id)).toEqual([BUKHARA_TEACHER, TASHKENT_TEACHER]);
    });

    it('leaves out a teacher who cannot receive anything', async () => {
      const id = draftId(await run('/announce all Term starts on Monday.'));
      expect(await recipientsOf(id)).not.toContain(REVOKED_TEACHER);
    });

    it('addresses one region, resolving the spelling the roster uses', async () => {
      const body = await run('/announce region:bukhara The office is closed on Friday.');

      expect(body).toContain('*1* teacher');
      expect(body).toContain('Bukhara');
      expect(await recipientsOf(draftId(body))).toEqual([BUKHARA_TEACHER]);
    });

    it('refuses a region nobody is in, rather than freezing an empty audience', async () => {
      // An announcement addressed to a place the system has never heard of
      // reaches nobody and looks exactly like one that worked — the count would
      // be 0, and 0 read quickly is "done".
      const body = await run('/announce region:Nowhere Anything at all.');

      expect(body).toMatch(/do not know a region/i);
      expect(body).toContain('Bukhara');

      const rows = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM announcements`);
      expect(Number(rows.rows[0]?.n)).toBe(0);
    });

    it('refuses an audience it does not understand rather than guessing', async () => {
      const body = await run('/announce everyone Anything at all.');

      expect(body).toMatch(/do not understand/i);
      const rows = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM announcements`);
      expect(Number(rows.rows[0]?.n)).toBe(0);
    });

    it('refuses an audience with no message after it', async () => {
      expect(await run('/announce all')).toMatch(/no message in it/i);
    });

    it('refuses a message Telegram would not deliver, before 1,800 sends fail', async () => {
      // An over-long announcement fails for every recipient, one at a time, all
      // night. Caught here it costs a retype.
      const body = await run(`/announce all ${'x'.repeat(4200)}`);

      expect(body).toMatch(/too long/i);
      const rows = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM announcements`);
      expect(Number(rows.rows[0]?.n)).toBe(0);
    });

    it('writes the command word and the audience to the log, and never the message', async () => {
      // D16's prefix rule, which `interactions.ts` names this exact command in
      // its comment for. Asserted rather than assumed.
      await run('/announce all A private operational instruction.');

      const rows = await db.execute<{ detail: string }>(
        sql`SELECT detail FROM messages WHERE chat_id = ${PROGRAM}`,
      );
      expect(rows.rows[0]?.detail).toBe('/announce all');
      expect(rows.rows[0]?.detail).not.toContain('private operational');
    });

    it('is not available below Program', async () => {
      expect(await run('/announce all Anything.', SUPPORT_MEMBER)).toMatch(/rank/i);
    });
  });

  describe('/announce_send', () => {
    it('queues the draft and says how long it will take', async () => {
      const id = draftId(await run('/announce all Term starts on Monday.'));
      const body = await run(`/announce_send ${id}`);

      expect(body).toContain('2 teachers');
      expect(await statusOf(id)).toBe('Queued');
    });

    it('refuses somebody else’s draft, and says it is not a rank they are missing', async () => {
      // Not a permission question — every Program member holds `announce`. A
      // Program member confirming words they did not write, to every teacher,
      // under their own name, is the thing being prevented.
      const id = draftId(await run('/announce all Term starts on Monday.'));
      const body = await run(`/announce_send ${id}`, OTHER_PROGRAM);

      expect(body).toMatch(/somebody else/i);
      expect(body).toMatch(/not a rank you are missing/i);
      expect(await statusOf(id)).toBe('Draft');
    });

    it('refuses one that is already being sent', async () => {
      const id = draftId(await run('/announce all Term starts on Monday.'));
      await run(`/announce_send ${id}`);

      expect(await run(`/announce_send ${id}`)).toMatch(/already being sent/i);
    });

    it('refuses one that was cancelled, rather than restarting it', async () => {
      const id = draftId(await run('/announce all Term starts on Monday.'));
      await run(`/announce_cancel ${id}`);

      expect(await run(`/announce_send ${id}`)).toMatch(/was cancelled/i);
      expect(await statusOf(id)).toBe('Cancelled');
    });

    it('refuses an id that does not exist', async () => {
      expect(await run('/announce_send 00000000-0000-0000-0000-000000000000')).toMatch(
        /no announcement/i,
      );
    });
  });

  describe('/announce_cancel', () => {
    it('stops a draft that had gone nowhere', async () => {
      const id = draftId(await run('/announce all Term starts on Monday.'));
      const body = await run(`/announce_cancel ${id}`);

      expect(body).toMatch(/nothing had been sent/i);
      expect(await statusOf(id)).toBe('Cancelled');
    });

    it('admits how many already had it when sending had begun', async () => {
      // A cancel that claims to have stopped something already in somebody's
      // chat is worse than one that admits the number.
      const id = draftId(await run('/announce all Term starts on Monday.'));
      await run(`/announce_send ${id}`);
      await db.execute(sql`
        UPDATE announcement_recipients SET state = 'Sent', sent_at = now()
        WHERE announcement_id = ${id} AND chat_id = ${BUKHARA_TEACHER}
      `);

      const body = await run(`/announce_cancel ${id}`);

      expect(body).toMatch(/1 teacher already had it/i);
      expect(body).toMatch(/cannot be recalled/i);
    });

    it('marks the rest Skipped rather than deleting them', async () => {
      // The record of who was not messaged is worth as much as the record of who
      // was, and a deleted row answers neither question.
      const id = draftId(await run('/announce all Term starts on Monday.'));
      await run(`/announce_cancel ${id}`);

      const rows = await db.execute<{ state: string }>(
        sql`SELECT DISTINCT state FROM announcement_recipients WHERE announcement_id = ${id}`,
      );
      expect(rows.rows).toEqual([{ state: 'Skipped' }]);
    });

    it('may be run by a colleague, unlike sending', async () => {
      // Confirming is the irreversible direction; stopping is the recoverable
      // one. A bad announcement going out while the only person who can halt it
      // is asleep is the worse failure.
      const id = draftId(await run('/announce all Term starts on Monday.'));

      expect(await run(`/announce_cancel ${id}`, OTHER_PROGRAM)).toMatch(/stopped/i);
      expect(await statusOf(id)).toBe('Cancelled');
    });
  });

  describe('/announcements', () => {
    it('says so plainly when nothing has been announced', async () => {
      expect(await run('/announcements')).toMatch(/nothing has been announced/i);
    });

    it('lists what has been sent, and how far it got', async () => {
      const id = draftId(await run('/announce all Term starts on Monday.'));
      const body = await run('/announcements');

      expect(body).toContain(id);
      expect(body).toContain('Draft');
    });
  });

  // -------------------------------------------------------------------------
  // Task 63
  // -------------------------------------------------------------------------

  describe('/export', () => {
    const openCase = async (
      reference: string,
      chatId: string,
      category = 'Visa',
      detail = 'my visa has not arrived and I am worried',
    ): Promise<void> => {
      await db.execute(sql`
        INSERT INTO cases (reference, teacher_chat_id, category, status, detail, public_update)
        VALUES (${reference}, ${chatId}, ${category}, 'New', ${detail}, 'we are looking into it')
      `);
    };

    const fileFrom = (outcome: RouterOutcome): { filename: string; contents: string } => {
      const doc = outcome.messages[0]?.document;
      if (doc === undefined) throw new Error(`no document in: ${outcome.messages[0]?.text}`);
      return doc;
    };

    it('sends a file holding the cases the asker can see', async () => {
      await openCase('VISA-2026-00001', BUKHARA_TEACHER);
      await openCase('VISA-2026-00002', TASHKENT_TEACHER);

      const file = fileFrom(await outcomeOf('/export'));

      expect(file.contents).toContain('VISA-2026-00001');
      expect(file.contents).toContain('VISA-2026-00002');
    });

    it('omits another region from a region-scoped member’s export', async () => {
      // The largest question anybody asks of `visibleToStaff`. A hand-rolled
      // query in the command file is one missing predicate away from somebody
      // taking every region home in a file.
      await openCase('VISA-2026-00001', BUKHARA_TEACHER);
      await openCase('VISA-2026-00002', TASHKENT_TEACHER);

      const file = fileFrom(await outcomeOf('/export', BUKHARA_PROGRAM));

      expect(file.contents).toContain('VISA-2026-00001');
      expect(file.contents).not.toContain('VISA-2026-00002');
    });

    it('is refused to a Lead outright, which is stronger than scoping them', async () => {
      await openCase('VISA-2026-00001', BUKHARA_TEACHER);
      expect(await run('/export', BUKHARA_LEAD)).toMatch(/rank/i);
    });

    it('carries no teacher’s words and no teacher’s name', async () => {
      // D43, and the assertion that has to survive somebody being helpful with
      // the column list. `/case` shows these, checks permission first and leaves
      // a row saying who read them; a file has none of those properties.
      await openCase('VISA-2026-00001', BUKHARA_TEACHER);

      const file = fileFrom(await outcomeOf('/export'));

      expect(file.contents).not.toContain('my visa has not arrived');
      expect(file.contents).not.toContain('we are looking into it');
      expect(file.contents).not.toContain('Bukhara Teacher');
      expect(file.contents.split('\r\n')[0]).toBe(
        '﻿reference,category,status,importance,region,owner,created,updated,due,closed',
      );
    });

    it('names the file with the date and the scope, so a stale one looks stale', async () => {
      await openCase('VISA-2026-00001', BUKHARA_TEACHER);

      const file = fileFrom(await outcomeOf('/export open'));

      expect(file.filename).toMatch(/^cases-\d{2}-\w{3}-\d{4}-open\.csv$/);
    });

    it('sends a message rather than an empty file when nothing matches', async () => {
      const outcome = await outcomeOf('/export');

      expect(outcome.messages[0]?.document).toBeUndefined();
      expect(outcome.messages[0]?.text).toMatch(/nothing to export/i);
    });

    it('refuses a filter that is not a status, and names the statuses', async () => {
      await openCase('VISA-2026-00001', BUKHARA_TEACHER);
      const body = await run('/export nonsense');

      expect(body).toMatch(/do not understand/i);
      expect(body).toContain('Under review');
    });

    it('writes an audit row, because a file leaving is the one act with no other trace', async () => {
      await openCase('VISA-2026-00001', BUKHARA_TEACHER);
      await outcomeOf('/export');

      const rows = await db.execute<{
        actor: string;
        action: string;
        detail: { filter: string; rows: number };
      }>(sql`SELECT actor, action, detail FROM audit_log WHERE action = 'CASES_EXPORTED'`);

      expect(rows.rows).toEqual([
        { actor: PROGRAM, action: 'CASES_EXPORTED', detail: { filter: 'all', rows: 1, matched: 1 } },
      ]);
    });

    it('says in the message that the file is outside every control the system has', async () => {
      // R28. The permission governs the act of exporting; nothing governs the
      // file afterwards, so saying so is the only remaining control.
      await openCase('VISA-2026-00001', BUKHARA_TEACHER);
      const outcome = await outcomeOf('/export');

      expect(outcome.messages[0]?.text).toMatch(/nothing deletes/i);
      expect(outcome.messages[0]?.text).toMatch(/no teacher’s words/i);
    });

    it('is not available below Program', async () => {
      expect(await run('/export', SUPPORT_MEMBER)).toMatch(/rank/i);
    });
  });
});
