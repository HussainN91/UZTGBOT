import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PRIVACY_NOTICE_VERSION, privacyNotice } from './privacy.js';
import type { RetentionPeriods } from './retention.js';

const CONTACT = 'support@mopse.uz';

const SET: RetentionPeriods = { caseDays: 7, urgentCaseDays: 180, messageDays: 3 };
const INDEFINITE: RetentionPeriods = { caseDays: null, urgentCaseDays: null, messageDays: null };

describe('the privacy notice', () => {
  it('interpolates the support contact, which is the access and removal route', () => {
    expect(privacyNotice(CONTACT, SET)).toContain(CONTACT);
  });

  it('leaves no placeholder behind when it does', () => {
    expect(privacyNotice(CONTACT, SET)).not.toMatch(/\{|\}/);
  });

  it('has a non-empty version, because acceptances are recorded against it', () => {
    expect(PRIVACY_NOTICE_VERSION.trim()).not.toBe('');
  });

  it('names the data held, its use, and who sees it', () => {
    const notice = privacyNotice(CONTACT, SET).toLowerCase();
    for (const required of ['email', 'message', 'case', 'staff']) {
      expect(notice).toContain(required);
    }
  });

  /**
   * The 3 August 2026 rewrite, held from the outside.
   *
   * A rewording is the one kind of change where every existing test can stay
   * green while a promise quietly disappears — the notice would still mention
   * email, cases and staff with an entire section missing. So each promise is
   * asserted by the thing it actually says rather than by a keyword that
   * survives anything.
   */
  it('still makes every promise it made before it was reworded', () => {
    const notice = privacyNotice(CONTACT, SET);

    // What we keep.
    expect(notice).toContain('recruitment email address');
    expect(notice).toContain('Telegram chat id');
    expect(notice).toMatch(/do not keep your Telegram display name/i);
    // Who can see it, and where it lives.
    expect(notice).toMatch(/not share it outside the Ministry/i);
    expect(notice).toContain('Uzbekistan');
    // The dispute disclosure, added before the feature that needed it.
    expect(notice).toMatch(/someone else tries to sign in as you/i);
    // The permanent access record, which is none of the three periods.
    expect(notice).toMatch(/permanent record/i);
    // Reading it again, at any time.
    expect(notice).toContain('/privacy');
  });

  /**
   * The route out, which is the one section a teacher needs when they are
   * unhappy — and therefore the one most worth a test of its own.
   *
   * Both lines are asserted. The regional admin is the answer for a teacher who
   * has a region; the contact is the answer for one who has none, and this
   * system has that state on purpose.
   */
  it('gives a teacher with no region a route out as well as one who has a region', () => {
    const notice = privacyNotice(CONTACT, SET);
    expect(notice).toMatch(/contact your regional admin/i);
    expect(notice).toContain(CONTACT);
  });

  /**
   * Not a style rule. The dash was carrying load-bearing clauses — that we do
   * *not* hold a Telegram name, and that the permanent record excludes messages
   * — as asides, which is the wrong place for the part a teacher would be most
   * surprised by. Each is its own sentence now, and this keeps it that way.
   */
  it('hangs nothing important off a dash', () => {
    expect(privacyNotice(CONTACT, SET)).not.toContain('—');
  });

  /**
   * A budget, because length is the whole reason this notice was rewritten.
   *
   * A MoPSE employee reported the bot as overwhelming, with too much writing.
   * Measured on 5 August 2026, this notice was 1,524 characters and it is shown
   * three times: inside the sign-in prompt, on `/privacy`, and again when a
   * retention period moves. Those three messages were 4,913 of the 10,202
   * characters the bot says to a teacher, and the first is the second message a
   * new teacher ever sees.
   *
   * **The number is the point, and no other test in this file can hold it.**
   * Every one above asserts that a promise is still *present*, so all of them
   * stay green while the notice grows back one careful clause at a time. That is
   * exactly how it reached 1,524 in the first place: four rewrites, each adding
   * a sentence that was worth adding on its own.
   *
   * **Both retention states are asserted, and that is not symmetry for its own
   * sake.** The first run of this test failed at 1,401 against a 1,400 budget,
   * on the *unset* periods rather than the real ones: "until the Ministry sets a
   * period", rendered three times, is longer than three numbers of days. So the
   * longest this notice can ever be is the state the system sits in between a
   * deploy and the runbook's settings insert, which is also the state nobody
   * reads while checking their wording. Measured after the trim: 1,294 with the
   * periods set, 1,370 without.
   *
   * **1,400, against 1,524 before the rewrite.** The cut is 230 characters and
   * no more, because what is left is eight separate promises in sentences that
   * are already short. A budget of 1,000 could only be met by dropping one of
   * them, and a test that can only be satisfied by breaking a legal statement is
   * worse than no test. The room above 1,370 is for a promise the Ministry
   * genuinely has to add. Anything past it is a decision somebody should have to
   * make deliberately, which is what failing here forces.
   */
  it('stays inside its length budget, in every retention state', () => {
    expect(privacyNotice(CONTACT, SET).length).toBeLessThanOrEqual(1_400);
    expect(privacyNotice(CONTACT, INDEFINITE).length).toBeLessThanOrEqual(1_400);
  });
});

