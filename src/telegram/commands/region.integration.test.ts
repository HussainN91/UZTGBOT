/**
 * A teacher's region, from the staff side — Task 45, over D20 and D21.
 *
 * Region is one of the two axes that decide who sees a teacher's case, which
 * makes `/region` the only command in this stage that can move work from one
 * person to another without touching a case at all. Most of what is asserted
 * below is therefore about refusals rather than about writes.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { withChatLock } from '../../conversation/lock.js';
import { route, type InboundUpdate, type RouterOutcome } from '../router.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const SUPPORT = '+998 71 000 0000';

const TASHKENT_LEAD = '996001';
const SAMARKAND_LEAD = '996002';
const EVERYWHERE_LEAD = '996003';
const SUPPORT_MEMBER = '996004';

const TASHKENT_TEACHER = '996101';
const SAMARKAND_TEACHER = '996102';
const UNPLACED_TEACHER = '996103';

const TASHKENT_ID = 'region.tashkent@example.com';
const SAMARKAND_ID = 'region.samarkand@example.com';
const UNPLACED_ID = 'region.unplaced@example.com';

describe.skipIf(!TEST_DATABASE_URL)('a teacher’s region', () => {
  let pool: pg.Pool;
  let db: Database;

  const send = (update: InboundUpdate): Promise<RouterOutcome> =>
    withChatLock(db, update.chatId, (tx) => route(tx, update, { supportContact: SUPPORT }));

  const run = async (text: string, chatId = TASHKENT_LEAD): Promise<string> =>
    (await send({ chatId, kind: 'text', text })).messages[0]?.text ?? '';

  const overrideOf = async (chatId: string): Promise<string | null> => {
    const rows = await db.execute<{ region_override: string | null }>(
      sql`SELECT region_override FROM teachers WHERE chat_id = ${chatId}`,
    );
    return rows.rows[0]?.region_override ?? null;
  };

  const flaggedAt = async (chatId: string): Promise<string | null> => {
    const rows = await db.execute<{ region_flagged_at: string | null }>(
      sql`SELECT region_flagged_at FROM teachers WHERE chat_id = ${chatId}`,
    );
    return rows.rows[0]?.region_flagged_at ?? null;
  };

  const flag = (chatId: string): Promise<unknown> =>
    db.execute(sql`UPDATE teachers SET region_flagged_at = now() WHERE chat_id = ${chatId}`);

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`
      TRUNCATE cases, case_notes, teachers, roster_entries, case_sequences,
               conversation_states, messages, faq_entries, urgent_codes,
               urgent_code_attempts, processed_updates, settings, staff,
               audit_log CASCADE
    `);

    await db.execute(sql`
      INSERT INTO staff (telegram_id, name, role, queue, regions, active) VALUES
        (${TASHKENT_LEAD},   'Tashkent Lead',  'Lead',    'All', ARRAY['Tashkent']::text[],  true),
        (${SAMARKAND_LEAD},  'Samarkand Lead', 'Lead',    'All', ARRAY['Samarkand']::text[], true),
        (${EVERYWHERE_LEAD}, 'National Lead',  'Lead',    'All', ARRAY[]::text[],            true),
        (${SUPPORT_MEMBER},  'Support Person', 'Support', 'All', ARRAY[]::text[],            true)
    `);
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active) VALUES
        (${TASHKENT_ID},  'Tashkent Teacher',  'Tashkent',  true),
        (${SAMARKAND_ID}, 'Samarkand Teacher', 'Samarkand', true),
        (${UNPLACED_ID},  'Unplaced Teacher',  NULL,        true)
    `);
    await db.execute(sql`
      INSERT INTO teachers (chat_id, identifier, name, region, verification_state) VALUES
        (${TASHKENT_TEACHER},  ${TASHKENT_ID},  'Tashkent Teacher',  'Tashkent',  'Verified'),
        (${SAMARKAND_TEACHER}, ${SAMARKAND_ID}, 'Samarkand Teacher', 'Samarkand', 'Verified'),
        (${UNPLACED_TEACHER},  ${UNPLACED_ID},  'Unplaced Teacher',  NULL,        'Verified')
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('/region', () => {
    it('refuses a region the manager does not cover', async () => {
      // The named test in the plan. A Lead scoped to Samarkand must not be able
      // to move a teacher into Bukhara — region decides who sees a case, so a
      // command that edits it is a command that can move work away from the
      // person holding it.
      const body = await run(`/region ${SAMARKAND_TEACHER} Tashkent`, SAMARKAND_LEAD);

      expect(body).toMatch(/do not cover/i);
      expect(await overrideOf(SAMARKAND_TEACHER)).toBeNull();
    });

    it('refuses to take a teacher OUT of a region it does not cover either', async () => {
      // The same act seen from the other side. Refusing only the destination
      // would stop a Tashkent lead pushing somebody into Samarkand and still let
      // them pull somebody out of it.
      const body = await run(`/region ${SAMARKAND_TEACHER} Tashkent`, TASHKENT_LEAD);

      expect(body).toMatch(/do not cover/i);
      expect(await overrideOf(SAMARKAND_TEACHER)).toBeNull();
    });

    it('lets somebody who covers both regions make the move', async () => {
      const body = await run(`/region ${SAMARKAND_TEACHER} Tashkent`, EVERYWHERE_LEAD);

      expect(await overrideOf(SAMARKAND_TEACHER)).toBe('Tashkent');
      expect(body).toContain('Tashkent');
      expect(body).toContain('Samarkand');
    });

    it('lets any manager place a teacher who has no region at all', async () => {
      // D10's rule, which has to hold here too: an unrecorded region is covered
      // by everybody. Otherwise the teachers whose region is least certain would
      // be the ones nobody is allowed to correct.
      await run(`/region ${UNPLACED_TEACHER} Tashkent`, TASHKENT_LEAD);

      expect(await overrideOf(UNPLACED_TEACHER)).toBe('Tashkent');
    });

    it('refuses a region nobody has ever heard of, and names the ones it knows', async () => {
      // A typo written happily puts the teacher in a province no staff member
      // covers: their cases visible only to all-region staff, routed nowhere,
      // and wrong in a way nothing would report.
      const body = await run(`/region ${TASHKENT_TEACHER} Tashkant`, EVERYWHERE_LEAD);

      expect(body).toMatch(/do not know a region/i);
      expect(body).toContain('Samarkand');
      expect(await overrideOf(TASHKENT_TEACHER)).toBeNull();
    });

    it('writes the spelling the roster uses, whatever was typed', async () => {
      await run(`/region ${TASHKENT_TEACHER} samarkand`, EVERYWHERE_LEAD);

      expect(await overrideOf(TASHKENT_TEACHER)).toBe('Samarkand');
    });

    it('clears the teacher’s report when it acts', async () => {
      // The flag means "reported and not yet dealt with". Leaving it raised puts
      // the teacher back in a queue of reports somebody has already handled.
      await flag(TASHKENT_TEACHER);
      await run(`/region ${TASHKENT_TEACHER} Samarkand`, EVERYWHERE_LEAD);

      expect(await flaggedAt(TASHKENT_TEACHER)).toBeNull();
    });

    it('returns a teacher to the spreadsheet’s region on clear', async () => {
      await run(`/region ${TASHKENT_TEACHER} Samarkand`, EVERYWHERE_LEAD);
      const body = await run(`/region ${TASHKENT_TEACHER} clear`, EVERYWHERE_LEAD);

      expect(await overrideOf(TASHKENT_TEACHER)).toBeNull();
      expect(body).toContain('Tashkent');
    });

    it('says so and writes nothing when the region is already that', async () => {
      const body = await run(`/region ${TASHKENT_TEACHER} Tashkent`, TASHKENT_LEAD);

      expect(body).toMatch(/already in Tashkent/i);
      expect(await overrideOf(TASHKENT_TEACHER)).toBeNull();
    });

    it('says plainly when there is no such teacher', async () => {
      const body = await run('/region 999999 Tashkent', EVERYWHERE_LEAD);

      expect(body).toMatch(/no teacher with chat id/i);
    });

    it('asks for a chat id rather than guessing', async () => {
      expect(await run('/region Tashkent', EVERYWHERE_LEAD)).toMatch(/chat id/i);
    });

    it('is not available at Support rank', async () => {
      const body = await run(`/region ${TASHKENT_TEACHER} Samarkand`, SUPPORT_MEMBER);

      expect(body).toMatch(/rank/i);
      expect(await overrideOf(TASHKENT_TEACHER)).toBeNull();
    });

    it('writes an audit row naming who decided it', async () => {
      await run(`/region ${TASHKENT_TEACHER} Samarkand`, EVERYWHERE_LEAD);

      const rows = await db.execute<{ actor: string; action: string; subject: string }>(
        sql`SELECT actor, action, subject FROM audit_log`,
      );
      expect(rows.rows).toEqual([
        { actor: EVERYWHERE_LEAD, action: 'TEACHER_REGION_SET', subject: TASHKENT_TEACHER },
      ]);
    });
  });

  describe('/regions', () => {
    it('lists teachers who reported a wrong region, oldest first', async () => {
      await flag(SAMARKAND_TEACHER);
      await flag(TASHKENT_TEACHER);

      const body = await run('/regions', EVERYWHERE_LEAD);

      expect(body).toContain(TASHKENT_TEACHER);
      expect(body).toContain(SAMARKAND_TEACHER);
      expect(body.indexOf(SAMARKAND_TEACHER)).toBeLessThan(body.indexOf(TASHKENT_TEACHER));
    });

    it('shows a manager only the teachers they hold', async () => {
      await flag(SAMARKAND_TEACHER);
      await flag(TASHKENT_TEACHER);

      const body = await run('/regions', TASHKENT_LEAD);

      expect(body).toContain(TASHKENT_TEACHER);
      expect(body).not.toContain(SAMARKAND_TEACHER);
    });

    it('shows everybody a teacher with no region recorded', async () => {
      await flag(UNPLACED_TEACHER);

      expect(await run('/regions', TASHKENT_LEAD)).toContain(UNPLACED_TEACHER);
      expect(await run('/regions', SAMARKAND_LEAD)).toContain(UNPLACED_TEACHER);
    });

    it('says the list is empty rather than showing nothing', async () => {
      const body = await run('/regions', EVERYWHERE_LEAD);

      expect(body).toMatch(/no teacher has reported/i);
    });

    it('drops a teacher off the list as soon as somebody acts', async () => {
      // Without this the report has a writer and no reader, which is the pattern
      // the backward audit of this stage exists to stop.
      await flag(TASHKENT_TEACHER);
      await run(`/region ${TASHKENT_TEACHER} Samarkand`, EVERYWHERE_LEAD);

      expect(await run('/regions', EVERYWHERE_LEAD)).toMatch(/no teacher has reported/i);
    });

    it('is not available at Support rank', async () => {
      expect(await run('/regions', SUPPORT_MEMBER)).toMatch(/rank/i);
    });
  });
});
