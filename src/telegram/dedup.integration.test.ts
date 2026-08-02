/**
 * Integration tests for update deduplication.
 *
 * These need a real PostgreSQL: the property under test is that two concurrent
 * claims of the same update cannot both succeed, and that is a guarantee of the
 * primary key, not of the code. A mock would only confirm the statement was
 * issued.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 *
 * The schema is applied once by src/test/global-setup.ts, not here — see the
 * note there about why migrating per file raced.
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import { claimUpdate, pruneProcessedUpdates, releaseUpdate } from './dedup.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

describe.skipIf(!TEST_DATABASE_URL)('update deduplication', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`TRUNCATE processed_updates`);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('lets the first delivery through', async () => {
    await expect(claimUpdate(db, 12345)).resolves.toBe(true);
  });

  it('refuses a redelivery of the same update', async () => {
    await claimUpdate(db, 12345);
    await expect(claimUpdate(db, 12345)).resolves.toBe(false);
  });

  it('lets exactly one of two concurrent deliveries win', async () => {
    // The case that matters. A redelivery can overlap an original that is still
    // running, so the two claims genuinely race.
    const results = await Promise.all([claimUpdate(db, 999), claimUpdate(db, 999)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('treats different updates independently', async () => {
    await expect(claimUpdate(db, 1)).resolves.toBe(true);
    await expect(claimUpdate(db, 2)).resolves.toBe(true);
  });

  it('accepts the very large ids Telegram actually issues', async () => {
    // Beyond 2^53, so anything parsing these into a JavaScript number would
    // collide two distinct updates into one and silently drop the second.
    const big = '9007199254740993';
    await expect(claimUpdate(db, big)).resolves.toBe(true);
    await expect(claimUpdate(db, '9007199254740994')).resolves.toBe(true);
  });

  /**
   * Giving a claim back after the work failed.
   *
   * The claim is taken before the work and commits on its own, so a throw in the
   * work left the claim standing and Telegram's redelivery was discarded as a
   * duplicate. The teacher's message was gone and the only trace was a log line.
   * Releasing is what lets the retry through.
   */
  describe('releasing a claim after the work failed', () => {
    it('lets the same update be claimed again', async () => {
      await expect(claimUpdate(db, 4242)).resolves.toBe(true);
      await expect(claimUpdate(db, 4242)).resolves.toBe(false);

      await expect(releaseUpdate(db, 4242)).resolves.toBe(true);

      await expect(claimUpdate(db, 4242)).resolves.toBe(true);
    });

    it('reports false when there was no claim to release', async () => {
      /**
       * `false` means "nothing had claimed this", **not** "the release failed" —
       * and `run()` in `bot.ts` words its alarm on exactly that distinction.
       *
       * The commonest reason the work throws is the database being unreachable,
       * and that throws at `claimUpdate` itself, before any row is committed. So
       * there is nothing to delete, this returns false, and Telegram's retry is
       * accepted normally because nothing is standing in its way. Reading false
       * as a failed release would raise a critical "message lost" alarm for
       * every update during an outage, when none of them is lost.
       */
      await expect(releaseUpdate(db, 4243)).resolves.toBe(false);
    });

    it('releases only the update it was asked about', async () => {
      await claimUpdate(db, 7001);
      await claimUpdate(db, 7002);

      await releaseUpdate(db, 7001);

      await expect(claimUpdate(db, 7001)).resolves.toBe(true);
      await expect(claimUpdate(db, 7002)).resolves.toBe(false);
    });

    it('handles the very large ids Telegram actually issues', async () => {
      // Same reason as the claim test: anything parsing these into a JavaScript
      // number collides two distinct updates, and here that would release the
      // wrong one.
      const big = '9007199254740993';
      await claimUpdate(db, big);

      await expect(releaseUpdate(db, big)).resolves.toBe(true);
      await expect(claimUpdate(db, big)).resolves.toBe(true);
    });
  });

  it('prunes claims too old to be replayed, and keeps recent ones', async () => {
    await claimUpdate(db, 555);
    await db.execute(sql`UPDATE processed_updates SET at = now() - interval '48 hours' WHERE update_id = '555'`);
    await claimUpdate(db, 556);

    const removed = await pruneProcessedUpdates(db, 24);

    expect(removed).toBe(1);
    await expect(claimUpdate(db, 556)).resolves.toBe(false);
  });
});
