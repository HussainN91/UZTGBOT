/**
 * Commands about people rather than cases.
 *
 * Two groups, and they are here together because both answer "who is this
 * person and what may they do": the staff table's own writers (`/staff`,
 * `/staff_add`, `/staff_role`, `/staff_remove`), and the two commands that end
 * and return a teacher's access (`/revoke`, `/restore`). `/region` and
 * `/regions` sit between them, correcting the other axis that decides who sees
 * whose case.
 */
import { STAFF_BUTTON_CAP, STAFF_CASE_LIST_CAP } from '../../config/constants.js';
import { CALLBACK, callbackPartProblem, encodeCallback } from '../callback-data.js';
import type { InlineButton, InlineKeyboard, InlineKeyboardRow } from '../keyboards.js';
import type { Database } from '../../db/index.js';
/**
 * Type-only, and pointing at the layer above — permitted, checked, and erased at
 * compile time. `cases/notify.ts` carries the same note for the same reason.
 */
import type { RouterOutcome } from '../router.js';
import { casesOwnedBy, listCases } from '../../cases/queries.js';
import { STAFF_ROLE_ORDER, type IdentityDisputeState, type StaffRole } from '../../db/schema.js';
import { ALL_QUEUES, QUEUE, type Queue } from '../../staff/queues.js';
import { CAPABILITY, capabilitiesFor } from '../../staff/roles.js';
import {
  StaffAlreadyExistsError,
  addStaff,
  clearUsername,
  countActiveSystem,
  deactivateStaff,
  findAnyStaff,
  listStaff,
  normaliseHandle,
  setStaffRegions,
  setStaffQueue,
  setStaffRole,
  setUsername,
  type StaffRecord,
} from '../../staff/repository.js';
import {
  clearRegionOverride,
  knownRegions,
  listRegionFlags,
  regionFor,
  setRegionOverride,
  type RegionFlag,
} from '../../teachers/region.js';
import { forgetTeacher } from '../../teachers/forget.js';
import { openDisputes } from '../../teachers/disputes.js';
import { settleAndAnnounce } from '../dispute-actions.js';
import {
  findTeacher,
  restoreTeacher,
  revokeTeacher,
  teacherHasAccess,
  type TeacherRecord,
} from '../../teachers/repository.js';
import {
  type StaffCommand,
  type StaffContext,
  ageInDays,
  describeCapabilities,
  reply,
  replyAndTell,
  scopeOf,
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
 *   `Tashkent` and `tashkent` are not two regions.
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
     * otherwise be written happily and put the teacher in a region no staff
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
        'would route somebody’s emergency to the wrong region. Ask them, then',
        '/region <chat id> <region>.',
      ].join('\n'),
    );
  },
};

// ---------------------------------------------------------------------------
// The staff table's own writers — Task 36, over D13, D14 and D18
// ---------------------------------------------------------------------------

/** A staff member as another staff member should see them named. */
const describeStaff = (member: { telegramId: string; name: string | null }): string =>
  member.name === null ? member.telegramId : `${member.name} (${member.telegramId})`;

/**
 * Take the first word off a line, leaving the rest intact.
 *
 * `/staff_add` is the only command in the stage taking three positional
 * arguments, and the remainder after them is a list rather than a phrase — so it
 * cannot use `splitChatId`'s "head and everything else" shape twice and stop.
 */
const takeWord = (text: string): { readonly word: string; readonly rest: string } => {
  const trimmed = text.trim();
  const boundary = trimmed.search(/\s/);
  return boundary === -1
    ? { word: trimmed, rest: '' }
    : { word: trimmed.slice(0, boundary), rest: trimmed.slice(boundary).trim() };
};

/**
 * A rank and a queue are matched case-insensitively and written back in the
 * spelling the schema uses, for the same reason `/region` canonicalises a region:
 * `system` and `System` must not become two things a later reader has to
 * reconcile. An unknown word is refused with the real list rather than defaulted
 * — the repository's own comment says why a default here grants more than the
 * caller asked for, invisibly.
 */
const parseRole = (value: string): StaffRole | null =>
  STAFF_ROLE_ORDER.find((role) => role.toLowerCase() === value.toLowerCase()) ?? null;

const parseQueue = (value: string): Queue | null =>
  ALL_QUEUES.find((queue) => queue.toLowerCase() === value.toLowerCase()) ?? null;

const roleList = (): string => STAFF_ROLE_ORDER.join(', ');
const queueList = (): string => ALL_QUEUES.join(', ');

/** One staff row on one line, in the order somebody reads it. */
const staffLine = (member: StaffRecord): string =>
  [
    `${member.telegramId} — ${member.name ?? 'name not recorded'}`,
    `  ${member.role} · ${member.queue} queue · ${describeRegions(member.regions)}`,
  ].join('\n');

/**
 * `/staff` — everybody, with the deactivated kept separate rather than hidden.
 *
 * Both halves are shown because both are needed. `/assign` tells people to check
 * an id here, and an id that is absent because the row is deactivated looks
 * exactly like an id that was mistyped — while `/staff_role` is the way back from
 * `/staff_remove`, and it cannot be used against somebody the list will not show.
 */
export const staffList: StaffCommand = {
  name: '/staff',
  capability: CAPABILITY.STAFF_MANAGE,
  handle: async (ctx) => {
    const everybody = await listStaff(ctx.db, { includeInactive: true });
    const active = everybody.filter((m) => m.active);
    const inactive = everybody.filter((m) => !m.active);

    const shown = active.slice(0, STAFF_CASE_LIST_CAP);
    const heading =
      shown.length < active.length
        ? `Staff — showing ${String(shown.length)} of ${String(active.length)}`
        : `Staff (${String(active.length)})`;

    const lines =
      active.length === 0
        ? ['Nobody is active. That should be impossible — the first System row is created by hand.']
        : [heading, '', ...shown.map(staffLine)];

    if (inactive.length > 0) {
      lines.push(
        '',
        `Deactivated (${String(inactive.length)}) — /staff_role puts somebody back`,
        '',
        ...inactive.slice(0, STAFF_CASE_LIST_CAP).map(staffLine),
      );
    }

    /**
     * The text list keeps everything it always had, and gains buttons — Part
     * 5H.3. Both, not one: the text carries chat ids, deactivated rows and the
     * counts, which a row of buttons cannot; the buttons are what turn "I want
     * to change this person" from four commands into three taps.
     */
    return reply(
      ctx.member.telegramId,
      [...lines, '', 'Or tap somebody below to change their rank, queue or regions.'].join('\n'),
      staffListKeyboard(everybody),
    );
  },
};

/**
 * Turn a comma-separated list into regions this system has actually heard of.
 *
 * The same rule `/region` applies and for the same reason (departure 17): a typo
 * written happily gives a staff member a region no teacher is in, so their queue
 * is silently empty and nothing anywhere reports it. The failure is quieter here
 * than on a teacher, because an over-narrow staff row looks like a quiet week.
 */
type ParsedRegions =
  | { readonly ok: true; readonly regions: readonly string[] }
  | { readonly ok: false; readonly text: string };

async function parseRegions(ctx: StaffContext, list: string): Promise<ParsedRegions> {
  const wanted = list
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r !== '');

  if (wanted.length === 0) return { ok: true, regions: [] };

  const known = await knownRegions(ctx.db);
  const canonical: string[] = [];

  for (const one of wanted) {
    const match = known.find((r) => r.toLowerCase() === one.toLowerCase());
    if (match === undefined) {
      /**
       * The empty case is its own message rather than a shorter version of the
       * other. Before the first sync there are no regions at all, and "the
       * regions I know are: " followed by nothing reads as a broken command — the
       * useful thing to say is that leaving regions off is both available and the
       * safe answer.
       */
      const help =
        known.length === 0
          ? [
              'I know of no regions at all yet — the roster has none recorded.',
              '',
              'Leave the regions off entirely and this person covers every region, which',
              'is the safe default. Narrow it once the roster has synced.',
            ]
          : [`The regions I know are: ${known.join(', ')}.`];

      return {
        ok: false,
        text: [`I do not know a region called “${one}”, so nothing was written.`, '', ...help].join('\n'),
      };
    }
    if (!canonical.some((r) => r.toLowerCase() === match.toLowerCase())) canonical.push(match);
  }

  return { ok: true, regions: canonical };
}

