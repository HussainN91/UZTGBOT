/**
 * Reading and writing the roster and the teachers bound to it.
 *
 * Uses the typed query builder rather than raw SQL, which is the point of
 * `db/index.ts`: a column rename breaks compilation at every call site here,
 * rather than failing quietly at runtime the way a renamed spreadsheet column
 * used to.
 */
import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import type { RetentionPeriods } from '../config/retention.js';
import type { Database } from '../db/index.js';
import { rosterEntries, teachers } from '../db/schema.js';
import { recordAudit } from '../log/audit.js';

export interface RosterMatch {
  readonly identifier: string;
  readonly name: string;
  readonly region: string | null;
  /**
   * The sync deactivates, it never deletes. Removing a teacher from the sheet is
   * what every administrator will assume revokes access, so this flag has to be
   * read at sign-in — without it, deleting a row does nothing at all.
   */
  readonly active: boolean;
}

/** Look up a roster row. `identifier` must already be normalised. */
export async function findRosterEntry(
  db: Database,
  identifier: string,
): Promise<RosterMatch | null> {
  const rows = await db
    .select({
      identifier: rosterEntries.identifier,
      name: rosterEntries.name,
      region: rosterEntries.region,
      active: rosterEntries.active,
    })
    .from(rosterEntries)
    .where(eq(rosterEntries.identifier, identifier))
    .limit(1);
  return rows[0] ?? null;
}

export interface TeacherRecord {
  readonly chatId: string;
  readonly identifier: string | null;
  readonly verificationState: 'Unverified' | 'AwaitingIdentifier' | 'Verified' | 'Revoked';
  readonly region: string | null;
  readonly revokedAt: Date | null;
  /**
   * Whether the roster still lists this teacher. Null when there is no roster
   * row at all — either they never signed in, or the row was removed.
   *
   * Joined here rather than looked up separately because it is a permission
   * input on every gated action, and a second query is a query somebody skips.
   */
  readonly rosterActive: boolean | null;
}

