/**
 * Anonymising a teacher who has asked to be removed.
 *
 * The privacy notice promises removal on request, and `cases.teacher_chat_id` is
 * `ON DELETE restrict` — deliberately, because it guarantees no case exists
 * without a real person behind it. Those two look like a contradiction and were
 * logged as one (`CONCERNS` A11). They are not: the constraint refuses to delete
 * a **teacher who has cases**, and it never blocked deleting a case. Replacing
 * the person and keeping the history satisfies both, which is what was agreed on
 * 29 July (design decision 8).
 *
 * **What this cannot remove, stated here rather than only in the runbook**,
 * because whoever runs the command has to be able to tell a teacher what
 * "removed" means:
 *
 *   The Telegram chat id survives. Every one of that teacher's cases points at
 *   it, and it is the primary key of the row those cases reference.
 *
 *   What they wrote in their cases survives, because the case history is the
 *   thing decision 8 keeps. Retention closes that on its own — a resolved case
 *   goes after its period without anybody acting — so this gap shrinks to
 *   nothing over time rather than staying open.
 *
 * Nobody should be told "removed" and understand something stronger than that.
 *
 * **One function, not one command.** The resignation route (design decision 9)
 * anonymises automatically three months after a teacher resigns, and it calls
 * this. Writing the logic inside `/forget` would mean writing it twice.
 *
 * No transaction is opened here, for the reason `verifyIdentifier` states: this
 * runs under `withChatLock`, which is already a transaction, and opening another
 * would be a savepoint pretending to be a commit.
 */
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { cases, conversationStates, messages, teachers } from '../db/schema.js';
import { recordAudit } from '../log/audit.js';
import { OPEN_CASE_STATUSES } from '../db/schema.js';
import { inArray } from 'drizzle-orm';

export type ForgetOutcome =
  /** No teacher row at all. A typo'd chat id, most likely. */
  | { readonly kind: 'notFound' }
  /**
   * The row is here and has already been anonymised.
   *
   * Distinguished from `notFound` so the command can say which it met. Reporting
   * "no such teacher" for somebody who *was* removed last month invites a second
   * search for a row that is doing exactly what it should.
   */
  | { readonly kind: 'alreadyForgotten' }
  | {
      readonly kind: 'forgotten';
      /** Open cases left behind, reported for the same reason `/revoke` reports them (R5). */
      readonly openCases: number;
      readonly messagesDeleted: number;
    };

/**
 * Replace the person, keep the history.
 *
 * The order matters in one place only: the identifier is cleared in the same
 * statement as everything else, so there is no moment at which the row is
 * half-anonymised and visible to a concurrent read.
 */
export async function forgetTeacher(
  db: Database,
  chatId: string,
  actor: string,
): Promise<ForgetOutcome> {
  const existing = await db
    .select({ identifier: teachers.identifier, name: teachers.name })
    .from(teachers)
    .where(eq(teachers.chatId, chatId))
    .limit(1);

  const row = existing[0];
  if (row === undefined) return { kind: 'notFound' };
  if (row.identifier === null && row.name === null) return { kind: 'alreadyForgotten' };

  const open = await db
    .select({ count: sql<string>`count(*)` })
    .from(cases)
    .where(
      sql`${cases.teacherChatId} = ${chatId} AND ${inArray(cases.status, [...OPEN_CASE_STATUSES])}`,
    );
  const openCases = Number(open[0]?.count ?? 0);

  /**
   * `Revoked` as well as anonymised, and that is not merely tidy. A row with no
   * identifier would fail `teacherHasAccess` anyway — it has no roster row to
   * re-check — but leaving the state as `Verified` would mean the *reason* they
   * cannot use the bot is invisible, and `/restore` would report success while
   * changing nothing that matters.
   */
  await db
    .update(teachers)
    .set({
      identifier: null,
      name: null,
      region: null,
      regionOverride: null,
      regionSetBy: null,
      regionSetAt: null,
      regionFlaggedAt: null,
      regionAskedAt: null,
      verificationState: 'Revoked',
      revokedAt: sql`now()`,
      revokedBy: actor,
      privacyNoticeAcceptedAt: null,
      privacyNoticeVersion: null,
      privacyAcceptedCaseDays: null,
      privacyAcceptedUrgentCaseDays: null,
      privacyAcceptedMessageDays: null,
    })
    .where(eq(teachers.chatId, chatId));

  /**
   * Their own words, which are theirs and are not case history.
   *
   * The interaction log holds what this person typed; the cases hold the problem
   * they reported, which is the record decision 8 keeps. Removal has to reach
   * the first even though it cannot reach the second.
   */
  const deleted = await db.delete(messages).where(eq(messages.chatId, chatId));
  await db.delete(conversationStates).where(eq(conversationStates.chatId, chatId));

  /**
   * The audit row stays, and its `subject` is the chat id rather than a name.
   *
   * `audit_log` is never pruned (D28) and "who ended this person's record, and
   * when" is exactly the question it exists to answer — including for this act,
   * which is the least reversible thing anybody can do in this system.
   */
  await recordAudit(db, {
    actor,
    action: 'TEACHER_FORGOTTEN',
    subject: chatId,
    detail: { openCases },
  });

  return { kind: 'forgotten', openCases, messagesDeleted: deleted.rowCount ?? 0 };
}
