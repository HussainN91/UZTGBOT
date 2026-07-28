import { describe, expect, it } from 'vitest';
import { PRIVACY_NOTICE_VERSION, privacyNotice } from './privacy.js';

const CONTACT = 'support@mopse.uz';

describe('the privacy notice', () => {
  it('interpolates the support contact, which is the access and removal route', () => {
    expect(privacyNotice(CONTACT)).toContain(CONTACT);
  });

  it('leaves no placeholder behind when it does', () => {
    expect(privacyNotice(CONTACT)).not.toMatch(/\{|\}/);
  });

  it('has a non-empty version, because acceptances are recorded against it', () => {
    expect(PRIVACY_NOTICE_VERSION.trim()).not.toBe('');
  });

  it('names the data held, its use, and who sees it', () => {
    const notice = privacyNotice(CONTACT).toLowerCase();
    for (const required of ['email', 'message', 'case', 'staff']) {
      expect(notice).toContain(required);
    }
  });

  /**
   * BOT-SPEC.md:243 — RETENTION_DAYS is still unset, so data is retained
   * indefinitely and "the notice wording must not contradict" that. A notice
   * promising deletion after a period nobody has chosen is a statement the
   * system cannot honour, and it is the kind of wording that gets pasted in
   * early and never revisited.
   */
  it('does not promise a retention period, because none has been decided', () => {
    expect(privacyNotice(CONTACT)).not.toMatch(/\b\d+\s*(day|month|year)s?\b/i);
  });

  it('says plainly how long data is kept instead of staying silent on it', () => {
    expect(privacyNotice(CONTACT).toLowerCase()).toContain('until');
  });
});
