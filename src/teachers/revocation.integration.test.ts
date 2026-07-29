/**
 * Integration tests for revocation — both halves of D17.
 *
 * The first test fails against the code as stage 3 left it. `RUNBOOK.md` §4.3,
 * `BOT-SPEC.md` §5.1 and `CONCERNS` A2 all state that deactivating a roster row
 * revokes a teacher on their next message. It did not: `roster.active` was read
 * only by `verifyIdentifier`, and a teacher who has signed in never signs in
 * again, so they kept full access indefinitely.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CASE_CATEGORY } from '../config/constants.js';
import { TeacherNotVerifiedError, createCase, getCasesForChatId } from '../cases/service.js';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import { findTeacher, revokeTeacher, teacherHasAccess } from './repository.js';
import { verifyIdentifier } from './verify.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const CHAT = '920001';
const IDENTIFIER = 'revocation.tester@example.com';
const STAFF = '929999';

describe.skipIf(!TEST_DATABASE_URL)('revocation', () => {
  let pool: pg.Pool;
  let db: Database;

  const openACase = (): Promise<unknown> =>
    createCase(db, {
      chatId: CHAT,
      category: CASE_CATEGORY.VISA,
      detail: 'my visa was refused',
    });

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(
      sql`TRUNCATE cases, case_notes, teachers, roster_entries, case_sequences CASCADE`,
    );
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active)
      VALUES (${IDENTIFIER}, 'Revocation Tester', 'Tashkent', true)
    `);
    await verifyIdentifier(db, CHAT, IDENTIFIER, 0);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('lets a teacher on an active roster row open a case', async () => {
    await expect(openACase()).resolves.toBeDefined();
  });

  it('refuses a gated action once the roster row is deactivated', async () => {
    // The test that proves the documented behaviour was never true.
    await db.execute(sql`UPDATE roster_entries SET active = false WHERE identifier = ${IDENTIFIER}`);

    await expect(openACase()).rejects.toBeInstanceOf(TeacherNotVerifiedError);
  });

  it('refuses a gated action once the roster row is removed entirely', async () => {
    // D17 accepts this deliberately: a row that disappears cuts a teacher off on
    // their next message. The sync's damage limit is what stops a cleared tab
    // cutting everybody off at once.
    await db.execute(sql`UPDATE teachers SET identifier = NULL WHERE chat_id = ${CHAT}`);
    await db.execute(sql`DELETE FROM roster_entries WHERE identifier = ${IDENTIFIER}`);

    await expect(openACase()).rejects.toBeInstanceOf(TeacherNotVerifiedError);
  });

  it('refuses a gated action for a teacher whose access was revoked by command', async () => {
    await revokeTeacher(db, CHAT, STAFF);

    await expect(openACase()).rejects.toBeInstanceOf(TeacherNotVerifiedError);
  });

  it('records who revoked them and when', async () => {
    // The columns have existed since stage 2 and nothing has ever written them.
    // A roster edit cannot answer "who decided this", which is why the command
    // exists alongside it.
    await revokeTeacher(db, CHAT, STAFF);

    const rows = await db.execute(
      sql`SELECT verification_state, revoked_by, revoked_at FROM teachers WHERE chat_id = ${CHAT}`,
    );
    expect(String(rows.rows[0]?.['verification_state'])).toBe('Revoked');
    expect(String(rows.rows[0]?.['revoked_by'])).toBe(STAFF);
    expect(rows.rows[0]?.['revoked_at']).not.toBeNull();
  });

  it('keeps the identifier, so the history link survives', async () => {
    // Clearing it would burn the roster identity and destroy the link this
    // table exists to preserve.
    await revokeTeacher(db, CHAT, STAFF);

    expect((await findTeacher(db, CHAT))?.identifier).toBe(IDENTIFIER);
  });

  it('leaves cases the teacher already opened readable by staff', async () => {
    // R5. Revocation ends their ability to open cases; it does not delete their
    // history, and staff still have to finish the work.
    await openACase();
    await revokeTeacher(db, CHAT, STAFF);

    const rows = await db.execute(sql`SELECT count(*) AS n FROM cases WHERE teacher_chat_id = ${CHAT}`);
    expect(Number(rows.rows[0]?.['n'])).toBe(1);
  });

  it('still lets a revoked teacher read their own case list', async () => {
    // Check My Case reads their own rows and opens nothing. Revocation is not a
    // punishment — it ends their ability to create work, not their ability to
    // see what they already reported.
    await openACase();
    await revokeTeacher(db, CHAT, STAFF);

    expect(await getCasesForChatId(db, CHAT)).toHaveLength(1);
  });

  it('reports when there is nobody to revoke', async () => {
    expect(await revokeTeacher(db, '404404', STAFF)).toBe(false);
  });

  describe('teacherHasAccess', () => {
    it('needs both halves', async () => {
      const verified = await findTeacher(db, CHAT);
      expect(teacherHasAccess(verified)).toBe(true);

      await db.execute(
        sql`UPDATE roster_entries SET active = false WHERE identifier = ${IDENTIFIER}`,
      );
      expect(teacherHasAccess(await findTeacher(db, CHAT))).toBe(false);
    });

    it('refuses a chat with no teacher row at all', () => {
      expect(teacherHasAccess(null)).toBe(false);
    });
  });
});
