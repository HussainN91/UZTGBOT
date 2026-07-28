/**
 * Integration tests for the sync, against a real PostgreSQL.
 *
 * The behaviour that matters most here cannot be tested without a database: a
 * refused sync must leave the previous data *exactly* as it was, which depends
 * on the upserts and the deactivations sharing one transaction. A mock would
 * confirm the code calls rollback, not that rollback actually undoes the writes.
 *
 * Skips itself when TEST_DATABASE_URL is unset so the pure-logic suite still
 * runs anywhere. A skipped test is not a passing test:
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 *
 * The schema is applied once by src/test/global-setup.ts, not here — see the
 * note there about why migrating per file raced.
 */
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import type { Alert, Alerter } from './alerts.js';
import type { SheetReader } from '../sheets/client.js';
import { syncFaq, syncRoster } from './sheets-sync.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const FAQ_HEADER = [
  'CODE',
  'CATEGORY',
  'BUTTON_TEXT',
  'KEYWORDS',
  'OFFICIAL_ANSWER',
  'LANGUAGE',
  'ACTIVE',
  'LAST_APPROVED_BY',
  'LAST_APPROVED_DATE',
];
const ROSTER_HEADER = ['IDENTIFIER', 'NAME', 'REGION'];

const faqRow = (code: string, category = 'Salary and Payment'): string[] => [
  code,
  category,
  `Question ${code}`,
  'keyword',
  `Answer for ${code}`,
  'EN',
  'TRUE',
  '',
  '',
];

const rosterRow = (n: number): string[] => [`teacher${n}@example.com`, `Teacher ${n}`, 'Tashkent'];

/** A stand-in for Google Sheets that returns whatever the test hands it. */
function readerReturning(tabs: Record<string, string[][]>): SheetReader {
  return { readTab: async (tab: string) => tabs[tab] ?? [] };
}

function collectingAlerter(): Alerter & { alerts: Alert[] } {
  const alerts: Alert[] = [];
  return { alerts, send: async (alert: Alert) => void alerts.push(alert) };
}

