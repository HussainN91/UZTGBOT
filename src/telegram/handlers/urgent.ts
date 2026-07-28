/**
 * What the bot says during an urgent case.
 *
 * Two rules shape every message here.
 *
 * A rejected code never says *why* it was rejected. Wrong, spent and expired
 * read identically, because "that code has already been used" confirms to
 * whoever typed it that they have found a real code.
 *
 * Nothing promises a person is coming. The bot escalates the case; it cannot
 * make anyone answer at two in the morning, and a teacher in an emergency who is
 * told help is on its way will wait rather than telephone someone. Every path
 * out of here names the support contact.
 */
import { URGENT_CODE_ATTEMPT_WINDOW_MINUTES } from '../../config/constants.js';
import { backToMenuKeyboard } from '../keyboards.js';
import type { Reply } from '../reply.js';

export function urgentCodePromptReply(): Reply {
  return {
    text:
      '🚨 Urgent Case\n\n' +
      'This needs a one-time code from a MoPSE Regional admin. If you do not have ' +
      'one, use Contact Support instead — it reaches the same people.\n\n' +
      'Please type your code.',
    keyboard: backToMenuKeyboard(),
  };
}

/**
 * A code that was not accepted.
 *
 * The remaining count is shown for the same reason the sign-in prompt shows it:
 * a teacher mistyping a code read to them over a bad phone line deserves to know
 * they are running out, and it tells a guesser nothing they could not measure.
 */
export function urgentCodeRejectedReply(attemptsRemaining: number, supportContact: string): Reply {
  return {
    text:
      'That code was not accepted.\n\n' +
      'Codes are single-use and time-limited, so one you have used before will not ' +
      'work again. Check it with the Regional admin who gave it to you.\n\n' +
      (attemptsRemaining > 0
        ? `You can try ${attemptsRemaining} more time${attemptsRemaining === 1 ? '' : 's'}.`
        : 'That was your last attempt for now.') +
      `\n\nIf this cannot wait, contact ${supportContact}.`,
    keyboard: backToMenuKeyboard(),
  };
}

/** Too many wrong codes. Self-healing, so it says when — no one has to release it. */
export function urgentCodeLockedOutReply(supportContact: string): Reply {
  return {
    text:
      'Too many codes have been tried from this chat.\n\n' +
      `Please wait ${URGENT_CODE_ATTEMPT_WINDOW_MINUTES} minutes and try again. ` +
      'Nothing is permanently blocked and you do not need anyone to unlock it.\n\n' +
      'You can still use Contact Support, which reaches the same team. ' +
      `If this is an emergency, contact ${supportContact} now.`,
    keyboard: backToMenuKeyboard(),
  };
}

/**
 * The code was good. Ask for the problem.
 *
 * It says the code is not spent yet, because that is the change D5 makes and it
 * is the difference between a teacher who abandons this and keeps their code and
 * one who telephones a Regional admin for another.
 */
export function urgentCodeAcceptedReply(): Reply {
  return {
    text:
      '✅ Code accepted.\n\n' +
      'Describe the emergency in one message — what has happened, where you are, ' +
      'and what you need. Include a phone number if someone should call you.\n\n' +
      'Your code is not used up until the case is filed, so you can take the time ' +
      'to write it properly.',
  };
}

/** A new urgent case. */
export function urgentCaseFiledReply(reference: string, supportContact: string): Reply {
  return {
    text:
      '🚨 Your case has been opened and marked urgent.\n\n' +
      `Reference: ${reference}\n\n` +
      'Keep this reference. Use Check My Case to see progress.\n\n' +
      `If your situation gets worse before anyone reaches you, contact ${supportContact}.`,
    keyboard: backToMenuKeyboard(),
  };
}

/**
 * The teacher already had an open case, so this escalated that one.
 *
 * Said plainly, and the reference is the *existing* one. A teacher told "opened"
 * twice believes there are two cases and chases both; a teacher told nothing
 * believes their code was wasted. The Apps Script version did the second.
 */
export function urgentCaseEscalatedReply(reference: string, supportContact: string): Reply {
  return {
    text:
      '🚨 Your existing case has been marked urgent.\n\n' +
      `Reference: ${reference}\n\n` +
      'You already had an open case, so rather than opening a second one, what you ' +
      'have just written has been added to it and it has been escalated. Your code ' +
      'has been used for this.\n\n' +
      `If your situation gets worse before anyone reaches you, contact ${supportContact}.`,
    keyboard: backToMenuKeyboard(),
  };
}

/**
 * The case is filed but the code would not spend.
 *
 * Rare, and never the teacher's fault — the code was good when they typed it.
 * They are told the truth: the case exists, the escalation did not apply, and
 * what to do about it. Hiding this would leave them believing an urgent case is
 * being treated as urgent when it is not.
 */
export function urgentCaseNotEscalatedReply(reference: string, supportContact: string): Reply {
  return {
    text:
      '⚠️ Your case has been opened, but the urgent code could not be applied.\n\n' +
      `Reference: ${reference}\n\n` +
      'The code was accepted when you typed it and has since expired or been used ' +
      'elsewhere. Your case is filed and nothing you wrote has been lost, but it is ' +
      'not marked urgent.\n\n' +
      `Please contact ${supportContact} now, quoting this reference, and tell your ` +
      'Regional admin the code did not go through so they can issue another.',
    keyboard: backToMenuKeyboard(),
  };
}

/** Urgent Case is a case, so maintenance mode stops it — and says who to call. */
export function urgentUnavailableReply(supportContact: string): Reply {
  return {
    text:
      'New cases are paused while the support team deals with something.\n\n' +
      'The FAQ and Check My Case still work. ' +
      `If this is an emergency, do not wait for the bot — contact ${supportContact} now.`,
    keyboard: backToMenuKeyboard(),
  };
}
