/**
 * Reading and writing the roster and the teachers bound to it.
 *
 * Uses the typed query builder rather than raw SQL, which is the point of
 * `db/index.ts`: a column rename breaks compilation at every call site here,
 * rather than failing quietly at runtime the way a renamed spreadsheet column
 * used to.
 */
import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { rosterEntries, teachers } from '../db/schema.js';

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
}

export async function findTeacher(db: Database, chatId: string): Promise<TeacherRecord | null> {
  const rows = await db
    .select({
      chatId: teachers.chatId,
      identifier: teachers.identifier,
      verificationState: teachers.verificationState,
      region: teachers.region,
      revokedAt: teachers.revokedAt,
    })
    .from(teachers)
    .where(eq(teachers.chatId, chatId))
    .limit(1);
  return rows[0] ?? null;
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
