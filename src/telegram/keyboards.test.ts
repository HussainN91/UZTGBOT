/**
 * One module builds every keyboard, so the 64-byte ceiling is enforced in one
 * place. `QAEngine.gs:411` had to re-check the limit manually in a second place
 * precisely because it was not.
 */
import { describe, expect, it } from 'vitest';
import {
  CALLBACK_DATA_MAX_BYTES,
  CASE_TOPIC_CHOICES,
  FAQ_PAGE_SIZE,
  FAQ_TOPICS,
} from '../config/constants.js';
import { byteLength } from './callback-data.js';
import {
  type ButtonableFaqRow,
  answerKeyboard,
  backToMenuKeyboard,
  caseTopicKeyboard,
  faqHubKeyboard,
  mainMenuKeyboard,
  pickerKeyboard,
  topicListingKeyboard,
} from './keyboards.js';

function faqRow(code: string, buttonText = 'How do I apply?'): ButtonableFaqRow {
  return { code, buttonText };
}

function payloads(keyboard: readonly (readonly { callback_data: string }[])[]): string[] {
  return keyboard.flatMap((row) => row.map((b) => b.callback_data));
}

describe('the byte ceiling is enforced in one place', () => {
  it('emits nothing over the limit, across every keyboard in the stage', () => {
    const rows = Array.from({ length: FAQ_PAGE_SIZE * 3 }, (_, i) =>
      faqRow(`PLACEMENT-${String(i).padStart(3, '0')}`),
    );
    const all = [
      ...payloads(mainMenuKeyboard()),
      ...payloads(faqHubKeyboard()),
      ...payloads(caseTopicKeyboard()),
      ...payloads(backToMenuKeyboard()),
      ...payloads(answerKeyboard('PLACEMENT-999', 'PLACEMENT')),
      ...payloads(topicListingKeyboard(rows, 'PLACEMENT', 1).keyboard),
      ...payloads(pickerKeyboard(rows.slice(0, 3), 'PLACEMENT', true).keyboard),
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const payload of all) {
      expect(byteLength(payload)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
    }
  });
});

describe('an over-long answer code', () => {
  /**
   * `encodeCallback` throws, where `faqButtonRows_` (`QAEngine.gs:343`) skipped
   * the row and logged. One bad code must hide one button, not take down the
   * whole topic listing — that would be strictly worse than the code being
   * replaced.
   */
  it('hides one button rather than taking down the listing', () => {
    const rows = [faqRow('VISA-001'), faqRow('X'.repeat(80)), faqRow('VISA-002')];
    const built = topicListingKeyboard(rows, 'VISA', 1);
    const emitted = payloads(built.keyboard);
    expect(emitted).toContain('ANS:VISA-001');
    expect(emitted).toContain('ANS:VISA-002');
    expect(emitted.some((p) => p.includes('XXXX'))).toBe(false);
  });

  it('reports the code it hid, so it can be alerted on rather than lost', () => {
    const rows = [faqRow('VISA-001'), faqRow('Y'.repeat(80))];
    expect(topicListingKeyboard(rows, 'VISA', 1).skipped).toEqual(['Y'.repeat(80)]);
  });

  it('reports nothing when every code fits', () => {
    expect(topicListingKeyboard([faqRow('VISA-001')], 'VISA', 1).skipped).toEqual([]);
  });
});

describe('paging', () => {
  it('offers no paging controls when everything fits on one page', () => {
    const built = topicListingKeyboard([faqRow('VISA-001')], 'VISA', 1);
    expect(payloads(built.keyboard).some((p) => p.startsWith('PG:'))).toBe(false);
  });

  it('offers paging once there is more than one page', () => {
    const rows = Array.from({ length: FAQ_PAGE_SIZE + 1 }, (_, i) => faqRow(`VISA-${i}`));
    const built = topicListingKeyboard(rows, 'VISA', 1);
    expect(payloads(built.keyboard)).toContain('PG:VISA:2');
  });

  it('shows only the current page of answers', () => {
    const rows = Array.from({ length: FAQ_PAGE_SIZE + 3 }, (_, i) => faqRow(`VISA-${i}`));
    const answers = payloads(topicListingKeyboard(rows, 'VISA', 1).keyboard).filter((p) =>
      p.startsWith('ANS:'),
    );
    expect(answers).toHaveLength(FAQ_PAGE_SIZE);
  });

  it('offers a way back from the last page', () => {
    const rows = Array.from({ length: FAQ_PAGE_SIZE + 1 }, (_, i) => faqRow(`VISA-${i}`));
    expect(payloads(topicListingKeyboard(rows, 'VISA', 2).keyboard)).toContain('PG:VISA:1');
  });
});

describe('the main menu', () => {
  it('shortcuts only the topics flagged for it, not all eleven', () => {
    const shortcuts = payloads(mainMenuKeyboard()).filter((p) => p.startsWith('CAT:'));
    const expected = FAQ_TOPICS.filter((t) => t.onMainMenu).map((t) => `CAT:${t.code}`);
    expect(shortcuts).toEqual(expected);
  });

  it('always offers the full FAQ hub, so nothing is unreachable', () => {
    expect(payloads(mainMenuKeyboard())).toContain('MENU:FAQ');
  });

  it('lists every topic in the hub', () => {
    const hub = payloads(faqHubKeyboard()).filter((p) => p.startsWith('CAT:'));
    expect(hub).toHaveLength(FAQ_TOPICS.length);
  });
});

describe('filing a case', () => {
  it('offers exactly the five filing options', () => {
    const emitted = payloads(caseTopicKeyboard()).filter((p) => p.startsWith('CASE:'));
    expect(emitted).toEqual(CASE_TOPIC_CHOICES.map((c) => `CASE:${c.key}`));
  });

  it('labels the general fallback "Something else", not "Contact Support"', () => {
    const labels = caseTopicKeyboard().flatMap((row) => row.map((b) => b.text));
    expect(labels.some((l) => l.includes('Something else'))).toBe(true);
  });
});

describe('an answer', () => {
  it('offers both halves of the feedback pair', () => {
    const emitted = payloads(answerKeyboard('VISA-001', 'VISA'));
    expect(emitted).toContain('OK:VISA-001');
    expect(emitted).toContain('BAD:VISA-001');
  });

  it('offers a way back into the topic as well as home', () => {
    const emitted = payloads(answerKeyboard('VISA-001', 'VISA'));
    expect(emitted).toContain('CAT:VISA');
    expect(emitted).toContain('MENU:MAIN');
  });
});

describe('a low-confidence picker', () => {
  it('offers Contact Support, so a teacher is never cornered by a bad guess', () => {
    const built = pickerKeyboard([faqRow('VISA-001')], 'VISA', true);
    expect(payloads(built.keyboard)).toContain('MENU:CONTACT_SUPPORT');
  });

  it('omits it when the matches were confident', () => {
    const built = pickerKeyboard([faqRow('VISA-001')], 'VISA', false);
    expect(payloads(built.keyboard)).not.toContain('MENU:CONTACT_SUPPORT');
  });
});
