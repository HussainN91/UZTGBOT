/**
 * Integration tests for the per-chat lock.
 *
 * These need a real PostgreSQL. The property under test is that two overlapping
 * handlers for one teacher cannot run at the same time, and that is a guarantee
 * of `pg_advisory_xact_lock` — a mock would only confirm the statement was
 * issued, which is exactly the part that is not in doubt.
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
import { withChatLock } from './lock.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!TEST_DATABASE_URL)('the per-chat lock', () => {
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

  it('does not let two handlers for one teacher overlap', async () => {
    // Chain 10: two quick messages from one teacher genuinely race now that the
    // platform no longer runs one thing at a time by accident.
    let active = 0;
    let mostConcurrent = 0;

    const work = async (): Promise<void> => {
      active += 1;
      mostConcurrent = Math.max(mostConcurrent, active);
      await sleep(40);
      active -= 1;
    };

    await Promise.all([withChatLock(db, '900001', work), withChatLock(db, '900001', work)]);

    expect(mostConcurrent).toBe(1);
  });

  it('lets two different teachers run at the same time', async () => {
    /**
     * The point of the whole change. Each side refuses to finish until it knows
     * the other has started, so this can only resolve if both are inside their
     * lock together. If the lock were global — as it was in Apps Script — the
     * second would wait for the first to finish and this would time out.
     */
    let aIsIn = (): void => {};
    let bIsIn = (): void => {};
    const aEntered = new Promise<void>((resolve) => {
      aIsIn = resolve;
    });
    const bEntered = new Promise<void>((resolve) => {
      bIsIn = resolve;
    });

    await Promise.all([
      withChatLock(db, '900002', async () => {
        aIsIn();
        await bEntered;
      }),
      withChatLock(db, '900003', async () => {
        bIsIn();
        await aEntered;
      }),
    ]);
  });

  it('returns what the work returns', async () => {
    await expect(withChatLock(db, '900004', async () => 'filed')).resolves.toBe('filed');
  });

  it('releases the lock when the work throws', async () => {
    await expect(
      withChatLock(db, '900005', async () => {
        throw new Error('handler blew up');
      }),
    ).rejects.toThrow('handler blew up');

    // The next caller must not inherit a stranded lock. Without the transaction
    // scope this is where the bot would wedge for one teacher, permanently.
    await expect(withChatLock(db, '900005', async () => 'ok')).resolves.toBe('ok');
  });

  it('rolls back the work when it throws, because the work is inside the transaction', async () => {
    // Proves `fn` receives the transaction rather than the pool. If it received
    // the pool this insert would survive, and "dedup and insert in one
    // transaction under the chat lock" would be a false statement.
    await expect(
      withChatLock(db, '900006', async (tx) => {
        await tx.execute(
          sql`INSERT INTO conversation_states (chat_id, state) VALUES ('900006', 'AwaitingCaseTopic')`,
        );
        throw new Error('changed my mind');
      }),
    ).rejects.toThrow('changed my mind');

    const rows = await db.execute(
      sql`SELECT chat_id FROM conversation_states WHERE chat_id = '900006'`,
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('commits the work when it does not throw', async () => {
    await withChatLock(db, '900007', async (tx) => {
      await tx.execute(
        sql`INSERT INTO conversation_states (chat_id, state) VALUES ('900007', 'AwaitingCaseTopic')`,
      );
    });

    const rows = await db.execute(
      sql`SELECT chat_id FROM conversation_states WHERE chat_id = '900007'`,
    );
    expect(rows.rows).toHaveLength(1);
  });
});
