/**
 * What one tap on a case means — the case half of Part 5H.3's pattern.
 *
 * **Nothing in this file decides anything.** Every acting tap is turned back
 * into the typed command it is equivalent to, and `index.ts` hands that to the
 * same dispatcher a typed command goes through. So `/close` remains the single
 * place that knows a finished case may not be closed twice, `/assign` the single
 * place that checks the new owner can see it, and `/snooze` the single place
 * that holds the cap. **A second copy of any of those is the thing this file
 * must not create**, and copying the staff menu is how it avoids one.
 *
 * It cannot call `routeStaffCommand` itself: `index.ts` already imports the
 * commands, so the call would be a cycle. The cycle was telling the truth — this
 * decides *what* should happen and the dispatcher does it.
 *
 * Nothing here touches the database. The keyboard is a pure function of the case
 * and the person looking at it, which is what lets it be tested without a
 * container, and it is the same rule `keyboards.ts` holds for the teacher side.
 */
import { IMPORTANCE_ORDER } from '../../cases/importance.js';
import { findCase, type StaffCaseRow } from '../../cases/queries.js';
import { isOpenStatus } from '../../cases/status.js';
import { SNOOZE_CHOICES, STAFF_BUTTON_CAP } from '../../config/constants.js';
import type { Database } from '../../db/index.js';
import { staffCovering } from '../../staff/recipients.js';
import { listStaff, type StaffRecord } from '../../staff/repository.js';
import { CAPABILITY, can } from '../../staff/roles.js';
import type { StaffScope } from '../../staff/visibility.js';
import { CALLBACK, callbackPartProblem, encodeCallback } from '../callback-data.js';
import type { InlineButton, InlineKeyboard, InlineKeyboardRow } from '../keyboards.js';
/**
 * Type-only, and pointing at the layer above — permitted, checked, and erased
 * at compile time. `staff.ts` carries the same note for the same reason.
 */
import type { RouterOutcome } from '../router.js';
import { reply } from './context.js';

/**
 * The actions a payload may name. Matched exactly; anything else lands on the
 * case itself, which is the safe landing everywhere in this file.
 *
 * Short codes rather than words, for `callback-data.ts`'s reason: the byte
 * budget is shared with a nineteen-character reference and the values that hang
 * off some of these are region-length strings we do not control.
 */
export const CASE_ACTION = {
  REOPEN: 'RO',
  OWNER: 'OWN',
  IMPORTANCE: 'M',
  SNOOZE: 'SN',
  REPLY: 'REP',
  AWAIT: 'AWT',
  NOTE: 'N',
  DUE: 'D',
  CLOSE: 'C',
} as const;

const forCase = (reference: string, action: string): string =>
  encodeCallback(CALLBACK.CASE_ACTION, reference, action);

/**
 * The way back, and it is `/mycases` rather than `/cases`: it is the list a
 * staff member arrives from most often and the only one that needs no argument.
 *
 * The empty first field is deliberate — `CA::MINE` names no case, which is
 * exactly what "take me back to the list" means, and it is what the resolver
 * reads as "no reference given".
 */
const backToMyCasesButton: InlineButton = {
  text: '⬅️ Back to my cases',
  callback_data: encodeCallback(CALLBACK.CASE_ACTION, '', 'MINE'),
};

/**
 * The buttons under one case.
 *
 * **Built from what the tapper holds, using the same function that does the
 * refusing.** `case.update` floors at Support and `case.assign` at Program, so a
 * Support member must not be shown "Give it an owner" — a button shown and then
 * refused is worse than no button, and Part 5G wrote that down as a constraint
 * before any of this was built. There is no second table of who-sees-what here;
 * `can` is asked directly, so the advertised keyboard and the enforced rule
 * cannot drift apart.
 *
 * The case's own state is the second filter. A snooze on a finished case
 * suppresses chasing that has nothing left to chase, and `/snooze` refuses one —
 * so it is not drawn. Importance is drawn on a finished case deliberately: D22
 * calls it a judgement made after reading, and retention reads the marker and
 * never the status.
 */
