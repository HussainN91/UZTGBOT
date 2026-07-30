/**
 * Integration tests for sign-in, duplicate detection and privacy acceptance.
 *
 * D1 and D3 are both here, and both are decisions that look wrong until you read
 * why: a duplicate binding is allowed, and a lockout is temporary. Each has a
 * test naming the failure it avoids, because the "safer" alternative is what
 * somebody will propose the first time they read this code.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_VERIFICATION_ATTEMPTS } from '../config/constants.js';
import { PRIVACY_NOTICE_VERSION } from '../config/privacy.js';
import { withChatLock } from '../conversation/lock.js';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import { findTeacher } from './repository.js';
import { verifyIdentifier as verifyWithPeriods } from './verify.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const CHAT = '940001';
const OTHER_CHAT = '940002';
const IDENTIFIER = 'a.karimov@example.com';

/**
 * Stage 5 gave `verifyIdentifier` a fifth argument: the retention periods the
 * notice stated when this teacher read it, recorded as part of the acceptance.
 *
 * These tests are about verification rather than about consent, so they pass the
 * periods every teacher bound before stage 5 accepted under — all three unset,
 * which is what "kept until the Ministry sets a period" means. The acceptance
 * itself is covered in `privacy.integration.test.ts`.
 */
const verify = (
  db: Database,
  chatId: string,
  raw: string,
  attempts: number,
): ReturnType<typeof verifyWithPeriods> =>
  verifyWithPeriods(db, chatId, raw, attempts, {
    caseDays: null,
    urgentCaseDays: null,
    messageDays: null,
  });

describe.skipIf(!TEST_DATABASE_URL)('verifying a teacher', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    // teachers references roster_entries, so order matters.
    await db.execute(sql`TRUNCATE teachers, roster_entries CASCADE`);
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active)
      VALUES (${IDENTIFIER}, 'Aziz Karimov', 'Tashkent', true)
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('verifies a teacher whose identifier is on the roster', async () => {
    const outcome = await verify(db, CHAT, IDENTIFIER, 0);
    expect(outcome.kind).toBe('verified');

    const teacher = await findTeacher(db, CHAT);
    expect(teacher?.verificationState).toBe('Verified');
    expect(teacher?.identifier).toBe(IDENTIFIER);
  });

  it('accepts an identifier typed with different case and spacing', async () => {
    // The Apps Script version compared raw cell values, so a trailing space in a
    // pasted cell meant a teacher simply could not sign in, with nothing to say why.
    const outcome = await verify(db, CHAT, '  A.Karimov@Example.COM ', 0);
    expect(outcome.kind).toBe('verified');
  });

  it('refuses an identifier whose roster row has been deactivated', async () => {
    // The roster sync deactivates, never deletes. Removing a teacher from the
    // sheet is what every operator will assume revokes access — without this
    // check it does nothing at all.
    await db.execute(sql`UPDATE roster_entries SET active = false WHERE identifier = ${IDENTIFIER}`);

    const outcome = await verify(db, CHAT, IDENTIFIER, 0);
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'rosterRowDeactivated' });
    expect(await findTeacher(db, CHAT)).toBeNull();
  });

  it('refuses an identifier that is not on the roster at all', async () => {
    const outcome = await verify(db, CHAT, 'stranger@example.com', 0);
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'notOnRoster' });
  });

  it('copies the region from the roster', async () => {
    // Stage 4's entire region axis reads teachers.region, and bind time is the
    // only moment it is ever populated. Omitting it makes half of Stage 4's
    // permission model structurally dead.
    await verify(db, CHAT, IDENTIFIER, 0);
    expect((await findTeacher(db, CHAT))?.region).toBe('Tashkent');
  });

  it('records the privacy notice version in the same write as the bind', async () => {
    // Otherwise a teacher is Verified with no recorded acceptance, and the
    // column proves nothing.
    await verify(db, CHAT, IDENTIFIER, 0);

    const rows = await db.execute<{ accepted_at: Date | null; version: string | null }>(sql`
      SELECT privacy_notice_accepted_at AS accepted_at, privacy_notice_version AS version
      FROM teachers WHERE chat_id = ${CHAT}
    `);
    expect(rows.rows[0]?.accepted_at).not.toBeNull();
    expect(rows.rows[0]?.version).toBe(PRIVACY_NOTICE_VERSION);
  });

  it('works under the chat lock, which is how it is really called', async () => {
    const outcome = await withChatLock(db, CHAT, async (tx) =>
      verify(tx, CHAT, IDENTIFIER, 0),
    );
    expect(outcome.kind).toBe('verified');
    expect(await findTeacher(db, CHAT)).not.toBeNull();
  });
});

