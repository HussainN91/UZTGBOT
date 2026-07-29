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
               audit_log CASCADE
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

    it('is not available below System', async () => {
      expect(await run('/staff', PROGRAM)).toMatch(/rank/i);
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

    it('is not available below System', async () => {
      expect(await run(`/staff_add ${NEWCOMER} Support Visa`, PROGRAM)).toMatch(/rank/i);
      expect(await findAnyStaff(db, NEWCOMER)).toBeNull();
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

    it('is not available below System', async () => {
      expect(await run(`/staff_role ${SUPPORT_MEMBER} Lead`, PROGRAM)).toMatch(/rank/i);
      expect((await findStaff(db, SUPPORT_MEMBER))?.role).toBe('Support');
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
      // The property, tested rather than the branch, because the branch turns
      // out to be unreachable: `staff.manage` floors at System, so the caller is
      // always an active System member, and the only way to reach a count of one
      // is to be that one — which the self-check refuses first. Asserted as
      // behaviour so that a later change to either rule is caught by this test
      // rather than by an empty staff table.
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

    it('is not available below System', async () => {
      expect(await run(`/staff_remove ${SUPPORT_MEMBER}`, PROGRAM)).toMatch(/rank/i);
      expect(await findStaff(db, SUPPORT_MEMBER)).not.toBeNull();
    });
  });
});
