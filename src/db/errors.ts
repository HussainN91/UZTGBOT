/**
 * Reading what PostgreSQL actually said, through what drizzle wraps it in.
 *
 * Drizzle does not hand back the driver's error. It throws a `DrizzleQueryError`
 * carrying the real one on `cause`:
 *
 *   depth 0: DrizzleQueryError   code = undefined
 *   depth 1: DatabaseError       code = '23505'
 *
 * So `(err as { code?: string }).code === '23505'` — which is how both callers
 * of this module were written — reads `undefined` and **never fires**.
 *
 * Both were live faults, found on 31 July 2026 when the staff race test failed
 * for the second time. Neither had ever worked, and neither was visible:
 *
 *   `addStaff` looked correct because its pre-check catches the ordinary
 *   duplicate. Only a genuine race reaches the insert, and only then did the raw
 *   error escape — into `bot.catch`, which acknowledges the update and says
 *   nothing, so the staff member sees silence.
 *
 *   `issueUrgentCode`'s collision retry could not retry. At 32^6 a collision is
 *   vanishingly unlikely, so nothing has ever exercised it — the comment there
 *   already says being unlikely is not the same as being handled, which turned
 *   out to be truer than it was meant.
 *
 * The chain is walked rather than `cause` read once, because how many layers
 * drizzle adds is not something a caller should have to know, and it changed
 * once already without anybody noticing.
 */

/** PostgreSQL's `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** How far to walk before giving up. Two is the observed depth; five is slack. */
const MAX_DEPTH = 5;

export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e !== null && e !== undefined && depth < MAX_DEPTH; depth++) {
    if ((e as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
