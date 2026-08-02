/**
 * Seven in the morning — Task 68, and D39, D40 and D47's daily half.
 *
 * Three things that have never happened on their own, in one job because they
 * read the same table and are wanted at the same moment:
 *
 *   **Each staff member's own morning.** Not one message to the operations chat:
 *   a queue-and-region system whose daily summary ignores queue and region
 *   teaches everybody that most of the message is not theirs.
 *
 *   **The teacher chase.** A case at `Action required` is waiting on the
 *   *teacher*, and the staff member holding it is correctly doing nothing (D26,
 *   D40). The queries already know who to message; this job must not re-derive it.
 *
 *   **The published handles, re-checked** (D47, R33). It belongs here rather
 *   than in its own job because it is the same shape as the stranded-code check
 *   the heartbeat carries: something that should always find nothing, and that is
 *   silent for months when it does not.
 *
 * **The chase runs second, after every read.** The chase writes to `cases`, and
 * doing the reads first means the digest cannot report a case as chased before
 * it was.
 *
 * `trySend` throughout, never `send`. One staff member who has never started a
 * chat with the bot must not cost everybody else their digest.
 */
import type { Task } from 'graphile-worker';
import type { Api } from 'grammy';
import {
  DIGEST_LIST_CAP,
  TEACHER_CHASE_AFTER_DAYS,
  TEACHER_CHASE_MAX,
} from '../../config/constants.js';
import {
  casesAwaitingTeacher,
  casesExhaustedChasing,
  casesPastDue,
  listCases,
  staleCases,
} from '../../cases/queries.js';
import { markChaseReported, markTeacherChased } from '../../cases/service.js';
import { getDb } from '../../db/index.js';
import type { Database } from '../../db/index.js';
import {
  chaseExhaustedMessage,
  staffDigest,
  teacherChaseMessage,
} from '../../digest/format.js';
import { log } from '../../log.js';
import { openDisputes } from '../../teachers/disputes.js';
import { CAPABILITY, can } from '../../staff/roles.js';
import {
  type TelegramLookup,
  clearUsername,
  listStaff,
  publishedUsernames,
} from '../../staff/repository.js';
import type { Alerter } from '../../sync/alerts.js';
import { telegramAlerter } from '../../telegram/alerter.js';
import { createApi } from '../../telegram/bot.js';
import { trySend } from '../../telegram/send.js';
import { recordJobRun } from '../job-run.js';

export const DIGEST_TASK = 'digest';

/** Once a day. The heartbeat alarms at 1.5× this. */
export const DIGEST_INTERVAL_SECONDS = 24 * 60 * 60;

/** What one sender does. Narrowed so the job can be driven with no network. */
export interface DigestSender {
  send(chatId: string, text: string): Promise<boolean>;
}

export const telegramSender = (api: Api): DigestSender => ({
  send: async (chatId, text) => (await trySend(api, chatId, text)).ok,
});

export interface DigestReport {
  readonly digestsSent: number;
  readonly digestsSkipped: number;
  readonly teachersChased: number;
  readonly ownersTold: number;
  readonly undeliverable: number;
}

/**
 * One message per active staff member who can act, containing their own lists.
 *
 * **One scope evaluation per member, through the existing queries** (step 3).
 * Not one query with a join across staff: the guarantee `visibleToStaff` gives
 * is per-asker, and re-expressing it as a bulk query is exactly how it drifts.
 * Twenty or thirty staff at three queries each, once a day, is nothing.
 *
 * **Not Observers** (R14). Somebody who cannot reply, close or take a case is
 * being paged about work they are not permitted to do. It is the same filter
 * new-case notification applies, reusing the capability rather than the
 * visibility rule so the two cannot drift.
 */
async function sendStaffDigests(
  db: Database,
  sender: DigestSender,
): Promise<{ sent: number; skipped: number; undeliverable: number }> {
  const members = (await listStaff(db)).filter((m) =>
    can({ role: m.role, active: m.active }, CAPABILITY.CASE_UPDATE),
  );

  let sent = 0;
  let skipped = 0;
  let undeliverable = 0;

  for (const member of members) {
    const scope = { role: member.role, queue: member.queue, regions: member.regions };

    const [pastDue, stale, unassigned] = await Promise.all([
      casesPastDue(db, scope, member.telegramId),
      staleCases(db, scope),
      listCases(db, scope, { unassigned: true }),
    ]);

    /**
     * Disputes go only to the people who may act on them — Feature A.
     *
     * Filtered on `dispute.review`, the capability the line asks them to
     * *exercise*, rather than on the `case.update` that got them into this loop.
     * That is R14 in its own words, and the two sets are genuinely different: the
     * loop above is everybody who can work a case, and reviewing a dispute is a
     * separate grant that somebody may not hold.
     *
     * Not filtered by region, because a dispute has no queue and its region lives
     * on the roster rather than on anything `scope` can see. `/disputes` shows the
     * same unfiltered list, so the digest and the command agree.
     */
    const disputeLines = can({ role: member.role, active: member.active }, CAPABILITY.DISPUTE_REVIEW)
      ? (await openDisputes(db, DIGEST_LIST_CAP)).map(
          (d) =>
            `#${String(d.id)} — ${d.identifier} · ${String(d.parties.length)} accounts · opened ${d.openedAt}`,
        )
      : [];

    /**
     * `null` when there is nothing, and the formatter decides that rather than
     * this job (D39). A daily message saying "nothing to do" is a daily message
     * people filter, and then they filter the one that matters.
     */
    const text = staffDigest({ pastDue, stale, unassigned, disputes: disputeLines });
    if (text === null) {
      skipped += 1;
      continue;
    }

    if (await sender.send(member.telegramId, text)) sent += 1;
    else undeliverable += 1;
  }

  return { sent, skipped, undeliverable };
}

