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

  const verify = async (chatId = CHAT): Promise<void> => {
    await text('/start', chatId);
    await text(IDENTIFIER, chatId);
  };

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`
      TRUNCATE cases, teachers, roster_entries, case_sequences, conversation_states,
               messages, faq_entries, urgent_codes, urgent_code_attempts,
               processed_updates, settings CASCADE
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

  describe('signing in', () => {
    it('shows the privacy notice before asking for anything', async () => {
      const outcome = await text('/start');
      // The notice and the prompt are one message on purpose: replying with an
      // identifier is the acknowledgement, so a teacher cannot scroll past one
      // and answer the other.
      expect(firstText(outcome)).toContain('recruited with');
      expect(firstText(outcome).toLowerCase()).toContain('privacy');
      expect((await loadState(db, CHAT))?.kind).toBe('AwaitingIdentifier');
    });

    it('signs a teacher in and shows them the menu', async () => {
      await text('/start');
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
      expect(firstText(await text(IDENTIFIER))).toContain('could not find that address');
    });

    it('logs the address masked, never in full', async () => {
      await text('/start');
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
      const outcome = await text(IDENTIFIER, SECOND_CHAT);

      expect(firstText(outcome)).toContain('Signed in');
      expect(outcome.messages[1]?.chatId).toBe(CHAT);
      expect(outcome.messages[1]?.text).toContain('Security notice');
      expect(outcome.alerts[0]?.title).toContain('more than one chat');
    });

    it('says what a message to somebody else is, for the alert if it fails to send', async () => {
      // R10. `deliver` alerts when a send fails, and it used to describe every
      // message after the first as a duplicate sign-in notice — true while that
      // was the only one, and wrong the moment new-case notification exists.
      // The reply to the sender carries no purpose: it is always messages[0].
      await verify(CHAT);
      await text('/start', SECOND_CHAT);
      const outcome = await text(IDENTIFIER, SECOND_CHAT);

      expect(outcome.messages[0]?.purpose).toBeUndefined();
      expect(outcome.messages[1]?.purpose).toBe('a duplicate sign-in notice');
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
      expect(firstText(asked)).toContain('which of these is it about');
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
      expect(firstText(outcome)).toContain("couldn't match that");
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

  describe('urgent cases', () => {
    const CODE = 'XY77ZZ';

    const issueCode = async (): Promise<void> => {
      await db.execute(sql`
        INSERT INTO urgent_codes (code, issued_by, expires_at)
        VALUES (${CODE}, '990001', now() + interval '48 hours')
      `);
    };

    it('asks for a code, refuses a wrong one, and never says why', async () => {
      await verify();
      await tap(encodeCallback(CALLBACK.MENU, MENU_ACTION.URGENT_CASE));
      const outcome = await text('WRONG1');

      expect(firstText(outcome)).toContain('not accepted');
      expect(firstText(outcome)).not.toContain('expired');
      expect(firstText(outcome)).not.toContain('already used');
    });

    it('accepts a code without spending it, then files an escalated case', async () => {
      await verify();
      await issueCode();
      await tap(encodeCallback(CALLBACK.MENU, MENU_ACTION.URGENT_CASE));

      const accepted = await text(CODE);
      expect(firstText(accepted)).toContain('Code accepted');
      // Not spent yet — a teacher who stops here keeps their code.
      const mid = await db.execute<{ used_at: string | null }>(
        sql`SELECT used_at::text AS used_at FROM urgent_codes WHERE code = ${CODE}`,
      );
      expect(mid.rows[0]?.used_at).toBeNull();

      const filed = await text('The school has locked the dormitory and we are outside');
      expect(firstText(filed)).toContain('marked urgent');

      const rows = await db.execute<{ status: string }>(sql`SELECT status FROM cases`);
      expect(rows.rows[0]?.status).toBe('Escalated');
    });

    it('escalates an existing case rather than opening a second one', async () => {
      // The common path, not an edge case: urgent has no topic picker, so it
      // files under the same general category as every Contact Support case.
      await verify();
      await tap(encodeCallback(CALLBACK.MENU, MENU_ACTION.CONTACT_SUPPORT));
      await tap(encodeCallback(CALLBACK.CASE_TOPIC, 'OTHER'));
      await text('I asked about my contract yesterday');

      await issueCode();
      await tap(encodeCallback(CALLBACK.MENU, MENU_ACTION.URGENT_CASE));
      await text(CODE);
      const outcome = await text('It has become an emergency');

      expect(firstText(outcome)).toContain('existing case has been marked urgent');
      const rows = await db.execute(sql`SELECT reference FROM cases`);
      expect(rows.rows).toHaveLength(1);
      // The code still bought what it promised.
      const codes = await db.execute<{ case_reference: string | null }>(
        sql`SELECT case_reference FROM urgent_codes WHERE code = ${CODE}`,
      );
      expect(codes.rows[0]?.case_reference).not.toBeNull();
    });

    it('withholds the code from the log', async () => {
      await verify();
      await issueCode();
      await tap(encodeCallback(CALLBACK.MENU, MENU_ACTION.URGENT_CASE));
      await text(CODE);

      const rows = await db.execute<{ detail: string }>(
        sql`SELECT detail FROM messages WHERE chat_id = ${CHAT}`,
      );
      expect(rows.rows.map((r) => r.detail).join('|')).not.toContain(CODE);
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

    it('stops an urgent case, and says who to call instead', async () => {
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
      expect(firstText(outcome)).toContain('which of these is it about');
      const rows = await db.execute(sql`SELECT reference FROM cases`);
      expect(rows.rows).toHaveLength(0);
    });
  });
});
