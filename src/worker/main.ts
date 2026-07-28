/**
 * The worker process: everything slow, and everything that happens without
 * anyone asking.
 *
 * Announcements, the daily digest, the spreadsheet sync and record clean-up all
 * run here so none of them can delay a teacher waiting for a reply. The job
 * queue lives in PostgreSQL alongside the records — no second piece of
 * infrastructure to run, back up or lose.
 *
 * Stage 1 starts the runner with a single proof-of-life task. The real jobs
 * arrive in stages 2 and 5.
 */
import { run, type RunnerOptions, type Task } from 'graphile-worker';
import { env } from '../config/env.js';
import { assertDatabaseReachable, closePool } from '../db/client.js';
import { log } from '../log.js';
import { HEARTBEAT_TASK, heartbeatTask } from './tasks/heartbeat.js';
import { SYNC_SHEETS_TASK, syncSheetsTask } from './tasks/sync-sheets.js';

/**
 * Job definitions live in their own schema so `pg_dump` of the application
 * schema stays readable, and so a queue reset never risks application data.
 */
export const WORKER_SCHEMA = 'graphile_worker';

const ping: Task = async (_payload, helpers) => {
  helpers.logger.info('worker ping');
};

export const taskList = {
  ping,
  [SYNC_SHEETS_TASK]: syncSheetsTask,
  [HEARTBEAT_TASK]: heartbeatTask,
} satisfies Record<string, Task>;

/**
 * The schedule.
 *
 * graphile-worker reads this in crontab form and, crucially, will not run a job
 * twice for the same slot even across restarts — so a deploy in the middle of a
 * scheduled minute does not double-run it.
 *
 * `?` fills the minute and hour from a hash of the job name where it does not
 * matter exactly when a job runs. Here it does matter, so both are explicit.
 */
export const CRONTAB = `
# Copy the FAQ bank and the teacher roster out of the spreadsheet. Ten minutes
# is the promise made to staff: an edited answer reaches teachers within ten
# minutes, rather than the up-to-six-hours the Apps Script cache allowed.
*/10 * * * * ${SYNC_SHEETS_TASK}

# Watch the other jobs. A job that fails is noisy and will be noticed; a job
# that stops being scheduled at all is silent, and silence is what this
# detects. Five minutes so a stopped ten-minute job is reported promptly
# without the check itself becoming the noisiest thing in the logs.
*/5 * * * * ${HEARTBEAT_TASK}
`.trim();

async function main(): Promise<void> {
  const settings = env();
  await assertDatabaseReachable();

  const options: RunnerOptions = {
    connectionString: settings.DATABASE_URL,
    schema: WORKER_SCHEMA,
    /**
     * One at a time, deliberately.
     *
     * The only heavy moment in this system is a single announcement burst, and
     * that is paced by Telegram's rate limit rather than by how many jobs run at
     * once. Concurrency here would buy nothing and would make the ordering of
     * an announcement's per-recipient rows harder to reason about.
     */
    concurrency: 1,
    // We install our own handlers below so the pool closes cleanly.
    noHandleSignals: true,
    pollInterval: 2_000,
    taskList,
    crontab: CRONTAB,
  };

  const runner = await run(options);
  log.info({ schema: WORKER_SCHEMA }, 'worker process running');

  const stop = (signal: string) => {
    log.info({ signal }, 'shutting down worker');
    runner
      .stop()
      .then(() => closePool())
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        log.error({ err }, 'worker shutdown failed');
        process.exit(1);
      });
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  await runner.promise;
}

main().catch((err: unknown) => {
  log.fatal({ err }, 'worker process failed to start');
  process.exit(1);
});