/**
 * What somebody is told when their own staff access changes.
 *
 * Always sent. A rank that changes without the holder knowing produces somebody
 * who either believes they still hold a permission they do not, or does not know
 * about one they now do — and `purpose` is set because every message to a chat
 * other than the sender's carries one (R10).
 */
const accessChangedNotice = (
  chatId: string,
  lines: readonly string[],
): { readonly chatId: string; readonly text: string; readonly purpose: string } => ({
  chatId,
  text: lines.join('\n'),
  purpose: 'a notice to a staff member that their own access has changed',
});

/**
 * `/staff_add <chat id> <rank> <queue> [regions]` — adding, and only adding.
 *
 * Rank and queue are required arguments rather than defaulted ones. The schema
 * defaults both so that adding those columns could not break existing rows;
 * a command that lets a caller omit them grants Support over every queue to
 * somebody they may have meant to restrict, and nothing in what they typed shows
 * it. Regions omitted **does** mean every region — that is what an empty list
 * means everywhere in this system, and it is the wider of the two, so it is
 * stated back in the confirmation rather than assumed to have been understood.
 *
 * An existing row is refused and pointed at `/staff_role`. `/add_admin` used to
 * upsert, and its defaulting fourth argument stripped `IS_SYSTEM_ADMIN` from
 * whatever row it landed on — including the caller's own
 * (`AdminCommands.gs:1089`).
 */
export const staffAdd: StaffCommand = {
  name: '/staff_add',
  capability: CAPABILITY.STAFF_MANAGE,
  handle: async (ctx) => {
    const usage = [
      '/staff_add 991001 Support Visa',
      '/staff_add 991001 Lead All Tashkent, Samarkand',
      '',
      `Ranks: ${roleList()}`,
      `Queues: ${queueList()}`,
      'Regions are optional and comma-separated. Leave them off for every region.',
    ].join('\n');

    const split = splitChatId(ctx.rest);
    if (split === null) {
      return reply(ctx.member.telegramId, `I need their Telegram chat id first.\n\n${usage}`);
    }

    const first = takeWord(split.rest);
    const second = takeWord(first.rest);

    if (first.word === '' || second.word === '') {
      return reply(
        ctx.member.telegramId,
        [
          'A rank and a queue are both required, and neither is guessed.',
          '',
          'Defaulting them would give somebody more than you asked for, and nothing in',
          'what you typed would show it.',
          '',
          usage,
        ].join('\n'),
      );
    }

    const role = parseRole(first.word);
    if (role === null) {
      return reply(
        ctx.member.telegramId,
        [`I do not know a rank called “${first.word}”.`, '', `The ranks are: ${roleList()}.`].join('\n'),
      );
    }

    const queue = parseQueue(second.word);
    if (queue === null) {
      return reply(
        ctx.member.telegramId,
        [`I do not know a queue called “${second.word}”.`, '', `The queues are: ${queueList()}.`].join('\n'),
      );
    }

    const parsedRegions = await parseRegions(ctx, second.rest);
    if (!parsedRegions.ok) return reply(ctx.member.telegramId, parsedRegions.text);

    try {
      await addStaff(ctx.db, {
        telegramId: split.chatId,
        role,
        queue,
        regions: parsedRegions.regions,
        actor: ctx.member.telegramId,
      });
    } catch (err: unknown) {
      if (err instanceof StaffAlreadyExistsError) {
        const existing = await findAnyStaff(ctx.db, split.chatId);
        return reply(
          ctx.member.telegramId,
          [
            `${split.chatId} already has a staff row${existing === null ? '' : ` — ${existing.role}, ${existing.active ? 'active' : 'deactivated'}`}.`,
            '',
            'Adding is adding. To change what they may do, or to put a deactivated',
            `person back, use /staff_role ${split.chatId} <rank>.`,
          ].join('\n'),
        );
      }
      throw err;
    }

    const coverage =
      queue === QUEUE.NONE
        ? 'They can see no cases at all — the None queue is deliberate and shows nothing.'
        : `They see ${queue === QUEUE.ALL ? 'every kind of case' : `${queue} cases`} in ${describeRegions(parsedRegions.regions)}.`;

    return replyAndTell(
      ctx.member.telegramId,
      [
        `${split.chatId} is now staff — ${role}, ${queue} queue, ${describeRegions(parsedRegions.regions)}.`,
        '',
        coverage,
        'They have been told. /staff shows everybody.',
      ].join('\n'),
      [
        accessChangedNotice(split.chatId, [
          '👤 You have been given access to the MoPSE support bot as staff.',
          '',
          `Rank: ${role}`,
          `Queue: ${queue}`,
          `Regions: ${describeRegions(parsedRegions.regions)}`,
          '',
          `Added by: ${describeStaff(ctx.member)}`,
          '',
          '/whoami — everything you can do, and the commands for it',
        ]),
      ],
    );
  },
};

/**
 * `/staff_role <chat id> <rank>` — change a rank, and put somebody back.
 *
 * Reactivation lives here rather than in a command of its own, so there is no
 * state a person can be left in that needs a database session to leave.
 *
 * **The last-System guard is on this command as well as on `/staff_remove`,
 * which the plan does not say and which is the same hole.** D13 makes the first
 * System row a hand-written INSERT precisely because there is no way back from
 * having none — and demoting the only System member to Program empties the rank
 * exactly as deactivating them does. A guard on one of the two doors is not a
 * guard.
 *
 * **Kept, and its reasoning changed, on 5 August 2026** when `staff.manage`
 * dropped to `Program`. The recovery is no longer necessarily a database
 * session: a Program member can now put somebody back at System. What the
 * guard still buys is that the four System-only powers — resolving an identity
 * dispute, anonymising a teacher, pausing the bot, setting retention — cannot
 * be left held by nobody in a single tap, with nothing said. If there is also
 * no active Program member, SSH and SQL is still the only way back.
 */
export const staffRole: StaffCommand = {
  name: '/staff_role',
  capability: CAPABILITY.STAFF_MANAGE,
  handle: async (ctx) => {
    const usage = [`/staff_role 991001 Lead`, '', `The ranks are: ${roleList()}.`].join('\n');

    const split = splitChatId(ctx.rest);
    if (split === null) {
      return reply(ctx.member.telegramId, `Whose rank? I need their chat id.\n\n${usage}`);
    }

    const wanted = split.rest.trim();
    if (wanted === '') return reply(ctx.member.telegramId, `Which rank?\n\n${usage}`);

    const role = parseRole(wanted);
    if (role === null) {
      return reply(
        ctx.member.telegramId,
        [`I do not know a rank called “${wanted}”.`, '', `The ranks are: ${roleList()}.`].join('\n'),
      );
    }

    const existing = await findAnyStaff(ctx.db, split.chatId);
    if (existing === null) {
      return reply(
        ctx.member.telegramId,
        [
          `${split.chatId} has no staff row, so there is no rank to change.`,
          '',
          `/staff_add ${split.chatId} ${role} All — adds them.`,
        ].join('\n'),
      );
    }

    if (existing.role === role && existing.active) {
      return reply(ctx.member.telegramId, `${describeStaff(existing)} is already ${role}. Nothing changed.`);
    }

    if (existing.role === 'System' && existing.active && role !== 'System') {
      const systems = await countActiveSystem(ctx.db);
      if (systems <= 1) {
        return reply(
          ctx.member.telegramId,
          [
            `${describeStaff(existing)} is the last active System member, so their rank was not changed.`,
            '',
            'System is the only rank that can settle an identity dispute, remove a teacher’s',
            'details on request, pause the bot or change how long records are kept. Taking it',
            'off the last person holding it leaves nobody who can do any of those.',
            '',
            'Add a second System member first, then change this one.',
          ].join('\n'),
        );
      }
    }

    const written = await setStaffRole(ctx.db, split.chatId, role, ctx.member.telegramId);
    if (!written) return reply(ctx.member.telegramId, `${split.chatId} has gone. Nothing was changed.`);

    const reactivated = !existing.active;
    const confirmation = reactivated
      ? `${describeStaff(existing)} is active again, at ${role}${existing.role === role ? '' : ` (was ${existing.role})`}.`
      : `${describeStaff(existing)} is now ${role}, was ${existing.role}.`;

    return replyAndTell(
      ctx.member.telegramId,
      [confirmation, '', 'They have been told.'].join('\n'),
      [
        accessChangedNotice(split.chatId, [
          reactivated
            ? '👤 Your access to the MoPSE support bot has been restored.'
            : '👤 Your rank on the MoPSE support bot has changed.',
          '',
          `Rank: ${role}`,
          `Changed by: ${describeStaff(ctx.member)}`,
          '',
          '/whoami — everything you can do now',
        ]),
      ],
    );
  },
};

