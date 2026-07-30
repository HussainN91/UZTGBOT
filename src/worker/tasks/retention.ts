/**
 * The nightly deletion pass — Task 67, and the half of D29 that makes the
 * privacy notice true.
 *
 * **Composed here, not in a module** (D36). This is the only place that knows
 * both the periods and every table they govern: `purge.ts` holds the statements,
 * `pruneProcessedUpdates` lives beside `claimUpdate` in `telegram/dedup.ts`
 * because that is the other half of the same idea, and neither imports the
 * other. The job is above both, so the job composes both.
 *
 * **Nothing here invents a period.** Every function refuses to touch its table
 * when its period is `null`, and this job's job is to say so out loud — D30
 * predicts that state will be reported as a fault, because a working job that
 * deletes nothing and a broken job that deletes nothing look identical from
 * outside.
 */
import type { Task } from 'graphile-worker';
import { ANNOUNCEMENT_RECIPIENT_RETENTION_DAYS } from '../../config/constants.js';
import { retentionPeriods } from '../../config/settings.js';
import type { RetentionPeriods } from '../../config/retention.js';
import { getDb } from '../../db/index.js';
import type { Database } from '../../db/index.js';
import { log } from '../../log.js';
import {
  deleteOldMessages,
  deleteResolvedCases,
  pruneAnnouncementRecipients,
  pruneConversationStates,
  pruneUrgentCodeAttempts,
  scrubSyncRunRejections,
} from '../../retention/purge.js';
import type { Alerter } from '../../sync/alerts.js';
import { telegramAlerter } from '../../telegram/alerter.js';
import { createApi } from '../../telegram/bot.js';
import { pruneProcessedUpdates } from '../../telegram/dedup.js';
import { recordJobRun } from '../job-run.js';

export const RETENTION_TASK = 'retention';

/** Once a night. The heartbeat alarms at 1.5× this, so a stopped job is noticed. */
export const RETENTION_INTERVAL_SECONDS = 24 * 60 * 60;

/** What one table's pass did, or why it did not happen. */
interface PurgeLine {
  readonly table: string;
  readonly removed: number;
  readonly failed?: string;
}

export interface PurgeReport {
  readonly lines: readonly PurgeLine[];
  readonly periods: RetentionPeriods;
  readonly failures: number;
  readonly total: number;
}

/**
 * Run every pass, and let no one of them stop the others.
 *
 * **One `try` per table** (step 5). A lock held by a staff member closing a
 * case, or a period that PostgreSQL refuses to build an interval from, must
 * leave the other eleven tables done rather than skipped — the same argument
 * `Promise.allSettled` makes in the sheet sync, where one failing spreadsheet tab
 * must not stop the others.
 *
 * **Cases first.** They are the only pass that cascades (`case_notes` goes with
 * them), so doing it first means the later passes are not counting rows that are
 * about to disappear anyway.
 */
export async function runRetention(db: Database): Promise<PurgeReport> {
  const periods = await retentionPeriods(db);

  const passes: readonly { table: string; run: () => Promise<number> }[] = [
    { table: 'cases', run: () => deleteResolvedCases(db, periods) },
    { table: 'messages', run: () => deleteOldMessages(db, periods.messageDays) },
    { table: 'conversation_states', run: () => pruneConversationStates(db, periods.messageDays) },
    { table: 'urgent_code_attempts', run: () => pruneUrgentCodeAttempts(db, periods.messageDays) },
    { table: 'sync_runs.rejections', run: () => scrubSyncRunRejections(db, periods.messageDays) },
    /**
     * The pruner written in stage 2 with a test and no caller (R26). The table
     * has grown by one row per Telegram update since the day it was built.
     */
    { table: 'processed_updates', run: () => pruneProcessedUpdates(db) },
    {
      table: 'announcement_recipients',
      run: () => pruneAnnouncementRecipients(db, ANNOUNCEMENT_RECIPIENT_RETENTION_DAYS),
    },
  ];

  const lines: PurgeLine[] = [];
  for (const pass of passes) {
    try {
      lines.push({ table: pass.table, removed: await pass.run() });
    } catch (err) {
      const failed = err instanceof Error ? err.message : String(err);
      log.error({ err, table: pass.table }, 'a retention pass failed; the others still ran');
      lines.push({ table: pass.table, removed: 0, failed });
    }
  }

  return {
    lines,
    periods,
    failures: lines.filter((l) => l.failed !== undefined).length,
    total: lines.reduce((sum, l) => sum + l.removed, 0),
  };
}

/** The periods that are not set, named as a teacher would recognise them. */
function unsetPeriods(periods: RetentionPeriods): string[] {
  const missing: string[] = [];
  if (periods.caseDays === null) missing.push('CASE_RETENTION_DAYS');
  if (periods.urgentCaseDays === null) missing.push('URGENT_CASE_RETENTION_DAYS');
  if (periods.messageDays === null) missing.push('MESSAGE_RETENTION_DAYS');
  return missing;
}

/**
 * Tell the operations chat, but only when there is something worth saying.
 *
 * **A nightly "deleted 14 cases" alarm is an alarm people mute**, and a muted
 * channel is how the alarms that matter stop being read. So an ordinary night is
 * silent and goes to the log instead.
 *
 * Two things are said aloud. A failed pass, obviously. And the state D30 predicts
 * will be reported as a fault — **no period set, so nothing was deleted** —
 * repeated once a night until somebody sets one, because at launch that is
 * indistinguishable from a job that does not work, and the notice is meanwhile
 * telling teachers their data is kept until the Ministry decides.
 */
export async function reportRetention(alerter: Alerter, report: PurgeReport): Promise<void> {
  const missing = unsetPeriods(report.periods);
  const detail = report.lines
    .map((l) => (l.failed === undefined ? `• ${l.table}: ${l.removed}` : `• ${l.table}: FAILED — ${l.failed}`))
    .join('\n');

  if (report.failures > 0) {
    await alerter.send({
      severity: 'critical',
      title: 'The nightly deletion pass did not finish',
      body: [
        `${report.failures} of ${report.lines.length} passes failed. The others ran.`,
        '',
        detail,
        '',
        'Records that should have gone are still here, which means the privacy notice',
        'is currently promising something the system is not doing. It will try again',
        'tomorrow night; if it fails twice, somebody needs to look.',
      ].join('\n'),
    });
    return;
  }

  if (missing.length > 0) {
    await alerter.send({
      severity: 'warning',
      title: 'Nothing is being deleted, because no retention period is set',
      body: [
        `Not set: ${missing.join(', ')}.`,
        '',
        'The nightly job ran and deleted nothing of those classes. That is the safe',
        'behaviour and it is not a fault — but teachers are being told their records',
        'are kept until the Ministry sets a period, and that is what is happening.',
        '',
        'A System member sets them with /retention. This will be said again every',
        'night until they are.',
        '',
        detail,
      ].join('\n'),
    });
    return;
  }

  log.info(
    { total: report.total, lines: report.lines },
    'retention: nightly pass complete',
  );
}

export const retentionTask: Task = async () => {
  const db = getDb();
  const alerter = telegramAlerter(createApi());

  const report = await recordJobRun(db, RETENTION_TASK, RETENTION_INTERVAL_SECONDS, () =>
    runRetention(db),
  );

  await reportRetention(alerter, report);
};
