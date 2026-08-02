/**
 * Who is told about an identity dispute, and what they are told — Feature A.
 *
 * Mirrors `cases/notify.ts` deliberately, down to the shape of the return value:
 * it computes recipients and writes the words, and **it sends nothing**. The
 * messages are returned and `deliver` sends them after the transaction commits,
 * because announcing an argument over a binding that can still roll back is
 * worse than announcing it a moment later.
 *
 * Three things here are load-bearing:
 *
 *   **The adjudicating region is the ROSTER's, resolved from the identifier.**
 *   Never `regionFor(chatId)`. The two chats can carry different `regionOverride`
 *   values, so a per-chat lookup would let an impostor with an override choose
 *   their own adjudicator — which in a feature about impersonation is the whole
 *   game. `regionFor` must not appear in this file.
 *
 *   **The queue axis is not consulted.** `RecipientQuery.category` is omitted, and
 *   `staff/recipients.ts` says why in its own words: a dispute is not filed under
 *   a category, so filtering by one would silently exclude everybody whose queue
 *   is not `All`. A dispute has no queue.
 *
 *   **Neither party's message accuses the other**, and neither says anything that
 *   lets a party certify itself. Both buttons record a claim and decide nothing.
 *   Both messages say plainly that signing in still works, because a teacher who
 *   reads "somebody else is using your account" and assumes they are locked out
 *   is a teacher who stops using the bot.
 *
 * **What the reviewer is NOT shown, and it is a gap rather than a decision.**
 * Part 2 says each party's *Telegram display name* should be listed. This bot has
 * never captured one — nothing anywhere reads `from.first_name`, and
 * `teachers.name` is the **roster** name copied at sign-in, which is identical
 * for every party by construction and so distinguishes nobody. What is shown
 * instead is each party's chat id, when it first appeared, when it was last
 * active, and what it tapped — which is held, and is more decisive for telling
 * two accounts apart than a display name anyone can change would be. Capturing
 * display names is a schema change, a change to the update path, and more
 * personal data held; it is written up rather than smuggled in here.
 */
import { sql } from 'drizzle-orm';
import { NEW_CASE_NOTIFY_CAP, TIMEZONE } from '../config/constants.js';
import type { Database } from '../db/index.js';
import { logInteraction } from '../log/interactions.js';
import { regionalRecipients } from '../staff/recipients.js';
import { CAPABILITY } from '../staff/roles.js';
import type { Alert } from '../sync/alerts.js';
import { CALLBACK, encodeCallback } from '../telegram/callback-data.js';
import type { OutgoingMessage } from '../telegram/router.js';
import type { DisputeParty } from './disputes.js';

export interface DisputeNotification {
  readonly messages: readonly OutgoingMessage[];
  readonly alerts: readonly Alert[];
}

export const NO_DISPUTE_NOTIFICATION: DisputeNotification = { messages: [], alerts: [] };

export interface DisputeOpenedNotice {
  readonly disputeId: number;
  readonly identifier: string;
  /** The chat that has just signed in. */
  readonly newChatId: string;
  /** Everyone who already held the identity. */
  readonly priorChatIds: readonly string[];
  readonly supportContact: string;
}

/**
 * The message each party gets when a dispute opens. One button each.
 *
 * The two wordings differ because the two situations differ — one chat has just
 * signed in and the other has been signed in for a while — but neither is told
 * the other is an impostor, and neither button settles anything.
 *
 * **The prior holder's message replaces the plain duplicate-sign-in notice** that
 * `handleIdentifier` used to send. It says the same thing and carries a button;
 * sending both would put two near-identical messages in one chat a second apart,
 * and the second one is the one that leads somewhere.
 */
