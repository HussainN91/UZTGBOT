/**
 * The top-level menu, and the two prompts that stand in front of it.
 *
 * Kept apart from the FAQ handlers because this is where a teacher lands when
 * anything goes wrong anywhere else — an unknown topic, a withdrawn answer, a
 * conversation state from a build that no longer exists. It has to be the one
 * thing that cannot itself fail.
 */
import { privacyNotice } from '../../config/privacy.js';
import { backToMenuKeyboard, mainMenuKeyboard } from '../keyboards.js';
import type { Reply } from '../reply.js';

export function mainMenuReply(): Reply {
  return { text: 'What would you like to do?', keyboard: mainMenuKeyboard() };
}

/**
 * Shown before an identifier is asked for, and again on demand via /privacy.
 *
 * The notice is part of the prompt rather than a separate message the teacher
 * has to have read: replying with an identifier is the acknowledgement, so the
 * two cannot be separated by a teacher who scrolled past.
 */
export function signInPromptReply(supportContact: string): Reply {
  return {
    text:
      `${privacyNotice(supportContact)}\n\n` +
      '— — —\n\n' +
      'To continue, please reply with the email address you were recruited with. ' +
      'Replying means you have read the notice above.',
  };
}

/** `/privacy`, which must work whether or not the teacher has signed in. */
export function privacyReply(supportContact: string): Reply {
  return { text: privacyNotice(supportContact), keyboard: backToMenuKeyboard() };
}

/**
 * `staffSection` is appended only for an active staff member, and is `null` for
 * everybody else.
 *
 * It arrives as a finished block rather than being built here, because deciding
 * *which* commands to name is an authorization question and this file is the one
 * place in the bot that must never fail. `Webhook.gs:249` kept the same split:
 * a teacher offered `/close` is a teacher who will type it, and then be refused
 * by the bot that suggested it.
 */
export function helpReply(supportContact: string, staffSection: string | null = null): Reply {
  return {
    text:
      'This bot answers common questions and opens support cases for teachers ' +
      'recruited by the Ministry.\n\n' +
      '/start — the main menu\n' +
      '/privacy — what data is held about you\n' +
      '/help — this message\n\n' +
      (staffSection === null ? '' : `${staffSection}\n\n`) +
      `If you need a person, contact ${supportContact}.`,
    keyboard: backToMenuKeyboard(),
  };
}
