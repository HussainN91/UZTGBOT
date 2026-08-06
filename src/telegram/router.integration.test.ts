/**
 * End-to-end tests for the routing pipeline.
 *
 * These drive the same function the webhook drives, against a real database,
 * with no Telegram involved: `route` decides and returns what should be said, so
 * a whole conversation can be played out as a sequence of updates and the
 * database inspected between them.
 *
 * Most of what is checked here was untestable before the rebuild. The state
 * lived in memory, so "the teacher taps twice", "the bot restarts", and "a
 * command arrives mid-conversation" could only be reasoned about.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { clearSettingsCache } from '../config/settings.js';
import { withChatLock } from '../conversation/lock.js';
import { loadState } from '../conversation/state.js';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import { processUpdate } from './bot.js';
import { encodeCallback, CALLBACK } from './callback-data.js';
import { MENU_ACTION } from './keyboards.js';
import { route, type InboundUpdate, type RouterOutcome } from './router.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const CHAT = '980001';
const SECOND_CHAT = '980002';
const IDENTIFIER = 'router.tester@example.com';
const SUPPORT = '+998 71 000 0000';

describe.skipIf(!TEST_DATABASE_URL)('the router', () => {
  let pool: pg.Pool;
  let db: Database;

  /** One update, through the lock and the transaction, exactly as the bot does. */
  const send = async (update: InboundUpdate): Promise<RouterOutcome> =>
    withChatLock(db, update.chatId, (tx) => route(tx, update, { supportContact: SUPPORT }));

  const text = (body: string, chatId = CHAT): Promise<RouterOutcome> =>
    send({ chatId, kind: 'text', text: body });

  const tap = (data: string, chatId = CHAT): Promise<RouterOutcome> =>
    send({ chatId, kind: 'callback', text: data });

  const firstText = (outcome: RouterOutcome): string => outcome.messages[0]?.text ?? '';

  /** Every callback payload on the reply's keyboard, rows flattened. */
  const buttons = (outcome: RouterOutcome): string[] =>
    (outcome.messages[0]?.keyboard ?? []).flatMap((row) => row.map((b) => b.callback_data));

  const SIGN_IN = encodeCallback(CALLBACK.MENU, MENU_ACTION.SIGN_IN);
  const MAIN_MENU = encodeCallback(CALLBACK.MENU, MENU_ACTION.MAIN);

  /**
   * `/start` no longer asks for an address — Part 5F. It opens the menu, and the
   * Sign in button on it is what asks. Every test that needs a signed-in teacher
   * goes through the same three steps a real one does.
   */
  const verify = async (chatId = CHAT): Promise<void> => {
    await text('/start', chatId);
    await tap(SIGN_IN, chatId);
    await text(IDENTIFIER, chatId);
  };

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    /**
     * `identity_disputes` and its parties are truncated here from Feature A
     * onward, and the reason is the fault Part 5H.1 recorded rather than
     * tidiness: **a feature that starts reading a table breaks every test file
     * that does not clean it.** A dispute surviving between tests would collide
     * with the partial unique index on the next duplicate sign-in, and the test
     * that failed would be one that had never heard of disputes.
     */
    await db.execute(sql`
      TRUNCATE cases, teachers, roster_entries, case_sequences, conversation_states,
               messages, faq_entries, urgent_codes, urgent_code_attempts,
               identity_dispute_parties, identity_disputes, staff, audit_log,
               processed_updates, settings, form_links CASCADE
    `);
    clearSettingsCache();
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active)
      VALUES (${IDENTIFIER}, 'Router Tester', 'Tashkent', true)
    `);
    await db.execute(sql`
      INSERT INTO faq_entries (code, topic_code, sheet_row, button_text, keywords, official_answer)
      VALUES
        ('VISA-001', 'VISA', 1, 'How long does a visa take?',
         ARRAY['visa','long','take'], 'Usually fourteen working days.'),
        ('ACCOM-001', 'ACCOM', 1, 'Who pays for my accommodation?',
         ARRAY['accommodation','rent','pays'], 'The school pays the deposit.')
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  /**
   * Part 5F. The front door used to be a sign-in prompt with no way past, which
   * closed the FAQ to the one person who most needs it — somebody who cannot
   * sign in and has a question. `/start` now opens the menu for everybody.
   *
   * The head of project chose the *reduced* menu: an unsigned chat is shown only
   * what works without an account, rather than the whole menu with a Sign in
   * button added. Hiding a button is on top of the gate behind it, never instead
   * of it — a button lives in a scrollback for ever — so the four gated actions
   * are still refused on tap, and `describe('opening a case')` proves it.
   */
  describe('the front door', () => {
    const CONTACT_SUPPORT = encodeCallback(CALLBACK.MENU, MENU_ACTION.CONTACT_SUPPORT);

    it('opens the menu for a chat that has never signed in, and asks for nothing', async () => {
      const outcome = await text('/start');

      expect(buttons(outcome)).toContain(SIGN_IN);
      expect(firstText(outcome)).toContain('without signing in');
      // The defect itself: they used to be held here, and everything they typed
      // afterwards was read as a failed email address.
      expect(await loadState(db, CHAT)).toBeNull();
    });

    it('offers an unsigned chat nothing that would stop and ask for an address', async () => {
      const shown = buttons(await text('/start'));

      for (const gated of [
        MENU_ACTION.CONTACT_SUPPORT,
        MENU_ACTION.URGENT_CASE,
        MENU_ACTION.CHECK_CASE,
        MENU_ACTION.SUBMIT_DOCS,
      ]) {
        expect(shown).not.toContain(encodeCallback(CALLBACK.MENU, gated));
      }
      // And what it does offer is the whole point of the part.
      expect(shown).toContain(encodeCallback(CALLBACK.MENU, MENU_ACTION.FAQ));
      expect(shown).toContain(encodeCallback(CALLBACK.MENU, MENU_ACTION.MY_MANAGER));
    });

    it('gives the same reduced menu from the Home button, not just from /start', async () => {
      /**
       * The trap this part is likeliest to fall into. 🏠 Main Menu draws the menu
       * through `MENU_ACTION.MAIN`, a different path from `/start`, so changing
       * only `/start` would show the reduced menu once and the full one from the
       * teacher's first Home tap onwards.
       */
      await text('/start');
      const home = await tap(MAIN_MENU);

      expect(buttons(home)).toContain(SIGN_IN);
      expect(buttons(home)).not.toContain(CONTACT_SUPPORT);
    });

    it('reaches the answer bank without signing in', async () => {
      await text('/start');
      const answer = await tap(encodeCallback(CALLBACK.ANSWER, 'VISA-001'));

      expect(firstText(answer)).toContain('fourteen working days');
      expect(await loadState(db, CHAT)).toBeNull();
    });

    it('asks for the address only when the Sign in button is tapped', async () => {
      await text('/start');
      const outcome = await tap(SIGN_IN);

      // The notice and the prompt are one message on purpose: replying with an
      // identifier is the acknowledgement, so a teacher cannot scroll past one
      // and answer the other. Moving the notice off the first screen must not
      // move it off the acceptance.
      expect(firstText(outcome)).toContain('recruited with');
      expect(firstText(outcome).toLowerCase()).toContain('privacy');
      expect((await loadState(db, CHAT))?.kind).toBe('AwaitingIdentifier');
    });

    it('opens the full menu once they have signed in', async () => {
      await verify();
      const outcome = await text('/start');

      expect(buttons(outcome)).toContain(CONTACT_SUPPORT);
      expect(buttons(outcome)).not.toContain(SIGN_IN);
      expect(firstText(outcome)).not.toContain('without signing in');
    });

    it('lands a teacher on the full menu when they sign in from the button', async () => {
      await text('/start');
      await tap(SIGN_IN);
      const outcome = await text(IDENTIFIER);

      expect(firstText(outcome)).toContain('Signed in as Router Tester');
      expect(buttons(outcome)).toContain(CONTACT_SUPPORT);
    });

    it('shows a signed-in teacher the Sign in button on nothing', async () => {
      // A stale Sign in button from before they signed in still works: it lands
      // them on the menu rather than asking them to sign in twice.
      await verify();
      expect(buttons(await tap(SIGN_IN))).not.toContain(SIGN_IN);
    });

    describe('a teacher whose access has ended', () => {
      const revoke = async (): Promise<void> => {
        await verify();
        await db.execute(
          sql`UPDATE teachers SET verification_state = 'Revoked', revoked_at = now()
              WHERE chat_id = ${CHAT}`,
        );
      };

      const isRevoked = async (): Promise<boolean> => {
        const rows = await db.execute<{ revoked: boolean }>(
          sql`SELECT revoked_at IS NOT NULL AS revoked FROM teachers WHERE chat_id = ${CHAT}`,
        );
        return rows.rows[0]?.revoked === true;
      };

      it('tells them their access ended rather than prompting, on /start', async () => {
        await revoke();
        expect(firstText(await text('/start'))).toMatch(/access.*has ended/i);
      });

      it('REFUSES the Sign in button, and leaves the revocation standing', async () => {
        /**
         * The assertion that matters most in this part. `bindTeacher` clears
         * `revoked_at`, so a revoked teacher who reaches the sign-in prompt
         * undoes a staff member's decision by typing an email address, silently.
         * That hole existed on `/start` and was closed at `a37fef8`; the Sign in
         * button is a fourth door into the same place.
         *
         * This asserts the refusal rather than the button's absence on purpose.
         * A button a revoked teacher is never shown is still sitting in their
         * scrollback from yesterday, and it is still tappable.
         */
        await revoke();

        const outcome = await tap(SIGN_IN);

        expect(firstText(outcome)).toMatch(/access.*has ended/i);
        expect(await loadState(db, CHAT)).toBeNull();
        expect(await isRevoked()).toBe(true);
      });

      it('does not put the Sign in button on their menu either', async () => {
        await revoke();
        const menu = await tap(MAIN_MENU);

        expect(buttons(menu)).not.toContain(SIGN_IN);
        expect(buttons(menu)).not.toContain(CONTACT_SUPPORT);
        // Still not a dead end: the answer bank stays open to them.
        expect(buttons(menu)).toContain(encodeCallback(CALLBACK.MENU, MENU_ACTION.FAQ));
      });

      it('treats a deactivated roster row the same way, not as a new teacher', async () => {
        // Removing a row from the sheet is what every administrator assumes
        // revokes access. The state stays `Verified`, so a test for `Revoked`
        // alone would offer this teacher the prompt.
        await verify();
        await db.execute(
          sql`UPDATE roster_entries SET active = false WHERE identifier = ${IDENTIFIER}`,
        );

        expect(firstText(await tap(SIGN_IN))).toMatch(/access.*has ended/i);
        expect(buttons(await tap(MAIN_MENU))).not.toContain(SIGN_IN);
      });
    });
  });

  describe('signing in', () => {
    it('signs a teacher in and shows them the menu', async () => {
      await text('/start');
      await tap(SIGN_IN);
      const outcome = await text(IDENTIFIER);

      expect(firstText(outcome)).toContain('Signed in as Router Tester');
      expect(await loadState(db, CHAT)).toBeNull();

      const rows = await db.execute<{ verification_state: string; region: string }>(
        sql`SELECT verification_state, region FROM teachers WHERE chat_id = ${CHAT}`,
      );
      expect(rows.rows[0]?.verification_state).toBe('Verified');
      // Captured here or never — Stage 4's whole regional permission model reads it.
      expect(rows.rows[0]?.region).toBe('Tashkent');
    });

    it('records which version of the notice was accepted', async () => {
      await verify();
      const rows = await db.execute<{ v: string | null; at: string | null }>(
        sql`SELECT privacy_notice_version AS v, privacy_notice_accepted_at::text AS at
            FROM teachers WHERE chat_id = ${CHAT}`,
      );
      // Without the version, a later revision erases the meaning of every
      // earlier consent: the date alone proves somebody agreed to something.
      expect(rows.rows[0]?.v).not.toBeNull();
      expect(rows.rows[0]?.at).not.toBeNull();
    });

    it('refuses an address that is not on the roster and counts the attempt', async () => {
      await text('/start');
      await tap(SIGN_IN);
      const outcome = await text('someone.else@example.com');

      expect(firstText(outcome)).toContain('could not find that address');
      const state = await loadState(db, CHAT);
      expect(state?.kind === 'AwaitingIdentifier' && state.attempts).toBe(1);
    });

    it('refuses a teacher whose roster row has been deactivated', async () => {
      // Removing a row from the sheet is what every administrator assumes
      // revokes access. The sync only deactivates, so sign-in must read the flag.
      await db.execute(sql`UPDATE roster_entries SET active = false WHERE identifier = ${IDENTIFIER}`);
      await text('/start');
      await tap(SIGN_IN);
      expect(firstText(await text(IDENTIFIER))).toContain('could not find that address');
    });

    it('logs the address masked, never in full', async () => {
      await text('/start');
      await tap(SIGN_IN);
      await text(IDENTIFIER);

      const rows = await db.execute<{ detail: string }>(
        sql`SELECT detail FROM messages WHERE chat_id = ${CHAT} ORDER BY at`,
      );
      const details = rows.rows.map((r) => r.detail).join('|');
      expect(details).not.toContain(IDENTIFIER);
      expect(details).toContain('r***@example.com');
    });

    it('reports a second account taking an identity, and allows it', async () => {
      /**
       * D1. Blocking would lock out any teacher who changes phone, and would let
       * anyone holding a leaked recruitment email lock the real teacher out for
       * good. So it is allowed, and three people are told.
       */
      await verify(CHAT);
      await text('/start', SECOND_CHAT);
      await tap(SIGN_IN, SECOND_CHAT);
      const outcome = await text(IDENTIFIER, SECOND_CHAT);

      expect(firstText(outcome)).toContain('Signed in');
      expect(outcome.messages[1]?.chatId).toBe(CHAT);
      /**
       * The prior holder is told, and what they are told stopped opening with
       * "⚠️ Security notice" on 5 August 2026. This asserts the substance rather
       * than the heading: their account, signed in from somewhere else. The
       * alarm moved to the button, which is the only part of it a teacher acts
       * on.
       */
      expect(outcome.messages[1]?.text).toMatch(/signed in to your teacher account/i);
      expect(outcome.alerts[0]?.title).toContain('more than one chat');
    });

    it('says what a message to somebody else is, for the alert if it fails to send', async () => {
      // R10. `deliver` alerts when a send fails, and it used to describe every
      // message after the first as a duplicate sign-in notice — true while that
      // was the only one, and wrong the moment new-case notification exists.
      // The reply to the sender carries no purpose: it is always messages[0].
      await verify(CHAT);
      await text('/start', SECOND_CHAT);
      await tap(SIGN_IN, SECOND_CHAT);
      const outcome = await text(IDENTIFIER, SECOND_CHAT);

      expect(outcome.messages[0]?.purpose).toBeUndefined();
      expect(outcome.messages[1]?.purpose).toBe('a duplicate sign-in notice');
    });
  });

  // -------------------------------------------------------------------------
  // Identity disputes — Feature A
  // -------------------------------------------------------------------------

  describe('identity disputes', () => {
    /** Sign both chats in as the same teacher, which is what opens a dispute. */
    const contest = async (): Promise<RouterOutcome> => {
      await verify(CHAT);
      await text('/start', SECOND_CHAT);
      await tap(SIGN_IN, SECOND_CHAT);
      return text(IDENTIFIER, SECOND_CHAT);
    };

    const openDisputeId = async (): Promise<number> => {
      const rows = await db.execute<{ id: number }>(
        sql`SELECT id FROM identity_disputes WHERE resolved_at IS NULL`,
      );
      return rows.rows[0]?.id ?? 0;
    };

    it('opens a record and gives both chats a button', async () => {
      const outcome = await contest();

      const [{ n }] = (
        await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM identity_disputes`)
      ).rows as [{ n: string }];
      expect(n).toBe('1');

      // Both parties get something they can act on. Neither button settles it.
      const prior = outcome.messages.find((m) => m.chatId === CHAT);
      const fresh = outcome.messages.filter((m) => m.chatId === SECOND_CHAT).at(-1);
      expect(prior?.keyboard).toBeDefined();
      expect(fresh?.keyboard).toBeDefined();
    });

    it('signs the second chat in anyway — a dispute does not gate access', async () => {
      // The decision D1 made and Part 2 kept. Blocking would lock out any teacher
      // who changes phone, and would let anyone with a leaked address lock the
      // real teacher out permanently.
      const outcome = await contest();

      expect(firstText(outcome)).toContain('Signed in');
      const rows = await db.execute<{ state: string }>(
        sql`SELECT verification_state AS state FROM teachers WHERE chat_id = ${SECOND_CHAT}`,
      );
      expect(rows.rows[0]?.state).toBe('Verified');
    });

    it('keeps the operations alarm as well as the dispute', async () => {
      // The alarm is what fires when NOBODY taps anything, which is exactly the
      // silent impersonation case. The dispute is added beside it, not instead.
      const outcome = await contest();
      expect(outcome.alerts[0]?.title).toContain('more than one chat');
    });

    it('joins a third chat to the same record rather than opening a second', async () => {
      const third = '980003';
      await contest();
      await text('/start', third);
      await tap(SIGN_IN, third);
      await text(IDENTIFIER, third);

      const rows = await db.execute<{ n: string }>(
        sql`SELECT count(*) AS n FROM identity_disputes`,
      );
      expect(rows.rows[0]?.n).toBe('1');

      const parties = await db.execute<{ n: string }>(
        sql`SELECT count(*) AS n FROM identity_dispute_parties`,
      );
      expect(parties.rows[0]?.n).toBe('3');
    });

    it('records a party’s answer and thanks them without settling anything', async () => {
      await contest();
      const id = await openDisputeId();

      const answered = await tap(encodeCallback(CALLBACK.DISPUTE_CLAIM, String(id), 'NotMine'), CHAT);

      expect(firstText(answered)).toContain('recorded');
      const rows = await db.execute<{ claim: string | null; state: string }>(sql`
        SELECT p.claim, d.state FROM identity_dispute_parties p
        JOIN identity_disputes d ON d.id = p.dispute_id
        WHERE p.dispute_id = ${id} AND p.chat_id = ${CHAT}
      `);
      expect(rows.rows[0]?.claim).toBe('NotMine');
      expect(rows.rows[0]?.state).toBe('Claimed');
      // Nobody has been revoked. A party cannot decide.
      const teacher = await db.execute<{ state: string }>(
        sql`SELECT verification_state AS state FROM teachers WHERE chat_id = ${SECOND_CHAT}`,
      );
      expect(teacher.rows[0]?.state).toBe('Verified');
    });

    it('gives a stranger who guesses a dispute payload nothing but the menu', async () => {
      // Tapped rather than checked for absence. A hand-crafted payload must not
      // reveal whether the dispute exists, who is on it, or that the guess landed.
      await contest();
      const id = await openDisputeId();
      const stranger = '980777';

      const outcome = await tap(
        encodeCallback(CALLBACK.DISPUTE_CLAIM, String(id), 'Mine'),
        stranger,
      );

      expect(firstText(outcome)).not.toContain('recorded');
      const rows = await db.execute<{ n: string }>(
        sql`SELECT count(*) AS n FROM identity_dispute_parties WHERE chat_id = ${stranger}`,
      );
      expect(rows.rows[0]?.n).toBe('0');
    });

    it('refuses a settle tap from a Program member and names the rank it needs', async () => {
      // A button sits in a scrollback for ever, so it is tapped rather than
      // assumed absent. Program can revoke a teacher and still cannot do this.
      await contest();
      const id = await openDisputeId();
      const program = '980500';
      await db.execute(sql`
        INSERT INTO staff (telegram_id, name, role, queue, active)
        VALUES (${program}, 'Program Person', 'Program', 'All', true)
      `);

      const outcome = await tap(
        encodeCallback(CALLBACK.DISPUTE_RESOLVE, String(id), CHAT),
        program,
      );

      expect(firstText(outcome)).toContain('System');
      const teacher = await db.execute<{ state: string }>(
        sql`SELECT verification_state AS state FROM teachers WHERE chat_id = ${SECOND_CHAT}`,
      );
      expect(teacher.rows[0]?.state).toBe('Verified');
    });

    it('settles it for System, revoking the other account and closing its cases', async () => {
      await contest();
      const id = await openDisputeId();
      const admin = '980900';
      await db.execute(sql`
        INSERT INTO staff (telegram_id, name, role, queue, active)
        VALUES (${admin}, 'System Person', 'System', 'All', true)
      `);

      const outcome = await tap(encodeCallback(CALLBACK.DISPUTE_RESOLVE, String(id), CHAT), admin);

      expect(firstText(outcome)).toContain('settled');
      const kept = await db.execute<{ state: string }>(
        sql`SELECT verification_state AS state FROM teachers WHERE chat_id = ${CHAT}`,
      );
      const lost = await db.execute<{ state: string }>(
        sql`SELECT verification_state AS state FROM teachers WHERE chat_id = ${SECOND_CHAT}`,
      );
      expect(kept.rows[0]?.state).toBe('Verified');
      expect(lost.rows[0]?.state).toBe('Revoked');

      // Both parties are told, and the losing chat is given a route rather than
      // an accusation.
      const toLoser = outcome.messages.find((m) => m.chatId === SECOND_CHAT);
      expect(toLoser?.text).toContain(SUPPORT);
    });

    it('makes a second settle tap a no-op that says so', async () => {
      await contest();
      const id = await openDisputeId();
      const admin = '980900';
      await db.execute(sql`
        INSERT INTO staff (telegram_id, name, role, queue, active)
        VALUES (${admin}, 'System Person', 'System', 'All', true)
      `);

      await tap(encodeCallback(CALLBACK.DISPUTE_RESOLVE, String(id), CHAT), admin);
      const again = await tap(
        encodeCallback(CALLBACK.DISPUTE_RESOLVE, String(id), SECOND_CHAT),
        admin,
      );

      expect(firstText(again)).toContain('already settled');
      // The second tap named the OTHER chat. It must not have changed hands.
      const first = await db.execute<{ state: string }>(
        sql`SELECT verification_state AS state FROM teachers WHERE chat_id = ${CHAT}`,
      );
      expect(first.rows[0]?.state).toBe('Verified');
    });

    it('tells a party who answers after the decision that it is settled', async () => {
      await contest();
      const id = await openDisputeId();
      const admin = '980900';
      await db.execute(sql`
        INSERT INTO staff (telegram_id, name, role, queue, active)
        VALUES (${admin}, 'System Person', 'System', 'All', true)
      `);
      await tap(encodeCallback(CALLBACK.DISPUTE_RESOLVE, String(id), CHAT), admin);

      const late = await tap(encodeCallback(CALLBACK.DISPUTE_CLAIM, String(id), 'Mine'), CHAT);
      expect(firstText(late)).toContain('already been settled');
    });
  });

  describe('the FAQ', () => {
    it('asks which topic a typed question belongs to, and remembers it', async () => {
      /**
       * Matching is scoped to one topic (`BOT-SPEC.md:9.0`) — precision over
       * recall, so a visa question is never answered from the accommodation
       * bank. The question is remembered so the scoping is not a dead end.
       */
      const asked = await text('how long does a visa take');
      expect(firstText(asked)).toMatch(/which of these is it about/i);
      const state = await loadState(db, CHAT);
      expect(state?.kind === 'AwaitingQuestionTopic' && state.query).toBe(
        'how long does a visa take',
      );

      const answered = await tap(encodeCallback(CALLBACK.QUERY_TOPIC, 'VISA'));
      expect(firstText(answered)).toContain('fourteen working days');
      // Answered once and forgotten, so the next message starts clean.
      expect(await loadState(db, CHAT)).toBeNull();
    });

    it('serves the FAQ to a teacher who has not signed in', async () => {
      // Deliberate: the FAQ is public information, and making someone identify
      // themselves to read it would collect more data, not less.
      await text('how long does a visa take');
      const answered = await tap(encodeCallback(CALLBACK.QUERY_TOPIC, 'VISA'));
      expect(firstText(answered)).toContain('fourteen working days');
      const rows = await db.execute(sql`SELECT chat_id FROM teachers`);
      expect(rows.rows).toHaveLength(0);
    });

    it('will not answer a question out of the wrong topic', async () => {
      // The whole point of the scoping. The visa answer exists, but it is not
      // in the accommodation bank and must not be served from it.
      await text('how long does a visa take');
      const outcome = await tap(encodeCallback(CALLBACK.QUERY_TOPIC, 'ACCOM'));
      expect(firstText(outcome)).not.toContain('fourteen working days');
    });

    it('offers the topic list rather than guessing when nothing matches', async () => {
      await text('what is the capital of France');
      const outcome = await tap(encodeCallback(CALLBACK.QUERY_TOPIC, 'VISA'));
      expect(firstText(outcome)).toMatch(/could not match that/i);
      expect(firstText(outcome)).not.toContain('fourteen working days');
    });

    it('lists the topic when the remembered question has expired', async () => {
      await text('how long does a visa take');
      await db.execute(
        sql`UPDATE conversation_states SET expires_at = now() - interval '1 hour' WHERE chat_id = ${CHAT}`,
      );
      // Nothing to answer, so the teacher gets the topic's questions rather
      // than a shrug.
      const outcome = await tap(encodeCallback(CALLBACK.QUERY_TOPIC, 'VISA'));
      expect(JSON.stringify(outcome.messages[0]?.keyboard)).toContain('VISA-001');
    });

    it('records an unanswered question, which is the content signal', async () => {
      await text('is there a creche at the school');
      const rows = await db.execute<{ detail: string }>(
        sql`SELECT detail FROM messages WHERE chat_id = ${CHAT} ORDER BY at DESC LIMIT 1`,
      );
      expect(rows.rows[0]?.detail).toContain('creche');
    });

    it('opens a topic and lists its questions', async () => {
      const outcome = await tap(encodeCallback(CALLBACK.TOPIC, 'VISA'));
      expect(firstText(outcome)).toContain('Visa');
      expect(JSON.stringify(outcome.messages[0]?.keyboard)).toContain('VISA-001');
    });

    it('lands on the main menu for a button from a build that no longer exists', async () => {
      const outcome = await tap('NONSENSE:WHATEVER');
      expect(firstText(outcome)).toContain('What would you like to do');
    });

    it('will not serve an answer that has been withdrawn', async () => {
      // A teacher's scrollback keeps every button they were ever sent.
      await db.execute(sql`UPDATE faq_entries SET active = false WHERE code = 'VISA-001'`);
      const outcome = await tap(encodeCallback(CALLBACK.ANSWER, 'VISA-001'));
      expect(firstText(outcome)).toContain('no longer available');
    });

    it('records both halves of the feedback pair', async () => {
      await tap(encodeCallback(CALLBACK.ANSWER_HELPFUL, 'VISA-001'));
      await tap(encodeCallback(CALLBACK.ANSWER_UNHELPFUL, 'ACCOM-001'));

      const rows = await db.execute<{ action: string; detail: string }>(
        sql`SELECT action, detail FROM messages WHERE action LIKE 'ANSWER_%' ORDER BY at`,
      );
      // Only the ❌ half existed before, so the bank could learn what was
      // failing but never what was working.
      expect(rows.rows.map((r) => r.action)).toEqual(['ANSWER_HELPFUL', 'ANSWER_UNHELPFUL']);
      expect(rows.rows[0]?.detail).toBe('VISA-001');
    });
  });

  describe('opening a case', () => {
    it('asks an unsigned-in teacher to sign in, then resumes what they wanted', async () => {
      const gate = await tap(encodeCallback(CALLBACK.MENU, MENU_ACTION.CONTACT_SUPPORT));
      expect(firstText(gate)).toContain('recruited with');

      const signedIn = await text(IDENTIFIER);
      // Resumed, not dropped at the main menu: the commonest moment to be asked
      // to sign in is the moment you wanted something.
      expect(firstText(signedIn)).toContain('What is this about');
      expect((await loadState(db, CHAT))?.kind).toBe('AwaitingCaseTopic');
    });

    it('files a case and gives back a reference', async () => {
      await verify();
      await tap(encodeCallback(CALLBACK.MENU, MENU_ACTION.CONTACT_SUPPORT));
      await tap(encodeCallback(CALLBACK.CASE_TOPIC, 'VISA'));
      const outcome = await text('My visa was refused and my flight is on Tuesday');

      expect(firstText(outcome)).toContain('has been opened');
      expect(firstText(outcome)).toMatch(/VISA-\d{4}-00001/);
      expect(await loadState(db, CHAT)).toBeNull();
    });

    it('never reads a teacher their own words back', async () => {
      await verify();
      await tap(encodeCallback(CALLBACK.MENU, MENU_ACTION.CONTACT_SUPPORT));
      await tap(encodeCallback(CALLBACK.CASE_TOPIC, 'VISA'));
      await text('My passport number is AB1234567');

      const outcome = await tap(encodeCallback(CALLBACK.MENU, MENU_ACTION.CHECK_CASE));
      expect(firstText(outcome)).not.toContain('AB1234567');
      expect(firstText(outcome)).toContain('VISA-');
    });

    it('withholds the case description from the log', async () => {
      await verify();
      await tap(encodeCallback(CALLBACK.MENU, MENU_ACTION.CONTACT_SUPPORT));
      await tap(encodeCallback(CALLBACK.CASE_TOPIC, 'VISA'));
      await text('My passport number is AB1234567');

      const rows = await db.execute<{ detail: string }>(
        sql`SELECT detail FROM messages WHERE chat_id = ${CHAT}`,
      );
      expect(rows.rows.map((r) => r.detail).join('|')).not.toContain('AB1234567');
    });

    it('answers a command mid-conversation instead of filing it as a case', async () => {
      /**
       * The reason commands are matched before the state machine. A teacher
       * part-way through describing a problem who types /help must get help, not
       * have "/help" filed as their problem.
       */
      await verify();
      await tap(encodeCallback(CALLBACK.MENU, MENU_ACTION.CONTACT_SUPPORT));
      await tap(encodeCallback(CALLBACK.CASE_TOPIC, 'VISA'));

      const outcome = await text('/help');
      expect(firstText(outcome)).toContain('/privacy');
      const rows = await db.execute(sql`SELECT reference FROM cases`);
      expect(rows.rows).toHaveLength(0);
      // And they are still where they were, so the next message is still the case.
      expect((await loadState(db, CHAT))?.kind).toBe('AwaitingCaseDetail');
    });

    it('answers /privacy from inside sign-in', async () => {
      await text('/start');
      const outcome = await text('/privacy');
      expect(firstText(outcome).toLowerCase()).toContain('privacy');
    });
  });

  /**
   * Asking for priority.
   *
   * These tests used to be about a one-time code: a wrong one refused without
   * saying why, a right one accepted without being spent, and the code withheld
   * from the log. The whole route went on 1 August 2026 — the gate moved from
   * "before the teacher may speak" to "before priority is granted".
   *
   * What replaced it is one property worth stating plainly: **there is nothing
   * between the button and the writing.**
   */
  describe('asking for priority', () => {
    const DESCRIPTION = 'The school has locked the dormitory and we are outside';

    it('asks for the problem straight away, with no code in the way', async () => {
      await verify();
      const prompt = await tap(encodeCallback(CALLBACK.MENU, MENU_ACTION.URGENT_CASE));

      expect(firstText(prompt).toLowerCase()).toContain('describe');
      expect(firstText(prompt).toLowerCase()).not.toContain('code');
    });

    it('files the case at Normal and tells the teacher a person will decide', async () => {
      await verify();
      await tap(encodeCallback(CALLBACK.MENU, MENU_ACTION.URGENT_CASE));

      const filed = await text(DESCRIPTION);

      expect(firstText(filed).toLowerCase()).toContain('coordinator');
      /**
       * The assertion the whole feature turns on. Retention keys off
       * `importance`, so a request that marked itself urgent would hand every
       * teacher six months of retention for a tap.
       */
      const rows = await db.execute<{ status: string; importance: string; requested: boolean }>(sql`
        SELECT status, importance, urgent_requested_at IS NOT NULL AS requested FROM cases
      `);
      expect(rows.rows[0]?.importance).toBe('Normal');
      expect(rows.rows[0]?.requested).toBe(true);
    });

    /**
     * The prompt a teacher could be held at for half an hour.
     *
     * `AwaitingUrgentDetail` has carried an `attempts` count since it was
     * written and nothing ever incremented it, so there was no limit here at
     * all: somebody sending photographs instead of text got the same sentence
     * back every time until the state expired, while the ordinary case prompt
     * beside it gives up after three tries and says what to do instead. The
     * person likeliest to hit it is the one with an emergency and a photograph
     * of a document.
     */
    it('gives up on the priority prompt after three tries, rather than looping', async () => {
      await verify();
      await tap(encodeCallback(CALLBACK.MENU, MENU_ACTION.URGENT_CASE));

      // Two refusals that keep them where they are.
      expect(firstText(await text('')).toLowerCase()).toContain('did not get any text');
      expect(firstText(await text('')).toLowerCase()).toContain('did not get any text');

      // The third ends it, says what to do next, and offers the way back.
      const third = await text('');
      expect(firstText(third).toLowerCase()).toContain('start again');
      expect(third.messages[0]?.keyboard).toBeDefined();

      // And the state is gone, so their next message is not swallowed as detail.
      const states = await db.execute<{ n: string }>(
        sql`SELECT count(*) AS n FROM conversation_states WHERE chat_id = ${CHAT}`,
      );
      expect(Number(states.rows[0]?.n)).toBe(0);
    });

    it('still files the case when a teacher gets it right on the second try', async () => {
      // The counter must not lock somebody out who simply mistyped once.
      await verify();
      await tap(encodeCallback(CALLBACK.MENU, MENU_ACTION.URGENT_CASE));
      await text('');

      const filed = await text(DESCRIPTION);

      expect(firstText(filed).toLowerCase()).toContain('coordinator');
      const rows = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM cases`);
      expect(Number(rows.rows[0]?.n)).toBe(1);
    });

    it('adds to an existing case rather than opening a second one', async () => {
      // The common path, not an edge case: a priority request has no topic
      // picker, so it files under the same general category as every Contact
      // Support case.
      await verify();
      await tap(encodeCallback(CALLBACK.MENU, MENU_ACTION.CONTACT_SUPPORT));
      await tap(encodeCallback(CALLBACK.CASE_TOPIC, 'OTHER'));
      await text('I asked about my contract yesterday');

      await tap(encodeCallback(CALLBACK.MENU, MENU_ACTION.URGENT_CASE));
      const outcome = await text('It has still not been answered and my start date is Monday');

      expect(firstText(outcome).toLowerCase()).toContain('already have');
      const rows = await db.execute(sql`SELECT reference FROM cases`);
      expect(rows.rows).toHaveLength(1);
    });

    it('withholds the description from the log, as it does for any case', async () => {
      await verify();
      await tap(encodeCallback(CALLBACK.MENU, MENU_ACTION.URGENT_CASE));
      await text(DESCRIPTION);

      const rows = await db.execute<{ detail: string }>(
        sql`SELECT detail FROM messages WHERE chat_id = ${CHAT}`,
      );
      expect(rows.rows.map((r) => r.detail).join('|')).not.toContain('dormitory');
    });
  });

  describe('maintenance mode', () => {
    beforeEach(async () => {
      await db.execute(sql`INSERT INTO settings (key, value) VALUES ('MAINTENANCE_MODE', 'TRUE')`);
      clearSettingsCache();
    });

    it('stops a new case', async () => {
      await verify();
      const outcome = await tap(encodeCallback(CALLBACK.MENU, MENU_ACTION.CONTACT_SUPPORT));
      expect(firstText(outcome)).toContain('paused');
    });

    it('stops a priority request, and says who to call instead', async () => {
      await verify();
      const outcome = await tap(encodeCallback(CALLBACK.MENU, MENU_ACTION.URGENT_CASE));
      expect(firstText(outcome)).toContain('paused');
      expect(firstText(outcome)).toContain(SUPPORT);
    });

    it('leaves the FAQ alone', async () => {
      // A teacher looking up an answer is not creating work for anyone, and
      // turning the whole bot off would tell them nothing.
      await text('how long does a visa take');
      const outcome = await tap(encodeCallback(CALLBACK.QUERY_TOPIC, 'VISA'));
      expect(firstText(outcome)).toContain('fourteen working days');
    });

    it('leaves Check My Case alone', async () => {
      await verify();
      const outcome = await tap(encodeCallback(CALLBACK.MENU, MENU_ACTION.CHECK_CASE));
      expect(firstText(outcome)).toContain('not opened any cases');
    });
  });

  describe('a redelivered update', () => {
    it('is ignored, so a resend cannot file a second case', async () => {
      /**
       * Telegram resends anything it does not get a 2xx for, including after a
       * crash between committing a case and replying. Without the claim, the
       * replay runs the whole flow again.
       */
      await verify();
      await tap(encodeCallback(CALLBACK.MENU, MENU_ACTION.CONTACT_SUPPORT));
      await tap(encodeCallback(CALLBACK.CASE_TOPIC, 'VISA'));

      const update: InboundUpdate = { chatId: CHAT, kind: 'text', text: 'my visa was refused' };
      const first = await processUpdate(db, 4242, update, SUPPORT);
      const replay = await processUpdate(db, 4242, update, SUPPORT);

      expect(first).not.toBeNull();
      expect(replay).toBeNull();
      const rows = await db.execute(sql`SELECT reference FROM cases`);
      expect(rows.rows).toHaveLength(1);
    });

    it('lets a genuinely new update through', async () => {
      const a = await processUpdate(db, 5001, { chatId: CHAT, kind: 'text', text: '/help' }, SUPPORT);
      const b = await processUpdate(db, 5002, { chatId: CHAT, kind: 'text', text: '/help' }, SUPPORT);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
    });
  });

  describe('surviving a restart', () => {
    it('picks a conversation up exactly where it was left', async () => {
      // Nothing is held in memory, so "the same chat, later, in a different
      // process" is only a second read of the same row.
      await verify();
      await tap(encodeCallback(CALLBACK.MENU, MENU_ACTION.CONTACT_SUPPORT));
      await tap(encodeCallback(CALLBACK.CASE_TOPIC, 'VISA'));

      // ---- the process restarts here ----

      const outcome = await text('my visa was refused and my flight is Tuesday');
      expect(firstText(outcome)).toContain('has been opened');
    });

    it('treats an expired conversation as absent rather than as a case', async () => {
      /**
       * D4, and the reason expiry is checked on reading. An abandoned case from
       * two days ago must not capture the teacher's next FAQ question as its
       * description.
       */
      await verify();
      await tap(encodeCallback(CALLBACK.MENU, MENU_ACTION.CONTACT_SUPPORT));
      await tap(encodeCallback(CALLBACK.CASE_TOPIC, 'VISA'));
      await db.execute(
        sql`UPDATE conversation_states SET expires_at = now() - interval '1 hour' WHERE chat_id = ${CHAT}`,
      );

      const outcome = await text('how long does a visa take');
      expect(firstText(outcome)).toMatch(/which of these is it about/i);
      const rows = await db.execute(sql`SELECT reference FROM cases`);
      expect(rows.rows).toHaveLength(0);
    });
  });

  /**
   * A form area — a button with a name of its own that files under a category
   * the bot already has.
   *
   * The whole of the feature, from a teacher's side: they are shown what to
   * gather, given the link, asked what they need, and their message opens a case
   * that says the paperwork is still to come.
   */
  describe('a complaint and its paperwork, together', () => {
    const REIMBURSE = encodeCallback(CALLBACK.DOC_TYPE, 'REIMBURSE');

    /**
     * A form area. `CATEGORY` is what makes it one — a form with somewhere to
     * file a complaint is a form that asks for one, and `PREPARE` is only ever
     * what to have ready.
     *
     * Both cells are overridable and independently so, because since 6 August
     * 2026 they answer two unrelated questions and all four of their
     * combinations are reachable from a sheet MoPSE can edit.
     */
    const publishArea = async (
      overrides: { readonly category?: string | null; readonly prepare?: string | null } = {},
    ): Promise<void> => {
      const category = overrides.category === undefined ? 'Travel and Arrival' : overrides.category;
      const prepare =
        overrides.prepare === undefined ? 'Have your receipts ready as one PDF.' : overrides.prepare;
      await db.execute(sql`
        INSERT INTO form_links (type, sheet_row, button_text, url, category, prepare, active)
        VALUES ('REIMBURSE', 1, 'Reimbursement', 'https://forms.gle/abc',
                ${category}, ${prepare}, true)
      `);
    };

    it('shows the paperwork, the link, and files what the teacher then writes', async () => {
      await verify();
      await publishArea();

      const shown = await tap(REIMBURSE);
      expect(firstText(shown)).toContain('Have your receipts ready as one PDF.');
      expect(firstText(shown)).toContain('forms.gle');
      expect(firstText(shown)).toContain('tell us what you need');

      const filed = await text('the embassy charged me twice for the visa');
      expect(firstText(filed)).toContain('has been opened');

      const rows = await db.execute<{
        category: string;
        form_type: string;
        awaiting_form: boolean;
        detail: string;
      }>(sql`SELECT category, form_type, awaiting_form, detail FROM cases`);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.category).toBe('Travel and Arrival');
      expect(rows.rows[0]?.form_type).toBe('REIMBURSE');
      expect(rows.rows[0]?.awaiting_form).toBe(true);
      expect(rows.rows[0]?.detail).toBe('the embassy charged me twice for the visa');
    });

    /**
     * Medical Leave: notes but no prompt. Typing medical detail into a chat
     * message stores it as case text, where the form keeps it in Google — so this
     * form tells teachers what to bring and then gets out of the way.
     */
    it('shows the notes without asking for a message when there is no category', async () => {
      await verify();
      await db.execute(sql`
        INSERT INTO form_links (type, sheet_row, button_text, url, prepare, active)
        VALUES ('MEDICAL', 1, 'Medical Leave', 'https://forms.gle/m',
                'Have your dates and any medical documents ready.', true)
      `);

      const shown = await tap(encodeCallback(CALLBACK.DOC_TYPE, 'MEDICAL'));
      expect(firstText(shown)).toContain('Have your dates and any medical documents ready.');
      expect(firstText(shown)).toContain('forms.gle');
      expect(firstText(shown)).not.toContain('tell us what you need');

      /**
       * Asserted against the stored state, not only the wording: nothing is
       * waiting for a message, so nothing can swallow one.
       */
      expect(await loadState(db, CHAT)).toBeNull();

      /**
       * And the next thing they type is handled as it would have been if they
       * had never opened the form — the FAQ takes the question and remembers it
       * while asking which topic it belongs to. It does not become case text.
       */
      const after = await text('how long does a visa take');
      expect(firstText(after)).not.toContain('has been opened');
      expect(firstText(after)).toMatch(/which of these is it about/i);
      expect((await db.execute(sql`SELECT reference FROM cases`)).rows).toHaveLength(0);
      const state = await loadState(db, CHAT);
      expect(state?.kind).toBe('AwaitingQuestionTopic');
    });

    /**
     * And a category with no notes still asks. The two cells are independent now,
     * so all four combinations have to behave, not just the two we happen to use.
     */
    it('asks for a message when there is a category but no notes', async () => {
      await verify();
      await db.execute(sql`
        INSERT INTO form_links (type, sheet_row, button_text, url, category, active)
        VALUES ('ACCOM', 1, 'Accommodation', 'https://forms.gle/a', 'Accommodation', true)
      `);

      const shown = await tap(encodeCallback(CALLBACK.DOC_TYPE, 'ACCOM'));
      expect(firstText(shown)).toContain('tell us what you need');

      await text('the boiler has not worked since I arrived');
      const rows = await db.execute<{ category: string; form_type: string }>(
        sql`SELECT category, form_type FROM cases`,
      );
      expect(rows.rows[0]?.category).toBe('Accommodation');
      expect(rows.rows[0]?.form_type).toBe('ACCOM');
    });

    /**
     * A plain document form is untouched. It has neither cell filled in, so it
     * says what it always said and captures nothing the teacher types next —
     * which is what keeps this feature from changing Submit Documents for
     * everybody.
     */
    it('leaves a form with no paperwork message exactly as it was', async () => {
      await verify();
      await publishArea({ category: null, prepare: null });

      const shown = await tap(REIMBURSE);
      expect(firstText(shown)).toContain('You do not need to send anything back to me');

      const after = await text('how long does a visa take');
      expect(firstText(after)).not.toContain('has been opened');
      const rows = await db.execute(sql`SELECT reference FROM cases`);
      expect(rows.rows).toHaveLength(0);
    });

    /**
     * The area is re-read when the message arrives, never trusted from the
     * state. A form withdrawn while the teacher was typing must not still file
     * under it — and the teacher must be told rather than left with silence.
     */
    it('does not file under an area that was withdrawn while they were typing', async () => {
      await verify();
      await publishArea();
      await tap(REIMBURSE);

      await db.execute(sql`UPDATE form_links SET active = false WHERE type = 'REIMBURSE'`);

      const outcome = await text('the embassy charged me twice');
      expect(firstText(outcome)).toContain('no longer available');
      const rows = await db.execute(sql`SELECT reference FROM cases`);
      expect(rows.rows).toHaveLength(0);
      expect(await loadState(db, CHAT)).toBeNull();
    });

    /**
     * Assert the refusal, not the absence. The button sits in a teacher's
     * scrollback for ever, so a chat that has never signed in tapping it must be
     * refused rather than merely not shown it.
     */
    it('refuses the button from a chat that has not signed in', async () => {
      await publishArea();
      await text('/start', SECOND_CHAT);

      const outcome = await tap(REIMBURSE, SECOND_CHAT);
      expect(firstText(outcome)).not.toContain('Have your receipts ready');
      expect(await loadState(db, SECOND_CHAT)).not.toMatchObject({
        kind: 'AwaitingFormComplaint',
      });
    });
  });
});
