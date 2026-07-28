import { describe, expect, it } from 'vitest';
import { isCaseReference, parseCommand, splitReference } from './parse.js';

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
