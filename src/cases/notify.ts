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
import { staffCovering } from '../staff/recipients.js';
import type { Alert } from '../sync/alerts.js';
import { regionFor } from '../teachers/region.js';
import { CALLBACK, encodeCallback } from '../telegram/callback-data.js';
import type { OutgoingMessage } from '../telegram/router.js';
import { markCaseReceived } from './service.js';

export interface NewCaseNotice {
  readonly reference: string;
  readonly category: string;
  readonly teacherChatId: string;
  /**
   * The staff member this case was given to, or null when nobody covers it.
   *
   * **Passed in rather than worked out here, and that is the change of 5 August
   * 2026 (D1).** This function used to ask `staffCovering` who could work the
   * case and write to all of them, up to twenty. On a four-person team that was
   * three or four phones for one teacher's problem, and the MoPSE employee using
   * the bot reported the result as overwhelming.
   *
   * The owner is decided once, by `chooseOwner`, inside `createCase`. Working out
   * a recipient list here as well would be a second answer to a question that
   * already has one, and the two would drift the first time either rule moved.
   */
  readonly owner: string | null;
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

  if (notice.owner === null) {
    /**
     * Nobody covers this queue and region, so there is nobody to write to.
     *
     * **The alarm goes to the operations chat and to no individual**, which is
     * D5 carried out. The head of project's rule is that somebody always covers
     * every region, so reaching this branch means a staff row is wrong rather
     * than that the bot is working as intended. The people who can fix a staffing
     * hole are in that chat. A caseworker cannot, and the old wording of this
     * warning, delivered to their phone, is a large part of what a MoPSE employee
     * described as threatening.
     *
     * The watcher count is still computed, and still only on this branch,
     * because it is the difference between two fixes. "Nobody at all covers this"
     * needs a person hired; "people cover it who may only look" needs somebody's
     * rank raised. An alarm that cannot tell them apart makes its reader do the
     * diagnosis at three in the morning.
     */
    const watchers = await staffCovering(db, {
      capability: CAPABILITY.CASE_VIEW,
      category: notice.category,
      region,
    });
    await logFanOut(db, notice.reference, 'STAFF_NOTIFIED_NEW', 0, 0);
    return { messages: [], alerts: [unworkableAlert(notice, region, watchers.length)] };
  }

  const facts = await caseFacts(db, notice.reference);

  /**
   * D25, step 2a. Only a case still at `New` moves — the guard is inside
   * `markCaseReceived` and it is what stops an urgent case being demoted out of
   * `Escalated`, which is what puts it in `/urgent`.
   */
  await markCaseReceived(db, notice.reference);
  await logFanOut(db, notice.reference, 'STAFF_NOTIFIED_NEW', 1, 1);

