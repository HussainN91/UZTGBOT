/**
 * The privacy notice, and the version teachers are recorded as having accepted.
 *
 * A legal statement about what data is held, so it lives in git where it is
 * reviewed and diffable — the same reasoning as TIMEZONE. An environment
 * variable can be blank, and a blank privacy notice shown immediately before
 * collecting an email address is exactly the failure this is meant to prevent.
 *
 * Bump PRIVACY_NOTICE_VERSION in the same commit as any wording change. The
 * version is recorded against each acceptance, so "who agreed to what" survives
 * a revision — a timestamp alone cannot answer that.
 */
import { TIMEZONE } from './constants.js';

export const PRIVACY_NOTICE_VERSION = '2026-07-28.1';

/**
 * `supportContact` is validated at start-up and cannot be a placeholder, so the
 * access-and-removal route in the text below is always a real one. That check is
 * what makes it safe to state the route as plainly as this.
 *
 * On retention: BOT-SPEC.md:243 records that `RETENTION_DAYS` is unset and that
 * the wording "must not contradict" indefinite retention. So this says data is
 * kept until MoPSE sets a period, rather than naming one. Saying nothing at all
 * would be the worse option — it reads as a decision having been made.
 */
export function privacyNotice(supportContact: string): string {
  return [
    '🔒 *Privacy notice*',
    '',
    'Before you sign in, please read this.',
    '',
    '*What is held*',
    '• The recruitment email address you use to verify.',
    '• Your Telegram chat id, and your name as Telegram supplies it.',
    '• The messages you send to this bot, and the support cases you open.',
    '',
    '*What it is used for*',
    'Confirming you are a teacher recruited by the Ministry, and answering the',
    'support cases you raise. It is not used for anything else.',
    '',
    '*Who can see it*',
    'Ministry support staff working your case. It is not shared outside the',
    'Ministry, and it is held on a server located in Uzbekistan.',
    '',
    '*How long it is kept*',
    'Until the Ministry sets a retention period. When one is set, this notice',
    'will be updated and you will be asked to read it again.',
    '',
    '*Access and removal*',
    `To ask what is held about you, or to ask for it to be removed, contact ${supportContact}.`,
    '',
    `You can read this notice at any time with /privacy. All times are ${TIMEZONE}.`,
  ].join('\n');
}
