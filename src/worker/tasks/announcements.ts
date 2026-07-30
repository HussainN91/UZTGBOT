/**
 * The announcement sweeper — Task 69, and D41 and D42.
 *
 * This is the only thing that sends an announcement. **There is deliberately no
 * job to enqueue** (D37): `/announce_send` marks a row `Queued` and returns, and
 * this scheduled sweeper picks it up. Two things follow from that, and both are
 * the reason it is built this way rather than as a fan-out job.
 *
 *   A restart mid-broadcast **resumes** rather than repeating, by construction.
 *   Every recipient is a row with a state, so there is no separate recovery
 *   path — the ordinary path already is one.
 *
 *   Announcements stay out of `job_runs` as an *on-demand* row. `checkHeartbeats`
 *   alarms on any job whose last success is older than 1.5× its interval, so an
 *   on-demand announcement job would raise a critical alarm on the operations
 *   chat **every hour in which nobody sent an announcement** — which is most
 *   hours (R22). A scheduled sweeper runs every minute and succeeds every minute,
 *   including when there is nothing to do.
 *
 * **One batch per run, and then return** (D42). No pacing loop and no sleeping.
 * The worker is `concurrency: 1`, and a run that worked its way through 1,800
 * sends would hold the only slot for minutes — during which the ten-minute sync
 * and the five-minute heartbeat do not run, and the first symptom is a *false*
 * alarm that the sheet sync has stopped, raised late by the heartbeat that was
 * itself starved (R27). At 200 a run, 1,800 teachers take about nine minutes.
 *
 * Composed here rather than in a module (D36): `store.ts` holds the statements,
 * `send.ts` speaks to Telegram, `format.ts` writes the words, and this is the
 * only place that knows all three.
 */
import type { Task } from 'graphile-worker';
import type { Api } from 'grammy';
import {
  type AnnouncementRow,
  claimBatch,
  finishIfDone,
  markRecipient,
  nextSendable,
  resetStalledRecipients,
  returnForRetry,
  tally,
} from '../../announcements/store.js';
import { ANNOUNCEMENT_BATCH } from '../../config/constants.js';
import { getDb } from '../../db/index.js';
import type { Database } from '../../db/index.js';
import { announcementMessage, announcementReport } from '../../digest/format.js';
import { log } from '../../log.js';
import { findTeacher, teacherHasAccess } from '../../teachers/repository.js';
import { createApi } from '../../telegram/bot.js';
import { type SendResult, isRetryable, trySend } from '../../telegram/send.js';
import { recordJobRun } from '../job-run.js';

export const ANNOUNCEMENT_TASK = 'announcements';

/**
 * Every minute, and the heartbeat alarms at 1.5× this.
 *
 * A sweeper that stops running is a broadcast that stops half-way with nobody
 * told — the sender saw "queued" and has no reason to look again.
 */
export const ANNOUNCEMENT_INTERVAL_SECONDS = 60;

/**
 * How long a recipient may sit claimed before it is assumed the run that claimed
 * it died.
 *
 * Deliberately far longer than any healthy run. `resetStalledRecipients` measures
 * from the *announcement's* start rather than from the claim — there is no
 * per-recipient claim timestamp and this stage adds no further migration — so a
 * window short enough to be prompt would eventually return recipients that a
 * slow-but-living run is still working through, and message those teachers
 * twice. An hour against a nine-minute broadcast is the margin that makes that
 * impossible in practice, and the cost of the caution is that a broadcast
 * orphaned by a crash takes up to an hour to resume rather than a minute.
 *
 * It is only ever reached when there is nothing left to claim — see `runSweep`.
 * A duplicate message to 1,800 people is the one failure a broadcast must not
 * have; a late one is merely late.
 */
const STALLED_AFTER_MINUTES = 60;

/** What one sender does. Narrowed so the sweep can be driven with no network. */
export interface AnnouncementSender {
  send(chatId: string, text: string): Promise<SendResult>;
}

export const telegramAnnouncementSender = (api: Api): AnnouncementSender => ({
  send: (chatId, text) => trySend(api, chatId, text),
});

export interface SweepReport {
  /** `null` when there was nothing queued, which is most minutes of most days. */
  readonly announcementId: string | null;
  readonly claimed: number;
  readonly sent: number;
  readonly skipped: number;
  readonly failed: number;
  readonly retrying: number;
  readonly stalledReturned: number;
  readonly finished: boolean;
}

const IDLE: SweepReport = {
  announcementId: null,
  claimed: 0,
  sent: 0,
  skipped: 0,
  failed: 0,
  retrying: 0,
  stalledReturned: 0,
  finished: false,
};

/**
 * Work one batch of one announcement, then stop.
 *
 * Sequential, not `Promise.all`. Telegram's limit is on the rate of sends and a
 * burst of 200 concurrent requests is the fastest way to meet it; the sequence
 * also means the rate-limit break below actually stops something.
 */
