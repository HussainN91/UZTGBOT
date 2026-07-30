/**
 * Every message the scheduled jobs send, built from rows.
 *
 * Pure — no database, no Telegram, no clock. That is what lets the exact words a
 * staff member reads at seven in the morning, and the exact words a teacher is
 * chased with, be checked in a test with nothing running.
 *
 * Two properties are load-bearing here and both are faults elsewhere if they
 * slip:
 *
 *   **A teacher's own words are never in any of these.** `StaffCaseRow` carries
 *   `detail`, and it is deliberately not rendered. Twenty Telegram histories is
 *   not where a teacher's account of their problem belongs; staff read it with
 *   `/case`, which checks permission first and leaves a row saying who read it.
 *
 *   **These messages are built in the worker, so `reply()`'s clamp does not
 *   apply to them.** Telegram refuses a message over 4096 characters, `send`
 *   throws, and the digest is then lost while an operator is woken. The budget
 *   below is the arithmetic; `clamp` is the guarantee, because arithmetic goes
 *   wrong quietly.
 */
import type { StaffCaseList, StaffCaseRow } from '../cases/queries.js';
import {
  DIGEST_LIST_CAP,
  TEACHER_CHASE_MAX,
  TELEGRAM_MESSAGE_MAX_CHARS,
  TIMEZONE,
} from '../config/constants.js';

/**
 * `StaffCaseRow` is a type-only import pointing at a layer above this one, and
 * that is deliberate and permitted: type imports are erased at compile time, so
 * a pure module can borrow a shape without depending on it at run time. The
 * dependency checker knows the rule. Re-declaring the row here would be a second
 * copy of a shape that has to agree with the query that produces it.
 */

const tashkent = (value: Date): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);

/**
 * Never longer than Telegram will deliver, whatever the arithmetic above said.
 *
 * Truncated with a marker rather than silently: somebody who cannot see the last
 * lines must know there were some, which is the whole argument behind every
 * capped list in this system reporting its total.
 */
function clamp(text: string): string {
  if (text.length <= TELEGRAM_MESSAGE_MAX_CHARS) return text;
  const marker = '\n… truncated. Use /cases to see the rest.';
  return `${text.slice(0, TELEGRAM_MESSAGE_MAX_CHARS - marker.length)}${marker}`;
}

/** One case, on one line, with nothing on it a teacher wrote. */
function line(row: StaffCaseRow): string {
  const parts = [`• ${row.reference} — ${row.status}`];
  if (row.importance !== 'Normal') parts.push(`[${row.importance}]`);
  if (row.region !== null) parts.push(`· ${row.region}`);
  if (row.dueAt !== null) parts.push(`· due ${tashkent(row.dueAt)}`);
  return parts.join(' ');
}

/**
 * A capped section, or nothing at all when the list is empty.
 *
 * The total is of everything matching and visible, not of everything shown, so a
 * backlog of two hundred cannot look identical to a backlog of ten.
 */
function section(heading: string, list: StaffCaseList): string[] {
  if (list.cases.length === 0) return [];

  const shown = list.cases.slice(0, DIGEST_LIST_CAP);
  const hidden = list.total - shown.length;

  return [
    heading,
    ...shown.map(line),
    ...(hidden > 0 ? [`  …and ${hidden} more.`] : []),
    '',
  ];
}

export interface DigestLists {
  /** Theirs, and past the date somebody promised. */
  readonly pastDue: StaffCaseList;
  /** In their queue and region, and nobody has touched them. */
  readonly stale: StaffCaseList;
  /** In their queue and region, with no owner at all. */
  readonly unassigned: StaffCaseList;
}

/**
 * One staff member's morning, or `null` when they have nothing.
 *
 * **`null` is the point, not an edge case** (D39). A daily message that says
 * "nothing to do" is a daily message people filter, and then they filter the one
 * that matters. Deciding it here rather than in the job means the rule lives in
 * one place and the job cannot send an empty digest by accident.
 *
 * The three lists stay apart because they mean different things and need
 * different acts. A promise somebody made and missed is not the same as a case
 * nobody has touched, and neither is the same as a case nobody has taken — a
 * case can be in all three or in none.
 */
export function staffDigest(lists: DigestLists): string | null {
  const body = [
    ...section('⏰ *Past the date you promised*', lists.pastDue),
    ...section('🕸 *Nobody has touched these*', lists.stale),
    ...section('📥 *Waiting to be taken*', lists.unassigned),
  ];

  if (body.length === 0) return null;

  return clamp(
    ['☀️ *Your cases this morning*', '', ...body, '/mycases · /cases unassigned'].join('\n'),
  );
}

/**
 * The reminder a teacher gets when their case is waiting on them.
 *
 * `public_update` is quoted verbatim and never parsed. It is what `/await`
 * wrote, it is the only case text a teacher ever sees, and a taxonomy of action
 * types is coming later (D26) — this renders whatever that produces as text.
 *
 * It offers Check My Case rather than only asking again, because a teacher who
 * has already done what was asked and heard nothing needs a route that is not
 * silence.
 */
export function teacherChaseMessage(row: StaffCaseRow): string {
  return clamp(
    [
      `📌 Your case ${row.reference} is waiting for you.`,
      '',
      row.publicUpdate.trim() === ''
        ? 'Our staff need something from you before it can move forward.'
        : `What we need:\n${row.publicUpdate.trim()}`,
      '',
      'Reply here, or use Check My Case to see where it stands. If you have already',
      'sent this to us, Check My Case will show what we have.',
    ].join('\n'),
  );
}

/**
 * Told to whoever holds a case after the teacher has stopped answering.
 *
 * The end of D40's cap, and the only thing in this system that has ever produced
 * this signal. Three unanswered reminders over nine days is a teacher who has
 * left, changed number, or given up — which is exactly the situation
 * `/close <ref> unresolved <reason>` was built for, so the message names it.
 */
export function chaseExhaustedMessage(row: StaffCaseRow): string {
  return clamp(
    [
      `🔇 ${row.reference} — the teacher has not answered.`,
      '',
      `Reminded ${TEACHER_CHASE_MAX} times and nothing has come back. Nothing further`,
      'will be sent to them about this case.',
      '',
      `/case ${row.reference} — read it`,
      `/close ${row.reference} unresolved <why> — shut it without pretending it was fixed`,
      `/await ${row.reference} <what is needed> — ask again and restart the reminders`,
    ].join('\n'),
  );
}

export interface AnnouncementOutcome {
  readonly sent: number;
  readonly skipped: number;
  readonly failed: number;
  readonly total: number;
}

/**
 * What the sender is told when a broadcast finishes.
 *
 * Three counts, never one (D41). "1,780 sent" hides both the teachers who lost
 * access between the draft and the send — who were correctly not messaged — and
 * the ones Telegram refused, who may need a person. They need different things
 * done about them, so they are counted separately, and a count that is zero is
 * left out rather than reported as a reassuring nought.
 */
export function announcementReport(outcome: AnnouncementOutcome): string {
  const lines = [
    '📣 *Announcement finished*',
    '',
    `Sent: ${outcome.sent} of ${outcome.total}.`,
  ];

  if (outcome.skipped > 0) {
    lines.push(`Skipped: ${outcome.skipped} — they no longer have access to the bot.`);
  }
  if (outcome.failed > 0) {
    lines.push(
      `Failed: ${outcome.failed} — Telegram would not deliver to them, usually because`,
      'they have blocked the bot or never started a chat with it.',
    );
  }

  return clamp(lines.join('\n'));
}
