/**
 * Integration tests for FAQ browsing and answering.
 *
 * The scoring rules are proven without a database in `faq/scoring.test.ts`.
 * What is tested here is the join between those rules and real rows: that a
 * withdrawn answer is unreachable, that a nonsense topic lands on the menu
 * instead of throwing, and that a clean miss offers a person rather than a guess.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FAQ_PAGE_SIZE } from '../../config/constants.js';
import type { Database } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import type { Reply } from '../reply.js';
import { answerReply, faqHubReply, questionReply, topicListingReply } from './faq.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

function payloads(reply: Reply): string[] {
  return (reply.keyboard ?? []).flatMap((row) => row.map((b) => b.callback_data));
}

describe.skipIf(!TEST_DATABASE_URL)('FAQ handlers', () => {
  let pool: pg.Pool;
  let db: Database;

  async function insert(
    code: string,
    sheetRow: number,
    keywords: readonly string[],
    active = true,
  ): Promise<void> {
    await db.execute(sql`
      INSERT INTO faq_entries (code, topic_code, sheet_row, button_text, keywords, official_answer, active)
      VALUES (${code}, 'VISA', ${sheetRow}, ${`Question ${code}`},
              ${sql.raw(`ARRAY[${keywords.map((k) => `'${k}'`).join(',') || ''}]::text[]`)},
              ${`The official answer for ${code}`}, ${active})
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

  describe('a topic listing', () => {
    it('offers a button per question', async () => {
      await insert('VISA-001', 10, ['passport']);
      await insert('VISA-002', 20, ['extension']);
      const reply = await topicListingReply(db, 'VISA');
      expect(payloads(reply)).toContain('ANS:VISA-001');
      expect(payloads(reply)).toContain('ANS:VISA-002');
    });

    it('falls back to the main menu for an unknown topic rather than throwing', async () => {
      // Callback data arrives from the network. A stale button from an older
      // taxonomy looks exactly like this, and a throw would reach bot.catch,
      // which acknowledges the update and says nothing — leaving silence.
      const reply = await topicListingReply(db, 'NOT_A_TOPIC');
      expect(payloads(reply)).toContain('MENU:FAQ');
    });

    it('says so plainly when a topic has no approved answers yet', async () => {
      const reply = await topicListingReply(db, 'LIVING');
      expect(reply.text).toContain('no approved answers');
      expect(payloads(reply)).toContain('MENU:CONTACT_SUPPORT');
    });

    it('names the page it is on once there is more than one', async () => {
      for (let i = 0; i <= FAQ_PAGE_SIZE; i++) {
        await insert(`VISA-${String(i).padStart(3, '0')}`, i + 1, ['passport']);
      }
      const reply = await topicListingReply(db, 'VISA', 1);
      expect(reply.text).toContain('page 1 of 2');
    });

    it('clamps a hand-crafted page number to a real page', async () => {
      await insert('VISA-001', 10, ['passport']);
      const reply = await topicListingReply(db, 'VISA', 99);
      expect(payloads(reply)).toContain('ANS:VISA-001');
    });
  });

  describe('an answer', () => {
    it('sends the official wording with a feedback pair', async () => {
      await insert('VISA-001', 10, ['passport']);
      const reply = await answerReply(db, 'VISA-001');
      expect(reply.text).toContain('The official answer for VISA-001');
      expect(payloads(reply)).toContain('OK:VISA-001');
      expect(payloads(reply)).toContain('BAD:VISA-001');
    });

    it('refuses a withdrawn answer from a stale button', async () => {
      await insert('VISA-002', 20, ['passport'], false);
      const reply = await answerReply(db, 'VISA-002');
      expect(reply.text).toContain('no longer available');
      expect(reply.text).not.toContain('The official answer');
    });

    it('refuses a code that never existed', async () => {
      const reply = await answerReply(db, 'NOPE-999');
      expect(reply.text).toContain('no longer available');
    });
  });

  describe('a typed question', () => {
    it('answers directly on one confident match', async () => {
      await insert('VISA-001', 10, ['passport']);
      await insert('VISA-002', 20, ['accommodation']);
      const reply = await questionReply(db, 'VISA', 'passport');
      expect(reply.text).toContain('The official answer for VISA-001');
    });

    it('offers a choice rather than picking between tied matches', async () => {
      await insert('VISA-001', 10, ['passport']);
      await insert('VISA-002', 20, ['passport']);
      const reply = await questionReply(db, 'VISA', 'passport');
      expect(reply.text).toContain('pick the closest one');
      expect(payloads(reply)).toContain('ANS:VISA-001');
      expect(payloads(reply)).toContain('ANS:VISA-002');
    });

    it('offers a person rather than a guess when nothing matches', async () => {
      await insert('VISA-001', 10, ['passport']);
      const reply = await questionReply(db, 'VISA', 'bicycle repairs');
      expect(reply.text).toContain("couldn't match");
      expect(payloads(reply)).toContain('MENU:CONTACT_SUPPORT');
    });

    it('never matches against a withdrawn answer', async () => {
      // The active filter has to hold on this path too, or a withdrawn answer
      // comes back through the search even though its button is gone.
      await insert('VISA-002', 20, ['passport'], false);
      const reply = await questionReply(db, 'VISA', 'passport');
      expect(reply.text).not.toContain('The official answer for VISA-002');
    });
  });

  it('lists every topic in the hub without touching the database', () => {
    expect(payloads(faqHubReply()).filter((p) => p.startsWith('CAT:')).length).toBeGreaterThan(4);
  });
});
