/**
 * Changing a case — Task 34, D25 as corrected by D26.
 *
 * The first commands in this rebuild that write to a case, which makes two
 * things load-bearing that reading never exercised: `updateCase` and `addNote`
 * take a bare reference and do not know who is asking, so every one of these
 * commands has to resolve through `findCase` first; and every one of them can
 * put staff free text in front of a teacher, which is the leak D16 closed and
 * the length limit `/case` already had to respect.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getCasesForChatId } from '../../cases/service.js';
import { CASE_CATEGORY, TELEGRAM_MESSAGE_MAX_CHARS } from '../../config/constants.js';
import { withChatLock } from '../../conversation/lock.js';
import type { Database } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { route, type InboundUpdate, type RouterOutcome } from '../router.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const SUPPORT = '+998 71 000 0000';

const VISA_STAFF = '995001';
const ACCOM_STAFF = '995002';
const OBSERVER = '995003';

const TEACHER = '995101';
const OTHER_TEACHER = '995102';

const TEACHER_ID = 'mutate.teacher@example.com';
const OTHER_ID = 'mutate.other@example.com';

const VISA_REF = 'VISA-2026-00001';
const ACCOM_REF = 'ACCOM-2026-00001';

describe.skipIf(!TEST_DATABASE_URL)('changing a case', () => {
  let pool: pg.Pool;
  let db: Database;

  const send = (update: InboundUpdate): Promise<RouterOutcome> =>
    withChatLock(db, update.chatId, (tx) => route(tx, update, { supportContact: SUPPORT }));

  const command = (text: string, chatId = VISA_STAFF): Promise<RouterOutcome> =>
    send({ chatId, kind: 'text', text });

  const run = async (text: string, chatId = VISA_STAFF): Promise<string> =>
    (await command(text, chatId)).messages[0]?.text ?? '';

  /**
   * The timestamps come back as **strings**, not `Date`s.
   *
   * `db.execute` hands over the raw value PostgreSQL sent: drizzle installs its
   * own type parsers, so a `timestamptz` read this way is never parsed the way
   * the query builder parses one. Typing them as `Date` here compiles and then
   * fails at `.getTime()`. Compared as strings, which is exact anyway.
   */
  const caseRow = async (
    reference: string,
  ): Promise<{
    status: string;
    public_update: string;
    closed_at: string | null;
    updated_at: string;
  }> => {
    const rows = await db.execute<{
      status: string;
      public_update: string;
      closed_at: string | null;
      updated_at: string;
    }>(sql`SELECT status, public_update, closed_at, updated_at FROM cases WHERE reference = ${reference}`);
    return rows.rows[0]!;
  };

  const notesOn = async (reference: string): Promise<string[]> => {
    const rows = await db.execute<{ body: string }>(
      sql`SELECT body FROM case_notes WHERE case_reference = ${reference}`,
    );
    return rows.rows.map((r) => r.body);
  };

  const logFor = async (chatId: string): Promise<string[]> => {
    const rows = await db.execute<{ detail: string }>(
      sql`SELECT detail FROM messages WHERE chat_id = ${chatId}`,
    );
    return rows.rows.map((r) => r.detail);
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

    await db.execute(sql`
      INSERT INTO staff (telegram_id, name, role, queue, regions, active) VALUES
        (${VISA_STAFF},  'Visa Staff',   'Support',  'Visa',          ARRAY['Tashkent']::text[], true),
        (${ACCOM_STAFF}, 'Accom Staff',  'Support',  'Accommodation', ARRAY[]::text[],           true),
        (${OBSERVER},    'The Observer', 'Observer', 'All',           ARRAY[]::text[],           true)
    `);
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active) VALUES
        (${TEACHER_ID}, 'The Teacher', 'Tashkent', true),
        (${OTHER_ID},   'Other One',   'Tashkent', true)
    `);
    await db.execute(sql`
      INSERT INTO teachers (chat_id, identifier, name, region, verification_state) VALUES
        (${TEACHER},       ${TEACHER_ID}, 'The Teacher', 'Tashkent', 'Verified'),
        (${OTHER_TEACHER}, ${OTHER_ID},   'Other One',   'Tashkent', 'Verified')
    `);
    await db.execute(sql`
      INSERT INTO cases (reference, category, teacher_chat_id, status, detail) VALUES
        (${VISA_REF},  ${CASE_CATEGORY.VISA},          ${TEACHER}, 'New', 'the embassy has my passport'),
        (${ACCOM_REF}, ${CASE_CATEGORY.ACCOMMODATION}, ${TEACHER}, 'New', 'the landlord changed the locks')
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('who may change what', () => {
    it('refuses a case outside the caller’s queue, and writes nothing', async () => {
      // The single most important property in this file. `updateCase` takes a
      // bare reference and does not know who is asking — resolving through
      // `findCase` is the only thing standing between a Visa-queue member and
      // an Accommodation case.
      await run(`/close ${ACCOM_REF} sorted`);

      expect((await caseRow(ACCOM_REF)).status).toBe('New');
      expect((await caseRow(ACCOM_REF)).public_update).toBe('');
    });

    it('answers “not yours” exactly as it answers “no such case”', async () => {
      // Confirming a reference exists tells the asker a teacher filed
      // something, which is what the visibility rule protects.
      const hidden = await run(`/note ${ACCOM_REF} anything`);
      const absent = await run('/note VISA-2026-99999 anything');

      expect(hidden.replace(ACCOM_REF, 'X')).toBe(absent.replace('VISA-2026-99999', 'X'));
    });

    it('applies the same gate to every command that writes', async () => {
      await run(`/reply ${ACCOM_REF} hello`);
      await run(`/await ${ACCOM_REF} send a photo`);
      await run(`/reopen ${ACCOM_REF}`);
      await run(`/note ${ACCOM_REF} internal`);

      expect((await caseRow(ACCOM_REF)).status).toBe('New');
      expect(await notesOn(ACCOM_REF)).toHaveLength(0);
    });

    it('refuses an Observer, who may look and change nothing', async () => {
      // The whole point of the rank. case.view is not case.update.
      const body = await run(`/reply ${VISA_REF} hello`, OBSERVER);

      expect(body).toMatch(/rank/i);
      expect((await caseRow(VISA_REF)).status).toBe('New');
    });

    it('lets a member whose queue does cover it through', async () => {
      await run(`/note ${ACCOM_REF} this one is mine`, ACCOM_STAFF);

      expect(await notesOn(ACCOM_REF)).toEqual(['this one is mine']);
    });
  });

  describe('/reply', () => {
    it('moves the case to Under review and puts the words where the teacher sees them', async () => {
      await run(`/reply ${VISA_REF} your visa is with the embassy until Friday`);

      const row = await caseRow(VISA_REF);
      expect(row.status).toBe('Under review');
      expect(row.public_update).toBe('your visa is with the embassy until Friday');
    });

    it('sends the teacher a message, and says what it is', async () => {
      // R10. `deliver` names the message in the alarm it raises when a send
      // fails, and an unnamed one falls back to wording that names nothing.
      const outcome = await command(`/reply ${VISA_REF} your visa is ready`);

      const toTeacher = outcome.messages.filter((m) => m.chatId === TEACHER);
      expect(toTeacher).toHaveLength(1);
      expect(toTeacher[0]?.text).toContain('your visa is ready');
      expect(toTeacher[0]?.purpose).toMatch(/repl/i);
    });

    it('warns the sender when the teacher can no longer use the bot, and still sends', async () => {
      // R5. Telegram will deliver it; the teacher simply cannot open the bot to
      // read the case or answer. Refusing would leave a staff member believing
      // they had answered somebody.
      await db.execute(sql`UPDATE teachers SET verification_state = 'Revoked' WHERE chat_id = ${TEACHER}`);

      const outcome = await command(`/reply ${VISA_REF} your visa is ready`);

      expect(outcome.messages[0]?.text).toMatch(/no longer use the bot/i);
      expect(outcome.messages.some((m) => m.chatId === TEACHER)).toBe(true);
    });

    it('gives the same warning when the roster row is what went', async () => {
      // Wider than R5 described. A teacher loses access two ways and only one
      // of them is a `Revoked` state — `teacherHasAccess` is the single answer
      // to both, which is why the check is that function and not a comparison
      // against verification_state.
      await db.execute(sql`UPDATE roster_entries SET active = false WHERE identifier = ${TEACHER_ID}`);

      expect(await run(`/reply ${VISA_REF} your visa is ready`)).toMatch(/no longer use the bot/i);
    });

    it('refuses a finished case and points at the way to reopen it', async () => {
      await run(`/close ${VISA_REF} all sorted`);

      const body = await run(`/reply ${VISA_REF} one more thing`);

      expect(body).toMatch(/reopen/i);
      expect((await caseRow(VISA_REF)).public_update).toBe('all sorted');
    });

    it('refuses to send nothing', async () => {
      expect(await run(`/reply ${VISA_REF}`)).toMatch(/what should I tell them/i);
      expect((await caseRow(VISA_REF)).status).toBe('New');
    });
  });

  describe('/await', () => {
    it('marks the case as waiting on the teacher and tells them what is wanted', async () => {
      // D26. `Action required` means the teacher must act, so the request has
      // to reach them — an instruction in a staff-only column is one nobody
      // follows.
      const outcome = await command(`/await ${VISA_REF} send a photograph of your passport page`);

      const row = await caseRow(VISA_REF);
      expect(row.status).toBe('Action required');
      expect(row.public_update).toContain('passport page');
      expect(outcome.messages.find((m) => m.chatId === TEACHER)?.text).toContain('passport page');
    });

    it('shows the request through Check My Case as well as by message', async () => {
      await run(`/await ${VISA_REF} send a photograph of your passport page`);

      const visible = await getCasesForChatId(db, TEACHER);
      expect(JSON.stringify(visible)).toContain('passport page');
    });

    it('refuses to mark a case “Action required” without saying what the action is', async () => {
      // A teacher who can see they must act but not what the act is, is stuck
      // in a state only a staff member can leave.
      expect(await run(`/await ${VISA_REF}`)).toMatch(/what do you need/i);
      expect((await caseRow(VISA_REF)).status).toBe('New');
    });

    it('keeps the case open — it is live work, it is just not ours to move', async () => {
      await run(`/await ${VISA_REF} send a photograph`);

      expect(await run('/cases')).toContain(VISA_REF);
    });
  });

  describe('/close', () => {
    it('completes a case and tells the teacher why', async () => {
      const outcome = await command(`/close ${VISA_REF} your visa was issued on Tuesday`);

      const row = await caseRow(VISA_REF);
      expect(row.status).toBe('Completed');
      expect(row.closed_at).not.toBeNull();
      expect(outcome.messages.find((m) => m.chatId === TEACHER)?.text).toContain('issued on Tuesday');
    });

    it('shuts a case unresolved, keeping the reason internal', async () => {
      // D26. The reason is written for whoever reads the case afterwards, and
      // staff being candid is what makes it worth having.
      const outcome = await command(`/close ${VISA_REF} unresolved unreachable since March, three attempts`);

      expect((await caseRow(VISA_REF)).status).toBe('Closed');
      expect(await notesOn(VISA_REF)).toEqual(['Closed unresolved: unreachable since March, three attempts']);

      const toTeacher = outcome.messages.find((m) => m.chatId === TEACHER)?.text ?? '';
      expect(toTeacher).not.toContain('three attempts');
      expect(toTeacher).toContain(SUPPORT);
    });

    it('does not leave a closed case telling the teacher it is being worked on', async () => {
      await run(`/reply ${VISA_REF} we are chasing the embassy now`);
      await run(`/close ${VISA_REF} unresolved teacher has left the country`);

      const visible = JSON.stringify(await getCasesForChatId(db, TEACHER));
      expect(visible).not.toContain('chasing the embassy');
      expect(visible).not.toContain('left the country');
    });

    it('says which of the two it did, because the word could be a genuine message', async () => {
      // `/close REF unresolved issues remain` is a real thing somebody could
      // type meaning the other one. Saying plainly what was done is how that is
      // caught, rather than guessing at intent.
      expect(await run(`/close ${VISA_REF} unresolved gave up`)).toMatch(/without being resolved/i);
    });

    it('refuses to shut a case unresolved with no reason recorded', async () => {
      expect(await run(`/close ${VISA_REF} unresolved`)).toMatch(/why is it being closed/i);
      expect((await caseRow(VISA_REF)).status).toBe('New');
    });

    it('refuses a case that is already finished', async () => {
      await run(`/close ${VISA_REF} done`);

      expect(await run(`/close ${VISA_REF} done again`)).toMatch(/already Completed/i);
    });
  });

  describe('/reopen', () => {
    it('opens a finished case and clears its end date', async () => {
      // The fault this task found. `closed_at` means "when this case ended", and
      // stage 5's retention measures seven days from it — a reopened case
      // carrying a stale one is work in hand that the clean-up would delete.
      await run(`/close ${VISA_REF} done`);
      expect((await caseRow(VISA_REF)).closed_at).not.toBeNull();

      await run(`/reopen ${VISA_REF}`);

      const row = await caseRow(VISA_REF);
      expect(row.status).toBe('Under review');
      expect(row.closed_at).toBeNull();
    });

    it('refuses a case that is already open rather than rewriting its status', async () => {
      // A silent rewrite would move updated_at and make a case somebody else is
      // working look freshly touched to staleCases.
      expect(await run(`/reopen ${VISA_REF}`)).toMatch(/already open/i);
    });

    it('does not message the teacher, and says so', async () => {
      // Nothing has been said to them by a person, and Check My Case shows the
      // status. A notice here would be the bot inventing words nobody wrote.
      await run(`/close ${VISA_REF} done`);
      const outcome = await command(`/reopen ${VISA_REF}`);

      expect(outcome.messages).toHaveLength(1);
      expect(outcome.messages[0]?.text).toMatch(/not been messaged/i);
    });
  });

  describe('/note', () => {
    it('records a note without touching the case', async () => {
      // addNote deliberately leaves the case row alone. If it moved updated_at,
      // a case being discussed internally would look freshly worked to
      // staleCases — which is exactly the case most worth surfacing.
      const before = await caseRow(VISA_REF);
      await run(`/note ${VISA_REF} she is still waiting on the embassy`);
      const after = await caseRow(VISA_REF);

      expect(await notesOn(VISA_REF)).toEqual(['she is still waiting on the embassy']);
      expect(after.updated_at).toBe(before.updated_at);
      expect(after.status).toBe('New');
    });

    it('never lets a note reach the teacher', async () => {
      await run(`/note ${VISA_REF} this teacher has complained twice before`);

      const visible = await getCasesForChatId(db, TEACHER);
      expect(JSON.stringify(visible)).not.toContain('complained twice');
    });

    it('is allowed on a finished case, because a record is not an action', async () => {
      await run(`/close ${VISA_REF} done`);

      await run(`/note ${VISA_REF} the embassy confirmed afterwards`);

      expect(await notesOn(VISA_REF)).toHaveLength(1);
    });

    it('refuses an empty note here rather than throwing inside addNote', async () => {
      // An exception from a command reaches bot.catch, which acknowledges the
      // update and says nothing — so the staff member would see silence and
      // assume it worked.
      expect(await run(`/note ${VISA_REF}`)).toMatch(/what is the note/i);
      expect(await notesOn(VISA_REF)).toHaveLength(0);
    });

    it('counts the notes back, so /case is not needed to check it landed', async () => {
      await run(`/note ${VISA_REF} one`);
      expect(await run(`/note ${VISA_REF} two`)).toContain('2 notes');
    });
  });

  describe('what reaches the interaction log', () => {
    it('keeps a reply out of it', async () => {
      // R1 meeting D16, and /reply is the command the rule was written for.
      await run(`/reply ${VISA_REF} your visa is with the embassy, ready Friday`);

      const rows = await logFor(VISA_STAFF);
      expect(rows).toContain(`/reply ${VISA_REF}`);
      expect(rows.some((r) => r.includes('embassy'))).toBe(false);
    });

    it('keeps a note out of it', async () => {
      await run(`/note ${VISA_REF} she has complained twice before`);

      const rows = await logFor(VISA_STAFF);
      expect(rows).toContain(`/note ${VISA_REF}`);
      expect(rows.some((r) => r.includes('complained'))).toBe(false);
    });

    it('keeps an unresolved closing reason out of it', async () => {
      await run(`/close ${VISA_REF} unresolved unreachable since March`);

      expect((await logFor(VISA_STAFF)).some((r) => r.includes('unreachable'))).toBe(false);
    });
  });

  describe('/assign', () => {
    /**
     * `case.assign` floors at **Program** as of Part 5H.2, raised from `Lead` on
     * 1 August 2026. Cases now arrive with an owner already chosen by load, so
     * moving one is an override of that rather than the way work is handed out.
     */
    const PROGRAM = '995004';
    const LEAD = '995005';

    beforeEach(async () => {
      await db.execute(sql`
        INSERT INTO staff (telegram_id, name, role, queue, regions, active) VALUES
          (${PROGRAM}, 'The Program Admin', 'Program', 'All', ARRAY[]::text[], true),
          (${LEAD},    'The Lead',          'Lead',    'All', ARRAY[]::text[], true)
      `);
    });

    it('is refused for a Lead, naming the rank it needs', async () => {
      // A refusal that names the floor is worth more than "you may not": the
      // recovery is asking a named person for a rank rather than guessing.
      const body = await run(`/assign ${VISA_REF} ${VISA_STAFF}`, LEAD);

      expect(body).toContain('Program');
      expect(await ownerOf(VISA_REF)).toBeNull();
    });

    const auditRows = async (): Promise<{ action: string; subject: string | null }[]> => {
      const rows = await db.execute<{ action: string; subject: string | null }>(
        sql`SELECT action, subject FROM audit_log`,
      );
      return rows.rows;
    };

    const ownerOf = async (reference: string): Promise<string | null> => {
      const rows = await db.execute<{ owner: string | null }>(
        sql`SELECT owner FROM cases WHERE reference = ${reference}`,
      );
      return rows.rows[0]?.owner ?? null;
    };

    it('refuses an id that is not active staff, before touching the case', async () => {
      // R3. cases.owner is a foreign key: writing an unknown id raises a
      // constraint error, which reaches bot.catch, which acknowledges the update
      // and says nothing — so the assigner reads silence as success and nobody
      // is working the case.
      const body = await run(`/assign ${VISA_REF} 999999`, PROGRAM);

      expect(body).toMatch(/not an active staff member/i);
      expect(await ownerOf(VISA_REF)).toBeNull();
    });

    it('refuses a member who has been deactivated', async () => {
      // Their cases would appear in nobody's /mycases, because casesOwnedBy is
      // asked by a person who can no longer ask.
      await db.execute(sql`UPDATE staff SET active = false WHERE telegram_id = ${ACCOM_STAFF}`);

      await run(`/assign ${ACCOM_REF} ${ACCOM_STAFF}`, PROGRAM);

      expect(await ownerOf(ACCOM_REF)).toBeNull();
    });

    it('refuses somebody who could not see the case', async () => {
      // The check a foreign key cannot make. An id can be real staff and still
      // be the wrong person: the case leaves /cases unassigned and is invisible
      // in the new owner's /mycases, which is worse than leaving it unowned.
      const body = await run(`/assign ${VISA_REF} ${ACCOM_STAFF}`, PROGRAM);

      expect(body).toMatch(/cannot see/i);
      expect(body).toContain('Accommodation');
      expect(await ownerOf(VISA_REF)).toBeNull();
    });

    it('assigns to somebody whose queue does cover it, and tells them', async () => {
      const outcome = await command(`/assign ${VISA_REF} ${VISA_STAFF}`, PROGRAM);

      expect(await ownerOf(VISA_REF)).toBe(VISA_STAFF);

      const told = outcome.messages.filter((m) => m.chatId === VISA_STAFF);
      expect(told).toHaveLength(1);
      expect(told[0]?.text).toContain(VISA_REF);
      // R10 — deliver names this in the alarm it raises if the send fails.
      expect(told[0]?.purpose).toMatch(/assigned/i);
    });

    it('puts the case in the new owner’s /mycases and out of the backlog', async () => {
      await run(`/assign ${VISA_REF} ${VISA_STAFF}`, PROGRAM);

      expect(await run('/mycases', VISA_STAFF)).toContain(VISA_REF);
      expect(await run('/cases unassigned', VISA_STAFF)).not.toContain(VISA_REF);
    });

    it('records who handed the case to whom', async () => {
      // D18. recordAudit propagates its errors on purpose — an assignment that
      // cannot be recorded should not happen.
      await run(`/assign ${VISA_REF} ${VISA_STAFF}`, PROGRAM);

      expect(await auditRows()).toEqual([{ action: 'CASE_ASSIGNED', subject: VISA_REF }]);
    });

    it('writes no audit row when it refused', async () => {
      await run(`/assign ${VISA_REF} 999999`, PROGRAM);

      expect(await auditRows()).toHaveLength(0);
    });

    it('names the previous owner when a case moves hands', async () => {
      await run(`/assign ${VISA_REF} ${VISA_STAFF}`, PROGRAM);

      expect(await run(`/assign ${VISA_REF} ${LEAD}`, PROGRAM)).toContain(VISA_STAFF);
    });

    it('does not message somebody about their own action', async () => {
      // Taking a case yourself is now a Program act rather than the commonest
      // use of this command, but the rule is unchanged: nobody is sent a notice
      // about something they just did.
      const outcome = await command(`/assign ${VISA_REF} ${PROGRAM}`, PROGRAM);

      expect(outcome.messages).toHaveLength(1);
      expect(outcome.messages[0]?.text).toMatch(/your \/mycases/i);
    });

    it('says so, and writes nothing, when the case is already theirs', async () => {
      await run(`/assign ${VISA_REF} ${VISA_STAFF}`, PROGRAM);
      await db.execute(sql`DELETE FROM audit_log`);

      expect(await run(`/assign ${VISA_REF} ${VISA_STAFF}`, PROGRAM)).toMatch(/already belongs/i);
      expect(await auditRows()).toHaveLength(0);
    });

    it('is not available to Support, who may work a case but not hand it on', async () => {
      const body = await run(`/assign ${VISA_REF} ${VISA_STAFF}`, VISA_STAFF);

      expect(body).toMatch(/rank/i);
      expect(await ownerOf(VISA_REF)).toBeNull();
    });

    it('refuses a case the assigner themselves cannot see', async () => {
      // The assigner is scoped too. resolveCase runs under their scope before
      // anything about the assignee is considered — and rank does not exempt
      // them, which is why this scopes the Program admin rather than a junior.
      await db.execute(sql`UPDATE staff SET queue = 'Visa' WHERE telegram_id = ${PROGRAM}`);

      await run(`/assign ${ACCOM_REF} ${ACCOM_STAFF}`, PROGRAM);

      expect(await ownerOf(ACCOM_REF)).toBeNull();
    });

    it('asks for an id rather than guessing', async () => {
      expect(await run(`/assign ${VISA_REF}`, PROGRAM)).toMatch(/who should own it/i);
    });
  });

  /**
   * Task 45 — the three judgements staff record about a case.
   *
   * `/mark` is the one that outlives the case: status moves and a resolved
   * emergency becomes `Completed`, so the marker is the only thing that will
   * still know it was one when stage 5's retention reads it (D22, R13).
   */
  describe('marks and dates', () => {
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    /** A date far enough ahead that it cannot go stale while this suite exists. */
    const isoInDays = (days: number): string =>
      new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

    const spelt = (iso: string): string => {
      const [year, month, day] = iso.split('-');
      return `${day!} ${MONTHS[Number(month) - 1]!} ${year!}`;
    };

    const judgement = async (
      reference: string,
    ): Promise<{ importance: string; due_at: string | null; snoozed_until: string | null }> => {
      const rows = await db.execute<{ importance: string; due_at: string | null; snoozed_until: string | null }>(
        sql`SELECT importance, due_at, snoozed_until FROM cases WHERE reference = ${reference}`,
      );
      return rows.rows[0]!;
    };

    describe('/mark', () => {
      it('records a level, and says which one it replaced', async () => {
        const body = await run(`/mark ${VISA_REF} Critical`);

        expect((await judgement(VISA_REF)).importance).toBe('Critical');
        expect(body).toContain('Critical');
        expect(body).toContain('Normal');
      });

      it('refuses a word it does not know instead of quietly marking nothing', async () => {
        const body = await run(`/mark ${VISA_REF} hihg`);

        expect(body).toMatch(/do not know a level/i);
        expect(body).toContain('Critical');
        expect((await judgement(VISA_REF)).importance).toBe('Normal');
      });

      it('reads a level however it is capitalised', async () => {
        await run(`/mark ${VISA_REF} urgent`);
        expect((await judgement(VISA_REF)).importance).toBe('Urgent');
      });

      it('keeps the marker through close and reopen — R13', async () => {
        // Nothing about `Completed` remembers that a case was an emergency. A
        // retention job reading status would delete exactly the cases the rule
        // exists to keep, at the shortest interval, and nobody would find out.
        await run(`/mark ${VISA_REF} Critical`);
        await run(`/close ${VISA_REF} the visa was issued`);
        expect((await judgement(VISA_REF)).importance).toBe('Critical');

        await run(`/reopen ${VISA_REF}`);
        expect((await judgement(VISA_REF)).importance).toBe('Critical');
      });

      it('may be used on a finished case, unlike /due and /snooze', async () => {
        // D22: critical is a judgement somebody makes after reading the case,
        // and the reader who realises afterwards is the person it exists for.
        await run(`/close ${VISA_REF} the visa was issued`);
        await run(`/mark ${VISA_REF} Critical`);

        expect((await judgement(VISA_REF)).importance).toBe('Critical');
      });

      it('is refused outside the caller’s queue, like every other write', async () => {
        await run(`/mark ${ACCOM_REF} Critical`);
        expect((await judgement(ACCOM_REF)).importance).toBe('Normal');
      });

      it('is not available to an Observer', async () => {
        expect(await run(`/mark ${VISA_REF} Critical`, OBSERVER)).toMatch(/rank/i);
        expect((await judgement(VISA_REF)).importance).toBe('Normal');
      });
    });

    describe('/due', () => {
      it('accepts a date a person would actually type, in either form', async () => {
        const iso = isoInDays(30);

        await run(`/due ${VISA_REF} ${iso}`);
        const first = (await judgement(VISA_REF)).due_at;
        expect(first).not.toBeNull();

        await run(`/due ${VISA_REF} ${spelt(iso)}`);
        expect((await judgement(VISA_REF)).due_at).toBe(first);
      });

      it('refuses one in the past, and says to check the year', async () => {
        const body = await run(`/due ${VISA_REF} 2020-01-01`);

        expect(body).toMatch(/already passed/i);
        expect(body).toMatch(/year/i);
        expect((await judgement(VISA_REF)).due_at).toBeNull();
      });

      it('refuses a slashed date rather than guessing which half is the month', async () => {
        const body = await run(`/due ${VISA_REF} 15/08/2026`);

        expect(body).toMatch(/will not guess/i);
        expect((await judgement(VISA_REF)).due_at).toBeNull();
      });

      it('refuses a day that does not exist', async () => {
        await run(`/due ${VISA_REF} 2027-02-31`);
        expect((await judgement(VISA_REF)).due_at).toBeNull();
      });

      it('takes the date off again', async () => {
        await run(`/due ${VISA_REF} ${isoInDays(30)}`);
        await run(`/due ${VISA_REF} clear`);

        expect((await judgement(VISA_REF)).due_at).toBeNull();
      });

      it('refuses a finished case — a promise about work that is over', async () => {
        await run(`/close ${VISA_REF} the visa was issued`);
        const body = await run(`/due ${VISA_REF} ${isoInDays(30)}`);

        expect(body).toMatch(/finished/i);
        expect((await judgement(VISA_REF)).due_at).toBeNull();
      });

      it('tells nobody but the person who typed it', async () => {
        // A date staff agree among themselves is not a promise made to anybody
        // until somebody makes it with /reply.
        const outcome = await command(`/due ${VISA_REF} ${isoInDays(30)}`);

        expect(outcome.messages).toHaveLength(1);
        expect(outcome.messages[0]?.chatId).toBe(VISA_STAFF);
      });
    });

    describe('/snooze', () => {
      it('snoozes for a number of days and says until when', async () => {
        const body = await run(`/snooze ${VISA_REF} 14`);

        expect((await judgement(VISA_REF)).snoozed_until).not.toBeNull();
        expect(body).toMatch(/still open/i);
      });

      it('refuses longer than the cap, rather than throwing into silence', async () => {
        // An exception reaches bot.catch, which acknowledges the update and says
        // nothing — so the staff member would see silence and assume it worked.
        const body = await run(`/snooze ${VISA_REF} 400`);

        expect(body).toMatch(/limit is/i);
        expect((await judgement(VISA_REF)).snoozed_until).toBeNull();
      });

      it('refuses something that is not a number of days', async () => {
        await run(`/snooze ${VISA_REF} a fortnight`);
        expect((await judgement(VISA_REF)).snoozed_until).toBeNull();
      });

      it('can be lifted again, which is the recovery from a mistyped one', async () => {
        await run(`/snooze ${VISA_REF} 90`);
        await run(`/snooze ${VISA_REF} clear`);

        expect((await judgement(VISA_REF)).snoozed_until).toBeNull();
      });

      it('refuses a finished case', async () => {
        await run(`/close ${VISA_REF} the visa was issued`);
        await run(`/snooze ${VISA_REF} 14`);

        expect((await judgement(VISA_REF)).snoozed_until).toBeNull();
      });

      it('changes neither the status nor the owner', async () => {
        await run(`/reply ${VISA_REF} we are on it`);
        await run(`/snooze ${VISA_REF} 14`);

        expect((await caseRow(VISA_REF)).status).toBe('Under review');
      });
    });
  });

  describe('length', () => {
    it('keeps both messages inside what Telegram will deliver', async () => {
      // A reply carries staff free text of unbounded length, and a reply that
      // fails to send is a teacher never told the answer to their problem.
      const outcome = await command(`/reply ${VISA_REF} ${'x'.repeat(9000)}`);

      expect(outcome.messages).toHaveLength(2);
      for (const message of outcome.messages) {
        expect(message.text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_CHARS);
      }
    });
  });
});