/**
 * These four replace the stage 3 test `does not promise a retention period,
 * because none has been decided`.
 *
 * That test was correct for as long as `RETENTION_DAYS` was unset and
 * BOT-SPEC.md:243 required the wording not to contradict indefinite retention.
 * Plan D28 decided the periods and R17 said this test inverts in stage 5, in the
 * same commit as the wording. This is that commit. It is replaced rather than
 * deleted, because the property it was protecting — the notice never states a
 * period the system will not honour — is still the property, and it is now
 * enforced from the other side.
 */
describe('the retention paragraph', () => {
  it('states the numbers it was given', () => {
    const notice = privacyNotice(CONTACT, SET);
    expect(notice).toContain('7 days');
    expect(notice).toContain('180 days');
    expect(notice).toContain('3 days');
  });

  it('says data is kept until a period is set, when one is not', () => {
    /**
     * D30's consequence, said to a teacher rather than implied. An unset period
     * means the job deletes nothing, so a notice naming a number would be false
     * — and this is the state the system is in between the deploy and the
     * runbook's settings insert.
     */
    const notice = privacyNotice(CONTACT, INDEFINITE);
    expect(notice).not.toMatch(/\b\d+\s*(day|month|year)s?\b/i);
    expect(notice.toLowerCase()).toContain('until');
  });

  it('names each period separately, so one unset period does not hide the others', () => {
    // The likeliest real misconfiguration: somebody seeds two keys and mistypes
    // the third. The notice must then be true about all three.
    const notice = privacyNotice(CONTACT, { ...SET, messageDays: null });
    expect(notice).toContain('7 days');
    expect(notice).toContain('180 days');
    expect(notice).not.toContain('3 days');
  });

  it('cannot disagree with the settings, because there is no second copy', () => {
    /**
     * The property the whole design rests on (D28, R20). A settings row and a
     * hard-coded sentence can disagree; a sentence generated from the row
     * cannot. This asserts it structurally rather than by reading the output:
     * there must be no number of days written into the module's own source.
     *
     * It reads the file rather than the rendered notice on purpose. A literal
     * that happens to match the current setting would pass every other test in
     * this file and fail the day somebody changes a period.
     */
    const source = readFileSync(new URL('./privacy.ts', import.meta.url), 'utf8');
    const body = source.replace(/^\s*\*.*$/gm, '').replace(/\/\/.*$/gm, '');
    expect(body).not.toMatch(/\b\d+\s*(day|month|year)s?\b/i);
  });

  /**
   * Nothing in this bot has ever turned Telegram formatting on.
   *
   * `send.ts` has supported it since it was written and no call site anywhere
   * passes it, so a `*heading*` is not a heading — it is two asterisks, read as
   * punctuation, in the one message this system shows before it asks a teacher
   * for an email address. The markers were removed on 2 August 2026 rather than
   * the formatting turned on, because turning it on means escaping every piece
   * of free text in every message that carries one, and a single unescaped
   * character makes Telegram refuse the whole message.
   *
   * This assertion exists because the audit found that nothing protected it:
   * every test that touched this text matched the words *inside* the markers, so
   * the markers could have been added or removed at will and the suite would
   * have said nothing either way.
   */
  it('contains no formatting markers, because no message is ever sent with formatting on', () => {
    expect(privacyNotice(CONTACT, SET)).not.toContain('*');
    expect(privacyNotice(CONTACT, INDEFINITE)).not.toContain('*');
  });

  /**
   * The sentence that had never been true, corrected on 2 August 2026.
   *
   * The notice told every teacher the bot holds "your name as Telegram supplies
   * it". No path into this system has ever read a Telegram display name — the
   * name on a teacher's record is copied from the recruitment spreadsheet. This
   * is a legal statement, so it is asserted rather than left to a reader.
   *
   * The middle assertion moved on 3 August 2026 with the rewrite: the notice
   * said "display name is not stored" and now says "we do not keep your Telegram
   * display name". **The property is unchanged and so is this test's job** — the
   * bot must deny holding a Telegram-supplied name, in whatever words the notice
   * currently uses. Only the phrasing being matched was updated, because only
   * the phrasing moved.
   */
  it('does not claim to hold a name that Telegram supplies', () => {
    const notice = privacyNotice(CONTACT, SET);

    expect(notice).not.toMatch(/name as Telegram supplies/i);
    expect(notice).toMatch(/do not keep your Telegram display name/i);
    expect(notice).toMatch(/recruitment records/i);
  });

  it('says what is kept permanently, rather than listing only the deletions', () => {
    // A notice that describes what goes and stays silent about what stays is
    // quietly incomplete. audit_log is never pruned (D28) and teachers should
    // be able to read that.
    expect(privacyNotice(CONTACT, SET).toLowerCase()).toContain('permanent');
  });
});
