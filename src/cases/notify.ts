/**
 * Who is told when a case arrives, and what they are told — D11.
 *
 * This closes the largest missing endpoint in the system. Until now a teacher
 * could describe an emergency, receive a reference number, and have **nothing
 * anywhere be told** — not a staff member, not the operations chat, not the log.
 * `createCase` returned and the case sat in a table nobody queried. Stage 3's D2
 * intended to leave "one clean seam" here; checked against the code there was no
 * seam at all, so this is built outright.
 *
 * Three properties are load-bearing and each is a fault somewhere else if it
 * slips:
 *
 *   **Recipients are filtered on `case.update`, not on visibility.** An Observer
 *   can see every case in their queue and can change none of them, so notifying
 *   one is paging somebody about work they are not permitted to do (R14). Apps
 *   Script filtered on `adminCanSeeCase_` alone (`AdminCommands.gs:353`), which
 *   was right there only because its `ReadOnly` bucket was almost always empty.
 *
 *   **Zero recipients is an alarm, not a log line.** `notifyAdminsOfNewCase_`
 *   wrote `console.error` and returned (`AdminCommands.gs:355-359`); the case
 *   then sat unseen with its only trace in a log nobody opens. A case nobody can
 *   act on is the exact failure this feature exists to prevent, so it raises a
 *   critical alert naming the category.
 *
 *   **The teacher's words are never in here.** Twenty Telegram histories is not
 *   where a teacher's account of their problem belongs (`AdminCommands.gs:325`).
 *   Staff read it with `/case`, which checks permissions and leaves a row saying
 *   who read it.
 *
 * Nothing is sent from here. The messages are returned, delivered by `deliver`
 * after the transaction commits — the same rule as the duplicate-identity
 * notice, and for the same reason: announcing something that can still roll back
 * is worse than announcing it a moment later.
 */
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { NEW_CASE_NOTIFY_CAP, TIMEZONE } from '../config/constants.js';
import type { Database } from '../db/index.js';
import { staff } from '../db/schema.js';
import { logInteraction } from '../log/interactions.js';
import { CAPABILITY, type Capability, rolesHolding } from '../staff/roles.js';
import { queuesCovering } from '../staff/queues.js';
import type { Alert } from '../sync/alerts.js';
import { regionFor } from '../teachers/region.js';
import type { OutgoingMessage } from '../telegram/router.js';
import { markCaseReceived } from './service.js';

export interface NewCaseNotice {
  readonly reference: string;
  readonly category: string;
  readonly teacherChatId: string;
  /** Filed through the urgent-code path, or escalated onto an existing case. */
  readonly urgent: boolean;
}

export interface NotificationOutcome {
  readonly messages: readonly OutgoingMessage[];
  readonly alerts: readonly Alert[];
}

/**
 * Nothing to announce.
 *
 * Used on the paths where a case already exists and staff were told about it
 * when it did: a second tap inside the 24-hour duplicate window returns the same
 * case, and paging twenty people again for it teaches them to ignore the alert.
 */
export const NO_NOTIFICATION: NotificationOutcome = { messages: [], alerts: [] };

/**
 * Announce a case to the staff who can work it.
 *
 * Runs inside the caller's transaction: the recipients are computed and the
 * status is written in the same unit as the case itself, so there is no state in
 * which a case exists at `Received` and the notification never happened.
 */
export async function notifyNewCase(
  db: Database,
  notice: NewCaseNotice,
): Promise<NotificationOutcome> {
  /**
   * Resolved through `regionFor`, never from `teachers.region`.
   *
   * That column is the snapshot `bindTeacher` wrote at sign-in, and a verified
   * teacher never signs in again — reading it here would send a corrected
   * teacher's emergency to whoever covered the region they were in last year
   * (R12). `null` is a legitimate answer and widens rather than narrows.
   */
  const region = await regionFor(db, notice.teacherChatId);

  const actors = await staffMatching(db, CAPABILITY.CASE_UPDATE, notice.category, region);

  if (actors.length === 0) {
    /**
     * Only computed when there is a problem, because it is only ever used to
     * word the alarm. "Nobody at all covers this" and "people cover it who may
     * only look at it" are different failures with different fixes — one needs a
     * staff member, the other needs a rank — and an alarm that cannot tell them
     * apart makes the reader do the diagnosis at three in the morning.
     */
    const watchers = await staffMatching(db, CAPABILITY.CASE_VIEW, notice.category, region);
    await logFanOut(db, notice, 0, 0);
    return { messages: [], alerts: [unworkableAlert(notice, region, watchers.length)] };
  }

  const chosen = actors.slice(0, NEW_CASE_NOTIFY_CAP);
  const filedAt = await filedAtInTashkent(db, notice.reference);

  /**
   * D25, step 2a. Only a case still at `New` moves — the guard is inside
   * `markCaseReceived` and it is what stops an urgent case being demoted out of
   * `Escalated`, which is what puts it in `/urgent`.
   */
  await markCaseReceived(db, notice.reference);
  await logFanOut(db, notice, chosen.length, actors.length);

  const text = noticeText(notice, region, filedAt);
  return {
    messages: chosen.map((chatId) => ({
      chatId,
      text,
      /**
       * R10. `deliver` names this in the alarm it raises when a send fails, and
       * before `purpose` existed it called every message after the first "a
       * notice about somebody else's action (a duplicate sign-in)". A staff
       * notification that failed to arrive would have been reported as the
       * wrong thing entirely.
       */
      purpose: notice.urgent ? 'an urgent case notification' : 'a new case notification',
    })),
    alerts: [],
  };
}

