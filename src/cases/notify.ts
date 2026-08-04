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
import { sql } from 'drizzle-orm';
import { NEW_CASE_NOTIFY_CAP, TIMEZONE } from '../config/constants.js';
import type { Database } from '../db/index.js';
import { logInteraction } from '../log/interactions.js';
import { CAPABILITY } from '../staff/roles.js';
import { regionalRecipients, staffCovering } from '../staff/recipients.js';
import type { Alert } from '../sync/alerts.js';
import { regionFor } from '../teachers/region.js';
import { CALLBACK, encodeCallback } from '../telegram/callback-data.js';
import type { OutgoingMessage } from '../telegram/router.js';
import { markCaseReceived } from './service.js';

export interface NewCaseNotice {
  readonly reference: string;
  readonly category: string;
  readonly teacherChatId: string;
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

  const actors = await staffCovering(db, {
    capability: CAPABILITY.CASE_UPDATE,
    category: notice.category,
    region,
  });

  if (actors.length === 0) {
    /**
     * Only computed when there is a problem, because it is only ever used to
     * word the alarm. "Nobody at all covers this" and "people cover it who may
     * only look at it" are different failures with different fixes — one needs a
     * staff member, the other needs a rank — and an alarm that cannot tell them
     * apart makes the reader do the diagnosis at three in the morning.
     */
    const watchers = await staffCovering(db, {
      capability: CAPABILITY.CASE_VIEW,
      category: notice.category,
      region,
    });
    await logFanOut(db, notice.reference, 'STAFF_NOTIFIED_NEW', 0, 0);
    return { messages: [], alerts: [unworkableAlert(notice, region, watchers.length)] };
  }

  const chosen = actors.slice(0, NEW_CASE_NOTIFY_CAP);
  const facts = await caseFacts(db, notice.reference);

  /**
   * D25, step 2a. Only a case still at `New` moves — the guard is inside
   * `markCaseReceived` and it is what stops an urgent case being demoted out of
   * `Escalated`, which is what puts it in `/urgent`.
   */
  await markCaseReceived(db, notice.reference);
  await logFanOut(db, notice.reference, 'STAFF_NOTIFIED_NEW', chosen.length, actors.length);

  const text = noticeText(notice, region, facts);
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
      purpose: 'a new case notification',
    })),
    alerts: [],
  };
}

// ---------------------------------------------------------------------------
// The urgent gate
// ---------------------------------------------------------------------------

export interface UrgentRequestNotice {
  readonly reference: string;
  readonly teacherChatId: string;
  /** False when the request landed on a case the teacher already had open. */
  readonly isNew: boolean;
}

/**
 * Tell a regional coordinator that a teacher has asked for priority.
 *
 * **Filtered on `urgent.issue`, not on `case.update`.** They are being asked to
 * exercise the first, and the two are not the same set: `urgent.issue` is
 * floored at `Support` deliberately — the person a teacher reaches is whoever is
 * on the desk, and a decision that needs a Lead is a decision that arrives after
 * the thing it was about.
 *
 * **This message names the teacher, which nothing else in this file does.** The
 * header rule — "the teacher's words are never in here" — still holds and is
 * different: their *account of the problem* stays behind `/case`, which checks
 * permissions and leaves a row saying who read it. The name and the roster
 * identifier are here because the whole of step 4 is "the coordinator verifies
 * however they normally would", and a coordinator who has to run `/case` before
 * they can tell who is asking is one who will confirm without checking.
 *
 * Falls back to System when no staff member covers the region, and says so. A
 * teacher in a region nobody covers must not have their request land nowhere;
 * see `regionalRecipients`.
 */
