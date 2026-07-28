/**
 * The scheduled sync.
 *
 * Every ten minutes, so an edit to an FAQ answer reaches teachers within ten
 * minutes instead of the up-to-six-hours the Apps Script cache allowed.
 *
 * The roster and the FAQ are synced independently on purpose: a problem with one
 * tab must not stop the other. A refused roster sync should never mean the FAQ
 * stops updating too.
 */
import type { Task } from 'graphile-worker';
import { getDb } from '../../db/index.js';
import { log } from '../../log.js';
import { createSheetReader } from '../../sheets/client.js';
import { syncFaq, syncRoster, type SyncReport } from '../../sync/sheets-sync.js';
import { telegramAlerter } from '../../telegram/alerter.js';
import { createApi } from '../../telegram/bot.js';

export const SYNC_SHEETS_TASK = 'sync_sheets';

export const syncSheetsTask: Task = async () => {
  const db = getDb();
  const reader = createSheetReader();
  // A refused sync and a rejected FAQ row both need a person to act. Until this
  // was wired up, both were written to a log and reached nobody.
  const alerter = telegramAlerter(createApi());

  // Settled, not all: one failing sync must not prevent the other from running,
  // and both record their own outcome regardless.
  const [faq, roster] = await Promise.allSettled([
    syncFaq(db, reader, { alerter }),
    syncRoster(db, reader, { alerter }),
  ]);

  const outcomes = [describe('FAQ', faq), describe('ROSTER', roster)];
  log.info({ outcomes }, 'scheduled sheet sync finished');

  /**
   * Throwing marks the job failed so graphile-worker retries it and the
   * heartbeat sees a failure — but only for an unexpected error. A sync that was
   * *refused* by the damage limit did its job correctly: it already alerted, and
   * retrying it every few seconds would just repeat the alarm.
   */
  const crashed = [faq, roster].filter((r) => r.status === 'rejected');
  if (crashed.length > 0) {
    throw new AggregateError(
      crashed.map((r) => (r as PromiseRejectedResult).reason),
      'one or more sheet syncs threw unexpectedly',
    );
  }
};

function describe(source: string, result: PromiseSettledResult<SyncReport>): string {
  if (result.status === 'rejected') return `${source}: threw — ${String(result.reason)}`;
  return `${source}: ${result.value.outcome} (${result.value.message})`;
}
