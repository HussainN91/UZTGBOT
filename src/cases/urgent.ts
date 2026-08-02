/**
 * Asking for a case to be treated as urgent, and the decision that grants it.
 *
 * **This replaced the one-time code entirely on 1 August 2026.** The old design
 * rationed *speech*: a teacher had to telephone a Regional admin, be read a
 * six-character code, and type it before they were allowed to describe their
 * problem at all. Everything in this file that generated, checked, spent and
 * audited those codes is gone, along with the two states a teacher could get
 * stuck in and the alarm for a code spent without a case.
 *
 * What replaced it rations *priority* instead:
 *
 *   1. The teacher describes the problem. Nothing is in their way.
 *   2. The case is filed at `Normal` and stamped `urgent_requested_at`.
 *   3. A regional coordinator is told, and decides.
 *   4. On confirmation the case becomes `Urgent` and everybody who needs to know
 *      is told.
 *
 * Three properties are load-bearing:
 *
 *   **A pending request is `Normal`, not `Urgent`.** Retention keys off
 *   `importance` and keeps urgent cases for six months against the ordinary
 *   week, so a request that stamped the marker on the way in would let anybody
 *   grant themselves half a year of retention by tapping a button. The marker is
 *   what the coordinator's judgement buys, and it is written in exactly one
 *   place: `confirmUrgentRequest`.
 *
 *   **Deduplication is the common path, not an edge case.** Urgent requests file
 *   under Contact Support because they have no topic picker, and so does every
 *   ordinary Contact Support case — so a teacher who opened one yesterday will
 *   always deduplicate against it. The words are appended to that case and the
 *   request is stamped on *it*. Splitting would fragment one problem across two
 *   references and give staff two things to work.
 *
 *   **Nothing here sends anything.** It returns what happened; layer 3 turns
 *   that into messages. `notify.ts` computes the recipients.
 *
 * Nothing takes a lock. `requestUrgentCase` is a read-then-write and runs inside
 * `withChatLock`, which is already a transaction — one lock, taken in one place.
 */
import { sql } from 'drizzle-orm';
import { TIMEZONE, URGENT_CASE_CATEGORY } from '../config/constants.js';
import type { Database } from '../db/index.js';
import type { CaseStatus } from '../db/schema.js';
import { recordAudit } from '../log/audit.js';
import { createCase } from './service.js';

export interface UrgentRequest {
  readonly chatId: string;
  /** The teacher's own words. Stored, never echoed back, never logged. */
  readonly detail: string;
}

export interface UrgentRequestResult {
  readonly reference: string;
  /** False when an open case in this category already existed and was appended to. */
  readonly isNew: boolean;
  /**
   * The case was already `Urgent` or `Critical` before this arrived.
   *
   * The teacher's words are still appended — they are new information about a
   * live problem — but nobody is notified a second time and the teacher is told
   * plainly that it is already escalated. Re-notifying here is how a coordinator
   * learns that the confirm button means nothing.
   */
  readonly alreadyUrgent: boolean;
  /**
   * A request was already pending on this case when this one arrived.
   *
   * Distinct from `alreadyUrgent`: this is "you have asked and nobody has
   * decided yet", which is a different sentence to the teacher and, for the
   * coordinator, a reason not to send a second identical message.
   */
  readonly alreadyRequested: boolean;
}

/**
 * File — or append to — a case, and record that priority was asked for.
 *
 * `createCase` is called without `escalate`, deliberately and against the shape
 * of the old code. The flag files at `Escalated`/`Urgent` in one insert, which
 * is exactly what must not happen before a person has agreed to it.
 *
 * Returns without stamping anything when the case is already urgent, so a
 * confirmed case cannot have its decision clock reset by a teacher writing in
 * again.
 */
