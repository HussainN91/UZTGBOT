/**
 * The top-level menu, and the two prompts that stand in front of it.
 *
 * Kept apart from the FAQ handlers because this is where a teacher lands when
 * anything goes wrong anywhere else — an unknown topic, a withdrawn answer, a
 * conversation state from a build that no longer exists. It has to be the one
 * thing that cannot itself fail.
 */
import { privacyNotice } from '../../config/privacy.js';
import type { RetentionPeriods } from '../../config/retention.js';
/**
 * A type-only import pointing at a layer above this one, which is permitted and
 * is checked: type imports are erased at compile time, so this file stays free
 * of the database exactly as its header says. Re-declaring the shape here would
 * be a second copy of something that has to agree with the query producing it.
 */
import type { RegionManager } from '../../staff/repository.js';
import {
  backToMenuKeyboard,
  mainMenuKeyboard,
  privacyAcceptKeyboard,
  regionCheckKeyboard,
  type MenuAccess,
} from '../keyboards.js';
import type { Reply } from '../reply.js';

const MENU_PROMPT = 'What would you like to do?';

/**
 * The menu, in whichever of its three forms this chat is owed — Part 5F.
 *
 * **The second paragraph exists because the reduced menu is short enough to
 * mislead.** A teacher recruited by the Ministry arrives expecting to be able to
 * report a problem; shown four FAQ shortcuts and nothing else, the honest
 * conclusion is that this bot only answers questions, and they leave rather than
 * sign in. The head of project asked for it in those terms on 1 August 2026.
 *
 * **It is not shown to a teacher whose access has ended.** Every verb in it —
 * report, ask, send, check — is something they can no longer do, and the line
 * would read as the bot advertising what was just taken away. They get the plain
 * prompt and a menu with no way in; `accessEndedReply` is what explains.
 *
 * Still pure, and still the one thing in the bot that cannot itself fail:
 * `access` is decided by the router, which has the database, and arrives here
 * already answered.
 */
export function mainMenuReply(access: MenuAccess): Reply {
  return {
    text:
      access === 'signInOffered'
        ? `${MENU_PROMPT}\n\n` +
          'You can read the answers below without signing in. Sign in to report a ' +
          'problem, ask for priority, send documents, or check a case you have already sent.'
        : MENU_PROMPT,
    keyboard: mainMenuKeyboard(access),
  };
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
        'keeping right — if it is wrong, an urgent case could go to the wrong region.',
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
 *
 * `periods` comes from settings and is threaded in rather than read here,
 * because this file must stay free of the database — it is the one thing in the
 * bot that cannot itself fail. A teacher signing in for the first time therefore
 * reads exactly the text an existing teacher re-accepts, which is the point of
 * generating it in one place.
 */
export function signInPromptReply(supportContact: string, periods: RetentionPeriods): Reply {
  return {
    text:
      `${privacyNotice(supportContact, periods)}\n\n` +
      '— — —\n\n' +
      'To continue, please reply with the email address you were recruited with. ' +
      'Replying means you have read the notice above.',
  };
}

/**
 * Access that has been taken away, told to the person it was taken from.
 *
 * **This is never the sign-in prompt, and that is the whole point of it.** A
 * revoked teacher offered the prompt would be sent round a loop, and — far worse
 * — would arrive at `bindTeacher`, which clears `revoked_at`, and would thereby
 * undo their own revocation by typing an email address. `/restore` exists (D27)
 * because taking that access back is a decision for somebody with the authority
 * to make it.
 *
 * The wording names neither reason. A teacher cannot act on either — a roster row
 * is recruitment's and a revocation is a staff decision — so the useful thing to
 * give them is the person to ask. Which of the two it was is told to *staff*, by
 * `/restore`, where it can be acted on.
 */
export function accessEndedReply(supportContact: string): Reply {
  return {
    text:
      'Your access to this bot has ended, so it cannot be used from this chat.\n\n' +
      `If you think this is a mistake, contact ${supportContact}.`,
    keyboard: backToMenuKeyboard(),
  };
}

/**
 * The notice shown again, to a teacher who has already signed in — D31, D32.
 *
 * **What changed goes first, in the first two lines.** "Our privacy policy has
 * been updated" is the wording every teacher has learned to tap past; a teacher
 * should be able to read how long their case is kept before they decide, and
 * that is what the notice below is actually about.
 *
 * It is one tap and it is only asked when the promise moved — a lengthened
 * period or a rewritten notice (`requiresReconsent`). Shortening asks nobody
 * anything, which is why seeding the periods at launch reaches no one.
 */
export function reconsentReply(
  supportContact: string,
  periods: RetentionPeriods,
  version: string,
  periodsField: string,
): Reply {
  return {
    text: [
      '📋 *We have set how long your information is kept.*',
      '',
      'The notice you agreed to said we would tell you when this was decided, and',
      'ask you to read it again. This is that. Nothing about your cases has changed.',
      '',
      '— — —',
      '',
      privacyNotice(supportContact, periods),
    ].join('\n'),
    keyboard: privacyAcceptKeyboard(version, periodsField),
  };
}

/**
 * Who covers this teacher's region — Q2, D47, and R34.
 *
 * **The last two lines are the only control there is** over the cost this
 * feature was accepted with: a teacher who can message a manager directly will
 * sometimes do that instead of opening a case, and that work then has no
 * reference, no queue, no owner, no promised date and no retention rule. Nothing
 * technical can route a direct message backwards, so the wording sends anything
 * needing a record back to Contact Support. It has to be in the message rather
 * than in a plan.
 *
 * **`null` says nothing about staffing.** "No manager is assigned to your
 * region" is an operational fact a teacher can do nothing with, and it is not
 * theirs to worry about — they get the support contact, which is the same thing
 * they would have got before this feature existed.
 *
 * A manager with no published handle is still named. `null` there means "not
 * published" rather than "unknown" (D47), and a name plus the support contact is
 * more than a teacher had yesterday.
 */
export function regionManagerReply(
  manager: RegionManager | null,
  supportContact: string,
): Reply {
  if (manager === null) {
    return {
      text: [
        '📞 *Getting help*',
        '',
        `For anything about your recruitment or your placement, contact ${supportContact}.`,
        '',
        'To open a case that our staff will track and answer, use Contact Support —',
        'that is the route that gets you a reference number.',
      ].join('\n'),
      keyboard: backToMenuKeyboard(),
    };
  }

  const named = manager.name ?? 'Our regional manager';

  return {
    text: [
      `👤 *${manager.region}*`,
      '',
      manager.telegramUsername === null
        ? `${named} covers your region.`
        : `${named} covers your region — @${manager.telegramUsername}`,
      '',
      '**Please use Contact Support for anything that needs answering properly.**',
      'A message sent directly has no case number, is not tracked, and nobody else',
      'can pick it up if they are away.',
      '',
      `For anything else, contact ${supportContact}.`,
    ].join('\n'),
    keyboard: backToMenuKeyboard(),
  };
}

/** `/privacy`, which must work whether or not the teacher has signed in. */
export function privacyReply(supportContact: string, periods: RetentionPeriods): Reply {
  return { text: privacyNotice(supportContact, periods), keyboard: backToMenuKeyboard() };
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
