/**
 * "Who covers my region?", and the handle it publishes — Task 66, Q2, D47.
 *
 * The second teacher-visible change in this stage, and the only thing this
 * system does that publishes a named ministry employee to 1,800 people. Two
 * things are being proved here and the second is the one that matters:
 *
 *   A teacher is shown the person who covers them, resolved the way everything
 *   else resolves a region — the staff-set override first, the roster second
 *   (R12), never the sign-in snapshot.
 *
 *   A handle is **verified rather than trusted** (R33). Every other stale value
 *   in this system degrades towards nothing happening; this one degrades towards
 *   the ministry's own bot pointing teachers at a stranger, confidently and
 *   silently. `api.getChat('@handle').id` must equal the staff row's id or the
 *   column is not written at all.
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
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import {
  type TelegramLookup,
  clearUsername,
  normaliseHandle,
  regionManagerFor,
  setUsername,
} from '../staff/repository.js';
import { setRegionOverride } from '../teachers/region.js';
import { CALLBACK, encodeCallback } from './callback-data.js';
import { MENU_ACTION } from './keyboards.js';
import { route, type InboundUpdate, type RouterDeps, type RouterOutcome } from './router.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

/**
 * A telephone number rather than an address, and that is load-bearing for one
 * test below: "does not publish a handle that has not been set" asserts the
 * reply contains no `@` at all, and `support@mopse.uz` would satisfy it by
 * accident. The plan's own sketch of that test had exactly that hole.
 */
const SUPPORT = '+998 71 000 0000';

const SYSTEM = '995001';
const BUKHARA_LEAD = '995002';
const OBSERVER = '995003';
const ALL_REGION_SUPPORT = '995004';

const TEACHER = '995101';
const UNPLACED = '995102';
const STRANGER = '995103';

/**
 * Telegram, reduced to the one question this feature asks it.
 *
 * A handle nobody holds throws, exactly as `getChat` does for "chat not found",
 * because that is a legitimate answer to the question rather than a fault.
 */
const fakeTelegram = (handles: Readonly<Record<string, string>>): TelegramLookup => ({
  getChat: async (handle: string) => {
    const id = handles[handle];
    if (id === undefined) throw new Error('Bad Request: chat not found');
    return { id };
  },
});

