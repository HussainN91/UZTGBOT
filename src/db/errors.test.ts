import { describe, expect, it } from 'vitest';
import { isUniqueViolation } from './errors.js';

/**
 * These are deterministic on purpose.
 *
 * The fault this module fixes was guarded only by a *race* test, which passed
 * most runs because the timing usually let a pre-check catch the duplicate
 * first. It failed twice in three days and was written off as intermittent both
 * times. Nothing here depends on timing, so a regression fails every run.
 *
 * The shape asserted below was measured against a real PostgreSQL on 31 July
 * 2026, not guessed:
 *
 *   depth 0: DrizzleQueryError   code = undefined
 *   depth 1: DatabaseError       code = '23505'
 */
describe('reading a unique violation through what drizzle wraps it in', () => {
  /** What drizzle actually throws: the driver's error hidden on `cause`. */
  const wrapped = (): Error => {
    const driver = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
    });
    return Object.assign(new Error('Failed query: insert into "staff" …'), { cause: driver });
  };

  it('finds the code on a wrapped error — the case that was broken', () => {
    expect(isUniqueViolation(wrapped())).toBe(true);
  });

  it('still finds it on a bare driver error', () => {
    expect(isUniqueViolation(Object.assign(new Error('dup'), { code: '23505' }))).toBe(true);
  });

  it('finds it however many layers get added later', () => {
    const deep = Object.assign(new Error('outer'), {
      cause: Object.assign(new Error('middle'), { cause: wrapped() }),
    });
    expect(isUniqueViolation(deep)).toBe(true);
  });

  /**
   * The half that matters as much: a foreign-key violation must NOT be reported
   * as a duplicate. `addStaff` would otherwise tell a staff member somebody
   * already exists when the real problem was something else entirely.
   */
  it('does not mistake another database error for a duplicate', () => {
    const fk = Object.assign(new Error('outer'), {
      cause: Object.assign(new Error('violates foreign key constraint'), { code: '23503' }),
    });
    expect(isUniqueViolation(fk)).toBe(false);
  });

  it('says no to an ordinary error with no code anywhere', () => {
    expect(isUniqueViolation(new Error('something else went wrong'))).toBe(false);
  });

  it('does not throw on null, undefined, or a thrown string', () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });

  it('terminates on a cause that points back at itself', () => {
    const loop: { cause?: unknown; code?: string } = {};
    loop.cause = loop;
    expect(isUniqueViolation(loop)).toBe(false);
  });
});
