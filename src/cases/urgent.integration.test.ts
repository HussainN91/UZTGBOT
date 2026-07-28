/**
 * Integration tests for urgent cases and their one-time codes.
 *
 * Three of these could not have been written against the old platform: "the same
 * code used twice at the same moment", "the bot restarts between the code and
 * the description", and "the code is spent on the deduplicated path too". The
 * first was an accepted risk, the second was impossible because state lived in
 * memory, and the third was a bug nobody had a way to see.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CASE_CATEGORY, URGENT_CODE_MAX_ATTEMPTS } from '../config/constants.js';
import { withChatLock } from '../conversation/lock.js';
import { loadState, saveState } from '../conversation/state.js';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import type { Alert, Alerter } from '../sync/alerts.js';
import {
  checkStrandedUrgentCodes,
  checkUrgentCode,
  fileUrgentCase,
  normaliseUrgentCode,
} from './urgent.js';
import { createCase } from './service.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const CHAT = '960001';
const OTHER_CHAT = '960002';
const IDENTIFIER = 'urgent.tester@example.com';
const ISSUER = '970001';
const CODE = 'AB12CD';
const DETAIL = 'My landlord has changed the locks and I am outside with my children';

function collectingAlerter(): Alerter & { readonly sent: Alert[] } {
  const sent: Alert[] = [];
  return {
    sent,
    async send(alert: Alert): Promise<void> {
      sent.push(alert);
    },
  };
}

describe.skipIf(!TEST_DATABASE_URL)('urgent cases', () => {
  let pool: pg.Pool;
  let db: Database;

  const issueCode = async (code: string, expiresIn = '48 hours'): Promise<void> => {
    await db.execute(sql`
      INSERT INTO urgent_codes (code, issued_by, expires_at)
      VALUES (${code}, ${ISSUER}, now() + ${expiresIn}::interval)
    `);
  };

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`
      TRUNCATE cases, teachers, roster_entries, case_sequences,
               urgent_codes, urgent_code_attempts, conversation_states CASCADE
    `);
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active)
      VALUES (${IDENTIFIER}, 'Urgent Tester', 'Tashkent', true)
    `);
    await db.execute(sql`
      INSERT INTO teachers (chat_id, verification_state, identifier, name, region)
      VALUES (${CHAT}, 'Verified', ${IDENTIFIER}, 'Urgent Tester', 'Tashkent')
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('checking a code', () => {
    it('accepts a good code without spending it', async () => {
      await issueCode(CODE);
      const result = await checkUrgentCode(db, CHAT, CODE);

      expect(result.kind).toBe('accepted');
      const rows = await db.execute<{ used_at: Date | null }>(
        sql`SELECT used_at FROM urgent_codes WHERE code = ${CODE}`,
      );
      // The whole of D5: checking is not spending. A teacher who stops here
      // still has their code.
      expect(rows.rows[0]?.used_at).toBeNull();
    });

    it('accepts a code typed in lower case with stray spaces', async () => {
      // Read aloud over the telephone, typed on a phone that capitalises for you.
      await issueCode(CODE);
      const result = await checkUrgentCode(db, CHAT, `  ${CODE.toLowerCase()} `);
      expect(result.kind).toBe('accepted');
    });

    it('refuses an expired code', async () => {
      await issueCode(CODE, '-1 hours');
      const result = await checkUrgentCode(db, CHAT, CODE);
      expect(result.kind).toBe('rejected');
    });

    it('refuses a code that has already been spent', async () => {
      await issueCode(CODE);
      await db.execute(
        sql`UPDATE urgent_codes SET used_at = now(), used_by = ${OTHER_CHAT} WHERE code = ${CODE}`,
      );
      const result = await checkUrgentCode(db, CHAT, CODE);
      expect(result.kind).toBe('rejected');
    });

    it('does not distinguish wrong from spent from expired', async () => {
      // Distinguishing them tells a guesser they have found a real code, which
      // is the most useful thing a guesser can learn.
      await issueCode(CODE, '-1 hours');
      const expired = await checkUrgentCode(db, CHAT, CODE);
      const nonexistent = await checkUrgentCode(db, CHAT, 'ZZ99ZZ');
      expect(expired.kind).toBe(nonexistent.kind);
    });
  });

  describe('the guess cap', () => {
    it('locks the chat out after too many wrong codes', async () => {
      for (let i = 0; i < URGENT_CODE_MAX_ATTEMPTS; i += 1) {
        const result = await checkUrgentCode(db, CHAT, `BAD${i}`);
        expect(result.kind).toBe('rejected');
      }

      const blocked = await checkUrgentCode(db, CHAT, 'BAD9');
      expect(blocked.kind).toBe('lockedOut');
    });

    it('locks out even when the next code offered is correct', async () => {
      await issueCode(CODE);
      for (let i = 0; i < URGENT_CODE_MAX_ATTEMPTS; i += 1) {
        await checkUrgentCode(db, CHAT, `BAD${i}`);
      }

      const result = await checkUrgentCode(db, CHAT, CODE);
      expect(result.kind).toBe('lockedOut');
      // And the good code is untouched, so it still works after the window.
      const rows = await db.execute<{ used_at: Date | null }>(
        sql`SELECT used_at FROM urgent_codes WHERE code = ${CODE}`,
      );
      expect(rows.rows[0]?.used_at).toBeNull();
    });

    it('counts per chat, so one guesser cannot lock out a teacher', async () => {
      for (let i = 0; i < URGENT_CODE_MAX_ATTEMPTS; i += 1) {
        await checkUrgentCode(db, OTHER_CHAT, `BAD${i}`);
      }
      await issueCode(CODE);
      const result = await checkUrgentCode(db, CHAT, CODE);
      expect(result.kind).toBe('accepted');
    });

    it('heals on its own as the window passes', async () => {
      // Self-healing by design: no Stage 3 command exists to release a lockout,
      // so a durable counter would strand a teacher until Stage 4 shipped.
      for (let i = 0; i < URGENT_CODE_MAX_ATTEMPTS; i += 1) {
        await checkUrgentCode(db, CHAT, `BAD${i}`);
      }
      expect((await checkUrgentCode(db, CHAT, 'BAD9')).kind).toBe('lockedOut');

      await db.execute(
        sql`UPDATE urgent_code_attempts SET at = now() - interval '2 hours' WHERE chat_id = ${CHAT}`,
      );
      await issueCode(CODE);
      expect((await checkUrgentCode(db, CHAT, CODE)).kind).toBe('accepted');
    });

    it('clears the count when a code is finally right', async () => {
      await issueCode(CODE);
      await checkUrgentCode(db, CHAT, 'WRONG1');
      await checkUrgentCode(db, CHAT, 'WRONG2');
      await checkUrgentCode(db, CHAT, CODE);

      const rows = await db.execute<{ count: number }>(
        sql`SELECT count(*)::int AS count FROM urgent_code_attempts WHERE chat_id = ${CHAT}`,
      );
      expect(rows.rows[0]?.count).toBe(0);
    });
  });

  describe('filing the case', () => {
    it('opens an escalated case and spends the code on it', async () => {
      await issueCode(CODE);
      const result = await withChatLock(db, CHAT, (tx) =>
        fileUrgentCase(tx, { chatId: CHAT, code: CODE, detail: DETAIL }),
      );

      expect(result.isNew).toBe(true);
      expect(result.escalated).toBe(true);

      const cases = await db.execute<{ status: string }>(
        sql`SELECT status FROM cases WHERE reference = ${result.reference}`,
      );
      expect(cases.rows[0]?.status).toBe('Escalated');

      const codes = await db.execute<{ used_by: string; case_reference: string }>(
        sql`SELECT used_by, case_reference FROM urgent_codes WHERE code = ${CODE}`,
      );
      expect(codes.rows[0]?.used_by).toBe(CHAT);
      // The code names what it bought, which is what makes "spent for nothing"
      // a queryable condition rather than an invisible one.
      expect(codes.rows[0]?.case_reference).toBe(result.reference);
    });

    it('spends the code on the deduplicated path too', async () => {
      /**
       * The one the plan names as easiest to get silently wrong. Urgent cases
       * have no topic picker, so they file under the same general category as
       * every ordinary Contact Support case — a teacher who opened one yesterday
       * always deduplicates against it. "Consume only on insert" would give the
       * escalation away free on the commonest path there is.
       */
      const existing = await createCase(db, {
        chatId: CHAT,
        category: CASE_CATEGORY.CONTACT_SUPPORT,
        detail: 'I asked about my contract yesterday',
      });
      await issueCode(CODE);

      const result = await withChatLock(db, CHAT, (tx) =>
        fileUrgentCase(tx, { chatId: CHAT, code: CODE, detail: DETAIL }),
      );

      expect(result.isNew).toBe(false);
      expect(result.reference).toBe(existing.reference);
      expect(result.escalated).toBe(true);

      const codes = await db.execute<{ case_reference: string }>(
        sql`SELECT case_reference FROM urgent_codes WHERE code = ${CODE}`,
      );
      expect(codes.rows[0]?.case_reference).toBe(existing.reference);
    });

    it('escalates the existing case and keeps the urgent words', async () => {
      const existing = await createCase(db, {
        chatId: CHAT,
        category: CASE_CATEGORY.CONTACT_SUPPORT,
        detail: 'I asked about my contract yesterday',
      });
      await issueCode(CODE);
      await withChatLock(db, CHAT, (tx) =>
        fileUrgentCase(tx, { chatId: CHAT, code: CODE, detail: DETAIL }),
      );

      const rows = await db.execute<{ status: string; detail: string }>(
        sql`SELECT status, detail FROM cases WHERE reference = ${existing.reference}`,
      );
      expect(rows.rows[0]?.status).toBe('Escalated');
      // Appended, never replaced — the original words survive alongside.
      expect(rows.rows[0]?.detail).toContain('I asked about my contract yesterday');
      expect(rows.rows[0]?.detail).toContain('URGENT follow-up');
      expect(rows.rows[0]?.detail).toContain('locks');
    });

    it('opens one case, not two, when a code is spent twice at once', async () => {
      await issueCode(CODE);
      const [a, b] = await Promise.all([
        withChatLock(db, CHAT, (tx) =>
          fileUrgentCase(tx, { chatId: CHAT, code: CODE, detail: DETAIL }),
        ),
        withChatLock(db, CHAT, (tx) =>
          fileUrgentCase(tx, { chatId: CHAT, code: CODE, detail: DETAIL }),
        ),
      ]);

      expect(a.reference).toBe(b.reference);
      const rows = await db.execute(sql`SELECT reference FROM cases`);
      expect(rows.rows).toHaveLength(1);
      // Exactly one of the two spent it; the conditional UPDATE cannot succeed
      // twice. The Apps Script notes listed double use as an accepted risk.
      expect([a.escalated, b.escalated].filter(Boolean)).toHaveLength(1);
    });

    it('cannot spend the same code from two different chats', async () => {
      // Roster first: teachers.identifier is a foreign key into it, which is
      // what stops a chat being bound to somebody who was never recruited.
      await db.execute(sql`
        INSERT INTO roster_entries (identifier, name, region, active)
        VALUES ('second.teacher@example.com', 'Second', 'Tashkent', true)
      `);
      await db.execute(sql`
        INSERT INTO teachers (chat_id, verification_state, identifier, name, region)
        VALUES (${OTHER_CHAT}, 'Verified', 'second.teacher@example.com', 'Second', 'Tashkent')
      `);
      await issueCode(CODE);

      const first = await withChatLock(db, CHAT, (tx) =>
        fileUrgentCase(tx, { chatId: CHAT, code: CODE, detail: DETAIL }),
      );
      const second = await withChatLock(db, OTHER_CHAT, (tx) =>
        fileUrgentCase(tx, { chatId: OTHER_CHAT, code: CODE, detail: 'me too' }),
      );

      expect(first.escalated).toBe(true);
      expect(second.escalated).toBe(false);
    });

    it('still files the case when the code has expired since it was accepted', async () => {
      /**
       * A teacher who accepts a code at hour 47 and describes their emergency
       * the next morning. Their words are not thrown away because of our timing
       * — they get an ordinary case and are told plainly it is not escalated.
       */
      await issueCode(CODE, '-1 hours');
      const result = await withChatLock(db, CHAT, (tx) =>
        fileUrgentCase(tx, { chatId: CHAT, code: CODE, detail: DETAIL }),
      );

      expect(result.escalated).toBe(false);
      expect(result.reference).not.toBe('');
      const rows = await db.execute<{ status: string; detail: string }>(
        sql`SELECT status, detail FROM cases WHERE reference = ${result.reference}`,
      );
      expect(rows.rows[0]?.detail).toContain('locks');
      expect(rows.rows[0]?.status).toBe('Escalated');
    });
  });

  describe('surviving a restart mid-conversation', () => {
    it('files correctly when the code was accepted before the process died', async () => {
      /**
       * Untestable before this rebuild: the state lived in `CacheService`, so a
       * restart between the code and the description simply lost the teacher —
       * and their code with it. Nothing here is carried in memory, so "the same
       * chat, later, in a different process" is just a second read.
       */
      await issueCode(CODE);
      const accepted = await checkUrgentCode(db, CHAT, CODE);
      expect(accepted.kind).toBe('accepted');
      await saveState(db, CHAT, { kind: 'AwaitingUrgentDetail', codeAccepted: CODE, attempts: 0 });

      // ---- the process restarts here; nothing survives but the database ----

      const state = await loadState(db, CHAT);
      expect(state?.kind).toBe('AwaitingUrgentDetail');
      const code = state?.kind === 'AwaitingUrgentDetail' ? state.codeAccepted : '';

      const result = await withChatLock(db, CHAT, (tx) =>
        fileUrgentCase(tx, { chatId: CHAT, code, detail: DETAIL }),
      );
      expect(result.escalated).toBe(true);
    });

    it('keeps the accepted code alive for longer than an ordinary conversation', async () => {
      // 24 hours, not 30 minutes. The old six was CacheService's ceiling, not a
      // decision — and a lapse cost a teacher their code.
      await saveState(db, CHAT, { kind: 'AwaitingUrgentDetail', codeAccepted: CODE, attempts: 0 });
      await db.execute(
        sql`UPDATE conversation_states SET updated_at = now() - interval '3 hours' WHERE chat_id = ${CHAT}`,
      );
      expect((await loadState(db, CHAT))?.kind).toBe('AwaitingUrgentDetail');
    });
  });

  describe('watching for a code spent on nothing', () => {
    it('finds nothing in the ordinary case', async () => {
      await issueCode(CODE);
      await withChatLock(db, CHAT, (tx) =>
        fileUrgentCase(tx, { chatId: CHAT, code: CODE, detail: DETAIL }),
      );

      const alerter = collectingAlerter();
      expect(await checkStrandedUrgentCodes(db, alerter)).toHaveLength(0);
      expect(alerter.sent).toHaveLength(0);
    });

    it('alerts when a code was spent without a case', async () => {
      // Cannot happen through fileUrgentCase — written here by hand precisely
      // because the alarm is for something outside that path doing it.
      await issueCode(CODE);
      await db.execute(sql`
        UPDATE urgent_codes
        SET used_at = now() - interval '3 hours', used_by = ${CHAT}
        WHERE code = ${CODE}
      `);

      const alerter = collectingAlerter();
      const stranded = await checkStrandedUrgentCodes(db, alerter);

      expect(stranded).toHaveLength(1);
      expect(alerter.sent[0]?.severity).toBe('critical');
      expect(alerter.sent[0]?.body).toContain(CODE);
    });

    it('leaves a recently spent code alone', async () => {
      await issueCode(CODE);
      await db.execute(
        sql`UPDATE urgent_codes SET used_at = now(), used_by = ${CHAT} WHERE code = ${CODE}`,
      );
      const alerter = collectingAlerter();
      expect(await checkStrandedUrgentCodes(db, alerter)).toHaveLength(0);
    });
  });

  it('normalises a code the same way everywhere', () => {
    expect(normaliseUrgentCode('  ab12cd  ')).toBe('AB12CD');
  });
});
