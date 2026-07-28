/**
 * What may and may not be written into the interaction log.
 *
 * BOT-SPEC.md:251 calls this "an audit trail, not a transcript". The redaction
 * was found defeated once already: the raw email was logged in full by the
 * webhook a few lines before the verification code redacted it, so the
 * protection was decorative. Keeping the decision in a pure function is what
 * makes it cheap enough to test every branch.
 */
import { describe, expect, it } from 'vitest';
import { CASE_CATEGORY } from '../config/constants.js';
import type { ConversationState } from '../conversation/state.js';
import { redactDetail } from './interactions.js';

const IDENTIFIER: ConversationState = { kind: 'AwaitingIdentifier', attempts: 1 };
const CASE_DETAIL: ConversationState = {
  kind: 'AwaitingCaseDetail',
  category: CASE_CATEGORY.VISA,
  attempts: 0,
};
const URGENT_CODE: ConversationState = { kind: 'AwaitingUrgentCode', attempts: 0 };

describe('when the teacher is signing in', () => {
  it('redacts the identifier to a hint', () => {
    expect(redactDetail('a.karimov@example.com', IDENTIFIER)).toBe('a***@example.com');
  });

  it('keeps the domain, which is what makes the hint useful on a support call', () => {
    expect(redactDetail('nodira@school.uz', IDENTIFIER)).toBe('n***@school.uz');
  });

  it('withholds a single-character local part rather than revealing it whole', () => {
    expect(redactDetail('a@school.uz', IDENTIFIER)).toBe('a***@school.uz');
  });

  it('withholds something that is not an address at all', () => {
    // A teacher who types their name here has typed personal data into a state
    // whose whole purpose is collecting personal data. It does not get logged
    // just because it failed to look like an email.
    expect(redactDetail('Nodira Karimova', IDENTIFIER)).toBe('(identifier withheld — 15 characters)');
  });
});

describe('when the teacher is describing a case', () => {
  it('withholds the detail, which lives in the case record instead', () => {
    expect(redactDetail('My visa was refused at the border', CASE_DETAIL)).toBe(
      '(case detail withheld — 33 characters)',
    );
  });

  it('withholds an urgent description too', () => {
    const urgentDetail: ConversationState = {
      kind: 'AwaitingUrgentDetail',
      codeAccepted: 'AB12CD',
      attempts: 0,
    };
    expect(redactDetail('I am stranded at the airport', urgentDetail)).toBe(
      '(case detail withheld — 28 characters)',
    );
  });
});

describe('when the teacher is entering an urgent code', () => {
  it('withholds the code', () => {
    expect(redactDetail('AB12CD', URGENT_CODE)).toBe('(urgent code withheld)');
  });
});

describe('when there is no conversation state', () => {
  /**
   * The subtle one, and the reason this function takes the state at all. If the
   * state lookup misses because it expired, a teacher typing their email late
   * would be logged verbatim — defeating the redaction exactly as it was
   * defeated before. Absent state is treated as potentially sensitive, not safe.
   */
  it('still redacts something that looks like an email address', () => {
    expect(redactDetail('a.karimov@example.com', null)).toBe('a***@example.com');
  });

  it('redacts an address embedded in a longer message', () => {
    expect(redactDetail('my email is nodira@school.uz thanks', null)).toBe(
      'my email is n***@school.uz thanks',
    );
  });

  /**
   * But it does not withhold ordinary questions. An unanswered question is the
   * most valuable content signal there is (QAEngine.gs:262), and blanket
   * redaction of every unstated message would destroy it to solve a problem the
   * address-scrubbing above already solves.
   */
  it('keeps an ordinary question, because that is the content signal', () => {
    expect(redactDetail('how do I extend my visa?', null)).toBe('how do I extend my visa?');
  });
});

describe('addresses are scrubbed whatever the state', () => {
  it('scrubs one out of a case description', () => {
    // Defence in depth. BOT-SPEC.md:247 says the identifier is written once, to
    // the teacher's row — so it has no business appearing in this table by any
    // route, including one nobody predicted.
    expect(redactDetail('contact me at nodira@school.uz', CASE_DETAIL)).not.toContain(
      'nodira@school.uz',
    );
  });
});

describe('housekeeping', () => {
  it('truncates a very long detail, because this column is not a transcript', () => {
    const long = 'x'.repeat(1000);
    expect(redactDetail(long, null).length).toBeLessThanOrEqual(500);
  });

  it('handles an empty detail without inventing one', () => {
    expect(redactDetail('', null)).toBe('');
  });
});
