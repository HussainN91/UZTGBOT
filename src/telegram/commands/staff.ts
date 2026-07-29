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
import { STAFF_CASE_LIST_CAP } from '../../config/constants.js';
import { casesOwnedBy, listCases } from '../../cases/queries.js';
import { STAFF_ROLE_ORDER, type StaffRole } from '../../db/schema.js';
import { ALL_QUEUES, QUEUE, type Queue } from '../../staff/queues.js';
import { CAPABILITY, capabilitiesFor } from '../../staff/roles.js';
import {
  StaffAlreadyExistsError,
  addStaff,
  countActiveSystem,
  deactivateStaff,
  findAnyStaff,
  listStaff,
  setStaffRole,
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

    return reply(ctx.member.telegramId, lines.join('\n'));
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
 * exactly as deactivating them does, with the same recovery: SSH and SQL. A
 * guard on one of the two doors is not a guard.
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
            'System is the only rank that can add staff at all. Taking it off the last',
            'person holding it leaves nobody who can put it back, and the recovery is a',
            'database session over the SSH tunnel.',
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
          'you would have no way to undo it. Ask another System member.',
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
     * D13's rule, and it is **unreachable behind the check above** — deliberately
     * kept anyway.
     *
     * `staff.manage` floors at System, so the caller is always an active System
     * member. If the target is a *different* active System member there are at
     * least two, and if it is the same one the self-check has already refused.
     * The invariant "at least one active System member" is therefore held by the
     * self-check alone, which is worth knowing and is not worth relying on: this
     * branch is what catches it if the self-check is ever relaxed, if a bootstrap
     * path is added, or if the floor for this capability ever moves. The
     * reachable version of this hole is on `/staff_role` — see there.
     */
    if (existing.role === 'System') {
      const systems = await countActiveSystem(ctx.db);
      if (systems <= 1) {
        return reply(
          ctx.member.telegramId,
          [
            `${describeStaff(existing)} is the last active System member, so nothing was changed.`,
            '',
            'With nobody at System nothing can add staff, change a rank or pause the bot,',
            'and the recovery is a hand-written INSERT over the SSH tunnel.',
            '',
            'Add a second System member first.',
          ].join('\n'),
        );
      }
    }

    /**
     * Read under the caller's own scope, which is exact here and only here:
     * `staff.manage` floors at System, and a System member bypasses both the
     * queue and the region axis. Asked through the scoped query rather than with
     * an unscoped count so that no read in this stage sidesteps the visibility
     * predicate — the `total` is the true figure, the list itself is capped.
     */
    const owned = await casesOwnedBy(ctx.db, scopeOf(ctx.member), split.chatId);

    const written = await deactivateStaff(ctx.db, split.chatId, ctx.member.telegramId);
    if (!written) return reply(ctx.member.telegramId, `${split.chatId} has gone. Nothing was changed.`);

    const caseNote =
      owned.total === 0
        ? ['They own no open cases.']
        : [
            `They still own ${String(owned.total)} open case${owned.total === 1 ? '' : 's'}, and those have been left exactly where they are:`,
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

/** Every command in this file, so registering one is a single edit. */
export const PEOPLE_COMMANDS: readonly StaffCommand[] = [
  whoami,
  region,
  regions,
  staffList,
  staffAdd,
  staffRole,
  staffRemove,
  revoke,
  restore,
];
