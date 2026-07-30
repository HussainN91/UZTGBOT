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

  it('says what is kept permanently, rather than listing only the deletions', () => {
    // A notice that describes what goes and stays silent about what stays is
    // quietly incomplete. audit_log is never pruned (D28) and teachers should
    // be able to read that.
    expect(privacyNotice(CONTACT, SET).toLowerCase()).toContain('permanent');
  });
});
