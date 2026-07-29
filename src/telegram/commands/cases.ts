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
import { countNotes, recentNotes, type CaseNote } from '../../cases/notes.js';
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
import { caseStatusList, parseCaseStatus } from '../../cases/status.js';
import { CAPABILITY } from '../../staff/roles.js';
import {
  type StaffCommand,
  ageInDays,
  formatTashkent,
  reply,
} from './context.js';

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

export const CASE_COMMANDS: readonly StaffCommand[] = [cases, myCases, urgent, oneCase, search];