export function disputeOpenedMessages(notice: DisputeOpenedNotice): DisputeNotification {
  const priorText = [
    '⚠️ Security notice',
    '',
    'Your teacher account has just been used to sign in from another Telegram',
    'account.',
    '',
    'If that was you — a new phone, for instance — nothing is wrong and you can',
    'ignore this.',
    '',
    'If it was not you, tap below. A member of Ministry staff will look at both',
    'accounts and decide. You are not locked out, and nothing you have done is',
    'affected while they look.',
    '',
    `You can also contact ${notice.supportContact}.`,
  ].join('\n');

  const newText = [
    '⚠️ Someone else is already signed in with this account',
    '',
    'You are signed in and everything works as normal — this does not block you.',
    '',
    'Another Telegram account is also signed in as this teacher. If you have just',
    'changed phone or number, that will be your old account, and tapping below',
    'tells our staff so.',
    '',
    'A member of Ministry staff decides which account stays. Nothing you tap here',
    'settles it.',
    '',
    `Questions: ${notice.supportContact}.`,
  ].join('\n');

  /**
   * The prior holders come first, and the new chat's own notice last.
   *
   * `deliver` treats `messages[0]` as the answer to whoever wrote in — that is
   * the sign-in confirmation, added by the router before these — and the next
   * message is the one an operator sees named in a failed-send alarm. The prior
   * holder's notice is the one that matters most there: it is going to somebody
   * who did not just do anything and has no idea it is coming.
   *
   * The purpose string is unchanged from the plain notice this replaced, because
   * it is what an operator reads at three in the morning and the message still
   * *is* a duplicate sign-in notice — it has simply grown a button.
   */
  const messages: OutgoingMessage[] = notice.priorChatIds.map((holder) => ({
    chatId: holder,
    purpose: 'a duplicate sign-in notice',
    text: priorText,
    keyboard: [
      [
        {
          text: '⚠️ This wasn’t me',
          callback_data: encodeCallback(
            CALLBACK.DISPUTE_CLAIM,
            String(notice.disputeId),
            'NotMine',
          ),
        },
      ],
    ],
  }));

  messages.push({
    chatId: notice.newChatId,
    purpose: 'telling a new chat its teacher identity is contested',
    text: newText,
    keyboard: [
      [
        {
          text: '✅ This is me — I changed phone',
          callback_data: encodeCallback(CALLBACK.DISPUTE_CLAIM, String(notice.disputeId), 'Mine'),
        },
      ],
    ],
  });

  return { messages, alerts: [] };
}

export interface DisputeEscalationNotice {
  readonly disputeId: number;
  readonly identifier: string;
  readonly parties: readonly DisputeParty[];
}

/**
 * Tell the region's reviewers that somebody has responded.
 *
 * Filtered on `dispute.review`, which floors at `Support` — the rank a MoPSE
 * regional admin actually holds. Filtering on `teacher.revoke` instead would send
 * every dispute in the country to Program and above, which on this team means
 * System, which means the regional routing never fires.
 *
 * Falls back to System when nobody covers the region **and says so in the
 * message**. "A region nobody covers must not become a dispute nobody sees" is
 * Part 2's sentence; the warning is there because a System member being asked to
 * decide something in a region no coordinator covers is a staffing gap, and a
 * gap nobody is told about stays open for as long as somebody keeps answering it.
 */
export async function notifyDisputeEscalated(
  db: Database,
  notice: DisputeEscalationNotice,
): Promise<DisputeNotification> {
  const roster = await rosterIdentity(db, notice.identifier);
  const recipients = await regionalRecipients(db, {
    capability: CAPABILITY.DISPUTE_REVIEW,
    region: roster.region,
  });

  if (recipients.chatIds.length === 0) {
    await logFanOut(db, notice.identifier, 'STAFF_NOTIFIED_DISPUTE', 0, 0);
    return {
      messages: [],
      alerts: [
        {
          severity: 'critical',
          title: 'An identity dispute has nobody to review it',
          body: [
            `Identifier: ${notice.identifier}`,
            `Region: ${roster.region ?? 'not recorded'}`,
            '',
            'Two or more Telegram accounts claim this teacher identity and NO active',
            'staff member — not even a System administrator — can be found to look at',
            'it. Somebody has to be given a staff row before this can be settled.',
          ].join('\n'),
        },
      ],
    };
  }

  const chosen = recipients.chatIds.slice(0, NEW_CASE_NOTIFY_CAP);
  await logFanOut(
    db,
    notice.identifier,
    'STAFF_NOTIFIED_DISPUTE',
    chosen.length,
    recipients.chatIds.length,
  );

  const seen = await partyFacts(db, notice.parties);

  const text = [
    '⚖️ Identity dispute — somebody has responded',
    '',
    `Teacher on the roster: ${roster.name ?? 'name not on the roster'}`,
    `Identifier: ${notice.identifier}`,
    `Region: ${roster.region ?? 'not recorded'}`,
    '',
    `${String(notice.parties.length)} Telegram accounts claim this identity:`,
    ...seen,
    '',
    'Telegram does not give bots phone numbers, so none is shown.',
    '',
    'Check however you normally would — telephone the school, or the teacher on a',
    'number you already hold. Nothing you do here settles it: only a System',
    'administrator can decide which account stays. Pass it on below when you have',
    'checked.',
    '',
    ...(recipients.viaSystemFallback
      ? [
          '⚠️ You are being asked because NO active staff member covers this region.',
          'That is a staffing gap, not a routing quirk — somebody needs the region.',
          '',
        ]
      : []),
    `/disputes — every dispute waiting`,
  ].join('\n');

  return {
    messages: chosen.map((chatId) => ({
      chatId,
      text,
      purpose: 'an identity dispute awaiting review',
      keyboard: [
        [
          {
            text: '📤 Send to system admin',
            callback_data: encodeCallback(CALLBACK.DISPUTE_ESCALATE, String(notice.disputeId)),
          },
        ],
      ],
    })),
    alerts: [],
  };
}

