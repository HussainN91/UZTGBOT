/**
 * Recording that a scheduled job ran, and noticing when one stops.
 *
 * "Nobody notices when something breaks" is on the concerns list because errors
 * went to a log nobody opened. The subtler half of that problem is a job that
 * stops running altogether: it produces no error at all, so there is nothing to
 * miss. A sync that silently stopped six weeks ago looks exactly like a sync
 * with nothing to do.
 *
 * Every scheduled job records its outcome here, and a job that misses its slot
 * raises an alert. That is what turns silence into an alarm instead of an
 * assumption.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { jobRuns } from '../db/schema.js';
import { log } from '../log.js';
import type { Alerter } from '../sync/alerts.js';

/**
 * Run a job, recording the attempt and its outcome.
 *
 * Rethrows on failure so graphile-worker still sees the job as failed and
 * retries it — this records history, it does not swallow errors.
 */
export async function recordJobRun<T>(
  db: Database,
  jobName: string,
  expectedIntervalSeconds: number,
  fn: () => Promise<T>,
): Promise<T> {
  await db
    .insert(jobRuns)
    .values({ jobName, expectedIntervalSeconds, lastStartedAt: new Date() })
    .onConflictDoUpdate({
      target: jobRuns.jobName,
      // The expected interval is refreshed from the code on every run, so
      // changing a schedule cannot leave a stale threshold alerting forever.
      set: { lastStartedAt: new Date(), expectedIntervalSeconds },
    });

  try {
    const result = await fn();
    await db
      .update(jobRuns)
      .set({ lastSuccessAt: new Date(), consecutiveFailures: 0, lastError: null, alertedAt: null })
      .where(sql`job_name = ${jobName}`);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(jobRuns)
      .set({
        lastFailureAt: new Date(),
        lastError: message.slice(0, 2000),
        consecutiveFailures: sql`${jobRuns.consecutiveFailures} + 1`,
      })
      .where(sql`job_name = ${jobName}`);
    throw err;
  }
}

/**
 * How long past its expected interval a job may go before it is treated as
 * stopped.
 *
 * Some slack, so a job that runs every ten minutes and is briefly slow does not
 * alarm. Half again is enough to absorb a restart without hiding a real stall.
 */
const GRACE_MULTIPLIER = 1.5;

/** Do not repeat the same alarm more often than this while a job stays down. */
const REALERT_AFTER_SECONDS = 3600;

export interface StaleJob {
  readonly jobName: string;
  readonly lastSuccessAt: Date | null;
  readonly expectedIntervalSeconds: number;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
}

/**
 * Alert on every job that has not succeeded within its expected interval.
 *
 * Deliberately driven by last *success*, not by last failure. A job that throws
 * is noisy and will be noticed; a job that stopped being scheduled at all is
 * silent, and silence is what this exists to detect.
 */
export async function checkHeartbeats(db: Database, alerter: Alerter): Promise<StaleJob[]> {
  const result = await db.execute<{
    job_name: string;
    last_success_at: Date | null;
    expected_interval_seconds: number;
    consecutive_failures: number;
    last_error: string | null;
  }>(sql`
    SELECT job_name, last_success_at, expected_interval_seconds, consecutive_failures, last_error
    FROM job_runs
    WHERE (
      last_success_at IS NULL
      OR last_success_at < now() - make_interval(secs => expected_interval_seconds * ${GRACE_MULTIPLIER})
    )
    AND (alerted_at IS NULL OR alerted_at < now() - make_interval(secs => ${REALERT_AFTER_SECONDS}))
  `);

  const stale: StaleJob[] = result.rows.map((r) => ({
    jobName: r.job_name,
    lastSuccessAt: r.last_success_at,
    expectedIntervalSeconds: r.expected_interval_seconds,
    consecutiveFailures: r.consecutive_failures,
    lastError: r.last_error,
  }));

  for (const job of stale) {
    const since = job.lastSuccessAt ? job.lastSuccessAt.toISOString() : 'never — it has not succeeded once';
    await alerter.send({
      severity: 'critical',
      title: `Scheduled job "${job.jobName}" has stopped`,
      body: [
        `Expected to succeed every ${job.expectedIntervalSeconds} seconds.`,
        `Last success: ${since}.`,
        job.consecutiveFailures > 0
          ? `${job.consecutiveFailures} consecutive failures. Last error: ${job.lastError ?? 'unknown'}`
          : 'No failures recorded — it is not being scheduled at all, rather than failing.',
        '',
        'Check the worker: docker compose logs worker',
      ].join('\n'),
    });
    log.error({ jobName: job.jobName }, 'scheduled job has stopped running');
  }

  if (stale.length > 0) {
    await db
      .update(jobRuns)
      .set({ alertedAt: new Date() })
      .where(sql`job_name = ANY(${stale.map((j) => j.jobName)})`);
  }

  return stale;
}