async function deliver(
  db: Database,
  row: AnnouncementRow,
  recipients: readonly string[],
  sender: AnnouncementSender,
): Promise<{ sent: number; skipped: number; failed: number; retrying: number }> {
  const text = announcementMessage(row.content);

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let retrying = 0;

  for (const [index, chatId] of recipients.entries()) {
    /**
     * Re-checked at send time, every time (D41).
     *
     * The audience was frozen when the draft was written, which is what makes
     * the count the sender approved the count that receives it — and a draft can
     * sit for a day. Messaging somebody whose access was revoked this morning is
     * the frozen list being wrong in the other direction.
     *
     * `teacherHasAccess` is asked rather than re-expressed. It is the single
     * answer to "may this person use the bot", and a broadcast is the largest
     * possible way to get it wrong.
     */
    if (!teacherHasAccess(await findTeacher(db, chatId))) {
      await markRecipient(db, row.id, chatId, 'Skipped', 'no longer has access to the bot');
      skipped += 1;
      continue;
    }

    const result = await sender.send(chatId, text);

    if (result.ok) {
      await markRecipient(db, row.id, chatId, 'Sent');
      sent += 1;
      continue;
    }

    /**
     * **`isRetryable` is the only thing that decides retry versus write-off.**
     * A rate limit or a Telegram outage is not a teacher who cannot be reached,
     * and writing one off would drop them from a ministry-wide message silently.
     * A block is permanent and is `Failed` with the reason recorded.
     */
    if (!isRetryable(result.failure)) {
      await markRecipient(db, row.id, chatId, 'Failed', result.failure.description);
      failed += 1;
      continue;
    }

    await returnForRetry(db, row.id, chatId, result.failure.description);
    retrying += 1;

    /**
     * Stop the batch on a rate limit, and hand the rest back unspent.
     *
     * Telegram has just said we are going too fast; sending the remaining
     * recipients earns a longer limit and delivers none of them. They are still
     * `Sending` from the claim, so they are returned explicitly — the next
     * sweep is a minute away and the whole design is that a late batch costs
     * nothing.
     */
    if (result.failure.kind === 'rate_limited') {
      for (const remaining of recipients.slice(index + 1)) {
        await returnForRetry(db, row.id, remaining, 'not attempted — rate limited earlier in the batch');
        retrying += 1;
      }
      break;
    }
  }

  return { sent, skipped, failed, retrying };
}

export async function runSweep(db: Database, sender: AnnouncementSender): Promise<SweepReport> {
  /**
   * One indexed read, and return. Most minutes there is nothing queued, and this
   * runs sixty times an hour for ever — it has to be cheap when idle or it is a
   * cost with no benefit.
   */
  const row = await nextSendable(db);
  if (row === null) return IDLE;

  const recipients = await claimBatch(db, row.id, ANNOUNCEMENT_BATCH);
  const counts = await deliver(db, row, recipients, sender);

  /**
   * Only when there was nothing to claim.
   *
   * If this run claimed work, another run's rows may still be in flight and
   * returning them would message those teachers twice. Nothing claimable and an
   * unfinished announcement is the shape of a run that died mid-batch, and it is
   * the only shape in which un-sticking is the right answer.
   */
  const stalledReturned =
    recipients.length === 0 ? await resetStalledRecipients(db, STALLED_AFTER_MINUTES) : 0;

  /**
   * Conditional on nothing being left, inside the statement, so a sweep that
   * raced another cannot close a send that still has recipients — and so this
   * fires exactly once however many sweeps see the last batch.
   *
   * **A broadcast with nobody in it finishes here.** `claimBatch` moves a
   * `Queued` row to `Sending` whether or not it claimed anybody, and this then
   * closes it. Left at `Queued` it would be picked up every minute for ever and
   * mentioned by nothing — invisible rather than loud, which is worse.
   */
  const finished = await finishIfDone(db, row.id);

  if (finished) {
    /**
     * Read the totals back rather than reporting this run's counts: a broadcast
     * spans nine runs and the sender wants the whole of it, not the last two
     * hundred.
     *
     * Best effort, and deliberately after the row is already `Sent`. A sender who
     * has blocked the bot must not leave the announcement looking unfinished for
     * ever.
     */
    const totals = await tally(db, row.id);
    const report = announcementReport({
      sent: totals.sent,
      skipped: totals.skipped,
      failed: totals.failed,
      total: totals.total,
    });

    const delivered = await sender.send(row.createdBy, report);
    if (!delivered.ok) {
      log.warn(
        { announcementId: row.id, createdBy: row.createdBy, failure: delivered.failure },
        'an announcement finished but its sender could not be told',
      );
    }
  }

  return {
    announcementId: row.id,
    claimed: recipients.length,
    ...counts,
    stalledReturned,
    finished,
  };
}

export const announcementTask: Task = async () => {
  const db = getDb();
  const sender = telegramAnnouncementSender(createApi());

  const report = await recordJobRun(db, ANNOUNCEMENT_TASK, ANNOUNCEMENT_INTERVAL_SECONDS, () =>
    runSweep(db, sender),
  );

  /**
   * Silent when idle. This runs every minute of every day, and a log line each
   * time saying nothing happened is how the lines that matter stop being read.
   */
  if (report.announcementId !== null) {
    log.info({ ...report }, 'announcements: swept a batch');
  }
};
