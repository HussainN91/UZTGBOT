/**
 * Integration tests for reading the answer bank.
 *
 * Two of these guard faults that were live in the rebuild until recently: an
 * answer withdrawn by a content owner staying reachable from a stale button, and
 * a listing whose order the database was never told.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import { findAnswer, listTopicAnswers } from './repository.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

describe.skipIf(!TEST_DATABASE_URL)('reading the answer bank', () => {
  let pool: pg.Pool;
  let db: Database;

  async function insert(
    code: string,
    sheetRow: number,
    active = true,
    topicCode = 'VISA',
  ): Promise<void> {
    await db.execute(sql`
      INSERT INTO faq_entries (code, topic_code, sheet_row, button_text, keywords, official_answer, active)
      VALUES (${code}, ${topicCode}, ${sheetRow}, ${`Button ${code}`},
              ARRAY['passport']::text[], ${`Answer for ${code}`}, ${active})
    `);
  }

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`TRUNCATE faq_entries`);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('a withdrawn answer', () => {
    it('is not listed', async () => {
      await insert('VISA-001', 10);
      await insert('VISA-002', 20, false);
      const rows = await listTopicAnswers(db, 'VISA');
      expect(rows.map((r) => r.code)).toEqual(['VISA-001']);
    });

    it('is unreachable from a stale button in a teacher’s scrollback', async () => {
      // The sync deactivates rather than deletes, so the row is still there. A
      // teacher scrolling back to yesterday still has the old button; tapping it
      // must not deliver an answer that content owners deliberately withdrew.
      await insert('VISA-002', 20, false);
      await expect(findAnswer(db, 'VISA-002')).resolves.toBeNull();
    });

    it('becomes reachable again when it is reinstated', async () => {
      await insert('VISA-002', 20, false);
      await db.execute(sql`UPDATE faq_entries SET active = true WHERE code = 'VISA-002'`);
      expect((await findAnswer(db, 'VISA-002'))?.code).toBe('VISA-002');
    });
  });

  describe('ordering', () => {
    it('lists in the order the content owner arranged the sheet', async () => {
      await insert('VISA-003', 30);
      await insert('VISA-001', 10);
      await insert('VISA-002', 20);
      const rows = await listTopicAnswers(db, 'VISA');
      expect(rows.map((r) => r.code)).toEqual(['VISA-001', 'VISA-002', 'VISA-003']);
    });

    it('breaks ties by code, so an un-migrated bank still pages stably', async () => {
      // sheet_row defaults to 0, so a bank imported before that column existed
      // has every row tied. Without a second key the order is arbitrary AND
      // unstable between two taps of the same button.
      await insert('VISA-003', 0);
      await insert('VISA-001', 0);
      await insert('VISA-002', 0);
      const rows = await listTopicAnswers(db, 'VISA');
      expect(rows.map((r) => r.code)).toEqual(['VISA-001', 'VISA-002', 'VISA-003']);
    });

    it('keeps paging stable across a sync that rewrites every row', async () => {
      /**
       * The sync refreshes every ten minutes and rewrites rows in place. If the
       * order depended on anything the sync churns — insertion order, physical
       * row position — a teacher on page 2 would see a reshuffled bank and get
       * "the answer I saw yesterday has gone", which arrives as one
       * unreproducible complaint.
       */
      await insert('VISA-001', 10);
      await insert('VISA-002', 20);
      await insert('VISA-003', 30);
      const before = (await listTopicAnswers(db, 'VISA')).map((r) => r.code);

      // Touch every row the way a sync does, in an order unrelated to sheet_row.
      await db.execute(sql`UPDATE faq_entries SET synced_at = now() WHERE code = 'VISA-002'`);
      await db.execute(sql`UPDATE faq_entries SET synced_at = now() WHERE code = 'VISA-001'`);
      await db.execute(sql`UPDATE faq_entries SET synced_at = now() WHERE code = 'VISA-003'`);

      expect((await listTopicAnswers(db, 'VISA')).map((r) => r.code)).toEqual(before);
    });
  });

  it('keeps topics separate', async () => {
    await insert('VISA-001', 10, true, 'VISA');
    await insert('SAL-001', 10, true, 'SALARY');
    expect((await listTopicAnswers(db, 'VISA')).map((r) => r.code)).toEqual(['VISA-001']);
  });

  it('returns nothing for a topic with no answers rather than throwing', async () => {
    await expect(listTopicAnswers(db, 'LIVING')).resolves.toEqual([]);
  });
});
