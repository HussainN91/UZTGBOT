/**
 * How serious a case is, as a person judged it.
 *
 * The vocabulary only — no database, no Telegram. See `caseImportanceEnum` in
 * the schema for why this is a separate axis from `status`, and plan D22 for the
 * decision. The short version: status moves, and a resolved emergency becomes
 * `Completed`, taking every trace of its having been an emergency with it.
 */
import { CASE_IMPORTANCE_ORDER, type CaseImportance } from '../db/schema.js';

export type { CaseImportance };

/**
 * Read a level from what a staff member typed.
 *
 * Returns `null` rather than defaulting to `Normal` on an unrecognised word.
 * `/mark VISA-2026-00001 hihg` must be refused with the list of levels: a
 * command that appeared to work and quietly marked nothing is the failure this
 * column exists to prevent, and the staff member would have no reason to look
 * again.
 */
export const parseImportance = (value: string): CaseImportance | null => {
  const wanted = value.trim().toLowerCase();
  return CASE_IMPORTANCE_ORDER.find((level) => level.toLowerCase() === wanted) ?? null;
};

/**
 * The levels, for a message offering them.
 *
 * Rendered from the same list the parser reads, so a level added to the enum
 * appears in the refusal that names them without anybody remembering to add it.
 * The case vocabulary was written out three times before `status.ts` collapsed
 * it into one list, and this is the same list one type along.
 */
export const importanceList = (): string => CASE_IMPORTANCE_ORDER.join(', ');

/** Where a level sits. Higher index is more serious. */
const rankOf = (level: CaseImportance): number => CASE_IMPORTANCE_ORDER.indexOf(level);

/**
 * Is `level` at least as serious as `floor`?
 *
 * Exists for one path in particular. When an emergency arrives for a teacher who
 * already has an open case the two are merged, and the merge must raise the
 * marker and never lower it — an urgent follow-up landing on a case somebody has
 * already judged critical must not demote it. That is the common path, not the
 * exception (R13).
 */
export const atLeastImportance = (level: CaseImportance, floor: CaseImportance): boolean =>
  rankOf(level) >= rankOf(floor);

/**
 * Does the long retention period apply to this case?
 *
 * The single expression of "six months for urgent and critical". Stage 5's
 * clean-up job reads this and nothing else; a job reading `status` instead would
 * delete precisely the cases the rule exists to keep.
 *
 * Written as "not Normal" rather than as a list of the two kept levels, so a
 * fourth level added later is retained by default. That is the safe direction to
 * fail: keeping a record too long is a conversation, deleting one is not.
 */
export const isRetained = (level: CaseImportance): boolean => level !== 'Normal';
