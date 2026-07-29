/**
 * The status vocabulary, and reading one out of what a staff member typed.
 *
 * The vocabulary only — no database, no Telegram — exactly as `importance.ts` is
 * for the other axis. See `caseStatusEnum` in the schema for the eight values
 * and plan D25/D26 for which four a staff member ever types.
 */
import { CASE_STATUS_ORDER, OPEN_CASE_STATUSES, type CaseStatus } from '../db/schema.js';

export type { CaseStatus };
export { CASE_STATUS_ORDER };

/**
 * Read a status from what a staff member typed.
 *
 * Case-insensitive, because a status is read off a screen and typed back with
 * whatever capitalisation the phone supplied. The comparison is over the whole
 * remainder rather than its first word, which is the single reason
 * `ParsedCommand.rest` is a phrase: `handleListCases_` split arguments on
 * whitespace and compared the first word (`AdminCommands.gs:501`), which made
 * every two-word status — `Under review`, `Action required` — silently
 * unmatchable. The command worked, returned nothing, and looked like an empty
 * queue.
 *
 * Returns `null` rather than falling back to a default. `/cases Undr review`
 * must be refused with the list of statuses; a filter that quietly matched
 * everything, or nothing, is a staff member drawing a conclusion about a queue
 * from a question the bot never asked.
 */
export const parseCaseStatus = (value: string): CaseStatus | null => {
  const wanted = value.trim().toLowerCase();
  if (wanted === '') return null;
  return CASE_STATUS_ORDER.find((status) => status.toLowerCase() === wanted) ?? null;
};

/**
 * Statuses that end a case, and so stamp `closed_at`.
 *
 * Here rather than in `service.ts`, where it was, because it is vocabulary and
 * because it now has a second reader: stage 5's retention pass measures from
 * `closed_at`, and `closed_at` is exactly what these three statuses set (D28).
 * The pairing with `OPEN_CASE_STATUSES` is checked by a test that asserts the
 * two partition all eight — add a status without deciding which side it falls
 * on and a case could end up in neither list, invisible to `/cases` and
 * immortal to retention.
 */
export const CLOSED_CASE_STATUSES = [
  'Completed',
  'Closed',
  'Duplicate',
] as const satisfies readonly CaseStatus[];

/** Is this status one a case can still be worked from? */
export const isOpenStatus = (status: CaseStatus): boolean =>
  (OPEN_CASE_STATUSES as readonly CaseStatus[]).includes(status);

/** Does reaching this status end the case, and stamp `closed_at`? */
export const isClosedStatus = (status: CaseStatus): boolean =>
  (CLOSED_CASE_STATUSES as readonly CaseStatus[]).includes(status);

/**
 * The statuses named back to somebody who typed one that does not exist.
 *
 * All eight, not the four D25 says staff type. Somebody who typed a status
 * wrongly is reading one off a case, and the four they *write* are not the four
 * they *see* — refusing `/cases Duplicate` with a list that omits `Duplicate`
 * would be the bot denying the existence of a status it had just displayed.
 */
export const caseStatusList = (): string => CASE_STATUS_ORDER.join(', ');
