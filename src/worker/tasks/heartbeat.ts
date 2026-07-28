/**
 * The job that watches the other jobs.
 *
 * Runs every five minutes and alerts on anything that has not succeeded within
 * its expected interval. This is the piece that makes silence audible: a sync
 * that stopped being scheduled produces no error, so without something actively
 * looking for its absence there is nothing to notice.
 *
 * It does not watch itself. If the worker is down, nothing here runs — that gap
 * is covered from outside, by the container healthcheck and by the daily backup
 * reporting its own success into the same table.
 */
import type { Task } from 'graphile-worker';
import { checkStrandedUrgentCodes } from '../../cases/urgent.js';
import { getDb } from '../../db/index.js';
import { log } from '../../log.js';
import { telegramAlerter } from '../../telegram/alerter.js';
import { createApi } from '../../telegram/bot.js';
import { checkHeartbeats } from '../job-run.js';

export const HEARTBEAT_TASK = 'heartbeat';

export const heartbeatTask: Task = async () => {
  const db = getDb();
  const alerter = telegramAlerter(createApi());

  const stale = await checkHeartbeats(db, alerter);
  if (stale.length === 0) log.debug('heartbeat: all scheduled jobs are current');

  /**
   * Also watch for a spent urgent code that bought no case.
   *
   * It belongs here rather than in its own job because it is the same kind of
   * problem: a failure that raises no error and produces no symptom anybody will
   * report. It should always find nothing — see `checkStrandedUrgentCodes`.
   */
  await checkStrandedUrgentCodes(db, alerter);
};
