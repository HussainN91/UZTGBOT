/**
 * One tap on a case menu — Task 4 of Part 5H.3's case half.
 *
 * The fixture is copied from `cases.integration.test.ts` rather than shared,
 * for the same reason that file's own fixture is not shared with anything
 * else: a staff/teacher/case set that both files own independently cannot be
 * changed for one without silently changing what the other asserts.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CASE_CATEGORY } from '../../config/constants.js';
import { clearSettingsCache } from '../../config/settings.js';
import { withChatLock } from '../../conversation/lock.js';
import type { Database } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { CALLBACK, encodeCallback } from '../callback-data.js';
import { route, type InboundUpdate, type RouterOutcome } from '../router.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

/** Staff. Names say what each is for. */
const VISA_TASHKENT = '994001';
const ACCOM_EVERYWHERE = '994002';
const OBSERVER = '994003';
const SYSTEM = '994004';

/** Teachers. */
const TASHKENT_TEACHER = '994101';
const SAMARKAND_TEACHER = '994102';

const TASHKENT_ID = 'reader.tashkent@example.com';
const SAMARKAND_ID = 'reader.samarkand@example.com';

describe.skipIf(!TEST_DATABASE_URL)('one tap on a case menu', () => {
  let pool: pg.Pool;
  let db: Database;

  const send = (update: InboundUpdate): Promise<RouterOutcome> =>
    withChatLock(db, update.chatId, (tx) => route(tx, update, { supportContact: '+998 71 000 0000' }));

  /**
   * Insert a case directly: these are menu-routing tests, and filing is
   * covered elsewhere.
   */
  const givenCase = async (fields: {
    reference: string;
    teacher: string;
    category: string;
    status?: string;
    importance?: string;
    owner?: string | null;
  }): Promise<void> => {
    await db.execute(sql`
      INSERT INTO cases (reference, category, teacher_chat_id, status, importance,
                         owner, detail, public_update, updated_at, created_at)
      VALUES (
        ${fields.reference}, ${fields.category}, ${fields.teacher},
        ${fields.status ?? 'New'}::case_status,
        ${fields.importance ?? 'Normal'}::case_importance,
        ${fields.owner ?? null},
        '', '', now(), now()
      )
    `);
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
      INSERT INTO staff (telegram_id, name, role, queue, regions, active) VALUES
        (${VISA_TASHKENT},   'Visa Tashkent',  'Support',  'Visa',          ARRAY['Tashkent']::text[], true),
        (${ACCOM_EVERYWHERE},'Accom Anywhere', 'Support',  'Accommodation', ARRAY[]::text[],           true),
        (${OBSERVER},        'The Observer',   'Observer', 'All',           ARRAY[]::text[],           true),
        (${SYSTEM},          'System Person',  'System',   'None',          ARRAY['Nukus']::text[],    true)
    `);
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active) VALUES
        (${TASHKENT_ID},  'Tashkent Teacher',  'Tashkent',  true),
        (${SAMARKAND_ID}, 'Samarkand Teacher', 'Samarkand', true)
    `);
    await db.execute(sql`
      INSERT INTO teachers (chat_id, identifier, name, region, verification_state) VALUES
        (${TASHKENT_TEACHER},  ${TASHKENT_ID},  'Tashkent Teacher',  'Tashkent',  'Verified'),
        (${SAMARKAND_TEACHER}, ${SAMARKAND_ID}, 'Samarkand Teacher', 'Samarkand', 'Verified')
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('reopens a finished case and shows it again with its buttons', async () => {
    await givenCase({
      reference: 'VISA-2026-00910',
      teacher: TASHKENT_TEACHER,
      category: CASE_CATEGORY.VISA,
      status: 'Completed',
    });

    const outcome = await send({
      chatId: VISA_TASHKENT,
      kind: 'callback',
      text: encodeCallback(CALLBACK.CASE_ACTION, 'VISA-2026-00910', 'RO'),
    });

    // The command's own answer first, then the case again.
    expect(outcome.messages[0]?.text).toContain('open again');
    expect(outcome.messages[1]?.text).toContain('VISA-2026-00910');
    expect(outcome.messages[1]?.keyboard?.length ?? 0).toBeGreaterThan(0);
  });

  it('offers the three levels of importance before writing one', async () => {
    await givenCase({
      reference: 'VISA-2026-00911',
      teacher: TASHKENT_TEACHER,
      category: CASE_CATEGORY.VISA,
    });

    const outcome = await send({
      chatId: VISA_TASHKENT,
      kind: 'callback',
      text: encodeCallback(CALLBACK.CASE_ACTION, 'VISA-2026-00911', 'M'),
    });

    const labels = (outcome.messages[0]?.keyboard ?? []).flat().map((b) => b.text).join(' ');
    expect(labels).toContain('Critical');
    expect(labels).toContain('Urgent');
  });

  it('writes the importance when a level is tapped', async () => {
    await givenCase({
      reference: 'VISA-2026-00912',
      teacher: TASHKENT_TEACHER,
      category: CASE_CATEGORY.VISA,
    });

    await send({
      chatId: VISA_TASHKENT,
      kind: 'callback',
      text: encodeCallback(CALLBACK.CASE_ACTION, 'VISA-2026-00912', 'M', 'Critical'),
    });

    const rows = await db.execute<{ importance: string }>(
      sql`SELECT importance FROM cases WHERE reference = 'VISA-2026-00912'`,
    );
    expect(rows.rows[0]?.importance).toBe('Critical');
  });

  /**
   * The refusal, not the absence. A Support member is never shown this button —
   * but the payload is four visible characters and the message it came in sits
   * in a chat for ever, so it must be tapped and refused rather than merely
   * hidden.
   */
  it('refuses an owner change from somebody who may not make one', async () => {
    await givenCase({
      reference: 'VISA-2026-00913',
      teacher: TASHKENT_TEACHER,
      category: CASE_CATEGORY.VISA,
      owner: null,
    });

    const outcome = await send({
      chatId: VISA_TASHKENT,
      kind: 'callback',
      text: encodeCallback(CALLBACK.CASE_ACTION, 'VISA-2026-00913', 'OWN', SYSTEM),
    });

    expect(outcome.messages[0]?.text).toContain('not available at your rank');

    const rows = await db.execute<{ owner: string | null }>(
      sql`SELECT owner FROM cases WHERE reference = 'VISA-2026-00913'`,
    );
    expect(rows.rows[0]?.owner).toBeNull();
  });

  /**
   * A case in another queue and region. The refusal must be identical to "no
   * such case": confirming a reference exists tells the tapper a teacher filed
   * something, which is what the visibility rule protects.
   */
  it('answers a case outside the tapper’s scope exactly as it answers a missing one', async () => {
    await givenCase({
      reference: 'ACCOM-2026-00914',
      teacher: SAMARKAND_TEACHER,
      category: CASE_CATEGORY.ACCOMMODATION,
    });

    const hidden = await send({
      chatId: VISA_TASHKENT,
      kind: 'callback',
      text: encodeCallback(CALLBACK.CASE_ACTION, 'ACCOM-2026-00914', 'M'),
    });
    const missing = await send({
      chatId: VISA_TASHKENT,
      kind: 'callback',
      text: encodeCallback(CALLBACK.CASE_ACTION, 'VISA-2026-09999', 'M'),
    });

    // The reference itself is echoed back in the refusal, so it is stripped
    // before comparing — the same normalisation the sibling test in
    // cases.integration.test.ts applies for the identical reason.
    expect(hidden.messages[0]?.text.replace('ACCOM-2026-00914', 'X')).toBe(
      missing.messages[0]?.text.replace('VISA-2026-09999', 'X'),
    );
  });

  it('sends somebody with no staff row the ordinary teacher menu', async () => {
    const outcome = await send({
      chatId: TASHKENT_TEACHER,
      kind: 'callback',
      text: encodeCallback(CALLBACK.CASE_ACTION, 'VISA-2026-00911', 'M', 'Critical'),
    });

    expect(outcome.messages[0]?.text).not.toContain('not available at your rank');
    expect(outcome.messages[0]?.text).not.toContain('VISA-2026-00911');
  });

  describe('writing the words for an action', () => {
    it('asks for the reply, then sends what was typed to the teacher', async () => {
      await givenCase({
        reference: 'VISA-2026-00920',
        teacher: TASHKENT_TEACHER,
        category: CASE_CATEGORY.VISA,
      });

      const prompt = await send({
        chatId: VISA_TASHKENT,
        kind: 'callback',
        text: encodeCallback(CALLBACK.CASE_ACTION, 'VISA-2026-00920', 'REP'),
      });
      expect(prompt.messages[0]?.text).toContain('VISA-2026-00920');

      const done = await send({
        chatId: VISA_TASHKENT,
        kind: 'text',
        text: 'your visa is with the embassy and should be ready on Friday',
      });

      const toTeacher = done.messages.find((m) => m.chatId === TASHKENT_TEACHER);
      expect(toTeacher?.text).toContain('should be ready on Friday');
    });

    /**
     * The rule this whole mechanism turns on. Without it the sentence is matched
     * as `/close`, refused for having no reference, and the staff member's words
     * are gone.
     */
    it('treats a message beginning with a slash as the words, not as a command', async () => {
      await givenCase({
        reference: 'VISA-2026-00921',
        teacher: TASHKENT_TEACHER,
        category: CASE_CATEGORY.VISA,
      });

      await send({
        chatId: VISA_TASHKENT,
        kind: 'callback',
        text: encodeCallback(CALLBACK.CASE_ACTION, 'VISA-2026-00921', 'REP'),
      });

      const done = await send({
        chatId: VISA_TASHKENT,
        kind: 'text',
        text: '/close the window in her flat is broken, we are chasing the landlord',
      });

      const toTeacher = done.messages.find((m) => m.chatId === TASHKENT_TEACHER);
      expect(toTeacher?.text).toContain('the window in her flat is broken');
    });

    it('lets somebody out with /cancel, changing nothing', async () => {
      await givenCase({
        reference: 'VISA-2026-00922',
        teacher: TASHKENT_TEACHER,
        category: CASE_CATEGORY.VISA,
        status: 'Under review',
      });

      await send({
        chatId: VISA_TASHKENT,
        kind: 'callback',
        text: encodeCallback(CALLBACK.CASE_ACTION, 'VISA-2026-00922', 'REP'),
      });
      await send({ chatId: VISA_TASHKENT, kind: 'text', text: '/cancel' });

      // The next message is an ordinary one again, not a reply to a teacher.
      const after = await send({ chatId: VISA_TASHKENT, kind: 'text', text: '/mycases' });
      expect(after.messages.every((m) => m.chatId === VISA_TASHKENT)).toBe(true);

      const rows = await db.execute<{ status: string }>(
        sql`SELECT status FROM cases WHERE reference = 'VISA-2026-00922'`,
      );
      expect(rows.rows[0]?.status).toBe('Under review');
    });

    it('does not put an Observer into a writing state at all', async () => {
      await givenCase({
        reference: 'VISA-2026-00923',
        teacher: TASHKENT_TEACHER,
        category: CASE_CATEGORY.VISA,
      });

      await send({
        chatId: OBSERVER,
        kind: 'callback',
        text: encodeCallback(CALLBACK.CASE_ACTION, 'VISA-2026-00923', 'REP'),
      });

      const next = await send({ chatId: OBSERVER, kind: 'text', text: 'anything at all' });
      expect(next.messages.some((m) => m.chatId === TASHKENT_TEACHER)).toBe(false);
    });

    it('closes a case as unresolved, telling the teacher it closed and not why', async () => {
      await givenCase({
        reference: 'VISA-2026-00924',
        teacher: TASHKENT_TEACHER,
        category: CASE_CATEGORY.VISA,
      });

      await send({
        chatId: VISA_TASHKENT,
        kind: 'callback',
        text: encodeCallback(CALLBACK.CASE_ACTION, 'VISA-2026-00924', 'C', 'no'),
      });
      const done = await send({
        chatId: VISA_TASHKENT,
        kind: 'text',
        text: 'unreachable since March, three attempts',
      });

      const toTeacher = done.messages.find((m) => m.chatId === TASHKENT_TEACHER);
      expect(toTeacher?.text).not.toContain('unreachable since March');

      const rows = await db.execute<{ status: string }>(
        sql`SELECT status FROM cases WHERE reference = 'VISA-2026-00924'`,
      );
      expect(rows.rows[0]?.status).toBe('Closed');
    });
  });
});