export function caseActionKeyboard(row: StaffCaseRow, member: StaffRecord): InlineKeyboard {
  const rows: InlineKeyboardRow[] = [];
  const open = isOpenStatus(row.status);
  const mayUpdate = can(member, CAPABILITY.CASE_UPDATE);

  if (mayUpdate && !open) {
    rows.push([{ text: '↩️ Reopen', callback_data: forCase(row.reference, CASE_ACTION.REOPEN) }]);
  }

  if (can(member, CAPABILITY.CASE_ASSIGN)) {
    rows.push([{ text: '👤 Give it an owner', callback_data: forCase(row.reference, CASE_ACTION.OWNER) }]);
  }

  if (can(member, CAPABILITY.CASE_MARK)) {
    rows.push([
      { text: '❗ How serious is it', callback_data: forCase(row.reference, CASE_ACTION.IMPORTANCE) },
    ]);
  }

  if (mayUpdate && open) {
    rows.push([{ text: '💬 Reply to teacher', callback_data: forCase(row.reference, CASE_ACTION.REPLY) }]);
    rows.push([{ text: '📥 Ask them for something', callback_data: forCase(row.reference, CASE_ACTION.AWAIT) }]);
    rows.push([{ text: '✅ Close it', callback_data: forCase(row.reference, CASE_ACTION.CLOSE) }]);
    rows.push([{ text: '📅 Promised by', callback_data: forCase(row.reference, CASE_ACTION.DUE) }]);
    rows.push([{ text: '😴 Snooze', callback_data: forCase(row.reference, CASE_ACTION.SNOOZE) }]);
  }

  /**
   * A note is allowed on a finished case, unlike everything else that writes.
   * Something worth recording often turns up after the fact, and a note is a
   * record rather than an action — `/note` already permits it.
   */
  if (mayUpdate) {
    rows.push([{ text: '📝 Add a note', callback_data: forCase(row.reference, CASE_ACTION.NOTE) }]);
  }

  rows.push([backToMyCasesButton]);
  return rows;
}

/**
 * What one tap should produce — either something to show, or a command to run.
 *
 * The same split as `StaffMenuStep`, and it exists for the same reason: this
 * module cannot call the dispatcher without a cycle, so it decides and the
 * dispatcher does. That also means an acting tap runs through exactly the
 * function a typed command runs through, rather than through something that
 * resembles it.
 */
export type CaseTextAction = 'reply' | 'await' | 'note' | 'due' | 'close' | 'close-unresolved';

export type CaseMenuStep =
  | { readonly kind: 'show'; readonly outcome: RouterOutcome }
  | { readonly kind: 'run'; readonly command: string }
  /**
   * Ask for the words, and remember what they are for.
   *
   * A third kind rather than a `show` that happens to save a state, because a
   * state written from inside a function that claims only to render is exactly
   * the kind of side effect nobody finds. `index.ts` writes it, where every
   * other write in this path happens.
   */
  | {
      readonly kind: 'ask';
      readonly outcome: RouterOutcome;
      readonly action: CaseTextAction;
      readonly reference: string;
    };

const show = (outcome: RouterOutcome): CaseMenuStep => ({ kind: 'show', outcome });
const run = (command: string): CaseMenuStep => ({ kind: 'run', command });
const ask = (outcome: RouterOutcome, action: CaseTextAction, reference: string): CaseMenuStep => ({
  kind: 'ask',
  outcome,
  action,
  reference,
});

/**
 * One tap, resolved.
 *
 * **The case is re-read on every tap**, never trusted from the payload beyond
 * being a reference to look up, and it is read through `findCase` under the
 * tapper's own scope — which is what applies the visibility rule. A menu sits in
 * a chat for ever and the person tapping may have moved queue since it was
 * drawn.
 *
 * Authorisation for the *action* is not done here. The dispatcher checks
 * `case.view` before calling, and `routeStaffCommand` checks the action's own
 * capability again when the command runs.
 */
