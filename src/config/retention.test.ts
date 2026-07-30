/**
 * The two rules that decide whether records are deleted and whether 1,800
 * people are asked to read something again.
 *
 * Pure, and tested with numbers rather than a database, because both rules have
 * to be readable by somebody checking them against a promise made to teachers.
 */
import { describe, expect, it } from 'vitest';
import {
  type RetentionPeriods,
  isLongerThan,
  parsePeriod,
  parsePeriodsField,
  renderPeriodsField,
  requiresReconsent,
} from './retention.js';

const PERIODS: RetentionPeriods = { caseDays: 7, urgentCaseDays: 180, messageDays: 3 };
const INDEFINITE: RetentionPeriods = { caseDays: null, urgentCaseDays: null, messageDays: null };

describe('parsePeriod', () => {
  it('treats every unusable value as delete-nothing', () => {
    /**
     * Plan D30. The dangerous one is '0': read as a number it means "delete
     * everything that has ended", it is one keystroke away from a typo, and
     * there is no undo. Every other reading of an unusable value is the same
     * kind of guess, so they all land in the same place.
     */
    for (const raw of [null, '', '   ', 'abc', '0', '-7', '7.5', '7 days', '1e3']) {
      expect(parsePeriod(raw)).toBeNull();
    }
  });

  it('reads a plain number of days, with whatever spacing somebody typed', () => {
    expect(parsePeriod('7')).toBe(7);
    expect(parsePeriod(' 180 ')).toBe(180);
    expect(parsePeriod('1')).toBe(1);
  });

  it('refuses a number too large to be a real period', () => {
    // Not pedantry: an interval PostgreSQL cannot build throws inside the
    // nightly job, and a retention job that throws deletes nothing while
    // looking like it ran.
    expect(parsePeriod('99999999999999999999')).toBeNull();
  });
});

describe('isLongerThan', () => {
  it('treats null as the longest period there is', () => {
    // "Kept until the Ministry sets a period" is indefinite retention, and
    // indefinite is longer than any number of days.
    expect(isLongerThan(null, 180)).toBe(true);
    expect(isLongerThan(180, null)).toBe(false);
    expect(isLongerThan(null, null)).toBe(false);
  });

  it('compares two numbers the obvious way', () => {
    expect(isLongerThan(30, 7)).toBe(true);
    expect(isLongerThan(7, 30)).toBe(false);
    expect(isLongerThan(7, 7)).toBe(false);
  });
});

describe('requiresReconsent', () => {
  it('asks again when the wording changes', () => {
    expect(
      requiresReconsent(
        { version: '2026-07-28.1', periods: PERIODS },
        { version: '2026-07-30.1', periods: PERIODS },
      ),
    ).toBe(true);
  });

  it('asks again when any period is lengthened', () => {
    for (const longer of [
      { ...PERIODS, caseDays: 30 },
      { ...PERIODS, urgentCaseDays: 365 },
      { ...PERIODS, messageDays: 90 },
    ]) {
      expect(
        requiresReconsent({ version: 'v1', periods: PERIODS }, { version: 'v1', periods: longer }),
      ).toBe(true);
    }
  });

  it('does NOT ask again when a period is shortened', () => {
    /**
     * Plan D28, and the reason a hash of the notice text cannot do this job.
     * Deleting sooner than promised breaks no commitment to anybody, and
     * marching 1,800 people through a re-consent to be told their data goes
     * sooner is a cost with no beneficiary. Any digest of the whole notice
     * changes in both directions.
     */
    for (const shorter of [
      { ...PERIODS, caseDays: 1 },
      { ...PERIODS, urgentCaseDays: 90 },
      { ...PERIODS, messageDays: 1 },
    ]) {
      expect(
        requiresReconsent({ version: 'v1', periods: PERIODS }, { version: 'v1', periods: shorter }),
      ).toBe(false);
    }
  });

  it('does not ask again when nothing has moved at all', () => {
    expect(
      requiresReconsent({ version: 'v1', periods: PERIODS }, { version: 'v1', periods: PERIODS }),
    ).toBe(false);
  });

  it('treats an acceptance made under indefinite retention as the longest', () => {
    /**
     * Every teacher bound before stage 5 is in exactly this position: the notice
     * they read says the period is not yet set. Giving them 7 days is therefore
     * a *shortening*, and it is the wording bump — not the periods — that asks
     * them to read the notice again.
     */
    expect(
      requiresReconsent({ version: 'v1', periods: INDEFINITE }, { version: 'v1', periods: PERIODS }),
    ).toBe(false);
  });

  it('asks again when a period is turned off, because off is for ever', () => {
    // The other direction of the same rule: clearing CASE_RETENTION_DAYS stops
    // deletion entirely, which is keeping data longer than teachers were told.
    expect(
      requiresReconsent({ version: 'v1', periods: PERIODS }, { version: 'v1', periods: INDEFINITE }),
    ).toBe(true);
  });

  it('asks again when nothing was ever recorded', () => {
    // Teachers bound before the columns existed genuinely have no recorded
    // acceptance, and inventing one for them is worse than admitting it.
    expect(requiresReconsent(null, { version: 'v1', periods: PERIODS })).toBe(true);
  });

  it('asks again when the wording changed even though every period shortened', () => {
    // The two halves are independent and either one is sufficient. This is the
    // case that actually ships in stage 5.
    expect(
      requiresReconsent(
        { version: '2026-07-28.1', periods: INDEFINITE },
        { version: '2026-07-30.1', periods: PERIODS },
      ),
    ).toBe(true);
  });
});

/**
 * The periods as they travel inside a button.
 *
 * Round-tripped rather than checked one way, because the two halves are only
 * useful together: the notice a teacher was shown and the acceptance recorded
 * when they tap are matched by comparing what came back against what is current
 * (R20), and a render that does not parse back would silently show every teacher
 * the notice twice.
 */
describe('the periods field carried in a callback payload', () => {
  it('round-trips real values', () => {
    expect(parsePeriodsField(renderPeriodsField(PERIODS))).toEqual(PERIODS);
  });

  it('round-trips “kept indefinitely”, which is a value and not an absence', () => {
    expect(renderPeriodsField(INDEFINITE)).toBe('x-x-x');
    expect(parsePeriodsField('x-x-x')).toEqual(INDEFINITE);
  });

  it('round-trips a mixture, which is the likeliest real misconfiguration', () => {
    const mixed: RetentionPeriods = { caseDays: 7, urgentCaseDays: null, messageDays: 3 };
    expect(parsePeriodsField(renderPeriodsField(mixed))).toEqual(mixed);
  });

  it('refuses anything malformed rather than part-reading it', () => {
    // The payload arrives from the network and anybody can hand-craft one. The
    // caller's answer to null is to show the notice again, which is always safe;
    // a half-read set of periods would record an acceptance nobody gave.
    for (const raw of ['', '7-180', '7-180-3-4', '7--3', 'a-b-c', '7-180-0', '-7-180-3']) {
      expect(parsePeriodsField(raw)).toBeNull();
    }
  });
});
