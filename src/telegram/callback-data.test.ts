import { describe, expect, it } from 'vitest';
import {
  CALLBACK_DATA_MAX_BYTES,
  CASE_REFERENCE_PREFIX,
  CASE_TOPIC_CHOICES,
  FAQ_TOPICS,
} from '../config/constants.js';
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
    /**
     * The region check carries no parts at all — deliberately, because a payload
     * naming a region would make it a picker, and a menu of regions is a menu of
     * whose problem an emergency becomes. Asserted here so that anybody who later
     * adds a part is measured rather than trusted.
     */
    emitted.push(encodeCallback(CALLBACK.REGION_CONFIRMED));
    emitted.push(encodeCallback(CALLBACK.REGION_MOVED));

    const worst = emitted.reduce((a, b) => (byteLength(a) >= byteLength(b) ? a : b));
    expect(byteLength(worst)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
    // Fails loudly if a future code creeps toward the ceiling rather than over it.
    expect(byteLength(worst)).toBeLessThanOrEqual(32);
  });

  /**
   * The confirm-urgent button, measured on its own because it is the first
   * payload that carries a **case reference** rather than a fixed code.
   *
   * A reference is generated, not chosen from a list, so it is the one part of
   * the callback surface whose length is decided by a `CASE_REFERENCE_PREFIX`
   * somebody could lengthen later without ever looking at this file. The
   * arithmetic is asserted against the longest prefix the map actually holds,
   * built the way `allocateReference` builds it.
   */
  it('the confirm-urgent button fits with the longest reference this bot can build', () => {
    const longest = Object.values(CASE_REFERENCE_PREFIX).reduce((a, b) =>
      a.length >= b.length ? a : b,
    );
    const reference = `${longest}-2026-99999`;

    const emitted = encodeCallback(CALLBACK.URGENT_CONFIRM, reference);

    expect(byteLength(emitted)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
    expect(byteLength(emitted)).toBeLessThanOrEqual(32);
    // A reference has no colon in it, which is what lets it travel as one part.
    expect(reference).not.toContain(':');
  });

  /**
   * The three dispute buttons — Feature A.
   *
   * Measured against a `bigserial` at the largest value JavaScript can hold
   * exactly and a fifteen-digit Telegram chat id, because neither is chosen from
   * a list: one is allocated by the database and the other is handed to us by
   * Telegram, so both grow without anybody editing this repository. That is the
   * same reason the confirm-urgent test above measures a generated reference
   * rather than a fixed code.
   */
  it('the dispute buttons fit with the largest id and chat id either can carry', () => {
    const hugeId = String(Number.MAX_SAFE_INTEGER);
    const longChatId = '999999999999999';

    const claim = encodeCallback(CALLBACK.DISPUTE_CLAIM, hugeId, 'NotMine');
    const escalate = encodeCallback(CALLBACK.DISPUTE_ESCALATE, hugeId);
    const resolve = encodeCallback(CALLBACK.DISPUTE_RESOLVE, hugeId, longChatId);

    for (const emitted of [claim, escalate, resolve]) {
      expect(byteLength(emitted)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
      expect(byteLength(emitted)).toBeLessThanOrEqual(40);
    }
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

describe('the case action prefix', () => {
  /**
   * `CONTRACT-2026-99999` is the longest reference this system can build: the
   * longest category name, a four-digit year and a five-digit sequence. Measured
   * with a real value rather than trusted to arithmetic.
   */
  const LONGEST_REFERENCE = 'CONTRACT-2026-99999';

  it('fits the longest importance payload inside the limit', () => {
    const data = encodeCallback(CALLBACK.CASE_ACTION, LONGEST_REFERENCE, 'M', 'Critical');
    expect(byteLength(data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
  });

  it('fits the longest owner payload inside the limit', () => {
    // Telegram ids are at most ten digits today; a spare digit costs nothing.
    const data = encodeCallback(CALLBACK.CASE_ACTION, LONGEST_REFERENCE, 'OWN', '99999999999');
    expect(byteLength(data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
  });

  it('fits the longest snooze payload inside the limit', () => {
    const data = encodeCallback(CALLBACK.CASE_ACTION, LONGEST_REFERENCE, 'SN', '30');
    expect(byteLength(data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
  });
});
