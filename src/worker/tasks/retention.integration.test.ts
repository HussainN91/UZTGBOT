/**
 * The nightly deletion pass — Task 67.
 *
 * The purge statements have their own tests; what is proved here is the *job*:
 * that an unset period deletes nothing and says so, that one failing table does
 * not skip the other six, and that the crontab entry means two in the morning in
 * Tashkent rather than two in the morning somewhere else.
 *
 * That last one is D38, and it is the only thing in this stage that fails
 * silently and looks like nothing at all.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { clearSettingsCache, setSetting } from '../../config/settings.js';
import type { Database } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import type { Alert, Alerter } from '../../sync/alerts.js';
import { CRONTAB, TASHKENT_UTC_OFFSET_HOURS, tashkentCron } from '../main.js';
import { RETENTION_TASK, reportRetention, runRetention } from './retention.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const TEACHER = '994101';

const collectingAlerter = (): { alerter: Alerter; sent: Alert[] } => {
  const sent: Alert[] = [];
  return {
    sent,
    alerter: {
      send: async (alert: Alert) => {
        sent.push(alert);
      },
    },
  };
};

/**
 * The crontab arithmetic, asserted rather than commented — D38, R23.
 *
 * These need no database, so they run whether or not one is up. That is
 * deliberate: this is the assertion most worth never skipping.
 */
