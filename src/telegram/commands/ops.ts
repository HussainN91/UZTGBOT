/**
 * The two commands that change how the bot itself behaves — Task 37.
 *
 * `/maintenance` pauses new cases; `/generate_urgent_code` issues the one-time
 * code that opens an escalated one. Neither is about a case or a person, which
 * is why they are here rather than in `cases.ts` or `staff.ts`.
 *
 * Both write an audit row (D18). Between them they are the only two commands in
 * the stage that change what happens to *every* teacher rather than to one, and
 * "who paused the bot at three in the morning" is exactly the question the audit
 * table exists to answer.
 */
import { TIMEZONE } from '../../config/constants.js';
import { issueUrgentCode } from '../../cases/urgent.js';
import { SETTING, isMaintenanceMode, setSetting } from '../../config/settings.js';
import { recordAudit } from '../../log/audit.js';
import { CAPABILITY } from '../../staff/roles.js';
import { type StaffCommand, formatTashkent, reply } from './context.js';

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
 * submission would throw away a spent urgent code and the words a teacher has
 * just typed out.
 *
 * So cases keep arriving for a while after this is switched on. Without this
 * sentence the first System member to use it sees the trickle and reports the
 * pause as broken.
 */
const IN_FLIGHT_NOTE = [
  'Cases will keep arriving for a little while, and that is correct rather than a',
  'fault. A teacher already part-way through writing one is not interrupted —',
  'stopping them there would throw away what they had typed, and an urgent code',
  'they had already spent.',
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
            'Teachers tapping Contact Support or Urgent Case are told the team is dealing',
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
            'Contact Support and Urgent Case work as usual from the next message.',
          ].join('\n'),
    );
  },
};

/**
 * `/generate_urgent_code` — the code a teacher types to open an escalated case.
 *
 * The first writer `urgent_codes.issued_by` has ever had. Every code that has
 * existed until now was inserted by hand through the runbook with `'0'` in that
 * column, and `'0'` names nobody — so the alarm that fires when a code is spent
 * without buying a case has never been able to say whose teacher was stranded.
 *
 * Available from `Support` upward, which is lower than it first looks and is
 * deliberate: the person a teacher telephones in an emergency is whoever is on
 * the support desk, and a code that needs a Lead to authorise is a code that
 * arrives after the emergency.
 *
 * **The code is printed once and never again.** Nothing in this system can show
 * it a second time, because nothing needs to — an unused code that has been lost
 * costs one more command, and a command that could re-display codes would turn
 * every staff account into a way of reading them all.
 */
export const generateUrgentCode: StaffCommand = {
  name: '/generate_urgent_code',
  capability: CAPABILITY.URGENT_ISSUE,
  handle: async (ctx) => {
    const issued = await issueUrgentCode(ctx.db, ctx.member.telegramId);

    return reply(
      ctx.member.telegramId,
      [
        `🚨 Urgent code: ${issued.code}`,
        '',
        `Usable once, until ${formatTashkent(issued.expiresAt)} (${TIMEZONE}).`,
        '',
        'Read it to the teacher and have them tap Urgent Case, then type it. It is',
        'not used up until their case is actually filed, so they can take the time to',
        'describe the emergency properly.',
        '',
        'This is the only time it is shown. Nothing can display it again — issue',
        'another if it is lost, and this one simply expires unused.',
        '',
        'It is recorded against your name.',
      ].join('\n'),
    );
  },
};

export const OPS_COMMANDS: readonly StaffCommand[] = [maintenance, generateUrgentCode];
