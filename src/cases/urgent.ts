/**
 * Urgent cases, and the one-time codes that open them. Implements D5.
 *
 * The whole design turns on one statement:
 *
 *     UPDATE urgent_codes SET used_at = now(), ...
 *     WHERE code = $1 AND used_at IS NULL AND expires_at > now()
 *
 * It can succeed exactly once, whoever runs it and however many run at the same
 * moment. `CONCERNS-AND-IT-ACTIONS.md` B8 recorded that consuming the code at
 * case-creation time — where it belongs — was blocked because it "opens a
 * double-use race". Against a real database it does not, so B8's stated blocker
 * is simply no longer true. That is a capability that became available when the
 * spreadsheet went away, and nobody had noticed.
 *
 * What it buys the teacher: a code is spent when their case is filed, not when
 * they type the code. Someone who gives up halfway keeps their code instead of
 * having to telephone a Regional admin for another one.
 *
 * What it cost, and this is the part no document mentioned: Apps Script deleted
 * a code whether the guess was right or wrong (`AdminCommands.gs:1261`), so a
 * wrong guess destroyed the thing being guessed at. A conditional update leaves
 * a wrong code alone, which makes guessing free — hence the cap below.
 *
 * Nothing here takes a lock or opens a transaction. `fileUrgentCase` is a
 * read-then-write and runs inside `withChatLock`, which is already a
 * transaction — one lock, taken in one place.
 */
import { sql } from 'drizzle-orm';
import {
  URGENT_CASE_CATEGORY,
  URGENT_CODE_ATTEMPT_WINDOW_MINUTES,
  URGENT_CODE_MAX_ATTEMPTS,
  URGENT_CODE_STRANDED_AFTER_MINUTES,
  TIMEZONE,
} from '../config/constants.js';
import type { Database } from '../db/index.js';
import { log } from '../log.js';
import type { Alerter } from '../sync/alerts.js';
import { appendUrgentFollowUp, createCase } from './service.js';

/**
 * Codes are matched case-insensitively and without surrounding space.
 *
 * `AdminCommands.gs:1237` did the same, and it matters more than it looks: the
 * code is read aloud over the telephone by a Regional admin to a teacher who
 * then types it on a phone keyboard that capitalises the first letter for them.
 */
export function normaliseUrgentCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export type UrgentCodeCheck =
  | { readonly kind: 'accepted'; readonly code: string }
  /** Wrong, spent, or expired — deliberately indistinguishable. See below. */
  | { readonly kind: 'rejected'; readonly attempts: number; readonly attemptsRemaining: number }
  | { readonly kind: 'lockedOut'; readonly retryAfterMinutes: number };

/**
 * Check a code without spending it.
 *
 * Wrong, already used and expired are one outcome on purpose. Telling a teacher
 * "that code exists but has been used" tells anyone guessing that they have
 * found a real code, which is the single most useful thing a guesser can learn.
 *
 * This is the *only* place a wrong code is counted. Checking is what a guesser
 * does; spending is what a teacher does, and by then the code has already been
 * accepted once.
 */
export async function checkUrgentCode(
  db: Database,
  chatId: string,
  rawCode: string,
): Promise<UrgentCodeCheck> {
  const attemptsSoFar = await countRecentAttempts(db, chatId);
  if (attemptsSoFar >= URGENT_CODE_MAX_ATTEMPTS) {
    return { kind: 'lockedOut', retryAfterMinutes: URGENT_CODE_ATTEMPT_WINDOW_MINUTES };
  }

  const code = normaliseUrgentCode(rawCode);
  const found = await db.execute<{ code: string }>(sql`
    SELECT code FROM urgent_codes
    WHERE code = ${code} AND used_at IS NULL AND expires_at > now()
  `);

  if (found.rows.length > 0) {
    // A correct code clears the chat's failures. Someone who mistyped four
    // times and then got it right is not one guess away from a lockout.
    await db.execute(sql`DELETE FROM urgent_code_attempts WHERE chat_id = ${chatId}`);
    return { kind: 'accepted', code };
  }

  await db.execute(sql`INSERT INTO urgent_code_attempts (chat_id) VALUES (${chatId})`);
  const attempts = attemptsSoFar + 1;
  return {
    kind: 'rejected',
    attempts,
    attemptsRemaining: Math.max(0, URGENT_CODE_MAX_ATTEMPTS - attempts),
  };
}

