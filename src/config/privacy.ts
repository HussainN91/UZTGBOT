/**
 * The privacy notice, and the version teachers are recorded as having accepted.
 *
 * A legal statement about what data is held, so the *wording* lives in git where
 * it is reviewed and diffable — the same reasoning as TIMEZONE. An environment
 * variable can be blank, and a blank privacy notice shown immediately before
 * collecting an email address is exactly the failure this is meant to prevent.
 *
 * **The numbers in it are not written here, and that is the point.** The three
 * retention periods are settings MoPSE can change without a deployment (plan
 * D28), and a settings row and a hard-coded sentence can disagree — silently,
 * because nobody is watching for it. A sentence generated from the row cannot.
 * `privacyNotice` therefore takes the periods and renders them, and a test reads
 * this file's own source to assert no number of days is typed into it.
 *
 * Bump PRIVACY_NOTICE_VERSION in the same commit as any wording change. See
 * below for what it does and does not cover.
 */
import { TIMEZONE } from './constants.js';
import type { RetentionPeriods } from './retention.js';

/**
 * The version of **the wording**, and only the wording.
 *
 * It does not cover the periods. The notice's numbers come from settings and can
 * change with no deploy, no review and nobody bumping anything — so the periods
 * a teacher accepted are recorded separately, on their own row, and
 * `requiresReconsent` in `retention.ts` reads both. Assuming this string covers
 * the whole notice is the mistake that would let a lengthened period go out
 * without anybody being asked (R17, R20).
 *
 * `2026-07-30.1` is the stage 5 rewrite: the retention paragraph now states real
 * periods, which is what the previous wording promised would happen.
 */
export const PRIVACY_NOTICE_VERSION = '2026-07-30.1';

/**
 * One line of the retention paragraph.
 *
 * Rendered per class rather than as one sentence covering all three, so that a
 * single unset period says so on its own line instead of making the whole
 * paragraph vague. The likeliest real misconfiguration is two keys seeded and
 * the third mistyped, and the notice has to stay true in that state.
 */
function keptFor(what: string, days: number | null): string {
  return days === null
    ? `• ${what}: kept until the Ministry sets a period.`
    : `• ${what}: ${days} days.`;
}

/**
 * The retention paragraph, as the teacher reads it.
 *
 * Exported because `/retention` shows a System member what the notice will say
 * before and after they change a period. That has to be *this* text and not a
 * second rendering of the same idea — a command that describes the periods in
 * its own words is the second copy this whole module exists to prevent, and it
 * would drift on the first wording change.
 */
export function retentionParagraph(periods: RetentionPeriods): string[] {
  return [
    'A case stays while it is open, however long that takes. Once it is finished:',
    keptFor('cases', periods.caseDays),
    keptFor('cases treated as urgent', periods.urgentCaseDays),
    keptFor('the messages you send', periods.messageDays),
    'When a case is deleted, everything written about it goes with it.',
  ];
}

/**
 * `supportContact` is validated at start-up and cannot be a placeholder, so the
 * access-and-removal route in the text below is always a real one. That check is
 * what makes it safe to state the route as plainly as this.
 *
 * `periods` is read from settings by the caller. `null` in any position means
 * that class of record is kept indefinitely, which is exactly what the deletion
 * job does with it — an unset period deletes nothing (D30). The notice and the
 * job therefore describe the same behaviour by construction rather than by
 * somebody keeping them in step.
 */
export function privacyNotice(supportContact: string, periods: RetentionPeriods): string {
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
    ...retentionParagraph(periods),
    '',
    'A record of decisions our staff make about access — not your messages — is',
    'kept permanently, so we can always answer who did what.',
    '',
    '*Access and removal*',
    `To ask what is held about you, or to ask for it to be removed, contact ${supportContact}.`,
    '',
    `You can read this notice at any time with /privacy. All times are ${TIMEZONE}.`,
  ].join('\n');
}