export async function requestUrgentCase(
  db: Database,
  request: UrgentRequest,
): Promise<UrgentRequestResult> {
  const result = await createCase(db, {
    chatId: request.chatId,
    category: URGENT_CASE_CATEGORY,
    detail: request.detail,
  });

  /**
   * One statement, and every answer this function needs comes out of it.
   *
   * Written as a conditional `UPDATE` rather than a read followed by a write
   * because two staff commands on one case take two different chat locks, and
   * anything read-modify-write between them races (R2).
   *
   * **The `before` sub-select is not tidiness.** `RETURNING` yields the row
   * *after* the write, so `urgent_requested_at IS NOT NULL` in that clause would
   * be true because this statement had just made it true — the question "was one
   * already pending" would answer itself, every time. A sub-query in `FROM` is
   * evaluated against the pre-update snapshot, which is the only way to get the
   * old values out in one statement; `clearUsername` records the same trap,
   * where it made a cleared handle unreportable.
   */
  const stamped = await db.execute<{ already_urgent: boolean; already_requested: boolean }>(sql`
    UPDATE cases
    SET urgent_requested_at = CASE
          WHEN cases.importance = 'Normal' AND cases.urgent_requested_at IS NULL THEN now()
          ELSE cases.urgent_requested_at
        END,
        updated_at = now()
    FROM (
      SELECT importance AS was_importance,
             urgent_requested_at AS was_requested_at,
             urgent_confirmed_at AS was_confirmed_at
      FROM cases WHERE reference = ${result.reference}
    ) AS before
    WHERE cases.reference = ${result.reference}
    RETURNING
      (before.was_importance <> 'Normal') AS already_urgent,
      (before.was_requested_at IS NOT NULL AND before.was_confirmed_at IS NULL) AS already_requested
  `);

  const row = stamped.rows[0];

  /**
   * The words are appended for an existing case, and only for an existing one —
   * a new case already holds them as its `detail`.
   *
   * Non-escalating, unlike the follow-up the code path used. `service.ts` used
   * to hold an `appendUrgentFollowUp` that appended **and** raised the status
   * and importance in one statement; it was removed with the codes, because
   * appending on this path must not raise `importance` or the request would
   * grant the very thing it is asking a coordinator to decide.
   */
  if (!result.isNew) {
    await appendUrgentRequest(db, result.reference, request.detail, request.chatId);
  }

  return {
    reference: result.reference,
    isNew: result.isNew,
    alreadyUrgent: row?.already_urgent === true,
    /**
     * Only meaningful when the case is not already urgent. A confirmed case has
     * a request stamp and a confirmation stamp, so the SQL above reports it as
     * not pending, which is correct — but `alreadyUrgent` is the sentence the
     * teacher gets either way.
     */
    alreadyRequested: row?.already_requested === true,
  };
}

/**
 * Add a teacher's later words to a case that already exists, without escalating.
 *
 * The second route by which `detail` may change after a case is filed, and like
 * the first it only ever appends. `CaseFields` deliberately cannot reach
 * `detail` — a write path that can replace a teacher's words is a write path
 * that can lose them — but dropping the words entirely is what the Apps Script
 * version did on this path (`MenuHandler.gs:302`).
 *
 * Stamped in Tashkent, by the database, for the same reason references are: a
 * follow-up written at 00:30 is dated by the clock the reader uses.
 */
async function appendUrgentRequest(
  db: Database,
  reference: string,
  detail: string,
  actor: string,
): Promise<boolean> {
  const result = await db.execute<{ reference: string }>(sql`
    UPDATE cases SET
      detail = detail || E'\n[' || to_char(now() AT TIME ZONE ${TIMEZONE}, 'YYYY-MM-DD HH24:MI')
             || ' URGENT REQUEST] ' || ${detail},
      updated_at = now(),
      last_actor = ${actor}
    WHERE reference = ${reference}
    RETURNING reference
  `);
  return result.rows.length > 0;
}

