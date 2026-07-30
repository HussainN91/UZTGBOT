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
import { syncFormResponses } from '../../sync/form-responses.js';
import { syncFaq, syncForms, syncRoster, type SyncReport } from '../../sync/sheets-sync.js';
import { telegramAlerter } from '../../telegram/alerter.js';
import { createApi } from '../../telegram/bot.js';
import { recordJobRun } from '../job-run.js';

export const SYNC_SHEETS_TASK = 'sync_sheets';

/**
 * Ten minutes, matching the schedule. If a run has not succeeded within half
 * again that, the heartbeat says so.
 */
export const SYNC_SHEETS_INTERVAL_SECONDS = 600;

export const syncSheetsTask: Task = async () =>
  recordJobRun(getDb(), SYNC_SHEETS_TASK, SYNC_SHEETS_INTERVAL_SECONDS, runSync);

async function runSync(): Promise<void> {
  const db = getDb();
  const reader = createSheetReader();
  // A refused sync and a rejected FAQ row both need a person to act. Until this
  // was wired up, both were written to a log and reached nobody.
  const alerter = telegramAlerter(createApi());

  // Settled, not all: one failing sync must not prevent the others from running,
  // and each records its own outcome regardless.
  const [faq, roster, forms] = await Promise.allSettled([
    syncFaq(db, reader, { alerter }),
    syncRoster(db, reader, { alerter }),
    syncForms(db, reader, { alerter }),
  ]);

  /**
   * The responses run AFTER the links, and sequentially rather than beside them.
   *
   * It reads `form_links` to learn which tabs to open, so running it in the same
   * batch would have it working from the previous cycle's list — and on a fresh
   * deployment, from no list at all. Ten minutes late for one cycle is nothing;
   * a form published this morning whose submissions are ignored until somebody
   * notices is not.
   *
   * ⚠️ This is the part of the sync whose cost grows. It opens one tab per form
   * with a responses tab, so ten forms is ten more round trips to Google inside
   * a worker that runs `concurrency: 1`. A long run starves the five-minute
   * heartbeat, and the first symptom is a FALSE alarm that the sheet sync has
   * stopped. If the form count grows, this is the thing to move to its own
   * schedule.
   */
  const responses = await syncFormResponses(db, reader, { alerter }).then(
    (r) => ({ status: 'fulfilled' as const, value: r }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  );

  const outcomes = [
    describe('FAQ', faq),
    describe('ROSTER', roster),
    describe('FORMS', forms),
    responses.status === 'rejected'
      ? `FORM_RESPONSES: threw — ${String(responses.reason)}`
      : `FORM_RESPONSES: ${responses.value.outcome} (${responses.value.message})`,
  ];
  log.info({ outcomes }, 'scheduled sheet sync finished');

  /**
   * Throwing marks the job failed so graphile-worker retries it and the
   * heartbeat sees a failure — but only for an unexpected error. A sync that was
   * *refused* by the damage limit did its job correctly: it already alerted, and
   * retrying it every few seconds would just repeat the alarm.
   */
  const crashed = [faq, roster, forms, responses].filter((r) => r.status === 'rejected');
  if (crashed.length > 0) {
    throw new AggregateError(
      crashed.map((r) => (r as { reason: unknown }).reason),
      'one or more sheet syncs threw unexpectedly',
    );
  }
};

function describe(source: string, result: PromiseSettledResult<SyncReport>): string {
  if (result.status === 'rejected') return `${source}: threw — ${String(result.reason)}`;
  return `${source}: ${result.value.outcome} (${result.value.message})`;
}
