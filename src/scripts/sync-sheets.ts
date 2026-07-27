/**
 * Run the sheet sync now, from the command line.
 *
 * Used for the very first roster load, and to check a fix straight away rather
 * than waiting for the next ten-minute slot.
 *
 *   npm run sync                 # sync both tabs
 *   npm run sync -- --faq        # one tab only
 *   npm run sync -- --roster
 *   npm run sync -- --force      # allow a deliberate bulk removal
 *
 * --force exists for a genuine mass removal — end of a cohort, say. It is
 * recorded as an override on the sync run, because an override nobody can see
 * afterwards is the same as having no limit at all.
 */
import process from 'node:process';
import { closePool } from '../db/client.js';
import { getDb } from '../db/index.js';
import { log } from '../log.js';
import { createSheetReader } from '../sheets/client.js';
import { syncFaq, syncRoster, type SyncReport } from '../sync/sheets-sync.js';

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const force = args.has('--force');
  const onlyFaq = args.has('--faq');
  const onlyRoster = args.has('--roster');
  const doFaq = onlyFaq || !onlyRoster;
  const doRoster = onlyRoster || !onlyFaq;

  if (force) log.warn('--force given: the damage limit will be overridden and the override recorded');

  const db = getDb();
  const reader = createSheetReader();
  const reports: SyncReport[] = [];

  if (doFaq) reports.push(await syncFaq(db, reader, { force }));
  if (doRoster) reports.push(await syncRoster(db, reader, { force }));

  for (const report of reports) {
    log.info(
      {
        source: report.source,
        outcome: report.outcome,
        upserted: report.rowsUpserted,
        deactivated: report.rowsDeactivated,
        rejected: report.rejections.length,
      },
      report.message,
    );
    for (const rejection of report.rejections) {
      log.warn(`  ${report.source} row ${rejection.row}: ${rejection.reason}`);
    }
  }

  // Non-zero on anything other than a clean application, so a deployment script
  // or a cron wrapper notices without having to parse the output.
  const worst = reports.some((r) => r.outcome === 'failed')
    ? 1
    : reports.some((r) => r.outcome === 'refused')
      ? 2
      : 0;
  await closePool();
  process.exit(worst);
}

main().catch((err: unknown) => {
  log.fatal({ err }, 'sync command failed');
  process.exit(1);
});