describe.skipIf(!TEST_DATABASE_URL)('sheet sync against a real database', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as NodePgDatabase<typeof schema> as Database;
    await db.execute(sql`TRUNCATE faq_entries, roster_entries, sync_runs RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('the ordinary path', () => {
    it('populates an empty table on the first run', async () => {
      const reader = readerReturning({ FAQ: [FAQ_HEADER, faqRow('SAL-001'), faqRow('SAL-002')] });
      const report = await syncFaq(db, reader);

      expect(report.outcome).toBe('applied');
      expect(report.rowsUpserted).toBe(2);
      expect(await countActive(db, 'faq_entries')).toBe(2);
    });

    it('updates an edited answer in place rather than duplicating it', async () => {
      const before = readerReturning({ FAQ: [FAQ_HEADER, faqRow('SAL-001')] });
      await syncFaq(db, before);

      const edited = [...faqRow('SAL-001')];
      edited[4] = 'A corrected answer';
      await syncFaq(db, readerReturning({ FAQ: [FAQ_HEADER, edited] }));

      const rows = await db.select().from(schema.faqEntries);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.officialAnswer).toBe('A corrected answer');
    });

    it('deactivates a row that has disappeared from the sheet', async () => {
      const ten = Array.from({ length: 10 }, (_, i) => faqRow(`SAL-${i}`));
      await syncFaq(db, readerReturning({ FAQ: [FAQ_HEADER, ...ten] }));

      // One removed out of ten is 10% — inside the limit.
      const report = await syncFaq(db, readerReturning({ FAQ: [FAQ_HEADER, ...ten.slice(1)] }));

      expect(report.outcome).toBe('applied');
      expect(report.rowsDeactivated).toBe(1);
      expect(await countActive(db, 'faq_entries')).toBe(9);
    });

    it('reinstates a row pasted back into the sheet', async () => {
      const ten = Array.from({ length: 10 }, (_, i) => rosterRow(i));
      await syncRoster(db, readerReturning({ ROSTER: [ROSTER_HEADER, ...ten] }));
      await syncRoster(db, readerReturning({ ROSTER: [ROSTER_HEADER, ...ten.slice(1)] }));
      expect(await countActive(db, 'roster_entries')).toBe(9);

      await syncRoster(db, readerReturning({ ROSTER: [ROSTER_HEADER, ...ten] }));
      expect(await countActive(db, 'roster_entries')).toBe(10);
    });
  });

  describe('the damage limit leaves the previous data untouched', () => {
    /**
     * The reason these tests need a real database. Refusing is only safe if the
     * upserts roll back with the deactivations — otherwise a refused sync would
     * still have half-applied the sheet it was refusing to trust.
     */
    it('refuses a sync that would empty the roster, and changes nothing', async () => {
      const teachers = Array.from({ length: 100 }, (_, i) => rosterRow(i));
      await syncRoster(db, readerReturning({ ROSTER: [ROSTER_HEADER, ...teachers] }));
      expect(await countActive(db, 'roster_entries')).toBe(100);

      const report = await syncRoster(db, readerReturning({ ROSTER: [ROSTER_HEADER] }));

      expect(report.outcome).toBe('refused');
      expect(report.rowsDeactivated).toBe(0);
      expect(await countActive(db, 'roster_entries')).toBe(100);
    });

    it('rolls back edits that arrived in the same refused run', async () => {
      const teachers = Array.from({ length: 100 }, (_, i) => rosterRow(i));
      await syncRoster(db, readerReturning({ ROSTER: [ROSTER_HEADER, ...teachers] }));

      // Rename one teacher and delete half of them in the same sheet read.
      const renamed = [...rosterRow(0)];
      renamed[1] = 'Renamed In A Bad Sync';
      const bad = [renamed, ...teachers.slice(50)];
      const report = await syncRoster(db, readerReturning({ ROSTER: [ROSTER_HEADER, ...bad] }));

      expect(report.outcome).toBe('refused');
      const row = await db
        .select()
        .from(schema.rosterEntries)
        .where(sql`identifier = 'teacher0@example.com'`);
      expect(row[0]?.name).toBe('Teacher 0');
    });

    it('raises a critical alert naming what to check', async () => {
      const teachers = Array.from({ length: 100 }, (_, i) => rosterRow(i));
      await syncRoster(db, readerReturning({ ROSTER: [ROSTER_HEADER, ...teachers] }));

      const alerter = collectingAlerter();
      await syncRoster(db, readerReturning({ ROSTER: [ROSTER_HEADER] }), { alerter });

      expect(alerter.alerts[0]?.severity).toBe('critical');
      expect(alerter.alerts[0]?.body).toMatch(/Nothing was changed/);
    });

    it('applies the same removal when a person forces it', async () => {
      const teachers = Array.from({ length: 100 }, (_, i) => rosterRow(i));
      await syncRoster(db, readerReturning({ ROSTER: [ROSTER_HEADER, ...teachers] }));

      const report = await syncRoster(db, readerReturning({ ROSTER: [ROSTER_HEADER, ...teachers.slice(50)] }), {
        force: true,
      });

      expect(report.outcome).toBe('applied');
      expect(await countActive(db, 'roster_entries')).toBe(50);
    });
  });

  describe('bad content is reported without blocking good content', () => {
    it('syncs the good rows and rejects the misspelled one', async () => {
      const alerter = collectingAlerter();
      const report = await syncFaq(
        db,
        readerReturning({
          FAQ: [FAQ_HEADER, faqRow('SAL-001'), faqRow('SAL-002', 'Salary and Payments'), faqRow('SAL-003')],
        }),
        { alerter },
      );

      expect(report.outcome).toBe('applied');
      expect(await countActive(db, 'faq_entries')).toBe(2);
      expect(report.rejections).toHaveLength(1);
      expect(alerter.alerts.some((a) => a.body.includes('Row 3'))).toBe(true);
    });

    it('changes nothing at all when a column has been renamed', async () => {
      await syncFaq(db, readerReturning({ FAQ: [FAQ_HEADER, faqRow('SAL-001')] }));

      const renamed = FAQ_HEADER.map((h) => (h === 'OFFICIAL_ANSWER' ? 'ANSWER' : h));
      const report = await syncFaq(db, readerReturning({ FAQ: [renamed, faqRow('SAL-001')] }));

      expect(report.outcome).toBe('failed');
      expect(report.message).toMatch(/OFFICIAL_ANSWER/);
      expect(await countActive(db, 'faq_entries')).toBe(1);
    });
  });

  describe('every run is recorded, including the ones that refused', () => {
    it('records an applied run with its counts', async () => {
      await syncFaq(db, readerReturning({ FAQ: [FAQ_HEADER, faqRow('SAL-001')] }));
      const runs = await db.select().from(schema.syncRuns);
      expect(runs[0]?.outcome).toBe('applied');
      expect(runs[0]?.rowsUpserted).toBe(1);
    });

    it('records a refusal, so a silently-skipped sync is impossible', async () => {
      const teachers = Array.from({ length: 100 }, (_, i) => rosterRow(i));
      await syncRoster(db, readerReturning({ ROSTER: [ROSTER_HEADER, ...teachers] }));
      await syncRoster(db, readerReturning({ ROSTER: [ROSTER_HEADER] }));

      const runs = await db.select().from(schema.syncRuns);
      expect(runs.map((r) => r.outcome)).toContain('refused');
    });

    it('stores the rejected rows so a content owner can see them later', async () => {
      await syncFaq(db, readerReturning({ FAQ: [FAQ_HEADER, faqRow('SAL-001', 'Nonsense Topic')] }));
      const runs = await db.select().from(schema.syncRuns);
      expect(runs[0]?.rowsRejected).toBe(1);
      expect(JSON.stringify(runs[0]?.rejections)).toMatch(/not a known topic/);
    });
  });
});

async function countActive(db: Database, table: 'faq_entries' | 'roster_entries'): Promise<number> {
  const identifier = table === 'faq_entries' ? sql`faq_entries` : sql`roster_entries`;
  const result = await db.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM ${identifier} WHERE active = true`,
  );
  return Number.parseInt(result.rows[0]?.count ?? '0', 10);
}
