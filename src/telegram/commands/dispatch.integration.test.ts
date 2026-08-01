/**
 * The dispatcher, the deny path, and `/whoami` — D9.
 *
 * Driven through `route` rather than through the dispatcher directly, because
 * the two properties that matter most are about *ordering*: a command must be
 * matched before the teacher state machine, and a sender who is not staff must
 * fall out of the command path and back into ordinary handling with their text
 * intact. Neither is visible from inside the dispatcher.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { saveState } from '../../conversation/state.js';
import { withChatLock } from '../../conversation/lock.js';
import type { Database } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { CAPABILITY } from '../../staff/roles.js';
import { route, type InboundUpdate, type RouterOutcome } from '../router.js';
import { routeStaffCommand, type StaffCommand } from './index.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const SUPPORT = '+998 71 000 0000';

const LEAD = '991001';
const OBSERVER = '991002';
const REMOVED = '991003';
const STRANGER = '991004';
const TEACHER = '991005';

const IDENTIFIER = 'dispatch.tester@example.com';

describe.skipIf(!TEST_DATABASE_URL)('the staff command dispatcher', () => {
  let pool: pg.Pool;
  let db: Database;

  const send = async (update: InboundUpdate): Promise<RouterOutcome> =>
    withChatLock(db, update.chatId, (tx) => route(tx, update, { supportContact: SUPPORT }));

  const text = (body: string, chatId: string): Promise<RouterOutcome> =>
    send({ chatId, kind: 'text', text: body });

  const firstText = (outcome: RouterOutcome): string => outcome.messages[0]?.text ?? '';

  /** Every action logged for one chat, in no particular order. */
  const actionsFor = async (chatId: string): Promise<string[]> => {
    const rows = await db.execute<{ action: string }>(
      sql`SELECT action FROM messages WHERE chat_id = ${chatId}`,
    );
    return rows.rows.map((r) => r.action);
  };

  const detailsFor = async (chatId: string, action: string): Promise<string[]> => {
    const rows = await db.execute<{ detail: string }>(
      sql`SELECT detail FROM messages WHERE chat_id = ${chatId} AND action = ${action}`,
    );
    return rows.rows.map((r) => r.detail);
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
        (${LEAD},     'Aziza Lead',   'Lead',     'Visa', ARRAY['Tashkent']::text[], true),
        (${OBSERVER}, 'Otabek Eyes',  'Observer', 'All',  ARRAY[]::text[],           true),
        (${REMOVED},  'Removed Rana', 'System',   'All',  ARRAY[]::text[],           false)
    `);

    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active)
      VALUES (${IDENTIFIER}, 'Dispatch Tester', 'Tashkent', true)
    `);
    await db.execute(sql`
      INSERT INTO teachers (chat_id, identifier, name, region, verification_state)
      VALUES (${TEACHER}, ${IDENTIFIER}, 'Dispatch Tester', 'Tashkent', 'Verified')
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('/whoami', () => {
    it('reports the rank, queue and regions the gates actually read', async () => {
      const body = firstText(await text('/whoami', LEAD));

      expect(body).toContain('Lead');
      expect(body).toContain('Visa');
      expect(body).toContain('Tashkent');
    });

    it('lists what the ladder grants, and nothing it does not', async () => {
      // The whole reason /whoami reads the capability table rather than a second
      // list: what it reports cannot disagree with what is enforced.
      const body = firstText(await text('/whoami', LEAD));

      expect(body).toContain('/region');
      expect(body).not.toContain('/maintenance');
    });

    it('stopped offering /assign to a Lead the moment the floor moved', async () => {
      /**
       * Part 5H.2 raised `case.assign` from `Lead` to `Program`, and **this test
       * changed by itself** — it asserted `/assign` was listed here, and failed
       * on the run after the one-line change, without `/whoami` being touched.
       *
       * That is the property being protected, demonstrated rather than
       * described: the message is generated from the same table the gates read,
       * so a permission cannot move in one place and stay put in the other. The
       * Apps Script version drifted precisely because "what am I allowed to do"
       * and "may I do this" were two lists.
       */
      expect(firstText(await text('/whoami', LEAD))).not.toContain('/assign');
    });

    it('tells an Observer they may look and change nothing', async () => {
      const body = firstText(await text('/whoami', OBSERVER));

      expect(body).toContain('/search');
      expect(body).not.toContain('/close');
      expect(body).not.toContain('/generate_urgent_code');
    });

    it('says "every region" rather than an empty list when no region is set', async () => {
      // An empty regions array means every region and never means none
      // (schema.ts:281). Printing nothing there reads as "no access at all".
      expect(firstText(await text('/whoami', OBSERVER)).toLowerCase()).toContain('every region');
    });
  });

  describe('the deny path', () => {
    it('does not tell a stranger that the command exists', async () => {
      const outcome = await text('/whoami', STRANGER);

      expect(firstText(outcome)).not.toMatch(/staff|admin|permission|rank/i);
    });

    it('logs the denial, so privilege probing leaves a trace', async () => {
      await text('/whoami', STRANGER);

      expect(await actionsFor(STRANGER)).toContain('STAFF_DENIED');
    });

    it('falls the stranger through to ordinary handling', async () => {
      // D9. The message is not consumed by the rejection: a stranger gets the
      // reply any other text would have got.
      const outcome = await text('/whoami', STRANGER);

      expect(outcome.messages).toHaveLength(1);
      expect(firstText(outcome)).not.toBe('');
    });

    it('treats a deactivated member as a stranger, whatever their rank was', async () => {
      // A deactivated System member is not a System member.
      const outcome = await text('/whoami', REMOVED);

      expect(firstText(outcome)).not.toContain('System');
      expect(await actionsFor(REMOVED)).toContain('STAFF_DENIED');
    });

    it('lets a teacher describing a case type a command word and keep their text', async () => {
      // The fall-through in D9, and the reason for it. Under the Apps Script
      // rule this teacher lost their case detail and was told they are not an
      // admin (AdminCommands.gs:409-417).
      await saveState(db, TEACHER, {
        kind: 'AwaitingCaseDetail',
        category: 'Visa',
        attempts: 0,
      });

      const outcome = await text('/whoami the boiler in my flat is broken', TEACHER);

      expect(firstText(outcome)).toMatch(/VISA-2026-/);
    });

    it('does not write a mid-case teacher’s words into the denial row', async () => {
      // R1 colliding with the fall-through. The denial is logged with the same
      // conversation state the message was logged with, so the stricter
      // redaction still wins — otherwise refusing a command becomes a second
      // route by which case detail reaches `messages`.
      await saveState(db, TEACHER, {
        kind: 'AwaitingCaseDetail',
        category: 'Visa',
        attempts: 0,
      });

      await text('/whoami the boiler in my flat is broken', TEACHER);

      const denials = await detailsFor(TEACHER, 'STAFF_DENIED');
      expect(denials).toHaveLength(1);
      expect(denials[0]).not.toContain('boiler');
    });

  });

  /**
   * The other half of the deny path: a real staff member whose rank is too low.
   *
   * Driven through `routeStaffCommand` with a registry of one, because the only
   * command this task builds is `/whoami`, which needs no capability. The
   * production registry is the default argument; passing one here is what lets
   * the branch be tested at the moment it is written rather than three tasks
   * later, when the first gated command arrives.
   */
  describe('a staff member whose rank is too low', () => {
    const gated: StaffCommand = {
      name: '/pretend',
      capability: CAPABILITY.MAINTENANCE,
      handle: async () => ({ messages: [], alerts: [] }),
    };

    const dispatch = (chatId: string, body: string): Promise<RouterOutcome | null> =>
      withChatLock(db, chatId, (tx) =>
        routeStaffCommand(tx, chatId, body, null, { supportContact: SUPPORT }, [gated]),
      );

    it('is told plainly, rather than being left to guess', async () => {
      // Unlike a stranger, they already know the command exists — silence here
      // would send a Lead's /maintenance to the teacher topic picker.
      const outcome = await dispatch(LEAD, '/pretend');

      expect(outcome).not.toBeNull();
      expect(outcome?.messages[0]?.text ?? '').toMatch(/System/);
    });

    it('leaves a denial with the caller’s shape', async () => {
      await dispatch(LEAD, '/pretend');

      expect(await actionsFor(LEAD)).toContain('STAFF_DENIED');
    });

    it('logs the command and its first argument only, never the rest', async () => {
      // D16. Staff have no conversation state, so the prefix rule is the only
      // thing standing between `/reply REF <the message>` and `messages`.
      await dispatch(LEAD, '/pretend VISA-2026-00001 and a great deal of free text');

      const denials = await detailsFor(LEAD, 'STAFF_DENIED');
      expect(denials).toEqual(['/pretend VISA-2026-00001']);
    });
  });

  describe('text that is not a staff command', () => {
    it('leaves an unknown command word to ordinary handling', async () => {
      // /closed is not a command this build has. A teacher who types it must
      // reach the same place any other sentence would.
      const outcome = await text('/closed the door on my flat', TEACHER);

      expect(firstText(outcome)).not.toMatch(/permission|not a command/i);
      expect(await actionsFor(TEACHER)).not.toContain('STAFF_DENIED');
    });

    it('leaves ordinary text alone', async () => {
      await text('how long does a visa take', LEAD);

      expect(await actionsFor(LEAD)).not.toContain('STAFF_DENIED');
    });
  });

  describe('/help', () => {
    it('shows a staff member the commands they may use', async () => {
      expect(firstText(await text('/help', LEAD))).toContain('/whoami');
    });

    it('never shows a teacher a command they cannot use', async () => {
      // Webhook.gs:249. A teacher offered /close is a teacher who will type it.
      const body = firstText(await text('/help', TEACHER));

      expect(body).not.toContain('/whoami');
      expect(body).toContain('/privacy');
    });

    it('shows a stranger the teacher help, not a hint that staff commands exist', async () => {
      expect(firstText(await text('/help', STRANGER))).not.toContain('/whoami');
    });
  });
});
