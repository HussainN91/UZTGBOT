import { describe, expect, it } from 'vitest';
import { CASE_STATUS_ORDER, OPEN_CASE_STATUSES } from '../db/schema.js';
import {
  CLOSED_CASE_STATUSES,
  caseStatusList,
  isClosedStatus,
  isOpenStatus,
  parseCaseStatus,
} from './status.js';

describe('parseCaseStatus', () => {
  it('reads a status containing a space', () => {
    // The one rule the whole parser exists for. AdminCommands.gs:501 split
    // arguments on whitespace and compared the first word, which made every
    // two-word status silently unmatchable: `/cases Under review` worked,
    // returned nothing, and looked exactly like an empty queue.
    expect(parseCaseStatus('Under review')).toBe('Under review');
    expect(parseCaseStatus('Action required')).toBe('Action required');
  });

  it('ignores capitalisation, because a phone supplies its own', () => {
    expect(parseCaseStatus('under REVIEW')).toBe('Under review');
    expect(parseCaseStatus('  completed  ')).toBe('Completed');
  });

  it('refuses a word it does not know rather than defaulting', () => {
    // A filter that quietly matched everything, or nothing, is a staff member
    // drawing a conclusion about a queue from a question never asked.
    expect(parseCaseStatus('Undr review')).toBeNull();
    expect(parseCaseStatus('open')).toBeNull();
    expect(parseCaseStatus('')).toBeNull();
  });

  it('accepts every status the database has', () => {
    for (const status of CASE_STATUS_ORDER) {
      expect(parseCaseStatus(status)).toBe(status);
    }
  });
});

describe('the open and closed halves', () => {
  it('partition all eight statuses, with none in both and none in neither', () => {
    // The guard that matters. A status added without deciding which side it
    // falls on would be invisible to /cases — which lists the open ones — and
    // immortal to stage 5's retention, which measures from the closed_at that
    // only the closed ones stamp. It would be in no list at all.
    for (const status of CASE_STATUS_ORDER) {
      expect(isOpenStatus(status) !== isClosedStatus(status)).toBe(true);
    }
    expect(OPEN_CASE_STATUSES.length + CLOSED_CASE_STATUSES.length).toBe(
      CASE_STATUS_ORDER.length,
    );
  });

  it('treats a case shut without resolution as ended, like one that was resolved', () => {
    // D26 gives `Closed` a writer. Both stamp closed_at, and both start the
    // retention clock — the difference between them is what a later reader
    // learns, not how long the record lives.
    expect(isClosedStatus('Completed')).toBe(true);
    expect(isClosedStatus('Closed')).toBe(true);
    expect(isClosedStatus('Duplicate')).toBe(true);
  });

  it('keeps a case waiting on the teacher open', () => {
    // D26. `Action required` means the teacher must act — the case is still
    // live work, it is simply not ours to move.
    expect(isOpenStatus('Action required')).toBe(true);
  });
});

describe('caseStatusList', () => {
  it('names all eight, not the four a staff member types', () => {
    // Somebody who mistyped a status is reading one off a case, and the four
    // they write are not the four they see. Refusing `/cases Duplicate` with a
    // list omitting `Duplicate` would be the bot denying a status it displays.
    for (const status of CASE_STATUS_ORDER) {
      expect(caseStatusList()).toContain(status);
    }
  });
});
