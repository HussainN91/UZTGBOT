/**
 * Copying the FAQ bank and the teacher roster out of the spreadsheet.
 *
 * One direction only. The spreadsheet owns these two things because they are
 * exactly the two things staff actually edit — and, conveniently, exactly the
 * two the bot never writes to, so the two copies can never disagree about which
 * is correct.
 *
 * A run either applies completely or changes nothing. Both the upserts and the
 * deactivations happen in one transaction, so a sync that trips the damage limit
 * leaves the previous good data exactly as it was, and the next run recovers on
 * its own once the sheet is fixed.
 */
import { and, eq, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { faqEntries, rosterEntries, syncRuns } from '../db/schema.js';
import { log } from '../log.js';
import { assessDamage, type DamageLimitOptions } from '../sheets/damage-limit.js';
import { SHEET_TABS, type SheetReader } from '../sheets/client.js';
import { HeaderMismatchError, parseFaqTab, parseRosterTab, type Rejection } from '../sheets/parse.js';
import { loggingAlerter, neverThrows, type Alerter } from './alerts.js';

export type SyncSource = 'FAQ' | 'ROSTER';

export type SyncOutcome = 'applied' | 'refused' | 'failed';

export interface SyncReport {
  readonly source: SyncSource;
  readonly outcome: SyncOutcome;
  readonly rowsSeen: number;
  readonly rowsUpserted: number;
  readonly rowsDeactivated: number;
  readonly rejections: readonly Rejection[];
  readonly message: string;
}

export interface SyncOptions extends DamageLimitOptions {
  readonly alerter?: Alerter;
}

/** Postgres caps parameters per statement; chunking keeps well clear of it. */
const CHUNK = 400;

function chunked<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Thrown to roll the transaction back when the damage limit refuses a run. */
class DamageLimitExceeded extends Error {
  constructor(
    readonly wouldDeactivate: number,
    readonly activeBefore: number,
    message: string,
  ) {
    super(message);
    this.name = 'DamageLimitExceeded';
  }
}

export async function syncFaq(
  db: Database,
  reader: SheetReader,
  options: SyncOptions = {},
): Promise<SyncReport> {
  return runSync(db, 'FAQ', options, async () => {
    const raw = await reader.readTab(SHEET_TABS.FAQ);
    const { rows, rejections } = parseFaqTab(raw);
    return {
      rejections,
      rowsSeen: Math.max(raw.length - 1, 0),
      apply: async (tx: Database, runStart: Date) => {
        const activeBefore = await countActive(tx, 'faq_entries');
        for (const batch of chunked(rows)) {
          await tx
            .insert(faqEntries)
            .values(
              batch.map((r) => ({
                code: r.code,
                sheetRow: r.sheetRow,
                topicCode: r.topicCode,
                buttonText: r.buttonText,
                keywords: [...r.keywords],
                officialAnswer: r.officialAnswer,
                language: r.language,
                active: r.active,
                lastApprovedBy: r.lastApprovedBy,
                lastApprovedDate: r.lastApprovedDate,
                syncedAt: runStart,
              })),
            )
            .onConflictDoUpdate({
              target: faqEntries.code,
              set: {
                sheetRow: sql`excluded.sheet_row`,
                topicCode: sql`excluded.topic_code`,
                buttonText: sql`excluded.button_text`,
                keywords: sql`excluded.keywords`,
                officialAnswer: sql`excluded.official_answer`,
                language: sql`excluded.language`,
                active: sql`excluded.active`,
                lastApprovedBy: sql`excluded.last_approved_by`,
                lastApprovedDate: sql`excluded.last_approved_date`,
                syncedAt: sql`excluded.synced_at`,
              },
            });
        }
        return { activeBefore, upserted: rows.length };
      },
      deactivate: async (tx: Database, runStart: Date) => {
        const result = await tx
          .update(faqEntries)
          .set({ active: false })
          .where(and(eq(faqEntries.active, true), lt(faqEntries.syncedAt, runStart)));
        return result.rowCount ?? 0;
      },
      countStale: async (tx: Database, runStart: Date) =>
        countWhere(tx, 'faq_entries', sql`active = true AND synced_at < ${runStart}`),
    };
  });
}

export async function syncRoster(
  db: Database,
  reader: SheetReader,
  options: SyncOptions = {},
): Promise<SyncReport> {
  return runSync(db, 'ROSTER', options, async () => {
    const raw = await reader.readTab(SHEET_TABS.ROSTER);
    const { rows, rejections } = parseRosterTab(raw);
    return {
      rejections,
      rowsSeen: Math.max(raw.length - 1, 0),
      apply: async (tx: Database, runStart: Date) => {
        const activeBefore = await countActive(tx, 'roster_entries');
        for (const batch of chunked(rows)) {
          await tx
            .insert(rosterEntries)
            .values(
              batch.map((r) => ({
                identifier: r.identifier,
                name: r.name,
                region: r.region,
                active: true,
                syncedAt: runStart,
              })),
            )
            .onConflictDoUpdate({
              target: rosterEntries.identifier,
              set: {
                name: sql`excluded.name`,
                region: sql`excluded.region`,
                // A teacher reappearing in the sheet is reinstated, which is how
                // an accidental deletion is undone by simply pasting the row back.
                active: sql`excluded.active`,
                syncedAt: sql`excluded.synced_at`,
              },
            });
        }
        return { activeBefore, upserted: rows.length };
      },
      deactivate: async (tx: Database, runStart: Date) => {
        const result = await tx
          .update(rosterEntries)
          .set({ active: false })
          .where(and(eq(rosterEntries.active, true), lt(rosterEntries.syncedAt, runStart)));
        return result.rowCount ?? 0;
      },
      countStale: async (tx: Database, runStart: Date) =>
        countWhere(tx, 'roster_entries', sql`active = true AND synced_at < ${runStart}`),
    };
  });
}

interface SyncPlan {
  readonly rejections: readonly Rejection[];
  readonly rowsSeen: number;
  apply(tx: Database, runStart: Date): Promise<{ activeBefore: number; upserted: number }>;
  deactivate(tx: Database, runStart: Date): Promise<number>;
  countStale(tx: Database, runStart: Date): Promise<number>;
}

async function runSync(
  db: Database,
  source: SyncSource,
  options: SyncOptions,
  build: () => Promise<SyncPlan>,
): Promise<SyncReport> {
  const alerter = neverThrows(options.alerter ?? loggingAlerter);
  const runStart = new Date();
  let upserted = 0;
  let deactivated = 0;
  let rowsSeen = 0;
  let rejections: readonly Rejection[] = [];

  try {
    const plan = await build();
    rejections = plan.rejections;
    rowsSeen = plan.rowsSeen;

    await db.transaction(async (tx) => {
      const applied = await plan.apply(tx as Database, runStart);
      upserted = applied.upserted;

      /**
       * Count what would be switched off BEFORE switching anything off, then
       * throw to roll back if it is too much. The upserts are rolled back with
       * it, which is what makes "nothing was changed" literally true rather than
       * approximately true.
       */
      const wouldDeactivate = await plan.countStale(tx as Database, runStart);
      const assessment = assessDamage(applied.activeBefore, wouldDeactivate, options);
      if (!assessment.allowed) {
        throw new DamageLimitExceeded(wouldDeactivate, applied.activeBefore, assessment.reason);
      }
      if (assessment.reason.startsWith('OVERRIDDEN')) {
        log.warn({ source, reason: assessment.reason }, 'damage limit overridden');
      }
      deactivated = await plan.deactivate(tx as Database, runStart);
    });

    const message =
      `${source}: ${upserted} rows up to date, ${deactivated} deactivated` +
      (rejections.length > 0 ? `, ${rejections.length} rejected` : '');
    await record(db, source, 'applied', runStart, { rowsSeen, upserted, deactivated, rejections, message });
    log.info({ source, upserted, deactivated, rejected: rejections.length }, 'sync applied');

    if (rejections.length > 0) await reportRejections(alerter, source, rejections);
    return { source, outcome: 'applied', rowsSeen, rowsUpserted: upserted, rowsDeactivated: deactivated, rejections, message };
  } catch (err) {
    if (err instanceof DamageLimitExceeded) {
      await record(db, source, 'refused', runStart, {
        rowsSeen,
        upserted: 0,
        deactivated: 0,
        rejections,
        message: err.message,
      });
      log.error({ source, wouldDeactivate: err.wouldDeactivate }, 'sync refused by damage limit');
      await alerter.send({ severity: 'critical', title: `${source} sync refused`, body: err.message });
      return { source, outcome: 'refused', rowsSeen, rowsUpserted: 0, rowsDeactivated: 0, rejections, message: err.message };
    }

    const message =
      err instanceof HeaderMismatchError
        ? err.message
        : `${source} sync failed: ${err instanceof Error ? err.message : String(err)}`;
    await record(db, source, 'failed', runStart, { rowsSeen, upserted: 0, deactivated: 0, rejections, message });
    log.error({ source, err }, 'sync failed');
    await alerter.send({ severity: 'critical', title: `${source} sync failed`, body: message });
    return { source, outcome: 'failed', rowsSeen, rowsUpserted: 0, rowsDeactivated: 0, rejections, message };
  }
}

/**
 * Rejections go to a person, not only to a log.
 *
 * Whoever owns the FAQ content is the one who can fix a misspelled topic, and
 * they will never see a server log. The message names the row and the fix.
 */
async function reportRejections(
  alerter: Alerter,
  source: SyncSource,
  rejections: readonly Rejection[],
): Promise<void> {
  const shown = rejections.slice(0, 10);
  const body = [
    `${rejections.length} row(s) in the ${source} tab could not be used. Everything else synced normally.`,
    '',
    ...shown.map((r) => `Row ${r.row}: ${r.reason}`),
    ...(rejections.length > shown.length ? [`…and ${rejections.length - shown.length} more.`] : []),
  ].join('\n');
  await alerter.send({ severity: 'warning', title: `${source} rows rejected`, body });
}

async function record(
  db: Database,
  source: SyncSource,
  outcome: SyncOutcome,
  startedAt: Date,
  data: {
    rowsSeen: number;
    upserted: number;
    deactivated: number;
    rejections: readonly Rejection[];
    message: string;
  },
): Promise<void> {
  try {
    await db.insert(syncRuns).values({
      source,
      startedAt,
      finishedAt: new Date(),
      outcome,
      rowsSeen: data.rowsSeen,
      rowsUpserted: data.upserted,
      rowsDeactivated: data.deactivated,
      rowsRejected: data.rejections.length,
      rejections: data.rejections,
      message: data.message,
    });
  } catch (err) {
    // Recording the run must never be the reason a good sync reports failure.
    log.error({ err, source }, 'could not record the sync run');
  }
}

async function countActive(tx: Database, table: 'faq_entries' | 'roster_entries'): Promise<number> {
  return countWhere(tx, table, sql`active = true`);
}

async function countWhere(
  tx: Database,
  table: 'faq_entries' | 'roster_entries',
  predicate: ReturnType<typeof sql>,
): Promise<number> {
  const identifier = table === 'faq_entries' ? sql`faq_entries` : sql`roster_entries`;
  const result = await tx.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM ${identifier} WHERE ${predicate}`,
  );
  const first = result.rows[0];
  return first ? Number.parseInt(first.count, 10) : 0;
}