export async function caseMenuView(
  db: Database,
  chatId: string,
  scope: StaffScope,
  parts: readonly string[],
): Promise<CaseMenuStep> {
  const [reference = '', action = '', value = ''] = parts;

  /**
   * No reference: the way back, which `backToMyCasesButton` builds as `CA::MINE`
   * — an empty first field. It is also where an unreadable or hand-crafted
   * payload lands, and a list is the right thing to show somebody whose button
   * meant nothing.
   */
  if (reference === '') return run('/mycases');

  const row = await findCase(db, scope, reference);
  if (row === null) {
    /**
     * "No such case" and "not yours" are the same answer, deliberately and
     * indistinguishably. The wording is `/case`'s own, so the two cannot drift
     * into telling a tapper apart from a reader.
     */
    return show(
      reply(
        chatId,
        `No case ${reference.toUpperCase()} that you can see. Check the reference, or /cases for what is open.`,
      ),
    );
  }

  // No action: the case itself. This is where every Back button leads.
  if (action === '') return run(`/case ${row.reference}`);

  if (action === CASE_ACTION.REOPEN) return run(`/reopen ${row.reference}`);

  const asking = promptFor(chatId, row, action, value);
  if (asking !== null) return asking;

  if (value === '') return show(await choicesFor(db, chatId, row, action));

  if (action === CASE_ACTION.IMPORTANCE) return run(`/mark ${row.reference} ${value}`);
  if (action === CASE_ACTION.OWNER) return run(`/assign ${row.reference} ${value}`);
  if (action === CASE_ACTION.SNOOZE) return run(`/snooze ${row.reference} ${value}`);

  // An action this build does not have: a hand-crafted payload, or a menu from
  // an older build. The case is the safe landing, as it is everywhere here.
  return run(`/case ${row.reference}`);
}

/**
 * The second level: which value, for an action that takes one.
 *
 * Every one of these ends in a payload naming the action **and** the value, so a
 * tap at this level is a complete instruction on its own — nothing is remembered
 * between the two taps and nothing can go stale between them.
 */
async function choicesFor(
  db: Database,
  chatId: string,
  row: StaffCaseRow,
  action: string,
): Promise<RouterOutcome> {
  if (action === CASE_ACTION.IMPORTANCE) {
    return reply(
      chatId,
      `How serious is ${row.reference}?\n\nIt is ${row.importance} now.`,
      choiceKeyboard(
        row.reference,
        CASE_ACTION.IMPORTANCE,
        IMPORTANCE_ORDER.map((level) => ({
          value: level,
          label: level === row.importance ? `✅ ${level}` : level,
        })),
      ),
    );
  }

  if (action === CASE_ACTION.SNOOZE) {
    return reply(
      chatId,
      [
        `Stop chasing ${row.reference} for how long?`,
        '',
        'It stays open, stays yours and stays at the same status.',
        'A snooze stops the chasing, not the work.',
      ].join('\n'),
      choiceKeyboard(row.reference, CASE_ACTION.SNOOZE, [
        ...SNOOZE_CHOICES.map((days) => ({ value: String(days), label: `${String(days)} days` })),
        { value: 'clear', label: 'Start chasing it again' },
      ]),
    );
  }

  if (action === CASE_ACTION.OWNER) return ownerChoices(db, chatId, row);

  return reply(chatId, `Nothing to choose for ${row.reference}.`, [[backToCaseButton(row.reference)]]);
}

const backToCaseButton = (reference: string): InlineButton => ({
  text: '⬅️ Back to the case',
  callback_data: encodeCallback(CALLBACK.CASE_ACTION, reference),
});

