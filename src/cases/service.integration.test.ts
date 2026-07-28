/**
 * Integration tests for case creation, the 24-hour window and Check My Case.
 *
 * The double-tap test is the one that could not be written before: state lived
 * in memory and the dedup check was a read-then-write under a global lock, so
 * "two taps arrive at once" was untestable and simply assumed to be handled.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CASE_CATEGORY } from '../config/constants.js';
import { withChatLock } from '../conversation/lock.js';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import { checkMyCaseReply } from '../telegram/handlers/cases.js';
import {
  TeacherNotVerifiedError,
  createCase,
  getCasesForChatId,
  updateCase,
} from './service.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const CHAT = '950001';
const IDENTIFIER = 'case.tester@example.com';
const DETAIL = 'My visa was refused and my flight is on Tuesday';

describe.skipIf(!TEST_DATABASE_URL)('cases', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`TRUNCATE cases, teachers, roster_entries, case_sequences CASCADE`);
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active)
      VALUES (${IDENTIFIER}, 'Case Tester', 'Tashkent', true)
    `);
    await db.execute(sql`
      INSERT INTO teachers (chat_id, verification_state, identifier, name, region)
      VALUES (${CHAT}, 'Verified', ${IDENTIFIER}, 'Case Tester', 'Tashkent')
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('opening one', () => {
    it('opens a case and returns its reference', async () => {
      const result = await createCase(db, {
        chatId: CHAT,
        category: CASE_CATEGORY.VISA,
        detail: DETAIL,
      });
      expect(result.isNew).toBe(true);
      expect(result.reference).toMatch(/^VISA-\d{4}-00001$/);
    });

    it('refuses a chat that is not verified', async () => {
      // The foreign key proves a teachers row exists, not that it is Verified —
      // an unverified chat that merely reached the identifier prompt already has
      // one. This check is the actual guardrail.
      await db.execute(sql`
        INSERT INTO teachers (chat_id, verification_state) VALUES ('950099', 'AwaitingIdentifier')
      `);
      await expect(
        createCase(db, { chatId: '950099', category: CASE_CATEGORY.VISA, detail: DETAIL }),
      ).rejects.toBeInstanceOf(TeacherNotVerifiedError);
    });

    it('refuses a chat with no teacher row at all', async () => {
      await expect(
        createCase(db, { chatId: '950098', category: CASE_CATEGORY.VISA, detail: DETAIL }),
      ).rejects.toBeInstanceOf(TeacherNotVerifiedError);
    });
  });

  describe('the 24-hour window', () => {
    it('returns the existing case rather than opening a second', async () => {
      const first = await createCase(db, {
        chatId: CHAT,
        category: CASE_CATEGORY.VISA,
        detail: DETAIL,
      });
      const second = await createCase(db, {
        chatId: CHAT,
        category: CASE_CATEGORY.VISA,
        detail: 'asking again',
      });

      expect(second.isNew).toBe(false);
      expect(second.reference).toBe(first.reference);
    });

    it('creates one case, not two, when confirm is double-tapped', async () => {
      /**
       * The case that matters. Two taps arrive as two updates and genuinely race
       * — the platform no longer runs one thing at a time by accident. Both go
       * through the chat lock, which is where the serialisation now comes from.
       */
      const [a, b] = await Promise.all([
        withChatLock(db, CHAT, async (tx) =>
          createCase(tx, { chatId: CHAT, category: CASE_CATEGORY.VISA, detail: DETAIL }),
        ),
        withChatLock(db, CHAT, async (tx) =>
          createCase(tx, { chatId: CHAT, category: CASE_CATEGORY.VISA, detail: DETAIL }),
        ),
      ]);

      expect(a.reference).toBe(b.reference);
      const rows = await db.execute(sql`SELECT reference FROM cases`);
      expect(rows.rows).toHaveLength(1);
    });

    it('keeps categories separate', async () => {
      const visa = await createCase(db, {
        chatId: CHAT,
        category: CASE_CATEGORY.VISA,
        detail: DETAIL,
      });
      const travel = await createCase(db, {
        chatId: CHAT,
        category: CASE_CATEGORY.TRAVEL,
        detail: DETAIL,
      });
      expect(travel.isNew).toBe(true);
      expect(travel.reference).not.toBe(visa.reference);
    });

    it('opens a new case once the old one is closed', async () => {
      // A teacher whose case was closed yesterday and who has the same problem
      // today is raising a new case, not repeating one.
      const first = await createCase(db, {
        chatId: CHAT,
        category: CASE_CATEGORY.VISA,
        detail: DETAIL,
      });
      await updateCase(db, first.reference, { status: 'Closed' }, 'staff-1');

      const second = await createCase(db, {
        chatId: CHAT,
        category: CASE_CATEGORY.VISA,
        detail: DETAIL,
      });
      expect(second.isNew).toBe(true);
    });

    it('opens a new case once the window has passed', async () => {
      const first = await createCase(db, {
        chatId: CHAT,
        category: CASE_CATEGORY.VISA,
        detail: DETAIL,
      });
      await db.execute(
        sql`UPDATE cases SET created_at = now() - interval '25 hours' WHERE reference = ${first.reference}`,
      );

      const second = await createCase(db, {
        chatId: CHAT,
        category: CASE_CATEGORY.VISA,
        detail: DETAIL,
      });
      expect(second.isNew).toBe(true);
    });
  });

  describe('the teacher never sees their own words read back', () => {
    it('leaves detail out of what Check My Case can even select', async () => {
      await createCase(db, { chatId: CHAT, category: CASE_CATEGORY.VISA, detail: DETAIL });
      const visible = await getCasesForChatId(db, CHAT);
      expect(JSON.stringify(visible)).not.toContain('refused');
    });

    it('leaves detail out of the message a teacher is sent', async () => {
      await createCase(db, { chatId: CHAT, category: CASE_CATEGORY.VISA, detail: DETAIL });
      const reply = await checkMyCaseReply(db, CHAT);
      expect(reply.text).not.toContain('refused');
      expect(reply.text).toContain('VISA-');
    });

    it('shows a public update, which is the only case text a teacher sees', async () => {
      const { reference } = await createCase(db, {
        chatId: CHAT,
        category: CASE_CATEGORY.VISA,
        detail: DETAIL,
      });
      await updateCase(
        db,
        reference,
        { status: 'Under review', publicUpdate: 'We have your documents.' },
        'staff-1',
      );

      const reply = await checkMyCaseReply(db, CHAT);
      expect(reply.text).toContain('We have your documents.');
      expect(reply.text).toContain('Under review');
    });

    it('stores the detail, so staff can still read it', async () => {
      // The point is that it is withheld from the teacher, not discarded.
      const { reference } = await createCase(db, {
        chatId: CHAT,
        category: CASE_CATEGORY.VISA,
        detail: DETAIL,
      });
      const rows = await db.execute<{ detail: string }>(
        sql`SELECT detail FROM cases WHERE reference = ${reference}`,
      );
      expect(rows.rows[0]?.detail).toBe(DETAIL);
    });
  });

  describe('updating', () => {
    it('stamps who acted and when', async () => {
      const { reference } = await createCase(db, {
        chatId: CHAT,
        category: CASE_CATEGORY.VISA,
        detail: DETAIL,
      });
      await updateCase(db, reference, { status: 'Received' }, '960001');

      const rows = await db.execute<{ last_actor: string; closed_at: Date | null }>(
        sql`SELECT last_actor, closed_at FROM cases WHERE reference = ${reference}`,
      );
      expect(rows.rows[0]?.last_actor).toBe('960001');
      expect(rows.rows[0]?.closed_at).toBeNull();
    });

    it('stamps closed_at when a case ends', async () => {
      const { reference } = await createCase(db, {
        chatId: CHAT,
        category: CASE_CATEGORY.VISA,
        detail: DETAIL,
      });
      await updateCase(db, reference, { status: 'Completed' }, '960001');

      const rows = await db.execute<{ closed_at: Date | null }>(
        sql`SELECT closed_at FROM cases WHERE reference = ${reference}`,
      );
      expect(rows.rows[0]?.closed_at).not.toBeNull();
    });

    it('reports a reference that does not exist rather than throwing', async () => {
      await expect(updateCase(db, 'VISA-2026-99999', { status: 'Closed' }, 'x')).resolves.toBe(
        false,
      );
    });
  });

  it('says so when there are no cases', async () => {
    const reply = await checkMyCaseReply(db, CHAT);
    expect(reply.text).toContain('not opened any cases');
  });
});
