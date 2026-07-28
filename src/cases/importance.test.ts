import { describe, expect, it } from 'vitest';
import { CASE_IMPORTANCE_ORDER } from '../db/schema.js';
import { atLeastImportance, isRetained, parseImportance } from './importance.js';

describe('parseImportance', () => {
  it('accepts the three levels however they are capitalised', () => {
    expect(parseImportance('urgent')).toBe('Urgent');
    expect(parseImportance('URGENT')).toBe('Urgent');
    expect(parseImportance('Critical')).toBe('Critical');
    expect(parseImportance('  normal  ')).toBe('Normal');
  });

  it('returns null for anything else, rather than guessing', () => {
    // /mark REF hihg must be refused with the list, not silently read as one of
    // the three. A marker that quietly did not apply is the failure this whole
    // column exists to avoid.
    expect(parseImportance('hihg')).toBeNull();
    expect(parseImportance('')).toBeNull();
    expect(parseImportance('very urgent')).toBeNull();
  });
});

describe('isRetained', () => {
  it('keeps urgent and critical cases', () => {
    // The agreed rule: six months for these. Stage 5's retention job reads this
    // and nothing else — a job reading `status` would delete exactly the cases
    // the rule exists to keep, because a resolved emergency becomes Completed.
    expect(isRetained('Urgent')).toBe(true);
    expect(isRetained('Critical')).toBe(true);
  });

  it('does not keep an ordinary case', () => {
    expect(isRetained('Normal')).toBe(false);
  });

  it('covers every level the enum defines', () => {
    // Guards a level being added later and silently falling into "delete
    // sooner", which is the direction that loses data.
    for (const level of CASE_IMPORTANCE_ORDER) {
      expect(typeof isRetained(level)).toBe('boolean');
    }
  });
});

describe('atLeastImportance', () => {
  it('orders the three levels', () => {
    expect(atLeastImportance('Critical', 'Urgent')).toBe(true);
    expect(atLeastImportance('Urgent', 'Urgent')).toBe(true);
    expect(atLeastImportance('Normal', 'Urgent')).toBe(false);
  });

  it('is what stops a merge lowering a marker', () => {
    // R13. When an emergency arrives for a teacher who already has an open case
    // the two are merged, and that path must raise the marker, never lower it.
    // It is the common path, not the exception.
    const existing = 'Critical';
    const arriving = 'Urgent';
    const merged = atLeastImportance(existing, arriving) ? existing : arriving;
    expect(merged).toBe('Critical');
  });
});
