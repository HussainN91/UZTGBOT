/**
 * The sign-in prompt, which had never had a test of its own.
 *
 * It is the first thing a teacher who has never used this bot reads, and until
 * 3 August 2026 it asked them to *"reply with"* an address — which reads as a
 * Telegram reply, a real thing they can do and the wrong one — and it put that
 * instruction after the entire privacy notice, the longest message the bot
 * sends.
 *
 * Nothing held either fault, which is why both survived to launch minus days.
 * The rest of this module is covered through `route`, and the prompt was covered
 * only by tests that happened to mention it while checking something else. These
 * assert the prompt as the thing under test.
 *
 * Pure, so no database: `menu.ts` takes its periods and its contact as arguments
 * precisely so that it cannot itself fail.
 */
import { describe, expect, it } from 'vitest';
import type { RetentionPeriods } from '../../config/retention.js';
import { signInPromptReply } from './menu.js';

const CONTACT = 'support@mopse.uz';
const PERIODS: RetentionPeriods = { caseDays: 7, urgentCaseDays: 180, messageDays: 3 };

const prompt = (): string => signInPromptReply(CONTACT, PERIODS).text;

describe('the sign-in prompt', () => {
  it('says enter, and never asks for a Telegram reply', () => {
    expect(prompt()).toContain('Enter your email address');
    expect(prompt().toLowerCase()).not.toContain('reply with');
  });

  /**
   * The ordering, which is the half of this that a keyword test would miss: the
   * words could all be present and still sit at the bottom of a page of legal
   * text, which is where they were.
   */
  it('puts the instruction before the notice rather than after it', () => {
    const text = prompt();
    expect(text.indexOf('Enter your email address')).toBeLessThan(text.indexOf('Privacy notice'));
  });

  /**
   * The property the old ordering was chosen for, kept rather than traded away.
   * Sending the address is the acknowledgement, so the notice has to travel in
   * the same message — a teacher cannot scroll past what they were shown.
   */
  it('still carries the whole notice in the same message', () => {
    const text = prompt();
    expect(text).toContain('Privacy notice');
    expect(text).toContain(CONTACT);
    expect(text).toContain('recruited with');
  });
});
