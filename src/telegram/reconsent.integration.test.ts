/**
 * The teacher's re-consent gate — Task 65, D31 and D32.
 *
 * **The only change in this stage that reaches all 1,800 teachers**, and the one
 * thing in it a person will notice. Most of what is asserted here is therefore
 * about what the gate does *not* do: it does not touch the answer bank, it does
 * not ask twice, it does not cost a teacher their place, and it does not record
 * an acceptance for text nobody saw.
 *
 * The property that makes the record worth having is the last one. "We showed it
 * to them" is not a record; "this named teacher confirmed this version, with
 * these three numbers in it, on this date" is — and a period is a settings row a
 * System member can change while a teacher is reading.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CALLBACK_DATA_MAX_BYTES } from '../config/constants.js';
import { PRIVACY_NOTICE_VERSION } from '../config/privacy.js';
import { renderPeriodsField } from '../config/retention.js';
import { clearSettingsCache, retentionPeriods, setSetting } from '../config/settings.js';
import { withChatLock } from '../conversation/lock.js';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import { privacyAcceptance, recordAcceptance } from '../teachers/privacy.js';
import { CALLBACK, byteLength, encodeCallback } from './callback-data.js';
import { MENU_ACTION } from './keyboards.js';
import { route, type InboundUpdate, type RouterOutcome } from './router.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const SUPPORT = '+998 71 000 0000';

/** Signed in long ago, under the wording that promised to ask again. */
const TEACHER = '996101';
/** Signed in and has accepted whatever is current. */
const UP_TO_DATE = '996102';
/** Never signed in at all. */
const STRANGER = '996103';

const OLD_VERSION = '2026-07-28.1';

