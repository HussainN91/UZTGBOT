/**
 * These are guards against a category or a filing option being added later
 * without the things that make it work. Every failure mode here is silent in
 * production: a case filed as CASE-2026-0001, a button that routes nowhere, a
 * picker that Telegram rejects. None of them raise an error at the time.
 */
import { describe, expect, it } from 'vitest';
import {
  CASE_CATEGORY,
  CASE_REFERENCE_PREFIX,
  CASE_TOPIC_CHOICES,
  FAQ_CONFIDENT_SCORE,
  FAQ_MATCH_MIN_SCORE,
  caseTopicByKey,
} from './constants.js';

describe('case reference prefixes', () => {
  it('maps every case category to a reference prefix', () => {
    for (const category of Object.values(CASE_CATEGORY)) {
      expect(CASE_REFERENCE_PREFIX[category]).toMatch(/^[A-Z]+$/);
    }
  });

  /**
   * Two categories sharing a prefix would interleave their numbering, so
   * VISA-2026-0002 could follow VISA-2026-0001 in a different category. The
   * reference is what a teacher quotes on the phone; it has to identify one case.
   */
  it('gives each category a distinct prefix', () => {
    const prefixes = Object.values(CASE_REFERENCE_PREFIX);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});

describe('the categories a teacher can file under', () => {
  it('offers only categories that exist', () => {
    const known = new Set<string>(Object.values(CASE_CATEGORY));
    for (const choice of CASE_TOPIC_CHOICES) {
      expect(known.has(choice.category)).toBe(true);
    }
  });

  /**
   * The key travels in callback data, where ":" is the field separator —
   * encodeCallback rejects a part containing it. Catching that here names the
   * offending choice instead of failing inside a keyboard builder at run time.
   */
  it('uses keys that are safe to put in callback data', () => {
    for (const choice of CASE_TOPIC_CHOICES) {
      expect(choice.key).toMatch(/^[A-Z_]+$/);
    }
  });

  it('resolves a known key and refuses an unknown one', () => {
    expect(caseTopicByKey('VISA')?.category).toBe(CASE_CATEGORY.VISA);
    expect(caseTopicByKey('SALARY')).toBeNull();
  });

  /**
   * "Something else" is the general fallback, and it must land on Contact
   * Support — that is the category with a queue behind it. Pointing it anywhere
   * else routes those cases to nobody.
   */
  it('routes the general fallback to Contact Support', () => {
    expect(caseTopicByKey('OTHER')?.category).toBe(CASE_CATEGORY.CONTACT_SUPPORT);
  });
});

/**
 * If the confidence floor ever dropped to the match floor, every single weak
 * match would be sent as a definitive answer — which is precisely the behaviour
 * "the bot must never guess" forbids.
 */
it('keeps the confidence floor above the match floor', () => {
  expect(FAQ_CONFIDENT_SCORE).toBeGreaterThan(FAQ_MATCH_MIN_SCORE);
});
