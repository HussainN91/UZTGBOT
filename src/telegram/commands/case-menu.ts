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
import type { StaffCaseRow } from '../../cases/queries.js';
import { isOpenStatus } from '../../cases/status.js';
import type { StaffRecord } from '../../staff/repository.js';
import { CAPABILITY, can } from '../../staff/roles.js';
import { CALLBACK, encodeCallback } from '../callback-data.js';
import type { InlineButton, InlineKeyboard, InlineKeyboardRow } from '../keyboards.js';

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
    rows.push([{ text: '😴 Snooze', callback_data: forCase(row.reference, CASE_ACTION.SNOOZE) }]);
  }

  rows.push([backToMyCasesButton]);
  return rows;
}
