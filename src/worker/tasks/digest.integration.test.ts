/**
 * Seven in the morning — Task 68.
 *
 * The wording has its own pure tests; what is proved here is the job. Three
 * properties matter more than the rest:
 *
 *   **Somebody with nothing gets nothing** (D39). A daily message saying
 *   "nothing to do" is a daily message people filter, and then they filter the
 *   one that matters.
 *
 *   **The chase reaches the teacher, not the staff member** (D26, D40). A case
 *   at `Action required` is waiting on the teacher, and the person holding it is
 *   correctly doing nothing.
 *
 *   **One unreachable recipient costs nobody else their message.** `trySend`
 *   throughout, and a failed chase does not advance the case's clock.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { TEACHER_CHASE_MAX } from '../../config/constants.js';
import { clearSettingsCache, setSetting } from '../../config/settings.js';
import type { Database } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import type { Alert, Alerter } from '../../sync/alerts.js';
import type { TelegramLookup } from '../../staff/repository.js';
import { CRONTAB } from '../main.js';
import { tashkentCron } from '../main.js';
import { DIGEST_TASK, type DigestSender, runDigest, verifyPublishedHandles } from './digest.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const OWNER = '993001';
const OTHER_STAFF = '993002';
const OBSERVER = '993003';

const TEACHER = '993101';

/** Every message the job tried to send, and whether it was allowed to succeed. */
const recordingSender = (
  blocked: readonly string[] = [],
): { sender: DigestSender; sent: { chatId: string; text: string }[] } => {
  const sent: { chatId: string; text: string }[] = [];
  return {
    sent,
    sender: {
      send: async (chatId, text) => {
        if (blocked.includes(chatId)) return false;
        sent.push({ chatId, text });
        return true;
      },
    },
  };
};

const collectingAlerter = (): { alerter: Alerter; alerts: Alert[] } => {
  const alerts: Alert[] = [];
  return { alerts, alerter: { send: async (alert: Alert) => void alerts.push(alert) } };
};

const noTelegram: TelegramLookup = {
  getChat: async () => {
    throw new Error('not called');
  },
};

describe('the digest is scheduled for the morning, not for noon', () => {
  it('runs at 07:00 Tashkent', () => {
    // D38, R23. Both original crontab entries are intervals, which are
    // indifferent to the zone; this is the first absolute-time job in the
    // system and the whole reason the mapping is asserted rather than commented.
    expect(CRONTAB).toContain(`${tashkentCron(7)} ${DIGEST_TASK}`);
    expect(tashkentCron(7)).toBe('0 2 * * *');
  });
});

