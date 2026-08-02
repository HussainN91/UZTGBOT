/**
 * Run the sheet sync now, from the command line.
 *
 * Used for the very first roster load, and to check a fix straight away rather
 * than waiting for the next ten-minute slot.
 *
 *   npm run sync                 # sync all three tabs
 *   npm run sync -- --faq        # one tab only
 *   npm run sync -- --roster
 *   npm run sync -- --forms
 *   npm run sync -- --force      # allow a deliberate bulk removal
 *
 * --force exists for a genuine mass removal — end of a cohort, say. It is
 * recorded as an override on the sync run, because an override nobody can see
 * afterwards is the same as having no limit at all.
 *
 * **FORMS was missing from this command until 2 August 2026**, and the scheduled
 * worker had always synced it. So forms did arrive, within ten minutes — but the
 * manual first-load command the deploy guide points at skipped them, which is
 * exactly the moment somebody is standing there watching and concluding the
 * feature does not work. A command that syncs "everything" has to mean it.
 */
import process from 'node:process';
import { closePool } from '../db/client.js';
import { getDb } from '../db/index.js';
import { log } from '../log.js';
import { createSheetReader } from '../sheets/client.js';
import { syncFaq, syncForms, syncRoster, type SyncReport } from '../sync/sheets-sync.js';

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const force = args.has('--force');

  /**
   * Any tab named runs only the tabs named; no tab named runs all of them.
   *
   * Written this way rather than as a chain of `onlyX || !onlyY` pairs, which is
   * what it was — that shape works for two tabs and quietly stops working at
   * three, because `!onlyRoster` is true when `--forms` was given.
   */
  const named = ['--faq', '--roster', '--forms'].filter((flag) => args.has(flag));
  const wanted = (flag: string): boolean => named.length === 0 || named.includes(flag);

  if (force) log.warn('--force given: the damage limit will be overridden and the override recorded');

  const db = getDb();
  const reader = createSheetReader();
  const reports: SyncReport[] = [];

  if (wanted('--faq')) reports.push(await syncFaq(db, reader, { force }));
  if (wanted('--roster')) reports.push(await syncRoster(db, reader, { force }));
  if (wanted('--forms')) reports.push(await syncForms(db, reader, { force }));

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
