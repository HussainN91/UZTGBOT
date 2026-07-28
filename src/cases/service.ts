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
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import {
  CASE_DEDUP_WINDOW_HOURS,
  CHECK_MY_CASE_CAP,
  type CaseCategory,
  TIMEZONE,
} from '../config/constants.js';
import type { Database } from '../db/index.js';
import { cases } from '../db/schema.js';
import { findTeacher } from '../teachers/repository.js';
import { allocateReference } from './reference.js';

export type CaseStatus =
  | 'New'
  | 'Received'
  | 'Under review'
  | 'Action required'
  | 'Escalated'
  | 'Completed'
  | 'Closed'
  | 'Duplicate';

/**
 * What counts as "still open" for the duplicate check (`CaseManager.gs:22`).
 *
 * Completed, Closed and Duplicate are excluded deliberately: a teacher whose
 * case was closed yesterday and who has the same problem again today is raising
 * a new case, not repeating one.
 */
export const OPEN_CASE_STATUSES = [
  'New',
  'Received',
  'Under review',
  'Action required',
  'Escalated',
] as const satisfies readonly CaseStatus[];

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
   * File at `Escalated` rather than `New`.
   *
   * Only the urgent flow sets this, and only after a code has been accepted —
   * it is what the code buys. A flag rather than a free `status` parameter,
   * because a caller that can choose any opening status can file a case as
   * `Closed`.
   */
  readonly escalate?: boolean;
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
  const teacher = await findTeacher(db, request.chatId);
  if (teacher === null || teacher.verificationState !== 'Verified') {
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
  await db.insert(cases).values({
    reference,
    category: request.category,
    teacherChatId: request.chatId,
    detail: request.detail,
    status: request.escalate === true ? 'Escalated' : 'New',
    lastActor: request.chatId,
  });

  return { reference, isNew: true };
}

/**
 * Add an urgent follow-up to a case that already exists, and escalate it.
 *
 * The one route by which `detail` may change after a case is filed, and it only
 * ever appends. `CaseFields` deliberately cannot reach `detail` — a write path
 * that can replace a teacher's words is a write path that can lose them — but
 * dropping the words entirely is what the Apps Script version did on this path
 * (`MenuHandler.gs:302`), and it meant a spent single-use code bought nothing
 * and nobody was told.
 *
 * Stamped in Tashkent, by the database, for the same reason references are: a
 * follow-up filed at 00:30 is dated by the clock the reader uses.
 *
 * Returns false when no such case exists, which the caller treats as ordinary —
 * a case can be removed by retention between the dedup read and this write.
 */
export async function appendUrgentFollowUp(
  db: Database,
  reference: string,
  detail: string,
  actor: string,
): Promise<boolean> {
  const result = await db.execute<{ reference: string }>(sql`
    UPDATE cases SET
      detail = detail || E'\n[' || to_char(now() AT TIME ZONE ${TIMEZONE}, 'YYYY-MM-DD HH24:MI')
             || ' URGENT follow-up] ' || ${detail},
      status = 'Escalated',
      updated_at = now(),
      last_actor = ${actor}
    WHERE reference = ${reference}
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

/** Statuses that end a case, and so stamp `closed_at`. */
const TERMINAL_STATUSES: readonly CaseStatus[] = ['Completed', 'Closed', 'Duplicate'];

/**
 * Apply a change, stamping who did it and when.
 *
 * Returns false when no such case exists, rather than throwing — a stale
 * reference from a button or a typed command is ordinary input.
 */
export async function updateCase(
  db: Database,
  reference: string,
  fields: CaseFields,
  actor: string,
): Promise<boolean> {
  const closedAt =
    fields.status !== undefined && TERMINAL_STATUSES.includes(fields.status)
      ? sql`now()`
      : undefined;

  const result = await db
    .update(cases)
    .set({
      ...(fields.status !== undefined ? { status: fields.status } : {}),
      ...(fields.owner !== undefined ? { owner: fields.owner } : {}),
      ...(fields.publicUpdate !== undefined ? { publicUpdate: fields.publicUpdate } : {}),
      ...(closedAt !== undefined ? { closedAt } : {}),
      updatedAt: sql`now()`,
      lastActor: actor,
    })
    .where(eq(cases.reference, reference))
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