  return {
    messages: [
      {
        chatId: notice.owner,
        text: noticeText(notice, region, facts),
        /**
         * R10. `deliver` names this in the alarm it raises when a send fails, and
         * before `purpose` existed it called every message after the first "a
         * notice about somebody else's action (a duplicate sign-in)". A staff
         * notification that failed to arrive would have been reported as the
         * wrong thing entirely.
         */
        purpose: 'a new case notification',
        keyboard: [
          [
            {
              text: `📂 Open ${notice.reference}`,
              callback_data: encodeCallback(CALLBACK.CASE_OPEN, notice.reference),
            },
          ],
        ],
      },
    ],
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
  /** The case's owner. See `NewCaseNotice.owner`, which carries the argument. */
  readonly owner: string | null;
}

/**
 * Tell a regional coordinator that a teacher has asked for priority.
 *
 * **Sent to the owner alone since 5 August 2026 (D1).** It went to everybody in
 * the region who held `urgent.issue`, which on this team overlapped almost
 * entirely with everybody who had just been told the case existed.
 *
 * The person who will do the work is the person who decides whether it jumps the
 * queue. That is a narrowing of who decides, and it is not a lowering of the bar:
 * the owner holds `case.update`, which floors at `Support`, exactly where
 * `urgent.issue` floors. One Support member could always decide this alone. What
 * has changed is which one, and that it is now the one with the case.
 *
 * **This message names the teacher, which nothing else in this file does.** The
 * header rule — "the teacher's words are never in here" — still holds and is
 * different: their *account of the problem* stays behind `/case`, which checks
 * permissions and leaves a row saying who read it. The name and the roster
 * identifier are here because the whole of step 4 is "the coordinator verifies
 * however they normally would", and a coordinator who has to run `/case` before
 * they can tell who is asking is one who will confirm without checking.
 *
 * A case with no owner raises an alert to the operations chat instead. D5 says
 * that cannot happen while any staff row covers every region, which every one of
 * them does today, so reaching it means a staff row is wrong.
 */
export async function notifyUrgentRequest(
  db: Database,
  notice: UrgentRequestNotice,
): Promise<NotificationOutcome> {
  const region = await regionFor(db, notice.teacherChatId);

  if (notice.owner === null) {
    await logFanOut(db, notice.reference, 'STAFF_NOTIFIED_URGENT_REQUEST', 0, 0);
    return { messages: [], alerts: [noCoordinatorAlert(notice.reference, region)] };
  }

  const who = await teacherIdentity(db, notice.teacherChatId);
  const facts = await caseFacts(db, notice.reference);
  await logFanOut(db, notice.reference, 'STAFF_NOTIFIED_URGENT_REQUEST', 1, 1);

  /**
   * Four lines, from about twelve.
   *
   * **The teacher's name goes first, on its own line.** A person asked for help;
   * the category is only how it is filed. That ordering is the one deliberate
   * piece of shape in this message.
   *
   * **The roster identifier came out**, and the argument that put it there has
   * expired rather than been overruled. It was included because checking who was
   * asking meant typing a command first, so a coordinator would confirm without
   * looking. Opening the case is one tap now.
   *
   * The paragraph explaining what a priority request is came out too. The person
   * reading this has the two buttons in front of them and has done it before.
   */
  const text = [
    '⏫ Priority asked for',
    '',
    who.name ?? 'Name not on the roster',
    [notice.reference, region ?? 'region not recorded', facts.filedAt].join(' · '),
  ].join('\n');

  return {
    messages: [
      {
        chatId: notice.owner,
        text,
        purpose: 'an urgent-priority request awaiting a decision',
        keyboard: [
          [
            {
              text: '📂 Open case',
              callback_data: encodeCallback(CALLBACK.CASE_OPEN, notice.reference),
            },
            {
              text: '⏫ Make it a priority',
              callback_data: encodeCallback(CALLBACK.URGENT_CONFIRM, notice.reference),
            },
          ],
        ],
      },
    ],
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
 * the teacher's identity and the buttons; the new-case notice carries strictly
 * less. Sending both would put two messages about one case in one person's chat a
 * second apart, which is how somebody learns that the second one is noise, and
 * the second one is the one with the decision in it.
 *
 * **This strip stopped being an optimisation on 5 August 2026 and became the
 * thing holding the promise.** It was written when the two audiences merely
 * overlapped, so at worst it saved somebody a duplicate. Under D1 both messages
 * go to the same person by construction: the owner. Without this, the one change
 * that exists to stop a phone going off twice for one teacher would itself send
 * two messages a second apart. Do not remove it, and do not let it become
 * conditional.
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
    owner: notice.owner,
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
    title: 'A teacher asked for priority and the case has no owner',
    body: [
      `Case: ${reference}`,
      `Region: ${region ?? 'not recorded'}`,
      '',
      'The case is filed and the teacher has their reference. It is at normal',
      'importance and the request waits until somebody owns the case.',
      '',
      'Widen a staff member’s queue or regions, or add somebody.',
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
    SELECT to_char(c.created_at AT TIME ZONE ${TIMEZONE}, 'DD Mon, HH24:MI') AS filed_at,
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
 * What the owner sees on their phone.
 *
 * Three lines and a button, down from seven lines ending in two typed commands.
 * Nothing was thrown away: what came out is behind the button, which opens the
 * case exactly as tapping it in `/cases` does.
 *
 * **"for you" is only sayable because of D1.** While this went to everybody who
 * could work the case it had to be impersonal. One recipient lets the message say
 * whose case it is, which is the most useful word in it.
 *
 * The reference sits on the button rather than in the body, so it is there when
 * it is wanted and costs no line. No detail, no teacher name, no chat id, and no
 * em dash: §7 of the design, and the reason this rewrite exists.
 */
function noticeText(notice: NewCaseNotice, region: string | null, facts: CaseFacts): string {
  return [
    '🆕 New case for you',
    '',
    [notice.category, region ?? 'region not recorded'].join(' · '),
    facts.filedAt,
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
            ? `📄 ${facts.area.label}, not sent yet`
            : `📄 ${facts.area.label}, sent`,
        ]),
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