export async function notifyUrgentRequest(
  db: Database,
  notice: UrgentRequestNotice,
): Promise<NotificationOutcome> {
  const region = await regionFor(db, notice.teacherChatId);
  const recipients = await regionalRecipients(db, {
    capability: CAPABILITY.URGENT_ISSUE,
    region,
  });

  if (recipients.chatIds.length === 0) {
    await logFanOut(db, notice.reference, 'STAFF_NOTIFIED_URGENT_REQUEST', 0, 0);
    return { messages: [], alerts: [noCoordinatorAlert(notice.reference, region)] };
  }

  const who = await teacherIdentity(db, notice.teacherChatId);
  const chosen = recipients.chatIds.slice(0, NEW_CASE_NOTIFY_CAP);
  await logFanOut(
    db,
    notice.reference,
    'STAFF_NOTIFIED_URGENT_REQUEST',
    chosen.length,
    recipients.chatIds.length,
  );

  const text = [
    `⏫ Priority requested — ${notice.reference}`,
    '',
    `Teacher: ${who.name ?? 'name not on the roster'}`,
    `Identifier: ${who.identifier ?? 'not recorded'}`,
    `Region: ${region ?? 'not recorded'}`,
    '',
    notice.isNew
      ? 'They have opened a case and asked for it to be treated as a priority.'
      : 'They have added to a case they already had open and asked for it to be treated as a priority.',
    '',
    'It is filed at normal importance until you decide. Check with them however',
    'you normally would, then confirm below if it should jump the queue.',
    '',
    ...(recipients.viaSystemFallback
      ? [
          '⚠️ You are being asked because NO active staff member covers this region.',
          'That is a staffing gap, not a routing quirk — somebody needs the region.',
          '',
        ]
      : []),
    `/case ${notice.reference} — read it, including what the teacher wrote`,
  ].join('\n');

  return {
    messages: chosen.map((chatId) => ({
      chatId,
      text,
      purpose: 'an urgent-priority request awaiting a decision',
      keyboard: [
        [
          {
            text: '⏫ Confirm urgent',
            callback_data: encodeCallback(CALLBACK.URGENT_CONFIRM, notice.reference),
          },
        ],
      ],
    })),
    alerts: [],
  };
}

/**
 * Everything one urgent request has to announce, in one call.
 *
 * There are two audiences and they are computed differently. The case still has
 * to reach **its queue** — that is `notifyNewCase`, filtered by category and
 * `case.update`, and it is also the only thing that moves a case off `New`. The
 * request has to reach **the region's coordinators** — filtered by
 * `urgent.issue` and no queue at all. On a small team those sets overlap almost
 * completely.
 *
 * So the overlap is removed, and the request message is the one kept. It carries
 * the reference, the teacher's identity and the button; the new-case notice
 * carries strictly less. Sending both would put two messages about one case in
 * one person's chat a second apart, which is how somebody learns that the second
 * one is noise — and the second one is the one with the decision in it.
 *
 * A request landing on a case the teacher already had open announces nothing to
 * the queue at all: staff were told when it was filed, and paging them again for
 * a case they already have is the failure `NO_NOTIFICATION` exists to prevent.
 */
export async function notifyUrgentRequestOnCase(
  db: Database,
  notice: UrgentRequestNotice & { readonly category: string },
): Promise<NotificationOutcome> {
  const request = await notifyUrgentRequest(db, notice);

  if (!notice.isNew) return request;

  const filed = await notifyNewCase(db, {
    reference: notice.reference,
    category: notice.category,
    teacherChatId: notice.teacherChatId,
  });

  const told = new Set(request.messages.map((m) => m.chatId));
  return {
    messages: [...filed.messages.filter((m) => !told.has(m.chatId)), ...request.messages],
    alerts: [...filed.alerts, ...request.alerts],
  };
}

export interface UrgentConfirmedNotice {
  readonly reference: string;
  readonly teacherChatId: string;
  /** The case's owner, or null when nobody has taken it. */
  readonly owner: string | null;
  readonly confirmedBy: string;
}