/**
 * `/staff_queue <chat id> <queue>` — which kinds of case somebody works.
 *
 * **New on 1 August 2026, and it closes a gap rather than adding a feature.** A
 * queue could only ever be set once, by `/staff_add`; moving somebody from Visa
 * to Accommodation needed a database session over the SSH tunnel. `/staff_role`
 * and `/staff_region` have always existed for the other two axes.
 *
 * It matters more now than it would have in July. Since Part 5H.1 a queue
 * decides who a new case is **assigned** to, not merely who may see it — so a
 * queue left wrong no longer means somebody reads a list they do not need, it
 * means work is routed to them and sits there with their name on it.
 *
 * The holder is told, for `accessChangedNotice`'s reason: somebody whose queue
 * moved without their knowing will keep working from a `/cases` list that has
 * quietly changed underneath them.
 */
export const staffQueue: StaffCommand = {
  name: '/staff_queue',
  capability: CAPABILITY.STAFF_MANAGE,
  handle: async (ctx) => {
    const usage = [`/staff_queue 991001 Visa`, '', `The queues are: ${queueList()}.`].join('\n');

    const split = splitChatId(ctx.rest);
    if (split === null) {
      return reply(ctx.member.telegramId, `Whose queue? I need their chat id.\n\n${usage}`);
    }

    const wanted = split.rest.trim();
    if (wanted === '') return reply(ctx.member.telegramId, `Which queue?\n\n${usage}`);

    const queue = parseQueue(wanted);
    if (queue === null) {
      return reply(
        ctx.member.telegramId,
        [`I do not know a queue called “${wanted}”.`, '', `The queues are: ${queueList()}.`].join('\n'),
      );
    }

    const existing = await findAnyStaff(ctx.db, split.chatId);
    if (existing === null) {
      return reply(
        ctx.member.telegramId,
        [
          `${split.chatId} has no staff row, so there is no queue to change.`,
          '',
          `/staff_add ${split.chatId} Support ${queue} — adds them.`,
        ].join('\n'),
      );
    }

    if (existing.queue === queue) {
      return reply(
        ctx.member.telegramId,
        `${describeStaff(existing)} already holds the ${queue} queue. Nothing changed.`,
      );
    }

    const written = await setStaffQueue(ctx.db, split.chatId, queue, ctx.member.telegramId);
    if (!written) return reply(ctx.member.telegramId, `${split.chatId} has gone. Nothing was changed.`);

    /**
     * Said plainly rather than left to be discovered. `None` is a real choice —
     * it is how somebody keeps a rank and stops receiving case work — but a
     * queue of `None` and a queue nobody has got round to setting look identical
     * from the outside, so the one that was chosen says so.
     */
    const consequence =
      queue === QUEUE.NONE
        ? 'They will see no cases and be assigned none.'
        : queue === QUEUE.ALL
          ? 'They will see every kind of case in the regions they hold.'
          : `They will see ${queue} cases in the regions they hold, and new ones may be assigned to them.`;

    return replyAndTell(
      ctx.member.telegramId,
      [
        `${describeStaff(existing)} now holds the ${queue} queue, was ${existing.queue}.`,
        consequence,
        '',
        'They have been told.',
      ].join('\n'),
      [
        accessChangedNotice(split.chatId, [
          '👤 The kind of case you handle on the MoPSE support bot has changed.',
          '',
          `Queue: ${queue}`,
          `Changed by: ${describeStaff(ctx.member)}`,
          '',
          '/cases — what you can see now',
        ]),
      ],
    );
  },
};

/**
 * `/staff_remove <chat id>` — deactivate. The row always stays.
 *
 * Never a delete: `case_notes.author_chat_id` and `audit_log.actor` name these
 * people, and a note whose author cannot be named is worse than no note.
 *
 * Three refusals and one report, and the report is the interesting one. R3's
 * second order: `ON DELETE SET NULL` never fires because staff are deactivated
 * rather than deleted, so a departing member's open cases stay assigned to them
 * and appear in nobody's `/mycases`. **The cases are left exactly where they
 * are** — silently unassigning them would destroy the only record of who was
 * working them — and the count is reported so somebody reassigns them on purpose.
 */
export const staffRemove: StaffCommand = {
  name: '/staff_remove',
  capability: CAPABILITY.STAFF_MANAGE,
  handle: async (ctx) => {
    const split = splitChatId(ctx.rest);
    if (split === null) {
      return reply(ctx.member.telegramId, 'Who should I remove? /staff_remove 991001 — the id is on /staff.');
    }

    /**
     * Self-deactivation is refused (`AdminCommands.gs:1209`). It is not caught by
     * the last-System rule: a System member with a colleague can deactivate
     * themselves perfectly legally and be locked out of undoing it, because
     * `findStaff` returns active rows only and every staff command runs through
     * it. The recovery is asking the colleague, which is fine — but doing it by
     * accident, mid-sentence, is not.
     */
    if (split.chatId === ctx.member.telegramId) {
      return reply(
        ctx.member.telegramId,
        [
          'You cannot remove yourself.',
          '',
          'Every staff command checks for an active row, so the moment it went through',
          'you would have no way to undo it. Ask somebody else who manages staff.',
        ].join('\n'),
      );
    }

    const existing = await findAnyStaff(ctx.db, split.chatId);
    if (existing === null) {
      return reply(ctx.member.telegramId, `${split.chatId} has no staff row, so there is nothing to remove.`);
    }

    if (!existing.active) {
      return reply(
        ctx.member.telegramId,
        [
          `${describeStaff(existing)} is already deactivated. Nothing changed.`,
          '',
          `/staff_role ${split.chatId} ${existing.role} — puts them back.`,
        ].join('\n'),
      );
    }

    /**
     * D13's rule, and **it became reachable on 5 August 2026** when
     * `staff.manage` dropped from `System` to `Program`.
     *
     * It was written as unreachable and kept anyway: while the caller was always
     * a System member, deactivating the last one meant deactivating yourself,
     * which the self-check above already refused. That reasoning named the exact
     * thing that has now happened — *"if the floor for this capability ever
     * moves"* — because a Program member deactivating the only System member is
     * not deactivating themselves, and nothing above this branch stops them.
     * The comment was the whole value of keeping it.
     */
    if (existing.role === 'System') {
      const systems = await countActiveSystem(ctx.db);
      if (systems <= 1) {
        return reply(
          ctx.member.telegramId,
          [
            `${describeStaff(existing)} is the last active System member, so nothing was changed.`,
            '',
            'With nobody at System nothing can settle an identity dispute, remove a teacher’s',
            'details on request, pause the bot or change how long records are kept.',
            '',
            'Add a second System member first.',
          ].join('\n'),
        );
      }
    }

    /**
     * Read under the caller's own scope, as every case read in this system is.
     *
     * **It was exact until 5 August 2026 and is no longer.** `staff.manage`
     * floored at System, and a System member bypasses both the queue and the
     * region axis, so this count was the true one. A Program member does not
     * bypass either — a Program member holding one queue, or a few regions,
     * sees only the departing person's cases inside it. The count is therefore
     * a floor, and the wording below says so rather than presenting it as a
     * total: an undercount read as a total is how somebody is deactivated with
     * work still on them and nobody the wiser. `openCaseNote` has said "that you
     * can see" for the same reason since stage 4.
     */
    const owned = await casesOwnedBy(ctx.db, scopeOf(ctx.member), split.chatId);

    const written = await deactivateStaff(ctx.db, split.chatId, ctx.member.telegramId);
    if (!written) return reply(ctx.member.telegramId, `${split.chatId} has gone. Nothing was changed.`);

    const caseNote =
      owned.total === 0
        ? ['They own no open cases that you can see.']
        : [
            `They still own ${String(owned.total)} open case${owned.total === 1 ? '' : 's'} that you can see, and those have been left exactly where they are:`,
            '',
            ...owned.cases.map((c) => `  ${c.reference} — ${c.status} · ${c.category}`),
            ...(owned.cases.length < owned.total
              ? [`  … and ${String(owned.total - owned.cases.length)} more`]
              : []),
            '',
            'Unassigning them would destroy the only record of who was working them, and',
            'they now appear in nobody’s /mycases. /assign each one to somebody.',
          ];

    return replyAndTell(
      ctx.member.telegramId,
      [
        `${describeStaff(existing)} is deactivated. The row stays, so their notes and audit rows still name them.`,
        '',
        ...caseNote,
        '',
        `/staff_role ${split.chatId} ${existing.role} — puts them back.`,
      ].join('\n'),
      [
        accessChangedNotice(split.chatId, [
          '👤 Your staff access to the MoPSE support bot has ended.',
          '',
          `Ended by: ${describeStaff(ctx.member)}`,
          '',
          'Staff commands will no longer work from this chat.',
        ]),
      ],
    );
  },
};