describe.skipIf(!TEST_DATABASE_URL)('a second account presenting the same identity', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`TRUNCATE teachers, roster_entries CASCADE`);
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active)
      VALUES (${IDENTIFIER}, 'Aziz Karimov', 'Tashkent', true)
    `);
    await verify(db, CHAT, IDENTIFIER, 0);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('is allowed to bind — detected, not blocked', async () => {
    // D1. Blocking would lock out any teacher who changes phone, and would let
    // anyone holding a leaked recruitment email lock the real teacher out.
    const outcome = await verify(db, OTHER_CHAT, IDENTIFIER, 0);
    expect(outcome.kind).toBe('verified');
    expect((await findTeacher(db, OTHER_CHAT))?.verificationState).toBe('Verified');
  });

  it('reports the prior holder, so the alarm can be raised and they can be told', async () => {
    const outcome = await verify(db, OTHER_CHAT, IDENTIFIER, 0);
    if (outcome.kind !== 'verified') throw new Error(`expected a binding, got ${outcome.kind}`);
    expect(outcome.priorHolders).toEqual([CHAT]);
  });

  it('leaves the original binding in place', async () => {
    // Both chats hold the identity. The second binding is a signal for a human,
    // not a reason to revoke the first.
    await verify(db, OTHER_CHAT, IDENTIFIER, 0);
    expect((await findTeacher(db, CHAT))?.verificationState).toBe('Verified');
  });

  it('reports nobody when a teacher re-verifies on the same chat', async () => {
    // The ordinary case, and the one that would cry wolf if the chat being bound
    // were not excluded from the lookup.
    const outcome = await verify(db, CHAT, IDENTIFIER, 0);
    if (outcome.kind !== 'verified') throw new Error(`expected a binding, got ${outcome.kind}`);
    expect(outcome.priorHolders).toEqual([]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('failed attempts (D3)', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`TRUNCATE teachers, roster_entries CASCADE`);
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active)
      VALUES (${IDENTIFIER}, 'Aziz Karimov', 'Tashkent', true)
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('consumes an attempt when the identifier is not on the roster', async () => {
    const outcome = await verify(db, CHAT, 'stranger@example.com', 0);
    expect(outcome).toMatchObject({ consumedAttempt: true, attempts: 1 });
  });

  it('counts down the attempts remaining', async () => {
    const outcome = await verify(db, CHAT, 'stranger@example.com', 2);
    expect(outcome).toMatchObject({ attempts: 3, attemptsRemaining: MAX_VERIFICATION_ATTEMPTS - 3 });
  });

  it('locks out once the budget is spent', async () => {
    const outcome = await verify(
      db,
      CHAT,
      'stranger@example.com',
      MAX_VERIFICATION_ATTEMPTS,
    );
    expect(outcome.kind).toBe('lockedOut');
  });

  it('does NOT consume an attempt for a teacher re-verifying their own identity', async () => {
    /**
     * Distinguish roster-miss from your-own-account, or an operator fixing a
     * sheet can lock out the very teacher they are fixing: the row goes
     * inactive, the teacher retries honestly, and five retries exhaust a budget
     * meant for guessers.
     */
    await verify(db, CHAT, IDENTIFIER, 0);
    await db.execute(sql`UPDATE roster_entries SET active = false WHERE identifier = ${IDENTIFIER}`);

    const outcome = await verify(db, CHAT, IDENTIFIER, 3);
    expect(outcome).toMatchObject({ kind: 'refused', consumedAttempt: false, attempts: 3 });
  });

  it('still lets that teacher through once the roster row is restored', async () => {
    await verify(db, CHAT, IDENTIFIER, 0);
    await db.execute(sql`UPDATE roster_entries SET active = false WHERE identifier = ${IDENTIFIER}`);
    await verify(db, CHAT, IDENTIFIER, MAX_VERIFICATION_ATTEMPTS);
    await db.execute(sql`UPDATE roster_entries SET active = true WHERE identifier = ${IDENTIFIER}`);

    // Never locked out, because none of those retries were guesses.
    const outcome = await verify(db, CHAT, IDENTIFIER, MAX_VERIFICATION_ATTEMPTS);
    expect(outcome.kind).toBe('verified');
  });
});
