/**
 * Commands about people rather than cases.
 *
 * `/whoami`, `/region` and `/regions` are here now; `/staff`, `/staff_add`,
 * `/staff_role`, `/staff_remove`, `/revoke` and `/restore` join them in task 36.
 */
import { STAFF_CASE_LIST_CAP } from '../../config/constants.js';
import { CAPABILITY, capabilitiesFor } from '../../staff/roles.js';
import type { StaffRecord } from '../../staff/repository.js';
import {
  clearRegionOverride,
  knownRegions,
  listRegionFlags,
  regionFor,
  setRegionOverride,
  type RegionFlag,
} from '../../teachers/region.js';
import { findTeacher } from '../../teachers/repository.js';
import {
  type StaffCommand,
  type StaffContext,
  ageInDays,
  describeCapabilities,
  reply,
} from './context.js';
import { splitChatId } from './parse.js';

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

// ---------------------------------------------------------------------------
// A teacher's region — Task 45, over D20 and D21
// ---------------------------------------------------------------------------

/**
 * Does this staff member cover a region?
 *
 * Three rules, and each of them is somewhere else in the system already:
 *
 * - An empty `regions` list means every region and never means none
 *   (`schema.ts:281`), so that adding the column could not narrow anybody's
 *   existing access.
 * - A region nobody has recorded is covered by everybody. That is D10's rule —
 *   an unknown region hides a case from nobody — and it must hold here too, or
 *   the teachers whose region is least certain become the ones nobody may
 *   correct.
 * - The comparison is case-insensitive, as `visibleToStaff` makes it, so that
 *   `Tashkent` and `tashkent` are not two provinces.
 */
const covers = (member: StaffRecord, region: string | null): boolean =>
  member.regions.length === 0 ||
  region === null ||
  member.regions.some((r) => r.toLowerCase() === region.toLowerCase());

/** Refusal text for a region outside the caller's reach, saying what to do instead. */
const outOfReach = (member: StaffRecord, what: string): string =>
  [
    what,
    '',
    `You cover ${describeRegions(member.regions)}.`,
    '',
    'Region decides who sees a teacher’s case, so moving one across a boundary you',
    'do not hold would take work away from whoever does. Ask somebody who covers',
    'both regions — a Program or System member covers all of them.',
  ].join('\n');

/**
 * `/region <chat_id> <region|clear>` — the only writer of a region correction.
 *
 * The bot never writes back to the spreadsheet (D20): it holds Viewer access to
 * one document, and edit access would reach the confidential answer bank in
 * another tab. So a correction lives in the database, an explicit decision by a
 * named person beats an import, and `clear` is the way back to whatever
 * recruitment says — which is also the recovery from a mistyped region.
 *
 * **Both ends of the move are checked, not just the destination.** Refusing only
 * the destination would stop a Samarkand lead pushing a teacher into Bukhara and
 * still let them pull one *out* of Bukhara into Samarkand, which is the same act
 * of taking work from the person holding it, viewed from the other side.
 */