// ---------------------------------------------------------------------------
// A teacher's access — Task 36, over D17's command half and D27
// ---------------------------------------------------------------------------

/**
 * How many of this teacher's open cases the caller can see, and their references.
 *
 * R5, and it is reported by both `/revoke` and `/restore` because both are the
 * moment somebody should know. Revoking strands a staff member replying to a
 * teacher who cannot read it; restoring is when those cases become answerable
 * again.
 *
 * Scoped, like every case read in this system. A Program member holding one
 * queue is told what they can see rather than a total — stated in those words in
 * the message, because an undercount presented as a total is exactly the sort of
 * quiet wrongness this rebuild exists to remove.
 */
async function openCaseNote(
  ctx: StaffContext,
  chatId: string,
): Promise<{ readonly any: boolean; readonly lines: readonly string[] }> {
  const open = await listCases(ctx.db, scopeOf(ctx.member), { teacherChatId: chatId });
  if (open.total === 0) {
    return { any: false, lines: ['They have no open cases that you can see.'] };
  }

  return {
    any: true,
    lines: [
      `They have ${String(open.total)} open case${open.total === 1 ? '' : 's'} that you can see:`,
      ...open.cases.map((c) => `  ${c.reference} — ${c.status} · ${c.category}`),
      ...(open.cases.length < open.total
        ? [`  … and ${String(open.total - open.cases.length)} more`]
        : []),
    ],
  };
}

/** Why a teacher is locked out, told apart, because only one of them `/restore` can fix. */
const rosterIsTheProblem = (teacher: TeacherRecord): boolean => teacher.rosterActive !== true;

const ROSTER_FIX = [
  'Their roster row is inactive or gone, and that is a second, separate reason they',
  'cannot use the bot — the gate re-checks the recruitment spreadsheet on every',
  'action. Nothing here can fix it; recruitment has to put the row back.',
];

/**
 * `/revoke <chat id>` — end a teacher's access, with a name against it (D17).
 *
 * The columns have existed since stage 2 and nothing ever wrote them. The roster
 * route works too now, but a spreadsheet edit cannot answer "who decided this and
 * when", which is an audit question and the reason this command exists beside it.
 *
 * **Only a `Verified` teacher can be revoked**, and that is a real guard rather
 * than tidiness. Revoking a chat that never signed in would write `Revoked` onto
 * it, and `/restore` would then be able to write `Verified` onto a chat with no
 * roster identity at all — a command pair that between them grants access rather
 * than returning it. `restoreTeacher` refuses that in SQL as well; this is the
 * same rule stated where a person can read it.
 *
 * The teacher is not messaged. The reasons somebody's access ends are
 * administrative and often not the bot's to announce, and the router already
 * tells them plainly, with the support contact, the moment they next try. The
 * confirmation says so, so nobody assumes it was done for them.
 */
export const revoke: StaffCommand = {
  name: '/revoke',
  capability: CAPABILITY.TEACHER_REVOKE,
  handle: async (ctx) => {
    const usage = '/revoke 995101 — the chat id is on /case, next to the teacher’s name.';

    const split = splitChatId(ctx.rest);
    if (split === null) return reply(ctx.member.telegramId, `I need a teacher’s chat id.\n\n${usage}`);

    const teacher = await findTeacher(ctx.db, split.chatId);
    if (teacher === null) {
      return reply(ctx.member.telegramId, `I have no teacher with chat id ${split.chatId}.\n\n${usage}`);
    }

    if (teacher.verificationState === 'Revoked') {
      return reply(
        ctx.member.telegramId,
        [
          `${split.chatId} is already revoked. Nothing was changed and nothing was recorded.`,
          '',
          `/restore ${split.chatId} — gives them their access back.`,
        ].join('\n'),
      );
    }

    if (teacher.verificationState !== 'Verified') {
      return reply(
        ctx.member.telegramId,
        [
          `${split.chatId} has never signed in, so there is no access to end.`,
          '',
          'They can browse the answer bank, which needs no sign-in and is open to',
          'anybody. Nothing else is available to them.',
        ].join('\n'),
      );
    }

    const openCases = await openCaseNote(ctx, split.chatId);

    const written = await revokeTeacher(ctx.db, split.chatId, ctx.member.telegramId);
    if (!written) return reply(ctx.member.telegramId, `${split.chatId} has gone. Nothing was changed.`);

    return reply(
      ctx.member.telegramId,
      [
        `${split.chatId} can no longer open cases or read their own. Recorded against your name.`,
        '',
        ...openCases.lines,
        ...(openCases.any
          ? [
              '',
              'A /reply still reaches their chat, but they cannot open the bot to read the',
              'case or answer. Finish or close them.',
            ]
          : []),
        '',
        'They have not been messaged. The bot tells them their access has ended, with',
        `the support contact, the next time they use it. /restore ${split.chatId} undoes this.`,
      ].join('\n'),
    );
  },
};

/**
 * `/restore <chat id>` — D27, at the same rank as `/revoke` on purpose.
 *
 * Whoever can make the mistake can undo it without escalating to somebody more
 * senior, because a recovery that needs a second person is a recovery that waits
 * until Monday.
 *
 * **The failure this command must not have (R16).** A teacher loses the bot two
 * ways and only one of them is `Revoked`: a teacher whose *roster row* was
 * deactivated or removed is still `Verified` and still fails the gate, because
 * D17 re-checks the roster live. Reporting "restored" while they stay locked out
 * is worse than having no command — the staff member stops looking and the
 * teacher concludes the bot is broken. So the roster is read and the answer names
 * which of the two situations it found, in those words.
 *
 * **And a teacher who was never revoked changes nothing and records nothing.**
 * `restoreTeacher` writes its audit row only when its statement matched, so an
 * invented `TEACHER_RESTORED` is impossible rather than merely avoided here.
 */
