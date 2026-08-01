/**
 * The commands that change how the bot itself behaves — Task 37, and Task 61.
 *
 * `/maintenance` pauses new cases; `/urgent_pending` lists the priority requests
 * nobody has decided; `/retention` sets how long records are kept. None of them
 * is about one case or one person, which is why they are here rather than in
 * `cases.ts` or `staff.ts`.
 *
 * All three write an audit row (D18). Between them they are the only commands
 * that change what happens to *every* teacher rather than to one, and "who
 * paused the bot at three in the morning" is exactly the question the audit
 * table exists to answer.
 */
import { STAFF_CASE_LIST_CAP, TIMEZONE } from '../../config/constants.js';
import { pendingUrgentRequests } from '../../cases/urgent.js';
import { retentionParagraph } from '../../config/privacy.js';
import {
  RETENTION_AGREED,
  RETENTION_SETTING,
  type RetentionPeriods,
  isLongerThan,
  parsePeriod,
} from '../../config/retention.js';
import { SETTING, isMaintenanceMode, retentionPeriods, setSetting } from '../../config/settings.js';
import { recordAudit } from '../../log/audit.js';
import { CAPABILITY } from '../../staff/roles.js';
import { type StaffCommand, reply } from './context.js';

/**
 * What `/maintenance` accepts, matched exactly rather than by prefix.
 *
 * `off` and `on` differ by one character and mean opposite things, and a fuzzy
 * match — anything starting with "o" — would turn a typo into an outage. An
 * unrecognised word is refused with the current state rather than guessed.
 */
const parseOnOff = (value: string): boolean | null => {
  const word = value.trim().toLowerCase();
  if (['on', 'yes', 'true', 'pause', 'paused'].includes(word)) return true;
  if (['off', 'no', 'false', 'resume', 'resumed'].includes(word)) return false;
  return null;
};

/**
 * R6, stated in the confirmation because otherwise it is reported as a bug.
 *
 * A teacher already part-way through describing a case is deliberately **not**
 * blocked: the router checks maintenance when a case is started and when a topic
 * is chosen, not when the detail is submitted. `handleMaintenance_` says the same
 * (`AdminCommands.gs:1401`), and the reason is that blocking an in-flight
 * submission would throw away the words a teacher has just typed out.
 *
 * So cases keep arriving for a while after this is switched on. Without this
 * sentence the first System member to use it sees the trickle and reports the
 * pause as broken.
 */
const IN_FLIGHT_NOTE = [
  'Cases will keep arriving for a little while, and that is correct rather than a',
  'fault. A teacher already part-way through writing one is not interrupted —',
  'stopping them there would throw away everything they had typed.',
];

/**
 * `/maintenance on|off` — pause and resume new cases.
 *
 * Deliberately narrow. It stops *new cases*; the answer bank and Check My Case
 * stay live, because a teacher looking something up or checking a case they
 * already have is not creating work for anybody, and turning the whole bot off
 * would tell them nothing about why.
 *
 * With no argument it reports the current state and changes nothing. That is the
 * commonest thing somebody actually wants at three in the morning — "is it still
 * on?" — and making them type a word to find out invites them to type the wrong
 * one.
 */
export const maintenance: StaffCommand = {
  name: '/maintenance',
  capability: CAPABILITY.MAINTENANCE,
  handle: async (ctx) => {
    const usage = ['/maintenance on   — stop new cases', '/maintenance off  — let them through again'].join('\n');
    const currently = await isMaintenanceMode(ctx.db);
    const state = currently ? 'paused' : 'running normally';

    const wanted = ctx.rest.trim();
    if (wanted === '') {
      return reply(
        ctx.member.telegramId,
        [`New cases are ${state}.`, '', usage].join('\n'),
      );
    }

    const on = parseOnOff(wanted);
    if (on === null) {
      return reply(
        ctx.member.telegramId,
        [
          `I do not understand “${wanted}”, so nothing was changed.`,
          '',
          `New cases are ${state}.`,
          '',
          usage,
        ].join('\n'),
      );
    }

    if (on === currently) {
      return reply(
        ctx.member.telegramId,
        [`New cases are already ${state}. Nothing changed and nothing was recorded.`].join('\n'),
      );
    }

    /**
     * `setSetting` drops the cached value, so the next message sees this rather
     * than up to a minute of staleness. That is the whole reason the writer lives
     * beside the cache instead of being an ordinary update.
     */
    await setSetting(ctx.db, SETTING.MAINTENANCE_MODE, on ? 'TRUE' : 'FALSE', ctx.member.telegramId);
    await recordAudit(ctx.db, {
      actor: ctx.member.telegramId,
      action: 'MAINTENANCE_SET',
      detail: { to: on ? 'on' : 'off' },
    });

    return reply(
      ctx.member.telegramId,
      on
        ? [
            '⏸ New cases are paused.',
            '',
            'Teachers tapping Contact Support or Ask for Priority are told the team is dealing',
            'with something, and are given the support contact. The answer bank and Check',
            'My Case still work.',
            '',
            ...IN_FLIGHT_NOTE,
            '',
            '/maintenance off — let them through again.',
          ].join('\n')
        : [
            '▶️ New cases are running normally again.',
            '',
            'Contact Support and Ask for Priority work as usual from the next message.',
          ].join('\n'),
    );
  },
};

