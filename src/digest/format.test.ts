import { describe, expect, it } from 'vitest';
import {
  DIGEST_LIST_CAP,
  TEACHER_CHASE_MAX,
  TELEGRAM_MESSAGE_MAX_CHARS,
} from '../config/constants.js';
import type { StaffCaseRow } from '../cases/queries.js';
import {
  announcementMessage,
  announcementOverBy,
  announcementReport,
  chaseExhaustedMessage,
  staffDigest,
  teacherChaseMessage,
} from './format.js';

const row = (over: Partial<StaffCaseRow> = {}): StaffCaseRow =>
  ({
    reference: 'VISA-2026-00001',
    category: 'Visa',
    status: 'Under review',
    importance: 'Normal',
    teacherChatId: '900001',
    teacherName: 'A. Karimov',
    region: 'Bukhara',
    regionOverride: null,
    regionSetBy: null,
    regionSetAt: null,
    owner: null,
    detail: 'the teacher’s own words, which must never appear in a digest',
    publicUpdate: '',
    dueAt: new Date('2026-07-25T13:00:00Z'),
    snoozedUntil: null,
    createdAt: new Date('2026-07-01T09:00:00Z'),
    updatedAt: new Date('2026-07-02T09:00:00Z'),
    closedAt: null,
    ...over,
  }) as StaffCaseRow;

const empty = { cases: [], total: 0 };
const list = (cases: StaffCaseRow[], total = cases.length) => ({ cases, total });

describe('the staff digest', () => {
  it('sends nothing to somebody with nothing due', () => {
    /**
     * D39. A daily message saying "nothing to do" is a daily message people
     * filter, and then they filter the one that matters. Returning null here
     * rather than deciding it in the job means the rule lives in one place and
     * the job cannot send an empty digest by accident.
     */
    expect(staffDigest({ pastDue: empty, stale: empty, unassigned: empty })).toBeNull();
  });

  it('sends a digest when any one list has something in it', () => {
    expect(staffDigest({ pastDue: list([row()]), stale: empty, unassigned: empty })).not.toBeNull();
    expect(staffDigest({ pastDue: empty, stale: list([row()]), unassigned: empty })).not.toBeNull();
    expect(staffDigest({ pastDue: empty, stale: empty, unassigned: list([row()]) })).not.toBeNull();
  });

  it('never contains what the teacher wrote', () => {
    /**
     * The same rule new-case notification follows: a teacher's account of their
     * problem does not belong in a message pushed to a phone. Staff read it with
     * `/case`, which checks permission first and leaves a row saying who read it.
     */
    const digest = staffDigest({ pastDue: list([row()]), stale: empty, unassigned: empty })!;
    expect(digest).not.toContain('the teacher’s own words');
  });

  it('keeps the three lists apart, because they mean different things', () => {
    // "You promised a date and missed it" and "nobody has touched this" are two
    // different ideas of late, and a case can be either, both or neither.
    const digest = staffDigest({
      pastDue: list([row({ reference: 'VISA-2026-00001' })]),
      stale: list([row({ reference: 'TRAVEL-2026-00002' })]),
      unassigned: list([row({ reference: 'SUPPORT-2026-00003' })]),
    })!;

    const pastDueAt = digest.indexOf('VISA-2026-00001');
    const staleAt = digest.indexOf('TRAVEL-2026-00002');
    const unassignedAt = digest.indexOf('SUPPORT-2026-00003');

    expect(pastDueAt).toBeGreaterThan(-1);
    expect(staleAt).toBeGreaterThan(pastDueAt);
    expect(unassignedAt).toBeGreaterThan(staleAt);
  });

  it('caps each list and says what it is not showing', () => {
    // STAFF_CASE_LIST_CAP's argument: a list that silently loses its tail is
    // worse than one that says how much is missing.
    const many = Array.from({ length: DIGEST_LIST_CAP + 5 }, (_, i) =>
      row({ reference: `VISA-2026-0000${i}` }),
    );
    const digest = staffDigest({ pastDue: list(many, 40), stale: empty, unassigned: empty })!;

    expect(digest.match(/VISA-2026-/g)).toHaveLength(DIGEST_LIST_CAP);
    expect(digest).toContain('30 more');
  });

  it('stays inside what Telegram will deliver', () => {
    const many = Array.from({ length: 200 }, (_, i) => row({ reference: `SUPPORT-2026-${i}` }));
    const digest = staffDigest({
      pastDue: list(many, 200),
      stale: list(many, 200),
      unassigned: list(many, 200),
    })!;
    expect(digest.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_CHARS);
  });

  it('survives a teacher with no name', () => {
    // `/forget` clears the name and keeps the case history, so a nameless
    // teacher is an ordinary state rather than a broken row.
    const digest = staffDigest({
      pastDue: list([row({ teacherName: null, region: null })]),
      stale: empty,
      unassigned: empty,
    })!;
    expect(digest).not.toContain('null');
  });
});

