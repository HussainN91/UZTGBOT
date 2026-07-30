/**
 * Integration tests for what a teacher is recorded as having agreed to.
 *
 * These columns existed from stage 3 and nothing has ever read them. What makes
 * them worth having is the question they answer after the notice changes: not
 * "did somebody agree to something" but "did this person agree to *this*".
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PRIVACY_NOTICE_VERSION } from '../config/privacy.js';
import { type RetentionPeriods, requiresReconsent } from '../config/retention.js';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import { privacyAcceptance, recordAcceptance } from './privacy.js';
import { bindTeacher, restoreTeacher } from './repository.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const CHAT = '960001';
const IDENTIFIER = 'privacy.tester@example.com';

const SET: RetentionPeriods = { caseDays: 7, urgentCaseDays: 180, messageDays: 3 };
const INDEFINITE: RetentionPeriods = { caseDays: null, urgentCaseDays: null, messageDays: null };

describe.skipIf(!TEST_DATABASE_URL)('the privacy acceptance', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`TRUNCATE cases, teachers, roster_entries, audit_log CASCADE`);
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active)
      VALUES (${IDENTIFIER}, 'Privacy Tester', 'Tashkent', true)
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('is null for a chat that has never signed in', async () => {
    await expect(privacyAcceptance(db, '960099')).resolves.toBeNull();
  });

  it('is null for a teacher bound before the columns existed', async () => {
    // Real rows in production are in exactly this state. Inventing an
    // acceptance for them would be worse than admitting there is none.
    await db.execute(sql`
      INSERT INTO teachers (chat_id, verification_state, identifier, name)
      VALUES (${CHAT}, 'Verified', ${IDENTIFIER}, 'Privacy Tester')
    `);
    await expect(privacyAcceptance(db, CHAT)).resolves.toBeNull();
  });

  it('records all five columns together', async () => {
    await db.execute(sql`
      INSERT INTO teachers (chat_id, verification_state, identifier, name)
      VALUES (${CHAT}, 'Verified', ${IDENTIFIER}, 'Privacy Tester')
    `);

    await expect(recordAcceptance(db, CHAT, '2026-07-30.1', SET)).resolves.toBe(true);
    await expect(privacyAcceptance(db, CHAT)).resolves.toEqual({
      version: '2026-07-30.1',
      periods: SET,
    });
  });

  it('reports false for a chat that does not exist, rather than inventing a row', async () => {
    await expect(recordAcceptance(db, '960098', '2026-07-30.1', SET)).resolves.toBe(false);
  });

  describe('signing in', () => {
    it('records the periods the notice stated, not only its version', async () => {
      /**
       * Without this, every teacher who signs in is asked to re-accept on their
       * very next tap — having accepted moments earlier, because replying with
       * an identifier *is* the acknowledgement. R11's shape one column-set
       * along: `bindTeacher`'s `set` object is where a field gets forgotten.
       */
      await bindTeacher(db, {
        chatId: CHAT,
        identifier: IDENTIFIER,
        name: 'Privacy Tester',
        region: 'Tashkent',
        privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
        privacyAcceptedPeriods: SET,
      });

      const accepted = await privacyAcceptance(db, CHAT);
      expect(accepted).toEqual({ version: PRIVACY_NOTICE_VERSION, periods: SET });
      expect(
        requiresReconsent(accepted, { version: PRIVACY_NOTICE_VERSION, periods: SET }),
      ).toBe(false);
    });

    it('records an indefinite acceptance when no period is set', async () => {
      // The state between the deploy and the runbook's launch insert. It must
      // be recorded as indefinite rather than as nothing, so that setting a
      // period afterwards reads as the shortening it is.
      await bindTeacher(db, {
        chatId: CHAT,
        identifier: IDENTIFIER,
        name: 'Privacy Tester',
        region: 'Tashkent',
        privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
        privacyAcceptedPeriods: INDEFINITE,
      });

      const accepted = await privacyAcceptance(db, CHAT);
      expect(accepted?.periods).toEqual(INDEFINITE);
      expect(
        requiresReconsent(accepted, { version: PRIVACY_NOTICE_VERSION, periods: SET }),
      ).toBe(false);
    });
  });

  describe('restoring a revoked teacher', () => {
    it('leaves the acceptance exactly as it was', async () => {
      /**
       * D27: restoring somebody is undoing one act, not re-running their
       * sign-in. A `/restore` that cleared these columns would push that teacher
       * through a re-consent nobody asked for, on top of a revocation somebody
       * had just decided was a mistake.
       */
      await bindTeacher(db, {
        chatId: CHAT,
        identifier: IDENTIFIER,
        name: 'Privacy Tester',
        region: 'Tashkent',
        privacyNoticeVersion: '2026-07-30.1',
        privacyAcceptedPeriods: SET,
      });
      await db.execute(
        sql`UPDATE teachers SET verification_state = 'Revoked', revoked_at = now() WHERE chat_id = ${CHAT}`,
      );

      await restoreTeacher(db, CHAT, '969001');

      await expect(privacyAcceptance(db, CHAT)).resolves.toEqual({
        version: '2026-07-30.1',
        periods: SET,
      });
    });
  });
});
