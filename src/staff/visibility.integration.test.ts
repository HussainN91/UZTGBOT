/**
 * Integration tests for the one place queue and region are ever combined.
 *
 * Two of these exist because the plan's original code sample was wrong in ways
 * nothing above the database could see: it bound JS arrays in a form PostgreSQL
 * rejects outright, and it read `teachers.region` — the snapshot taken at
 * sign-in — which would have left the region fault alive in the single most
 * important consumer of a region there is.
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
import { setRegionOverride } from '../teachers/region.js';
import { QUEUE } from './queues.js';
import { type StaffScope, visibleCaseReferences } from './visibility.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const CHAT = '970001';
const IDENTIFIER = 'visibility.tester@example.com';
const MANAGER = '979999';
const VISA_REF = 'VISA-2026-00001';
const ACCOM_REF = 'ACCOM-2026-00001';

const scope = (over: Partial<StaffScope> = {}): StaffScope => ({
  role: 'Support',
  queue: QUEUE.ALL,
  regions: [],
  ...over,
});

describe.skipIf(!TEST_DATABASE_URL)('the visibility predicate', () => {
  let pool: pg.Pool;
  let db: Database;

  const setRosterRegion = async (region: string | null): Promise<void> => {
    await db.execute(
      sql`UPDATE roster_entries SET region = ${region} WHERE identifier = ${IDENTIFIER}`,
    );
  };

  const seedTeacher = async (rosterRegion: string | null): Promise<void> => {
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active)
      VALUES (${IDENTIFIER}, 'Visibility Tester', ${rosterRegion}, true)
    `);
    // teachers.region deliberately holds a DIFFERENT value from the roster, so
    // any test that passes by reading the snapshot instead of the live roster
    // fails loudly rather than coincidentally agreeing.
    await db.execute(sql`
      INSERT INTO teachers (chat_id, verification_state, identifier, name, region)
      VALUES (${CHAT}, 'Verified', ${IDENTIFIER}, 'Visibility Tester', 'StaleSnapshot')
    `);
  };

  const seedCase = async (reference: string, category: string): Promise<void> => {
    await db.execute(sql`
      INSERT INTO cases (reference, category, teacher_chat_id, status, detail)
      VALUES (${reference}, ${category}, ${CHAT}, 'New', 'detail')
    `);
  };

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`TRUNCATE cases, teachers, roster_entries, staff, audit_log CASCADE`);
    await seedTeacher('Tashkent');
    await seedCase(VISA_REF, CASE_CATEGORY.VISA);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('region', () => {
    it('does not hide a case whose teacher has no region', async () => {
      // adminCoversRegion_ returns true for a falsy region (AdminCommands.gs:236).
      // Without this a teacher whose roster row has no region files cases that no
      // region-scoped staff member can see, and nobody finds out.
      await setRosterRegion(null);
      const rows = await visibleCaseReferences(db, scope({ regions: ['Tashkent'] }));
      expect(rows).toContain(VISA_REF);
    });

    it('treats an empty regions array as every region', async () => {
      // schema.ts — the default, chosen so the column could not narrow access.
      expect(await visibleCaseReferences(db, scope({ regions: [] }))).toContain(VISA_REF);
    });

    it('hides a case from a staff member scoped to another region', async () => {
      expect(await visibleCaseReferences(db, scope({ regions: ['Bukhara'] }))).not.toContain(
        VISA_REF,
      );
    });

    it('compares regions without case sensitivity', async () => {
      // The roster is typed by hand. "Tashkent" and "tashkent" are one place.
      expect(await visibleCaseReferences(db, scope({ regions: ['tashkent'] }))).toContain(VISA_REF);
    });

    it('follows a corrected region, not the one copied at sign-in', async () => {
      // The test that stops this predicate quietly bypassing regionFor.
      // teachers.region still says StaleSnapshot; the case must now be visible to
      // Samarkand staff and not to Tashkent staff. Without this, the region fix
      // works everywhere except the one place that decides who sees a teacher's
      // emergency.
      await setRosterRegion('Samarkand');

      expect(await visibleCaseReferences(db, scope({ regions: ['Samarkand'] }))).toContain(VISA_REF);
      expect(await visibleCaseReferences(db, scope({ regions: ['Tashkent'] }))).not.toContain(
        VISA_REF,
      );
    });

    it('lets a manager override reach the predicate too', async () => {
      await setRegionOverride(db, CHAT, 'Bukhara', MANAGER);

      expect(await visibleCaseReferences(db, scope({ regions: ['Bukhara'] }))).toContain(VISA_REF);
      expect(await visibleCaseReferences(db, scope({ regions: ['Tashkent'] }))).not.toContain(
        VISA_REF,
      );
    });

    it('still hides nothing when the override and the roster are both empty', async () => {
      // COALESCE of two nulls is null, and the IS NULL branch must still catch
      // it. This is the property most likely to break when the join was added.
      await setRosterRegion(null);
      await db.execute(sql`UPDATE teachers SET region_override = NULL WHERE chat_id = ${CHAT}`);

      expect(await visibleCaseReferences(db, scope({ regions: ['Bukhara'] }))).toContain(VISA_REF);
    });

    it('does not lose a case whose roster row has been removed', async () => {
      // The roster join must be a LEFT join. A teacher whose row was deleted
      // still has cases, and an inner join would make them invisible to
      // everybody — the exact failure this predicate exists to prevent.
      await db.execute(sql`UPDATE teachers SET identifier = NULL WHERE chat_id = ${CHAT}`);
      await db.execute(sql`DELETE FROM roster_entries WHERE identifier = ${IDENTIFIER}`);

      expect(await visibleCaseReferences(db, scope({ regions: ['Bukhara'] }))).toContain(VISA_REF);
    });
  });

  describe('queue', () => {
    it('hides a Visa case from an Accommodation queue', async () => {
      expect(
        await visibleCaseReferences(db, scope({ queue: QUEUE.ACCOMMODATION })),
      ).not.toContain(VISA_REF);
    });

    it('shows a Visa case to the Visa queue', async () => {
      expect(await visibleCaseReferences(db, scope({ queue: QUEUE.VISA }))).toContain(VISA_REF);
    });

    it('shows an uncategorised case to every queue', async () => {
      // Contact Support routes to All: it is by definition the case nobody has
      // classified, and it is exactly what goes unworked.
      await seedCase('SUPPORT-2026-00001', CASE_CATEGORY.CONTACT_SUPPORT);
      expect(await visibleCaseReferences(db, scope({ queue: QUEUE.VISA }))).toContain(
        'SUPPORT-2026-00001',
      );
    });

    it('shows a staff member holding no queue nothing at all', async () => {
      // None is a deliberate setting, not a bug, and must not read as All.
      expect(await visibleCaseReferences(db, scope({ queue: QUEUE.NONE }))).toEqual([]);
    });

    it('shows a queue this build does not recognise nothing, and does not throw', async () => {
      // An empty category list must produce a valid query. The generated SQL for
      // an empty IN list is where a naive implementation emits `in ()`.
      expect(await visibleCaseReferences(db, scope({ queue: 'Recruitment' }))).toEqual([]);
    });
  });

  describe('System', () => {
    it('shows a System member everything, whatever their queue says', async () => {
      await seedCase(ACCOM_REF, CASE_CATEGORY.ACCOMMODATION);
      const rows = await visibleCaseReferences(
        db,
        scope({ role: 'System', queue: QUEUE.NONE, regions: ['Bukhara'] }),
      );
      expect(rows).toContain(VISA_REF);
      expect(rows).toContain(ACCOM_REF);
    });
  });

  describe('the two axes together', () => {
    it('requires both to permit it', async () => {
      // Right queue, wrong region.
      expect(
        await visibleCaseReferences(db, scope({ queue: QUEUE.VISA, regions: ['Bukhara'] })),
      ).not.toContain(VISA_REF);

      // Right region, wrong queue.
      expect(
        await visibleCaseReferences(
          db,
          scope({ queue: QUEUE.ACCOMMODATION, regions: ['Tashkent'] }),
        ),
      ).not.toContain(VISA_REF);

      // Both.
      expect(
        await visibleCaseReferences(db, scope({ queue: QUEUE.VISA, regions: ['Tashkent'] })),
      ).toContain(VISA_REF);
    });
  });
});
