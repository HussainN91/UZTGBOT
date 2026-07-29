/**
 * Staff notes on a case — internal, and never shown to a teacher.
 *
 * Their own table rather than an append to `cases.detail`, which holds the
 * teacher's own words at the moment they filed and which `CaseFields`
 * deliberately cannot reach. Apps Script appended notes into that same cell
 * (`AdminCommands.gs:788`), which is why `handleCaseDetail_` carries a comment
 * about the message outgrowing Telegram's 4096-character limit: an internal
 * thread was accumulating inside a field that also held a teacher's original
 * description, with the author and the time encoded as text somebody would
 * eventually have to parse.
 *
 * An INSERT rather than a read-append-write, which also settles the concurrency
 * question. The chat lock is taken on the *sender's* chat, so two staff members
 * writing about one case hold two different locks — anything read-modify-write
 * here would silently lose one of the two notes (R2).
 */
import { desc, eq, sql } from 'drizzle-orm';
import { CASE_NOTES_SHOWN } from '../config/constants.js';
import type { Database } from '../db/index.js';
import { caseNotes } from '../db/schema.js';

export interface CaseNote {
  readonly id: string;
  readonly authorChatId: string;
  readonly body: string;
  readonly createdAt: Date;
}

/**
 * Add one note.
 *
 * Deliberately does **not** touch the case row — not `updated_at`, not
 * `last_actor`, not the status. A note is not progress on a case, and if it
 * moved `updated_at` then a case being discussed internally would look freshly
 * worked to `staleCases`, which is exactly the case most worth surfacing.
 *
 * An empty body is refused rather than stored. A blank row in a list of notes
 * reads as a note somebody deleted, and there is no delete.
 */
export async function addNote(
  db: Database,
  caseReference: string,
  body: string,
  authorChatId: string,
): Promise<void> {
  const trimmed = body.trim();
  if (trimmed === '') throw new Error('a note cannot be empty');

  await db.insert(caseNotes).values({
    caseReference: caseReference.trim().toUpperCase(),
    authorChatId,
    body: trimmed,
  });
}

/**
 * The most recent notes on a case, newest first.
 *
 * Capped, with `countNotes` giving the total, so `/case` can show the last few
 * and say how many more there are instead of growing until it has to be split
 * across messages — which is the failure the old single-cell approach reached.
 */
export async function recentNotes(
  db: Database,
  caseReference: string,
  limit: number = CASE_NOTES_SHOWN,
): Promise<CaseNote[]> {
  const rows = await db
    .select({
      id: caseNotes.id,
      authorChatId: caseNotes.authorChatId,
      body: caseNotes.body,
      createdAt: caseNotes.createdAt,
    })
    .from(caseNotes)
    .where(eq(caseNotes.caseReference, caseReference.trim().toUpperCase()))
    .orderBy(desc(caseNotes.createdAt), desc(caseNotes.id))
    .limit(limit);

  return rows;
}

/** How many notes a case has in total, for the "and N more" line. */
export async function countNotes(db: Database, caseReference: string): Promise<number> {
  const rows = await db
    .select({ count: sql<string>`count(*)` })
    .from(caseNotes)
    .where(eq(caseNotes.caseReference, caseReference.trim().toUpperCase()));
  // count(*) is a bigint and arrives as a string; it is never parsed for us.
  return Number(rows[0]?.count ?? 0);
}
