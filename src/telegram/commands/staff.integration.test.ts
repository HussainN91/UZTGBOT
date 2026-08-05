/**
 * Managing the staff table itself — Task 36, over D13, D14 and D18.
 *
 * The commands that finally give this table a full set of writers. Most of what
 * is asserted below is refusals, because that is where the cost is: every
 * mistake here is recovered by a database session over the SSH tunnel, which is
 * precisely what D13 chose when it made the first System row a hand-written
 * INSERT.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CASE_CATEGORY } from '../../config/constants.js';
import { createCase, updateCase } from '../../cases/service.js';
import type { Database } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { withChatLock } from '../../conversation/lock.js';
import { findAnyStaff, findStaff } from '../../staff/repository.js';
import { CALLBACK, encodeCallback } from '../callback-data.js';
import { ALL_QUEUES } from '../../staff/queues.js';
import { route, type InboundUpdate, type RouterOutcome } from '../router.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const SUPPORT = '+998 71 000 0000';

const SYSTEM = '998001';
const SECOND_SYSTEM = '998002';
const PROGRAM = '998003';
const SUPPORT_MEMBER = '998004';
const NEWCOMER = '998005';

const TEACHER = '998101';
const IDENTIFIER = 'staff.teacher@example.com';

describe.skipIf(!TEST_DATABASE_URL)('managing staff', () => {
  let pool: pg.Pool;
  let db: Database;

  const send = (update: InboundUpdate): Promise<RouterOutcome> =>
    withChatLock(db, update.chatId, (tx) => route(tx, update, { supportContact: SUPPORT }));

  const outcomeOf = (text: string, chatId = SYSTEM): Promise<RouterOutcome> =>
    send({ chatId, kind: 'text', text });

  const run = async (text: string, chatId = SYSTEM): Promise<string> =>
    (await outcomeOf(text, chatId)).messages[0]?.text ?? '';

  const auditActions = async (subject: string): Promise<string[]> => {
    const rows = await db.execute<{ action: string }>(
      sql`SELECT action FROM audit_log WHERE subject = ${subject} ORDER BY at`,
    );
    return rows.rows.map((r) => r.action);
  };

  /** One tap on a staff menu, as the button carries it. */
  const tapMenu = (parts: readonly string[], chatId = SYSTEM): Promise<RouterOutcome> =>
    send({ chatId, kind: 'callback', text: encodeCallback(CALLBACK.STAFF_MENU, ...parts) });

  const tapText = async (parts: readonly string[], chatId = SYSTEM): Promise<string> =>
    (await tapMenu(parts, chatId)).messages[0]?.text ?? '';

  const buttonsOf = (outcome: RouterOutcome, index = 0): string[] =>
    (outcome.messages[index]?.keyboard ?? []).flatMap((row) => row.map((b) => b.callback_data));

  const labelsOf = (outcome: RouterOutcome, index = 0): string[] =>
    (outcome.messages[index]?.keyboard ?? []).flatMap((row) => row.map((b) => b.text));

  const queueOf = async (chatId: string): Promise<string | undefined> =>
    (await findAnyStaff(db, chatId))?.queue;

  const regionsOf = async (chatId: string): Promise<readonly string[]> =>
    (await findAnyStaff(db, chatId))?.regions ?? [];

  const addSecondSystem = (): Promise<unknown> =>
    db.execute(sql`
      INSERT INTO staff (telegram_id, name, role, queue, regions, active)
      VALUES (${SECOND_SYSTEM}, 'Second System', 'System', 'All', ARRAY[]::text[], true)
    `);

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`
      TRUNCATE cases, case_notes, teachers, roster_entries, case_sequences,
               conversation_states, messages, faq_entries, urgent_codes,
               urgent_code_attempts, processed_updates, settings, staff,
               identity_dispute_parties, identity_disputes, audit_log CASCADE
    `);

    await db.execute(sql`
      INSERT INTO staff (telegram_id, name, role, queue, regions, active) VALUES
        (${SYSTEM},         'System Admin',   'System',  'All',  ARRAY[]::text[],           true),
        (${PROGRAM},        'Programme Lead', 'Program', 'All',  ARRAY[]::text[],           true),
        (${SUPPORT_MEMBER}, 'Support Person', 'Support', 'Visa', ARRAY['Tashkent']::text[], true)
    `);
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active)
      VALUES (${IDENTIFIER}, 'Staff Test Teacher', 'Tashkent', true)
    `);
    await db.execute(sql`
      INSERT INTO teachers (chat_id, identifier, name, region, verification_state)
      VALUES (${TEACHER}, ${IDENTIFIER}, 'Staff Test Teacher', 'Tashkent', 'Verified')
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('/staff', () => {
    it('lists everybody active, with their rank, queue and regions', async () => {
      const body = await run('/staff');

      expect(body).toContain(SYSTEM);
      expect(body).toContain(PROGRAM);
      expect(body).toContain('Support Person');
      expect(body).toContain('Visa queue');
      expect(body).toContain('Tashkent');
    });

    it('says “every region” rather than printing an empty list', async () => {
      // An empty regions array means every region and never means none. Printing
      // nothing would read as "no access at all" for the person whose access is
      // widest, which is how somebody ends up being granted a rank they did not
      // need.
      expect(await run('/staff')).toContain('every region');
    });

    it('shows deactivated members separately rather than hiding them', async () => {
      // /assign tells people to check an id here, and an id absent because the
      // row is deactivated looks exactly like an id that was mistyped.
      await addSecondSystem();
      await run(`/staff_remove ${PROGRAM}`);

      const body = await run('/staff');
      expect(body).toMatch(/deactivated/i);
      expect(body).toContain(PROGRAM);
    });

    it('is available to a Program admin, and not below', async () => {
      // The list itself contains the word "rank", so a refusal must be matched
      // on the rank it names rather than on that word — this test passed for the
      // wrong reason for the first minutes after the floor moved.
      expect(await run('/staff', PROGRAM)).toContain(SUPPORT_MEMBER);
      expect(await run('/staff', SUPPORT_MEMBER)).toContain('needs Program rank');
    });
  });

  describe('/staff_add', () => {
    it('adds somebody with the rank and queue that were typed', async () => {
      await run(`/staff_add ${NEWCOMER} Lead Visa`);

      const added = await findStaff(db, NEWCOMER);
      expect(added?.role).toBe('Lead');
      expect(added?.queue).toBe('Visa');
      expect(added?.regions).toEqual([]);
    });

    it('writes an audit row in the same transaction as the grant', async () => {
      // D18. src/log/audit.ts propagates its errors on purpose: a grant that
      // cannot be recorded should not happen.
      await run(`/staff_add ${NEWCOMER} Support Visa`);

      expect(await auditActions(NEWCOMER)).toEqual(['STAFF_ADDED']);
    });

    it('notifies the person whose access changed', async () => {
      const outcome = await outcomeOf(`/staff_add ${NEWCOMER} Support Visa`);

      expect(outcome.messages[0]?.chatId).toBe(SYSTEM);
      expect(outcome.messages[1]?.chatId).toBe(NEWCOMER);
      expect(outcome.messages[1]?.text).toContain('Support');
      expect(outcome.messages[1]?.purpose).toBeDefined();
    });

    it('refuses to guess a rank or a queue', async () => {
      // The schema defaults both so that adding the columns could not break
      // existing rows. A command that defaults them grants Support over every
      // queue to somebody the caller may have meant to restrict, and nothing in
      // what they typed shows it.
      const body = await run(`/staff_add ${NEWCOMER}`);

      expect(body).toMatch(/required/i);
      expect(await findAnyStaff(db, NEWCOMER)).toBeNull();
    });

    it('refuses a rank it does not know, and names the ones it does', async () => {
      const body = await run(`/staff_add ${NEWCOMER} Regional All`);

      expect(body).toMatch(/do not know a rank/i);
      expect(body).toContain('Lead');
      expect(await findAnyStaff(db, NEWCOMER)).toBeNull();
    });

    it('refuses a queue it does not know, and names the ones it does', async () => {
      const body = await run(`/staff_add ${NEWCOMER} Support Recruitment`);

      expect(body).toMatch(/do not know a queue/i);
      expect(body).toContain('Visa');
      expect(await findAnyStaff(db, NEWCOMER)).toBeNull();
    });

    it('refuses a region nobody has ever heard of', async () => {
      // The same argument /region makes. A typo here gives a staff member a
      // region no teacher is in, so their queue is silently empty — and an empty
      // queue looks exactly like a quiet week.
      const body = await run(`/staff_add ${NEWCOMER} Lead All Tashkant`);

      expect(body).toMatch(/do not know a region/i);
      expect(await findAnyStaff(db, NEWCOMER)).toBeNull();
    });

    it('writes the spelling the roster uses, whatever was typed', async () => {
      await run(`/staff_add ${NEWCOMER} Lead All tashkent`);

      expect((await findStaff(db, NEWCOMER))?.regions).toEqual(['Tashkent']);
    });

    it('takes several regions, comma-separated', async () => {
      await db.execute(sql`
        INSERT INTO roster_entries (identifier, name, region, active)
        VALUES ('staff.samarkand@example.com', 'Samarkand Teacher', 'Samarkand', true)
      `);

      await run(`/staff_add ${NEWCOMER} Lead All Tashkent, Samarkand`);

      expect((await findStaff(db, NEWCOMER))?.regions).toEqual(['Tashkent', 'Samarkand']);
    });

    it('refuses somebody who already has a row, and points at /staff_role', async () => {
      // Adding is adding. /add_admin used to upsert, and its defaulting fourth
      // argument stripped IS_SYSTEM_ADMIN from whatever row it landed on —
      // including the caller's own.
      const body = await run(`/staff_add ${PROGRAM} Observer All`);

      expect(body).toMatch(/already has a staff row/i);
      expect(body).toContain('/staff_role');
      expect((await findStaff(db, PROGRAM))?.role).toBe('Program');
    });

    it('is available to a Program admin, and not below', async () => {
      // Lowered from System to Program on 5 August 2026 at the head of
      // project's instruction. The second half is the half that can regress
      // quietly: a floor nobody is under is not a floor.
      expect(await run(`/staff_add ${NEWCOMER} Support Visa`, PROGRAM)).toMatch(/is now staff/i);
      expect((await findStaff(db, NEWCOMER))?.role).toBe('Support');

      const refused = await run(`/staff_add ${SECOND_SYSTEM} Support Visa`, SUPPORT_MEMBER);
      expect(refused).toContain('needs Program rank');
      expect(await findAnyStaff(db, SECOND_SYSTEM)).toBeNull();
    });
  });

  describe('/staff_role', () => {
    it('changes a rank and records it', async () => {
      await run(`/staff_role ${SUPPORT_MEMBER} Lead`);

      expect((await findStaff(db, SUPPORT_MEMBER))?.role).toBe('Lead');
      expect(await auditActions(SUPPORT_MEMBER)).toEqual(['STAFF_ROLE_SET']);
    });

    it('is the way back from /staff_remove', async () => {
      // Reactivation lives here rather than in a command of its own, so there is
      // no state a person can be left in that needs a database session to leave.
      await run(`/staff_remove ${SUPPORT_MEMBER}`);
      expect(await findStaff(db, SUPPORT_MEMBER)).toBeNull();

      const body = await run(`/staff_role ${SUPPORT_MEMBER} Support`);

      expect(body).toMatch(/active again/i);
      expect(await findStaff(db, SUPPORT_MEMBER)).not.toBeNull();
    });

    it('refuses to demote the last active System member', async () => {
      // Not in the plan, and the same hole D13 guards on /staff_remove. Demoting
      // the only System member empties the rank exactly as deactivating them
      // does, with the same recovery: SSH and SQL.
      const body = await run(`/staff_role ${SYSTEM} Program`);

      expect(body).toMatch(/last active System member/i);
      expect((await findStaff(db, SYSTEM))?.role).toBe('System');
    });

    it('allows the demotion once there is a second System member', async () => {
      await addSecondSystem();

      await run(`/staff_role ${SYSTEM} Program`);

      expect((await findStaff(db, SYSTEM))?.role).toBe('Program');
    });

    it('says so and records nothing when the rank is already that', async () => {
      const body = await run(`/staff_role ${PROGRAM} Program`);

      expect(body).toMatch(/already Program/i);
      expect(await auditActions(PROGRAM)).toHaveLength(0);
    });

    it('points at /staff_add when there is no row', async () => {
      const body = await run(`/staff_role ${NEWCOMER} Support`);

      expect(body).toMatch(/no staff row/i);
      expect(body).toContain('/staff_add');
    });

    it('notifies the person whose rank changed', async () => {
      const outcome = await outcomeOf(`/staff_role ${SUPPORT_MEMBER} Lead`);

      expect(outcome.messages[1]?.chatId).toBe(SUPPORT_MEMBER);
      expect(outcome.messages[1]?.text).toContain('Lead');
    });

    it('is available to a Program admin, and not below', async () => {
      expect(await run(`/staff_role ${SUPPORT_MEMBER} Lead`, SUPPORT_MEMBER)).toContain(
        'needs Program rank',
      );
      expect((await findStaff(db, SUPPORT_MEMBER))?.role).toBe('Support');

      await run(`/staff_role ${SUPPORT_MEMBER} Lead`, PROGRAM);
      expect((await findStaff(db, SUPPORT_MEMBER))?.role).toBe('Lead');
    });
  });

  describe('/staff_remove', () => {
    it('deactivates rather than deleting, so notes and audit rows still name them', async () => {
      await run(`/staff_remove ${SUPPORT_MEMBER}`);

      expect(await findStaff(db, SUPPORT_MEMBER)).toBeNull();
      expect((await findAnyStaff(db, SUPPORT_MEMBER))?.active).toBe(false);
      expect(await auditActions(SUPPORT_MEMBER)).toEqual(['STAFF_REMOVED']);
    });

    it('refuses self-deactivation', async () => {
      // AdminCommands.gs:1209. Every staff command checks for an active row, so
      // the moment it went through the caller would have no way to undo it.
      await addSecondSystem();

      const body = await run(`/staff_remove ${SYSTEM}`, SYSTEM);

      expect(body).toMatch(/cannot remove yourself/i);
      expect(await findStaff(db, SYSTEM)).not.toBeNull();
    });

    it('cannot be used to leave nobody at System — D13, whichever order it is done in', async () => {
      // The property, tested rather than the branch. It was written when the
      // branch was unreachable — `staff.manage` floored at System, so reaching a
      // count of one meant being that one, which the self-check refuses first —
      // and asserted as behaviour precisely so that a change to either rule
      // would be caught here rather than by an empty staff table. The floor
      // moved to Program on 5 August 2026 and the branch is now live; the test
      // below is that path.
      await addSecondSystem();
      await run(`/staff_remove ${SECOND_SYSTEM}`);
      await run(`/staff_remove ${SYSTEM}`, SYSTEM);

      const rows = await db.execute<{ n: string }>(
        sql`SELECT count(*) AS n FROM staff WHERE role = 'System' AND active = true`,
      );
      expect(Number(rows.rows[0]?.n)).toBe(1);
    });

    it('reports open cases owned by somebody being deactivated, and leaves them assigned', async () => {
      // R3, second order. Silently unassigning would lose the only record of who
      // was working them; ON DELETE SET NULL never fires, because staff are
      // deactivated rather than deleted.
      const filed = await createCase(db, {
        chatId: TEACHER,
        category: CASE_CATEGORY.VISA,
        detail: 'visa refused',
      });
      await updateCase(db, filed.reference, { owner: SUPPORT_MEMBER }, SYSTEM);

      const body = await run(`/staff_remove ${SUPPORT_MEMBER}`);

      expect(body).toMatch(/1 open case/i);
      expect(body).toContain(filed.reference);

      const rows = await db.execute(
        sql`SELECT owner FROM cases WHERE reference = ${filed.reference}`,
      );
      expect(String(rows.rows[0]?.['owner'])).toBe(SUPPORT_MEMBER);
    });

    it('says so and records nothing when they are already deactivated', async () => {
      await run(`/staff_remove ${SUPPORT_MEMBER}`);
      const body = await run(`/staff_remove ${SUPPORT_MEMBER}`);

      expect(body).toMatch(/already deactivated/i);
      expect(await auditActions(SUPPORT_MEMBER)).toHaveLength(1);
    });

    it('says plainly when there is no such row', async () => {
      expect(await run(`/staff_remove ${NEWCOMER}`)).toMatch(/no staff row/i);
    });

    it('notifies the person whose access ended', async () => {
      const outcome = await outcomeOf(`/staff_remove ${SUPPORT_MEMBER}`);

      expect(outcome.messages[1]?.chatId).toBe(SUPPORT_MEMBER);
      expect(outcome.messages[1]?.text).toMatch(/access.*has ended/i);
    });

    it('actually ends their ability to run staff commands', async () => {
      // The whole point, and it goes through the dispatcher rather than the
      // repository: a deactivated member is a stranger, so the command falls
      // through to ordinary teacher handling and tells them nothing.
      await run(`/staff_remove ${SUPPORT_MEMBER}`);

      expect(await run('/whoami', SUPPORT_MEMBER)).not.toMatch(/signed in as staff/i);
    });

    it('refuses a Program admin the last active System member', async () => {
      /**
       * The newly reachable half of D13, live since the floor moved on 5 August
       * 2026. A Program member deactivating the only System member is not
       * deactivating themselves, so the self-check that used to answer first
       * never fires, and this branch is all there is between the ministry and a
       * bot with nobody who can settle a disputed identity or pause it.
       */
      const body = await run(`/staff_remove ${SYSTEM}`, PROGRAM);

      expect(body).toMatch(/last active System member/i);
      expect(await findStaff(db, SYSTEM)).not.toBeNull();
    });

    it('lets a Program admin deactivate somebody, and refuses below that', async () => {
      // The refusal is asserted first on purpose: a deactivated member is a
      // stranger to every staff command, so a Support member who has just been
      // removed would be answered with the teacher menu rather than a refusal,
      // and the second half of this test would pass for the wrong reason.
      // Matched on the refusal's own words: the target is called "Programme
      // Lead", so a bare check for "Program" would pass on their name.
      expect(await run(`/staff_remove ${PROGRAM}`, SUPPORT_MEMBER)).toContain('needs Program rank');
      expect(await findStaff(db, PROGRAM)).not.toBeNull();

      expect(await run(`/staff_remove ${SUPPORT_MEMBER}`, PROGRAM)).toMatch(/deactivated/i);
      expect(await findStaff(db, SUPPORT_MEMBER)).toBeNull();
    });
  });

  /**
   * `/staff_queue` — new on 1 August 2026, and it closes a gap rather than
   * adding a feature: a queue could only ever be set once, by `/staff_add`.
   * `/staff_role` and `/staff_region` have always existed for the other two axes
   * of the same model.
   */
  describe('/staff_queue', () => {
    it('moves somebody to another queue and tells them', async () => {
      const outcome = await outcomeOf(`/staff_queue ${SUPPORT_MEMBER} Accommodation`);

      expect(await queueOf(SUPPORT_MEMBER)).toBe('Accommodation');
      expect(outcome.messages[1]?.chatId).toBe(SUPPORT_MEMBER);
      expect(await auditActions(SUPPORT_MEMBER)).toContain('STAFF_QUEUE_SET');
    });

    it('refuses a queue this build does not have, and names the ones it does', async () => {
      // The same rule /staff_region applies to a region. A queue written happily
      // and never matched leaves somebody with a silently empty list, and since
      // Part 5H.1 it also stops work being routed to them — with nothing to say so.
      const body = await run(`/staff_queue ${SUPPORT_MEMBER} Medical`);

      expect(body).toContain('Visa');
      expect(await queueOf(SUPPORT_MEMBER)).toBe('Visa');
    });

    it('does not bring a deactivated person back, which is what a rank is for', async () => {
      /**
       * The one difference from `setStaffRole`, which does reactivate.
       * `/staff_role` is the documented way back from `/staff_remove`, and a
       * queue change restoring access would be a second, undocumented door into
       * being staff again.
       */
      await run(`/staff_remove ${SUPPORT_MEMBER}`);
      await run(`/staff_queue ${SUPPORT_MEMBER} Travel`);

      expect(await queueOf(SUPPORT_MEMBER)).toBe('Travel');
      expect(await findStaff(db, SUPPORT_MEMBER)).toBeNull();
    });

    it('says nothing changed rather than writing an audit row for nothing', async () => {
      await db.execute(sql`DELETE FROM audit_log`);
      const body = await run(`/staff_queue ${SUPPORT_MEMBER} Visa`);

      expect(body).toMatch(/already holds/i);
      expect(await auditActions(SUPPORT_MEMBER)).toHaveLength(0);
    });
  });

  /**
   * Part 5H.3, asked for directly: *"i do /staff, i see a list of staff listed
   * as buttons, i choose the staff, then bot prompts me, what to do with them
   * … i need it button based PLEASE."*
   *
   * The property worth protecting is not that the buttons work. It is that they
   * do not know anything the commands do not — every acting tap is turned back
   * into the typed command it is equivalent to, so there is no second copy of
   * "the last System member keeps their rank" to drift from the first.
   */
  describe('managing staff by button', () => {
    it('puts a button for each person under /staff', async () => {
      const outcome = await outcomeOf('/staff');

      expect(buttonsOf(outcome)).toContain(encodeCallback(CALLBACK.STAFF_MENU, SUPPORT_MEMBER));
      expect(buttonsOf(outcome)).toContain(encodeCallback(CALLBACK.STAFF_MENU, PROGRAM));
    });

    it('shows what can be done with the person who was tapped', async () => {
      const outcome = await tapMenu([SUPPORT_MEMBER]);

      expect(outcome.messages[0]?.text).toContain('Support Person');
      expect(buttonsOf(outcome)).toEqual([
        encodeCallback(CALLBACK.STAFF_MENU, SUPPORT_MEMBER, 'ROLE'),
        encodeCallback(CALLBACK.STAFF_MENU, SUPPORT_MEMBER, 'Q'),
        encodeCallback(CALLBACK.STAFF_MENU, SUPPORT_MEMBER, 'R'),
        encodeCallback(CALLBACK.STAFF_MENU, SUPPORT_MEMBER, 'OFF'),
        encodeCallback(CALLBACK.STAFF_MENU),
      ]);
    });

    it('offers every rank, ticking the one they hold', async () => {
      const outcome = await tapMenu([SUPPORT_MEMBER, 'ROLE']);

      expect(labelsOf(outcome)).toContain('✅ Support');
      expect(labelsOf(outcome)).toContain('Lead');
    });

    it('changes a rank in one tap, and tells the person', async () => {
      const outcome = await tapMenu([SUPPORT_MEMBER, 'ROLE', 'Lead']);

      expect((await findAnyStaff(db, SUPPORT_MEMBER))?.role).toBe('Lead');
      // messages[1] is the notice to the person whose access changed; the list
      // follows it, so the next change needs no command retyped.
      expect(outcome.messages.some((m) => m.chatId === SUPPORT_MEMBER)).toBe(true);
      expect(await auditActions(SUPPORT_MEMBER)).toContain('STAFF_ROLE_SET');
    });

    it('offers every queue, and changes it in one tap', async () => {
      const offered = labelsOf(await tapMenu([SUPPORT_MEMBER, 'Q']));
      for (const queue of ALL_QUEUES) {
        expect(offered.some((l) => l.endsWith(queue))).toBe(true);
      }

      await tapMenu([SUPPORT_MEMBER, 'Q', 'Accommodation']);
      expect(await queueOf(SUPPORT_MEMBER)).toBe('Accommodation');
    });

    describe('regions, which are a list rather than a choice', () => {
      it('adds one that is not held, and removes one that is', async () => {
        // Every other menu here picks one value out of a fixed set. This one is
        // built up over several taps, and each tap is still a whole instruction.
        await tapMenu([SUPPORT_MEMBER, 'R', 'Tashkent']);
        expect(await regionsOf(SUPPORT_MEMBER)).toEqual([]);

        await tapMenu([SUPPORT_MEMBER, 'R', 'Tashkent']);
        expect(await regionsOf(SUPPORT_MEMBER)).toEqual(['Tashkent']);
      });

      it('ticks the regions they already hold', async () => {
        expect(labelsOf(await tapMenu([SUPPORT_MEMBER, 'R']))).toContain('✅ Tashkent');
      });

      it('says so rather than showing an empty picker before the roster syncs', async () => {
        // The teacher goes first: their identifier is a foreign key into the
        // roster, which is the schema saying a teacher cannot outlive their row.
        await db.execute(sql`DELETE FROM teachers`);
        await db.execute(sql`DELETE FROM roster_entries`);

        expect(await tapText([SUPPORT_MEMBER, 'R'])).toContain('no regions at all');
      });
    });

    it('removes somebody from staff, and offers to put them back afterwards', async () => {
      await tapMenu([SUPPORT_MEMBER, 'OFF']);
      expect(await findStaff(db, SUPPORT_MEMBER)).toBeNull();

      // The row stays, so the menu can still reach them — and the slot that said
      // Remove now says the opposite, because it is one question with two words.
      expect(buttonsOf(await tapMenu([SUPPORT_MEMBER]))).toContain(
        encodeCallback(CALLBACK.STAFF_MENU, SUPPORT_MEMBER, 'ON'),
      );

      await tapMenu([SUPPORT_MEMBER, 'ON']);
      expect(await findStaff(db, SUPPORT_MEMBER)).not.toBeNull();
    });

    describe('the buttons know nothing the commands do not', () => {
      it('refuses to demote the last active System member, through the button', async () => {
        /**
         * **The test this whole part turns on.** That refusal lives in
         * `/staff_role` and nowhere else, and the button reaches it by being
         * retyped as that command rather than by re-implementing it. If the menu
         * ever grows its own path to `setStaffRole`, this is what fails.
         */
        const body = await tapText([SYSTEM, 'ROLE', 'Support']);

        expect(body).toMatch(/last active System member/i);
        expect((await findAnyStaff(db, SYSTEM))?.role).toBe('System');
      });

      it('refuses to remove yourself, through the button', async () => {
        /**
         * A *different* refusal from the one above, and it fires first: the
         * last active System member is also the person tapping, and
         * `/staff_remove` stops self-removal before it counts Systems at all.
         *
         * Which one answers is not the point. The point is that neither lives
         * anywhere near this menu, and both reached it anyway.
         */
        const body = await tapText([SYSTEM, 'OFF']);

        expect(body).toMatch(/cannot remove yourself/i);
        expect(await findStaff(db, SYSTEM)).not.toBeNull();
      });
    });

    describe('who may tap', () => {
      it('answers a teacher with the main menu, never with a refusal', async () => {
        // The dispatcher's rule. "You are not staff" tells a stranger that the
        // button they guessed at is real.
        expect(await tapText([SUPPORT_MEMBER, 'ROLE', 'System'], TEACHER)).toContain(
          'What would you like to do?',
        );
        expect((await findAnyStaff(db, SUPPORT_MEMBER))?.role).toBe('Support');
      });

      it('lets a Program admin change a rank through the button', async () => {
        // Program held staff.manage from 5 August 2026, and the buttons inherit
        // it because they run the typed command rather than a copy of it.
        await tapText([SUPPORT_MEMBER, 'ROLE', 'Lead'], PROGRAM);

        expect((await findAnyStaff(db, SUPPORT_MEMBER))?.role).toBe('Lead');
      });

      it('tells a Support member plainly that this needs Program', async () => {
        // They can see the button, so silence would leave them tapping it.
        const body = await tapText([SUPPORT_MEMBER, 'ROLE', 'Lead'], SUPPORT_MEMBER);

        expect(body).toContain('needs Program rank');
        expect((await findAnyStaff(db, SUPPORT_MEMBER))?.role).toBe('Support');
      });

      it('re-reads the subject on every tap, not only when the menu was drawn', async () => {
        // A menu sits in a chat for ever. The person it names may be gone.
        await db.execute(sql`DELETE FROM staff WHERE telegram_id = ${SUPPORT_MEMBER}`);

        expect(await tapText([SUPPORT_MEMBER])).toContain('no staff row any more');
      });
    });
  });

  describe('adding somebody by button', () => {
    it('walks from the id through rank and queue to a staff row', async () => {
      const start = await send({
        chatId: SYSTEM,
        kind: 'callback',
        text: encodeCallback(CALLBACK.STAFF_ADD),
      });
      expect(start.messages[0]?.text).toContain('chat id');

      const afterId = await send({ chatId: SYSTEM, kind: 'text', text: '995500' });
      const rankLabels = labelsOf(afterId);
      expect(rankLabels).toContain('Support');

      const afterRank = await send({
        chatId: SYSTEM,
        kind: 'callback',
        text: encodeCallback(CALLBACK.STAFF_ADD, '995500', 'Support'),
      });
      const queueLabels = labelsOf(afterRank);
      expect(queueLabels).toContain('Visa');

      await send({
        chatId: SYSTEM,
        kind: 'callback',
        text: encodeCallback(CALLBACK.STAFF_ADD, '995500', 'Support', 'Visa'),
      });

      const rows = await db.execute<{ role: string; queue: string; regions: string[] }>(
        sql`SELECT role, queue, regions FROM staff WHERE telegram_id = '995500'`,
      );
      expect(rows.rows[0]?.role).toBe('Support');
      expect(rows.rows[0]?.queue).toBe('Visa');
      // Regions are not asked for; empty means every region, never none.
      expect(rows.rows[0]?.regions).toEqual([]);
    });

    it('refuses the whole flow to somebody who may not manage staff', async () => {
      const outcome = await send({
        chatId: SUPPORT_MEMBER,
        kind: 'callback',
        text: encodeCallback(CALLBACK.STAFF_ADD, '995501', 'System', 'All'),
      });

      expect(outcome.messages[0]?.text).toContain('rank or above');
      const rows = await db.execute(sql`SELECT 1 FROM staff WHERE telegram_id = '995501'`);
      expect(rows.rows).toHaveLength(0);
    });

    /**
     * The typed id is not validated by the flow — `/staff_add` already answers a
     * chat id that has a row, and duplicating that check here would be a second
     * copy of it. This proves the existing answer is what comes back.
     */
    it('hands an existing chat id to the command that already answers for it', async () => {
      await send({
        chatId: SYSTEM,
        kind: 'callback',
        text: encodeCallback(CALLBACK.STAFF_ADD, SUPPORT_MEMBER, 'Support', 'Visa'),
      });

      const rows = await db.execute<{ count: string }>(
        sql`SELECT count(*) AS count FROM staff WHERE telegram_id = ${SUPPORT_MEMBER}`,
      );
      expect(rows.rows[0]?.count).toBe('1');
    });
  });

  // -------------------------------------------------------------------------
  // Identity disputes — Feature A
  // -------------------------------------------------------------------------

  describe('/disputes and /dispute_resolve', () => {
    const SECOND_TEACHER = '998102';

    /** Two chats holding one roster identity, with a dispute open over it. */
    const openOne = async (): Promise<number> => {
      await db.execute(sql`
        INSERT INTO teachers (chat_id, identifier, name, region, verification_state)
        VALUES (${SECOND_TEACHER}, ${IDENTIFIER}, 'Staff Test Teacher', 'Tashkent', 'Verified')
      `);
      const inserted = await db.execute<{ id: number }>(sql`
        INSERT INTO identity_disputes (identifier, state) VALUES (${IDENTIFIER}, 'Open')
        RETURNING id
      `);
      const id = inserted.rows[0]?.id ?? 0;
      await db.execute(sql`
        INSERT INTO identity_dispute_parties (dispute_id, chat_id)
        VALUES (${id}, ${TEACHER}), (${id}, ${SECOND_TEACHER})
      `);
      return id;
    };

    it('lists an open dispute to a Support member, with a button', async () => {
      // Support is the floor deliberately: a MoPSE regional admin is usually a
      // Support row with a region set, so a higher floor would mean no regional
      // admin ever sees one.
      const id = await openOne();
      const outcome = await outcomeOf('/disputes', SUPPORT_MEMBER);

      expect(outcome.messages[0]?.text).toContain(`#${String(id)}`);
      expect(outcome.messages[0]?.text).toContain(IDENTIFIER);
      expect(buttonsOf(outcome)).toContain(encodeCallback(CALLBACK.DISPUTE_ESCALATE, String(id)));
    });

    it('says plainly when nothing is in dispute', async () => {
      expect(await run('/disputes', SUPPORT_MEMBER)).toContain('No accounts are in dispute');
    });

    it('is not a command-existence oracle for somebody with no staff row', async () => {
      // Silence, exactly as every other staff command gives — a reply would tell
      // a stranger the command is real.
      const outcome = await outcomeOf('/disputes', TEACHER);
      expect(outcome.messages[0]?.text ?? '').not.toContain('dispute');
    });

    it('refuses /dispute_resolve to Program, naming the rank it needs', async () => {
      const id = await openOne();
      const body = await run(`/dispute_resolve ${String(id)} ${TEACHER} checked`, PROGRAM);

      expect(body).toContain('System');
      expect((await findStaff(db, PROGRAM))?.role).toBe('Program');
    });

    it('refuses a chat id that is not one of the accounts in dispute', async () => {
      const id = await openOne();
      const body = await run(`/dispute_resolve ${String(id)} 998999 checked`, SYSTEM);

      expect(body).toContain('not one of the accounts');
    });

    it('insists on a reason, because the audit row is the point', async () => {
      const id = await openOne();
      const body = await run(`/dispute_resolve ${String(id)} ${TEACHER}`, SYSTEM);

      expect(body).toContain('I need a reason');
    });

    it('settles it, revoking the other account and writing one audit row', async () => {
      const id = await openOne();
      await createCase(db, {
        chatId: SECOND_TEACHER,
        category: CASE_CATEGORY.VISA,
        detail: 'a case on the losing account',
      });

      const body = await run(
        `/dispute_resolve ${String(id)} ${TEACHER} telephoned the school`,
        SYSTEM,
      );

      expect(body).toContain('settled');
      const states = await db.execute<{ chat_id: string; state: string }>(sql`
        SELECT chat_id, verification_state AS state FROM teachers
        WHERE chat_id IN (${TEACHER}, ${SECOND_TEACHER}) ORDER BY chat_id
      `);
      expect(states.rows.find((r) => r.chat_id === TEACHER)?.state).toBe('Verified');
      expect(states.rows.find((r) => r.chat_id === SECOND_TEACHER)?.state).toBe('Revoked');

      // The losing account's case is closed with a reason a teacher can read.
      const closed = await db.execute<{ status: string; public_update: string | null }>(
        sql`SELECT status, public_update FROM cases WHERE teacher_chat_id = ${SECOND_TEACHER}`,
      );
      expect(closed.rows[0]?.status).toBe('Closed');
      expect(closed.rows[0]?.public_update).toContain(SUPPORT);

      expect(await auditActions(IDENTIFIER)).toEqual(['IDENTITY_DISPUTE_RESOLVED']);
    });

    it('gives the typed command and the button the identical answer', async () => {
      // The whole reason `settleAndAnnounce` lives outside the router. If the two
      // paths ever grow separate implementations, this is what fails.
      const id = await openOne();
      await run(`/dispute_resolve ${String(id)} ${TEACHER} checked`, SYSTEM);

      const viaButton = await send({
        chatId: SYSTEM,
        kind: 'callback',
        text: encodeCallback(CALLBACK.DISPUTE_RESOLVE, String(id), SECOND_TEACHER),
      });

      expect(viaButton.messages[0]?.text).toContain('already settled');
      // And it did not change hands on the second attempt.
      const kept = await db.execute<{ state: string }>(
        sql`SELECT verification_state AS state FROM teachers WHERE chat_id = ${TEACHER}`,
      );
      expect(kept.rows[0]?.state).toBe('Verified');
    });
  });
});
