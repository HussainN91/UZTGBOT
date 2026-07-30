/**
 * The deletion pass — the most dangerous code in this system.
 *
 * Every function here destroys records and nothing undoes any of it. Three rules
 * hold throughout and each one is a fault if it slips:
 *
 *   **An unset period deletes nothing.** Not a default, not a fallback. Every
 *   function takes its period as an argument and returns 0 without touching the
 *   database when it is `null` (plan D30). `parsePeriod` is what turns a zero,
 *   a typo and a missing row all into that same `null`.
 *
 *   **One statement each.** This runs in the worker with no chat lock at all, so
 *   a read-then-delete would race a staff member closing a case. R2's argument,
 *   with more force than anywhere it has been made before.
 *
 *   **Nothing here takes a case reference, and that is deliberate.** Deleting is
 *   not a `service.ts` operation (D35). `service.ts` is the one write path for
 *   *fields on a case* and every function there takes a reference — a delete
 *   that took one would be reachable from a command, and a command that can
 *   delete a case by reference is a command that deletes the wrong case, with
 *   `case_notes` cascading out from under it. These take periods and a database,
 *   and one job calls them.
 *
 * What is deliberately **not** here: `audit_log`, `announcements`,
 * `urgent_codes`, `job_runs` and `case_sequences`. The first three are
 * audit-class — who granted access, what the ministry told teachers, and who
 * authorised an emergency — and the last two are bounded and load-bearing. See
 * the plan's D33 table for the reasoning on each, and R30 for why the sequence
 * table in particular must survive a deletion.
 *
 * `processed_updates` is pruned by `pruneProcessedUpdates` in `telegram/dedup.ts`,
 * which has existed since stage 2 with a test and no caller. It is not moved
 * here: it belongs beside `claimUpdate`, which is the other half of the same
 * idea, and the *job* composes both rather than this module importing a layer
 * above it (D36).
 */
import { sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import type { RetentionPeriods } from '../config/retention.js';

/**
 * Resolved cases past their period, and the notes that cascade with them.
 *
 * **One statement covering both periods**, not two. Two would leave a window in
 * which the ordinary period had been applied and the urgent one had not —
 * harmless in effect and impossible to reason about from a log line.
 *
 * The `importance` half is the whole point (D22, R13). A case marked `Critical`
 * that gets resolved becomes `Completed`, and nothing about `Completed`
 * remembers it was ever an emergency: a job reading `status` would delete
 * exactly the cases most worth keeping, at the shortest interval, and nobody
 * would notice for six months.
 *
 * `closed_at IS NOT NULL` is what keeps an unresolved case for ever, however old
 * it is — and it is a real column with a real writer rather than an end date
 * inferred from a status history nobody keeps.
 */
export async function deleteResolvedCases(
  db: Database,
  periods: RetentionPeriods,
): Promise<number> {
  const { caseDays, urgentCaseDays } = periods;
  if (caseDays === null && urgentCaseDays === null) return 0;

  /**
   * Each branch is dropped entirely when its period is unset, rather than
   * defaulted. The likeliest real misconfiguration is one key seeded and the
   * other mistyped, and the correct behaviour there is to honour the one that
   * was set and keep everything the other governs.
   */
  const ordinary =
    caseDays === null
      ? sql`false`
      : sql`(importance = 'Normal' AND closed_at < now() - make_interval(days => ${caseDays}))`;

  const urgent =
    urgentCaseDays === null
      ? sql`false`
      : sql`(importance <> 'Normal' AND closed_at < now() - make_interval(days => ${urgentCaseDays}))`;

  const result = await db.execute(sql`
    DELETE FROM cases
    WHERE closed_at IS NOT NULL AND (${ordinary} OR ${urgent})
  `);

  return result.rowCount ?? 0;
}

/**
 * The interaction log.
 *
 * Three days is three days for every row — no exemptions and no per-action
 * carve-outs (D28). A retention rule with a list of things it does not apply to
 * is a rule nobody can state in one sentence, and the privacy notice has to
 * state it in one sentence.
 */
export async function deleteOldMessages(db: Database, messageDays: number | null): Promise<number> {
  if (messageDays === null) return 0;

  const result = await db.execute(sql`
    DELETE FROM messages WHERE at < now() - make_interval(days => ${messageDays})
  `);
  return result.rowCount ?? 0;
}

/**
 * Abandoned conversations, long after they stopped meaning anything.
 *
 * `AwaitingQuestionTopic` stores the teacher's typed question in `payload`, so
 * this table holds the same class of content as `messages` and goes on the same
 * period. Nothing has ever deleted a row: D4 deliberately has no sweeper,
 * because expiry is enforced on every read and a sweeper would have made stage 3
 * quietly broken until stage 5 shipped.
 *
 * **Only rows already past `expires_at`, and only long past it.** An expired
 * state is already invisible to the router, so deleting one changes no behaviour
 * at all — but a teacher part-way through an urgent case holds a state with a
 * 24-hour life, and deleting that costs them a spent single-use code and
 * everything they had typed (R25). Measuring from `expires_at` rather than
 * `updated_at` is what makes that impossible rather than unlikely.
 */
export async function pruneConversationStates(
  db: Database,
  messageDays: number | null,
): Promise<number> {
  if (messageDays === null) return 0;

  const result = await db.execute(sql`
    DELETE FROM conversation_states
    WHERE expires_at IS NOT NULL
      AND expires_at < now() - make_interval(days => ${messageDays})
  `);
  return result.rowCount ?? 0;
}

/**
 * Wrong urgent-code guesses.
 *
 * A chat id and a timestamp per wrong guess, meaningful only inside a 60-minute
 * window, and nothing has ever removed one. The cap heals on its own because the
 * *query* is windowed; the rows are not.
 */
export async function pruneUrgentCodeAttempts(
  db: Database,
  messageDays: number | null,
): Promise<number> {
  if (messageDays === null) return 0;

  const result = await db.execute(sql`
    DELETE FROM urgent_code_attempts WHERE at < now() - make_interval(days => ${messageDays})
  `);
  return result.rowCount ?? 0;
}

/**
 * Teacher email addresses in the sync log.
 *
 * The row is kept and the jsonb is emptied, which is unlike everything else in
 * this file and is the right shape here. `sync_runs` is the operational history
 * of every sync including the ones that refused to run, and that history is
 * worth keeping — but `Rejection.value` holds the teacher's recruitment email
 * for a duplicate or malformed roster row, the sync runs every ten minutes, and
 * nothing has ever deleted a row. One bad spreadsheet line therefore writes that
 * address into 144 rows a day until somebody fixes the sheet (R24).
 *
 * `rows_rejected` is a separate count column, so the signal an operator actually
 * reads survives the scrub intact.
 *
 * The `<> '[]'` guard is not an optimisation: without it every nightly run
 * reports rewriting rows it did not change, and a count nobody can trust is a
 * count nobody reads.
 */
export async function scrubSyncRunRejections(
  db: Database,
  messageDays: number | null,
): Promise<number> {
  if (messageDays === null) return 0;

  const result = await db.execute(sql`
    UPDATE sync_runs
    SET rejections = '[]'::jsonb
    WHERE started_at < now() - make_interval(days => ${messageDays})
      AND rejections <> '[]'::jsonb
  `);
  return result.rowCount ?? 0;
}

/**
 * Per-recipient delivery rows, once an announcement is long finished.
 *
 * The `announcements` row itself is **never** pruned — it is the record of what
 * the ministry told teachers, it contains no teacher's words, and it is
 * audit-class by the same argument as `audit_log`. What goes is the 1,800 chat
 * ids beside it, which after a month answer no question anybody asks.
 *
 * `finished_at IS NOT NULL` is load-bearing: those rows are what make a restart
 * mid-broadcast resume rather than repeat, so deleting them from a send still in
 * flight would message people twice.
 *
 * Its period is a constant rather than a setting, because it governs
 * operational bookkeeping rather than anything the privacy notice states.
 */
/**
 * Take the email off a form submission once its case is gone — D44.
 *
 * **Anonymises; never deletes.** That distinction is the whole function, and
 * getting it the other way round would be a slow disaster rather than a bug.
 *
 * `form_submissions` is what stops a submission being filed twice. The bot reads
 * the whole responses tab every ten minutes, and Google's sheet keeps row 42 for
 * ever, so the marker is the only thing that says "row 42 has been dealt with".
 * Delete the marker and row 42 looks new again — a fresh case, every ten
 * minutes, for the life of the system.
 *
 * So what goes is the address, which is the entire personal content of the row.
 * What stays is `("PASSPORT", 42, Filed)`, which identifies nobody.
 *
 * Two ways a row qualifies:
 *
 *   `Filed` with no `case_reference` — the case it created has been purged, and
 *   `ON DELETE SET NULL` is what left the marker behind rather than taking it.
 *
 *   Anything else, past the ordinary case period — an unmatched submission or
 *   one from a teacher who never signed in. It never became a case, so nothing
 *   else will ever clear it, and it must not sit there indefinitely.
 *
 * Returns 0 and touches nothing when the period is unset (D30). Safe: with no
 * period, no case is ever purged, so no `Filed` marker loses its reference
 * either.
 */
export async function anonymiseFormSubmissions(
  db: Database,
  caseDays: number | null,
): Promise<number> {
  if (caseDays === null) return 0;

  const result = await db.execute(sql`
    UPDATE form_submissions
    SET submitter_email = NULL
    WHERE submitter_email IS NOT NULL
      AND case_reference IS NULL
      AND (outcome = 'Filed' OR seen_at < now() - make_interval(days => ${caseDays}))
  `);
  return result.rowCount ?? 0;
}

export async function pruneAnnouncementRecipients(db: Database, days: number): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM announcement_recipients
    WHERE announcement_id IN (
      SELECT id FROM announcements
      WHERE finished_at IS NOT NULL AND finished_at < now() - make_interval(days => ${days})
    )
  `);
  return result.rowCount ?? 0;
}