/**
 * `/urgent_pending` — the requests nobody has decided.
 *
 * **This replaced `/generate_urgent_code` on 1 August 2026.** That command
 * issued the one-time code a teacher had to be read down the telephone before
 * they were allowed to describe their problem, and the whole route went with it.
 * The capability it was gated on did not: `urgent.issue` now means "may decide
 * that a case jumps the queue", which is the same authority pointed at the
 * decision rather than at the credential.
 *
 * It exists because the programme plan accepts, explicitly, that a pending
 * request waits on one regional coordinator and declines to auto-escalate —
 * auto-escalation would push every frivolous request to Program anyway, which
 * defeats the gate. Visibility was chosen instead of automation, which only
 * works if there is something to look at.
 *
 * Unscoped by queue and region, deliberately: this is a supervision list, and a
 * supervisor filtered to their own region cannot see that another region has
 * stopped answering. It shows references and waiting times, never a teacher's
 * words — those stay behind `/case`, which records who read them.
 */
export const urgentPending: StaffCommand = {
  name: '/urgent_pending',
  capability: CAPABILITY.URGENT_ISSUE,
  handle: async (ctx) => {
    const waiting = await pendingUrgentRequests(ctx.db, STAFF_CASE_LIST_CAP);

    if (waiting.length === 0) {
      return reply(
        ctx.member.telegramId,
        [
          'No priority requests are waiting for a decision.',
          '',
          'Every request that has been made has been either confirmed or overtaken by',
          'the case being marked urgent some other way.',
        ].join('\n'),
      );
    }

    return reply(
      ctx.member.telegramId,
      [
        `⏫ ${waiting.length} priority request(s) waiting for a decision`,
        '',
        ...waiting.map((r) => `${r.reference} — asked ${r.requestedAt} (${TIMEZONE})`),
        '',
        'Nothing escalates these on its own, by design. Open one to read it, then',
        'confirm it with the button on the message you were sent.',
        '',
        '/case <reference> — read it, including what the teacher wrote',
      ].join('\n'),
    );
  },
};

/**
 * The three classes a period governs, and the word a person types for each.
 *
 * Keyed off `RETENTION_SETTING` rather than by writing the three keys out again,
 * for the reason `SETTING` spreads it: two lists that have to agree with nothing
 * enforcing it is the fault `status.ts` was created to fix.
 *
 * `field` is what the same class is called on `RetentionPeriods`, so the value
 * printed back and the value compared for lengthening are read from one object
 * rather than looked up twice by hand.
 */
const RETENTION_CLASS = {
  case: {
    key: RETENTION_SETTING.CASE_RETENTION_DAYS,
    field: 'caseDays',
    what: 'Resolved cases',
    /** What stops being deleted when this is unset, in the words D30 requires. */
    nothing: 'no resolved case is being deleted',
  },
  urgent: {
    key: RETENTION_SETTING.URGENT_CASE_RETENTION_DAYS,
    field: 'urgentCaseDays',
    what: 'Resolved cases marked urgent or critical',
    nothing: 'no resolved urgent or critical case is being deleted',
  },
  messages: {
    key: RETENTION_SETTING.MESSAGE_RETENTION_DAYS,
    field: 'messageDays',
    what: 'The messages teachers send, and the interaction log',
    nothing: 'nothing in the interaction log is being deleted',
  },
} as const satisfies Record<string, { key: string; field: keyof RetentionPeriods; what: string; nothing: string }>;

type RetentionClassName = keyof typeof RETENTION_CLASS;

/**
 * The words accepted for each class, matched exactly.
 *
 * Exact rather than by prefix, and for the same reason `parseOnOff` is exact:
 * `urgent` and `case` govern periods that differ by a factor of twenty-five, and
 * a fuzzy match that resolved a typo to the wrong one would delete six months of
 * emergency cases in a week. An unrecognised word is refused with the list.
 */
const CLASS_WORD: Readonly<Record<string, RetentionClassName>> = {
  case: 'case',
  cases: 'case',
  urgent: 'urgent',
  critical: 'urgent',
  message: 'messages',
  messages: 'messages',
};

const RETENTION_USAGE = [
  '/retention                  — show the three periods',
  '/retention case 7           — resolved cases',
  '/retention urgent 180       — resolved cases marked urgent or critical',
  '/retention messages 3       — messages and the interaction log',
];

