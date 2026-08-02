/**
 * Everything staff read about cases.
 *
 * Every query here applies `visibleToStaff` and joins the same two tables, so
 * there is no way to ask a question of this module that returns a case the
 * asker may not see. That is the entire point of the file: `adminCanSeeCase_`
 * was correct and was applied by hand at six separate call sites
 * (`AdminCommands.gs:529, 569, 597, 636, 836`), and a seventh would have been an
 * exposure with no error anywhere.
 *
 * Reads only. `updateCase` in `service.ts` remains the one write path.
 */
import { type SQL, and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { EXPORT_ROW_CAP, STAFF_CASE_LIST_CAP } from '../config/constants.js';
import { SETTING, getSetting } from '../config/settings.js';
import type { Database } from '../db/index.js';
import { CASE_STATUS_ORDER, OPEN_CASE_STATUSES, cases, rosterEntries, teachers } from '../db/schema.js';
import { type StaffScope, visibleToStaff } from '../staff/visibility.js';
import type { CaseStatus } from './service.js';

/** One row as staff see it in a list or in full. */
export interface StaffCaseRow {
  readonly reference: string;
  readonly category: string;
  readonly status: CaseStatus;
  readonly importance: 'Normal' | 'Urgent' | 'Critical';
  readonly teacherChatId: string;
  readonly teacherName: string | null;
  readonly region: string | null;
  /**
   * Set when a person decided the region, null when it came from the roster.
   *
   * `regionSetBy` alone cannot answer that: `clearRegionOverride` stamps it too,
   * and a teacher whose override was cleared has a named setter and a region
   * that came from the spreadsheet after all.
   */
  readonly regionOverride: string | null;
  readonly regionSetBy: string | null;
  readonly regionSetAt: Date | null;
  readonly owner: string | null;
  readonly detail: string;
  readonly publicUpdate: string;
  readonly dueAt: Date | null;
  readonly snoozedUntil: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly closedAt: Date | null;
}

/**
 * A capped list, and how many matched in total.
 *
 * The total is of everything matching *and visible*, not of everything shown.
 * `handleListCases_` displayed twenty and said nothing further, which made a
 * backlog of two hundred look exactly like a backlog of twenty — and the whole
 * reason to look at a queue is to find out which of those it is.
 */
export interface StaffCaseList {
  readonly cases: StaffCaseRow[];
  readonly total: number;
}

/**
 * Every read in this module returns this shape, including the ones that cannot
 * currently exceed the cap.
 *
 * Uniformity is the point. A module where some functions return a list and
 * others return `{ cases, total }` is one where a caller writes `.map` on the
 * wrong one, and the commands in layer 3 call all five.
 */
const EMPTY_LIST: StaffCaseList = { cases: [], total: 0 };

const COLUMNS = {
  reference: cases.reference,
  category: cases.category,
  status: cases.status,
  importance: cases.importance,
  teacherChatId: cases.teacherChatId,
  teacherName: teachers.name,
  /** Resolved the same way `regionFor` resolves it, never from the sign-in copy. */
  region: sql<string | null>`coalesce(${teachers.regionOverride}, ${rosterEntries.region})`,
  /** Where that region came from, so `/case` can say who decided it (Task 45). */
  regionOverride: teachers.regionOverride,
  regionSetBy: teachers.regionSetBy,
  regionSetAt: teachers.regionSetAt,
  owner: cases.owner,
  detail: cases.detail,
  publicUpdate: cases.publicUpdate,
  dueAt: cases.dueAt,
  snoozedUntil: cases.snoozedUntil,
  createdAt: cases.createdAt,
  updatedAt: cases.updatedAt,
  closedAt: cases.closedAt,
};

/**
 * The joins, in one place, because the LEFT is load-bearing.
 *
 * `teachers` is INNER and safe — `cases.teacher_chat_id` is a non-null foreign
 * key. `roster_entries` must be LEFT: a teacher whose roster row was removed
 * still has cases, and an INNER join would hide them from everybody, which is
 * the failure the visibility predicate exists to prevent.
 */
const scoped = (db: Database) =>
  db
    .select(COLUMNS)
    .from(cases)
    .innerJoin(teachers, eq(cases.teacherChatId, teachers.chatId))
    .leftJoin(rosterEntries, eq(teachers.identifier, rosterEntries.identifier));

/** The same joins, counting rather than selecting, so a total respects visibility. */
const countMatching = async (db: Database, where: SQL): Promise<number> => {
  const rows = await db
    .select({ count: sql<string>`count(*)` })
    .from(cases)
    .innerJoin(teachers, eq(cases.teacherChatId, teachers.chatId))
    .leftJoin(rosterEntries, eq(teachers.identifier, rosterEntries.identifier))
    .where(where);
  // count(*) is a bigint and arrives as a string; it is never parsed for us.
  return Number(rows[0]?.count ?? 0);
};

const listWhere = async (db: Database, where: SQL): Promise<StaffCaseList> => {
  const rows = await scoped(db).where(where).orderBy(desc(cases.createdAt)).limit(STAFF_CASE_LIST_CAP);
  return { cases: rows as StaffCaseRow[], total: await countMatching(db, where) };
};

export interface ListCasesOptions {
  /** An exact status. Overrides the open-only default. */
  readonly status?: CaseStatus;
  /** Only cases with no owner — the intake backlog. */
  readonly unassigned?: boolean;
  /**
   * One teacher's cases — what `/revoke` and `/restore` report (R5).
   *
   * Scoped like everything else in this file, and that is a deliberate choice
   * rather than an oversight. A Program member holding one queue is told how
   * many of the teacher's open cases *they* can see, not how many exist, because
   * this module's whole guarantee is that no question asked of it returns a case
   * the asker may not have — and a count is the cheapest possible way to lose
   * that guarantee. The commands say "you can see" rather than implying a total.
   */
  readonly teacherChatId?: string;
}

/**
 * `/cases`.
 *
 * Open cases only unless a status is named. `handleListCases_` listed completed
 * and closed ones too, which buried the actionable work under the finished work
 * — and the finished work grows without limit.
 */
export async function listCases(
  db: Database,
  scope: StaffScope,
  options: ListCasesOptions = {},
): Promise<StaffCaseList> {
  const status =
    options.status === undefined
      ? inArray(cases.status, [...OPEN_CASE_STATUSES])
      : eq(cases.status, options.status);

  const where = and(
    visibleToStaff(scope),
    status,
    options.unassigned === true ? isNull(cases.owner) : undefined,
    options.teacherChatId === undefined ? undefined : eq(cases.teacherChatId, options.teacherChatId),
  )!;

  return listWhere(db, where);
}

/** `/mycases`. Open cases only — a closed case is not work in hand. */
export async function casesOwnedBy(
  db: Database,
  scope: StaffScope,
  ownerChatId: string,
): Promise<StaffCaseList> {
  const where = and(
    visibleToStaff(scope),
    eq(cases.owner, ownerChatId),
    inArray(cases.status, [...OPEN_CASE_STATUSES]),
  )!;

  return listWhere(db, where);
}

/**
 * The overdue threshold, or `null` when nobody has set a usable one.
 *
 * Exported because `/urgent` has to tell two situations apart that look
 * identical from an empty list: **no case is overdue**, and **nobody has said
 * what overdue means**. A staff member shown "nothing overdue" by a feature
 * that is switched off draws exactly the wrong conclusion, and that is the
 * "looks configured and does nothing" failure this rebuild exists to remove.
 *
 * The validation lives here rather than in each caller, so the command's
 * *wording* and the query's *behaviour* can never disagree — an `OVERDUE_DAYS`
 * of `abc` must not have the command announce a threshold the query then
 * ignores.
 */
export async function overdueDays(db: Database): Promise<number | null> {
  const raw = await getSetting(db, SETTING.OVERDUE_DAYS);
  if (raw === null || raw.trim() === '') return null;

  const days = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(days) && days > 0 ? days : null;
}

/**
 * Open cases nobody has touched for longer than `OVERDUE_DAYS`.
 *
 * One of two ideas of "late", and the other one is `casesPastDue` — a promise
 * somebody made and missed. A case can be either, both or neither, and merging
 * them would make the daily chase in stage 5 pursue the wrong list.
 *
 * **Returns nothing when `OVERDUE_DAYS` is unset**, rather than falling back to
 * a number. A fallback here is the bot inventing MoPSE's service standard and
 * then reporting cases as late against it; `handleUrgentCases_` says the same
 * thing (`AdminCommands.gs:551`). The rule lives in here rather than in the
 * caller because a caller is a thing that forgets.
 */
export async function staleCases(
  db: Database,
  scope: StaffScope,
  options: {
    /** Only cases with no owner at all — the standing backlog the digest shows. */
    readonly unassigned?: boolean;
    /**
     * The threshold, when the caller has already read it.
     *
     * `/urgent` reads `overdueDays` itself, because it has to say "nobody has
     * set a threshold" in words rather than showing an empty list — and then
     * called this, which read the same setting again. Two queries for one
     * number, on a command staff run all day.
     *
     * Optional rather than required, so the rule still lives in here for every
     * caller that does not care: omit it and `overdueDays` is read as before.
     * `null` means the same thing whichever way it arrives — nobody has said
     * what overdue means, so nothing is reported as late against a number this
     * bot invented.
     */
    readonly overdueDays?: number | null;
  } = {},
): Promise<StaffCaseList> {
  const days = options.overdueDays !== undefined ? options.overdueDays : await overdueDays(db);
  if (days === null) return EMPTY_LIST;

  const where = and(
    visibleToStaff(scope),
    inArray(cases.status, [...OPEN_CASE_STATUSES]),
    sql`${cases.updatedAt} < now() - make_interval(days => ${days})`,
    options.unassigned === true ? isNull(cases.owner) : undefined,
  )!;

  // Oldest first: the case nobody has touched for longest is the one to look at.
  const rows = await scoped(db).where(where).orderBy(cases.updatedAt).limit(STAFF_CASE_LIST_CAP);
  return { cases: rows as StaffCaseRow[], total: await countMatching(db, where) };
}

/**
 * Open cases whose promised date has passed and which are not snoozed.
 *
 * The **other** idea of "late", and it must never be merged with `staleCases`.
 * That one is "nobody has touched this for N days"; this one is "somebody made a
 * promise to a teacher and missed it". A case can be either, both or neither —
 * a case worked on daily can still miss its date, and a case nobody has touched
 * may never have had one.
 *
 * Unlike `staleCases` this needs no setting: the date came from a person, so
 * there is no service standard to invent and nothing to omit when unset. A case
 * with no `due_at` is simply not past due.
 *
 * Nothing calls this on a schedule until stage 5. It exists now so that stage
 * adds a trigger rather than a trigger and a query.
 */
export async function casesPastDue(
  db: Database,
  scope: StaffScope,
  /**
   * Restrict to one person's own cases — what the daily digest sends them.
   *
   * A filter rather than a second function, because the *rule* about what "past
   * due" means must not exist twice. The digest asks "which of mine did I
   * promise and miss"; `/urgent` asks the same question of a whole queue.
   */
  ownerChatId?: string,
): Promise<StaffCaseList> {
  const where = and(
    visibleToStaff(scope),
    inArray(cases.status, [...OPEN_CASE_STATUSES]),
    sql`${cases.dueAt} IS NOT NULL AND ${cases.dueAt} < now()`,
    or(isNull(cases.snoozedUntil), sql`${cases.snoozedUntil} < now()`),
    ownerChatId === undefined ? undefined : eq(cases.owner, ownerChatId),
  )!;

  // Longest-missed first: the promise broken furthest back is the one to answer.
  const rows = await scoped(db).where(where).orderBy(cases.dueAt).limit(STAFF_CASE_LIST_CAP);
  return { cases: rows as StaffCaseRow[], total: await countMatching(db, where) };
}

/**
 * Cases waiting on the TEACHER whose reminder is due.
 *
 * **The one query in this file that takes no `StaffScope`, and it says so here
 * rather than leaving a reader to wonder.** Every other function guarantees that
 * no question asked of it returns a case the asker may not see — that guarantee
 * is about a *person* asking, and this feeds a scheduled job. There is nobody
 * whose visibility could apply. Anything that hands these rows to a staff member
 * must apply the scope itself; the only caller is the digest job, which sends to
 * the case's own owner.
 *
 * The four conditions each rule out a different wrong reminder:
 *
 *   `Action required` only — the case must actually be waiting on the teacher.
 *   D26 is what makes this the right target: chasing the staff member who is
 *   correctly doing nothing is a digest people learn to ignore.
 *
 *   Under the cap, and not chased recently. Three reminders over nine days, not
 *   a daily nag at somebody who may need a document or an appointment.
 *
 *   Not snoozed. A snooze suppresses chasing and never the case itself, and it
 *   must suppress this exactly as it suppresses `casesPastDue`.
 *
 *   The teacher can still receive something (R29). A revoked teacher, or one
 *   whose roster row went, is a case to close unresolved rather than one to
 *   message — and messaging them costs a send and tells nobody anything.
 */
export async function casesAwaitingTeacher(
  db: Database,
  afterDays: number,
  maxChases: number,
): Promise<StaffCaseRow[]> {
  const rows = await scoped(db)
    .where(
      and(
        eq(cases.status, 'Action required'),
        sql`${cases.teacherChaseCount} < ${maxChases}`,
        or(
          isNull(cases.teacherChasedAt),
          sql`${cases.teacherChasedAt} < now() - make_interval(days => ${afterDays})`,
        ),
        or(isNull(cases.snoozedUntil), sql`${cases.snoozedUntil} < now()`),
        // `teacherHasAccess`, as SQL. Both halves, for D17's reason.
        eq(teachers.verificationState, 'Verified'),
        isNull(teachers.revokedAt),
        eq(rosterEntries.active, true),
      )!,
    )
    .orderBy(cases.teacherChasedAt, cases.createdAt);

  return rows as StaffCaseRow[];
}

/**
 * Cases whose teacher has run out of reminders and whose owner has not been told.
 *
 * Also unscoped, and for the same reason. The count is exactly at the cap: one
 * past it means the owner has already been told, which is what
 * `markChaseReported` writes.
 */
export async function casesExhaustedChasing(
  db: Database,
  maxChases: number,
): Promise<StaffCaseRow[]> {
  const rows = await scoped(db)
    .where(
      and(
        eq(cases.status, 'Action required'),
        sql`${cases.teacherChaseCount} = ${maxChases}`,
      )!,
    )
    .orderBy(cases.teacherChasedAt);

  return rows as StaffCaseRow[];
}

export type ExportSelection =
  | { readonly ok: true; readonly list: StaffCaseList }
  /** The filter was not a status. `statuses` is what to name back to them. */
  | { readonly ok: false; readonly statuses: readonly string[] };

/**
 * Every case the asker can see, up to `EXPORT_ROW_CAP`, for `/export`.
 *
 * **Here rather than in the command**, and that is D43 and R28 together. This
 * module's whole guarantee is that no question asked of it returns a case the
 * asker may not see, and an export is the largest question anybody asks — a
 * hand-rolled query in a command file is one `visibleToStaff` away from a Lead
 * taking every region home in a file.
 *
 * `''` is every case including the closed ones, unlike `listCases`. An export is
 * a report about what has happened, not a work queue, and a report of open cases
 * only would silently answer a different question from the one asked.
 *
 * The total is of everything matching, so the command can say how much is not in
 * the file. A truncated report that does not say it is truncated is one somebody
 * plans from.
 */
export async function casesForExport(
  db: Database,
  scope: StaffScope,
  filter: string,
): Promise<ExportSelection> {
  const wanted = filter.trim().toLowerCase();

  let status: SQL | undefined;
  if (wanted === '') {
    status = undefined;
  } else if (wanted === 'open') {
    status = inArray(cases.status, [...OPEN_CASE_STATUSES]);
  } else {
    const match = CASE_STATUS_ORDER.find((s) => s.toLowerCase() === wanted);
    if (match === undefined) return { ok: false, statuses: CASE_STATUS_ORDER };
    status = eq(cases.status, match);
  }

  const where = and(visibleToStaff(scope), status)!;

  const rows = await scoped(db).where(where).orderBy(desc(cases.createdAt)).limit(EXPORT_ROW_CAP);
  return { ok: true, list: { cases: rows as StaffCaseRow[], total: await countMatching(db, where) } };
}

/**
 * `%` and `_` are wildcards to LIKE and are almost never wildcards to a person.
 *
 * Without this, `/search %` returns every case the asker can see and `/search
 * 50%` quietly matches anything beginning "50". The backslash is the escape
 * character named in the ESCAPE clause below.
 */
const escapeLike = (term: string): string => term.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/**
 * `/search`.
 *
 * The query with the largest exposure surface in this module: it reads the
 * teacher's own words, so it is visible to staff who may see the case and to
 * nobody else. Unlike `/cases` it searches closed cases too — somebody
 * searching is usually looking for something already dealt with.
 *
 * An empty term returns nothing rather than everything. "Show me all the cases"
 * is `/cases`, and a stray `/search` should not dump the backlog.
 */
export async function searchCases(
  db: Database,
  scope: StaffScope,
  term: string,
): Promise<StaffCaseList> {
  const trimmed = term.trim();
  if (trimmed === '') return { cases: [], total: 0 };

  const pattern = `%${escapeLike(trimmed)}%`;
  const where = and(
    visibleToStaff(scope),
    or(
      sql`${cases.detail} ILIKE ${pattern} ESCAPE '\\'`,
      sql`${cases.reference} ILIKE ${pattern} ESCAPE '\\'`,
    ),
  )!;

  return listWhere(db, where);
}

/**
 * One case in full, or null.
 *
 * Null covers both "no such case" and "not yours", deliberately and
 * indistinguishably. Telling somebody that a reference exists but belongs to a
 * queue they do not hold is itself a disclosure — it confirms a teacher filed
 * something, which is the thing the visibility rule protects.
 *
 * The reference is upper-cased because a teacher reads it aloud over the phone
 * and a staff member types what they heard.
 */
export async function findCase(
  db: Database,
  scope: StaffScope,
  reference: string,
): Promise<StaffCaseRow | null> {
  const rows = await scoped(db)
    .where(and(visibleToStaff(scope), eq(cases.reference, reference.trim().toUpperCase()))!)
    .limit(1);

  return (rows[0] as StaffCaseRow | undefined) ?? null;
}
