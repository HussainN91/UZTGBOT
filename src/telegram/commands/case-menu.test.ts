/**
 * The case keyboard — a pure function, tested without a database.
 *
 * The property under test is the one the design calls load-bearing: **a button
 * is never drawn for somebody who would be refused for tapping it.** A button
 * shown and then refused is worse than no button, because the person cannot
 * tell whether they did it wrong.
 */
import { describe, expect, it } from 'vitest';
import type { StaffRecord } from '../../staff/repository.js';
import type { StaffCaseRow } from '../../cases/queries.js';
import { caseActionKeyboard } from './case-menu.js';

const member = (over: Partial<StaffRecord> = {}): StaffRecord => ({
  telegramId: '994001',
  name: 'A Member',
  role: 'Support',
  queue: 'Visa',
  regions: [],
  active: true,
  addedBy: null,
  addedAt: new Date(),
  telegramUsername: null,
  ...over,
});

const openCase = (over: Partial<StaffCaseRow> = {}): StaffCaseRow =>
  ({
    reference: 'VISA-2026-00311',
    status: 'Under review',
    importance: 'Normal',
    category: 'Visa',
    region: 'Tashkent',
    ...over,
  }) as StaffCaseRow;

/**
 * The action field of every button, so a test can ask "is it offered at all".
 *
 * The field rather than a substring of the whole payload: `CA::MINE` contains
 * the characters `:M`, so a substring test for the importance action would pass
 * on the Back button and prove nothing.
 */
const payloads = (member_: StaffRecord, row: StaffCaseRow): string[] =>
  caseActionKeyboard(row, member_)
    .flat()
    .map((b) => b.callback_data.split(':')[2] ?? '');

describe('who is shown which case buttons', () => {
  it('does not offer an owner to somebody who may not assign one', () => {
    // case.assign floors at Program. Support holds case.update and no more.
    expect(payloads(member({ role: 'Support' }), openCase())).not.toContain('OWN');
  });

  it('offers an owner to Program', () => {
    expect(payloads(member({ role: 'Program' }), openCase())).toContain('OWN');
  });

  it('offers nothing that writes to an Observer', () => {
    // case.view floors at Observer and every action here needs more than that.
    const shown = payloads(member({ role: 'Observer' }), openCase());
    expect(shown).not.toContain('SN');
    expect(shown).not.toContain('M');
    expect(shown).not.toContain('RO');
  });

  it('offers nothing at all to a deactivated member who still holds the rank', () => {
    const keyboard = caseActionKeyboard(openCase(), member({ role: 'System', active: false }));
    const actions = keyboard.flat().map((b) => b.callback_data.split(':')[2] ?? '');
    // Only the way back survives, and it names no action on any case.
    expect(actions.filter((a) => a !== 'MINE')).toEqual([]);
  });
});

describe('which buttons suit the case as it stands', () => {
  it('offers reopen on a finished case and not on an open one', () => {
    expect(payloads(member({ role: 'Program' }), openCase({ status: 'Under review' }))).not.toContain('RO');
    expect(payloads(member({ role: 'Program' }), openCase({ status: 'Completed' }))).toContain('RO');
  });

  it('does not offer a snooze on a finished case', () => {
    expect(payloads(member({ role: 'Program' }), openCase({ status: 'Completed' }))).not.toContain('SN');
  });

  /**
   * Importance is deliberately allowed on a finished case. D22 calls it a
   * judgement somebody makes after reading, retention keys off it and never off
   * the status, so marking a closed case is the one thing that keeps it.
   */
  it('offers importance on a finished case', () => {
    expect(payloads(member({ role: 'Program' }), openCase({ status: 'Completed' }))).toContain('M');
  });
});
