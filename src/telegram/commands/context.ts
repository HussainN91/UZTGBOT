/**
 * The vocabulary every staff command file shares.
 *
 * Held apart from `index.ts` so that `staff.ts`, `cases.ts` and `ops.ts` can
 * import it without importing the dispatcher that imports them. That is not a
 * style preference: a value cycle between a command file and the registry would
 * work until the day somebody moved a `const` above a function, and the failure
 * — a half-initialised module — is one of the least legible in Node.
 *
 * Nothing here touches the database or Telegram.
 */
import { TELEGRAM_MESSAGE_MAX_CHARS, TIMEZONE } from '../../config/constants.js';
import type { Database } from '../../db/index.js';
import type { Capability } from '../../staff/roles.js';
import type { StaffRecord } from '../../staff/repository.js';
import type { StaffScope } from '../../staff/visibility.js';
import type { OutgoingMessage, RouterDeps, RouterOutcome } from '../router.js';
import type { InlineKeyboard } from '../keyboards.js';

/** Everything a command handler is given. It never re-reads any of it. */
export interface StaffContext {
  /** The caller's transaction, never the pool. */
  readonly db: Database;
  readonly member: StaffRecord;
  /**
   * The same member, in the shape the visibility predicate wants.
   *
   * Passed down rather than derived per command, so no command can accidentally
   * widen its own scope — `adminCanSeeCase_` was correct and was re-derived at
   * six call sites, and a seventh would have been an exposure with no error.
   */
  readonly scope: StaffScope;
  /** Everything after the command word, trimmed at the ends only. */
  readonly rest: string;
  readonly deps: RouterDeps;
}

export interface StaffCommand {
  /** Lower-cased, with the leading slash. Matched exactly. */
  readonly name: string;
  /**
   * What the sender must hold, or `null` for any active staff member.
   *
   * `null` is not "no check": the dispatcher has already refused anybody with no
   * active staff row by the time a handler sees this.
   */
  readonly capability: Capability | null;
  readonly handle: (ctx: StaffContext) => Promise<RouterOutcome>;
}

/**
 * The single-message answer most commands give.
 *
 * Clamped, always, and that is not defensive tidiness. Telegram rejects a
 * message over `TELEGRAM_MESSAGE_MAX_CHARS` with a 400; `send` turns that into a
 * throw, `deliver` catches it and alerts — so the staff member who asked a
 * question gets silence and an operator gets woken up. `/case` prints a
 * teacher's own words and several staff notes, none of which have a length
 * limit, so this is reachable by ordinary use rather than by abuse.
 *
 * Every staff command goes through here, so the guarantee is structural rather
 * than something each command has to remember.
 */
export function reply(chatId: string, text: string, keyboard?: InlineKeyboard): RouterOutcome {
  return {
    messages: [{ chatId, text: clampToTelegram(text), ...(keyboard !== undefined ? { keyboard } : {}) }],
    alerts: [],
  };
}

/**
 * The staff member's confirmation, followed by anyone else who must be told.
 *
 * `messages[0]` stays the answer to whoever typed the command — `deliver` words
 * its failure alarm from that position, and everything after it is expected to
 * carry a `purpose` naming what it was (R10).
 *
 * Every message is clamped, not just the first. A message to a teacher carries
 * `public_update`, which is staff free text of unbounded length, so it can reach
 * Telegram's limit exactly as `/case` can — and a reply that fails to send is a
 * teacher who is never told the answer to their problem.
 */
export function replyAndTell(
  chatId: string,
  text: string,
  others: readonly OutgoingMessage[],
): RouterOutcome {
  return {
    messages: [
      { chatId, text: clampToTelegram(text) },
      ...others.map((m) => ({ ...m, text: clampToTelegram(m.text) })),
    ],
    alerts: [],
  };
}

/**
 * Cut a message to something Telegram will actually deliver.
 *
 * The last line of defence, not the first: `/case` budgets the detail and each
 * note so this never fires in practice. It exists because a budget is
 * arithmetic — add a field, raise a cap, and the sum quietly stops fitting.
 *
 * It says what it did. A message that ends mid-sentence with no explanation
 * reads as a bot that broke, and the staff member's next move is to retry it.
 */
export function clampToTelegram(text: string): string {
  if (text.length <= TELEGRAM_MESSAGE_MAX_CHARS) return text;

  const notice = `\n\n… cut short — ${text.length - TELEGRAM_MESSAGE_MAX_CHARS} more characters than Telegram will send.`;
  return `${text.slice(0, TELEGRAM_MESSAGE_MAX_CHARS - notice.length)}${notice}`;
}

