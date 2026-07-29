/**
 * The top-level menu, and the two prompts that stand in front of it.
 *
 * Kept apart from the FAQ handlers because this is where a teacher lands when
 * anything goes wrong anywhere else — an unknown topic, a withdrawn answer, a
 * conversation state from a build that no longer exists. It has to be the one
 * thing that cannot itself fail.
 */
import { privacyNotice } from '../../config/privacy.js';
import { backToMenuKeyboard, mainMenuKeyboard, regionCheckKeyboard } from '../keyboards.js';
import type { Reply } from '../reply.js';

export function mainMenuReply(): Reply {
  return { text: 'What would you like to do?', keyboard: mainMenuKeyboard() };
}

/**
 * "Is the region we hold for you still right?" — D21, and the only
 * teacher-visible change in stage 4.
 *
 * It says what the answer is *for*, because a question with no stated purpose is
 * one people answer carelessly, and this one decides which staff receive their
 * emergency. It also says plainly that nothing happens automatically, so that a
 * teacher who taps "I have moved" and sees no change does not conclude the bot
 * ignored them.
 *
 * Arrives as a second message beside the menu, never instead of it. The teacher
 * can ignore it entirely and use the bot exactly as before; it comes back in six
 * months.
 */
export function regionCheckReply(region: string): Reply {
  return {
    text: [
      `📍 We have you in ${region}.`,
      '',
      'This is how we decide which of our staff sees your case, so it is worth ' +
        'keeping right — if it is wrong, an urgent case could go to the wrong province.',
      '',
      'Is it still correct? Nothing changes automatically: if you have moved, one ' +
        'of our staff will check and update it.',
    ].join('\n'),
    keyboard: regionCheckKeyboard(),
  };
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