export const restore: StaffCommand = {
  name: '/restore',
  capability: CAPABILITY.TEACHER_REVOKE,
  handle: async (ctx) => {
    const usage = '/restore 995101 — the chat id is on /case, next to the teacher’s name.';

    const split = splitChatId(ctx.rest);
    if (split === null) return reply(ctx.member.telegramId, `I need a teacher’s chat id.\n\n${usage}`);

    const teacher = await findTeacher(ctx.db, split.chatId);
    if (teacher === null) {
      return reply(ctx.member.telegramId, `I have no teacher with chat id ${split.chatId}.\n\n${usage}`);
    }

    if (teacher.verificationState !== 'Revoked') {
      return reply(
        ctx.member.telegramId,
        [
          `${split.chatId} is not revoked, so nothing was changed and nothing was recorded.`,
          '',
          ...(rosterIsTheProblem(teacher)
            ? [
                'They still cannot use the bot, and this is why:',
                '',
                ...ROSTER_FIX,
              ]
            : ['They can use the bot normally.']),
        ].join('\n'),
      );
    }

    const written = await restoreTeacher(ctx.db, split.chatId, ctx.member.telegramId);
    if (!written) return reply(ctx.member.telegramId, `${split.chatId} has gone. Nothing was changed.`);

    /**
     * Read back rather than assumed. The row was `Revoked` a moment ago and the
     * roster half was never touched by either command, so the only way to say
     * truthfully whether this teacher can now use the bot is to ask the same
     * function the gate asks.
     */
    const after = await findTeacher(ctx.db, split.chatId);
    const usable = teacherHasAccess(after);
    const openCases = await openCaseNote(ctx, split.chatId);

    return reply(
      ctx.member.telegramId,
      [
        usable
          ? `${split.chatId} is restored, and they can use the bot again.`
          : `${split.chatId} is restored, but they still cannot use the bot.`,
        '',
        ...(usable ? [] : [...ROSTER_FIX, '']),
        ...openCases.lines,
        '',
        'They have not been messaged — nothing announces this to them. If they were',
        'told their access had ended, somebody should tell them it is back.',
      ].join('\n'),
    );
  },
};

/**
 * What `/forget` does and does not remove, in the words whoever runs it will
 * need on the telephone.
 *
 * Written into the confirmation rather than only into the runbook, because the
 * person typing this is the person who then tells a teacher their data has been
 * removed — and they must be able to say what that means. Nobody should hear
 * "removed" and understand something stronger than this (D44).
 */
const FORGET_RESIDUAL = [
  'What is gone: their name, their recruitment identifier, their region, and every',
  'message they have ever sent the bot.',
  '',
  'What stays, and why:',
  '• Their Telegram chat id. Every one of their cases points at it, and that link',
  '  is what guarantees no case exists without a real person behind it.',
  '• What they wrote in their cases. That history is kept on purpose — but the',
  '  retention job removes each case on its own schedule once it is resolved, so',
  '  this shrinks to nothing without anybody doing anything.',
];

/**
 * `/forget <chat id> FORGET` — anonymise a teacher who has asked to be removed.
 *
 * **System only** (D44), and the gap between this and `/revoke` at Program is
 * the point: revoking is reversible and `/restore` exists so the mistake is
 * cheap, while this has no undo whatsoever. The cost is real and was accepted —
 * a Support member who takes the request cannot action it themselves.
 *
 * The second word is typed rather than tapped, and it is the same shape a
 * database `DELETE` without a `WHERE` should have. Without it the command
 * explains what will and will not be removed and changes nothing, which is also
 * the only way to read that explanation before committing to it.
 *
 * The work is in `forgetTeacher` and not here, because the resignation route
 * (design decision 9) anonymises automatically three months after a teacher
 * resigns and calls the same function.
 */
export const forget: StaffCommand = {
  name: '/forget',
  capability: CAPABILITY.TEACHER_FORGET,
  handle: async (ctx) => {
    const usage = '/forget 995101 FORGET — the chat id is on /case, next to the teacher’s name.';

    const split = splitChatId(ctx.rest);
    if (split === null) return reply(ctx.member.telegramId, `I need a teacher’s chat id.\n\n${usage}`);

    const teacher = await findTeacher(ctx.db, split.chatId);
    if (teacher === null) {
      return reply(ctx.member.telegramId, `I have no teacher with chat id ${split.chatId}.\n\n${usage}`);
    }

    if (split.rest.trim() !== 'FORGET') {
      const openCases = await openCaseNote(ctx, split.chatId);
      return reply(
        ctx.member.telegramId,
        [
          `⚠️ This permanently removes ${split.chatId} from the system. Nothing has changed.`,
          '',
          ...FORGET_RESIDUAL,
          '',
          ...openCases.lines,
          ...(openCases.any
            ? [
                '',
                'Their open cases stay open and stay visible, with no name on them. Somebody',
                'should finish or close them.',
              ]
            : []),
          '',
          'There is no undo. To go ahead, type it again with the word FORGET on the end:',
          `/forget ${split.chatId} FORGET`,
        ].join('\n'),
      );
    }

    const outcome = await forgetTeacher(ctx.db, split.chatId, ctx.member.telegramId);

    if (outcome.kind === 'notFound') {
      return reply(ctx.member.telegramId, `${split.chatId} has gone. Nothing was changed.`);
    }

    /**
     * Told apart from "no such teacher" deliberately (departure 3 of this
     * stage). Reporting the latter for somebody removed last month sends an
     * operator looking for a row that is behaving exactly as it should.
     */
    if (outcome.kind === 'alreadyForgotten') {
      return reply(
        ctx.member.telegramId,
        [
          `${split.chatId} was already removed. Nothing was changed and nothing was recorded.`,
          '',
          'The row is still here and is meant to be — their cases point at it. There is',
          'no name, no identifier and no region on it.',
        ].join('\n'),
      );
    }

    return reply(
      ctx.member.telegramId,
      [
        `✅ ${split.chatId} has been removed. Recorded against your name.`,
        '',
        ...FORGET_RESIDUAL,
        '',
        `${outcome.messagesDeleted} log ${outcome.messagesDeleted === 1 ? 'entry' : 'entries'} deleted.`,
        ...(outcome.openCases > 0
          ? [
              `They still have ${outcome.openCases} open case${outcome.openCases === 1 ? '' : 's'}, now with no name on`,
              'them. Somebody should finish or close them.',
            ]
          : []),
        '',
        'They have not been messaged, and they can no longer use the bot.',
      ].join('\n'),
    );
  },
};

/**
 * `/username @handle` and `/username clear` — D47, Q2.
 *
 * **Your own row, and nobody else's.** Not a permission question: a handle
 * published under somebody's name, to 1,800 teachers, is theirs to publish. So
 * there is no chat-id argument at all, which also means there is no way to
 * mistype one.
 *
 * Available to any active staff member. The check that matters is not rank —
 * it is `api.getChat`, which decides whether the handle is really theirs.
 *
 * The three failures are reported separately because they need different things
 * done about them: a typo needs retyping, an unknown handle means Telegram has
 * never seen it, and a handle belonging to somebody else is the one that would
 * have pointed teachers at a stranger. A staff member who mistypes their own
 * handle must find out from this command and not from a teacher.
 */
