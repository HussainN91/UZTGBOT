/**
 * Integration tests for job heartbeats.
 *
 * These exist because the alarm was broken and nothing said so. `checkHeartbeats`
 * selected `last_success_at` through `db.execute`, which returns the raw string
 * PostgreSQL sent rather than a `Date` — drizzle installs its own type parsers —
 * and then called `.toISOString()` on it.
 *
 * The branch that threw is the one where a job succeeded at least once and then
 * stopped, which is the commonest real failure and the whole reason the module
 * exists. A job that had never succeeded alerted correctly, so the shape of the
 * bug was "the alarm works in the test you would write first and not in the case
 * you built it for".
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import type { Alert, Alerter } from '../sync/alerts.js';
import { checkHeartbeats, recordJobRun } from './job-run.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const JOB = 'test-job';
const EVERY_TEN_MINUTES = 600;

function collectingAlerter(): Alerter & { readonly sent: Alert[] } {
  const sent: Alert[] = [];
  return {
    sent,
    async send(alert: Alert): Promise<void> {
      sent.push(alert);
    },
  };
}

describe.skipIf(!TEST_DATABASE_URL)('job heartbeats', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`TRUNCATE job_runs CASCADE`);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('says nothing about a job that is running on time', async () => {
    await recordJobRun(db, JOB, EVERY_TEN_MINUTES, async () => undefined);

    const alerter = collectingAlerter();
    expect(await checkHeartbeats(db, alerter)).toHaveLength(0);
    expect(alerter.sent).toHaveLength(0);
  });

  it('alerts on a job that succeeded once and then stopped', async () => {
    /**
     * The case the bug was in. A job that ran, worked, and then stopped being
     * scheduled produces no error of its own — this alarm is the only thing that
     * would ever mention it, and it was throwing before it could.
     */
    await recordJobRun(db, JOB, EVERY_TEN_MINUTES, async () => undefined);
    await db.execute(
      sql`UPDATE job_runs SET last_success_at = now() - interval '2 hours' WHERE job_name = ${JOB}`,
    );

    const alerter = collectingAlerter();
    const stale = await checkHeartbeats(db, alerter);

    expect(stale).toHaveLength(1);
    expect(alerter.sent).toHaveLength(1);
    expect(alerter.sent[0]?.title).toContain(JOB);
    // The formatted local time reached the message, rather than "[object Object]"
    // or an exception on the way there.
    expect(alerter.sent[0]?.body).toMatch(/Last success \(Tashkent time\): \d{4}-\d{2}-\d{2} \d{2}:\d{2}\./);
  });

  it('alerts on a job that has never succeeded', async () => {
    await db.execute(sql`
      INSERT INTO job_runs (job_name, expected_interval_seconds, last_started_at)
      VALUES (${JOB}, ${EVERY_TEN_MINUTES}, now())
    `);

    const alerter = collectingAlerter();
    expect(await checkHeartbeats(db, alerter)).toHaveLength(1);
    expect(alerter.sent[0]?.body).toContain('never');
  });

  it('does not repeat the same alarm on every pass', async () => {
    // Otherwise a job that stays down floods the operations chat every five
    // minutes, and the next real alarm arrives in a wall of noise.
    await db.execute(sql`
      INSERT INTO job_runs (job_name, expected_interval_seconds, last_started_at)
      VALUES (${JOB}, ${EVERY_TEN_MINUTES}, now())
    `);

    const alerter = collectingAlerter();
    await checkHeartbeats(db, alerter);
    await checkHeartbeats(db, alerter);
    expect(alerter.sent).toHaveLength(1);
  });

  it('records a failure and rethrows, so the worker still retries', async () => {
    await expect(
      recordJobRun(db, JOB, EVERY_TEN_MINUTES, async () => {
        throw new Error('the sheet was unreachable');
      }),
    ).rejects.toThrow('the sheet was unreachable');

    const rows = await db.execute<{ consecutive_failures: number; last_error: string }>(
      sql`SELECT consecutive_failures, last_error FROM job_runs WHERE job_name = ${JOB}`,
    );
    expect(rows.rows[0]?.consecutive_failures).toBe(1);
    expect(rows.rows[0]?.last_error).toContain('unreachable');
  });

  it('clears the failure count once the job works again', async () => {
    await expect(
      recordJobRun(db, JOB, EVERY_TEN_MINUTES, async () => {
        throw new Error('transient');
      }),
    ).rejects.toThrow();
    await recordJobRun(db, JOB, EVERY_TEN_MINUTES, async () => undefined);

    const rows = await db.execute<{ consecutive_failures: number; last_error: string | null }>(
      sql`SELECT consecutive_failures, last_error FROM job_runs WHERE job_name = ${JOB}`,
    );
    expect(rows.rows[0]?.consecutive_failures).toBe(0);
    expect(rows.rows[0]?.last_error).toBeNull();
  });
});
