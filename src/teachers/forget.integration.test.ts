/**
 * Integration tests for anonymising a teacher.
 *
 * The least reversible act in this system, so the tests are as much about what
 * survives as about what goes.
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
import { forgetTeacher } from './forget.js';
import { findTeacher } from './repository.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const CHAT = '950001';
const IDENTIFIER = 'forget.tester@example.com';
const ACTOR = '959001';

describe.skipIf(!TEST_DATABASE_URL)('forgetting a teacher', () => {
  let pool: pg.Pool;
  let db: Database;

  const countOf = async (fragment: ReturnType<typeof sql>): Promise<number> => {
    const rows = await db.execute<{ n: string }>(fragment);
    return Number(rows.rows[0]?.n ?? 0);
  };

  const nameOf = async (chatId: string): Promise<string | null> => {
    const rows = await db.execute<{ name: string | null }>(
      sql`SELECT name FROM teachers WHERE chat_id = ${chatId}`,
    );
    return rows.rows[0]?.name ?? null;
  };

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`
      TRUNCATE cases, case_notes, teachers, roster_entries, messages,
               conversation_states, audit_log CASCADE
    `);
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active)
      VALUES (${IDENTIFIER}, 'Forget Tester', 'Bukhara', true)
    `);
    await db.execute(sql`
      INSERT INTO teachers (chat_id, verification_state, identifier, name, region,
                            region_override, privacy_notice_version, privacy_accepted_case_days)
      VALUES (${CHAT}, 'Verified', ${IDENTIFIER}, 'Forget Tester', 'Bukhara',
              'Samarkand', '2026-07-30.1', 7)
    `);
    await db.execute(sql`
      INSERT INTO cases (reference, category, teacher_chat_id, status, detail)
      VALUES ('VISA-2026-00001', ${CASE_CATEGORY.VISA}, ${CHAT}, 'Under review', 'my visa was refused'),
             ('VISA-2026-00002', ${CASE_CATEGORY.TRAVEL}, ${CHAT}, 'Completed', 'flight question')
    `);
    await db.execute(sql`
      INSERT INTO messages (chat_id, action, detail)
      VALUES (${CHAT}, 'MESSAGE', 'when will my visa arrive'), (${CHAT}, 'CALLBACK', 'MENU:MAIN')
    `);
    await db.execute(sql`
      INSERT INTO conversation_states (chat_id, state, payload, expires_at)
      VALUES (${CHAT}, 'AwaitingQuestionTopic', '{"kind":"AwaitingQuestionTopic","query":"visas"}'::jsonb,
              now() + interval '30 minutes')
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('clears the person and keeps the case history', async () => {
    // Design decision 8, agreed 29 July: removal means replacing the name and
    // the identifier while the cases stay.
    const outcome = await forgetTeacher(db, CHAT, ACTOR);
    expect(outcome).toMatchObject({ kind: 'forgotten', openCases: 1 });

    const teacher = await findTeacher(db, CHAT);
    expect(teacher?.identifier).toBeNull();
    expect(teacher?.verificationState).toBe('Revoked');
    // `TeacherRecord` carries permission inputs, not display fields, so the name
    // is read directly rather than widening a type used by every gate.
    expect(await nameOf(CHAT)).toBeNull();

    expect(await countOf(sql`SELECT count(*) AS n FROM cases WHERE teacher_chat_id = ${CHAT}`)).toBe(2);
  });

  it('deletes their own words from the interaction log', async () => {
    // What they typed is theirs; the problem they reported is the record
    // decision 8 keeps. Removal reaches the first even though it cannot reach
    // the second.
    await forgetTeacher(db, CHAT, ACTOR);
    expect(await countOf(sql`SELECT count(*) AS n FROM messages WHERE chat_id = ${CHAT}`)).toBe(0);
  });

  it('clears any conversation they were part-way through', async () => {
    await forgetTeacher(db, CHAT, ACTOR);
    expect(
      await countOf(sql`SELECT count(*) AS n FROM conversation_states WHERE chat_id = ${CHAT}`),
    ).toBe(0);
  });

  it('clears the region a staff member had set, and the privacy acceptance', async () => {
    await forgetTeacher(db, CHAT, ACTOR);
    const rows = await db.execute<{ region_override: string | null; privacy_notice_version: string | null }>(
      sql`SELECT region_override, privacy_notice_version FROM teachers WHERE chat_id = ${CHAT}`,
    );
    expect(rows.rows[0]?.region_override).toBeNull();
    expect(rows.rows[0]?.privacy_notice_version).toBeNull();
  });

  it('leaves the audit trail, which is the record of the act itself', async () => {
    // audit_log is never pruned (D28), and "who ended this person's record, and
    // when" is exactly what it exists to answer.
    await forgetTeacher(db, CHAT, ACTOR);
    const rows = await db.execute<{ action: string; actor: string }>(
      sql`SELECT action, actor FROM audit_log WHERE subject = ${CHAT}`,
    );
    expect(rows.rows).toEqual([{ action: 'TEACHER_FORGOTTEN', actor: ACTOR }]);
  });

  it('does not free the roster identifier for somebody else', async () => {
    // The roster row is recruitment's and is untouched. What goes is the link.
    await forgetTeacher(db, CHAT, ACTOR);
    expect(
      await countOf(sql`SELECT count(*) AS n FROM roster_entries WHERE identifier = ${IDENTIFIER}`),
    ).toBe(1);
  });

  it('reports an unknown chat id rather than doing nothing quietly', async () => {
    await expect(forgetTeacher(db, '950099', ACTOR)).resolves.toEqual({ kind: 'notFound' });
  });

  it('is safe to run twice, and says which situation it met', async () => {
    /**
     * "Already forgotten" is kept apart from "no such teacher" deliberately.
     * Reporting no-such-teacher for somebody who *was* removed last month
     * invites a second search for a row that is doing exactly what it should.
     */
    await forgetTeacher(db, CHAT, ACTOR);
    await expect(forgetTeacher(db, CHAT, ACTOR)).resolves.toEqual({ kind: 'alreadyForgotten' });

    // And it must not write a second audit row for an act that did not happen.
    expect(await countOf(sql`SELECT count(*) AS n FROM audit_log WHERE subject = ${CHAT}`)).toBe(1);
  });

  it('leaves another teacher entirely alone', async () => {
    await db.execute(sql`
      INSERT INTO teachers (chat_id, verification_state, name) VALUES ('950002', 'Verified', 'Somebody Else')
    `);
    await forgetTeacher(db, CHAT, ACTOR);
    expect(await nameOf('950002')).toBe('Somebody Else');
  });
});