export const username: StaffCommand = {
  name: '/username',
  capability: null,
  handle: async (ctx) => {
    const usage = [
      '/username @yourhandle — publish it to teachers in your region',
      '/username clear       — stop publishing it',
    ].join('\n');

    const wanted = ctx.rest.trim();
    const current = ctx.member.telegramUsername;
    const showing =
      current === null
        ? 'Nothing is published for you at the moment.'
        : `Teachers in your region are shown @${current}.`;

    if (wanted === '') {
      return reply(
        ctx.member.telegramId,
        [
          showing,
          '',
          'This is shown to teachers who ask who covers their region, beside your',
          'name. It is checked against Telegram when you set it and again every day.',
          '',
          usage,
        ].join('\n'),
      );
    }

    if (wanted.toLowerCase() === 'clear') {
      const cleared = await clearUsername(ctx.db, ctx.member.telegramId);
      return reply(
        ctx.member.telegramId,
        cleared === null
          ? 'Nothing was published for you, so nothing changed.'
          : [
              `Stopped publishing @${cleared}.`,
              '',
              'Teachers asking who covers their region are now shown your name and the',
              'support contact instead.',
            ].join('\n'),
      );
    }

    /**
     * No lookup, no write. An unverified handle is the failure D47 exists to
     * prevent, and writing one "for now" is how it would arrive silently.
     */
    if (ctx.deps.telegram === undefined) {
      return reply(
        ctx.member.telegramId,
        [
          'I cannot check that handle with Telegram at the moment, so nothing was',
          'written.',
          '',
          'A handle is never published unchecked: a Telegram username can be released',
          'and claimed by somebody else, and publishing the wrong one would point',
          'teachers at a stranger. Please try again shortly.',
        ].join('\n'),
      );
    }

    const outcome = await setUsername(ctx.db, ctx.deps.telegram, ctx.member.telegramId, wanted);

    if (outcome.ok) {
      return reply(
        ctx.member.telegramId,
        [
          `✅ Publishing @${outcome.handle}. Telegram confirms it is yours.`,
          '',
          'Teachers in the regions you cover now see your name and this handle when',
          'they ask who covers their region, and can tap through to message you.',
          '',
          'It is re-checked every day. If you change your Telegram username, this is',
          'cleared automatically and you and the operations chat are both told.',
          '',
          '/username clear — stop publishing it.',
        ].join('\n'),
      );
    }

    const why: Readonly<Record<'malformed' | 'unknown' | 'belongsToSomebodyElse', readonly string[]>> = {
      malformed: [
        `“${wanted}” is not a Telegram username, so nothing was written.`,
        '',
        'A username is 5 to 32 letters, digits or underscores, starting with a letter.',
        'It is the one in Telegram’s own Settings, not your display name.',
      ],
      unknown: [
        `Telegram does not know @${normaliseHandle(wanted) ?? wanted}, so nothing was written.`,
        '',
        'Check the spelling against Telegram’s Settings screen. A username has to be',
        'set there before it can be published here.',
      ],
      belongsToSomebodyElse: [
        `⚠️ @${normaliseHandle(wanted) ?? wanted} belongs to somebody else, so nothing was written.`,
        '',
        'This is exactly the check that matters. Publishing it would have shown',
        'teachers a stranger’s handle beside your name, with the Ministry’s bot',
        'vouching for it.',
        '',
        'Check the spelling in Telegram’s Settings.',
      ],
    };

    return reply(ctx.member.telegramId, [...why[outcome.reason], '', showing].join('\n'));
  },
};

/**
 * `/staff_region` — change which regions a staff member covers.
 *
 * **Built on 31 July 2026 to close a gap the runbook had already promised was
 * closed.** §2.6 told the operator to set regions with this command "afterwards",
 * and it did not exist: `regions` was written by `/staff_add` and by nothing
 * else, so coverage could be set once, at creation, and never changed except by
 * hand in SQL.
 *
 * That mattered because §2.6 also records that regions are entered **after
 * launch, on purpose** — and because the failure looks like working software. An
 * empty `regions` array means *every* region, deliberately, so nobody gets an
 * error; every staff member simply sees the whole country.
 *
 * `clear` is spelled out rather than implied by an empty argument. "Everybody
 * sees everything" is a real and sometimes correct configuration, but it is not
 * one to reach by pressing enter with nothing typed.
 */
export const staffRegion: StaffCommand = {
  name: '/staff_region',
  capability: CAPABILITY.STAFF_MANAGE,
  handle: async (ctx) => {
    const usage = [
      '/staff_region 991001 Tashkent, Samarkand',
      '/staff_region 991001 clear   — every region, which is what an empty list means',
    ].join('\n');

    const split = splitChatId(ctx.rest);
    if (split === null) {
      return reply(ctx.member.telegramId, `Whose regions? I need their chat id.\n\n${usage}`);
    }

    const wanted = split.rest.trim();
    if (wanted === '') {
      return reply(ctx.member.telegramId, `Which regions?\n\n${usage}`);
    }

    const existing = await findAnyStaff(ctx.db, split.chatId);
    if (existing === null) {
      return reply(
        ctx.member.telegramId,
        [
          `${split.chatId} has no staff row, so there are no regions to change.`,
          '',
          `/staff_add ${split.chatId} Support All — adds them.`,
        ].join('\n'),
      );
    }

    const parsed =
      wanted.toLowerCase() === 'clear'
        ? ({ ok: true, regions: [] } as const)
        : await parseRegions(ctx, wanted);
    if (!parsed.ok) return reply(ctx.member.telegramId, parsed.text);

    const written = await setStaffRegions(ctx.db, split.chatId, parsed.regions, ctx.member.telegramId);
    if (!written) {
      return reply(ctx.member.telegramId, `${split.chatId} has no staff row, so nothing was changed.`);
    }

    const now = { ...existing, regions: parsed.regions };
    return reply(
      ctx.member.telegramId,
      parsed.regions.length === 0
        ? [
            `${describeStaff(now)} now covers every region.`,
            '',
            'That is what an empty list means here, and it is not a fault — but it does',
            'mean they see every teacher’s cases, so set it deliberately.',
          ].join('\n')
        : `${describeStaff(now)} now covers ${describeRegions(parsed.regions)}.`,
    );
  },
};

/** Every command in this file, so registering one is a single edit. */
// ---------------------------------------------------------------------------
// Staff management by button — Part 5H.3
// ---------------------------------------------------------------------------

/**
 * The whole of `/staff` as buttons, asked for directly on 1 August 2026:
 * *"i do /staff, i see a list of staff listed as buttons, i choose the staff,
 * then bot prompts me, what to do with them … i need it button based PLEASE."*
 *
 * **Nothing below decides anything.** Every acting tap is turned back into the
 * typed command it is equivalent to and handed to `routeStaffCommand` — so
 * `/staff_role` remains the single place that knows a rank may not be taken off
 * the last active System member, `/staff_queue` the single place that knows what
 * a queue means, and `/staff_remove` the single place that counts somebody's
 * open cases before deactivating them. **A second copy of any of those rules is
 * the thing this part must not create**, and copying the case-list button's
 * approach is how it avoids one.
 *
 * The subject travels in the payload, never in conversation state — see
 * `CALLBACK.STAFF_MENU` for why.
 */
const staffButton = (member: StaffRecord): InlineButton => ({
  text: `${member.active ? '' : '🚫 '}${member.name ?? member.telegramId} — ${member.role} · ${member.queue}`,
  callback_data: encodeCallback(CALLBACK.STAFF_MENU, member.telegramId),
});

/** One button per person, capped for the same reason the case lists are. */
function staffListKeyboard(members: readonly StaffRecord[]): InlineKeyboard {
  return members.slice(0, STAFF_BUTTON_CAP).map((m) => [staffButton(m)]);
}

const backToStaffButton: InlineButton = {
  text: '⬅️ All staff',
  callback_data: encodeCallback(CALLBACK.STAFF_MENU),
};

/**
 * The one thing `/staff` could not do by button until now.
 *
 * It sits under the list rather than beside each person, because it is about
 * nobody — every other button in this menu names a subject and this one cannot.
 */
const addSomebodyButton: InlineButton = {
  text: '➕ Add somebody',
  callback_data: encodeCallback(CALLBACK.STAFF_ADD),
};

/**
 * What can be done to one person.
 *
 * Deactivate and reactivate are the same slot showing opposite words, because
 * they are one question — is this person staff — and two buttons would let
 * somebody tap "deactivate" on a row that already is.
 */
function staffActionsKeyboard(member: StaffRecord): InlineKeyboard {
  const forThem = (action: string): string =>
    encodeCallback(CALLBACK.STAFF_MENU, member.telegramId, action);

  return [
    [{ text: '🎖 Change rank', callback_data: forThem(ACTION.ROLE) }],
    [{ text: '📁 Change queue', callback_data: forThem(ACTION.QUEUE) }],
    [{ text: '📍 Change regions', callback_data: forThem(ACTION.REGION) }],
    [
      member.active
        ? { text: '🚫 Remove from staff', callback_data: forThem(ACTION.OFF) }
        : { text: '♻️ Put back as ' + member.role, callback_data: forThem(ACTION.ON) },
    ],
    [backToStaffButton],
  ];
}

