/**
 * Messaging every teacher at once — Task 62 — and taking a report out — Task 63.
 *
 * Two commands that have nothing in common except their shape: both are bulk,
 * both are the largest version of something the system already does one at a
 * time, and both are irreversible in a way a single message and a single `/case`
 * are not. They share a file because they share that argument, and because a
 * reader who changes one should be looking at the other.
 *
 * **Nothing here sends anything.** `/announce` writes a draft and freezes its
 * audience; a scheduled sweeper does the delivering (D37), which is what makes a
 * restart mid-broadcast resume rather than repeat — and what keeps announcements
 * out of `job_runs`, where an on-demand row would raise a critical alarm every
 * hour in which nobody sent one (R22).
 *
 * `/export` does produce a file, and the file is the one thing this system emits
 * that outlives every control it has (R28). What limits it is what goes into it.
 */
import {
  ANNOUNCEMENT_BATCH,
  EXPORT_ROW_CAP,
  TELEGRAM_MESSAGE_MAX_CHARS,
} from '../../config/constants.js';
import { type Audience, describeAudience, parseAudience } from '../../announcements/audience.js';
import {
  type AnnouncementRow,
  cancelAnnouncement,
  createDraft,
  findAnnouncement,
  listAnnouncements,
  markQueued,
  tally,
} from '../../announcements/store.js';
import { casesForExport } from '../../cases/queries.js';
import { announcementMessage, announcementOverBy } from '../../digest/format.js';
import { toCsv } from '../../export/csv.js';
import { recordAudit } from '../../log/audit.js';
import { CAPABILITY } from '../../staff/roles.js';
import { knownRegions } from '../../teachers/region.js';
import { type StaffCommand, type StaffContext, formatTashkent, reply } from './context.js';

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

const ANNOUNCE_USAGE = [
  '/announce all <message>              — every teacher who can use the bot',
  '/announce region:Bukhara <message>   — one region only',
  '/announce_send <id>                  — actually send it',
  '/announce_cancel <id>                — stop it',
  '/announcements                       — what has been sent',
];

/**
 * Split `all Dear teachers, …` into the audience and the message.
 *
 * The audience is the **first word**, which is also what makes D16's prefix rule
 * work: the interaction log keeps a command's name and first argument and drops
 * the rest, so this logs as `/announce all` and the message to 1,800 teachers
 * does not land in `messages`. `interactions.ts` names this exact command in its
 * comment; the test asserts it rather than trusting it.
 */
function splitAudience(rest: string): { readonly head: string; readonly body: string } | null {
  const trimmed = rest.trim();
  if (trimmed === '') return null;

  const boundary = trimmed.search(/\s/);
  if (boundary === -1) return { head: trimmed, body: '' };
  return { head: trimmed.slice(0, boundary), body: trimmed.slice(boundary).trim() };
}

/**
 * Resolve the region name against the ones this system has heard of.
 *
 * The shape is decided by the pure module and the *name* here, because
 * `knownRegions` is what `/region` and `/staff_add` already canonicalise
 * against. An announcement addressed to a region nobody is in reaches nobody
 * and looks exactly like one that worked — the count in the confirmation would
 * be `0` and a sender in a hurry reads `0` as `done`. Refusing names the
 * regions instead.
 */
async function canonicalAudience(
  ctx: StaffContext,
  audience: Audience,
): Promise<{ readonly ok: true; readonly audience: Audience } | { readonly ok: false; readonly text: string }> {
  if (audience.kind === 'all') return { ok: true, audience };

  const known = await knownRegions(ctx.db);
  const match = known.find((r) => r.toLowerCase() === audience.region.toLowerCase());
  if (match === undefined) {
    return {
      ok: false,
      text: [
        `I do not know a region called “${audience.region}”, so nothing was written.`,
        '',
        known.length === 0 ? 'No region is on the roster yet.' : `Known: ${known.join(', ')}`,
      ].join('\n'),
    };
  }

  return { ok: true, audience: { kind: 'region', region: match } };
}

/**
 * `/announce <audience> <message>` — write a draft and freeze who gets it.
 *
 * **Nothing is sent by this command**, and that is the whole design (D41).
 * 1,800 messages is the least undoable thing in the system, so it takes two
 * commands: one that shows the sender exactly what will go and to how many
 * people, and one that confirms it. The audience is frozen *here*, at the
 * preview, because that is the only point at which the number approved and the
 * number messaged can be the same number — the flaw the schema describes is a
 * version that counted once for the preview and looked it up again when sending.
 *
 * No audit row. `announcements` is itself the permanent record — it holds the
 * text, the audience, the sender and the time, it is never pruned (D33), and a
 * second row in `audit_log` saying the same thing is a second copy that can
 * disagree.
 */