async function countRecentAttempts(db: Database, chatId: string): Promise<number> {
  const rows = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM urgent_code_attempts
    WHERE chat_id = ${chatId}
      AND at > now() - make_interval(mins => ${URGENT_CODE_ATTEMPT_WINDOW_MINUTES})
  `);
  return rows.rows[0]?.count ?? 0;
}

/**
 * Spend a code, naming the case it was spent on.
 *
 * The `WHERE` clause is the entire single-use guarantee, and the expiry check is
 * in the same statement rather than read first and trusted (D4). Returns false
 * when the code is not spendable, whatever the reason.
 */
async function consumeUrgentCode(
  db: Database,
  code: string,
  chatId: string,
  caseReference: string,
): Promise<boolean> {
  const result = await db.execute<{ code: string }>(sql`
    UPDATE urgent_codes
    SET used_at = now(), used_by = ${chatId}, case_reference = ${caseReference}
    WHERE code = ${code} AND used_at IS NULL AND expires_at > now()
    RETURNING code
  `);
  return result.rows.length > 0;
}

export interface UrgentFilingResult {
  readonly reference: string;
  /** False when an open case in this category already existed. */
  readonly isNew: boolean;
  /**
   * Whether the code was actually spent on this case.
   *
   * False is rare and always worth an alarm: the code was good when the teacher
   * typed it and is not good now. The case is still filed — see below.
   */
  readonly escalated: boolean;
}

/**
 * File an urgent case and spend the code, or neither.
 *
 * Runs inside the caller's transaction, so the case and the consumption commit
 * together. That is the whole of D5: there is no window in which a code is spent
 * and no case exists, and none in which a case is escalated without the code
 * being spent.
 *
 * **The deduplicated path spends the code too.** It is not an edge case: urgent
 * cases have no topic picker, so every one of them files under the general
 * category, and so does every ordinary Contact Support case — a teacher who
 * opened one yesterday will always deduplicate against it. What the code buys is
 * attention on the teacher's problem, and the existing case gets it: the urgent
 * words are appended and the case is escalated. Spending the code only on an
 * insert gives urgent escalations away free on the commonest path there is, and
 * it is the easiest thing in this stage to get silently wrong.
 *
 * **When the code will not spend, the case is still filed.** The teacher typed
 * an emergency; throwing it away because their code expired in the hours between
 * accepting it and describing the problem punishes them for our timing. They get
 * an ordinary case and are told plainly that the escalation did not apply, which
 * is recoverable — `escalated: false` is also an alarm, because a code that
 * validated and then would not spend means either it straddled its expiry or two
 * chats are holding the same code.
 */
export async function fileUrgentCase(
  db: Database,
  request: { readonly chatId: string; readonly code: string; readonly detail: string },
): Promise<UrgentFilingResult> {
  const result = await createCase(db, {
    chatId: request.chatId,
    category: URGENT_CASE_CATEGORY,
    detail: request.detail,
    escalate: true,
  });

  if (!result.isNew) {
    await appendUrgentFollowUp(db, result.reference, request.detail, request.chatId);
  }

  const escalated = await consumeUrgentCode(
    db,
    normaliseUrgentCode(request.code),
    request.chatId,
    result.reference,
  );

  return { reference: result.reference, isNew: result.isNew, escalated };
}

export interface StrandedCode {
  readonly code: string;
  readonly usedBy: string | null;
  /**
   * Formatted in Tashkent by the database, not a `Date`.
   *
   * `db.execute` hands back the raw string PostgreSQL sent — drizzle installs
   * its own type parsers, so it does not parse timestamps the way `pool.query`
   * does. Formatting in SQL means the value is never a `Date` that only looks
   * like one, and the person reading the alert gets their own clock.
   */
  readonly usedAt: string;
}

/**
 * Alert on any code that was spent without buying a case.
 *
 * Under D5 this cannot happen — the consumption and the insert are one
 * transaction — which is exactly why it is worth watching. A row here means
 * something consumed a code outside `fileUrgentCase`, and the teacher who spent
 * it is sitting with no case and no reason to think anything went wrong. That is
 * invisible from every other angle: no error is raised, no job fails, and the
 * teacher's silence looks like satisfaction.
 */
export async function checkStrandedUrgentCodes(
  db: Database,
  alerter: Alerter,
): Promise<StrandedCode[]> {
  const result = await db.execute<{ code: string; used_by: string | null; used_at: string }>(sql`
    SELECT code, used_by,
           to_char(used_at AT TIME ZONE ${TIMEZONE}, 'YYYY-MM-DD HH24:MI') AS used_at
    FROM urgent_codes
    WHERE used_at IS NOT NULL
      AND case_reference IS NULL
      AND used_at < now() - make_interval(mins => ${URGENT_CODE_STRANDED_AFTER_MINUTES})
  `);

  const stranded: StrandedCode[] = result.rows.map((r) => ({
    code: r.code,
    usedBy: r.used_by,
    usedAt: r.used_at,
  }));

  for (const item of stranded) {
    log.error({ code: item.code, chatId: item.usedBy }, 'urgent code spent with no case');
  }

  if (stranded.length > 0) {
    await alerter.send({
      severity: 'critical',
      title: `${stranded.length} urgent code(s) spent without opening a case`,
      body: [
        'A teacher gave up a single-use code and has no case to show for it.',
        'This should be impossible: the code and the case are written in one transaction,',
        'so something has consumed a code outside src/cases/urgent.ts.',
        '',
        ...stranded.map((s) => `${s.code} — chat ${s.usedBy ?? 'unknown'}, spent ${s.usedAt} (Tashkent)`),
        '',
        'Contact each teacher; their emergency has not reached anyone.',
      ].join('\n'),
    });
  }

  return stranded;
}
