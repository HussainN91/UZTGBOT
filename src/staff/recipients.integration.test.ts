/**
 * The shared regional-recipient lookup — Part 4 of the programme plan.
 *
 * It is one module rather than a query copied into each feature that needs it,
 * and these tests exist because the rules are subtle in ways that do not survive
 * being retyped. Two of them fail *open* when they are got wrong, which is the
 * dangerous direction: a copy that reads `region = ANY(regions)` and stops there
 * silently excludes every all-region staff member, and on a small team that is
 * everybody.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CASE_CATEGORY } from '../config/constants.js';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import { regionalRecipients, staffCovering } from './recipients.js';
import { CAPABILITY } from './roles.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const SUPPORT_TASHKENT = '994001';
const SUPPORT_SAMARKAND = '994002';
const SUPPORT_EVERYWHERE = '994003';
const OBSERVER_EVERYWHERE = '994004';
const SYSTEM_NARROW = '994005';
const DEACTIVATED = '994006';
const VISA_ONLY_TASHKENT = '994007';

describe.skipIf(!TEST_DATABASE_URL)('who gets told about a region', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`TRUNCATE staff CASCADE`);
    await db.execute(sql`
      INSERT INTO staff (telegram_id, name, role, queue, regions, active) VALUES
        (${SUPPORT_TASHKENT},   'Tashkent Support', 'Support',  'All',  ARRAY['Tashkent'],  true),
        (${SUPPORT_SAMARKAND},  'Samarkand Support','Support',  'All',  ARRAY['Samarkand'], true),
        (${SUPPORT_EVERYWHERE}, 'Roving Support',   'Support',  'All',  ARRAY[]::text[],    true),
        (${OBSERVER_EVERYWHERE},'New Starter',      'Observer', 'All',  ARRAY[]::text[],    true),
        (${SYSTEM_NARROW},      'System Admin',     'System',   'None', ARRAY['Nukus'],     true),
        (${DEACTIVATED},        'Left Last Month',  'Support',  'All',  ARRAY[]::text[],    false),
        (${VISA_ONLY_TASHKENT}, 'Visa Desk',        'Support',  'Visa', ARRAY['Tashkent'],  true)
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('staffCovering', () => {
    it('includes a staff member whose regions are empty', async () => {
      /**
       * The one that fails open. An empty `regions` array means **every**
       * region, never none, and a lookup that forgets it excludes the roving
       * staff who are usually the ones actually on the desk.
       */
      const found = await staffCovering(db, {
        capability: CAPABILITY.URGENT_ISSUE,
        region: 'Tashkent',
      });

      expect(found).toContain(SUPPORT_EVERYWHERE);
      expect(found).toContain(SUPPORT_TASHKENT);
      expect(found).not.toContain(SUPPORT_SAMARKAND);
    });

    it('widens rather than narrows when the region is unknown', async () => {
      // D10. A teacher with no recorded region must reach somebody: "we do not
      // know where they are" cannot become "so nobody is told".
      const found = await staffCovering(db, {
        capability: CAPABILITY.URGENT_ISSUE,
        region: null,
      });

      expect(found).toContain(SUPPORT_TASHKENT);
      expect(found).toContain(SUPPORT_SAMARKAND);
      expect(found).toContain(SUPPORT_EVERYWHERE);
    });

    it('matches a region regardless of case', async () => {
      const found = await staffCovering(db, {
        capability: CAPABILITY.URGENT_ISSUE,
        region: 'TASHKENT',
      });

      expect(found).toContain(SUPPORT_TASHKENT);
    });

    it('excludes anybody who does not hold the capability', async () => {
      // R14. An Observer can read every case in their queue and change none of
      // them, so paging one is paging somebody about work they may not do.
      const found = await staffCovering(db, {
        capability: CAPABILITY.URGENT_ISSUE,
        region: null,
      });

      expect(found).not.toContain(OBSERVER_EVERYWHERE);
    });

    it('excludes a deactivated row', async () => {
      const found = await staffCovering(db, {
        capability: CAPABILITY.URGENT_ISSUE,
        region: null,
      });

      expect(found).not.toContain(DEACTIVATED);
    });

    it('includes System even when its queue and region cover nothing', async () => {
      // Exactly as `visibleToStaff` does. Without the bypass, a System member
      // with a misconfigured queue is the one person who can never be told
      // about anything.
      const found = await staffCovering(db, {
        capability: CAPABILITY.URGENT_ISSUE,
        region: 'Tashkent',
      });

      expect(found).toContain(SYSTEM_NARROW);
    });

    it('consults the queue only when a category is given', async () => {
      /**
       * The difference between the two callers, and the reason the parameter is
       * optional rather than defaulted. A case has a category and a queue; an
       * urgent request is about a *region*, and filtering it by queue would drop
       * the Visa desk from a decision that has nothing to do with visas.
       */
      const withoutQueue = await staffCovering(db, {
        capability: CAPABILITY.URGENT_ISSUE,
        region: 'Tashkent',
      });
      expect(withoutQueue).toContain(VISA_ONLY_TASHKENT);

      const forAccommodation = await staffCovering(db, {
        capability: CAPABILITY.CASE_UPDATE,
        category: CASE_CATEGORY.ACCOMMODATION,
        region: 'Tashkent',
      });
      expect(forAccommodation).not.toContain(VISA_ONLY_TASHKENT);
    });

    it('returns a stable order, so the same people are chosen twice running', async () => {
      const first = await staffCovering(db, { capability: CAPABILITY.CASE_UPDATE, region: null });
      const second = await staffCovering(db, { capability: CAPABILITY.CASE_UPDATE, region: null });

      expect(first).toEqual(second);
      expect(first).toEqual([...first].sort());
    });
  });

  describe('regionalRecipients', () => {
    it('reports the region’s own people, and does not call it a fallback', async () => {
      const found = await regionalRecipients(db, {
        capability: CAPABILITY.URGENT_ISSUE,
        region: 'Samarkand',
      });

      expect(found.viaSystemFallback).toBe(false);
      expect(found.chatIds).toContain(SUPPORT_SAMARKAND);
    });

    it('reports the fallback when System is the only reason anybody is told', async () => {
      /**
       * "A region nobody covers must not become a dispute nobody sees" — the
       * programme plan says it about identity disputes and it is equally true
       * of a priority request. The flag matters as much as the recipients: a
       * System member being asked to decide because **nobody covers that
       * region** is a staffing gap, and a gap nobody names stays open for as
       * long as somebody keeps answering it.
       *
       * `SYSTEM_NARROW` covers Nukus and holds the `None` queue, so it is
       * reached here by the bypass and by nothing else.
       */
      await db.execute(sql`DELETE FROM staff WHERE role <> 'System'`);

      const found = await regionalRecipients(db, {
        capability: CAPABILITY.URGENT_ISSUE,
        region: 'Fergana',
      });

      expect(found.chatIds).toEqual([SYSTEM_NARROW]);
      expect(found.viaSystemFallback).toBe(true);
    });

    it('does not cry staffing gap when System genuinely covers the region', async () => {
      /**
       * The failure the flag had before this test existed: it was computed as
       * "did the first query find nobody", which could never be true because
       * that query already returns every active System member. Reported the
       * other way round, it would warn about a staffing hole on every message
       * to a small team whose System member covers everywhere.
       */
      await db.execute(sql`DELETE FROM staff WHERE role <> 'System'`);
      await db.execute(sql`UPDATE staff SET regions = ARRAY[]::text[], queue = 'All'`);

      const found = await regionalRecipients(db, {
        capability: CAPABILITY.URGENT_ISSUE,
        region: 'Fergana',
      });

      expect(found.chatIds).toEqual([SYSTEM_NARROW]);
      expect(found.viaSystemFallback).toBe(false);
    });

    it('falls back when the only people who cover it may not act', async () => {
      await db.execute(sql`DELETE FROM staff WHERE telegram_id <> ${OBSERVER_EVERYWHERE}`);
      await db.execute(sql`
        INSERT INTO staff (telegram_id, name, role, queue, regions, active)
        VALUES ('994009', 'Standby System', 'System', 'None', ARRAY['Nukus'], true)
      `);

      const found = await regionalRecipients(db, {
        capability: CAPABILITY.URGENT_ISSUE,
        region: 'Fergana',
      });

      expect(found.viaSystemFallback).toBe(true);
      expect(found.chatIds).toEqual(['994009']);
    });

    it('returns nobody at all rather than inventing somebody', async () => {
      // The honest empty answer. The caller raises a critical alert on it; a
      // lookup that widened to "everybody" on a miss would route a Samarkand
      // teacher's request to whoever happens to cover Bukhara.
      await db.execute(sql`TRUNCATE staff CASCADE`);

      const found = await regionalRecipients(db, {
        capability: CAPABILITY.URGENT_ISSUE,
        region: 'Tashkent',
      });

      expect(found.chatIds).toEqual([]);
      // Nobody at all is not a fallback — it is the critical alert the caller
      // raises, and calling it a fallback would put a staffing warning in a
      // message that is never sent to anybody.
      expect(found.viaSystemFallback).toBe(false);
    });
  });
});