export const region: StaffCommand = {
  name: '/region',
  capability: CAPABILITY.TEACHER_REGION,
  handle: async (ctx) => {
    const usage = [
      '/region 995101 Samarkand',
      '/region 995101 clear   — back to whatever the recruitment spreadsheet says',
      '',
      'The chat id is on /case, next to the teacher’s name.',
    ].join('\n');

    const split = splitChatId(ctx.rest);
    if (split === null) return reply(ctx.member.telegramId, `I need a teacher’s chat id first.\n\n${usage}`);

    const teacher = await findTeacher(ctx.db, split.chatId);
    if (teacher === null) {
      return reply(
        ctx.member.telegramId,
        `I have no teacher with chat id ${split.chatId}. Check it on /case — it is shown with the teacher’s name.`,
      );
    }

    const wanted = split.rest.trim();
    if (wanted === '') return reply(ctx.member.telegramId, `Which region?\n\n${usage}`);

    const held = await regionFor(ctx.db, split.chatId);

    if (/^(clear|none)$/i.test(wanted)) {
      if (!covers(ctx.member, held)) {
        return reply(
          ctx.member.telegramId,
          outOfReach(ctx.member, `${split.chatId} is in ${held ?? 'no region'}, which you do not cover.`),
        );
      }

      const done = await clearRegionOverride(ctx.db, split.chatId, ctx.member.telegramId);
      if (!done) return reply(ctx.member.telegramId, 'That teacher has gone. Nothing was changed.');

      const now = await regionFor(ctx.db, split.chatId);
      return reply(
        ctx.member.telegramId,
        [
          `${split.chatId} is back to what the recruitment spreadsheet says: ${now ?? 'no region at all'}.`,
          '',
          now === null
            ? 'With no region recorded, every staff member can see their cases.'
            : `Their cases now go to staff covering ${now}.`,
        ].join('\n'),
      );
    }

    /**
     * The region must be one this system has actually heard of. A typo would
     * otherwise be written happily and put the teacher in a province no staff
     * member covers — their cases visible only to all-region staff, routed
     * nowhere, and wrong in a way nothing would report. Refusing with the real
     * names is also how somebody finds out what the names are.
     */
    const known = await knownRegions(ctx.db);
    const canonical = known.find((r) => r.toLowerCase() === wanted.toLowerCase());
    if (canonical === undefined) {
      return reply(
        ctx.member.telegramId,
        [
          `I do not know a region called “${wanted}”, so nothing was changed.`,
          '',
          known.length === 0
            ? 'I know of no regions at all yet — the roster has none recorded.'
            : `The regions I know are: ${known.join(', ')}.`,
          '',
          'A region I have never seen is almost always a typo. If it is genuinely new,',
          'it reaches me when recruitment puts a teacher in it on the spreadsheet.',
        ].join('\n'),
      );
    }

    if (!covers(ctx.member, canonical)) {
      return reply(ctx.member.telegramId, outOfReach(ctx.member, `You do not cover ${canonical}.`));
    }

    if (!covers(ctx.member, held)) {
      return reply(
        ctx.member.telegramId,
        outOfReach(ctx.member, `${split.chatId} is in ${held ?? 'no region'}, which you do not cover.`),
      );
    }

    if (held !== null && held.toLowerCase() === canonical.toLowerCase()) {
      return reply(ctx.member.telegramId, `${split.chatId} is already in ${held}. Nothing changed.`);
    }

    const done = await setRegionOverride(ctx.db, split.chatId, canonical, ctx.member.telegramId);
    if (!done) return reply(ctx.member.telegramId, 'That teacher has gone. Nothing was changed.');

    return reply(
      ctx.member.telegramId,
      [
        `${split.chatId} is now in ${canonical}, was ${held ?? 'no region'}.`,
        '',
        `Their cases now go to staff covering ${canonical}, including the ones already open.`,
        'The recruitment spreadsheet is unchanged and this decision wins over it until',
        'somebody clears it with /region ' + split.chatId + ' clear.',
      ].join('\n'),
    );
  },
};

const renderFlag = (flag: RegionFlag): string =>
  [
    `${flag.chatId} — ${flag.name ?? 'name not recorded'}`,
    `  we hold ${flag.region ?? 'no region'} · reported ${ageInDays(flag.flaggedAt)} ago`,
  ].join('\n');

/**
 * `/regions` — teachers who have told us the region we hold for them is wrong.
 *
 * The reader for D21's flag. Without it the teacher-facing half of that decision
 * writes a signal into a column nobody looks at, which is the backward audit at
 * the top of the stage-4 plan happening again inside the same stage.
 *
 * Scoped to the regions the caller covers, and it is the region *we currently
 * hold* that decides that — see `listRegionFlags`. Where the teacher has
 * actually gone is precisely what nobody has been told yet, so it cannot be the
 * thing the list is filtered by.
 *
 * Fetched whole rather than paged. The list is small by construction: a row
 * leaves it the moment somebody acts, because `setRegionOverride` clears the
 * flag in the same statement it writes the region.
 */
export const regions: StaffCommand = {
  name: '/regions',
  capability: CAPABILITY.TEACHER_REGION,
  handle: async (ctx: StaffContext) => {
    const flags = await listRegionFlags(ctx.db, ctx.member.regions);

    if (flags.length === 0) {
      return reply(
        ctx.member.telegramId,
        [
          'No teacher has reported a wrong region.',
          '',
          `This covers ${describeRegions(ctx.member.regions)}, and a report leaves the list as`,
          'soon as somebody sets the region with /region.',
        ].join('\n'),
      );
    }

    const shown = flags.slice(0, STAFF_CASE_LIST_CAP);
    const heading =
      shown.length < flags.length
        ? `Teachers who say their region is wrong — showing ${String(shown.length)} of ${String(flags.length)}, oldest first`
        : `Teachers who say their region is wrong (${String(flags.length)}), oldest first`;

    return reply(
      ctx.member.telegramId,
      [
        heading,
        '',
        ...shown.map(renderFlag),
        '',
        'They told us it is wrong; they were not asked where they are now — a wrong tap',
        'would route somebody’s emergency to the wrong province. Ask them, then',
        '/region <chat id> <region>.',
      ].join('\n'),
    );
  },
};

/** Every command in this file, so registering one is a single edit. */
export const PEOPLE_COMMANDS: readonly StaffCommand[] = [whoami, region, regions];