/**
 * Tell everybody a confirmation concerns: the owner, and Program upward.
 *
 * The owner first, because they are the one person whose work has just changed.
 * A case they took at normal priority is now the thing they are meant to be
 * doing, and nothing else in this system would have told them — `/urgent` is a
 * list somebody has to think to open.
 *
 * Program and above are told because the plan asks for it, and the reason is
 * that this is the only granting act in the system with no second signature:
 * `urgent.issue` sits at `Support`, so one person on the desk can raise a case
 * above every other case in the country. Nobody has to approve it; somebody has
 * to be able to see it happened.
 *
 * The teacher is **not** told from here. Their message is the answer to their
 * own tap when they made the request, and this confirmation may arrive hours
 * later — the router sends it, because `messages[0]` must stay the answer to
 * whoever acted, and the person who acted here is the coordinator.
 */
export async function notifyUrgentConfirmed(
  db: Database,
  notice: UrgentConfirmedNotice,
): Promise<NotificationOutcome> {
  const oversight = await staffCovering(db, {
    capability: CAPABILITY.ANNOUNCE,
    region: null,
  });

  /**
   * Deduplicated, and the owner is dropped rather than the oversight list.
   *
   * The owner is very often a Program member on a small team, and two identical
   * messages a second apart is how somebody learns that this notification means
   * nothing. `confirmedBy` is excluded for the same reason plus one more: they
   * have just tapped the button and are already being answered.
   */
  const recipients = [...new Set([...(notice.owner === null ? [] : [notice.owner]), ...oversight])].filter(
    (chatId) => chatId !== notice.confirmedBy,
  );

  if (recipients.length === 0) return NO_NOTIFICATION;

  const text = [
    `⏫ Case marked urgent — ${notice.reference}`,
    '',
    `Confirmed by: ${notice.confirmedBy}`,
    notice.owner === null
      ? 'Nobody owns this case yet.'
      : `Owner: ${notice.owner}`,
    '',
    'It is now at Escalated and appears in /urgent.',
    '',
    `/case ${notice.reference} — read it, including what the teacher wrote`,
    `/assign ${notice.reference} <telegram id> — give it an owner`,
  ].join('\n');

  return {
    messages: recipients.slice(0, NEW_CASE_NOTIFY_CAP).map((chatId) => ({
      chatId,
      text,
      purpose: 'notice that a case was confirmed urgent',
    })),
    alerts: [],
  };
}

/** R4 one axis along: a teacher asked for priority and nobody can grant it. */
function noCoordinatorAlert(reference: string, region: string | null): Alert {
  return {
    severity: 'critical',
    title: 'A teacher asked for priority and nobody can decide it',
    body: [
      `Case: ${reference}`,
      `Region: ${region ?? 'not recorded'}`,
      '',
      'No active staff member holds urgent.issue — not in this region, and not at',
      'System either, which is the fallback. The case is filed and the teacher has',
      'their reference, but it is sitting at normal importance and the request will',
      'stay pending until somebody with the rank exists.',
      '',
      'Add a Support member, or check that the System rows are still active.',
    ].join('\n'),
  };
}

/**
 * Who the teacher is, as the roster records them.
 *
 * The identifier comes from `teachers`, which is what they signed in with, and
 * the name from `roster_entries`, which is what the ministry holds. LEFT joined:
 * a teacher whose roster row was removed still has a case and a coordinator
 * still has to be told something about them.
 */
async function teacherIdentity(
  db: Database,
  chatId: string,
): Promise<{ name: string | null; identifier: string | null }> {
  const rows = await db.execute<{ name: string | null; identifier: string | null }>(sql`
    SELECT r.name AS name, t.identifier AS identifier
    FROM teachers t
    LEFT JOIN roster_entries r ON r.identifier = t.identifier
    WHERE t.chat_id = ${chatId}
  `);
  const row = rows.rows[0];
  return { name: row?.name ?? null, identifier: row?.identifier ?? null };
}

/** The form area a case was raised in, if it was raised in one. */
interface FormArea {
  /** What a teacher saw on the button, so staff and teacher name it the same way. */
  readonly label: string;
  readonly awaitingForm: boolean;
}

