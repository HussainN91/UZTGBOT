import { describe, expect, it } from 'vitest';
import {
  isCaseReference,
  parseCommand,
  parseDueDate,
  splitChatId,
  splitReference,
} from './parse.js';

describe('parseCommand', () => {
  it('treats the remainder as one phrase, not as words', () => {
    // /cases Under review — a status can contain a space, and splitting it would
    // make that filter silently unmatchable (AdminCommands.gs:501).
    expect(parseCommand('/cases Under review')).toEqual({ name: '/cases', rest: 'Under review' });
  });

  it('strips a bot mention', () => {
    expect(parseCommand('/case@MopseBot VISA-2026-00001')?.name).toBe('/case');
  });

  it('lowercases the command but never the arguments', () => {
    // A case reference is upper-case and a teacher's name is not ours to change.
    expect(parseCommand('/CASE Visa-2026-00001')).toEqual({
      name: '/case',
      rest: 'Visa-2026-00001',
    });
  });

  it('returns null for text that is not a command', () => {
    expect(parseCommand('how long does a visa take')).toBeNull();
    expect(parseCommand('')).toBeNull();
  });

  it('returns null for a lone slash and for a slash followed by a space', () => {
    expect(parseCommand('/')).toBeNull();
    expect(parseCommand('/ cases')).toBeNull();
  });

  it('returns an empty rest when there are no arguments', () => {
    expect(parseCommand('/whoami')).toEqual({ name: '/whoami', rest: '' });
  });

  it('ignores leading and trailing whitespace around the whole message', () => {
    expect(parseCommand('  /close VISA-2026-00001  ')).toEqual({
      name: '/close',
      rest: 'VISA-2026-00001',
    });
  });

  it('does not treat a mid-sentence slash as a command', () => {
    // A teacher describing a problem writes "contract w/ school" and must not
    // have it read as a command — D9 lets unrecognised senders fall through, so
    // a false positive here costs a teacher their typed case detail.
    expect(parseCommand('contract w/ school is wrong')).toBeNull();
  });

  it('reads a command that is only a mention', () => {
    expect(parseCommand('/whoami@MopseBot')).toEqual({ name: '/whoami', rest: '' });
  });

  it('lowercases the bot mention check, so /Case@MopseBot still parses', () => {
    expect(parseCommand('/Case@MopseBot')?.name).toBe('/case');
  });
});

describe('splitReference', () => {
  it('splits a reference from a message without losing internal spacing', () => {
    expect(splitReference('VISA-2026-00001  we have  emailed you')).toEqual({
      reference: 'VISA-2026-00001',
      rest: 'we have  emailed you',
    });
  });

  it('upper-cases the reference, because a teacher reads it aloud over the phone', () => {
    expect(splitReference('visa-2026-00001 done')?.reference).toBe('VISA-2026-00001');
  });

  it('returns an empty rest when only a reference is given', () => {
    expect(splitReference('VISA-2026-00001')).toEqual({
      reference: 'VISA-2026-00001',
      rest: '',
    });
  });

  it('returns null when the first word is not a case reference', () => {
    // /reply with no reference must fail loudly rather than guess which case the
    // sender meant. Guessing here sends a teacher somebody else's answer.
    expect(splitReference('we have emailed you')).toBeNull();
    expect(splitReference('')).toBeNull();
  });
});

describe('isCaseReference', () => {
  it('accepts every prefix the allocator can produce', () => {
    for (const prefix of ['VISA', 'TRAVEL', 'CONTRACT', 'ACCOM', 'DOCS', 'SUPPORT', 'CASE']) {
      expect(isCaseReference(`${prefix}-2026-00001`)).toBe(true);
    }
  });

  it('rejects text that merely contains hyphens', () => {
    expect(isCaseReference('VISA-2026')).toBe(false);
    expect(isCaseReference('not-a-reference')).toBe(false);
    expect(isCaseReference('VISA-26-00001')).toBe(false);
  });
});

describe('splitChatId', () => {
  it('splits an id from what follows it', () => {
    expect(splitChatId('995101 Samarkand')).toEqual({ chatId: '995101', rest: 'Samarkand' });
  });

  it('accepts an id on its own', () => {
    expect(splitChatId('995101')).toEqual({ chatId: '995101', rest: '' });
  });

  it('refuses anything that is not digits, rather than guessing', () => {
    // A correction landing on somebody else's account is the unrecoverable
    // outcome; being told to include an id is the recoverable one.
    expect(splitChatId('@someone Samarkand')).toBeNull();
    expect(splitChatId('995101x Samarkand')).toBeNull();
    expect(splitChatId('')).toBeNull();
  });
});

describe('parseDueDate', () => {
  /** The instant, as a person in Tashkent would read it. */
  const inTashkent = (at: Date): string =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Tashkent',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(at);

  it('reads the two forms a person would actually type', () => {
    const iso = parseDueDate('2026-08-15');
    const spelt = parseDueDate('15 Aug 2026');
    const long = parseDueDate('15 August 2026');

    expect(iso.ok && spelt.ok && long.ok).toBe(true);
    if (!iso.ok || !spelt.ok || !long.ok) return;
    expect(spelt.at.getTime()).toBe(iso.at.getTime());
    expect(long.at.getTime()).toBe(iso.at.getTime());
  });

  it('lands on the END of that day in Tashkent, not the start of it', () => {
    // "By the 15th" means the teacher has been promised something by the time
    // the 15th is over. Parsed as midnight, every promise would fall five hours
    // into the previous day for everyone who reads it, and a case promised for
    // today would look broken the moment it was promised.
    const parsed = parseDueDate('2026-08-15');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(inTashkent(parsed.at)).toBe('15 Aug 2026, 23:59');
  });

  it('refuses a slashed date instead of guessing which half is the month', () => {
    // 15/08 and 08/15 are both in ordinary use. A date read the wrong way round
    // is not visibly wrong — it is a promise to a teacher on the wrong day.
    expect(parseDueDate('15/08/2026')).toEqual({ ok: false, why: 'ambiguous' });
    expect(parseDueDate('08/15/2026')).toEqual({ ok: false, why: 'ambiguous' });
    expect(parseDueDate('15.08.2026')).toEqual({ ok: false, why: 'ambiguous' });
  });

  it('refuses a day that does not exist rather than rolling it forward', () => {
    // Date.UTC turns 31 February into 3 March without complaint.
    expect(parseDueDate('2026-02-31')).toEqual({ ok: false, why: 'no-such-day' });
    expect(parseDueDate('31 Feb 2026')).toEqual({ ok: false, why: 'no-such-day' });
    expect(parseDueDate('2026-13-01')).toEqual({ ok: false, why: 'no-such-day' });
  });

  it('refuses text with no date in it', () => {
    expect(parseDueDate('next Tuesday')).toEqual({ ok: false, why: 'unreadable' });
    expect(parseDueDate('soon')).toEqual({ ok: false, why: 'unreadable' });
    expect(parseDueDate('15 Smarch 2026')).toEqual({ ok: false, why: 'unreadable' });
    expect(parseDueDate('')).toEqual({ ok: false, why: 'unreadable' });
  });

  it('tells March from May, which three letters is the shortest way to do', () => {
    const march = parseDueDate('01 Mar 2026');
    const may = parseDueDate('01 May 2026');
    expect(march.ok && may.ok).toBe(true);
    if (!march.ok || !may.ok) return;
    expect(march.at.getTime()).toBeLessThan(may.at.getTime());
    expect(parseDueDate('01 Ma 2026')).toEqual({ ok: false, why: 'unreadable' });
  });
});