export const announce: StaffCommand = {
  name: '/announce',
  capability: CAPABILITY.ANNOUNCE,
  handle: async (ctx) => {
    const split = splitAudience(ctx.rest);
    if (split === null) {
      return reply(
        ctx.member.telegramId,
        ['What should it say, and who to?', '', ...ANNOUNCE_USAGE].join('\n'),
      );
    }

    const shape = parseAudience(split.head);
    if (shape === null) {
      return reply(
        ctx.member.telegramId,
        [
          `I do not understand “${split.head}” as an audience, so nothing was written.`,
          '',
          'There are two: `all`, or `region:<name>`.',
          '',
          ...ANNOUNCE_USAGE,
        ].join('\n'),
      );
    }

    if (split.body === '') {
      return reply(
        ctx.member.telegramId,
        ['That has no message in it, so nothing was written.', '', ...ANNOUNCE_USAGE].join('\n'),
      );
    }

    const resolved = await canonicalAudience(ctx, shape);
    if (!resolved.ok) return reply(ctx.member.telegramId, resolved.text);

    /**
     * Measured on the *rendered* message, and against the un-clamped length.
     *
     * Telegram refuses anything past the limit, but the formatter clamps rather
     * than throwing — so without this an over-long announcement is silently
     * truncated and delivered to every teacher ending in "… cut short".
     * `announcementOverBy` is what sees that; a check against the clamped text
     * can never fire, which is how this was written the first time.
     */
    const overBy = announcementOverBy(split.body);
    if (overBy > 0) {
      return reply(
        ctx.member.telegramId,
        [
          'That is too long for Telegram to deliver, so nothing was written.',
          '',
          `With the heading it is ${overBy} characters past the limit of`,
          `${TELEGRAM_MESSAGE_MAX_CHARS}. Shorten it and send it again.`,
          '',
          'It is refused rather than shortened for you: an announcement that arrives',
          'cut off mid-sentence reaches every teacher that way, and cannot be recalled.',
        ].join('\n'),
      );
    }

    const preview = announcementMessage(split.body);

    const { id, recipients } = await createDraft(ctx.db, {
      content: split.body,
      audience: resolved.audience,
      createdBy: ctx.member.telegramId,
    });

    return reply(
      ctx.member.telegramId,
      [
        `📝 *Draft ${id}*`,
        '',
        `To: ${describeAudience(resolved.audience)} — *${recipients}* ${recipients === 1 ? 'teacher' : 'teachers'}.`,
        ...(recipients === 0
          ? ['', '⚠️ Nobody matches that audience, so sending it would reach no one.']
          : []),
        '',
        'This is exactly what they will see:',
        '',
        '— — —',
        preview,
        '— — —',
        '',
        'Nothing has been sent. To send it:',
        `/announce_send ${id}`,
        '',
        `To throw it away: /announce_cancel ${id}`,
      ].join('\n'),
    );
  },
};

/** Why a draft could not be confirmed, in the words its status deserves. */
function refuseSend(row: AnnouncementRow): string {
  switch (row.status) {
    case 'Queued':
    case 'Sending':
      return 'That is already being sent. /announcements shows how far it has got.';
    case 'Sent':
      return `That was already sent${row.finishedAt === null ? '' : `, at ${formatTashkent(row.finishedAt)}`}. Write a new one rather than resending.`;
    case 'Cancelled':
      return 'That was cancelled. Write a new one — a cancelled announcement is not restarted.';
    case 'Failed':
      return 'That one failed and was not left sendable. Write a new one.';
    default:
      return 'That cannot be sent.';
  }
}

/**
 * `/announce_send <id>` — confirm a draft, and hand it to the sweeper.
 *
 * It marks the row `Queued` and returns. There is deliberately no job to
 * enqueue: a scheduled sweeper is the only sender (D37), which keeps
 * announcements out of `job_runs` and makes a restart mid-broadcast resume by
 * construction rather than through a second recovery mechanism.
 *
 * **Only the person who drafted it may confirm it**, and that is not a
 * permission question — every Program member holds `announce`. It is that a
 * Program member confirming somebody else's draft is confirming words they did
 * not write, to 1,800 people, under their own name.
 */
