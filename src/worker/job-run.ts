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
import { inArray, sql } from 'drizzle-orm';
import { TIMEZONE } from '../config/constants.js';
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
  /**
   * Already formatted, in Tashkent, and a string rather than a `Date`.
   *
   * Two reasons, and the second one is a fault this shape prevents. It is read
   * by a person on the operations chat, for whom a UTC instant is five hours
   * wrong and needs converting in their head at the moment they are least
   * inclined to. And `db.execute` returns a timestamp as the raw string
   * PostgreSQL sent — drizzle installs its own type parsers, so unlike
   * `pool.query` it does not hand back a `Date`. This field was typed as one and
   * had `.toISOString()` called on it, which throws.
   *
   * The path that throws is the one where a job succeeded once and then stopped,
   * which is the commonest real failure and the entire reason this function
   * exists. The alarm for silence was itself silent.
   */
  readonly lastSuccessAt: string | null;
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
 *
 * On the `::float8` cast in the grace period: without it PostgreSQL infers the
 * parameter's type from `expected_interval_seconds`, which is an integer column,
 * and then refuses 1.5 as invalid input for an integer. The statement threw on
 * every call, so this function had never once completed — the alarm for silence
 * was itself silent, and nothing was watching it because it is the thing that
 * watches. Found the first time it was pointed at a real database.
 */
export async function checkHeartbeats(db: Database, alerter: Alerter): Promise<StaleJob[]> {
  const result = await db.execute<{
    job_name: string;
    last_success_at: string | null;
    expected_interval_seconds: number;
    consecutive_failures: number;
    last_error: string | null;
  }>(sql`
    SELECT job_name,
           to_char(last_success_at AT TIME ZONE ${TIMEZONE}, 'YYYY-MM-DD HH24:MI') AS last_success_at,
           expected_interval_seconds, consecutive_failures, last_error
    FROM job_runs
    WHERE (
      last_success_at IS NULL
      -- The ::float8 cast is load-bearing; see the note above this function.
      OR last_success_at
         < now() - make_interval(secs => expected_interval_seconds) * ${GRACE_MULTIPLIER}::float8
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
    const since = job.lastSuccessAt ?? 'never — it has not succeeded once';
    await alerter.send({
      severity: 'critical',
      title: `Scheduled job "${job.jobName}" has stopped`,
      body: [
        `Expected to succeed every ${job.expectedIntervalSeconds} seconds.`,
        `Last success (Tashkent time): ${since}.`,
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
    /**
     * `inArray`, not `ANY(${array})`. Interpolating a JavaScript array into raw
     * SQL binds it as one parameter, and PostgreSQL then reads the value as an
     * array literal and rejects it — so marking the alarm as sent threw, which
     * would have re-alerted on every pass and buried the operations chat. It was
     * never reached, because the query above it never completed either.
     */
    await db
      .update(jobRuns)
      .set({ alertedAt: new Date() })
      .where(inArray(jobRuns.jobName, stale.map((j) => j.jobName)));
  }

  return stale;
}