export interface DisputeWithSystemNotice extends DisputeEscalationNotice {
  readonly forwardedBy: string;
}

/**
 * Tell System that a reviewer has handed it over.
 *
 * Every System member, unconditionally — `dispute.resolve` floors there, so this
 * is not a fan-out to a region but to the two people who can act. Each message
 * carries one button per party, naming the chat that would **keep** the identity.
 */
export async function notifyDisputeWithSystem(
  db: Database,
  notice: DisputeWithSystemNotice,
): Promise<DisputeNotification> {
  const roster = await rosterIdentity(db, notice.identifier);
  const recipients = await regionalRecipients(db, {
    capability: CAPABILITY.DISPUTE_RESOLVE,
    region: null,
  });

  if (recipients.chatIds.length === 0) {
    return {
      messages: [],
      alerts: [
        {
          severity: 'critical',
          title: 'An identity dispute reached System and there is no System member',
          body: [
            `Identifier: ${notice.identifier}`,
            '',
            'A reviewer passed this on and nobody holds the rank to settle it. The',
            'launch checklist requires two named System members for exactly this.',
          ].join('\n'),
        },
      ],
    };
  }

  const seen = await partyFacts(db, notice.parties);

  const text = [
    '⚖️ Identity dispute — passed to you to settle',
    '',
    `Teacher on the roster: ${roster.name ?? 'name not on the roster'}`,
    `Identifier: ${notice.identifier}`,
    `Region: ${roster.region ?? 'not recorded'}`,
    `Passed on by: ${notice.forwardedBy}`,
    '',
    'The accounts claiming this identity:',
    ...seen,
    '',
    'Choosing an account revokes every other one and closes its cases with a',
    'reason the teacher can read. The revocation can be undone with /restore; the',
    'closed cases stay closed.',
    '',
    'Use the buttons, or /dispute_resolve for a longer note.',
  ].join('\n');

  /**
   * One button per party, each naming the chat that KEEPS the identity.
   *
   * Capped, like every keyboard here. A dispute with more parties than fit is
   * settled with `/dispute_resolve`, which the message names — a wall of buttons
   * on a decision this serious is worse than a typed command.
   */
  const keyboard = notice.parties.slice(0, 6).map((party) => [
    {
      text: `✅ ${party.chatId} is the teacher`,
      callback_data: encodeCallback(
        CALLBACK.DISPUTE_RESOLVE,
        String(notice.disputeId),
        party.chatId,
      ),
    },
  ]);

  return {
    messages: recipients.chatIds.map((chatId) => ({
      chatId,
      text,
      purpose: 'an identity dispute awaiting a decision',
      keyboard,
    })),
    alerts: [],
  };
}

export interface DisputeResolvedNotice {
  readonly keptChatId: string;
  readonly revoked: readonly string[];
  readonly closedCases: readonly string[];
  readonly supportContact: string;
}

