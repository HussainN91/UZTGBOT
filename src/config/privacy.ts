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
 * `2026-07-30.1` was the stage 5 rewrite: the retention paragraph began stating
 * real periods, which is what the wording before it promised would happen.
 *
 * `2026-08-01.1` names identity disputes, ahead of Feature A building them. Two
 * sentences, approved by the head of project on 1 August 2026, and deliberately
 * made **before** the feature: a wording change asks every teacher who has
 * already signed in to accept again, and doing it now costs one round from a
 * pilot of eight rather than one round from everybody after launch — on top of
 * the round the change would have needed anyway.
 *
 * `2026-08-02.1` carries two corrections that the 2 August audit found, and it
 * carries them **together** on purpose. Each bump asks every signed-in teacher
 * to read and accept the notice again, so two commits to this file would have
 * been two rounds of asking; and the same argument as `2026-08-01.1` applies
 * with more force now, because it is one teacher today and 1,800 after launch.
 *
 * The first correction is that the notice claimed the bot holds "your name as
 * Telegram supplies it". **It has never captured a Telegram name.** The name it
 * holds is copied from the Ministry's recruitment records, and has been since
 * the first version of this file. A legal statement that describes data the
 * system does not collect is wrong in the direction that matters least, but it
 * is still wrong, and it is the sentence a teacher would quote back.
 *
 * The second is that every heading in here was wrapped in asterisks intended as
 * Telegram bold, and **nothing in this bot has ever turned Telegram formatting
 * on**, so teachers have been reading the punctuation. The markers are gone
 * rather than the formatting turned on: see the commit for that argument. A test
 * below asserts the notice contains no asterisk, because nothing protected this.
 *
 * `2026-08-03.1` is a rewording, and one change of substance inside it.
 *
 * The rewording was asked for on 3 August 2026 — *"the core of the message is
 * fine i just don't like the way it is written"* — so what is held, what it is
 * used for, who can see it and how long it is kept all say the same things
 * afterwards. Three sentences that hung a clause off a dash became two sentences
 * each; the headings stopped describing a filing cabinet with nobody at it; and
 * the hand-wrapped lines went, because Telegram wraps for itself and a paragraph
 * wrapped twice comes out ragged on a phone.
 *
 * The change of substance is the access-and-removal route. It named the support
 * contact alone and now names **the regional admin first**, which is a person a
 * teacher can reach and the one already handling their cases. The support number
 * stays under it for the teacher who has no recorded region, because for them
 * the first line names nobody.
 *
 * It cost a round of re-acceptance from every teacher who had already signed in,
 * and it was done in the same pass as the sign-in prompt rather than separately
 * for exactly that reason. Eight teachers on the day; 1,800 after launch.
 */
export const PRIVACY_NOTICE_VERSION = '2026-08-03.1';

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
    '🔒 Privacy notice',
    '',
    'Please read this before you sign in.',
    '',
    /**
     * "What we keep", not "What is held" — and the same change runs through
     * every heading below.
     *
     * The passive voice was describing a filing cabinet with nobody standing at
     * it. A teacher reading a privacy notice is asking who has their email
     * address, and a sentence with no subject declines to say. The Ministry
     * holds it, so the notice now says we.
     *
     * The wording throughout was rewritten on 3 August 2026 at the head of
     * project's request. **Nothing it promises changed** — every item, purpose,
     * period and route below is the one that was there before.
     */
    'What we keep',
    '• The recruitment email address you sign in with.',
    /**
     * Corrected 2 August 2026. This said "your Telegram chat id, and your name as
     * Telegram supplies it", and the second half had never been true — no path
     * into this system reads a Telegram display name, and the name on a teacher's
     * record is the one copied from the recruitment spreadsheet by the roster
     * sync. Saying so plainly is worth the extra line: a teacher who has been
     * told the bot holds their Telegram name has been told something about
     * themselves that is not so.
     */
    /**
     * Two sentences where there was one hung off a dash. The dash was carrying
     * the correction — that we do *not* hold a Telegram name — as an aside, and
     * it is the part a teacher is most likely to have assumed wrongly.
     */
    '• Your Telegram chat id. We do not keep your Telegram display name. The name we hold for you is the one on the Ministry’s recruitment records.',
    '• The messages you send to this bot, and the cases you open.',
    '',
    'What we use it for',
    'To confirm you are a teacher the Ministry recruited, and to answer the cases you raise. Nothing else.',
    '',
    'Who can see it',
    'Ministry support staff working on your case. We do not share it outside the Ministry. It is held on a server in Uzbekistan.',
    /**
     * A blank line that did not need to be here before. Both paragraphs were
     * hand-wrapped, so the eye found the break anyway; now that each is one long
     * line, Telegram runs them together into a wall.
     */
    '',
    /**
     * Added 1 August 2026, before Feature A rather than after it.
     *
     * A dispute over who an account belongs to is **not a case**, so "staff
     * working your case" did not cover it — and what staff are shown to settle
     * one is the other chat's Telegram id and display name, which is one
     * teacher's data being read by somebody working on another's claim.
     *
     * Written before the feature exists, and that is the whole point of the
     * timing: a wording change asks every teacher who has already signed in to
     * accept again, which is one round now against one round afterwards on top
     * of the one this would have needed anyway.
     *
     * Narrowed on 2 August 2026, in the same pass as the display-name
     * correction above and for the same reason. "Both accounts’ Telegram
     * details" was true but wide enough for a teacher to read display names into
     * it, which is the thing this notice has just stopped claiming. What a
     * reviewer is actually shown is each account's chat id, when it first
     * appeared, and when it was last active — so the notice says that.
     */
    'If someone else tries to sign in as you, our staff see each account’s Telegram chat id, when it first appeared and when it was last used. That is how they decide which account is yours.',
    '',
    'How long we keep it',
    ...retentionParagraph(periods),
    '',
    /**
     * "including any dispute over who an account belongs to" — added 1 August
     * 2026 with the sentence above.
     *
     * The retention paragraph states three periods, and a dispute record is none
     * of them. This line nearly covered it already, since a dispute *is* a
     * decision about access — but "nearly" is not a thing to leave in a legal
     * statement, and naming it costs eleven words.
     */
    'We keep a permanent record of the decisions our staff make about your access, including any dispute over who an account belongs to. That record does not include your messages. It is there so we can always say who did what.',
    '',
    'Asking what we hold, or asking us to delete it',
    /**
     * The regional admin, named as the route — the head of project's decision on
     * 3 August 2026, replacing the support number that stood here alone.
     *
     * It is the better first answer. A regional admin is a person a teacher can
     * actually reach, and they are the staff member already handling that
     * teacher's cases, so the request lands with somebody who can act on it
     * rather than at a switchboard.
     *
     * **The number stays underneath it, and that is not caution.** This system
     * has a real state in which a teacher has no recorded region — `/case`
     * prints "region not recorded" against it, and it means every staff member
     * can see their case because no one region owns it. For that teacher
     * "your regional admin" names nobody at all. The same is true of a teacher
     * whose access has ended, which is exactly when somebody asks to be
     * forgotten. `supportContact` is validated at start-up and cannot be a
     * placeholder, so the second line is always a route that exists.
     */
    'Contact your regional admin: the staff member responsible for the region you work in.',
    `If you do not know who that is, contact ${supportContact}.`,
    '',
    `You can read this notice at any time with /privacy. All times are ${TIMEZONE}.`,
  ].join('\n');
}