/**
 * Remind the teachers whose cases are waiting on them, and give up after three.
 *
 * **The queries decide who is messaged, and this job does not re-derive it.**
 * `casesAwaitingTeacher` already applies the cap, the interval, the snooze and
 * `teacherHasAccess`; re-checking any of that here would be a second expression
 * of a rule that must have exactly one.
 *
 * A send that fails still counts as nothing having happened, so the clock does
 * not advance — the case simply comes back tomorrow, and the owner is told when
 * the reminders run out, which is the honest outcome for a teacher who cannot be
 * reached (R29).
 */
async function chaseTeachers(
  db: Database,
  sender: DigestSender,
): Promise<{ chased: number; ownersTold: number; undeliverable: number }> {
  let chased = 0;
  let ownersTold = 0;
  let undeliverable = 0;

  for (const row of await casesAwaitingTeacher(db, TEACHER_CHASE_AFTER_DAYS, TEACHER_CHASE_MAX)) {
    if (await sender.send(row.teacherChatId, teacherChaseMessage(row))) {
      await markTeacherChased(db, row.reference);
      chased += 1;
    } else {
      undeliverable += 1;
    }
  }

  /**
   * The end of D40's cap, and the only thing in this system that has ever
   * produced this signal. Three unanswered reminders over nine days is a teacher
   * who has left, changed number, or given up — which is exactly what
   * `/close <ref> unresolved <reason>` was built for.
   *
   * A case with no owner has nobody to tell. It is still marked as reported, so
   * the query does not return it every morning for ever; it is in somebody's
   * unassigned list, which is where an ownerless case belongs.
   */
  for (const row of await casesExhaustedChasing(db, TEACHER_CHASE_MAX)) {
    if (row.owner !== null && (await sender.send(row.owner, chaseExhaustedMessage(row)))) {
      ownersTold += 1;
    }
    await markChaseReported(db, row.reference);
  }

  return { chased, ownersTold, undeliverable };
}

/**
 * Re-check every published handle — D47, R33.
 *
 * A handful of API calls against values that change about never. A handle that
 * no longer resolves to its owner is cleared, and **both** the staff member and
 * the operations chat are told: the staff member is the one person who already
 * knows they changed it, and therefore the least likely to act on being told.
 *
 * A lookup that throws for any other reason leaves the column alone. Clearing a
 * published handle because Telegram was briefly unreachable would take the
 * feature away from everybody during an outage, and the failure this guards
 * against is a slow one — a released handle is wrong for months, not minutes.
 */
export async function verifyPublishedHandles(
  db: Database,
  telegram: TelegramLookup,
  sender: DigestSender,
  alerter: Alerter,
): Promise<number> {
  let cleared = 0;

  for (const { telegramId, handle } of await publishedUsernames(db)) {
    let resolved: string;
    try {
      resolved = String((await telegram.getChat(`@${handle}`)).id);
    } catch {
      // "Chat not found" and a Telegram outage are indistinguishable from here,
      // and only one of them is a reason to unpublish. Leave it; tomorrow will
      // ask again.
      log.warn({ telegramId, handle }, 'could not check a published handle; leaving it alone');
      continue;
    }

    if (resolved === telegramId) continue;

    await clearUsername(db, telegramId);
    cleared += 1;

    await sender.send(
      telegramId,
      [
        `⚠️ @${handle} is no longer yours, so it is no longer published.`,
        '',
        'Teachers asking who covers their region now see your name and the support',
        'contact instead of a link to you.',
        '',
        'If you changed your Telegram username, set the new one with /username.',
      ].join('\n'),
    );

    await alerter.send({
      severity: 'warning',
      title: 'A published Telegram handle stopped matching its owner',
      body: [
        `@${handle} was published for staff member ${telegramId} and no longer resolves to them.`,
        '',
        'It has been unpublished. A Telegram username is a label its owner can',
        'release, and a released one can be claimed by anybody — so leaving it would',
        'have pointed teachers in that region at a stranger, with the Ministry’s',
        'bot vouching for it.',
        '',
        'They have been told and can set the new one with /username. This is here as',
        'well because the person who changed it is the least likely to act on being',
        'told they changed it.',
      ].join('\n'),
    });
  }

  return cleared;
}

export async function runDigest(
  db: Database,
  sender: DigestSender,
  telegram: TelegramLookup,
  alerter: Alerter,
): Promise<DigestReport> {
  // Reads first, writes second. The chase writes to `cases`, and a digest that
  // reported a case as chased before it was would be reporting the future.
  const digests = await sendStaffDigests(db, sender);
  const chase = await chaseTeachers(db, sender);

  await verifyPublishedHandles(db, telegram, sender, alerter);

  return {
    digestsSent: digests.sent,
    digestsSkipped: digests.skipped,
    teachersChased: chase.chased,
    ownersTold: chase.ownersTold,
    undeliverable: digests.undeliverable + chase.undeliverable,
  };
}

export const digestTask: Task = async () => {
  const db = getDb();
  const api = createApi();
  const alerter = telegramAlerter(api);
  const sender = telegramSender(api);

  const report = await recordJobRun(db, DIGEST_TASK, DIGEST_INTERVAL_SECONDS, () =>
    runDigest(db, sender, { getChat: (handle: string) => api.getChat(handle) }, alerter),
  );

  /**
   * One summary line, and no alert for an ordinary morning.
   *
   * Individual send failures are counted rather than alerted: a staff member who
   * has never opened a chat with the bot is an onboarding problem, and an alarm
   * about it every morning is one people mute.
   */
  log.info({ ...report }, 'digest: morning pass complete');
};