/**
 * What the parties are told once it is settled.
 *
 * The losing chats get a reason and a route, never an accusation. If the decision
 * went the wrong way — and it can, which is why `/restore` exists — this message
 * is the only thing standing between a real teacher and silence.
 *
 * Pure: no database, no clock. Everything it needs is resolved by the caller.
 */
export function disputeResolvedMessages(notice: DisputeResolvedNotice): DisputeNotification {
  const messages: OutgoingMessage[] = [
    {
      chatId: notice.keptChatId,
      purpose: 'telling a teacher the dispute over their account is settled',
      text: [
        '✅ The question about your account is settled',
        '',
        'Ministry staff have confirmed this account is yours. Nothing has changed',
        'for you and you do not need to do anything.',
      ].join('\n'),
    },
  ];

  for (const chatId of notice.revoked) {
    messages.push({
      chatId,
      purpose: 'telling a chat it did not keep a contested identity',
      text: [
        'This account can no longer be used for teacher support',
        '',
        'Ministry staff have looked at the accounts signed in as this teacher and',
        'confirmed a different one is the teacher’s. This account has been signed',
        'out, and any cases it had open have been closed.',
        '',
        'You can still read the answer bank, which needs no account.',
        '',
        `If you believe this is wrong, contact ${notice.supportContact}. A person will`,
        'look at it, and the decision can be undone.',
      ].join('\n'),
    });
  }

  return { messages, alerts: [] };
}

/**
 * The roster's own record for this identity — name and region.
 *
 * The region here is **the roster's**, and reading it from the roster rather than
 * from either chat is the security property of this whole file. See the header.
 */
async function rosterIdentity(
  db: Database,
  identifier: string,
): Promise<{ name: string | null; region: string | null }> {
  const rows = await db.execute<{ name: string | null; region: string | null }>(sql`
    SELECT name, region FROM roster_entries WHERE identifier = ${identifier}
  `);
  return { name: rows.rows[0]?.name ?? null, region: rows.rows[0]?.region ?? null };
}

/**
 * One line per party: the chat id, what it tapped, and how long it has been here.
 *
 * `first_seen` and `last_seen` are what a reviewer actually needs. An account
 * that has been signed in since June and one that appeared this morning look
 * entirely different, and that difference is the thing a display name was
 * supposed to provide and could not — see the header.
 *
 * Formatted by the database, in Tashkent. A `timestamptz` read through
 * `db.execute` arrives as a **string**, so nothing here types one as a `Date`.
 */
async function partyFacts(db: Database, parties: readonly DisputeParty[]): Promise<string[]> {
  const lines: string[] = [];

  for (const party of parties) {
    const rows = await db.execute<{ first_seen: string | null; last_seen: string | null }>(sql`
      SELECT to_char(first_seen AT TIME ZONE ${TIMEZONE}, 'DD Mon YYYY') AS first_seen,
             to_char(last_seen  AT TIME ZONE ${TIMEZONE}, 'DD Mon YYYY, HH24:MI') AS last_seen
      FROM teachers WHERE chat_id = ${party.chatId}
    `);
    const row = rows.rows[0];

    lines.push(
      `• Chat ${party.chatId}`,
      `    first seen ${row?.first_seen ?? 'not recorded'} · last active ${row?.last_seen ?? 'not recorded'}`,
      `    ${claimLine(party)}`,
    );
  }

  return lines;
}

function claimLine(party: DisputeParty): string {
  if (party.claim === null) return 'has not answered';
  const said = party.claim === 'Mine' ? 'said “This is me”' : 'said “This wasn’t me”';
  return `${said}${party.claimedAt === null ? '' : ` on ${party.claimedAt}`}`;
}

/**
 * Record how many people were told, out of how many could have been.
 *
 * Subject is the identifier rather than a case reference, because a dispute has
 * no reference. The action is its own label for `logFanOut`'s stated reason: an
 * event filed under somebody else's name makes "how many disputes went
 * unanswered" unaskable from the log, and that is the question the "no
 * auto-expiry" decision needs an answer to.
 */
async function logFanOut(
  db: Database,
  identifier: string,
  action: 'STAFF_NOTIFIED_DISPUTE',
  notified: number,
  eligible: number,
): Promise<void> {
  await logInteraction(
    db,
    'SYSTEM',
    action,
    `${identifier} → ${String(notified)} of ${String(eligible)}`,
    null,
  );
}