/**
 * A timestamp as the person reading it experiences it.
 *
 * Tashkent, always — a Linux server runs in UTC, which is five hours behind, so
 * an unqualified date on a case would be five hours early for everybody who
 * reads it. `constants.ts` states the whole argument at `TIMEZONE`.
 *
 * `Intl` here, and `to_char(... AT TIME ZONE ...)` in `notify.ts`, which is not
 * an inconsistency: these values come through the drizzle query builder, which
 * parses `timestamptz` into a real `Date`, whereas `notify.ts` reads through
 * `db.execute`, which hands back the raw string PostgreSQL sent. Formatting a
 * `Date` is the right tool for a `Date`; formatting in SQL is the right tool for
 * something that was never parsed.
 */
export function formatTashkent(when: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(when);
}

/**
 * How long ago, in the shortest form that is still honest.
 *
 * Measured against the process clock rather than the database's. That is
 * deliberate and is safe *here* precisely because it is not safe anywhere a
 * value is stored: this is a rounded age for a person to glance at, not a
 * stamp anything is compared against. Every timestamp that decides something —
 * `updated_at`, `closed_at`, the dedup window — is written by `now()` inside
 * PostgreSQL and never by this process.
 */
export function ageInDays(since: Date): string {
  const days = Math.floor((Date.now() - since.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  return days === 1 ? '1 day' : `${days} days`;
}

/** A staff row, reduced to the two axes the visibility predicate reads. */
export const scopeOf = (member: StaffRecord): StaffScope => ({
  role: member.role,
  queue: member.queue,
  regions: member.regions,
});

interface CapabilityInterface {
  /** What it lets you do, in the words a ministry staff member would use. */
  readonly summary: string;
  /** The commands it unlocks. Empty until stage 5 builds them. */
  readonly commands: readonly string[];
}

/**
 * Each capability, as a person sees it.
 *
 * Total over `Capability`, so a capability added to the ladder without a
 * description is a compile error rather than a permission somebody holds and
 * cannot discover. The lists are D7's table, which is also `BOT-SPEC.md` §6.1 —
 * and because `/whoami` and `/help` both render from here while the gates read
 * `FLOOR`, what the bot advertises is filtered by the same ladder that enforces
 * it. Only the wording is duplicated; the authorization is not.
 */
export const CAPABILITY_INTERFACE: Readonly<Record<Capability, CapabilityInterface>> = {
  'case.view': {
    summary: 'Read cases',
    commands: ['/cases', '/mycases', '/urgent', '/case', '/search'],
  },
  'case.update': {
    summary: 'Answer, close and reopen cases',
    commands: ['/reply', '/await', '/close', '/reopen', '/note', '/due', '/snooze'],
  },
  'case.mark': { summary: 'Say how serious a case is', commands: ['/mark'] },
  'case.assign': { summary: 'Give a case an owner', commands: ['/assign'] },
  'urgent.issue': {
    summary: 'Issue a one-time urgent code',
    commands: ['/generate_urgent_code'],
  },
  'teacher.region': { summary: 'Correct a teacher’s region', commands: ['/region', '/regions'] },
  /**
   * `/restore` is listed beside `/revoke` on purpose, and at the same rank (D27).
   * Whoever can make the mistake can undo it without escalating, and a person who
   * has just revoked the wrong teacher needs to find the way back on the same
   * line, not by asking somebody.
   */
  'teacher.revoke': { summary: 'End and return a teacher’s access', commands: ['/revoke', '/restore'] },
  'staff.manage': {
    summary: 'Add, rank and remove staff',
    commands: ['/staff', '/staff_add', '/staff_role', '/staff_remove'],
  },
  maintenance: { summary: 'Pause and resume new cases', commands: ['/maintenance'] },
  announce: { summary: 'Message teachers in bulk', commands: [] },
  export: { summary: 'Export case records', commands: [] },
};

/**
 * One line per capability, listing the commands it unlocks.
 *
 * A capability with no command yet says so rather than being hidden. Hiding it
 * would make `/whoami` describe a smaller permission model than the one in
 * force, which is the exact drift the single-table rule exists to prevent.
 */
export function describeCapabilities(capabilities: readonly Capability[]): string[] {
  return capabilities.map((capability) => {
    const { summary, commands } = CAPABILITY_INTERFACE[capability];
    return commands.length === 0
      ? `• ${summary} — no command for this yet`
      : `• ${summary}: ${commands.join(' ')}`;
  });
}