describe.skipIf(!TEST_DATABASE_URL)('the re-consent gate', () => {
  let pool: pg.Pool;
  let db: Database;

  const send = (update: InboundUpdate): Promise<RouterOutcome> =>
    withChatLock(db, update.chatId, (tx) => route(tx, update, { supportContact: SUPPORT }));

  const taps = async (data: string, chatId = TEACHER): Promise<string> =>
    (await send({ chatId, kind: 'callback', text: data })).messages[0]?.text ?? '';

  const menu = (action: string, chatId = TEACHER): Promise<string> =>
    taps(encodeCallback(CALLBACK.MENU, action), chatId);

  /** The accept button as the bot would build it, from what is current. */
  const acceptButton = async (): Promise<string> =>
    encodeCallback(
      CALLBACK.PRIVACY_ACCEPTED,
      PRIVACY_NOTICE_VERSION,
      renderPeriodsField(await retentionPeriods(db)),
    );

  const stateOf = async (chatId: string): Promise<string | null> => {
    const rows = await db.execute<{ state: string }>(
      sql`SELECT state FROM conversation_states WHERE chat_id = ${chatId}`,
    );
    return rows.rows[0]?.state ?? null;
  };

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`
      TRUNCATE cases, case_notes, teachers, roster_entries, case_sequences,
               conversation_states, messages, faq_entries, urgent_codes,
               urgent_code_attempts, processed_updates, settings, staff,
               audit_log CASCADE
    `);
    clearSettingsCache();

    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active) VALUES
        ('old@example.com', 'Old Teacher', 'Tashkent', true),
        ('new@example.com', 'New Teacher', 'Tashkent', true)
    `);
    await db.execute(sql`
      INSERT INTO teachers (chat_id, identifier, name, region, verification_state) VALUES
        (${TEACHER},    'old@example.com', 'Old Teacher', 'Tashkent', 'Verified'),
        (${UP_TO_DATE}, 'new@example.com', 'New Teacher', 'Tashkent', 'Verified')
    `);

    // Accepted the *previous* wording, which is the situation every teacher in
    // production is in on the morning this ships.
    await recordAcceptance(db, TEACHER, OLD_VERSION, await retentionPeriods(db));
    await recordAcceptance(db, UP_TO_DATE, PRIVACY_NOTICE_VERSION, await retentionPeriods(db));
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('who is asked', () => {
    it('asks a teacher who accepted the old wording', async () => {
      const body = await menu(MENU_ACTION.CONTACT_SUPPORT);

      expect(body).toMatch(/how long your information is kept/i);
      expect(body).toContain('Privacy notice');
    });

    it('asks on all three gated actions and nowhere else', async () => {
      for (const action of [
        MENU_ACTION.CONTACT_SUPPORT,
        MENU_ACTION.URGENT_CASE,
        MENU_ACTION.CHECK_CASE,
      ]) {
        expect(await menu(action)).toContain('Privacy notice');
      }
    });

    it('leaves the answer bank open', async () => {
      /**
       * The FAQ has always been open, and maintenance mode deliberately leaves
       * it running. A teacher looking up a published answer is not somebody we
       * are collecting anything from, and gating it would be the one change that
       * made the bot less useful to somebody who had done nothing.
       */
      expect(await menu(MENU_ACTION.FAQ)).not.toContain('Privacy notice');
      expect(await menu(MENU_ACTION.MAIN)).not.toContain('Privacy notice');
    });

    it('does not ask a teacher who has accepted what is current', async () => {
      expect(await menu(MENU_ACTION.CONTACT_SUPPORT, UP_TO_DATE)).not.toContain('Privacy notice');
    });

    it('does not ask an unverified chat anything extra', async () => {
      /**
       * They have accepted nothing and are about to be shown the notice by the
       * sign-in prompt, which *is* the acknowledgement. Two notices in a row is
       * one notice nobody reads.
       */
      const body = await menu(MENU_ACTION.CONTACT_SUPPORT, STRANGER);

      expect(body).toContain('email address you were recruited with');
      expect(await stateOf(STRANGER)).toBe('AwaitingIdentifier');
    });

    it('does not ask when a period was only shortened', async () => {
      // D28: deleting sooner than promised breaks no commitment to anybody, and
      // forcing 1,800 people through a re-consent to be told their data goes
      // sooner is a cost with no beneficiary.
      await recordAcceptance(db, UP_TO_DATE, PRIVACY_NOTICE_VERSION, {
        caseDays: 30,
        urgentCaseDays: 180,
        messageDays: 3,
      });
      await setSetting(db, 'CASE_RETENTION_DAYS', '7');
      await setSetting(db, 'URGENT_CASE_RETENTION_DAYS', '180');
      await setSetting(db, 'MESSAGE_RETENTION_DAYS', '3');

      expect(await menu(MENU_ACTION.CONTACT_SUPPORT, UP_TO_DATE)).not.toContain('Privacy notice');
    });

    it('asks when a period was lengthened, without any wording change', async () => {
      // R20. This is the path that has no deploy and no review behind it — a
      // settings row somebody edited — and it is the whole reason the accepted
      // periods are recorded beside the accepted wording.
      await recordAcceptance(db, UP_TO_DATE, PRIVACY_NOTICE_VERSION, {
        caseDays: 7,
        urgentCaseDays: 180,
        messageDays: 3,
      });
      await setSetting(db, 'CASE_RETENTION_DAYS', '30');
      await setSetting(db, 'URGENT_CASE_RETENTION_DAYS', '180');
      await setSetting(db, 'MESSAGE_RETENTION_DAYS', '3');

      expect(await menu(MENU_ACTION.CONTACT_SUPPORT, UP_TO_DATE)).toContain('Privacy notice');
    });
  });

  describe('the notice itself', () => {
    it('states the periods a teacher would be agreeing to', async () => {
      await setSetting(db, 'CASE_RETENTION_DAYS', '7');
      await setSetting(db, 'URGENT_CASE_RETENTION_DAYS', '180');
      await setSetting(db, 'MESSAGE_RETENTION_DAYS', '3');

      const body = await menu(MENU_ACTION.CONTACT_SUPPORT);

      expect(body).toContain('7 days');
      expect(body).toContain('180 days');
      expect(body).toContain('3 days');
    });

    it('says what changed before it says anything else', async () => {
      // Step 4. "Our privacy policy has been updated" is the wording every
      // teacher has learned to tap past.
      const body = await menu(MENU_ACTION.CONTACT_SUPPORT);
      const openingLines = body.split('\n').slice(0, 4).join(' ').toLowerCase();

      expect(openingLines).toContain('how long');
      expect(openingLines).not.toContain('policy has been updated');
    });

    it('fits in a callback payload with room to spare, at real values', async () => {
      // Measured rather than reasoned about. Telegram truncates a payload over
      // 64 bytes silently, and a truncated one routes the tap somewhere else.
      await setSetting(db, 'CASE_RETENTION_DAYS', '180');
      await setSetting(db, 'URGENT_CASE_RETENTION_DAYS', '3650');
      await setSetting(db, 'MESSAGE_RETENTION_DAYS', '365');

      const data = await acceptButton();
      expect(byteLength(data)).toBeLessThan(CALLBACK_DATA_MAX_BYTES);
    });
  });

  describe('accepting', () => {
    it('records the version and all three numbers', async () => {
      await setSetting(db, 'CASE_RETENTION_DAYS', '7');
      await setSetting(db, 'URGENT_CASE_RETENTION_DAYS', '180');
      await setSetting(db, 'MESSAGE_RETENTION_DAYS', '3');
      await menu(MENU_ACTION.CONTACT_SUPPORT);

      await taps(await acceptButton());

      expect(await privacyAcceptance(db, TEACHER)).toEqual({
        version: PRIVACY_NOTICE_VERSION,
        periods: { caseDays: 7, urgentCaseDays: 180, messageDays: 3 },
      });
    });

    it('returns them to what they were trying to do', async () => {
      // D32. The resume `AwaitingIdentifier` already carries, reused rather than
      // rebuilt. A gate that costs a teacher their place is a gate they meet
      // twice, and the second time they tap through it unread.
      await menu(MENU_ACTION.URGENT_CASE);
      const body = await taps(await acceptButton());

      expect(body).toContain('one-time code');
    });

    it('returns them to the topic picker after Contact Support', async () => {
      await menu(MENU_ACTION.CONTACT_SUPPORT);
      const body = await taps(await acceptButton());

      expect(body.toLowerCase()).toContain('what is this about');
    });

    it('asks once, and not again', async () => {
      await menu(MENU_ACTION.CONTACT_SUPPORT);
      await taps(await acceptButton());

      expect(await menu(MENU_ACTION.CONTACT_SUPPORT)).not.toContain('Privacy notice');
      expect(await stateOf(TEACHER)).not.toBe('AwaitingPrivacyAcceptance');
    });

    it('shows the notice again when the periods moved under the button', async () => {
      /**
       * R20, at its sharpest. The teacher is holding a button that says "7
       * days"; a System member typed `/retention case 30` while they were
       * reading. Recording an acceptance now would put this teacher's name
       * against numbers they never saw, which is worse than one extra tap.
       */
      await setSetting(db, 'CASE_RETENTION_DAYS', '7');
      await menu(MENU_ACTION.CONTACT_SUPPORT);
      const stale = await acceptButton();

      await setSetting(db, 'CASE_RETENTION_DAYS', '30');
      const body = await taps(stale);

      expect(body).toContain('30 days');
      expect(await privacyAcceptance(db, TEACHER)).toEqual({
        version: OLD_VERSION,
        periods: { caseDays: null, urgentCaseDays: null, messageDays: null },
      });
    });

    it('shows the notice again when the wording moved under the button', async () => {
      await menu(MENU_ACTION.CONTACT_SUPPORT);
      const stale = encodeCallback(
        CALLBACK.PRIVACY_ACCEPTED,
        'some-older-version',
        renderPeriodsField(await retentionPeriods(db)),
      );

      expect(await taps(stale)).toContain('Privacy notice');
      expect((await privacyAcceptance(db, TEACHER))?.version).toBe(OLD_VERSION);
    });

    it('records nothing for a hand-crafted payload with a mangled periods field', async () => {
      // The payload arrives from the network and anybody can write one. A
      // half-read set of periods must never become an acceptance.
      await menu(MENU_ACTION.CONTACT_SUPPORT);
      const body = await taps(`${CALLBACK.PRIVACY_ACCEPTED}:${PRIVACY_NOTICE_VERSION}:7-180`);

      expect(body).toContain('Privacy notice');
      expect((await privacyAcceptance(db, TEACHER))?.version).toBe(OLD_VERSION);
    });

    it('is harmless from a chat that has no teacher row', async () => {
      // A button sitting in somebody's scrollback, tapped by a chat that was
      // never a teacher. It must not report an acceptance it did not make.
      const body = await taps(await acceptButton(), STRANGER);

      expect(body).not.toContain('Thank you');
      expect(await privacyAcceptance(db, STRANGER)).toBeNull();
    });
  });

  describe('the routes that do not go through the menu', () => {
    it('gates a case topic button from an old scrollback', async () => {
      /**
       * A teacher's scrollback keeps every button they were ever sent, so a
       * topic button from before the notice changed is a live route into filing
       * a case that never passes through `MENU:CONTACT_SUPPORT`. Gating only the
       * menu action would leave it open — the same class of hole as the second
       * door into sign-in that `startReply` was found to have.
       */
      const body = await taps(encodeCallback(CALLBACK.CASE_TOPIC, 'VISA'));

      expect(body).toContain('Privacy notice');

      const rows = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM cases`);
      expect(Number(rows.rows[0]?.n)).toBe(0);
    });
  });
});
