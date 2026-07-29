/**
 * The five reading commands: `/cases` `/mycases` `/urgent` `/case` `/search`.
 *
 * Thin, on purpose. Every question about *which* cases the caller may see was
 * answered in layer 2 — `src/cases/queries.ts` applies `visibleToStaff` and both
 * joins to every read, so there is no way to ask this module a question that
 * returns a case its asker may not have. Nothing here re-derives visibility, and
 * nothing here talks to the database except through those queries.
 *
 * `adminCanSeeCase_` was correct and was applied by hand at six separate call
 * sites (`AdminCommands.gs:529, 569, 597, 636, 836`); the seventh would have
 * been an exposure with no error anywhere. These five commands are that seventh
 * through eleventh, and they get it for free.
 *
 * **Length is the one thing this file has to be careful about.** Telegram
 * rejects a message over 4096 characters, and `/case` prints a teacher's own
 * words — which have no length limit, and which the urgent path appends to —
 * alongside staff notes that have none either. That is reachable by ordinary
 * use, and it is the failure `handleCaseDetail_` carried a comment about. The
 * detail and each note are budgeted here; `reply` clamps whatever comes out.
 */
import {
  CASE_DETAIL_SHOWN_CHARS,
  CASE_NOTES_SHOWN,
  CASE_NOTE_SHOWN_CHARS,
} from '../../config/constants.js';
import { addNote, countNotes, recentNotes, type CaseNote } from '../../cases/notes.js';
import {
  casesOwnedBy,
  findCase,
  listCases,
  overdueDays,
  searchCases,
  staleCases,
  type StaffCaseList,
  type StaffCaseRow,
} from '../../cases/queries.js';
import { updateCase } from '../../cases/service.js';
import { caseStatusList, isOpenStatus, parseCaseStatus } from '../../cases/status.js';
import { recordAudit } from '../../log/audit.js';
import { CAPABILITY } from '../../staff/roles.js';
import { findStaff } from '../../staff/repository.js';
import { findTeacher, teacherHasAccess } from '../../teachers/repository.js';
import type { OutgoingMessage, RouterOutcome } from '../router.js';
import {
  type StaffCommand,
  type StaffContext,
  ageInDays,
  formatTashkent,
  reply,
  replyAndTell,
  scopeOf,
} from './context.js';
import { splitReference } from './parse.js';

/**
 * What `/cases` was asked for.
 *
 * `unassigned` is checked before the status parser, and is not itself a status.
 * It is the intake backlog — the standing answer to R4, where a case is filed
 * into a queue nobody holds and sits unseen. The new-case alert catches it as it
 * happens; this is how somebody finds it afterwards.
 */
const UNASSIGNED = 'unassigned';

/** Shown against a case whose importance somebody has judged. See D22. */
const IMPORTANCE_MARK: Readonly<Record<StaffCaseRow['importance'], string>> = {
  Normal: '',
  Urgent: '❗',
  Critical: '🚨',
};

/**
 * One case on one line.
 *
 * Reference first, because it is what every other command takes as an argument
 * and what a teacher reads out over the telephone. Nothing here is unbounded:
 * the teacher's words are not in a list, and never will be — `/search` matches
 * on `detail` and still does not print it, because a list of twenty cases is
 * twenty teachers' accounts of their problems in one message.
 */
function caseLine(row: StaffCaseRow): string {
  const parts = [
    row.status,
    row.category,
    row.region ?? 'region not recorded',
    ageInDays(row.createdAt),
    row.owner === null ? 'unassigned' : `owner ${row.owner}`,
  ];
  return `${IMPORTANCE_MARK[row.importance]}${row.reference} — ${parts.join(' · ')}`;
}

/**
 * A list, headed by what it is and how much of it is being shown.
 *
 * The count of the rest is always reported. `handleListCases_` displayed twenty
 * and said nothing further, which made a backlog of two hundred look exactly
 * like a backlog of twenty — and the only reason to look at a queue is to find
 * out which of those it is.
 */
function renderList(title: string, list: StaffCaseList, emptyMessage: string): string {
  if (list.total === 0) return `${title}\n\n${emptyMessage}`;

  const heading =
    list.cases.length < list.total
      ? `${title} — showing ${list.cases.length} of ${list.total}`
      : `${title} (${list.total})`;

  return [heading, '', ...list.cases.map(caseLine)].join('\n');
}