/** The actions a payload may name. Matched exactly; anything else is ignored. */
const ACTION = {
  ROLE: 'ROLE',
  QUEUE: 'Q',
  REGION: 'R',
  OFF: 'OFF',
  ON: 'ON',
} as const;

function choiceKeyboard(
  telegramId: string,
  action: string,
  choices: readonly { readonly value: string; readonly label: string }[],
): InlineKeyboard {
  const rows: InlineKeyboardRow[] = [];
  for (const choice of choices) {
    /**
     * A choice that will not fit is skipped rather than thrown, and only the
     * region list can reach this: ranks and queues are constants in this
     * repository, while a region is a spreadsheet cell somebody typed. One
     * over-long region must hide one button, not take the whole menu away —
     * the rule `answerButtons` already applies to FAQ codes.
     */
    if (callbackPartProblem(CALLBACK.STAFF_MENU, choice.value) !== null) continue;
    rows.push([
      {
        text: choice.label,
        callback_data: encodeCallback(CALLBACK.STAFF_MENU, telegramId, action, choice.value),
      },
    ]);
  }
  rows.push([
    {
      text: '⬅️ Back',
      callback_data: encodeCallback(CALLBACK.STAFF_MENU, telegramId),
    },
  ]);
  return rows;
}

const describeMember = (m: StaffRecord): string =>
  [
    `${m.name ?? 'name not recorded'} — ${m.telegramId}`,
    `${m.role} · ${m.queue} queue · ${describeRegions(m.regions)}`,
    m.active ? '' : '🚫 Not currently staff.',
  ]
    .filter((line) => line !== '')
    .join('\n');

/**
 * What one tap on a staff menu should produce — either something to show, or a
 * command to run.
 *
 * **The split exists to avoid an import cycle, and the cycle was telling the
 * truth.** This module cannot call `routeStaffCommand`, because the dispatcher
 * that holds it already imports the commands in here. So this decides *what*
 * should happen and the dispatcher does it — which also means the acting taps
 * are executed by exactly the same function that executes a typed command,
 * rather than by something that resembles it.
 */
export type StaffMenuStep =
  | { readonly kind: 'show'; readonly outcome: RouterOutcome }
  | { readonly kind: 'run'; readonly command: string };

const show = (outcome: RouterOutcome): StaffMenuStep => ({ kind: 'show', outcome });
const run = (command: string): StaffMenuStep => ({ kind: 'run', command });

/**
 * One tap on a staff menu, resolved.
 *
 * **The subject is re-read from the database on every tap**, never trusted from
 * the payload beyond being an id to look up. A menu sits in a chat for ever, and
 * the person it is about may have been removed since it was drawn.
 *
 * Authorisation is not done here — the dispatcher does it before calling, and
 * again inside `routeStaffCommand` for anything that acts.
 */
export async function staffMenuView(
  db: Database,
  chatId: string,
  parts: readonly string[],
): Promise<StaffMenuStep> {
  const [subject = '', action = '', value = ''] = parts;

  // No subject: the list itself, which is also where every Back button leads.
  if (subject === '') return show(await staffMenuList(db, chatId));

  const target = await findAnyStaff(db, subject);
  if (target === null) {
    return show(
      reply(
        chatId,
        [`${subject} has no staff row any more.`, '', 'The list below is current.'].join('\n'),
        staffListKeyboard(await listStaff(db, { includeInactive: true })),
      ),
    );
  }

  if (action === '') {
    return show(
      reply(
        chatId,
        [describeMember(target), '', 'What would you like to do?'].join('\n'),
        staffActionsKeyboard(target),
      ),
    );
  }

  /**
   * A chosen value acts, and it acts by being retyped as the command it is.
   *
   * `/staff_remove` and the reactivation both take no value, so their menu tap
   * *is* the action — there is nothing left to choose. Everything else shows its
   * choices first.
   */
  if (action === ACTION.OFF) return run(`/staff_remove ${subject}`);
  if (action === ACTION.ON) return run(`/staff_role ${subject} ${target.role}`);

  if (value === '') return show(await choicesFor(db, chatId, target, action));

  if (action === ACTION.ROLE) return run(`/staff_role ${subject} ${value}`);
  if (action === ACTION.QUEUE) return run(`/staff_queue ${subject} ${value}`);
  if (action === ACTION.REGION) {
    return run(`/staff_region ${subject} ${toggledRegions(target, value)}`);
  }

  // An action this build does not have: a hand-crafted payload, or a menu from
  // an older build. The list is the safe landing, as it is everywhere else here.
  return show(await staffMenuList(db, chatId));
}

export async function staffMenuList(db: Database, chatId: string): Promise<RouterOutcome> {
  const everybody = await listStaff(db, { includeInactive: true });
  if (everybody.length === 0) {
    return reply(chatId, 'Nobody has a staff row. That should be impossible.');
  }

  const shown = Math.min(everybody.length, STAFF_BUTTON_CAP);
  return reply(
    chatId,
    [
      shown < everybody.length
        ? `Staff — the first ${String(shown)} of ${String(everybody.length)}`
        : `Staff (${String(everybody.length)})`,
      '',
      'Tap somebody to change their rank, queue or regions, or add somebody new.',
      ...(shown < everybody.length ? ['', '/staff lists everybody as text.'] : []),
    ].join('\n'),
    [...staffListKeyboard(everybody), [addSomebodyButton]],
  );
}

async function choicesFor(
  db: Database,
  chatId: string,
  target: StaffRecord,
  action: string,
): Promise<RouterOutcome> {
  if (action === ACTION.ROLE) {
    return reply(
      chatId,
      `Which rank for ${describeStaff(target)}?\n\nThey are ${target.role} now.`,
      choiceKeyboard(
        target.telegramId,
        ACTION.ROLE,
        STAFF_ROLE_ORDER.map((role) => ({
          value: role,
          label: role === target.role ? `✅ ${role}` : role,
        })),
      ),
    );
  }

  if (action === ACTION.QUEUE) {
    return reply(
      chatId,
      `Which queue for ${describeStaff(target)}?\n\nThey hold ${target.queue} now.`,
      choiceKeyboard(
        target.telegramId,
        ACTION.QUEUE,
        ALL_QUEUES.map((queue) => ({
          value: queue,
          label: queue === target.queue ? `✅ ${queue}` : queue,
        })),
      ),
    );
  }

  /**
   * Regions are a *list*, so these buttons toggle rather than choose — a tap
   * adds a region if they do not hold it and removes it if they do, and the tick
   * shows which is which. Everything else in this part is a single choice out of
   * a fixed set; this is the one place the answer is built up over several taps,
   * and each tap is still a complete instruction on its own.
   */
  const known = await knownRegions(db);
  if (known.length === 0) {
    return reply(
      chatId,
      [
        'I know of no regions at all yet — the roster has none recorded.',
        '',
        'Everybody covers every region until it has synced, which is the safe default.',
      ].join('\n'),
      staffActionsKeyboard(target),
    );
  }

  return reply(
    chatId,
    [
      `Which regions for ${describeStaff(target)}?`,
      '',
      `They cover ${describeRegions(target.regions)}.`,
      'Tap to add or remove. Removing the last one means every region.',
    ].join('\n'),
    choiceKeyboard(
      target.telegramId,
      ACTION.REGION,
      known.map((region) => ({
        value: region,
        label: holdsRegion(target, region) ? `✅ ${region}` : region,
      })),
    ),
  );
}

const holdsRegion = (member: StaffRecord, region: string): boolean =>
  member.regions.some((r) => r.toLowerCase() === region.toLowerCase());

/**
 * The region list this tap produces, as `/staff_region` would be typed.
 *
 * `clear` rather than an empty string, because that is the word the command
 * takes for "every region" — and an empty argument is refused by it as a missing
 * one, which is the right answer for somebody typing and the wrong one here.
 */
function toggledRegions(member: StaffRecord, region: string): string {
  const next = holdsRegion(member, region)
    ? member.regions.filter((r) => r.toLowerCase() !== region.toLowerCase())
    : [...member.regions, region];
  return next.length === 0 ? 'clear' : next.join(', ');
}