export const announceSend: StaffCommand = {
  name: '/announce_send',
  capability: CAPABILITY.ANNOUNCE,
  handle: async (ctx) => {
    const id = ctx.rest.trim();
    if (id === '') {
      return reply(ctx.member.telegramId, ['Which one?', '', ...ANNOUNCE_USAGE].join('\n'));
    }

    const row = await findAnnouncement(ctx.db, id);
    if (row === null) {
      return reply(
        ctx.member.telegramId,
        `There is no announcement ${id}. /announcements lists the recent ones.`,
      );
    }

    if (row.createdBy !== ctx.member.telegramId) {
      return reply(
        ctx.member.telegramId,
        [
          'That draft is somebody else’s, so nothing was sent.',
          '',
          'Whoever wrote it has to send it. Confirming words you did not write, to',
          'every teacher, under your own name, is not something this command will do',
          'for you — and it is not a rank you are missing.',
        ].join('\n'),
      );
    }

    if (!(await markQueued(ctx.db, id))) {
      return reply(ctx.member.telegramId, refuseSend(row));
    }

    const counts = await tally(ctx.db, id);

    return reply(
      ctx.member.telegramId,
      [
        `📣 *Sending to ${counts.total} ${counts.total === 1 ? 'teacher' : 'teachers'}.*`,
        '',
        `They go out in batches of ${ANNOUNCEMENT_BATCH}, about a minute apart, so this takes a`,
        'few minutes rather than happening at once. You will be told when it finishes,',
        'with how many were reached.',
        '',
        `/announce_cancel ${id} — stop the rest. Anything already delivered stays delivered.`,
      ].join('\n'),
    );
  },
};

/**
 * `/announce_cancel <id>` — stop it, and say honestly what had already gone.
 *
 * Available to anybody holding `announce`, not only the drafter, and that
 * asymmetry with `/announce_send` is deliberate: confirming is the irreversible
 * direction and stopping is the recoverable one. A wrong announcement going out
 * while the only person who can halt it is asleep is a worse failure than a
 * colleague cancelling something they should have left alone, which costs a
 * retype.
 */
export const announceCancel: StaffCommand = {
  name: '/announce_cancel',
  capability: CAPABILITY.ANNOUNCE,
  handle: async (ctx) => {
    const id = ctx.rest.trim();
    if (id === '') {
      return reply(ctx.member.telegramId, ['Which one?', '', ...ANNOUNCE_USAGE].join('\n'));
    }

    const row = await findAnnouncement(ctx.db, id);
    if (row === null) {
      return reply(
        ctx.member.telegramId,
        `There is no announcement ${id}. /announcements lists the recent ones.`,
      );
    }

    const { cancelled, alreadySent } = await cancelAnnouncement(ctx.db, id);
    if (!cancelled) {
      return reply(
        ctx.member.telegramId,
        row.status === 'Cancelled'
          ? 'That was already cancelled.'
          : `That one finished, so there is nothing left to stop. ${alreadySent} ${alreadySent === 1 ? 'teacher has' : 'teachers have'} it.`,
      );
    }

    return reply(
      ctx.member.telegramId,
      alreadySent === 0
        ? '🛑 Stopped. Nothing had been sent.'
        : [
            `🛑 Stopped — but ${alreadySent} ${alreadySent === 1 ? 'teacher' : 'teachers'} already had it.`,
            '',
            'A message that has been delivered cannot be recalled. If it needs correcting,',
            'that is a second announcement to the same audience.',
          ].join('\n'),
    );
  },
};

/**
 * How many announcements `/announcements` shows.
 *
 * Small on purpose: each one costs a `tally` query, and the question this
 * command answers is about the last few days rather than about the year.
 */
const ANNOUNCEMENT_LIST_CAP = 10;

/** How far a send has got, in one line. */
function announcementLine(row: AnnouncementRow, counts: { sent: number; total: number }): string {
  const when = formatTashkent(row.createdAt);
  const progress =
    row.status === 'Draft' ? `${counts.total} to go to` : `${counts.sent}/${counts.total} sent`;
  return `• \`${row.id}\` — ${row.status}, ${progress}, ${row.audience}, ${when}`;
}

/**
 * `/announcements` — what has been sent, and what is in flight.
 *
 * Deliberately short. This is the answer to "did that go out" and "what is that
 * thing I drafted yesterday", not an archive: the whole text of every past
 * announcement in one Telegram message is a message nobody reads.
 */