export async function findTeacher(db: Database, chatId: string): Promise<TeacherRecord | null> {
  const rows = await db
    .select({
      chatId: teachers.chatId,
      identifier: teachers.identifier,
      verificationState: teachers.verificationState,
      region: teachers.region,
      revokedAt: teachers.revokedAt,
      rosterActive: rosterEntries.active,
    })
    .from(teachers)
    .leftJoin(rosterEntries, eq(teachers.identifier, rosterEntries.identifier))
    .where(eq(teachers.chatId, chatId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * May this teacher do the things signing in unlocks?
 *
 * The single answer, because before this existed there were two and they
 * disagreed. `RUNBOOK.md` §4.3 tells an operator that setting a roster row
 * inactive revokes a teacher and "takes effect on their next message";
 * `BOT-SPEC.md` §5.1 and `CONCERNS` A2 repeat it. It was not true.
 * `roster.active` was read only by `verifyIdentifier`, and **a teacher who has
 * signed in never signs in again** — so a deactivated or deleted roster row
 * changed nothing at all, indefinitely.
 *
 * Both halves are checked here: the state, which `/revoke` writes, and the
 * roster, which is the route an operator will actually use.
 *
 * A missing roster row counts as revoked. D17 accepts that risk deliberately —
 * the sync refuses any run that would deactivate more than a fifth of active
 * rows, so a cleared or filtered tab cannot cut everybody off, and a single row
 * removed by mistake affects one teacher, shows in the sync history, and is
 * undone by putting the row back.
 */
export function teacherHasAccess(teacher: TeacherRecord | null): boolean {
  if (teacher === null) return false;
  if (teacher.verificationState !== 'Verified') return false;
  return teacher.rosterActive === true;
}

/**
 * End a teacher's access by command, recording who did it and when.
 *
 * The columns have existed since stage 2 — `revoked_at`, `revoked_by`, and the
 * enum's `Revoked` value — and nothing has ever written any of them. The
 * roster route works too now, but it cannot answer "who decided this, and
 * when", which is an audit question and the reason this command exists
 * alongside it.
 *
 * The identifier is deliberately left in place. Clearing it would burn the
 * roster identity and destroy the history link this table exists to preserve.
 */
export async function revokeTeacher(
  db: Database,
  chatId: string,
  actor: string,
): Promise<boolean> {
  const result = await db
    .update(teachers)
    .set({
      verificationState: 'Revoked',
      revokedAt: sql`now()`,
      revokedBy: actor,
    })
    .where(eq(teachers.chatId, chatId))
    .returning({ chatId: teachers.chatId });

  if (result.length === 0) return false;

  await recordAudit(db, { actor, action: 'TEACHER_REVOKED', subject: chatId });
  return true;
}

/**
 * Give a wrongly revoked teacher their access back — D27.
 *
 * The counterpart `/revoke` never had. Revoking the wrong person is an ordinary
 * mistake; the recovery before this was a database session over the SSH tunnel,
 * which is not an ordinary recovery.
 *
 * **Three conditions in the `WHERE`, and the last two are the point.** Only a
 * `Revoked` row is touched, so restoring somebody who was never revoked writes
 * nothing and the command can say so rather than inventing an audit row for an
 * event that did not happen (R16, second order). And `identifier IS NOT NULL`
 * refuses to promote a chat that never signed in: `/revoke` cannot reach one
 * either, but a restore that could write `Verified` onto a chat with no roster
 * identity would be this command granting access rather than returning it.
 *
 * It touches nothing else — not `identifier`, not `region_override`, not the
 * privacy-acceptance columns. Restoring somebody undoes one act; it does not
 * re-run their sign-in.
 *
 * One statement, like every other case and teacher write in this stage, because
 * the chat lock is the *sender's* and two staff members acting at once hold two
 * different locks (R2).
 */
export async function restoreTeacher(
  db: Database,
  chatId: string,
  actor: string,
): Promise<boolean> {
  const result = await db
    .update(teachers)
    .set({ verificationState: 'Verified', revokedAt: null, revokedBy: null })
    .where(
      and(
        eq(teachers.chatId, chatId),
        eq(teachers.verificationState, 'Revoked'),
        isNotNull(teachers.identifier),
      ),
    )
    .returning({ chatId: teachers.chatId });

  /**
   * The audit row is written here rather than by the command, and only when the
   * statement above actually changed a row. That is what makes R16's second
   * order structural instead of something a caller has to remember: a restore
   * that did nothing cannot leave a `TEACHER_RESTORED` row behind, whoever calls
   * it and however the command's branches are later rearranged.
   */
  if (result.length === 0) return false;

  await recordAudit(db, { actor, action: 'TEACHER_RESTORED', subject: chatId });
  return true;
}

/**
 * Every other chat that already holds this identity.
 *
 * This is the duplicate-identity signal (D1). The binding is allowed anyway —
 * blocking it would lock out a teacher who changed phone, and would let anyone
 * holding a leaked recruitment email lock the real teacher out permanently — so
 * what this returns is who to tell, not whether to proceed.
 *
 * Revoked chats are included deliberately: a revoked holder re-appearing under a
 * new chat id is exactly the case somebody should look at.
 */
export async function findOtherHolders(
  db: Database,
  identifier: string,
  exceptChatId: string,
): Promise<string[]> {
  const rows = await db
    .select({ chatId: teachers.chatId })
    .from(teachers)
    .where(
      and(
        eq(teachers.identifier, identifier),
        ne(teachers.chatId, exceptChatId),
        isNotNull(teachers.identifier),
      ),
    );
  return rows.map((r) => r.chatId);
}

export interface BindRequest {
  readonly chatId: string;
  readonly identifier: string;
  readonly name: string;
  readonly region: string | null;
  readonly privacyNoticeVersion: string;
  /**
   * The retention periods stated by the notice this teacher just read.
   *
   * Required, not optional. Signing in *is* an acceptance — the prompt says
   * replying means you have read the notice above — so a teacher bound without
   * these would be asked to re-accept on their very next tap, having accepted
   * moments earlier. This is R11's shape one column-set along: `bindTeacher`'s
   * `set` object is where a field gets forgotten.
   */
  readonly privacyAcceptedPeriods: RetentionPeriods;
}

/**
 * Bind a chat to a roster identity, recording the privacy acceptance in the same
 * statement.
 *
 * The acceptance is not a separate write on purpose. A teacher who ended up
 * Verified with no recorded acceptance would make the column prove nothing, and
 * two writes are two chances for the second to be skipped.
 *
 * `region` is copied from the roster here because this is the only moment it is
 * ever captured. Stage 4's entire regional permission model reads
 * `teachers.region`; omitting it would make half of that stage structurally dead
 * on arrival.
 *
 * Timestamps come from `now()` rather than the Node clock, so the database is
 * the single authority on when this happened.
 */
export async function bindTeacher(db: Database, request: BindRequest): Promise<void> {
  const bound = {
    identifier: request.identifier,
    name: request.name,
    region: request.region,
    verificationState: 'Verified' as const,
    privacyNoticeAcceptedAt: sql`now()`,
    privacyNoticeVersion: request.privacyNoticeVersion,
    privacyAcceptedCaseDays: request.privacyAcceptedPeriods.caseDays,
    privacyAcceptedUrgentCaseDays: request.privacyAcceptedPeriods.urgentCaseDays,
    privacyAcceptedMessageDays: request.privacyAcceptedPeriods.messageDays,
    lastSeen: sql`now()`,
    /** A previously revoked chat that verifies again is active once more. */
    revokedAt: null,
    revokedBy: null,
  };

  await db
    .insert(teachers)
    .values({ chatId: request.chatId, ...bound })
    .onConflictDoUpdate({ target: teachers.chatId, set: bound });
}
