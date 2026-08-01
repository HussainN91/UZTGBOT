/**
 * Integration tests for conversation state.
 *
 * Chain 10: this used to live in CacheService, where expiry was the platform's
 * problem and a restart wiped everything. It is now a row, which means expiry is
 * a stored deadline nobody sweeps — so every read has to enforce it. That is the
 * property these tests exist for, and it cannot be checked without a real clock
 * and a real database.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CASE_CATEGORY } from '../config/constants.js';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import { clearState, loadState, saveState } from './state.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const CHAT = '910001';

describe.skipIf(!TEST_DATABASE_URL)('conversation state', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`TRUNCATE conversation_states`);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('returns nothing when the teacher is not mid-conversation', async () => {
    await expect(loadState(db, CHAT)).resolves.toBeNull();
  });

  it('round-trips a state and its payload', async () => {
    await saveState(db, CHAT, { kind: 'AwaitingIdentifier', attempts: 2 });
    await expect(loadState(db, CHAT)).resolves.toEqual({
      kind: 'AwaitingIdentifier',
      attempts: 2,
    });
  });

  it('round-trips a state carrying a category', async () => {
    await saveState(db, CHAT, {
      kind: 'AwaitingCaseDetail',
      category: CASE_CATEGORY.VISA,
      attempts: 0,
    });
    await expect(loadState(db, CHAT)).resolves.toEqual({
      kind: 'AwaitingCaseDetail',
      category: CASE_CATEGORY.VISA,
      attempts: 0,
    });
  });

  it('replaces the previous state rather than accumulating rows', async () => {
    await saveState(db, CHAT, { kind: 'AwaitingIdentifier', attempts: 1 });
    await saveState(db, CHAT, { kind: 'AwaitingCaseTopic' });

    await expect(loadState(db, CHAT)).resolves.toEqual({ kind: 'AwaitingCaseTopic' });
    const rows = await db.execute(
      sql`SELECT chat_id FROM conversation_states WHERE chat_id = ${CHAT}`,
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('forgets a state that has been cleared', async () => {
    await saveState(db, CHAT, { kind: 'AwaitingCaseTopic' });
    await clearState(db, CHAT);
    await expect(loadState(db, CHAT)).resolves.toBeNull();
  });

  describe('expiry, which nothing sweeps', () => {
    it('treats an expired state as absent', async () => {
      await db.execute(sql`
        INSERT INTO conversation_states (chat_id, state, payload, expires_at)
        VALUES (${CHAT}, 'AwaitingCaseTopic', '{}'::jsonb, now() - interval '1 minute')
      `);
      await expect(loadState(db, CHAT)).resolves.toBeNull();
    });

    it('does not resurrect an expired state when the sweeper has not run', async () => {
      // The row is deliberately still there. Nothing deletes it — there is no
      // sweeper by design (D4) — so "absent" has to mean "the read refused it",
      // not "it was gone". If this ever passed because the row vanished, the
      // guarantee would be resting on a job that does not exist.
      await db.execute(sql`
        INSERT INTO conversation_states (chat_id, state, payload, expires_at)
        VALUES (${CHAT}, 'AwaitingCaseDetail', '{"category":"Visa","attempts":0}'::jsonb,
                now() - interval '2 days')
      `);

      await expect(loadState(db, CHAT)).resolves.toBeNull();

      const rows = await db.execute(
        sql`SELECT chat_id FROM conversation_states WHERE chat_id = ${CHAT}`,
      );
      expect(rows.rows).toHaveLength(1);
    });

    it('keeps a state that has not expired yet', async () => {
      await saveState(db, CHAT, { kind: 'AwaitingCaseTopic' });
      const rows = await db.execute<{ expires_at: Date | null }>(
        sql`SELECT expires_at FROM conversation_states WHERE chat_id = ${CHAT}`,
      );
      expect(rows.rows[0]?.expires_at).not.toBeNull();
      await expect(loadState(db, CHAT)).resolves.not.toBeNull();
    });

    it('gives a priority request far longer to be described than an ordinary case', async () => {
      // Somebody asked to explain why their case should come before others has
      // to go and find a date, a letter or an appointment reference. A prompt
      // that lapses while they look is one answered with two words instead.
      await saveState(db, CHAT, { kind: 'AwaitingCaseTopic' });
      const ordinary = await expiryOf(db, CHAT);

      await saveState(db, CHAT, { kind: 'AwaitingUrgentDetail', attempts: 0 });
      const urgent = await expiryOf(db, CHAT);

      expect(urgent).toBeGreaterThan(ordinary);
    });
  });

  describe('a state this build does not understand', () => {
    it('reads as absent rather than throwing', async () => {
      // A rollback to older code must not break every teacher mid-conversation.
      // `state` is free text on purpose so adding one needs no migration, and the
      // price of that is that this read must tolerate a value from the future.
      await db.execute(sql`
        INSERT INTO conversation_states (chat_id, state, payload, expires_at)
        VALUES (${CHAT}, 'AwaitingSomethingStageSixInvented', '{}'::jsonb, now() + interval '10 minutes')
      `);
      await expect(loadState(db, CHAT)).resolves.toBeNull();
    });

    it('reads as absent when the payload does not match the state', async () => {
      // Same reasoning one level down: the state is known but its shape changed.
      // Falling through to the main menu is recoverable; throwing on every
      // message until someone edits the database is not.
      await db.execute(sql`
        INSERT INTO conversation_states (chat_id, state, payload, expires_at)
        VALUES (${CHAT}, 'AwaitingCaseDetail', '{"category":"Not A Category"}'::jsonb,
                now() + interval '10 minutes')
      `);
      await expect(loadState(db, CHAT)).resolves.toBeNull();
    });
  });
});

async function expiryOf(db: Database, chatId: string): Promise<number> {
  const rows = await db.execute<{ expires_at: Date }>(
    sql`SELECT expires_at FROM conversation_states WHERE chat_id = ${chatId}`,
  );
  const value = rows.rows[0]?.expires_at;
  if (value === undefined) throw new Error('no conversation state row to read an expiry from');
  return new Date(value).getTime();
}