describe('the crontab is UTC, whatever the container says', () => {
  it('turns 07:00 Tashkent into 02:00 UTC', () => {
    // The number that must not be wrong, and the reason the whole of D38 exists.
    // Written the obvious way as `0 7 * * *`, the digest arrives at noon.
    expect(tashkentCron(7)).toBe('0 2 * * *');
  });

  it('turns 02:00 Tashkent into 21:00 UTC, the day before', () => {
    // The wrap is where a hand-written entry goes wrong: 2 − 5 is negative.
    expect(tashkentCron(2)).toBe('0 21 * * *');
  });

  it('wraps at both ends rather than producing an impossible hour', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const utcHour = Number(tashkentCron(hour).split(' ')[1]);
      expect(utcHour).toBeGreaterThanOrEqual(0);
      expect(utcHour).toBeLessThan(24);
      expect((utcHour + TASHKENT_UTC_OFFSET_HOURS) % 24).toBe(hour);
    }
  });

  it('schedules the retention job through it rather than by hand', () => {
    // A crontab line written out literally is one that stops agreeing with the
    // function the moment somebody changes the hour.
    expect(CRONTAB).toContain(`${tashkentCron(2)} ${RETENTION_TASK}`);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('the nightly retention job', () => {
  let pool: pg.Pool;
  let db: Database;

  const closedCase = async (reference: string, daysAgo: number, importance = 'Normal'): Promise<void> => {
    await db.execute(sql`
      INSERT INTO cases (reference, teacher_chat_id, category, status, importance, detail, closed_at)
      VALUES (${reference}, ${TEACHER}, 'Visa', 'Completed', ${importance}::case_importance,
              'something', now() - make_interval(days => ${daysAgo}))
    `);
  };

  const caseExists = async (reference: string): Promise<boolean> => {
    const rows = await db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM cases WHERE reference = ${reference}`,
    );
    return Number(rows.rows[0]?.n) > 0;
  };

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`
      TRUNCATE cases, case_notes, teachers, roster_entries, case_sequences,
               conversation_states, messages, faq_entries, urgent_codes,
               urgent_code_attempts, processed_updates, settings, staff,
               audit_log, announcements, announcement_recipients, sync_runs CASCADE
    `);
    clearSettingsCache();

    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active)
      VALUES ('r@example.com', 'A Teacher', 'Tashkent', true)
    `);
    await db.execute(sql`
      INSERT INTO teachers (chat_id, identifier, name, region, verification_state)
      VALUES (${TEACHER}, 'r@example.com', 'A Teacher', 'Tashkent', 'Verified')
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('deletes nothing at all when no period is set', async () => {
    /**
     * D30, and the state the system is in between the deploy and the runbook's
     * settings insert. Every pass runs and every pass touches nothing.
     */
    await closedCase('VISA-2026-00001', 400);
    await db.execute(sql`INSERT INTO messages (chat_id, action, detail) VALUES (${TEACHER}, 'MESSAGE', 'x')`);

    const report = await runRetention(db);

    expect(report.total).toBe(0);
    expect(report.failures).toBe(0);
    expect(await caseExists('VISA-2026-00001')).toBe(true);
  });

  it('says out loud that nothing is being deleted, because that looks like a fault', async () => {
    /**
     * The one thing D30 requires be said aloud. At launch a working job that
     * deletes nothing is indistinguishable from a broken one, and meanwhile the
     * notice is telling teachers their records are kept until the Ministry
     * decides — which is true, and is not what anybody intends after the deploy.
     */
    const { alerter, sent } = collectingAlerter();

    await reportRetention(alerter, await runRetention(db));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.severity).toBe('warning');
    expect(sent[0]?.title).toMatch(/nothing is being deleted/i);
    expect(sent[0]?.body).toContain('CASE_RETENTION_DAYS');
    expect(sent[0]?.body).toContain('/retention');
  });

  it('names only the periods that are actually missing', async () => {
    await setSetting(db, 'CASE_RETENTION_DAYS', '7');
    await setSetting(db, 'URGENT_CASE_RETENTION_DAYS', '180');
    const { alerter, sent } = collectingAlerter();

    await reportRetention(alerter, await runRetention(db));

    expect(sent[0]?.body).toContain('MESSAGE_RETENTION_DAYS');
    expect(sent[0]?.body).not.toContain('CASE_RETENTION_DAYS,');
  });

  it('deletes on the periods that are set, and reports the counts', async () => {
    await setSetting(db, 'CASE_RETENTION_DAYS', '7');
    await setSetting(db, 'URGENT_CASE_RETENTION_DAYS', '180');
    await setSetting(db, 'MESSAGE_RETENTION_DAYS', '3');

    await closedCase('VISA-2026-00001', 30);
    await closedCase('VISA-2026-00002', 2);

    const report = await runRetention(db);

    expect(await caseExists('VISA-2026-00001')).toBe(false);
    expect(await caseExists('VISA-2026-00002')).toBe(true);
    expect(report.lines.find((l) => l.table === 'cases')?.removed).toBe(1);
  });

  it('reads importance and never status', async () => {
    // D22, R13. A `Critical` case that was resolved is `Completed`, and nothing
    // about `Completed` remembers it was ever an emergency.
    await setSetting(db, 'CASE_RETENTION_DAYS', '7');
    await setSetting(db, 'URGENT_CASE_RETENTION_DAYS', '180');

    await closedCase('SUPPORT-2026-00003', 30, 'Critical');
    await closedCase('SUPPORT-2026-00004', 30, 'Normal');

    await runRetention(db);

    expect(await caseExists('SUPPORT-2026-00003')).toBe(true);
    expect(await caseExists('SUPPORT-2026-00004')).toBe(false);
  });

  it('calls the pruner that has had a test and no caller since stage 2', async () => {
    // R26. `processed_updates` has grown by one row per Telegram update since
    // the day it was built, and this job is its first caller.
    await db.execute(sql`
      INSERT INTO processed_updates (update_id, at) VALUES ('1', now() - make_interval(hours => 48))
    `);

    const report = await runRetention(db);

    expect(report.lines.find((l) => l.table === 'processed_updates')?.removed).toBe(1);
  });

  it('runs every pass even when one of them fails', async () => {
    /**
     * Step 5, and the same argument `Promise.allSettled` makes in the sheet
     * sync. A lock or a bad value against one table must leave the others done
     * rather than skipped.
     *
     * The failure is provoked by dropping the table the third pass reads, which
     * is the bluntest possible way to make exactly one statement throw.
     */
    await setSetting(db, 'MESSAGE_RETENTION_DAYS', '3');
    await db.execute(sql`INSERT INTO processed_updates (update_id, at) VALUES ('1', now() - make_interval(hours => 48))`);
    await db.execute(sql`ALTER TABLE conversation_states RENAME TO conversation_states_moved`);

    try {
      const report = await runRetention(db);

      expect(report.failures).toBe(1);
      expect(report.lines.find((l) => l.table === 'conversation_states')?.failed).toBeDefined();
      // The pass after the failing one still ran.
      expect(report.lines.find((l) => l.table === 'processed_updates')?.removed).toBe(1);
    } finally {
      await db.execute(sql`ALTER TABLE conversation_states_moved RENAME TO conversation_states`);
    }
  });

  it('raises a critical alarm for a failed pass, and not the unset-period warning', async () => {
    await setSetting(db, 'CASE_RETENTION_DAYS', '7');
    await setSetting(db, 'URGENT_CASE_RETENTION_DAYS', '180');
    // The pass only touches the table when its period is set — without this it
    // returns 0 without querying, and the rename below provokes nothing.
    await setSetting(db, 'MESSAGE_RETENTION_DAYS', '3');
    await db.execute(sql`ALTER TABLE conversation_states RENAME TO conversation_states_moved`);

    try {
      const { alerter, sent } = collectingAlerter();
      await reportRetention(alerter, await runRetention(db));

      expect(sent).toHaveLength(1);
      expect(sent[0]?.severity).toBe('critical');
      expect(sent[0]?.title).toMatch(/did not finish/i);
    } finally {
      await db.execute(sql`ALTER TABLE conversation_states_moved RENAME TO conversation_states`);
    }
  });

  it('says nothing at all on an ordinary night', async () => {
    // A nightly "deleted 14 cases" alarm is an alarm people mute, and a muted
    // channel is how the alarms that matter stop being read.
    await setSetting(db, 'CASE_RETENTION_DAYS', '7');
    await setSetting(db, 'URGENT_CASE_RETENTION_DAYS', '180');
    await setSetting(db, 'MESSAGE_RETENTION_DAYS', '3');
    await closedCase('VISA-2026-00001', 30);

    const { alerter, sent } = collectingAlerter();
    await reportRetention(alerter, await runRetention(db));

    expect(sent).toHaveLength(0);
  });
});
