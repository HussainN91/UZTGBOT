import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

/** A configuration that should always be accepted, so each test varies one thing. */
const valid = {
  DATABASE_URL: 'postgres://mopse:pw@localhost:5432/mopse',
  TELEGRAM_BOT_TOKEN: '8100000000:AAH1234567890abcdefghijklmnopqrstuvw',
  TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(48),
  PUBLIC_URL: 'https://bot.example.uz',
  SUPPORT_CONTACT: '+998 71 000 00 00',
} satisfies NodeJS.ProcessEnv;

describe('start-up configuration', () => {
  it('accepts a complete configuration and applies defaults', () => {
    const env = loadEnv(valid);
    expect(env.PORT).toBe(8080);
    expect(env.NODE_ENV).toBe('development');
  });

  it('reports every problem at once, not one per restart', () => {
    let message = '';
    try {
      loadEnv({});
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('TELEGRAM_BOT_TOKEN');
    expect(message).toContain('SUPPORT_CONTACT');
  });

  describe('the support contact cannot stay a placeholder', () => {
    /**
     * The Apps Script version shipped
     * `SUPPORT_CONTACT_INFO = 'PLACEHOLDER_SUPPORT_CONTACT — replace with…'`
     * and the runbook listed replacing it as a pre-launch blocker, where it was
     * still sitting unreplaced when the rebuild started. A blocker that depends
     * on somebody remembering is not a control; refusing to boot is.
     */
    it('rejects the exact placeholder the old code shipped with', () => {
      expect(() =>
        loadEnv({ ...valid, SUPPORT_CONTACT: 'PLACEHOLDER_SUPPORT_CONTACT — replace with a real MoPSE support/HR email or phone number' }),
      ).toThrow(/still a placeholder/);
    });

    it('rejects a placeholder whatever its case', () => {
      expect(() => loadEnv({ ...valid, SUPPORT_CONTACT: 'placeholder' })).toThrow(/still a placeholder/);
    });

    it('rejects an empty contact', () => {
      expect(() => loadEnv({ ...valid, SUPPORT_CONTACT: '   ' })).toThrow();
    });

    it('accepts a real contact', () => {
      expect(loadEnv({ ...valid, SUPPORT_CONTACT: 'support@mopse.uz' }).SUPPORT_CONTACT).toBe('support@mopse.uz');
    });
  });

  describe('the webhook secret', () => {
    it('refuses a short secret', () => {
      expect(() => loadEnv({ ...valid, TELEGRAM_WEBHOOK_SECRET: 'tooshort' })).toThrow(/at least 32/);
    });

    it('refuses characters Telegram will not accept, rather than failing silently at runtime', () => {
      expect(() => loadEnv({ ...valid, TELEGRAM_WEBHOOK_SECRET: `${'a'.repeat(40)}!$%` })).toThrow(/A-Z/);
    });
  });

  describe('the public URL', () => {
    it('refuses plaintext, which Telegram would reject anyway', () => {
      expect(() => loadEnv({ ...valid, PUBLIC_URL: 'http://bot.example.uz' })).toThrow(/https/);
    });

    it('refuses a trailing slash, which would produce a double slash in the webhook path', () => {
      expect(() => loadEnv({ ...valid, PUBLIC_URL: 'https://bot.example.uz/' })).toThrow(/slash/);
    });
  });

  describe('the operational alert recipient', () => {
    it('is required in production, because it is the only place alarms can go', () => {
      expect(() => loadEnv({ ...valid, NODE_ENV: 'production' })).toThrow(/OPS_ALERT_CHAT_ID/);
    });

    it('explains why, rather than just naming the variable', () => {
      let message = '';
      try {
        loadEnv({ ...valid, NODE_ENV: 'production' });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/only impersonation control/);
    });

    it('is optional in development, where the log is in front of you', () => {
      expect(() => loadEnv({ ...valid, NODE_ENV: 'development' })).not.toThrow();
    });

    it('accepts a numeric chat id', () => {
      expect(loadEnv({ ...valid, OPS_ALERT_CHAT_ID: '123456789' }).OPS_ALERT_CHAT_ID).toBe('123456789');
    });

    it('refuses an @username, which the Bot API cannot message reliably', () => {
      expect(() => loadEnv({ ...valid, OPS_ALERT_CHAT_ID: '@ops_channel' })).toThrow(/numeric/);
    });
  });

  it('refuses a bot token that is not shaped like one', () => {
    expect(() => loadEnv({ ...valid, TELEGRAM_BOT_TOKEN: 'not-a-token' })).toThrow(/bot token/);
  });
});