export type UrgentConfirmation =
  | {
      readonly kind: 'confirmed';
      readonly reference: string;
      readonly teacherChatId: string;
      /** The case's owner at the moment of confirmation, or null if unassigned. */
      readonly owner: string | null;
      /**
       * The case had been closed, and confirming has opened it again.
       *
       * Telegram keeps a button in a chat for ever, so a coordinator can tap
       * confirm long after somebody else closed the case. The tap is honoured —
       * a teacher's unanswered request outlives a close — but the coordinator is
       * told, because reopening somebody else's deliberate close is not a thing
       * that should happen quietly.
       */
      readonly reopened: boolean;
    }
  /** No such case. A button from a build that no longer exists, or a purged case. */
  | { readonly kind: 'unknown' }
  /** Nobody asked for this case to be urgent. */
  | { readonly kind: 'notRequested' }
  /** Somebody already decided. Names them, so the second tapper knows who. */
  | { readonly kind: 'alreadyConfirmed'; readonly by: string | null };

/**
 * Grant an urgent request — the one place `importance` is raised by this route.
 *
 * **Every button re-validates here, on tap, rather than trusting its payload.**
 * A callback payload is a promise about the world made when the message was
 * built, and Telegram keeps that button in a coordinator's scrollback for ever.
 * Two coordinators tapping the same message a minute apart must not produce two
 * confirmations, two audit rows and two notifications to a teacher; the
 * `urgent_confirmed_at IS NULL` guard in the `WHERE` clause is what makes the
 * second tap a no-op, and it is the same shape of single-statement guarantee the
 * one-time code used to rely on.
 *
 * The status moves to `Escalated` in the same statement, which is what puts the
 * case in `/urgent`. `updateCase` cannot express a conditional write and adding
 * a `where` to it would hand every caller a way to write a status that depends
 * on the current one — the argument `markCaseReceived` records.
 *
 * **This is the second writer of `status`, so it owes everything the first one
 * does.** `updateCase` carries a long note explaining that it clears `closed_at`
 * and restarts the teacher's chase clock on *any* status move, and that putting
 * that logic in the individual commands instead "is exactly how a reopened case
 * kept a stale `closed_at` for three stages". This function gained a conditional
 * write and lost that invariant with it: a case closed while its request was
 * still undecided came back to `Escalated` still carrying the date it ended, and
 * the nightly retention pass — which reads `closed_at` and never `status`, on
 * purpose — deleted it a week later.
 *
 * The three fields below are therefore not a nicety. They are the same three
 * `updateCase` writes, in the same statement as the status, because a status
 * written anywhere else in this codebase is written by a function that keeps
 * them together.
 *
 * The audit row is written in the same transaction as the change, never after.
 */
export async function confirmUrgentRequest(
  db: Database,
  reference: string,
  actor: string,
): Promise<UrgentConfirmation> {
  /**
   * `before` is the same trick `requestUrgentCase` uses, for the same reason.
   *
   * `RETURNING` yields the row *after* the write, and the write sets `closed_at`
   * to null — so `closed_at IS NOT NULL` in that clause would be false every
   * time and "did this reopen a closed case?" would answer itself wrongly on
   * every call. A sub-query in `FROM` is evaluated against the pre-update
   * snapshot, which is the only way to see the old value in one statement.
   *
   * It cannot change which rows are updated: it selects on the same reference,
   * so it yields exactly the row being written, or nothing at all for a
   * reference that does not exist — in which case the `WHERE` would have matched
   * nothing anyway.
   */
  const updated = await db.execute<{
    reference: string;
    teacher_chat_id: string;
    owner: string | null;
    reopened: boolean;
  }>(sql`
    UPDATE cases
    SET importance = GREATEST(importance, 'Urgent'::case_importance),
        status = 'Escalated',
        closed_at = NULL,
        teacher_chased_at = NULL,
        teacher_chase_count = 0,
        urgent_confirmed_by = ${actor},
        urgent_confirmed_at = now(),
        updated_at = now(),
        last_actor = ${actor}
    FROM (
      SELECT closed_at AS was_closed_at
      FROM cases WHERE reference = ${reference}
    ) AS before
    WHERE cases.reference = ${reference}
      AND cases.urgent_requested_at IS NOT NULL
      AND cases.urgent_confirmed_at IS NULL
    RETURNING cases.reference, cases.teacher_chat_id, cases.owner,
              (before.was_closed_at IS NOT NULL) AS reopened
  `);

  const row = updated.rows[0];
  if (row !== undefined) {
    await recordAudit(db, {
      actor,
      action: 'URGENT_CONFIRMED',
      subject: reference,
    });
    return {
      kind: 'confirmed',
      reference: row.reference,
      teacherChatId: row.teacher_chat_id,
      owner: row.owner,
      reopened: row.reopened,
    };
  }

  /**
   * The write did nothing, and the three reasons are different sentences.
   *
   * Read only on the failing path. Telling a coordinator "that case is already
   * urgent — Karimov confirmed it" costs one query on the rare branch and turns
   * a dead button into an answer; telling them nothing is how a person taps it
   * four more times.
   */
  const existing = await db.execute<{
    requested: boolean;
    confirmed_by: string | null;
    confirmed: boolean;
  }>(sql`
    SELECT urgent_requested_at IS NOT NULL AS requested,
           urgent_confirmed_by AS confirmed_by,
           urgent_confirmed_at IS NOT NULL AS confirmed
    FROM cases WHERE reference = ${reference}
  `);

  const found = existing.rows[0];
  if (found === undefined) return { kind: 'unknown' };
  if (found.confirmed) return { kind: 'alreadyConfirmed', by: found.confirmed_by };
  return { kind: 'notRequested' };
}