/**
 * Active staff who hold `capability` and whose queue and region reach this case.
 *
 * The inverse of the visibility predicate — that one asks "which cases may this
 * person see", this asks "which people may see this case" — and both read the
 * same two maps rather than restating the rule. Ordered by id so the same twenty
 * are chosen for the same case whichever way the rows happen to come back; the
 * cap is a latency bound (R9), and if it ever binds the answer is the worker,
 * not a cleverer ordering.
 */
async function staffMatching(
  db: Database,
  capability: Capability,
  category: string,
  region: string | null,
): Promise<string[]> {
  const roles = [...rolesHolding(capability)];
  const queues = [...queuesCovering(category)];
  if (roles.length === 0 || queues.length === 0) return [];

  /**
   * An unknown region reaches everybody — D10, and the branch is taken in
   * JavaScript rather than in SQL because binding a null parameter into
   * `$1 IS NULL` leaves PostgreSQL unable to infer its type.
   *
   * A staff member with no regions covers all of them (`schema.ts:281`: "Empty
   * array means every region — so adding this column cannot narrow existing
   * access"), which is `cardinality(...) = 0`. Note that `region` here is a
   * value, not a column, so the array-interpolation trap documented in
   * `visibility.ts` does not apply — `unnest` is over the staff row's column.
   */
  const regionClause =
    region === null
      ? sql`true`
      : sql`(cardinality(${staff.regions}) = 0
             OR lower(${region}) IN (SELECT lower(r) FROM unnest(${staff.regions}) AS r))`;

  const rows = await db
    .select({ telegramId: staff.telegramId })
    .from(staff)
    .where(
      and(
        eq(staff.active, true),
        inArray(staff.role, roles),
        /**
         * A System member bypasses both axes, exactly as `adminCanSeeCase_` does
         * (`AdminCommands.gs:290-294`) and exactly as `visibleToStaff` does.
         * Without it, a System member with a misconfigured queue is the one
         * person who cannot be told about anything.
         */
        or(eq(staff.role, 'System'), and(inArray(staff.queue, queues), regionClause)),
      ),
    )
    .orderBy(asc(staff.telegramId));

  return rows.map((r) => r.telegramId);
}

/**
 * The case's filing time, formatted by the database in Tashkent.
 *
 * Formatted in SQL rather than parsed into a `Date` and rendered here, for the
 * reason `StrandedCode.usedAt` records: `db.execute` hands back the raw string
 * PostgreSQL sent, because drizzle installs its own type parsers and does not
 * parse timestamps the way `pool.query` does. Doing it in SQL means the value is
 * never a `Date` that only looks like one, and the person reading gets their own
 * clock rather than the server's UTC.
 */
async function filedAtInTashkent(db: Database, reference: string): Promise<string> {
  const rows = await db.execute<{ filed_at: string }>(sql`
    SELECT to_char(created_at AT TIME ZONE ${TIMEZONE}, 'DD Mon YYYY, HH24:MI') AS filed_at
    FROM cases WHERE reference = ${reference}
  `);
  return rows.rows[0]?.filed_at ?? 'unknown';
}

/**
 * What a staff member sees on their phone.
 *
 * No detail, no teacher name, no chat id. The two command lines are the point of
 * the message: the recipient can read the case or take it without typing a
 * reference from memory.
 */
function noticeText(notice: NewCaseNotice, region: string | null, filedAt: string): string {
  return [
    notice.urgent
      ? `🚨 URGENT case — ${notice.reference}`
      : `🆕 New case — ${notice.reference}`,
    '',
    `Category: ${notice.category}`,
    `Region: ${region ?? 'not recorded'}`,
    `Filed: ${filedAt} (Tashkent)`,
    '',
    `/case ${notice.reference} — read it, including what the teacher wrote`,
    `/assign ${notice.reference} <telegram id> — give it an owner`,
  ].join('\n');
}

/** R4 and R14 together: a case has arrived and nobody is able to work it. */
function unworkableAlert(
  notice: NewCaseNotice,
  region: string | null,
  watchers: number,
): Alert {
  const diagnosis =
    watchers > 0
      ? [
          `${watchers} staff member(s) can SEE this case and none of them may act on it.`,
          'That is an Observer-only queue: cases arrive, and it looks staffed.',
          'Raise somebody to Support or above, or add a queue to somebody who has one.',
        ]
      : [
          'No active staff member covers this queue and region at all.',
          'Add somebody, or widen an existing member’s queue or regions.',
        ];

  return {
    severity: 'critical',
    title: notice.urgent
      ? 'An URGENT case has been filed that nobody can act on'
      : 'A case has been filed that nobody can act on',
    body: [
      `Case: ${notice.reference}`,
      `Category: ${notice.category}`,
      `Region: ${region ?? 'not recorded'}`,
      '',
      ...diagnosis,
      '',
      'The case is filed and the teacher has their reference. It is at status New,',
      'and it will stay there until a person is given the queue — it appears in',
      '/cases unassigned for anybody who gains it.',
    ].join('\n'),
  };
}

/**
 * One row per fan-out, against `SYSTEM`.
 *
 * `schema.ts:459` reserves that chat id for bot-initiated events precisely so a
 * case reference never ends up in the chat id column. The counts are how "a case
 * nobody saw" is answerable from the log rather than only from an alert somebody
 * may have missed.
 */
async function logFanOut(
  db: Database,
  notice: NewCaseNotice,
  notified: number,
  eligible: number,
): Promise<void> {
  await logInteraction(
    db,
    'SYSTEM',
    notice.urgent ? 'STAFF_NOTIFIED_URGENT' : 'STAFF_NOTIFIED_NEW',
    `${notice.reference} — notifying ${notified} of ${eligible} authorised staff`,
    null,
  );
}