export const announcementsList: StaffCommand = {
  name: '/announcements',
  capability: CAPABILITY.ANNOUNCE,
  handle: async (ctx) => {
    const rows = await listAnnouncements(ctx.db, ANNOUNCEMENT_LIST_CAP);
    if (rows.length === 0) {
      return reply(
        ctx.member.telegramId,
        ['Nothing has been announced yet.', '', ...ANNOUNCE_USAGE].join('\n'),
      );
    }

    const lines: string[] = [];
    for (const row of rows) {
      lines.push(announcementLine(row, await tally(ctx.db, row.id)));
    }

    return reply(
      ctx.member.telegramId,
      ['📣 *Recent announcements*', '', ...lines, '', ...ANNOUNCE_USAGE].join('\n'),
    );
  },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Every column the export carries, and — by its absence — every one it does not.
 *
 * **`detail`, `public_update` and the teacher's name are deliberately missing,
 * and a test asserts they are** (D43). `/case` shows a teacher's words, checks
 * permission first and leaves a row saying who read them. A file has none of
 * those properties: it lands in a Telegram chat, syncs to that person's devices,
 * is forwardable, and outlives the retention job built to delete the very text
 * inside it. Bulk egress of a teacher's account of their own problem is a
 * different act from a staff member reading one case, and this command must not
 * make them the same act.
 *
 * A column added here by somebody being helpful is how that stops being true, so
 * the list is a constant with this comment on it rather than an inline array.
 */
const EXPORT_COLUMNS = [
  'reference',
  'category',
  'status',
  'importance',
  'region',
  'owner',
  'created',
  'updated',
  'due',
  'closed',
] as const;

type ExportColumn = (typeof EXPORT_COLUMNS)[number];

/** `bukhara`, `all`, `open` — what goes in the filename so a stale file looks stale. */
function exportScopeLabel(filter: string): string {
  const cleaned = filter.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return cleaned === '' ? 'all' : cleaned;
}

/**
 * `/export [status]` — a management report of the cases the asker can see.
 *
 * Scoped through `queries.ts` and never with a query of its own. That module's
 * guarantee is that no question asked of it returns a case the asker may not
 * see, and an export is the largest question anybody asks — a Lead exporting
 * another region would be the whole guarantee lost in one command.
 *
 * An audit row is written because this is the one act in the stage with no other
 * trace (D18). A reply arrives in a teacher's chat, a close changes a status; a
 * file simply leaves, and nothing else would record that it had.
 */
export const exportCases: StaffCommand = {
  name: '/export',
  capability: CAPABILITY.EXPORT,
  handle: async (ctx) => {
    const filter = ctx.rest.trim();

    const found = await casesForExport(ctx.db, ctx.scope, filter);
    if (!found.ok) {
      return reply(
        ctx.member.telegramId,
        [
          `I do not understand “${filter}”, so nothing was exported.`,
          '',
          '/export            — every case you can see',
          '/export open       — the open ones only',
          `/export <status>   — one status: ${found.statuses.join(', ')}`,
        ].join('\n'),
      );
    }

    if (found.list.total === 0) {
      // A file with a header and no rows is indistinguishable from a broken
      // export, and it is the kind of thing somebody plans from.
      return reply(
        ctx.member.telegramId,
        filter === ''
          ? 'There are no cases you can see, so there is nothing to export.'
          : `No case you can see is “${filter}”, so there is nothing to export.`,
      );
    }

    const contents = toCsv(
      EXPORT_COLUMNS,
      found.list.cases.map(
        (row): Readonly<Record<ExportColumn, string | number | Date | null>> => ({
          reference: row.reference,
          category: row.category,
          status: row.status,
          importance: row.importance,
          region: row.region,
          owner: row.owner,
          created: row.createdAt,
          updated: row.updatedAt,
          due: row.dueAt,
          closed: row.closedAt,
        }),
      ),
    );

    const taken = new Date();
    const day = formatTashkent(taken).slice(0, 11).trim().replace(/ /g, '-').toLowerCase();
    const filename = `cases-${day}-${exportScopeLabel(filter)}.csv`;

    const truncated = found.list.total - found.list.cases.length;

    await recordAudit(ctx.db, {
      actor: ctx.member.telegramId,
      action: 'CASES_EXPORTED',
      subject: filename,
      detail: { filter: filter === '' ? 'all' : filter, rows: found.list.cases.length, matched: found.list.total },
    });

    return {
      messages: [
        {
          chatId: ctx.member.telegramId,
          text: [
            `📄 ${found.list.cases.length} ${found.list.cases.length === 1 ? 'case' : 'cases'}, as you can see them.`,
            ...(truncated > 0
              ? [
                  '',
                  `⚠️ ${truncated} more matched and are NOT in this file — it stops at ${EXPORT_ROW_CAP} rows.`,
                  'Narrow it with a status rather than planning from this one.',
                ]
              : []),
            '',
            'It carries no teacher’s words and no teacher’s name — not the case detail,',
            'not the update they were sent. Use /case for those, one at a time.',
            '',
            'This file is now outside everything that governs the system. Nothing deletes',
            'it, and forwarding it forwards it for good.',
          ].join('\n'),
          document: { filename, contents },
        },
      ],
      alerts: [],
    };
  },
};

export const ANNOUNCE_COMMANDS: readonly StaffCommand[] = [
  announce,
  announceSend,
  announceCancel,
  announcementsList,
  exportCases,
];