const describePeriod = (days: number | null): string =>
  days === null ? 'not set' : days === 1 ? '1 day' : `${days} days`;

/** The three periods as a person reads them, with D30's consequence spelt out. */
function describePeriods(periods: RetentionPeriods): string[] {
  const lines: string[] = [];

  for (const name of Object.keys(RETENTION_CLASS) as RetentionClassName[]) {
    const { field, what, nothing } = RETENTION_CLASS[name];
    const days = periods[field];
    lines.push(
      days === null ? `• ${what}: not set — ${nothing}.` : `• ${what}: ${describePeriod(days)}.`,
    );
  }

  return lines;
}

/**
 * `/retention` — how long records are kept, and the one command that can delete
 * them.
 *
 * With no arguments it reports and changes nothing, exactly as `/maintenance`
 * does, because that is the commonest thing anybody actually wants. It prints
 * the periods, what a teacher is told about them, and — for anything unset —
 * that nothing of that class is being deleted. D30 predicts that state will be
 * reported as a fault, so the command says it plainly rather than showing a
 * blank.
 *
 * At `MAINTENANCE`, which floors at System. A period governs a deletion that has
 * no undo, and the ladder already has the right rank for that.
 */
export const retention: StaffCommand = {
  name: '/retention',
  capability: CAPABILITY.MAINTENANCE,
  handle: async (ctx) => {
    const current = await retentionPeriods(ctx.db);

    const wanted = ctx.rest.trim();
    if (wanted === '') {
      return reply(
        ctx.member.telegramId,
        [
          '🗄 *Retention periods*',
          '',
          ...describePeriods(current),
          '',
          'What teachers are told, in the privacy notice:',
          '',
          ...retentionParagraph(current),
          '',
          `Agreed on 29 July 2026: cases ${RETENTION_AGREED.caseDays}, urgent ${RETENTION_AGREED.urgentCaseDays}, messages ${RETENTION_AGREED.messageDays}.`,
          '',
          ...RETENTION_USAGE,
        ].join('\n'),
      );
    }

    const parts = wanted.split(/\s+/);
    const name = CLASS_WORD[(parts[0] ?? '').toLowerCase()];
    if (name === undefined || parts.length !== 2) {
      return reply(
        ctx.member.telegramId,
        [
          `I do not understand “${wanted}”, so nothing was changed.`,
          '',
          ...describePeriods(current),
          '',
          ...RETENTION_USAGE,
        ].join('\n'),
      );
    }

    const { key, field, what } = RETENTION_CLASS[name];
    const was = current[field];

    /**
     * `parsePeriod` decides, not this command. A `0` here would mean "delete
     * everything that is closed" if it were read as a number, and it is one
     * keystroke from `7` — so the same function that makes the job refuse it
     * makes the command refuse it, and there is no second opinion about what a
     * bad value means.
     */
    const days = parsePeriod(parts[1]!);
    if (days === null) {
      return reply(
        ctx.member.telegramId,
        [
          `“${parts[1]}” is not a number of days, so nothing was changed.`,
          '',
          `${what}: ${describePeriod(was)}.`,
          '',
          'A period is a whole number of days, one or more. Zero is refused rather',
          'than read as “delete everything”.',
        ].join('\n'),
      );
    }

    if (days === was) {
      return reply(
        ctx.member.telegramId,
        `${what} are already kept for ${describePeriod(days)}. Nothing changed and nothing was recorded.`,
      );
    }

    await setSetting(ctx.db, key, String(days), ctx.member.telegramId);
    await recordAudit(ctx.db, {
      actor: ctx.member.telegramId,
      action: 'RETENTION_SET',
      subject: key,
      detail: { from: was, to: days },
    });

    const after: RetentionPeriods = { ...current, [field]: days };

    /**
     * R20, and the reason this warning exists at all: lengthening a period is a
     * change to what teachers were promised, so `requiresReconsent` will ask
     * every one of them to read the notice again. The write still happens — this
     * is a decision a System member is entitled to take — but they should learn
     * the cost here rather than from the outbound message count.
     *
     * Setting a period for the first time is a *shortening*: unset means kept
     * indefinitely, which is the longest period there is. So the common case at
     * launch, seeding all three, warns about nothing, which is correct.
     */
    const lengthened = isLongerThan(days, was);

    return reply(
      ctx.member.telegramId,
      [
        `✅ ${what}: ${describePeriod(was)} → ${describePeriod(days)}.`,
        '',
        ...describePeriods(after),
        ...(lengthened
          ? [
              '',
              '⚠️ This is longer than teachers were told, so about 1,800 of them will be',
              'asked to read the privacy notice again the next time they use the bot.',
            ]
          : []),
        '',
        'The nightly job deletes on this period from tonight. There is no undo.',
      ].join('\n'),
    );
  },
};

export const OPS_COMMANDS: readonly StaffCommand[] = [maintenance, urgentPending, retention];