function choiceKeyboard(
  reference: string,
  action: string,
  choices: readonly { readonly value: string; readonly label: string }[],
): InlineKeyboard {
  const rows: InlineKeyboardRow[] = [];
  for (const choice of choices) {
    /**
     * A choice that will not fit is skipped rather than thrown — the rule
     * `staff.ts` applies to region names and `answerButtons` applies to FAQ
     * codes. Nothing here can reach it today, because every value is a constant
     * from this repository, and it is written anyway so that the first value
     * which comes from outside does not have to remember.
     */
    if (callbackPartProblem(CALLBACK.CASE_ACTION, choice.value) !== null) continue;
    rows.push([
      {
        text: choice.label,
        callback_data: encodeCallback(CALLBACK.CASE_ACTION, reference, action, choice.value),
      },
    ]);
  }
  rows.push([backToCaseButton(reference)]);
  return rows;
}

/**
 * Who could own this case.
 *
 * `staffCovering` already answers "which people may see this", is the inverse of
 * the visibility predicate, and holds the three rules that do not survive being
 * retyped — an empty `regions` means every region, a null region widens rather
 * than narrows, and System bypasses both axes. **No new query, and no second
 * expression of who covers what.**
 *
 * It is asked for `case.update` rather than `case.view`, so an Observer who can
 * read the case but change nothing is not offered as its owner. That makes this
 * list *narrower* than `/assign` would accept, never wider — and narrower is the
 * safe direction: the command re-checks every candidate through `findCase` under
 * their own scope, so a button can only ever offer somebody the command would
 * also allow.
 *
 * An empty list says so in `/case`'s own words rather than drawing an empty
 * keyboard. That sentence means a staffing gap, not an unclaimed queue, and it
 * is the same sentence `/case` prints against `Owner:`.
 */
async function ownerChoices(db: Database, chatId: string, row: StaffCaseRow): Promise<RouterOutcome> {
  const ids = await staffCovering(db, {
    capability: CAPABILITY.CASE_UPDATE,
    category: row.category,
    region: row.region,
  });

  const people = (await listStaff(db)).filter((m) => ids.includes(m.telegramId));

  if (people.length === 0) {
    return reply(
      chatId,
      [
        `Nobody can own ${row.reference} — no active staff member covers this queue and region.`,
        '',
        'That is a staffing gap rather than a queue. It stays on /cases unassigned until',
        'somebody covers it.',
      ].join('\n'),
      [[backToCaseButton(row.reference)]],
    );
  }

  return reply(
    chatId,
    `Who should own ${row.reference}?\n\n${row.owner === null ? 'Nobody owns it now.' : `${row.owner} owns it now.`}`,
    choiceKeyboard(
      row.reference,
      CASE_ACTION.OWNER,
      people.slice(0, STAFF_BUTTON_CAP).map((m) => ({
        value: m.telegramId,
        label: m.telegramId === row.owner ? `✅ ${m.name ?? m.telegramId}` : (m.name ?? m.telegramId),
      })),
    ),
  );
}

/**
 * The prompt for an action that carries words, or null if this action does not.
 *
 * Every prompt names the case, because by the time somebody comes back to it the
 * case itself has scrolled away — and a bot asking "what should I tell them?"
 * with no subject is a bot nobody trusts.
 *
 * Every prompt carries Cancel. The alternative is a staff member whose next
 * message goes somewhere they did not intend, and the thirty-minute expiry is a
 * backstop rather than an answer.
 */