describe('the teacher’s reminder', () => {
  it('quotes what was asked for, which is the only case text a teacher sees', () => {
    // `/await` writes it to public_update precisely so the request reaches them.
    const message = teacherChaseMessage(row({ publicUpdate: 'Please send your visa page.' }));
    expect(message).toContain('Please send your visa page.');
    expect(message).toContain('VISA-2026-00001');
  });

  it('never quotes what the teacher themselves wrote', () => {
    expect(teacherChaseMessage(row())).not.toContain('the teacher’s own words');
  });

  it('says what to do when they have already done it', () => {
    // A teacher who replied and heard nothing needs a route that is not silence.
    expect(teacherChaseMessage(row()).toLowerCase()).toContain('check my case');
  });
});

describe('telling an owner the teacher has stopped answering', () => {
  it('names the case and says what the staff member can do about it', () => {
    // The signal D26 built `/close <ref> unresolved <reason>` for, and which
    // nothing has ever produced.
    const message = chaseExhaustedMessage(row());
    expect(message).toContain('VISA-2026-00001');
    expect(message).toContain('/close');
    expect(message).toContain('unresolved');
  });

  it('states the number of reminders from the constant that governs them', () => {
    // Not the word "three" beside a constant that says 3. Two copies of one
    // fact is how a message starts lying after somebody tunes the cap, and it
    // is the drift this project keeps finding in its own documents.
    expect(chaseExhaustedMessage(row())).toContain(String(TEACHER_CHASE_MAX));
  });
});

describe('an announcement, as a teacher receives it', () => {
  it('says who is speaking and where to go instead of replying', () => {
    // A message arriving unasked from a bot somebody signed into months ago
    // reads as spam unless it names its sender, and a broadcast is the one
    // message here nobody can usefully reply to.
    const message = announcementMessage('Term starts on Monday.');

    expect(message).toContain('Ministry');
    expect(message).toContain('Term starts on Monday.');
    expect(message).toContain('Contact Support');
  });

  it('reports nothing over the limit for a message that fits', () => {
    expect(announcementOverBy('Term starts on Monday.')).toBe(0);
  });

  it('reports the overflow of one that does not, which the clamp would hide', () => {
    /**
     * The fault this function exists for, and it was found by running the
     * command rather than by reading it. `announcementMessage` clamps — right
     * for every other message in this file, and wrong for free text somebody
     * typed, because the clamp turns "too long to send" into "delivered to
     * 1,800 people ending in … cut short". A guard written against the clamped
     * length can never fire.
     */
    const huge = 'x'.repeat(TELEGRAM_MESSAGE_MAX_CHARS + 100);

    expect(announcementMessage(huge).length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX_CHARS);
    expect(announcementOverBy(huge)).toBeGreaterThan(100);
  });
});

describe('the announcement report', () => {
  it('counts sent, skipped and failed separately', () => {
    /**
     * D41. "1,780 sent" alone hides both the teachers who lost access since the
     * draft was written and the ones Telegram refused, and those need different
     * things done about them.
     */
    const report = announcementReport({ sent: 1780, skipped: 15, failed: 5, total: 1800 });
    expect(report).toContain('1780');
    expect(report).toContain('15');
    expect(report).toContain('5');
    expect(report.toLowerCase()).toContain('no longer');
  });

  it('does not invent a skipped or failed line when there were none', () => {
    const report = announcementReport({ sent: 1800, skipped: 0, failed: 0, total: 1800 });
    expect(report.toLowerCase()).not.toContain('failed');
  });
});
