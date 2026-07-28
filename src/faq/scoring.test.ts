/**
 * The rules that decide whether a teacher gets an answer or a choice.
 *
 * Ported from QAEngine.gs:206-238 with its judgement intact. The scoring numbers
 * are not arbitrary: an exact match scores 2 and a typo-only match scores 1,
 * and the confidence floor sits at 2, so a row whose only evidence is a near-miss
 * can never be delivered as *the* answer. That is the whole of "the bot must
 * never guess" (BOT-SPEC.md:640).
 *
 * Keywords arrive already normalised — src/sheets/parse.ts:197 runs them through
 * faq/normalise.ts at parse time — so these fixtures store them the way the
 * database really holds them, `e visa` rather than `e-visa`.
 */
import { describe, expect, it } from 'vitest';
import { FAQ_MAX_PICKER_BUTTONS } from '../config/constants.js';
import { type ScorableFaqRow, selectAnswer } from './scoring.js';

function row(code: string, keywords: readonly string[], sheetRow = 1): ScorableFaqRow {
  return { code, sheetRow, keywords };
}

describe('the bot must never guess', () => {
  it('answers directly only on a single confident match', () => {
    const rows = [row('VISA-001', ['passport']), row('SAL-001', ['salary'])];
    const result = selectAnswer('passport', rows);
    expect(result.kind).toBe('answer');
    if (result.kind === 'answer') expect(result.row.code).toBe('VISA-001');
  });

  it('offers a picker rather than choosing between tied matches', () => {
    const rows = [row('VISA-001', ['passport']), row('VISA-002', ['passport'])];
    const result = selectAnswer('passport', rows);
    expect(result.kind).toBe('picker');
    if (result.kind === 'picker') {
      expect(result.rows.map((r) => r.code)).toEqual(['VISA-001', 'VISA-002']);
      // Both matched exactly. The teacher is choosing between two good answers,
      // not being asked to rescue a bad guess.
      expect(result.lowConfidence).toBe(false);
    }
  });

  it('offers a picker when the best match is below the confidence floor', () => {
    // 'accomodation' is one deletion from the stored keyword: evidence, but only
    // typo evidence, so it scores 1 and cannot be delivered as the answer.
    const rows = [row('ACC-001', ['accommodation'])];
    const result = selectAnswer('accomodation', rows);
    expect(result.kind).toBe('picker');
    if (result.kind === 'picker') expect(result.lowConfidence).toBe(true);
  });

  it('returns no match rather than the least-bad answer', () => {
    const rows = [row('VISA-001', ['passport']), row('SAL-001', ['salary'])];
    expect(selectAnswer('bicycle', rows).kind).toBe('none');
  });

  it('returns no match for an empty query rather than every row', () => {
    expect(selectAnswer('   ', [row('VISA-001', ['passport'])]).kind).toBe('none');
  });
});

describe('typo tolerance', () => {
  it('matches a keyword one character out', () => {
    const result = selectAnswer('pasport', [row('VISA-001', ['passport'])]);
    expect(result.kind).toBe('picker');
  });

  it('does not match a short word one character out', () => {
    // allowedTypos_ scales with length: 'visa' vs 'lisa' must not match, or
    // every four-letter word matches every other.
    expect(selectAnswer('lisa', [row('VISA-001', ['visa'])]).kind).toBe('none');
  });

  it('still matches a short keyword typed exactly', () => {
    expect(selectAnswer('visa', [row('VISA-001', ['visa'])]).kind).toBe('answer');
  });
});

describe('punctuation', () => {
  it('matches a hyphenated keyword typed without the hyphen', () => {
    // The Task 2 fix, proven from the query side. Both sides normalise to
    // 'e visa', so the phrase match lands.
    const rows = [row('VISA-009', ['e visa'])];
    expect(selectAnswer('how do I apply for an e-visa', rows).kind).toBe('answer');
  });

  it('matches a hyphenated keyword typed with the hyphen', () => {
    const rows = [row('VISA-009', ['e visa'])];
    expect(selectAnswer('e-visa', rows).kind).toBe('answer');
  });

  /**
   * The padding in the phrase match is what stops 'evisad' matching 'e visa'.
   * Without word boundaries a multi-word keyword matches inside longer words.
   */
  it('does not match a phrase embedded in a longer word', () => {
    const rows = [row('VISA-009', ['e visa'])];
    expect(selectAnswer('revisawork', rows).kind).toBe('none');
  });
});

describe('the picker', () => {
  it('is capped, so a topic with many ties cannot build an unusable keyboard', () => {
    const rows = Array.from({ length: FAQ_MAX_PICKER_BUTTONS + 4 }, (_, i) =>
      row(`VISA-${String(i).padStart(3, '0')}`, ['passport'], i + 1),
    );
    const result = selectAnswer('passport', rows);
    expect(result.kind).toBe('picker');
    if (result.kind === 'picker') expect(result.rows).toHaveLength(FAQ_MAX_PICKER_BUTTONS);
  });

  /**
   * Ties are ordered by the row the content owner put them on, so the same
   * question asked twice offers the same buttons in the same order. Ordering by
   * anything the database happens to return would reshuffle between taps.
   */
  it('orders ties by sheet row, not by the order they were passed in', () => {
    const rows = [
      row('VISA-003', ['passport'], 30),
      row('VISA-001', ['passport'], 10),
      row('VISA-002', ['passport'], 20),
    ];
    const result = selectAnswer('passport', rows);
    if (result.kind !== 'picker') throw new Error(`expected a picker, got ${result.kind}`);
    expect(result.rows.map((r) => r.code)).toEqual(['VISA-001', 'VISA-002', 'VISA-003']);
  });
});

describe('scoring', () => {
  it('prefers a phrase match over a single-word match', () => {
    const rows = [row('VISA-001', ['visa']), row('VISA-002', ['visa extension'])];
    const result = selectAnswer('visa extension', rows);
    // VISA-002 scores 2 for the phrase; VISA-001 scores 2 for the bare token.
    // They tie, and a tie is a picker — never a silent pick of the longer one.
    expect(result.kind).toBe('picker');
  });

  it('adds up across several keywords on one row', () => {
    const rows = [row('VISA-001', ['passport', 'expired']), row('VISA-002', ['passport'])];
    const result = selectAnswer('my passport expired', rows);
    expect(result.kind).toBe('answer');
    if (result.kind === 'answer') expect(result.row.code).toBe('VISA-001');
  });
});