function promptFor(
  chatId: string,
  row: StaffCaseRow,
  action: string,
  value: string,
): CaseMenuStep | null {
  const cancel: InlineKeyboard = [
    [{ text: '✖️ Cancel', callback_data: encodeCallback(CALLBACK.CASE_ACTION, row.reference) }],
  ];

  if (action === CASE_ACTION.REPLY) {
    return ask(
      reply(
        chatId,
        [
          `Writing a reply to the teacher on ${row.reference}.`,
          '',
          'Type it now. They will be sent exactly what you write, and can read it',
          'again in Check My Case.',
        ].join('\n'),
        cancel,
      ),
      'reply',
      row.reference,
    );
  }

  if (action === CASE_ACTION.AWAIT) {
    return ask(
      reply(
        chatId,
        [
          `What do you need from the teacher on ${row.reference}?`,
          '',
          'Type it now. The case is marked “Action required” and cannot move forward',
          'until they do it.',
        ].join('\n'),
        cancel,
      ),
      'await',
      row.reference,
    );
  }

  if (action === CASE_ACTION.NOTE) {
    return ask(
      reply(
        chatId,
        [
          `Writing a note on ${row.reference}.`,
          '',
          'Type it now. No teacher ever sees these, and the case is not touched — a',
          'note is a record rather than progress.',
        ].join('\n'),
        cancel,
      ),
      'note',
      row.reference,
    );
  }

  if (action === CASE_ACTION.DUE) {
    return ask(
      reply(
        chatId,
        [
          `When is ${row.reference} promised by?`,
          '',
          'Type a date — 2026-08-15, or 15 Aug 2026.',
          'Type “clear” to take the date off again.',
          '',
          'The teacher is not told. A date staff agree among themselves is not a',
          'promise to anybody until somebody makes it.',
        ].join('\n'),
        cancel,
      ),
      'due',
      row.reference,
    );
  }

  /**
   * Closing asks a question first. "We fixed it" and "we gave up" are the most
   * useful thing a later reader can know, and the two write different statuses,
   * send the teacher different things, and record the reason in different
   * places.
   */
  if (action === CASE_ACTION.CLOSE && value === '') {
    return {
      kind: 'show',
      outcome: reply(
        chatId,
        [
          `Closing ${row.reference}. Was it resolved?`,
          '',
          'Either way the teacher is told the case is closed.',
        ].join('\n'),
        [
          [
            {
              text: '✅ Yes — it was resolved',
              callback_data: encodeCallback(CALLBACK.CASE_ACTION, row.reference, CASE_ACTION.CLOSE, 'ok'),
            },
          ],
          [
            {
              text: '⚠️ No — closing it unresolved',
              callback_data: encodeCallback(CALLBACK.CASE_ACTION, row.reference, CASE_ACTION.CLOSE, 'no'),
            },
          ],
          ...cancel,
        ],
      ),
    };
  }

  if (action === CASE_ACTION.CLOSE && value === 'ok') {
    return ask(
      reply(
        chatId,
        [
          `Closing ${row.reference} as resolved.`,
          '',
          'What should I tell the teacher? They will be sent exactly what you write.',
        ].join('\n'),
        cancel,
      ),
      'close',
      row.reference,
    );
  }

  if (action === CASE_ACTION.CLOSE && value === 'no') {
    return ask(
      reply(
        chatId,
        [
          `Closing ${row.reference} without resolving it.`,
          '',
          'Why? This goes on the case as a note for whoever reads it later. The',
          'teacher is told the case is closed, not why.',
        ].join('\n'),
        cancel,
      ),
      'close-unresolved',
      row.reference,
    );
  }

  return null;
}

/**
 * The typed command a captured message is equivalent to.
 *
 * **This is the whole of what the writing states buy**, and it is deliberately
 * one small total function: every state maps to a command that already exists,
 * with the reference the state remembered and the words the staff member typed.
 * Nothing is parsed, nothing is validated, nothing is decided — `/reply` refuses
 * a finished case, `/due` refuses a date already gone, and `/close` writes the
 * note. They keep doing all of it.
 */
export function commandForCaseText(
  action: CaseTextAction,
  reference: string,
  text: string,
): string {
  switch (action) {
    case 'reply':
      return `/reply ${reference} ${text}`;
    case 'await':
      return `/await ${reference} ${text}`;
    case 'note':
      return `/note ${reference} ${text}`;
    case 'due':
      return `/due ${reference} ${text}`;
    case 'close':
      return `/close ${reference} ${text}`;
    case 'close-unresolved':
      return `/close ${reference} unresolved ${text}`;
  }
}