export interface PendingUrgentRequest {
  readonly reference: string;
  readonly teacherChatId: string;
  /**
   * How long it has been waiting, formatted by the database in Tashkent.
   *
   * Formatted in SQL rather than parsed into a `Date` and rendered here:
   * `db.execute` hands back the raw string PostgreSQL sent, because drizzle
   * installs its own type parsers and does not parse timestamps the way
   * `pool.query` does. Doing it in SQL means the value is never a `Date` that
   * only looks like one.
   */
  readonly requestedAt: string;
  /**
   * The case's status right now, which is not always one that is still open.
   *
   * A case can be closed while its request is still undecided, and that request
   * stays on this list — see the note on the query below.
   */
  readonly status: CaseStatus;
}

/**
 * Urgent requests nobody has decided.
 *
 * The plan accepts, explicitly, that a pending request waits on one regional
 * coordinator and declines to auto-escalate — auto-escalation would push every
 * frivolous request to Program anyway, which defeats the gate. Visibility is
 * what was chosen instead, so this is the query behind it, and a request that
 * nobody answers has to be findable or the accepted risk is not a risk anybody
 * can see.
 *
 * **A request on a closed case is shown, not filtered out.** The two conditions
 * here are about the *request* — asked, and not decided — and a staff member
 * closing the case does not decide it. Dropping the row would mean a teacher
 * asked for priority, nobody ever answered, and the list whose entire job is to
 * make that visible had quietly stopped mentioning it. What the row must not do
 * is look like work still waiting, which is what `status` is for: it comes back
 * with every row so the reader can tell in one glance which of these are live.
 */
export async function pendingUrgentRequests(
  db: Database,
  limit: number,
): Promise<PendingUrgentRequest[]> {
  const rows = await db.execute<{
    reference: string;
    teacher_chat_id: string;
    requested_at: string;
    /** The column is the `case_status` enum, so this is one of the eight. */
    status: CaseStatus;
  }>(sql`
    SELECT reference, teacher_chat_id, status,
           to_char(urgent_requested_at AT TIME ZONE ${TIMEZONE}, 'DD Mon YYYY, HH24:MI') AS requested_at
    FROM cases
    WHERE urgent_requested_at IS NOT NULL AND urgent_confirmed_at IS NULL
    ORDER BY urgent_requested_at ASC
    LIMIT ${limit}
  `);

  return rows.rows.map((r) => ({
    reference: r.reference,
    teacherChatId: r.teacher_chat_id,
    requestedAt: r.requested_at,
    status: r.status,
  }));
}
