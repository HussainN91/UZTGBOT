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
import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
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

/**
 * Every region this system has ever heard of, spelt as its source spells it.
 *
 * `/region` matches what a staff member types against this list and writes back
 * the spelling it finds, which does two things. A typo — `Bukhrara` — is refused
 * with the real names rather than written, and a region nobody covers is a
 * teacher whose cases only all-region staff can see: routed nowhere, visibly
 * wrong to nobody. And `tashkent` becomes `Tashkent`, so `/case` and `/regions`
 * do not grow a second spelling of one province. (Visibility itself already
 * compares case-insensitively, so this is legibility rather than correctness —
 * but two spellings on screen is how a person concludes there are two places.)
 *
 * The roster is the source; overrides are included because a region set by a
 * manager before recruitment caught up is still a real region. Read fresh each
 * time: this runs on a command a person types, not in a loop.
 */
export async function knownRegions(db: Database): Promise<string[]> {
  const [fromRoster, fromOverrides] = await Promise.all([
    db
      .selectDistinct({ region: rosterEntries.region })
      .from(rosterEntries)
      .where(and(isNotNull(rosterEntries.region), ne(rosterEntries.region, ''))),
    db
      .selectDistinct({ region: teachers.regionOverride })
      .from(teachers)
      .where(and(isNotNull(teachers.regionOverride), ne(teachers.regionOverride, ''))),
  ]);

  // The roster is listed first so that when the two disagree only in case, the
  // spelling recruitment uses is the one that survives.
  const seen = new Map<string, string>();
  for (const { region } of [...fromRoster, ...fromOverrides]) {
    if (region === null) continue;
    const key = region.toLowerCase();
    if (!seen.has(key)) seen.set(key, region);
  }

  return [...seen.values()].sort((a, b) => a.localeCompare(b));
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
 *
 * **Scoped by the region we currently hold, which is the only one we know.** A
 * report says "the region on my record is wrong" — so the person who should see
 * it is whoever holds the teacher today, because it is their queue the teacher is
 * wrongly sitting in. It cannot be scoped by where the teacher actually is: that
 * is the very thing nobody has been told yet.
 *
 * `regions` empty means every region, exactly as `staff.regions` means it
 * everywhere else, and a teacher with no region recorded appears for everybody —
 * the same `IS NULL` rule the visibility predicate depends on, for the same
 * reason. Without it, the teachers whose region is least known would be the ones
 * nobody could be shown.
 */
export async function listRegionFlags(
  db: Database,
  regions: readonly string[] = [],
): Promise<RegionFlag[]> {
  const held = sql<string | null>`coalesce(${teachers.regionOverride}, ${rosterEntries.region})`;

  // ⚠️ A JS array cannot be interpolated into a `sql` template — drizzle expands
  // it into a parameter list, so `= ANY(${arr})` becomes `= ANY(($1, $2))` and
  // PostgreSQL rejects it. `inArray`, as in `visibility.ts`, for the same reason.
  const regionClause =
    regions.length === 0
      ? sql`true`
      : sql`(${held} IS NULL OR ${inArray(sql`lower(${held})`, regions.map((r) => r.toLowerCase()))})`;

  const rows = await db
    .select({
      chatId: teachers.chatId,
      name: teachers.name,
      region: held,
      flaggedAt: teachers.regionFlaggedAt,
    })
    .from(teachers)
    .leftJoin(rosterEntries, eq(teachers.identifier, rosterEntries.identifier))
    .where(
      and(
        isNotNull(teachers.regionFlaggedAt),
        eq(teachers.verificationState, 'Verified'),
        regionClause,
      ),
    )
    .orderBy(teachers.regionFlaggedAt);

  return rows.map((r) => ({ ...r, flaggedAt: r.flaggedAt as Date }));
}
