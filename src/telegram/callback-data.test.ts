import { describe, expect, it } from 'vitest';
import { CALLBACK_DATA_MAX_BYTES, CASE_TOPIC_CHOICES, FAQ_TOPICS } from '../config/constants.js';
import {
  CALLBACK,
  CallbackDataTooLongError,
  byteLength,
  decodeCallback,
  encodeCallback,
  isCallback,
} from './callback-data.js';

describe('callback data stays inside Telegram’s 64-byte limit', () => {
  /**
   * The measurement that matters. An outside review claimed buttons would break
   * the limit; the arithmetic was wrong, but the limit is still real and the
   * only way to keep knowing that is to assert it against the actual values the
   * bot emits, for every topic, rather than against an estimate.
   */
  it('every topic button the bot can emit fits, with room to spare', () => {
    const emitted: string[] = [];
    for (const topic of FAQ_TOPICS) {
      emitted.push(encodeCallback(CALLBACK.TOPIC, topic.code));
      emitted.push(encodeCallback(CALLBACK.TOPIC_PAGE, topic.code, '99'));
      emitted.push(encodeCallback(CALLBACK.QUERY_TOPIC, topic.code));
    }
    /**
     * Only the five filing options, not all eleven FAQ topics. A case cannot be
     * opened against "Living in Uzbekistan" — there is no queue behind it — and
     * a test asserting a wider surface than the design allows is a test that
     * will not notice the design breaking.
     */
    for (const choice of CASE_TOPIC_CHOICES) {
      emitted.push(encodeCallback(CALLBACK.CASE_TOPIC, choice.key));
    }
    // FAQ answer codes come from the answer bank: three letters, dash, three digits.
    emitted.push(encodeCallback(CALLBACK.ANSWER, 'PLACEMENT-999'));
    emitted.push(encodeCallback(CALLBACK.ANSWER_UNHELPFUL, 'PLACEMENT-999'));
    emitted.push(encodeCallback(CALLBACK.ANSWER_HELPFUL, 'PLACEMENT-999'));
    emitted.push(encodeCallback(CALLBACK.DOC_TYPE, 'REIMBURSEMENT'));

    const worst = emitted.reduce((a, b) => (byteLength(a) >= byteLength(b) ? a : b));
    expect(byteLength(worst)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
    // Fails loudly if a future code creeps toward the ceiling rather than over it.
    expect(byteLength(worst)).toBeLessThanOrEqual(32);
  });

  it('payload size does not depend on the language shown on the button', () => {
    // The whole point of Chain 4. A topic's label may be translated into Russian
    // or Uzbek, where Cyrillic costs two bytes a character; the payload must not
    // move at all, because it carries the code and never the label.
    const english = encodeCallback(CALLBACK.TOPIC, 'LIVING');
    expect(byteLength(english)).toBe(byteLength('CAT:LIVING'));

    // For contrast: the Apps Script approach put the display label in the payload.
    const asAppsScriptDidIt = `CAT:${'Проживание в Узбекистане'}`;
    expect(byteLength(asAppsScriptDidIt)).toBeGreaterThan(byteLength(english));
  });

  it('refuses to build an oversized payload rather than letting Telegram truncate it', () => {
    expect(() => encodeCallback(CALLBACK.ANSWER, 'X'.repeat(80))).toThrow(CallbackDataTooLongError);
  });

  it('counts bytes, not characters', () => {
    expect(byteLength('abc')).toBe(3);
    expect(byteLength('При')).toBe(6);
    expect(byteLength('🛂')).toBe(4);
  });

  it('rejects a part containing the separator instead of decoding it wrongly later', () => {
    expect(() => encodeCallback(CALLBACK.TOPIC, 'A:B')).toThrow(/field separator/);
  });
});

describe('decoding untrusted callback data', () => {
  it('round-trips what it encodes', () => {
    const data = encodeCallback(CALLBACK.TOPIC_PAGE, 'LIVING', '3');
    expect(decodeCallback(data)).toEqual({ prefix: 'PG', parts: ['LIVING', '3'] });
  });

  it('returns null for empty input rather than throwing at the router', () => {
    expect(decodeCallback('')).toBeNull();
  });

  it('never resolves inherited object properties from a hand-crafted payload', () => {
    // 'DOC:constructor' hit a real bug in the Apps Script version: a bare lookup
    // resolved Object.prototype.constructor, returned something truthy, and the
    // resulting throw was swallowed so the button silently did nothing.
    const decoded = decodeCallback('DOC:constructor');
    expect(decoded).toEqual({ prefix: 'DOC', parts: ['constructor'] });
    // Callers must validate against a known list; decoding alone grants nothing.
    expect(isCallback('DOC:constructor', CALLBACK.DOC_TYPE, 'PASSPORT')).toBe(false);
  });

  it('does not match when extra fields are appended', () => {
    expect(isCallback('MENU:FAQ:EXTRA', CALLBACK.MENU, 'FAQ')).toBe(false);
    expect(isCallback('MENU:FAQ', CALLBACK.MENU, 'FAQ')).toBe(true);
  });
});