/**
 * What one tap on the add-somebody flow should produce.
 *
 * The same show-or-run split as `StaffMenuStep`, plus the one step that has to
 * ask for a typed value — and `ask` is a third kind rather than a `show` that
 * happens to save a state, because a state written from inside a function that
 * claims only to render is the kind of side effect nobody finds later.
 */
export type StaffAddStep =
  | { readonly kind: 'show'; readonly outcome: RouterOutcome }
  | { readonly kind: 'ask'; readonly outcome: RouterOutcome }
  | { readonly kind: 'run'; readonly command: string };

/**
 * One tap on the add-somebody flow, resolved.
 *
 * **Nothing here creates a staff row.** The last tap runs `/staff_add`, which is
 * the single place that knows what a queue means, refuses a rank it does not
 * recognise, answers a chat id that already has a row, and tells the new member
 * they have access. A second copy of any of that is what this shape exists to
 * avoid.
 */
export function staffAddView(chatId: string, parts: readonly string[]): StaffAddStep {
  const [subject = '', role = '', queue = ''] = parts;

  if (subject === '') {
    return {
      kind: 'ask',
      outcome: reply(
        chatId,
        [
          'Send me their Telegram chat id.',
          '',
          'It is the number rather than an @handle. If they have ever written to this',
          'bot it is on their case; otherwise any “what is my id” bot will tell them.',
        ].join('\n'),
        [[{ text: '✖️ Cancel', callback_data: encodeCallback(CALLBACK.STAFF_MENU) }]],
      ),
    };
  }

  if (role === '') {
    return {
      kind: 'show',
      outcome: reply(
        chatId,
        `Adding ${subject}. Which rank?`,
        addChoiceKeyboard(STAFF_ROLE_ORDER.map((r) => ({ label: r, parts: [subject, r] }))),
      ),
    };
  }

  if (queue === '') {
    return {
      kind: 'show',
      outcome: reply(
        chatId,
        [
          `Adding ${subject} as ${role}. Which queue?`,
          '',
          'The queue decides which teachers’ problems they can read, so it is asked',
          'rather than guessed — defaulting it would give somebody more than you asked',
          'for, and nothing on this screen would show it.',
        ].join('\n'),
        addChoiceKeyboard(ALL_QUEUES.map((q) => ({ label: q, parts: [subject, role, q] }))),
      ),
    };
  }

  return { kind: 'run', command: `/staff_add ${subject} ${role} ${queue}` };
}

function addChoiceKeyboard(
  choices: readonly { readonly label: string; readonly parts: readonly string[] }[],
): InlineKeyboard {
  const rows: InlineKeyboardRow[] = choices.map((c) => [
    { text: c.label, callback_data: encodeCallback(CALLBACK.STAFF_ADD, ...c.parts) },
  ]);
  rows.push([backToStaffButton]);
  return rows;
}

// ---------------------------------------------------------------------------
// Identity disputes — Feature A
// ---------------------------------------------------------------------------

/**
 * `/disputes` — every argument about who an account belongs to, still open.
 *
 * **A button is not a route to a dispute nobody was messaged about.** The
 * reviewer's message carries the escalate button, but it scrolls away, it only
 * reaches whoever covered the region at the moment somebody tapped, and a dispute
 * where *neither* party ever answers is never messaged to anybody at all. Part 2
 * declines to auto-expire a dispute and chooses visibility instead; this command
 * and the morning digest are that choice.
 *
 * Not scoped by region, and that is deliberate. A dispute is not a case: it has
 * no queue, and `visibleToStaff` has nothing to filter on. `dispute.review` is
 * the scope, which is why the floor on it was argued rather than assumed.
 */
export const disputes: StaffCommand = {
  name: '/disputes',
  capability: CAPABILITY.DISPUTE_REVIEW,
  handle: async (ctx) => {
    const open = await openDisputes(ctx.db, STAFF_CASE_LIST_CAP);

    if (open.length === 0) {
      return reply(
        ctx.member.telegramId,
        'No accounts are in dispute.\n\n'
          + 'One opens by itself when a second Telegram account signs in as a teacher who '
          + 'is already signed in.',
      );
    }

    const lines = open.flatMap((d) => [
      `#${String(d.id)} — ${d.identifier}`,
      `  ${String(d.parties.length)} accounts · opened ${d.openedAt} · ${describeDisputeState(d.state)}`,
      `  ${d.parties.join(', ')}`,
      '',
    ]);

    /**
     * Capped like every keyboard here. `STAFF_BUTTON_CAP` rather than the list
     * cap: the text above is still there to read, and a wall of buttons is the
     * failure Part 5G's cap exists to prevent.
     */
    const keyboard: InlineKeyboard = open.slice(0, STAFF_BUTTON_CAP).map((d) => [
      {
        text: `📤 Send #${String(d.id)} to system admin`,
        callback_data: encodeCallback(CALLBACK.DISPUTE_ESCALATE, String(d.id)),
      },
    ]);

    return reply(
      ctx.member.telegramId,
      [
        `⚖️ ${String(open.length)} account${open.length === 1 ? '' : 's'} in dispute`,
        '',
        ...lines,
        'Check however you normally would, then pass it on. Only a system',
        'administrator can decide which account stays.',
      ].join('\n'),
      keyboard,
    );
  },
};

/** The state, in the words a ministry staff member would use. */
function describeDisputeState(state: IdentityDisputeState): string {
  if (state === 'Open') return 'nobody has answered yet';
  if (state === 'Claimed') return 'answered, waiting on review';
  if (state === 'WithSystem') return 'with a system administrator';
  return 'settled';
}

/**
 * `/dispute_resolve <id> <chat id> <why>` — System only.
 *
 * **It runs the same function the button does.** `settleAndAnnounce` holds the
 * refusals, the revocations, the case closing and the messages to every party, so
 * the typed command and the tap cannot answer differently — the property Part
 * 5H.3 established for staff management, applied to the heaviest action in the
 * bot.
 *
 * The reason is required rather than optional. This closes somebody's cases and
 * ends their access on a judgement about who they are; an audit row that says
 * only "resolved" is one nobody can review afterwards.
 */
export const disputeResolve: StaffCommand = {
  name: '/dispute_resolve',
  capability: CAPABILITY.DISPUTE_RESOLVE,
  handle: async (ctx) => {
    const usage =
      '/dispute_resolve 42 995101 telephoned the school and confirmed\n\n'
      + 'The chat id is the account that KEEPS the identity — every other account in '
      + 'the dispute is revoked and its cases closed. /disputes shows which they are.';

    const trimmed = ctx.rest.trim();
    const boundary = trimmed.search(/\s/);
    const head = boundary === -1 ? trimmed : trimmed.slice(0, boundary);

    if (!/^\d+$/.test(head)) {
      return reply(ctx.member.telegramId, `I need a dispute number.\n\n${usage}`);
    }

    const split = splitChatId(boundary === -1 ? '' : trimmed.slice(boundary).trim());
    if (split === null) {
      return reply(
        ctx.member.telegramId,
        `I need the chat id of the account that keeps the identity.\n\n${usage}`,
      );
    }

    if (split.rest === '') {
      return reply(
        ctx.member.telegramId,
        'I need a reason, in your own words.\n\n'
          + 'This ends somebody’s access and closes their cases on a judgement about who '
          + `they are. An audit row saying only “resolved” is one nobody can review.\n\n${usage}`,
      );
    }

    return settleAndAnnounce(ctx.db, ctx.member.telegramId, {
      disputeId: Number.parseInt(head, 10),
      keptChatId: split.chatId,
      actor: ctx.member.telegramId,
      outcome: split.rest,
      supportContact: ctx.deps.supportContact,
    });
  },
};

export const PEOPLE_COMMANDS: readonly StaffCommand[] = [
  whoami,
  region,
  regions,
  disputes,
  disputeResolve,
  staffList,
  staffAdd,
  staffRole,
  staffQueue,
  staffRegion,
  staffRemove,
  revoke,
  restore,
  forget,
  username,
];
