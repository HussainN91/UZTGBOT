/**
 * Integration tests for staff notes.
 *
 * The concurrency test is the one that could not be written before: Apps Script
 * appended notes into `cases.detail` with a read-modify-write, and under this
 * system's per-chat locking two staff members writing at the same moment would
 * silently lose one of the two.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CASE_CATEGORY, CASE_NOTES_SHOWN } from '../config/constants.js';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import { getCasesForChatId } from './service.js';
import { addNote, countNotes, recentNotes } from './notes.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const CHAT = '990001';
const IDENTIFIER = 'notes.tester@example.com';
const REF = 'VISA-2026-00001';
const AUTHOR_A = '991001';
const AUTHOR_B = '991002';
const NOTE_TEXT = 'the embassy confirmed by telephone, do not tell the teacher yet';

describe.skipIf(!TEST_DATABASE_URL)('case notes', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`TRUNCATE cases, case_notes, teachers, roster_entries CASCADE`);
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active)
      VALUES (${IDENTIFIER}, 'Notes Tester', 'Tashkent', true)
    `);
    await db.execute(sql`
      INSERT INTO teachers (chat_id, verification_state, identifier, name, region)
      VALUES (${CHAT}, 'Verified', ${IDENTIFIER}, 'Notes Tester', 'Tashkent')
    `);
    await db.execute(sql`
      INSERT INTO cases (reference, category, teacher_chat_id, status, detail)
      VALUES (${REF}, ${CASE_CATEGORY.VISA}, ${CHAT}, 'New', 'my visa was refused')
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('keeps both notes when two staff write at the same moment', async () => {
    // R2. The chat lock is per SENDER, so two staff acting on one case take two
    // different locks. An INSERT is safe under that; a read-append-write is not,
    // and would lose one note with nothing to show it had happened.
    await Promise.all([addNote(db, REF, 'A', AUTHOR_A), addNote(db, REF, 'B', AUTHOR_B)]);

    const notes = await recentNotes(db, REF);
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => n.body).sort()).toEqual(['A', 'B']);
  });

  it('records who wrote it and when, as columns', async () => {
    // Not encoded into text somebody would eventually have to parse.
    await addNote(db, REF, NOTE_TEXT, AUTHOR_A);

    const [note] = await recentNotes(db, REF);
    expect(note?.authorChatId).toBe(AUTHOR_A);
    expect(note?.body).toBe(NOTE_TEXT);
    expect(note?.createdAt).toBeInstanceOf(Date);
  });

  it('never writes a note where the teacher can read it', async () => {
    // The whole reason for a separate table. cases.detail is the teacher's own
    // words and CaseFields deliberately cannot reach it.
    await addNote(db, REF, NOTE_TEXT, AUTHOR_A);

    const visible = await getCasesForChatId(db, CHAT);
    expect(JSON.stringify(visible)).not.toContain(NOTE_TEXT);
  });

  it('does not touch the case row at all', async () => {
    // A note is not progress. It must not move updated_at, or every note would
    // make a stale case look freshly worked and staleCases would go quiet.
    const before = await db.execute(sql`SELECT updated_at, detail FROM cases WHERE reference = ${REF}`);
    await addNote(db, REF, NOTE_TEXT, AUTHOR_A);
    const after = await db.execute(sql`SELECT updated_at, detail FROM cases WHERE reference = ${REF}`);

    expect(after.rows[0]?.['updated_at']).toEqual(before.rows[0]?.['updated_at']);
    expect(after.rows[0]?.['detail']).toEqual(before.rows[0]?.['detail']);
  });

  it('returns the most recent first, capped, and counts the rest', async () => {
    for (let i = 1; i <= CASE_NOTES_SHOWN + 3; i += 1) {
      await addNote(db, REF, `note ${i}`, AUTHOR_A);
    }

    const notes = await recentNotes(db, REF);
    expect(notes).toHaveLength(CASE_NOTES_SHOWN);
    expect(notes[0]?.body).toBe(`note ${CASE_NOTES_SHOWN + 3}`);
    expect(await countNotes(db, REF)).toBe(CASE_NOTES_SHOWN + 3);
  });

  it('refuses an empty note rather than storing a blank row', async () => {
    await expect(addNote(db, REF, '   ', AUTHOR_A)).rejects.toThrow(/empty/i);
    expect(await recentNotes(db, REF)).toEqual([]);
  });

  it('refuses a note on a case that does not exist', async () => {
    // The foreign key is what enforces it. Without the check the error would
    // reach bot.catch and the writer would be told nothing at all.
    await expect(addNote(db, 'VISA-2026-99999', 'hello', AUTHOR_A)).rejects.toThrow();
  });

  it('returns no notes for a case that has none', async () => {
    expect(await recentNotes(db, REF)).toEqual([]);
    expect(await countNotes(db, REF)).toBe(0);
  });

  it('goes away with its case, so retention can remove one', async () => {
    // ON DELETE CASCADE. Stage 5 must be able to remove a case without tripping
    // over its notes, and a note about a case that no longer exists is not a
    // record worth keeping.
    await addNote(db, REF, NOTE_TEXT, AUTHOR_A);
    await db.execute(sql`DELETE FROM cases WHERE reference = ${REF}`);

    const left = await db.execute(sql`SELECT count(*) AS n FROM case_notes`);
    expect(Number(left.rows[0]?.['n'])).toBe(0);
  });
});
