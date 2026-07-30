/**
 * What each teacher agreed to, and when.
 *
 * Stage 3 wrote `privacy_notice_accepted_at` and `privacy_notice_version` at
 * sign-in and **nothing has ever read either of them.** They were built for
 * this: the moment the notice changes, the only way to know who has seen the new
 * one is to have recorded what they saw of the old one.
 *
 * Four values, not one. The wording version alone cannot see a settings change —
 * and a settings change is precisely how the notice's text moves now, with no
 * deploy and no review (plan D28, R20). The periods alone cannot see a rewritten
 * paragraph. `requiresReconsent` in `config/retention.ts` reads all four and
 * holds the rule; this file only stores and fetches.
 */
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { PrivacyAcceptance, RetentionPeriods } from '../config/retention.js';
import type { Database } from '../db/index.js';
import { teachers } from '../db/schema.js';

/**
 * What this teacher accepted, or `null` when nothing was ever recorded.
 *
 * `null` covers two situations that are the same to the caller: a chat with no
 * teacher row at all, and a teacher bound before these columns existed. Both
 * mean "we cannot show that they agreed to anything", and inventing an
 * acceptance for either would be worse than admitting it.
 *
 * A row with a version but no periods is the second case and is returned with
 * all three as `null` — which `requiresReconsent` reads as "accepted while
 * everything was kept indefinitely", the honest reading of the notice they were
 * actually shown.
 */
export async function privacyAcceptance(
  db: Database,
  chatId: string,
): Promise<PrivacyAcceptance | null> {
  const rows = await db
    .select({
      version: teachers.privacyNoticeVersion,
      caseDays: teachers.privacyAcceptedCaseDays,
      urgentCaseDays: teachers.privacyAcceptedUrgentCaseDays,
      messageDays: teachers.privacyAcceptedMessageDays,
    })
    .from(teachers)
    .where(eq(teachers.chatId, chatId))
    .limit(1);

  const row = rows[0];
  if (row === undefined || row.version === null) return null;

  return {
    version: row.version,
    periods: {
      caseDays: row.caseDays,
      urgentCaseDays: row.urgentCaseDays,
      messageDays: row.messageDays,
    },
  };
}

/**
 * Record an acceptance — all five columns, in one statement.
 *
 * One statement because a teacher left with a version and no periods, or periods
 * and no version, is a record that cannot answer the question it exists for.
 *
 * The timestamp comes from `now()` rather than the Node clock, so the database
 * stays the single authority on when somebody agreed to something. That matters
 * more here than anywhere else in the system: this row is the answer to "on what
 * date did this person accept these terms".
 */
export async function recordAcceptance(
  db: Database,
  chatId: string,
  version: string,
  periods: RetentionPeriods,
): Promise<boolean> {
  const result = await db
    .update(teachers)
    .set({
      privacyNoticeAcceptedAt: sql`now()`,
      privacyNoticeVersion: version,
      privacyAcceptedCaseDays: periods.caseDays,
      privacyAcceptedUrgentCaseDays: periods.urgentCaseDays,
      privacyAcceptedMessageDays: periods.messageDays,
    })
    .where(eq(teachers.chatId, chatId))
    .returning({ chatId: teachers.chatId });

  return result.length > 0;
}