interface CaseFacts {
  readonly filedAt: string;
  readonly area: FormArea | null;
}

/**
 * The two things a new-case notice needs from the case row itself.
 *
 * **The filing time is formatted by the database in Tashkent**, for the reason
 * `StrandedCode.usedAt` records: `db.execute` hands back the raw string
 * PostgreSQL sent, because drizzle installs its own type parsers and does not
 * parse timestamps the way `pool.query` does. Doing it in SQL means the value is
 * never a `Date` that only looks like one, and the person reading gets their own
 * clock rather than the server's UTC. Nothing else read here is a timestamp —
 * one boolean and two text columns — which is the only reason this query is safe
 * to have grown.
 *
 * **`form_links` is LEFT joined, and the raw `form_type` is the fallback.** An
 * area MoPSE retires must not stop its existing cases notifying, which is why
 * `cases.form_type` is deliberately not a foreign key. A notice reading
 * "REIMBURSE" is worse than one reading "Reimbursement" and very much better
 * than no notice at all.
 */
async function caseFacts(db: Database, reference: string): Promise<CaseFacts> {
  const rows = await db.execute<{
    filed_at: string;
    form_type: string | null;
    button_text: string | null;
    awaiting_form: boolean;
  }>(sql`
    SELECT to_char(c.created_at AT TIME ZONE ${TIMEZONE}, 'DD Mon YYYY, HH24:MI') AS filed_at,
           c.form_type AS form_type,
           f.button_text AS button_text,
           c.awaiting_form AS awaiting_form
    FROM cases c
    LEFT JOIN form_links f ON f.type = c.form_type
    WHERE c.reference = ${reference}
  `);
  const row = rows.rows[0];
  if (row === undefined) return { filedAt: 'unknown', area: null };

  return {
    filedAt: row.filed_at,
    area:
      row.form_type === null
        ? null
        : { label: row.button_text ?? row.form_type, awaitingForm: row.awaiting_form },
  };
}

/**
 * What a staff member sees on their phone.
 *
 * No detail, no teacher name, no chat id. The two command lines are the point of
 * the message: the recipient can read the case or take it without typing a
 * reference from memory.
 */
function noticeText(notice: NewCaseNotice, region: string | null, facts: CaseFacts): string {
  return [
    `🆕 New case — ${notice.reference}`,
    '',
    `Category: ${notice.category}`,
    `Region: ${region ?? 'not recorded'}`,
    `Filed: ${facts.filedAt} (Tashkent)`,
    /**
     * One line, and only for a case raised in a form area.
     *
     * Whether the paperwork has arrived is the thing a person picking this up
     * most needs to know, because it decides what they do next: chase the
     * teacher, or read what they sent. A case raised any other way says nothing
     * here at all — a line reading "no paperwork" on a case that was never about
     * paperwork is noise, and noise is how a notice stops being read.
     */
    ...(facts.area === null
      ? []
      : [
          facts.area.awaitingForm
            ? `📄 ${facts.area.label} — the form has not arrived yet. The teacher was given the link.`
            : `📄 ${facts.area.label} — the form has been submitted.`,
        ]),
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
    title: 'A case has been filed that nobody can act on',
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
  reference: string,
  /**
   * Named by the caller rather than derived from a flag on the notice.
   *
   * An urgent *request* is a different event from a case arriving — the first is
   * somebody asking and the second is a case reaching its queue — and filing
   * both under one label would make "how many requests went unanswered"
   * unaskable from the log, which is the one question the accepted "it waits on
   * one coordinator" risk needs an answer to.
   */
  action: 'STAFF_NOTIFIED_NEW' | 'STAFF_NOTIFIED_URGENT_REQUEST',
  notified: number,
  eligible: number,
): Promise<void> {
  await logInteraction(
    db,
    'SYSTEM',
    action,
    `${reference} — notifying ${notified} of ${eligible} authorised staff`,
    null,
  );
}
