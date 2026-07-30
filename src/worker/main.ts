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
import { pathToFileURL } from 'node:url';
import { run, type RunnerOptions, type Task } from 'graphile-worker';
import { env } from '../config/env.js';
import { assertDatabaseReachable, closePool } from '../db/client.js';
import { log } from '../log.js';
import { ANNOUNCEMENT_TASK, announcementTask } from './tasks/announcements.js';
import { DIGEST_TASK, digestTask } from './tasks/digest.js';
import { HEARTBEAT_TASK, heartbeatTask } from './tasks/heartbeat.js';
import { RETENTION_TASK, retentionTask } from './tasks/retention.js';
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
  [RETENTION_TASK]: retentionTask,
  [DIGEST_TASK]: digestTask,
  [ANNOUNCEMENT_TASK]: announcementTask,
} satisfies Record<string, Task>;

/**
 * A time of day in Tashkent, as the crontab has to be written.
 *
 * **`graphile-worker` matches its crontab in UTC**, whatever the container says.
 * `digestTimestamp` in `node_modules/graphile-worker/dist/cron.js` reads
 * `getUTCHours()` and `getUTCMinutes()`; `docker-compose.yml` sets
 * `TZ: Asia/Tashkent` on both services, which changes `Date#getHours()`, the log
 * timestamps and every `AT TIME ZONE` reader — **and does not change cron
 * matching at all.** So the container's timezone setting makes this look handled
 * when it is not.
 *
 * Nothing has hit this because both original entries are intervals (`*​/10`,
 * `*​/5`), which are indifferent to the zone. The retention and digest jobs are
 * the first absolute-time jobs in this system, and a digest written the obvious
 * way as `0 7 * * *` arrives at noon — five hours after the working day starts,
 * silently, looking like nothing at all.
 *
 * Uzbekistan is UTC+5 all year and has no daylight saving, so a fixed offset is
 * safe here in a way it would not be in most places. That is written down so
 * nobody copies this pattern somewhere it breaks twice a year.
 *
 * There is a test asserting the arithmetic. A comment claiming it is not enough
 * — this is exactly the class of thing that is true when written and wrong later.
 */
export const TASHKENT_UTC_OFFSET_HOURS = 5;

export function tashkentCron(hour: number, minute = 0): string {
  const utcHour = (hour - TASHKENT_UTC_OFFSET_HOURS + 24) % 24;
  return `${minute} ${utcHour} * * *`;
}

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

# The nightly deletion pass, at 02:00 Tashkent — written in UTC, because
# graphile-worker matches on getUTCHours() and the container's TZ does not
# change that. See tashkentCron above; there is a test for the arithmetic.
# Two in the morning: after the day's cases are closed and long before anybody
# reads the report it may leave in the operations chat.
${tashkentCron(2)} ${RETENTION_TASK}

# The morning digest and the teacher chase, at 07:00 Tashkent. This is the
# number that must not be wrong and the reason D38 exists: written the obvious
# way as "0 7 * * *" it arrives at noon, five hours into the working day,
# silently, looking like nothing at all.
${tashkentCron(7)} ${DIGEST_TASK}

# The announcement sweeper. Every minute, one batch of 200, and return — the
# worker is concurrency 1, so a run that paced itself through 1,800 sends would
# starve the sync and the heartbeat above it (D42, R27). An interval, so the
# zone does not come into it.
#
# This is the only thing that sends an announcement, and there is deliberately
# no job to enqueue: that is what makes a restart mid-broadcast resume rather
# than repeat, and what keeps announcements out of job_runs as an on-demand row
# that would alarm every hour nobody sent one (D37, R22).
* * * * * ${ANNOUNCEMENT_TASK}
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

/**
 * Start only when this file *is* the process, never when it is imported.
 *
 * Without this guard, importing anything from here — `CRONTAB` and `taskList`
 * have always been exported — starts a second worker, connects it to the
 * database and races the real one for jobs. Nothing imported this file until the
 * crontab arithmetic needed asserting (D38), which is why it has never bitten:
 * the first `import { CRONTAB }` in a test spawned a runner that then called
 * `process.exit(1)` and took the test run with it.
 *
 * `process.argv[1]` is the script node was given; comparing it as a file URL is
 * what makes this work under both `node dist/worker/main.js` and the
 * `--experimental-strip-types` path the suite uses.
 */
const startedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (startedDirectly) {
  main().catch((err: unknown) => {
    log.fatal({ err }, 'worker process failed to start');
    process.exit(1);
  });
}