/** Cut a block of somebody's writing to its budget, saying how much is missing. */
function budget(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}… (${trimmed.length - limit} more characters — this is the whole of it in the database)`;
}

function renderNote(note: CaseNote): string {
  return `${formatTashkent(note.createdAt)} · ${note.authorChatId}\n  ${budget(note.body, CASE_NOTE_SHOWN_CHARS)}`;
}

/**
 * One case in full — the only place a teacher's own words are ever shown.
 *
 * The teacher's chat id is included because it is the argument `/revoke` and
 * `/region` take, and looking it up separately would mean a second command
 * against a table this one has already read.
 *
 * Due date and snooze are shown whether or not they are set (R15). They are
 * written from Task 45 and nothing chases them until stage 5, so this display is
 * the entire difference between two columns a person can act on and two columns
 * that are invisible until the stage after next.
 */
function renderCase(row: StaffCaseRow, notes: CaseNote[], noteTotal: number): string {
  const lines = [
    `${IMPORTANCE_MARK[row.importance]}${row.reference}`,
    `${row.status} · ${row.category} · importance ${row.importance}`,
    '',
    `Teacher: ${row.teacherName ?? 'name not recorded'} (chat ${row.teacherChatId})`,
    `Region: ${row.region ?? 'not recorded'}`,
    `Owner: ${row.owner ?? 'nobody — /assign to take it'}`,
    `Opened: ${formatTashkent(row.createdAt)} (${ageInDays(row.createdAt)} ago)`,
    `Last touched: ${formatTashkent(row.updatedAt)}`,
    `Promised by: ${row.dueAt === null ? 'no date given' : formatTashkent(row.dueAt)}`,
    `Snoozed until: ${row.snoozedUntil === null ? 'not snoozed' : formatTashkent(row.snoozedUntil)}`,
    ...(row.closedAt === null ? [] : [`Closed: ${formatTashkent(row.closedAt)}`]),
    '',
    'What the teacher wrote',
    budget(row.detail, CASE_DETAIL_SHOWN_CHARS),
    '',
    'What the teacher has been told',
    row.publicUpdate.trim() === '' ? 'Nothing yet — /reply is the only thing they ever see.' : row.publicUpdate.trim(),
  ];

  if (noteTotal === 0) {
    lines.push('', 'Notes: none yet — /note adds one, and no teacher ever sees them.');
  } else {
    const shown = notes.length < noteTotal ? `${notes.length} of ${noteTotal}, newest first` : `${noteTotal}`;
    lines.push('', `Notes (${shown})`, ...notes.map(renderNote));
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

/**
 * `/cases` — open cases in the caller's queue and region.
 *
 * `/cases unassigned` is the intake backlog; `/cases <status>` filters exactly.
 * An unrecognised word is refused with the list of statuses rather than quietly
 * matching nothing, which is what `handleListCases_` did to every two-word
 * status and which looked identical to an empty queue.
 */
export const cases: StaffCommand = {
  name: '/cases',
  capability: CAPABILITY.CASE_VIEW,
  handle: async ({ db, member, scope, rest }) => {
    const wanted = rest.trim();

    if (wanted.toLowerCase() === UNASSIGNED) {
      const list = await listCases(db, scope, { unassigned: true });
      return reply(
        member.telegramId,
        renderList('Open cases with no owner', list, 'Nothing is waiting to be picked up.'),
      );
    }

    if (wanted !== '') {
      const status = parseCaseStatus(wanted);
      if (status === null) {
        return reply(
          member.telegramId,
          [
            `I do not know a status called “${wanted}”.`,
            '',
            `The statuses are: ${caseStatusList()}.`,
            '',
            '/cases — everything still open',
            '/cases unassigned — the ones nobody has taken',
          ].join('\n'),
        );
      }
      const list = await listCases(db, scope, { status });
      return reply(
        member.telegramId,
        renderList(`Cases at “${status}”`, list, `No case is at ${status}.`),
      );
    }

    const list = await listCases(db, scope);
    return reply(
      member.telegramId,
      renderList('Open cases', list, 'Nothing is open in your queue.'),
    );
  },
};

/** `/mycases` — open cases this person owns. A closed case is not work in hand. */
export const myCases: StaffCommand = {
  name: '/mycases',
  capability: CAPABILITY.CASE_VIEW,
  handle: async ({ db, member, scope }) => {
    const list = await casesOwnedBy(db, scope, member.telegramId);
    return reply(
      member.telegramId,
      renderList(
        'Cases assigned to you',
        list,
        'Nothing is assigned to you. /cases unassigned shows what nobody has taken.',
      ),
    );
  },
};

/**
 * `/urgent` — the two things that mean "look at this now", kept apart.
 *
 * Escalated cases are emergencies while they are open (D25). Stale cases are
 * ones nobody has touched for `OVERDUE_DAYS`. A case can be either, both or
 * neither, and merging them would make one list that answers neither question.
 *
 * When nobody has set `OVERDUE_DAYS` the second half says so rather than
 * reporting an empty list. "Nothing is overdue" and "nobody has said what
 * overdue means" are the same empty array and opposite conclusions, and a staff
 * member shown the first when the second is true stops looking.
 */
export const urgent: StaffCommand = {
  name: '/urgent',
  capability: CAPABILITY.CASE_VIEW,
  handle: async ({ db, member, scope }) => {
    const escalated = await listCases(db, scope, { status: 'Escalated' });
    const days = await overdueDays(db);
    const stale = await staleCases(db, scope);

    const overdueSection =
      days === null
        ? [
            'Cases nobody has touched',
            '',
            'Not switched on. OVERDUE_DAYS has no value, so this list cannot be',
            'produced — it is empty because nothing is being measured, not because',
            'every case is being worked.',
          ].join('\n')
        : renderList(
            `Untouched for more than ${days} day${days === 1 ? '' : 's'}`,
            stale,
            'Every open case has been touched inside the threshold.',
          );

    return reply(
      member.telegramId,
      [
        renderList('Escalated', escalated, 'No case is escalated.'),
        '',
        '— — —',
        '',
        overdueSection,
      ].join('\n'),
    );
  },
};

/**
 * `/case <reference>` — one case in full.
 *
 * "No such case" and "not yours" are the same answer, deliberately and
 * indistinguishably. Telling somebody a reference exists but belongs to a queue
 * they do not hold confirms that a teacher filed something, which is the thing
 * the visibility rule protects.
 *
 * Reading one leaves a row in `messages` saying who read which case — the
 * router logs every command, and D16's rule keeps the command word and the
 * reference. That is the whole audit trail for "who looked at this teacher's
 * words", and it exists without this command doing anything.
 */
export const oneCase: StaffCommand = {
  name: '/case',
  capability: CAPABILITY.CASE_VIEW,
  handle: async ({ db, member, scope, rest }) => {
    const reference = rest.trim();
    if (reference === '') {
      return reply(member.telegramId, 'Which case? /case VISA-2026-00001');
    }

    const row = await findCase(db, scope, reference);
    if (row === null) {
      return reply(
        member.telegramId,
        `No case ${reference.toUpperCase()} that you can see. Check the reference, or /cases for what is open.`,
      );
    }

    const [notes, noteTotal] = await Promise.all([
      recentNotes(db, row.reference, CASE_NOTES_SHOWN),
      countNotes(db, row.reference),
    ]);

    return reply(member.telegramId, renderCase(row, notes, noteTotal));
  },
};

/**
 * `/search <text>` — reference or the teacher's own words.
 *
 * Searches closed cases too, unlike `/cases`: somebody searching is usually
 * looking for something already dealt with. It matches on `detail` and still
 * never prints it — twenty matches would be twenty teachers' accounts of their
 * problems in one message, and the way to read one is `/case`, which leaves a
 * row saying who read it.
 *
 * An empty term is refused rather than returning everything.
 */
export const search: StaffCommand = {
  name: '/search',
  capability: CAPABILITY.CASE_VIEW,
  handle: async ({ db, member, scope, rest }) => {
    const term = rest.trim();
    if (term === '') {
      return reply(member.telegramId, 'What am I looking for? /search embassy appointment');
    }

    const list = await searchCases(db, scope, term);
    return reply(
      member.telegramId,
      renderList(`Cases matching “${term}”`, list, 'Nothing matched, in any status.'),
    );
  },
};

// ---------------------------------------------------------------------------
// Changing a case — Task 34, D25 as corrected by D26
// ---------------------------------------------------------------------------

/**
 * Turn what somebody typed into a case they are allowed to change.
 *
 * **This is the authorization step for every mutation below, and it is the one
 * thing in this file that must never be skipped.** `updateCase` and `addNote`
 * take a bare reference and write — neither knows who is asking. Resolving
 * through `findCase` is what applies the scope, so a Support member holding the
 * Visa queue in Tashkent cannot close an Accommodation case in Samarkand by
 * typing its reference. Doing it in one helper rather than at five call sites is
 * the whole lesson of `adminCanSeeCase_`, which was correct and was applied by
 * hand until one place forgot.
 *
 * It answers "no such case" and "not yours" identically, for the same reason
 * `findCase` returns null for both: confirming that a reference exists tells the
 * asker a teacher filed something, which is what the visibility rule protects.
 */
type Resolved =
  | { readonly ok: true; readonly row: StaffCaseRow; readonly rest: string }
  | { readonly ok: false; readonly text: string };

async function resolveCase(ctx: StaffContext, usage: string): Promise<Resolved> {
  const split = splitReference(ctx.rest);
  if (split === null) {
    return { ok: false, text: `I need a case reference first.\n\n${usage}` };
  }

  const row = await findCase(ctx.db, ctx.scope, split.reference);
  if (row === null) {
    return {
      ok: false,
      text: `No case ${split.reference} that you can see. Check the reference, or /cases for what is open.`,
    };
  }

  return { ok: true, row, rest: split.rest };
}

/**
 * A message to the teacher, and whether the sender needs warning about it.
 *
 * R5, and it is wider than R5 described. A teacher loses the use of the bot in
 * two ways — `/revoke`, and their roster row being deactivated or removed — and
 * only the first is a `Revoked` state. `teacherHasAccess` is the single answer
 * to both, which is why the check is that function and not a comparison against
 * `verificationState`.
 *
 * The message is still **sent**. Telegram will deliver it: the teacher simply
 * cannot use the bot to reply or to look the case up again. Refusing to send
 * would leave a staff member believing they had answered somebody. So this is a
 * warning to the sender, never a refusal.
 */
async function noticeForTeacher(
  ctx: StaffContext,
  row: StaffCaseRow,
  text: string,
  purpose: string,
): Promise<{ readonly message: OutgoingMessage; readonly warning: string | null }> {
  const teacher = await findTeacher(ctx.db, row.teacherChatId);
  const reachable = teacherHasAccess(teacher);

  return {
    message: { chatId: row.teacherChatId, text, purpose },
    warning: reachable
      ? null
      : 'Note: this teacher can no longer use the bot, so they cannot open it to ' +
        'read the case or reply. The message has still been sent to their chat.',
  };
}

/** The staff confirmation, with the R5 warning appended when there is one. */
const confirm = (lines: readonly string[], warning: string | null): string =>
  warning === null ? lines.join('\n') : [...lines, '', warning].join('\n');

/**
 * Both halves of answering a teacher: `/reply` and `/await`.
 *
 * They differ in one thing — the status they write, and therefore what the
 * teacher is being told to do. `/reply` says "we are working on it";
 * `/await` says "we need something from you" (D26). Everything else is
 * identical, so they are one function rather than two that drift.
 *
 * Both write `public_update`, which is the only case text a teacher ever sees.
 * `/await` in particular is useless without it: a case marked "you must act"
 * with the instruction sitting in a staff-only column is an instruction nobody
 * follows.
 */
async function answerTeacher(
  ctx: StaffContext,
  kind: 'reply' | 'await',
): Promise<RouterOutcome> {
  const usage =
    kind === 'reply'
      ? '/reply VISA-2026-00001 your visa is with the embassy and should be ready on Friday'
      : '/await VISA-2026-00001 please send us a photograph of your passport page';

  const resolved = await resolveCase(ctx, usage);
  if (!resolved.ok) return reply(ctx.member.telegramId, resolved.text);

  const { row, rest } = resolved;
  const body = rest.trim();

  if (body === '') {
    return reply(
      ctx.member.telegramId,
      kind === 'reply'
        ? `What should I tell them?\n\n${usage}`
        : `What do you need from them? A case marked “Action required” with nothing asked for leaves the teacher stuck.\n\n${usage}`,
    );
  }

  if (!isOpenStatus(row.status)) {
    return reply(
      ctx.member.telegramId,
      `${row.reference} is ${row.status}, so it is finished. /reopen ${row.reference} first if there is more to do.`,
    );
  }

  const status = kind === 'reply' ? 'Under review' : 'Action required';
  const written = await updateCase(ctx.db, row.reference, { status, publicUpdate: body }, ctx.member.telegramId);
  if (!written) return reply(ctx.member.telegramId, `${row.reference} has gone. Nothing was changed.`);

  const teacherText =
    kind === 'reply'
      ? [`Update on your case ${row.reference}`, '', body].join('\n')
      : [
          `Your case ${row.reference} — we need something from you`,
          '',
          body,
          '',
          'The case cannot move forward until this is done.',
        ].join('\n');

  const { message, warning } = await noticeForTeacher(
    ctx,
    row,
    teacherText,
    kind === 'reply' ? 'a reply to a teacher about their case' : 'a request to a teacher for something we need',
  );

  return replyAndTell(
    ctx.member.telegramId,
    confirm(
      [
        `${row.reference} is now ${status}.`,
        kind === 'reply'
          ? 'The teacher has been sent your message and can also see it in Check My Case.'
          : 'The teacher has been told what you need, and can see it in Check My Case.',
      ],
      warning,
    ),
    [message],
  );
}

export const replyToTeacher: StaffCommand = {
  name: '/reply',
  capability: CAPABILITY.CASE_UPDATE,
  handle: (ctx) => answerTeacher(ctx, 'reply'),
};

export const awaitTeacher: StaffCommand = {
  name: '/await',
  capability: CAPABILITY.CASE_UPDATE,
  handle: (ctx) => answerTeacher(ctx, 'await'),
};

/**
 * `/close <ref> <message>` resolved it. `/close <ref> unresolved <reason>` did not.
 *
 * D26 gives `Closed` a writer, and the difference between "we fixed it" and "we
 * gave up" is the single most useful thing a later reader can know. Both stamp
 * `closed_at` and both start stage 5's retention clock; only what a later reader
 * learns differs.
 *
 * **The unresolved reason goes to a note, not to the teacher.** It is written
 * for whoever reads the case afterwards, and staff being candid — "unreachable
 * since March, three attempts" — is what makes it worth having. The teacher is
 * still told their case is closed, because silence against a case they raised is
 * worse than a plain notice, and `public_update` gets a neutral sentence so
 * Check My Case does not go on saying "we are working on it" against a closed
 * case.
 *
 * The word is matched exactly, and the confirmation says plainly which of the
 * two happened — `/close REF unresolved issues remain` is a real thing somebody
 * could type meaning the other one, and the way to catch it is to say what was
 * done rather than to guess.
 */
export const closeCase: StaffCommand = {
  name: '/close',
  capability: CAPABILITY.CASE_UPDATE,
  handle: async (ctx) => {
    const usage = [
      '/close VISA-2026-00001 your visa was issued on Tuesday',
      '/close VISA-2026-00001 unresolved unreachable since March, three attempts',
    ].join('\n');

    const resolved = await resolveCase(ctx, usage);
    if (!resolved.ok) return reply(ctx.member.telegramId, resolved.text);

    const { row, rest } = resolved;

    if (!isOpenStatus(row.status)) {
      return reply(ctx.member.telegramId, `${row.reference} is already ${row.status}.`);
    }

    const unresolved = /^unresolved(\s|$)/i.test(rest.trim());
    const body = unresolved ? rest.trim().replace(/^unresolved\s*/i, '').trim() : rest.trim();

    if (body === '') {
      return reply(
        ctx.member.telegramId,
        unresolved
          ? `Why is it being closed unresolved? A case shut for no recorded reason is one nobody can answer for.\n\n${usage}`
          : `What should I tell the teacher?\n\n${usage}`,
      );
    }

    const publicText = unresolved
      ? `This case has been closed without being resolved. If you still need help, contact ${ctx.deps.supportContact}.`
      : body;

    const written = await updateCase(
      ctx.db,
      row.reference,
      { status: unresolved ? 'Closed' : 'Completed', publicUpdate: publicText },
      ctx.member.telegramId,
    );
    if (!written) return reply(ctx.member.telegramId, `${row.reference} has gone. Nothing was changed.`);

    // The reason is a note, and only on the unresolved path. On the ordinary
    // path the teacher's message is already the record, in public_update.
    if (unresolved) {
      await addNote(ctx.db, row.reference, `Closed unresolved: ${body}`, ctx.member.telegramId);
    }

    const { message, warning } = await noticeForTeacher(
      ctx,
      row,
      [`Your case ${row.reference} has been closed.`, '', publicText].join('\n'),
      'a notice to a teacher that their case is closed',
    );

    return replyAndTell(
      ctx.member.telegramId,
      confirm(
        unresolved
          ? [
              `${row.reference} is Closed — shut without being resolved.`,
              'Your reason is on the case as a note. The teacher was told the case is closed, not why.',
            ]
          : [
              `${row.reference} is Completed.`,
              'The teacher has been sent your message and can see it in Check My Case.',
            ],
        warning,
      ),
      [message],
    );
  },
};

/**
 * `/reopen <ref>` — back to `Under review`.
 *
 * Refuses a case that is already open rather than quietly rewriting its status,
 * which would move `updated_at` and make a case somebody else is working look
 * freshly touched to `staleCases`.
 *
 * The teacher is not messaged. Nothing has been said to them by a person, and
 * Check My Case shows the status, so a notice here would be the bot inventing
 * words nobody wrote. What `updateCase` does do is clear `closed_at` — a case
 * that has not ended must not carry an end date, and stage 5's retention
 * measures from that column.
 */
export const reopenCase: StaffCommand = {
  name: '/reopen',
  capability: CAPABILITY.CASE_UPDATE,
  handle: async (ctx) => {
    const resolved = await resolveCase(ctx, '/reopen VISA-2026-00001');
    if (!resolved.ok) return reply(ctx.member.telegramId, resolved.text);

    const { row } = resolved;
    if (isOpenStatus(row.status)) {
      return reply(ctx.member.telegramId, `${row.reference} is already open — it is ${row.status}.`);
    }

    const written = await updateCase(
      ctx.db,
      row.reference,
      { status: 'Under review' },
      ctx.member.telegramId,
    );
    if (!written) return reply(ctx.member.telegramId, `${row.reference} has gone. Nothing was changed.`);

    return reply(
      ctx.member.telegramId,
      [
        `${row.reference} is open again, at Under review.`,
        'The teacher has not been messaged. /reply tells them something.',
      ].join('\n'),
    );
  },
};

/**
 * `/note <ref> <text>` — internal, and no teacher ever sees it.
 *
 * Writes no status, and `addNote` deliberately does not touch the case row at
 * all. A note is not progress: if it moved `updated_at`, a case being discussed
 * internally would look freshly worked to `staleCases`, which is exactly the
 * case most worth surfacing.
 *
 * Allowed on a closed case. Something worth recording often turns up after the
 * fact, and a note is a record rather than an action.
 *
 * The body is checked here rather than left to `addNote`'s throw: an exception
 * from a command reaches `bot.catch`, which acknowledges the update and says
 * nothing — so the staff member would see silence and assume it worked.
 */
export const noteOnCase: StaffCommand = {
  name: '/note',
  capability: CAPABILITY.CASE_UPDATE,
  handle: async (ctx) => {
    const usage = '/note VISA-2026-00001 she is still waiting on the embassy';

    const resolved = await resolveCase(ctx, usage);
    if (!resolved.ok) return reply(ctx.member.telegramId, resolved.text);

    const { row, rest } = resolved;
    const body = rest.trim();
    if (body === '') return reply(ctx.member.telegramId, `What is the note?\n\n${usage}`);

    await addNote(ctx.db, row.reference, body, ctx.member.telegramId);
    const total = await countNotes(ctx.db, row.reference);

    return reply(
      ctx.member.telegramId,
      [
        `Noted on ${row.reference}. ${total} note${total === 1 ? '' : 's'} on this case.`,
        'No teacher ever sees these, and the case has not been touched — /reply is what tells them something.',
      ].join('\n'),
    );
  },
};

/**
 * `/assign <ref> <telegram id>` — give a case an owner. Implements R3.
 *
 * **Both checks happen before the write, and both are the point of the command.**
 *
 * `cases.owner` is a foreign key to `staff.telegram_id`. Assigning an id with no
 * staff row raises a constraint error, which propagates to `bot.catch` — and
 * `bot.catch` acknowledges the update and says nothing at all. The assigner sees
 * silence, reads it as success, and the case is owned by nobody.
 * `AdminCommands.gs:742-751` validated the same two things and recorded why:
 * cases were "routinely assigned to typos and to people who are not admins — the
 * case then looked handled and nobody was working it".
 *
 * The second check is the one a foreign key cannot make. An id can be real staff
 * and still be the wrong person: assigning a Visa case to somebody holding only
 * the Accommodation queue puts it in a name, out of `/cases unassigned`, and
 * invisible to the owner's own `/mycases`. That is worse than leaving it
 * unassigned, because an unassigned case is still on a list somebody reads.
 *
 * Writes an audit row (D18). "Who handed this case to whom" is an accountability
 * question, and `recordAudit` propagates its errors on purpose — an assignment
 * that cannot be recorded does not happen.
 */
export const assignCase: StaffCommand = {
  name: '/assign',
  capability: CAPABILITY.CASE_ASSIGN,
  handle: async (ctx) => {
    const usage = '/assign VISA-2026-00001 991001   — the owner’s Telegram id, from /staff';

    const resolved = await resolveCase(ctx, usage);
    if (!resolved.ok) return reply(ctx.member.telegramId, resolved.text);

    const { row, rest } = resolved;
    const assigneeId = rest.trim();
    if (assigneeId === '') {
      return reply(ctx.member.telegramId, `Who should own it?\n\n${usage}`);
    }

    /**
     * `findStaff` returns active rows only, so a deactivated member is refused
     * here without a second check. That matters: their cases would appear in
     * nobody's `/mycases`, because `casesOwnedBy` is asked by a person who can
     * no longer ask.
     */
    const assignee = await findStaff(ctx.db, assigneeId);
    if (assignee === null) {
      return reply(
        ctx.member.telegramId,
        [
          `${assigneeId} is not an active staff member, so the case has not been moved.`,
          '',
          'Check the id with /staff. A case assigned to a typo looks handled and is not.',
        ].join('\n'),
      );
    }

    if (row.owner === assignee.telegramId) {
      return reply(ctx.member.telegramId, `${row.reference} already belongs to ${describeStaff(assignee)}.`);
    }

    /**
     * Can the person receiving it actually see it? Asked by running the same
     * lookup under *their* scope, rather than by re-deriving the queue and
     * region rules here — one expression of visibility, as everywhere else.
     */
    const theirs = await findCase(ctx.db, scopeOf(assignee), row.reference);
    if (theirs === null) {
      return reply(
        ctx.member.telegramId,
        [
          `${describeStaff(assignee)} cannot see ${row.reference}, so it has not been moved.`,
          '',
          `Their queue is ${assignee.queue} and this case is ${row.category}.`,
          'Assigning it anyway would take it off the unassigned list and put it',
          'somewhere nobody is looking.',
        ].join('\n'),
      );
    }

    const written = await updateCase(
      ctx.db,
      row.reference,
      { owner: assignee.telegramId },
      ctx.member.telegramId,
    );
    if (!written) return reply(ctx.member.telegramId, `${row.reference} has gone. Nothing was changed.`);

    await recordAudit(ctx.db, {
      actor: ctx.member.telegramId,
      action: 'CASE_ASSIGNED',
      subject: row.reference,
      detail: { from: row.owner, to: assignee.telegramId },
    });

    const handover =
      row.owner === null
        ? `${row.reference} is now owned by ${describeStaff(assignee)}.`
        : `${row.reference} has moved from ${row.owner} to ${describeStaff(assignee)}.`;

    /**
     * The new owner is told, unless they are the person who typed the command —
     * assigning a case to yourself is the commonest use of this, and being
     * messaged about your own action is noise.
     */
    if (assignee.telegramId === ctx.member.telegramId) {
      return reply(ctx.member.telegramId, `${handover}\n\nIt is in your /mycases now.`);
    }

    return replyAndTell(
      ctx.member.telegramId,
      `${handover}\n\nThey have been told, and it is in their /mycases.`,
      [
        {
          chatId: assignee.telegramId,
          purpose: 'a notice that a case has been assigned to somebody',
          text: [
            `📋 ${row.reference} has been assigned to you`,
            '',
            `Category: ${row.category}`,
            `Status: ${row.status}`,
            `Given to you by: ${describeStaff(ctx.member)}`,
            '',
            `/case ${row.reference} — read it, including what the teacher wrote`,
          ].join('\n'),
        },
      ],
    );
  },
};

/** A staff member as another staff member should see them named. */
const describeStaff = (member: { telegramId: string; name: string | null }): string =>
  member.name === null ? member.telegramId : `${member.name} (${member.telegramId})`;

export const CASE_COMMANDS: readonly StaffCommand[] = [
  cases,
  myCases,
  urgent,
  oneCase,
  search,
  replyToTeacher,
  awaitTeacher,
  closeCase,
  reopenCase,
  noteOnCase,
  assignCase,
];