describe.skipIf(!TEST_DATABASE_URL)('the morning digest job', () => {
  let pool: pg.Pool;
  let db: Database;

  const openCase = async (
    reference: string,
    over: {
      owner?: string | null;
      status?: string;
      dueDaysAgo?: number;
      updatedDaysAgo?: number;
      chaseCount?: number;
      chasedDaysAgo?: number | null;
      publicUpdate?: string;
    } = {},
  ): Promise<void> => {
    await db.execute(sql`
      INSERT INTO cases (reference, teacher_chat_id, category, status, detail, public_update,
                         owner, due_at, updated_at, teacher_chase_count, teacher_chased_at)
      VALUES (
        ${reference}, ${TEACHER}, 'Visa', ${over.status ?? 'Under review'}::case_status,
        'the teacher wrote this', ${over.publicUpdate ?? ''},
        ${over.owner === undefined ? OWNER : over.owner},
        ${over.dueDaysAgo === undefined ? null : sql`now() - make_interval(days => ${over.dueDaysAgo})`},
        ${over.updatedDaysAgo === undefined ? sql`now()` : sql`now() - make_interval(days => ${over.updatedDaysAgo})`},
        ${over.chaseCount ?? 0},
        ${over.chasedDaysAgo === undefined || over.chasedDaysAgo === null ? null : sql`now() - make_interval(days => ${over.chasedDaysAgo})`}
      )
    `);
  };

  const chaseCountOf = async (reference: string): Promise<number> => {
    const rows = await db.execute<{ n: number }>(
      sql`SELECT teacher_chase_count AS n FROM cases WHERE reference = ${reference}`,
    );
    return Number(rows.rows[0]?.n ?? -1);
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
        (${OWNER},       'Case Owner',  'Support',  'All', ARRAY[]::text[], true),
        (${OTHER_STAFF}, 'Colleague',   'Support',  'All', ARRAY[]::text[], true),
        (${OBSERVER},    'New Starter', 'Observer', 'All', ARRAY[]::text[], true)
    `);
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active)
      VALUES ('t@example.com', 'A Teacher', 'Tashkent', true)
    `);
    await db.execute(sql`
      INSERT INTO teachers (chat_id, identifier, name, region, verification_state)
      VALUES (${TEACHER}, 't@example.com', 'A Teacher', 'Tashkent', 'Verified')
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('the staff digest', () => {
    it('sends one message to somebody with a case past its promised date', async () => {
      await openCase('VISA-2026-00001', { dueDaysAgo: 2 });
      const { sender, sent } = recordingSender();
      const { alerter } = collectingAlerter();

      const report = await runDigest(db, sender, noTelegram, alerter);

      expect(report.digestsSent).toBe(1);
      expect(sent.filter((m) => m.chatId === OWNER)).toHaveLength(1);
      expect(sent[0]?.text).toContain('VISA-2026-00001');
    });

    it('sends nothing to somebody with nothing', async () => {
      // D39, and the point rather than an edge case.
      const { sender, sent } = recordingSender();
      const { alerter } = collectingAlerter();

      const report = await runDigest(db, sender, noTelegram, alerter);

      expect(sent).toHaveLength(0);
      expect(report.digestsSent).toBe(0);
      expect(report.digestsSkipped).toBeGreaterThan(0);
    });

    it('never sends to an Observer', async () => {
      /**
       * R14. Somebody who cannot reply, close or take a case is being paged
       * about work they are not permitted to do — the same filter new-case
       * notification applies, reusing the capability rather than the visibility
       * rule so the two cannot drift.
       */
      await openCase('VISA-2026-00001', { owner: null });
      const { sender, sent } = recordingSender();
      const { alerter } = collectingAlerter();

      await runDigest(db, sender, noTelegram, alerter);

      expect(sent.map((m) => m.chatId)).not.toContain(OBSERVER);
    });

    it('separates a promise somebody missed from a case nobody has touched', async () => {
      // Two different ideas of "late" that must never be merged: `casesPastDue`
      // is a promise made and missed, `staleCases` is nobody having touched it.
      await setSetting(db, 'OVERDUE_DAYS', '5');
      await openCase('VISA-2026-00001', { dueDaysAgo: 2 });
      await openCase('VISA-2026-00002', { updatedDaysAgo: 30, owner: OTHER_STAFF });

      const { sender, sent } = recordingSender();
      const { alerter } = collectingAlerter();
      await runDigest(db, sender, noTelegram, alerter);

      const ownersDigest = sent.find((m) => m.chatId === OWNER)?.text ?? '';
      expect(ownersDigest).toContain('Past the date you promised');
      expect(ownersDigest).toContain('Nobody has touched these');
    });

    it('does not stop the run when one staff member cannot be reached', async () => {
      // A staff member who has never opened a chat with the bot must not cost
      // everybody else their digest.
      await openCase('VISA-2026-00001', { dueDaysAgo: 2, owner: null });
      const { sender, sent } = recordingSender([OWNER]);
      const { alerter } = collectingAlerter();

      const report = await runDigest(db, sender, noTelegram, alerter);

      expect(report.undeliverable).toBe(1);
      expect(sent.map((m) => m.chatId)).toContain(OTHER_STAFF);
    });
  });

  describe('chasing the teacher', () => {
    it('messages the teacher, not the staff member holding the case', async () => {
      /**
       * D26 and D40, and the thing most worth getting wrong here. The queries
       * already decide who to message; this job must not re-derive it.
       */
      await openCase('VISA-2026-00001', {
        status: 'Action required',
        publicUpdate: 'please send a photograph of your passport page',
      });
      const { sender, sent } = recordingSender();
      const { alerter } = collectingAlerter();

      const report = await runDigest(db, sender, noTelegram, alerter);

      expect(report.teachersChased).toBe(1);
      expect(sent.find((m) => m.chatId === TEACHER)?.text).toContain(
        'photograph of your passport page',
      );

      /**
       * The owner gets **nothing at all**, which is stronger than "not the chase
       * text" and is the actual point of D26: a case at `Action required` is
       * waiting on the teacher, so the person holding it is correctly doing
       * nothing and has no reason to hear from the bot this morning. A digest
       * that nagged them about it is one they learn to ignore, which costs the
       * cases that genuinely are theirs.
       */
      expect(sent.map((m) => m.chatId)).not.toContain(OWNER);
    });

    it('advances the counter, so three reminders are three and not thirty', async () => {
      await openCase('VISA-2026-00001', { status: 'Action required', publicUpdate: 'send it' });
      const { sender } = recordingSender();
      const { alerter } = collectingAlerter();

      await runDigest(db, sender, noTelegram, alerter);

      expect(await chaseCountOf('VISA-2026-00001')).toBe(1);
    });

    it('does not advance the clock when the reminder could not be delivered', async () => {
      // R29. A skipped chase means nothing happened, so the case comes back
      // tomorrow rather than burning one of its three reminders on a send that
      // never arrived.
      await openCase('VISA-2026-00001', { status: 'Action required', publicUpdate: 'send it' });
      const { sender } = recordingSender([TEACHER]);
      const { alerter } = collectingAlerter();

      await runDigest(db, sender, noTelegram, alerter);

      expect(await chaseCountOf('VISA-2026-00001')).toBe(0);
    });

    it('tells the owner once when the reminders run out, and then stops', async () => {
      /**
       * The end of D40's cap, and the only thing in this system that has ever
       * produced this signal. Three unanswered reminders is a teacher who has
       * left, changed number, or given up — the situation
       * `/close <ref> unresolved <reason>` was built for.
       */
      await openCase('VISA-2026-00001', {
        status: 'Action required',
        chaseCount: TEACHER_CHASE_MAX,
        publicUpdate: 'send it',
      });

      const first = recordingSender();
      const { alerter } = collectingAlerter();
      const report = await runDigest(db, first.sender, noTelegram, alerter);

      expect(report.ownersTold).toBe(1);
      expect(first.sent.find((m) => m.chatId === OWNER)?.text).toContain('has not answered');
      expect(first.sent.map((m) => m.chatId)).not.toContain(TEACHER);

      const second = recordingSender();
      const again = await runDigest(db, second.sender, noTelegram, alerter);
      expect(again.ownersTold).toBe(0);
    });

    it('does not chase a teacher who cannot receive anything', async () => {
      // R29. A revoked teacher at `Action required` is a case to close
      // unresolved, not a case to chase.
      await openCase('VISA-2026-00001', { status: 'Action required', publicUpdate: 'send it' });
      await db.execute(sql`UPDATE teachers SET verification_state = 'Revoked', revoked_at = now() WHERE chat_id = ${TEACHER}`);

      const { sender, sent } = recordingSender();
      const { alerter } = collectingAlerter();
      await runDigest(db, sender, noTelegram, alerter);

      expect(sent.map((m) => m.chatId)).not.toContain(TEACHER);
    });

    it('does not chase a case that is snoozed', async () => {
      await openCase('VISA-2026-00001', { status: 'Action required', publicUpdate: 'send it' });
      await db.execute(sql`UPDATE cases SET snoozed_until = now() + make_interval(days => 7) WHERE reference = 'VISA-2026-00001'`);

      const { sender, sent } = recordingSender();
      const { alerter } = collectingAlerter();
      await runDigest(db, sender, noTelegram, alerter);

      expect(sent.map((m) => m.chatId)).not.toContain(TEACHER);
    });
  });

  describe('re-checking the published handles', () => {
    const lookup = (handles: Readonly<Record<string, string>>): TelegramLookup => ({
      getChat: async (handle: string) => {
        const id = handles[handle];
        if (id === undefined) throw new Error('Bad Request: chat not found');
        return { id };
      },
    });

    it('leaves a handle that still resolves to its owner', async () => {
      await db.execute(sql`UPDATE staff SET telegram_username = 'karimova' WHERE telegram_id = ${OWNER}`);
      const { sender } = recordingSender();
      const { alerter, alerts } = collectingAlerter();

      const cleared = await verifyPublishedHandles(db, lookup({ '@karimova': OWNER }), sender, alerter);

      expect(cleared).toBe(0);
      expect(alerts).toHaveLength(0);
    });

    it('unpublishes one that now belongs to somebody else, and tells both', async () => {
      /**
       * R33, the slow failure. A released handle is wrong for months, silently,
       * and it degrades towards the ministry's bot pointing teachers at a
       * stranger rather than towards nothing happening.
       */
      await db.execute(sql`UPDATE staff SET telegram_username = 'karimova' WHERE telegram_id = ${OWNER}`);
      const { sender, sent } = recordingSender();
      const { alerter, alerts } = collectingAlerter();

      const cleared = await verifyPublishedHandles(db, lookup({ '@karimova': '999999' }), sender, alerter);

      expect(cleared).toBe(1);
      expect(sent.find((m) => m.chatId === OWNER)?.text).toContain('no longer yours');
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.title).toMatch(/stopped matching/i);

      const rows = await db.execute<{ u: string | null }>(
        sql`SELECT telegram_username AS u FROM staff WHERE telegram_id = ${OWNER}`,
      );
      expect(rows.rows[0]?.u).toBeNull();
    });

    it('leaves the column alone when Telegram cannot be reached at all', async () => {
      /**
       * "Chat not found" and an outage are indistinguishable from here, and only
       * one of them is a reason to unpublish. Clearing on an outage would take
       * the feature away from everybody for the duration of it.
       */
      await db.execute(sql`UPDATE staff SET telegram_username = 'karimova' WHERE telegram_id = ${OWNER}`);
      const { sender } = recordingSender();
      const { alerter, alerts } = collectingAlerter();

      const cleared = await verifyPublishedHandles(db, lookup({}), sender, alerter);

      expect(cleared).toBe(0);
      expect(alerts).toHaveLength(0);

      const rows = await db.execute<{ u: string | null }>(
        sql`SELECT telegram_username AS u FROM staff WHERE telegram_id = ${OWNER}`,
      );
      expect(rows.rows[0]?.u).toBe('karimova');
    });
  });
});
