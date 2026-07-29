/**
 * Commands about people rather than cases.
 *
 * `/whoami` is here now; `/staff`, `/staff_add`, `/staff_role`, `/staff_remove`
 * and `/revoke` join it in tasks 36 and 30's command half.
 */
import { capabilitiesFor } from '../../staff/roles.js';
import type { StaffRecord } from '../../staff/repository.js';
import { type StaffCommand, describeCapabilities, reply } from './context.js';

/**
 * A staff member's regions, or the fact that they have all of them.
 *
 * An empty array means every region and never means none (`schema.ts:281`).
 * Printing an empty list would read as "no access at all" to the one person
 * whose access is widest, which is the sort of misreading that ends in somebody
 * being granted a rank they did not need.
 */
const describeRegions = (regions: readonly string[]): string =>
  regions.length === 0 ? 'every region' : regions.join(', ');

/**
 * What this account may do, read from the table the gates read.
 *
 * `handleWhoAmI_` (`AdminCommands.gs:453`) records this as a deliberate
 * property, and it is the reason `capabilitiesFor` exists: the answer to "what
 * am I allowed to do" is computed from `FLOOR`, exactly like the answer to "may
 * I do this". The Apps Script version drifted because those were two lists.
 */
export function whoamiText(member: StaffRecord): string {
  return [
    `You are signed in as staff${member.name === null ? '' : `, ${member.name}`}.`,
    '',
    `Rank: ${member.role}`,
    `Queue: ${member.queue}`,
    `Regions: ${describeRegions(member.regions)}`,
    '',
    'You may:',
    ...describeCapabilities(capabilitiesFor(member.role)),
    '',
    '/whoami — this message',
  ].join('\n');
}

export const whoami: StaffCommand = {
  name: '/whoami',
  /**
   * Every active staff member, whatever their rank.
   *
   * An Observer who cannot find out what an Observer is has been given a rank
   * and no way to understand it, and the first-week hires this rank exists for
   * are precisely the people who will ask.
   */
  capability: null,
  handle: async (ctx) => reply(ctx.member.telegramId, whoamiText(ctx.member)),
};
