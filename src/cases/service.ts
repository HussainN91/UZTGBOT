/**
 * The one write path for cases.
 *
 * Stage 4 mutates cases, stage 5 escalates them, stage 6 files document cases.
 * `DEPENDENCY_TREE.md:750` records that the Apps Script version had to retrofit
 * exactly this after callers hand-rolled their own writes and drifted — so the
 * columns that must never change after creation are simply not reachable from
 * `updateCase`, and `updated_at`/`last_actor` are set by the function rather
 * than trusted to the caller.
 *
 * Nothing here takes a lock. `createCase` is a read-then-write and must run
 * inside `withChatLock`, which is already a transaction — one lock, taken in one
 * place, at the top of the update handler.
 */
import { type SQL, and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import {
  CASE_DEDUP_WINDOW_HOURS,
  CHECK_MY_CASE_CAP,
  type CaseCategory,
  MAX_SNOOZE_DAYS,
} from '../config/constants.js';
import type { Database } from '../db/index.js';
import {
  type CaseImportance,
  type CaseStatus,
  OPEN_CASE_STATUSES,
  cases,
} from '../db/schema.js';
import { findTeacher, teacherHasAccess } from '../teachers/repository.js';
import { regionFor } from '../teachers/region.js';
import { chooseOwner } from '../staff/assignment.js';
import { allocateReference } from './reference.js';
import { isClosedStatus } from './status.js';

/**
 * Re-exported from the schema rather than restated here.
 *
 * It *was* restated: this file held its own eight-value `CaseStatus` union and
 * its own `OPEN_CASE_STATUSES` array, while `queries.ts` imported the schema's
 * copy of the latter. Two definitions of one list, reached by different
 * importers, agreeing only by luck — and the schema is the honest home, because
 * that is where the database enum they must match is declared.
 *
 * `OPEN_CASE_STATUSES` was re-exported here too, and nothing ever imported it:
 * every caller goes to the schema directly, which is what "the honest home"
 * means. Knip found the dead line on 30 July 2026 and it was removed rather than
 * adopted, because routing callers through this file would rebuild the second
 * source of truth the paragraph above describes closing.
 *
 * What "still open" means has not changed (`CaseManager.gs:22`): Completed,
 * Closed and Duplicate are excluded deliberately, because a teacher whose case
 * was closed yesterday and who has the same problem again today is raising a new
 * case, not repeating one.
 */
export type { CaseStatus };

export class TeacherNotVerifiedError extends Error {
  constructor(readonly chatId: string) {
    super(`chat ${chatId} is not verified, so it cannot open a case`);
    this.name = 'TeacherNotVerifiedError';
  }
}

export interface CreateCaseRequest {
  readonly chatId: string;
  readonly category: CaseCategory;
  /** The teacher's own words. Stored, never echoed back, never logged. */
  readonly detail: string;
  /**
   * The form area this case was raised in, when it was raised in one.
   *
   * Its presence is what sets `awaiting_form`: a case opened in an area is
   * opened because the teacher wrote a complaint, and the paperwork by
   * definition has not arrived yet. The response sync clears the flag when it
   * does.
   *
   * **Deliberately not part of the de-duplication read below.** Adding it would
   * let one teacher open two cases in the same category inside the 24-hour
   * window by using two areas, which is the double-tap this window exists to
   * absorb.
   */
  readonly formType?: string;
  /**
   * There used to be an `escalate` flag here, and its removal on 1 August 2026
   * is the whole shape of the urgent gate.
   *
   * It filed a case at `Escalated`/`Urgent` in the opening insert, and the
   * urgent flow set it the moment a one-time code was accepted — the code was
   * what bought the escalation. Nothing may do that now. A case is opened at
   * `New`/`Normal` by every path there is, and only `confirmUrgentRequest`
   * raises it, because only a person may decide that one teacher's problem
   * comes before another's.
   */
}

export interface CreateCaseResult {
  readonly reference: string;
  /** False when an open case in the same category already existed. */
  readonly isNew: boolean;
}

/**
 * Open a case, or return the open one this teacher already has in this category.
 *
 * The verified check stays at the application level even though
 * `cases.teacher_chat_id` has a foreign key. The key proves a `teachers` row
 * exists, not that its state is `Verified` — an unverified chat that merely
 * reached the identifier prompt already has a row. Dropping this because "the
 * database handles it" would make the guardrail weaker while looking stronger.
 */
export async function createCase(
  db: Database,
  request: CreateCaseRequest,
): Promise<CreateCaseResult> {
  /**
   * Both halves of D17. Being `Verified` is not enough — the roster row must
   * still list them. Before this check, deactivating a roster row (which the
   * runbook presents as the way to revoke somebody) did nothing whatsoever to a
   * teacher who had already signed in, because nothing re-read it after sign-in.
   */
  const teacher = await findTeacher(db, request.chatId);
  if (!teacherHasAccess(teacher)) {
    throw new TeacherNotVerifiedError(request.chatId);
  }

  const existing = await db
    .select({ reference: cases.reference })
    .from(cases)
    .where(
      and(
        eq(cases.teacherChatId, request.chatId),
        eq(cases.category, request.category),
        inArray(cases.status, [...OPEN_CASE_STATUSES]),
        gt(cases.createdAt, sql`now() - make_interval(hours => ${CASE_DEDUP_WINDOW_HOURS})`),
      ),
    )
    .orderBy(desc(cases.createdAt))
    .limit(1);

  const found = existing[0];
  if (found !== undefined) return { reference: found.reference, isNew: false };

  const reference = await allocateReference(db, request.category);

  /**
   * The case is given an owner as it is filed — Part 5H.1.
   *
   * **`null` is an ordinary answer here**, and it is the one that keeps
   * `/cases unassigned` worth reading: it means no active staff member holds
   * this queue in this region. Before automatic assignment that list meant
   * "nobody has picked this up"; it now means a staffing gap, which is a
   * sharper thing and the one R4 was written about.
   *
   * The region comes from `regionFor`, never from `teachers.region` — that
   * column is the snapshot taken at sign-in (R12), and assigning on a year-old
   * region would route work by where somebody used to live.
   *
   * Inside the caller's transaction, so a case and its owner are written
   * together or not at all. `chooseOwner` reads and returns; it writes nothing
   * and sends nothing.
   */
  const owner = await chooseOwner(db, {
    category: request.category,
    region: await regionFor(db, request.chatId),
  });

  await db.insert(cases).values({
    reference,
    category: request.category,
    teacherChatId: request.chatId,
    detail: request.detail,
    /**
     * Both defaulted, and neither reachable from a caller.
     *
     * They are written explicitly rather than left to the column defaults so
     * that the opening state of a case is readable here, in the one write path,
     * rather than in the schema — and so that the next person to want a case
     * that starts somewhere else has to come here and say why.
     */
    status: 'New',
    importance: 'Normal',
    lastActor: request.chatId,
    formType: request.formType ?? null,
    /**
     * True exactly when this case was raised in a form area, because a case
     * raised there is raised by the teacher writing, before they submit. The
     * response sync clears it when the submission arrives.
     */
    awaitingForm: request.formType !== undefined,
    ...(owner === null ? {} : { owner }),
  });

  return { reference, isNew: true };
}

/**
 * `appendUrgentFollowUp` lived here and was removed on 1 August 2026.
 *
 * It appended a teacher's later words to an open case **and escalated it in the
 * same statement** — status to `Escalated`, importance raised by `GREATEST` —
 * because on the old route the teacher had already spent a one-time code by the
 * time it ran, and the escalation was what the code had bought.
 *
 * Nothing may do that now. Appending is what the *request* path does, and a
 * request that raised importance would be granting itself the thing it was
 * asking a coordinator to decide. The append without the escalation lives in
 * `urgent.ts` as `appendUrgentRequest`, deliberately close to the code that
 * knows a request is only a request.
 */

/**
 * Record that a new case reached somebody who can act on it — D25.
 *
 * This is what finally gives `Received` a writer. The status has existed since
 * stage 2 and nothing has ever written it, so "filed, and somebody can see it"
 * and "filed, and nobody could" were the same word; now they are not, and no
 * staff member has to maintain the difference by hand.
 *
 * Not reachable through `updateCase`, and the `AND status = 'New'` guard is the
 * reason. An urgent case is filed at `Escalated`, and `Escalated` is what puts a
 * case in `/urgent` while it is open — demoting one to `Received` because
 * somebody was notified would take an emergency out of the list that exists to
 * show emergencies. `updateCase` cannot express a conditional write, and adding
 * a `where` to it would hand every caller a way to write a status that depends
 * on the current one.
 *
 * One statement, so it is safe under R2: two staff commands on one case take two
 * different chat locks, and any read-modify-write between them races.
 *
 * `last_actor` is deliberately untouched. Nobody did this; the system did, and
 * overwriting the teacher who filed the case would lose the only record of who
 * that was.
 */
export async function markCaseReceived(db: Database, reference: string): Promise<boolean> {
  const result = await db.execute<{ reference: string }>(sql`
    UPDATE cases SET status = 'Received', updated_at = now()
    WHERE reference = ${reference} AND status = 'New'
    RETURNING reference
  `);
  return result.rows.length > 0;
}

/**
 * The only fields anything may change after a case exists.
 *
 * `reference`, `category`, `teacherChatId` and `createdAt` are absent on
 * purpose — they identify the case, and a write path that can change them is a
 * write path that can silently reassign somebody's case to somebody else.
 * `detail` is absent too: it is the teacher's own words at the moment they filed.
 */
export interface CaseFields {
  readonly status?: CaseStatus;
  readonly owner?: string | null;
  /** The only case text a teacher ever sees back. Written by staff, deliberately. */
  readonly publicUpdate?: string;
}


/**
 * Apply a change, stamping who did it and when.
 *
 * Returns false when no such case exists, rather than throwing — a stale
 * reference from a button or a typed command is ordinary input.
 *
 * **This function does not check who is asking.** It takes a bare reference and
 * writes. Visibility is the caller's job, and in layer 3 that means resolving
 * the reference through `findCase` — which applies the scope — before calling
 * this. A command that skips that step lets a staff member close a case in a
 * queue they do not hold, and nothing here would notice.
 */
export async function updateCase(
  db: Database,
  reference: string,
  fields: CaseFields,
  actor: string,
): Promise<boolean> {
  /**
   * `closed_at` follows the status in both directions, and the second one is the
   * one that was missing.
   *
   * It marks when a case *ended*, so a case that has not ended must not carry
   * one. Before this it was set on the way into a terminal status and left alone
   * on the way out, so a case that was closed and then reopened stayed open with
   * a `closed_at` from its previous life.
   *
   * That was harmless until D28 and is not harmless now: stage 5's retention
   * measures the seven days from this column. A reopened case with a stale
   * `closed_at` is one somebody is actively working that the clean-up would
   * delete a week later. `undefined` still means "the status is not changing,
   * leave this alone" — only an actual move rewrites it.
   */
  const closedAt: SQL | null | undefined =
    fields.status === undefined ? undefined : isClosedStatus(fields.status) ? sql`now()` : null;

  /**
   * The teacher's chase clock restarts whenever the status moves — the same
   * place, and for the same reason, as `closed_at` above.
   *
   * Leaving `Action required` and re-entering it both mean the clock starts
   * again: the first because the case is no longer waiting on the teacher, the
   * second because `/await` has asked them for something new. `updateCase` is
   * the one write path that sees every status change, which is what makes this
   * hold for a command written in a later stage that nobody has thought of yet.
   *
   * Putting it in `/await` instead would be the exact hole that let a reopened
   * case keep a stale `closed_at` for three stages — correct at the one call
   * site somebody remembered, and silently absent from the next one.
   */
  const chaseReset = fields.status === undefined ? {} : { teacherChasedAt: null, teacherChaseCount: 0 };

  const result = await db
    .update(cases)
    .set({
      ...(fields.status !== undefined ? { status: fields.status } : {}),
      ...(fields.owner !== undefined ? { owner: fields.owner } : {}),
      ...(fields.publicUpdate !== undefined ? { publicUpdate: fields.publicUpdate } : {}),
      ...(closedAt !== undefined ? { closedAt } : {}),
      ...chaseReset,
      updatedAt: sql`now()`,
      lastActor: actor,
    })
    /**
     * Tidied like every sibling. This was the one case-writing function that
     * took the reference exactly as given.
     *
     * `markImportance`, `setDue`, `setSnooze`, `clearSnooze` and `findCase` all
     * trim and upper-case; this did not. Harmless today, because every caller
     * resolves through `findCase` first and hands on the reference the database
     * returned — but this is the function whose own comment warns callers to be
     * careful with it, and "the strict one is the one with the warning on it" is
     * a rule that lasts exactly until somebody reads five siblings and assumes
     * the sixth behaves the same.
     */
    .where(eq(cases.reference, reference.trim().toUpperCase()))
    .returning({ reference: cases.reference });

  return result.length > 0;
}

/**
 * Record that the teacher has been reminded their case is waiting on them.
 *
 * One statement, incrementing and stamping together. Two would let a crash
 * between them chase somebody again on the next run with the count unchanged,
 * which for a cap of three is the difference between three reminders and
 * indefinitely many.
 *
 * `last_actor` is deliberately untouched, exactly as `markCaseReceived` leaves
 * it: nobody did this, the system did, and overwriting the last person who acted
 * would lose the only record of who that was.
 */
export async function markTeacherChased(db: Database, reference: string): Promise<boolean> {
  const result = await db.execute<{ reference: string }>(sql`
    UPDATE cases
    SET teacher_chased_at = now(), teacher_chase_count = teacher_chase_count + 1
    WHERE reference = ${reference}
    RETURNING reference
  `);
  return result.rows.length > 0;
}

/**
 * Record that the case's owner has been told the teacher stopped answering.
 *
 * Marked by pushing the count one past the cap rather than by a sixth column on
 * `cases`. A boolean that exactly one query reads is not worth a migration, and
 * the meaning is exact: at the cap means "reminders are finished", one past it
 * means "and somebody has been told".
 *
 * It rides the same reset as everything else — `/await` moves the status, so a
 * fresh request to the teacher starts the whole cycle again.
 */
export async function markChaseReported(db: Database, reference: string): Promise<boolean> {
  const result = await db.execute<{ reference: string }>(sql`
    UPDATE cases
    SET teacher_chase_count = teacher_chase_count + 1
    WHERE reference = ${reference}
    RETURNING reference
  `);
  return result.rows.length > 0;
}

/**
 * Mark how serious a case is.
 *
 * Its own function rather than a field on `CaseFields`, because it is a
 * different kind of change: `CaseFields` is about where a case has got to, and
 * this is about what it is. Keeping them apart is what stops a status write
 * quietly resetting the marker that retention depends on.
 *
 * Unlike the urgent follow-up path this may lower as well as raise — a person
 * reading a case is allowed to decide it is not critical after all, which is
 * exactly the judgement the `Critical` level exists for.
 */
export async function markImportance(
  db: Database,
  reference: string,
  importance: CaseImportance,
  actor: string,
): Promise<boolean> {
  const result = await db
    .update(cases)
    .set({ importance, updatedAt: sql`now()`, lastActor: actor })
    .where(eq(cases.reference, reference.trim().toUpperCase()))
    .returning({ reference: cases.reference });

  return result.length > 0;
}

/**
 * Record when whoever holds this case said it would be done.
 *
 * Nothing chases this until stage 5 — a date that passes is visible to whoever
 * looks and to nobody else, which is the same position `OVERDUE_DAYS` has been
 * in since stage 2. It is written now so that stage adds a schedule to a field
 * already holding real data, rather than a schedule and a field and the hope
 * that staff have been filling it in.
 *
 * `null` clears it.
 */
export async function setDue(
  db: Database,
  reference: string,
  dueAt: Date | null,
  actor: string,
): Promise<boolean> {
  const result = await db
    .update(cases)
    .set({ dueAt, updatedAt: sql`now()`, lastActor: actor })
    .where(eq(cases.reference, reference.trim().toUpperCase()))
    .returning({ reference: cases.reference });

  return result.length > 0;
}

export class SnoozeTooLongError extends Error {
  constructor(readonly days: number) {
    super(`a case cannot be snoozed for ${days} days; the limit is ${MAX_SNOOZE_DAYS}`);
    this.name = 'SnoozeTooLongError';
  }
}

/**
 * Suppress chasing on a case until a date passes.
 *
 * A snooze never changes the case's status and never hides it from a list. It
 * suppresses the chasing, not the work — a snoozed case still appears in
 * `/cases`, still belongs to its owner, and is still open.
 *
 * Capped at `MAX_SNOOZE_DAYS`, which is what stops a snooze becoming a way to
 * make an inconvenient case disappear. The cap is enforced here rather than at
 * the command, so it holds for stage 5 and anything after it.
 */
export async function setSnooze(
  db: Database,
  reference: string,
  days: number,
  actor: string,
): Promise<boolean> {
  if (!Number.isFinite(days) || days <= 0) throw new SnoozeTooLongError(days);
  if (days > MAX_SNOOZE_DAYS) throw new SnoozeTooLongError(days);

  const result = await db
    .update(cases)
    .set({
      snoozedUntil: sql`now() + make_interval(days => ${days})`,
      updatedAt: sql`now()`,
      lastActor: actor,
    })
    .where(eq(cases.reference, reference.trim().toUpperCase()))
    .returning({ reference: cases.reference });

  return result.length > 0;
}

/**
 * Lift a snooze.
 *
 * Its own verb because `setSnooze` takes a number of days and there is no number
 * that means "never mind". Somebody who types `/snooze REF 90` meaning 9 has
 * otherwise put a case beyond chasing for three months with no way back short of
 * a database session — which is the argument D27 made for `/restore` and D20
 * made for clearing a region override. A mistake made by a command should be
 * undoable by a command.
 */
export async function clearSnooze(
  db: Database,
  reference: string,
  actor: string,
): Promise<boolean> {
  const result = await db
    .update(cases)
    .set({ snoozedUntil: null, updatedAt: sql`now()`, lastActor: actor })
    .where(eq(cases.reference, reference.trim().toUpperCase()))
    .returning({ reference: cases.reference });

  return result.length > 0;
}

/**
 * What a teacher is allowed to see about their own cases.
 *
 * `detail` is absent from this type, not merely unselected. Check My Case
 * strips it (`CaseManager.gs:173`), and making it structurally unavailable is
 * what stops a future caller reaching for it because it was convenient.
 */
export interface TeacherVisibleCase {
  readonly reference: string;
  readonly category: string;
  readonly status: CaseStatus;
  readonly publicUpdate: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A teacher's most recent cases, newest first. */
export async function getCasesForChatId(
  db: Database,
  chatId: string,
  limit: number = CHECK_MY_CASE_CAP,
): Promise<readonly TeacherVisibleCase[]> {
  return db
    .select({
      reference: cases.reference,
      category: cases.category,
      status: cases.status,
      publicUpdate: cases.publicUpdate,
      createdAt: cases.createdAt,
      updatedAt: cases.updatedAt,
    })
    .from(cases)
    .where(eq(cases.teacherChatId, chatId))
    .orderBy(desc(cases.createdAt))
    .limit(limit);
}

/** How many cases this teacher has, so a capped list can say what it is hiding. */
export async function countCasesForChatId(db: Database, chatId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(cases)
    .where(eq(cases.teacherChatId, chatId));
  return rows[0]?.count ?? 0;
}
