/**
 * Integration tests for the two log tables.
 *
 * The redaction rules themselves are proven in interactions.test.ts without a
 * database. What needs a real one is the part that cannot be faked: that the
 * redacted value is what actually lands in the column, that a failed write never
 * propagates out of `logInteraction`, and that an audit write does.
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
import { recordAudit } from './audit.js';
import { logInteraction } from './interactions.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
const CHAT = '920001';

describe.skipIf(!TEST_DATABASE_URL)('the interaction log', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`TRUNCATE messages`);
    await db.execute(sql`TRUNCATE audit_log`);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function details(): Promise<string[]> {
    const rows = await db.execute<{ detail: string }>(
      sql`SELECT detail FROM messages ORDER BY at`,
    );
    return rows.rows.map((r) => r.detail);
  }

  it('redacts the identifier when the teacher is signing in', async () => {
    await logInteraction(db, CHAT, 'RECEIVED_MESSAGE', 'a.karimov@example.com', {
      kind: 'AwaitingIdentifier',
      attempts: 1,
    });
    await expect(details()).resolves.toEqual(['a***@example.com']);
  });

  it('redacts when the state has EXPIRED, not only when it is present', async () => {
    /**
     * The subtle one. A teacher whose sign-in state lapsed and who then types
     * their address arrives here with a null state — the lookup missed. If that
     * were treated as "nothing sensitive", the address would be written in full
     * and the redaction defeated exactly as it was defeated before.
     */
    await logInteraction(db, CHAT, 'RECEIVED_MESSAGE', 'a.karimov@example.com', null);
    const written = await details();
    expect(written).toEqual(['a***@example.com']);
    expect(written[0]).not.toContain('a.karimov');
  });

  it('keeps an ordinary question, so the content gap is still findable', async () => {
    await logInteraction(db, CHAT, 'RECEIVED_MESSAGE', 'how do I extend my visa?', null);
    await expect(details()).resolves.toEqual(['how do I extend my visa?']);
  });

  it('accepts a non-numeric chat id, because SYSTEM events are logged here too', async () => {
    // `messages.chat_id` is plain text rather than the digits-checked chat id
    // used elsewhere, precisely so bot-initiated events can be recorded against
    // 'SYSTEM'. Worth pinning down: it is the reason a malformed id is not a
    // usable way to provoke a failure below.
    await logInteraction(db, 'SYSTEM', 'SYNC_REFUSED', 'roster shrank by 40%', null);
    await expect(details()).resolves.toEqual(['roster shrank by 40%']);
  });

  it('never lets a logging failure escape', async () => {
    // A genuinely unusable handle: the pool is closed before the write. This is
    // the shape of the real failure — the database went away mid-handler — and
    // the teacher's case must not fail with it.
    const closed = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await closed.end();
    const unusable = drizzle(closed, { schema }) as unknown as Database;

    await expect(
      logInteraction(unusable, CHAT, 'RECEIVED_MESSAGE', 'anything', null),
    ).resolves.toBeUndefined();
    await expect(details()).resolves.toEqual([]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('the audit log', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`TRUNCATE audit_log`);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('records who did what to whom', async () => {
    await recordAudit(db, {
      actor: '930001',
      action: 'STAFF_ADDED',
      subject: '930002',
      detail: { role: 'Lead', region: 'Tashkent' },
    });

    const rows = await db.execute<{ actor: string; action: string; subject: string; detail: unknown }>(
      sql`SELECT actor, action, subject, detail FROM audit_log`,
    );
    expect(rows.rows[0]).toMatchObject({
      actor: '930001',
      action: 'STAFF_ADDED',
      subject: '930002',
    });
    expect(rows.rows[0]?.detail).toEqual({ role: 'Lead', region: 'Tashkent' });
  });

  it('records an entry that has no subject', async () => {
    await recordAudit(db, { actor: 'SYSTEM', action: 'MAINTENANCE_MODE_ENABLED' });
    const rows = await db.execute(sql`SELECT subject FROM audit_log`);
    expect(rows.rows).toHaveLength(1);
  });

  /**
   * The opposite of `logInteraction`, and deliberately so. If the record of who
   * was granted access cannot be written, the caller must find out — an
   * unrecorded privileged action is worse than a failed one.
   */
  it('lets a failure propagate rather than losing the record', async () => {
    const closed = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    await closed.end();
    const unusable = drizzle(closed, { schema }) as unknown as Database;

    await expect(
      recordAudit(unusable, { actor: '930001', action: 'STAFF_ADDED', subject: '930002' }),
    ).rejects.toBeDefined();
  });
});
