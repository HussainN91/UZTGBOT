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
import type { Database } from '../../db/index.js';
import type { Capability } from '../../staff/roles.js';
import type { StaffRecord } from '../../staff/repository.js';
import type { StaffScope } from '../../staff/visibility.js';
import type { RouterDeps, RouterOutcome } from '../router.js';
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

/** The single-message answer most commands give. */
export function reply(chatId: string, text: string, keyboard?: InlineKeyboard): RouterOutcome {
  return {
    messages: [{ chatId, text, ...(keyboard !== undefined ? { keyboard } : {}) }],
    alerts: [],
  };
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
  'teacher.revoke': { summary: 'End a teacher’s access', commands: ['/revoke'] },
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
