/**
 * Integration tests for the staff-facing case reads.
 *
 * Every one of these applies the visibility predicate, so the tests that matter
 * most are the ones proving a query cannot return a case the asker may not see —
 * `/search` above all, because it reads the teacher's own words.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CASE_CATEGORY, STAFF_CASE_LIST_CAP } from '../config/constants.js';
import { clearSettingsCache, setSetting } from '../config/settings.js';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import { QUEUE } from '../staff/queues.js';
import type { StaffScope } from '../staff/visibility.js';
import { casesOwnedBy, findCase, listCases, searchCases, staleCases } from './queries.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const CHAT = '980001';
const IDENTIFIER = 'queries.tester@example.com';
const OWNER = '989001';
const DETAIL = 'my visa was refused and my flight is on Tuesday';

const scope = (over: Partial<StaffScope> = {}): StaffScope => ({
  role: 'Support',
  queue: QUEUE.ALL,
  regions: [],
  ...over,
});

describe.skipIf(!TEST_DATABASE_URL)('staff-facing case queries', () => {
  let pool: pg.Pool;
  let db: Database;

  const seedCase = async (
    reference: string,
    over: {
      category?: string;
      status?: string;
      detail?: string;
      owner?: string | null;
      ageDays?: number;
    } = {},
  ): Promise<void> => {
    const age = over.ageDays ?? 0;
    await db.execute(sql`
      INSERT INTO cases (reference, category, teacher_chat_id, status, detail, owner, created_at, updated_at)
      VALUES (
        ${reference},
        ${over.category ?? CASE_CATEGORY.VISA},
        ${CHAT},
        ${over.status ?? 'New'},
        ${over.detail ?? DETAIL},
        ${over.owner ?? null},
        now() - make_interval(days => ${age}),
        now() - make_interval(days => ${age})
      )
    `);
  };

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(
      sql`TRUNCATE cases, teachers, roster_entries, staff, settings, audit_log CASCADE`,
    );
    clearSettingsCache();
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active)
      VALUES (${IDENTIFIER}, 'Queries Tester', 'Tashkent', true)
    `);
    await db.execute(sql`
      INSERT INTO teachers (chat_id, verification_state, identifier, name, region)
      VALUES (${CHAT}, 'Verified', ${IDENTIFIER}, 'Queries Tester', 'Tashkent')
    `);
    await db.execute(sql`
      INSERT INTO staff (telegram_id, role, queue, regions, active)
      VALUES (${OWNER}, 'Support', 'All', ARRAY[]::text[], true)
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('listCases', () => {
    it('lists open cases only, by default', async () => {
      // /cases previously listed closed and completed ones too, which buried the
      // actionable work (AdminCommands.gs:493).
      await seedCase('VISA-2026-00001');
      await seedCase('VISA-2026-00002', { status: 'Completed' });
      await seedCase('VISA-2026-00003', { status: 'Closed' });

      const result = await listCases(db, scope());
      expect(result.cases.map((c) => c.reference)).toEqual(['VISA-2026-00001']);
    });

    it('orders by created_at descending, so the newest work is at the top', async () => {
      await seedCase('VISA-2026-00001', { ageDays: 3 });
      await seedCase('VISA-2026-00002', { ageDays: 1 });
      await seedCase('VISA-2026-00003', { ageDays: 2 });

      const result = await listCases(db, scope());
      expect(result.cases.map((c) => c.reference)).toEqual([
        'VISA-2026-00002',
        'VISA-2026-00003',
        'VISA-2026-00001',
      ]);
    });

    it('caps the list and says how many more there are', async () => {
      for (let i = 1; i <= STAFF_CASE_LIST_CAP + 5; i += 1) {
        await seedCase(`VISA-2026-${String(i).padStart(5, '0')}`, { ageDays: i });
      }

      const result = await listCases(db, scope());
      expect(result.cases.length).toBe(STAFF_CASE_LIST_CAP);
      // The count is of everything matching, not of what was shown — a backlog
      // of two hundred must not look identical to a backlog of twenty.
      expect(result.total).toBe(STAFF_CASE_LIST_CAP + 5);
    });

    it('filters by an exact status when asked', async () => {
      await seedCase('VISA-2026-00001', { status: 'Under review' });
      await seedCase('VISA-2026-00002', { status: 'New' });

      const result = await listCases(db, scope(), { status: 'Under review' });
      expect(result.cases.map((c) => c.reference)).toEqual(['VISA-2026-00001']);
    });

    it('lists unassigned cases as the intake backlog', async () => {
      await seedCase('VISA-2026-00001', { owner: null });
      await seedCase('VISA-2026-00002', { owner: OWNER });

      const result = await listCases(db, scope(), { unassigned: true });
      expect(result.cases.map((c) => c.reference)).toEqual(['VISA-2026-00001']);
    });

    it('never returns a case the asker may not see', async () => {
      await seedCase('ACCOM-2026-00001', { category: CASE_CATEGORY.ACCOMMODATION });
      const result = await listCases(db, scope({ queue: QUEUE.VISA }));
      expect(result.cases).toEqual([]);
      // The count must respect visibility too, or the message says "and 1 more"
      // about a case this person can never open.
      expect(result.total).toBe(0);
    });
  });

  describe('casesOwnedBy', () => {
    it('returns only that person’s open cases', async () => {
      await seedCase('VISA-2026-00001', { owner: OWNER });
      await seedCase('VISA-2026-00002', { owner: null });
      await seedCase('VISA-2026-00003', { owner: OWNER, status: 'Completed' });

      const result = await casesOwnedBy(db, scope(), OWNER);
      expect(result.cases.map((c) => c.reference)).toEqual(['VISA-2026-00001']);
    });
  });

  describe('staleCases', () => {
    it('omits stale cases entirely when OVERDUE_DAYS is unset', async () => {
      // Rather than inventing an SLA. AdminCommands.gs:551 — the command says so.
      // A fallback here would be the bot deciding MoPSE's service standard.
      await seedCase('VISA-2026-00001', { ageDays: 99 });

      expect((await staleCases(db, scope())).cases).toEqual([]);
    });

    it('returns cases untouched for longer than OVERDUE_DAYS', async () => {
      await setSetting(db, 'OVERDUE_DAYS', '7', 'test');
      clearSettingsCache();
      await seedCase('VISA-2026-00001', { ageDays: 10 });
      await seedCase('VISA-2026-00002', { ageDays: 2 });

      const rows = (await staleCases(db, scope())).cases;
      expect(rows.map((c) => c.reference)).toEqual(['VISA-2026-00001']);
    });

    it('does not count a closed case as stale', async () => {
      await setSetting(db, 'OVERDUE_DAYS', '7', 'test');
      clearSettingsCache();
      await seedCase('VISA-2026-00001', { ageDays: 30, status: 'Completed' });

      expect((await staleCases(db, scope())).cases).toEqual([]);
    });

    it('applies visibility', async () => {
      await setSetting(db, 'OVERDUE_DAYS', '7', 'test');
      clearSettingsCache();
      await seedCase('ACCOM-2026-00001', {
        category: CASE_CATEGORY.ACCOMMODATION,
        ageDays: 30,
      });

      expect((await staleCases(db, scope({ queue: QUEUE.VISA }))).cases).toEqual([]);
    });
  });

  describe('searchCases', () => {
    it('searches the detail, which is exactly why /search needs the visibility rule', async () => {
      // The teacher's own words are searchable by staff who can see the case, and
      // by nobody else. This is the query with the largest exposure surface here.
      await seedCase('VISA-2026-00001', { detail: 'my visa was refused' });
      await seedCase('ACCOM-2026-00001', {
        category: CASE_CATEGORY.ACCOMMODATION,
        detail: 'my visa paperwork is with the landlord',
      });

      const mine = await searchCases(db, scope({ queue: QUEUE.VISA }), 'visa');
      expect(mine.cases.map((c) => c.reference)).toEqual(['VISA-2026-00001']);
    });

    it('finds a case by its reference', async () => {
      await seedCase('VISA-2026-00001');
      const result = await searchCases(db, scope(), 'visa-2026-00001');
      expect(result.cases.map((c) => c.reference)).toEqual(['VISA-2026-00001']);
    });

    it('matches without case sensitivity', async () => {
      await seedCase('VISA-2026-00001', { detail: 'Embassy Appointment Missed' });
      const result = await searchCases(db, scope(), 'embassy appointment');
      expect(result.cases.length).toBe(1);
    });

    it('treats a percent sign as text, not as a wildcard', async () => {
      // Otherwise /search % returns every case in the system, and /search 50%
      // silently matches things containing "50" followed by anything.
      await seedCase('VISA-2026-00001', { detail: 'they took 50% of my deposit' });
      await seedCase('VISA-2026-00002', { detail: 'nothing about deposits' });

      const matched = await searchCases(db, scope(), '50%');
      expect(matched.cases.map((c) => c.reference)).toEqual(['VISA-2026-00001']);

      // A lone % finds the case that literally contains one — and only that
      // case. Unescaped it would match every case the asker can see, which is
      // the failure worth guarding: a stray character dumping the whole backlog.
      const literal = await searchCases(db, scope(), '%');
      expect(literal.cases.map((c) => c.reference)).toEqual(['VISA-2026-00001']);
    });

    it('treats an underscore as text, not as a single-character wildcard', async () => {
      await seedCase('VISA-2026-00001', { detail: 'reference is a_b' });
      await seedCase('VISA-2026-00002', { detail: 'reference is axb' });

      const result = await searchCases(db, scope(), 'a_b');
      expect(result.cases.map((c) => c.reference)).toEqual(['VISA-2026-00001']);
    });

    it('returns nothing for an empty term rather than everything', async () => {
      await seedCase('VISA-2026-00001');
      expect((await searchCases(db, scope(), '   ')).cases).toEqual([]);
    });

    it('searches closed cases too, unlike the default list', async () => {
      // A staff member searching for a reference is usually looking for
      // something that has already been dealt with.
      await seedCase('VISA-2026-00001', { status: 'Completed', detail: 'landlord dispute' });
      const result = await searchCases(db, scope(), 'landlord');
      expect(result.cases.map((c) => c.reference)).toEqual(['VISA-2026-00001']);
    });
  });

  describe('findCase', () => {
    it('returns one case in full', async () => {
      await seedCase('VISA-2026-00001');
      const found = await findCase(db, scope(), 'VISA-2026-00001');
      expect(found?.reference).toBe('VISA-2026-00001');
      expect(found?.detail).toBe(DETAIL);
    });

    it('returns null for a case the asker may not see', async () => {
      // Indistinguishable from "no such case", deliberately: telling somebody a
      // reference exists but is not theirs is itself a disclosure.
      await seedCase('ACCOM-2026-00001', { category: CASE_CATEGORY.ACCOMMODATION });
      expect(await findCase(db, scope({ queue: QUEUE.VISA }), 'ACCOM-2026-00001')).toBeNull();
    });

    it('returns null for a reference that does not exist', async () => {
      expect(await findCase(db, scope(), 'VISA-2026-99999')).toBeNull();
    });

    it('is not case sensitive about the reference', async () => {
      await seedCase('VISA-2026-00001');
      expect((await findCase(db, scope(), 'visa-2026-00001'))?.reference).toBe('VISA-2026-00001');
    });
  });
});