describe.skipIf(!TEST_DATABASE_URL)('the manager a teacher is shown', () => {
  let pool: pg.Pool;
  let db: Database;

  const telegram = fakeTelegram({
    '@karimova': BUKHARA_LEAD,
    '@somebodyelse': '999999',
  });

  const send = (update: InboundUpdate, deps: RouterDeps = { supportContact: SUPPORT }): Promise<RouterOutcome> =>
    withChatLock(db, update.chatId, (tx) => route(tx, update, deps));

  const run = async (text: string, chatId = BUKHARA_LEAD): Promise<string> =>
    (await send({ chatId, kind: 'text', text }, { supportContact: SUPPORT, telegram })).messages[0]
      ?.text ?? '';

  const asks = async (chatId = TEACHER): Promise<string> =>
    (
      await send({
        chatId,
        kind: 'callback',
        text: encodeCallback(CALLBACK.MENU, MENU_ACTION.MY_MANAGER),
      })
    ).messages[0]?.text ?? '';

  const usernameOf = async (telegramId: string): Promise<string | null> => {
    const rows = await db.execute<{ telegram_username: string | null }>(
      sql`SELECT telegram_username FROM staff WHERE telegram_id = ${telegramId}`,
    );
    return rows.rows[0]?.telegram_username ?? null;
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
        (${SYSTEM},            'System Admin',    'System',   'All', ARRAY[]::text[],          true),
        (${BUKHARA_LEAD},      'Nodira Karimova', 'Lead',     'All', ARRAY['Bukhara']::text[], true)
    `);

    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active) VALUES
        ('bukhara@example.com', 'Bukhara Teacher', 'Bukhara', true),
        ('nowhere@example.com', 'Unplaced Teacher', NULL,     true)
    `);
    await db.execute(sql`
      INSERT INTO teachers (chat_id, identifier, name, region, verification_state) VALUES
        (${TEACHER},  'bukhara@example.com', 'Bukhara Teacher',  'Tashkent', 'Verified'),
        (${UNPLACED}, 'nowhere@example.com', 'Unplaced Teacher', NULL,       'Verified')
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('who is named', () => {
    it('names the person covering the teacher’s region', async () => {
      expect(await regionManagerFor(db, 'Bukhara')).toMatchObject({
        telegramId: BUKHARA_LEAD,
        name: 'Nodira Karimova',
      });
    });

    it('reads the region the way everything else reads it', async () => {
      /**
       * R12. `teachers.region` says Tashkent here, deliberately — it is the
       * snapshot `bindTeacher` took at sign-in and a verified teacher never
       * signs in again. The roster and any override are what count, and a
       * teacher shown last year's manager is worse than one shown nobody.
       */
      await setRegionOverride(db, TEACHER, 'Bukhara', SYSTEM);
      const body = await asks();

      expect(body).toContain('Nodira Karimova');
      expect(body).toContain('Bukhara');
    });

    it('never names somebody who cannot act, even where they are the only regional one', async () => {
      /**
       * R14 once more. An Observer covering a region is not the person a
       * teacher should be sent to — they cannot reply, close or take a case.
       *
       * The assertion is "not the Observer" rather than "nobody", because the
       * System member in the fixture covers every region and does hold
       * `case.update`. That is the all-region fallback working, and it is
       * correct: the rank ordering reaches System last, only when nobody else
       * covers the teacher at all.
       */
      await db.execute(sql`
        INSERT INTO staff (telegram_id, name, role, queue, regions, active)
        VALUES (${OBSERVER}, 'New Starter', 'Observer', 'All', ARRAY['Samarkand']::text[], true)
      `);

      const named = await regionManagerFor(db, 'Samarkand');
      expect(named?.telegramId).not.toBe(OBSERVER);
    });

    it('names nobody at all when the only staff who could be named cannot act', async () => {
      await db.execute(sql`DELETE FROM staff WHERE telegram_id = ${SYSTEM}`);
      await db.execute(sql`
        INSERT INTO staff (telegram_id, name, role, queue, regions, active)
        VALUES (${OBSERVER}, 'New Starter', 'Observer', 'All', ARRAY['Samarkand']::text[], true)
      `);

      expect(await regionManagerFor(db, 'Samarkand')).toBeNull();
    });

    it('prefers somebody who names the region over somebody who covers them all', async () => {
      /**
       * The judgement the plan did not settle, asserted so that changing it is a
       * deliberate act. An empty `regions` array means *every* region, so
       * without this the first all-region Support member in id order would
       * become the named manager of the entire country.
       */
      await db.execute(sql`
        INSERT INTO staff (telegram_id, name, role, queue, regions, active)
        VALUES (${ALL_REGION_SUPPORT}, 'Everywhere Person', 'Support', 'All', ARRAY[]::text[], true)
      `);

      expect(await regionManagerFor(db, 'Bukhara')).toMatchObject({ telegramId: BUKHARA_LEAD });
    });

    it('falls back to an all-region member when nobody names the region', async () => {
      await db.execute(sql`
        INSERT INTO staff (telegram_id, name, role, queue, regions, active)
        VALUES (${ALL_REGION_SUPPORT}, 'Everywhere Person', 'Support', 'All', ARRAY[]::text[], true)
      `);

      expect(await regionManagerFor(db, 'Samarkand')).toMatchObject({
        telegramId: ALL_REGION_SUPPORT,
      });
    });

    it('names nobody for a teacher with no region at all', async () => {
      expect(await regionManagerFor(db, null)).toBeNull();
    });
  });

  describe('what the teacher reads', () => {
    it('says nothing about staffing when there is nobody', async () => {
      // "No manager is assigned to your region" is an operational fact a
      // teacher can do nothing with, and it is not theirs to worry about.
      const body = await asks(UNPLACED);

      expect(body).toContain(SUPPORT);
      expect(body).not.toMatch(/no manager|not assigned|nobody covers/i);
    });

    it('does not publish a handle that has not been set', async () => {
      // D47: null means "not published", and the name is still shown.
      await setRegionOverride(db, TEACHER, 'Bukhara', SYSTEM);
      const body = await asks();

      expect(body).toContain('Nodira Karimova');
      expect(body).not.toContain('@');
    });

    it('publishes the handle once it has been verified', async () => {
      await setRegionOverride(db, TEACHER, 'Bukhara', SYSTEM);
      await run('/username @karimova');

      expect(await asks()).toContain('@karimova');
    });

    it('sends anything needing a record back to Contact Support', async () => {
      /**
       * R34, and the only control there is. A teacher who messages a manager
       * directly leaves no reference, no queue, no owner, no promised date and
       * no retention rule, and nothing technical can route that backwards.
       *
       * **The matcher moved on 5 August 2026 and the property did not.** The
       * message used to earn its keep by listing what a direct message lacks:
       * no case number, not tracked, nobody to pick it up. Phase two turned that
       * around to say what Contact Support gives instead, because fifteen of the
       * bot's twenty-four teacher messages were telling teachers what was *not*
       * happening and the stack of them is what read as overwhelming.
       *
       * So the reason a teacher is given has to survive, in whichever direction
       * it is put: the message names Contact Support, and names the case number
       * as the thing that route gets them.
       */
      await setRegionOverride(db, TEACHER, 'Bukhara', SYSTEM);
      const body = await asks();

      expect(body).toContain('Contact Support');
      expect(body).toMatch(/case number/i);
    });

    it('answers a chat that has never signed in, rather than gating it', async () => {
      // Somebody who cannot sign in and needs a person to say so to is exactly
      // who asks this. The sign-in prompt is the one answer that does not help.
      const body = await asks(STRANGER);

      expect(body).toContain(SUPPORT);
      /**
       * Matched on the prompt's current instruction. This asserted the sentence
       * the prompt used before it was reworded on 3 August 2026, and a negative
       * assertion against wording that no longer exists anywhere passes for the
       * wrong reason — it would go on passing if this chat *were* gated.
       */
      expect(body).not.toContain('Enter your email address');
    });
  });

  describe('/username', () => {
    it('publishes a handle that Telegram confirms is theirs', async () => {
      const body = await run('/username @karimova');

      expect(body).toMatch(/publishing @karimova/i);
      expect(await usernameOf(BUKHARA_LEAD)).toBe('karimova');
    });

    it('refuses a handle that resolves to somebody else, and writes nothing', async () => {
      /**
       * The whole of R33 in one test. A Telegram username is a label its owner
       * can release, and a released handle can be claimed by anybody — so a
       * wrong one here would show 1,800 teachers a stranger's handle with the
       * ministry's bot vouching for it.
       */
      const body = await run('/username @somebodyelse');

      expect(body).toMatch(/belongs to somebody else/i);
      expect(await usernameOf(BUKHARA_LEAD)).toBeNull();
    });

    it('refuses one Telegram has never heard of', async () => {
      expect(await run('/username @nobodyatall')).toMatch(/does not know/i);
      expect(await usernameOf(BUKHARA_LEAD)).toBeNull();
    });

    it('refuses something that is not a username before calling Telegram at all', async () => {
      expect(await run('/username Nodira Karimova')).toMatch(/not a telegram username/i);
      expect(await usernameOf(BUKHARA_LEAD)).toBeNull();
    });

    it('accepts the forms a person actually pastes', async () => {
      expect(normaliseHandle('@karimova')).toBe('karimova');
      expect(normaliseHandle('karimova')).toBe('karimova');
      expect(normaliseHandle('https://t.me/karimova')).toBe('karimova');
      expect(normaliseHandle('  @karimova  ')).toBe('karimova');
      expect(normaliseHandle('4karimova')).toBeNull();
      expect(normaliseHandle('abc')).toBeNull();
    });

    it('reports what is published when asked with no argument', async () => {
      expect(await run('/username')).toMatch(/nothing is published/i);
      await run('/username @karimova');
      expect(await run('/username')).toContain('@karimova');
    });

    it('stops publishing on request', async () => {
      await run('/username @karimova');

      expect(await run('/username clear')).toMatch(/stopped publishing @karimova/i);
      expect(await usernameOf(BUKHARA_LEAD)).toBeNull();
    });

    it('says so rather than changing anything when there is nothing to clear', async () => {
      expect(await run('/username clear')).toMatch(/nothing was published/i);
    });

    it('writes nothing at all when the handle cannot be checked', async () => {
      /**
       * A published handle that was never verified is the exact failure D47
       * exists to prevent, so "cannot check" must mean "wrote nothing" rather
       * than "wrote it anyway". `deps.telegram` is absent here.
       */
      const body =
        (await send({ chatId: BUKHARA_LEAD, kind: 'text', text: '/username @karimova' }))
          .messages[0]?.text ?? '';

      expect(body).toMatch(/cannot check that handle/i);
      expect(await usernameOf(BUKHARA_LEAD)).toBeNull();
    });

    it('sets nobody else’s row, because there is no way to name one', async () => {
      // Not a permission check — a handle published under somebody's name is
      // theirs to publish, so the command takes no chat id at all.
      await run(`/username ${SYSTEM}`);

      expect(await usernameOf(SYSTEM)).toBeNull();
    });

    it('is available to any active staff member', async () => {
      await db.execute(sql`
        INSERT INTO staff (telegram_id, name, role, queue, regions, active)
        VALUES (${OBSERVER}, 'New Starter', 'Observer', 'All', ARRAY[]::text[], true)
      `);

      expect(await run('/username', OBSERVER)).not.toMatch(/rank/i);
    });
  });

  describe('clearUsername', () => {
    it('reports the handle it removed, so an alarm can name it', async () => {
      // "Your handle was removed" is not actionable; "@karimova no longer
      // resolves to you" is.
      await setUsername(db, telegram, BUKHARA_LEAD, '@karimova');

      expect(await clearUsername(db, BUKHARA_LEAD)).toBe('karimova');
      expect(await clearUsername(db, BUKHARA_LEAD)).toBeNull();
    });
  });
});
