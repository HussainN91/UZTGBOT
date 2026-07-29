/**
 * The one answer to "which region is this teacher in".
 *
 * Region is one of the two axes that decide who sees a teacher's case, so this
 * is a permission input, not a display field. Before this file there were two
 * routes for changing one and neither worked: correcting the spreadsheet reached
 * nobody who had already signed in, and no command existed at all.
 *
 * The bot never writes back to the spreadsheet. It holds Viewer access to one
 * document, and edit access would reach the confidential answer bank in another
 * tab — and two writable copies of one fact is an argument waiting for the worst
 * possible moment. So a correction lives here, and `schema.ts`'s ownership rule
 * holds: the sheet owns what the bot reads, the database owns what it writes.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { rosterEntries, teachers } from '../db/schema.js';
import { recordAudit } from '../log/audit.js';

/**
 * Resolve a teacher's region.
 *
 * Precedence, stated once so nothing re-derives it: **an explicit decision by a
 * named person beats an import.** Below that, the roster is read LIVE through a
 * join rather than from the copy taken at sign-in.
 *
 * That join is the fix for the older of the two faults. `teachers.region` is
 * written once, by `bindTeacher`, and a verified teacher never signs in again —
 * so a region corrected in the spreadsheet has never reached anybody who had
 * already signed in, while `RUNBOOK.md` and the specification both describe
 * recruitment's edits as authoritative. Reading through the join makes a roster
 * correction behave like every other sheet edit: it arrives on the next sync.
 *
 * `teachers.region` is deliberately kept and deliberately not read here. It is
 * now honestly what it always was — a record of what we believed at bind time.
 *
 * Returns `null` when neither source has one, and the visibility predicate
 * depends on that: an unknown region hides a case from nobody.
 */
export async function regionFor(db: Database, chatId: string): Promise<string | null> {
  const rows = await db
    .select({ region: sql<string | null>`coalesce(${teachers.regionOverride}, ${rosterEntries.region})` })
    .from(teachers)
    .leftJoin(rosterEntries, eq(teachers.identifier, rosterEntries.identifier))
    .where(eq(teachers.chatId, chatId))
    .limit(1);
  return rows[0]?.region ?? null;
}

/**
 * Set the override — the only writer, reached only through `/region`.
 *
 * Clears any mismatch flag in the same statement: the flag means "a teacher says
 * the region we hold is wrong", and a manager setting the region is precisely
 * the act that answers it. Leaving it raised would put the teacher back in a
 * queue of unhandled reports somebody has already handled.
 *
 * Returns false when there is no such teacher, so the command can say so rather
 * than reporting a success that wrote nothing.
 */
export async function setRegionOverride(
  db: Database,
  chatId: string,
  region: string,
  actor: string,
): Promise<boolean> {
  const before = await regionFor(db, chatId);

  const result = await db
    .update(teachers)
    .set({
      regionOverride: region,
      regionSetBy: actor,
      regionSetAt: sql`now()`,
      regionFlaggedAt: null,
    })
    .where(eq(teachers.chatId, chatId));

  if ((result.rowCount ?? 0) === 0) return false;

  await recordAudit(db, {
    actor,
    action: 'TEACHER_REGION_SET',
    subject: chatId,
    detail: { from: before, to: region },
  });
  return true;
}

/**
 * Clear the override, returning the teacher to whatever the roster says.
 *
 * This is the recovery path from a mistyped region, which is why it exists as
 * its own verb rather than as `/region <chat> <the old value>` — retyping the
 * roster's value by hand would create a second override that merely happens to
 * agree with the sheet today, and would stop tracking it tomorrow.
 */
export async function clearRegionOverride(
  db: Database,
  chatId: string,
  actor: string,
): Promise<boolean> {
  const before = await regionFor(db, chatId);

  const result = await db
    .update(teachers)
    .set({ regionOverride: null, regionSetBy: actor, regionSetAt: sql`now()` })
    .where(eq(teachers.chatId, chatId));

  if ((result.rowCount ?? 0) === 0) return false;

  await recordAudit(db, {
    actor,
    action: 'TEACHER_REGION_CLEARED',
    subject: chatId,
    detail: { from: before },
  });
  return true;
}

/**
 * A teacher has said the region we hold is wrong.
 *
 * Writes a flag and nothing else. The teacher is the best source of the signal
 * and the worst source of the record: region decides who receives their
 * emergency, so a menu of regions is a menu of whose problem this becomes, and a
 * wrong tap routes an emergency to the wrong province. A manager makes the
 * actual change through `setRegionOverride`.
 *
 * No audit row. Nothing changed that anyone needs to answer for, and the flag
 * itself is the record until it is cleared.
 */
export async function flagRegionMismatch(db: Database, chatId: string): Promise<boolean> {
  const result = await db
    .update(teachers)
    .set({ regionFlaggedAt: sql`now()` })
    .where(eq(teachers.chatId, chatId));
  return (result.rowCount ?? 0) > 0;
}

export interface RegionFlag {
  readonly chatId: string;
  readonly name: string | null;
  /** The region currently held, so a manager can judge the report without a second lookup. */
  readonly region: string | null;
  readonly flaggedAt: Date;
}

/**
 * Teachers who have reported that their region is wrong.
 *
 * Ordered oldest first: a report that has been waiting longest is the one most
 * likely to be routing somebody's emergency to the wrong province.
 */
export async function listRegionFlags(db: Database): Promise<RegionFlag[]> {
  const rows = await db
    .select({
      chatId: teachers.chatId,
      name: teachers.name,
      region: sql<string | null>`coalesce(${teachers.regionOverride}, ${rosterEntries.region})`,
      flaggedAt: teachers.regionFlaggedAt,
    })
    .from(teachers)
    .leftJoin(rosterEntries, eq(teachers.identifier, rosterEntries.identifier))
    .where(and(isNotNull(teachers.regionFlaggedAt), eq(teachers.verificationState, 'Verified')))
    .orderBy(teachers.regionFlaggedAt);

  return rows.map((r) => ({ ...r, flaggedAt: r.flaggedAt as Date }));
}
