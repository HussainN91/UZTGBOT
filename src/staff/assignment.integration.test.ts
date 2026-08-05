/**
 * Who a new case is given to — Part 5H.1.
 *
 * The rule the head of project chose on 1 August 2026: **the person with the
 * fewest open cases**, out of the staff whose queue and region already reach it.
 *
 * Almost none of that is new. `staffCovering` has answered "who can work this"
 * since Feature B, and it is the inverse of the visibility predicate rather than
 * a second copy of it. What is new is counting, and one exclusion that matters
 * more than it looks — see "the System bypass" below.
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
import { chooseOwner } from './assignment.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const BUSY = '996001';
const IDLE = '996002';
const OTHER_QUEUE = '996003';
const OTHER_REGION = '996004';
const SYSTEM = '996005';
const OBSERVER = '996006';
const PROGRAM = '996007';
const LEAD = '996008';

const TEACHER = '996101';

describe.skipIf(!TEST_DATABASE_URL)('choosing who owns a new case', () => {
  let pool: pg.Pool;
  let db: Database;

  const givenStaff = async (
    telegramId: string,
    role: string,
    queue: string,
    regions: readonly string[],
    active = true,
  ): Promise<void> => {
    await db.execute(sql`
      INSERT INTO staff (telegram_id, name, role, queue, regions, active)
      VALUES (${telegramId}, ${`Staff ${telegramId}`}, ${role}::staff_role, ${queue},
              ${sql.raw(`ARRAY[${regions.map((r) => `'${r}'`).join(',')}]::text[]`)}, ${active})
    `);
  };

  /** `count` open cases owned by `owner`, plus `closed` finished ones. */
  const givenCases = async (owner: string, count: number, closed = 0): Promise<void> => {
    for (let i = 0; i < count + closed; i++) {
      await db.execute(sql`
        INSERT INTO cases (reference, category, teacher_chat_id, status, owner, detail)
        VALUES (${`VISA-2026-${owner}${String(i).padStart(3, '0')}`}, ${CASE_CATEGORY.VISA},
                ${TEACHER}, ${i < count ? 'New' : 'Closed'}::case_status, ${owner}, '')
      `);
    }
  };

  const forVisaInTashkent = (): Promise<string | null> =>
    chooseOwner(db, { category: CASE_CATEGORY.VISA, region: 'Tashkent' });

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`
      TRUNCATE cases, teachers, roster_entries, case_sequences, staff, settings CASCADE
    `);
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active)
      VALUES ('assign.tester@example.com', 'Assign Tester', 'Tashkent', true)
    `);
    await db.execute(sql`
      INSERT INTO teachers (chat_id, identifier, name, region, verification_state)
      VALUES (${TEACHER}, 'assign.tester@example.com', 'Assign Tester', 'Tashkent', 'Verified')
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('gives it to the one with fewest open cases', async () => {
    await givenStaff(BUSY, 'Support', 'Visa', ['Tashkent']);
    await givenStaff(IDLE, 'Support', 'Visa', ['Tashkent']);
    await givenCases(BUSY, 3);
    await givenCases(IDLE, 1);

    expect(await forVisaInTashkent()).toBe(IDLE);
  });

  it('counts open cases only, so finished work does not follow somebody about', async () => {
    // The question is who has capacity now, not who has ever been busy. Counting
    // closed cases would push work away from whoever has been clearing it.
    await givenStaff(BUSY, 'Support', 'Visa', ['Tashkent']);
    await givenStaff(IDLE, 'Support', 'Visa', ['Tashkent']);
    await givenCases(BUSY, 1);
    await givenCases(IDLE, 0, 40);

    expect(await forVisaInTashkent()).toBe(IDLE);
  });

  it('only considers staff whose queue and region already reach the case', async () => {
    /**
     * The rule is the inverse of the visibility predicate and is read from the
     * same maps — assigning somebody a case they cannot then open would be a
     * worse failure than leaving it unowned.
     */
    await givenStaff(OTHER_QUEUE, 'Support', 'Accommodation', ['Tashkent']);
    await givenStaff(OTHER_REGION, 'Support', 'Visa', ['Samarkand']);
    await givenStaff(BUSY, 'Support', 'Visa', ['Tashkent']);
    await givenCases(BUSY, 9);

    expect(await forVisaInTashkent()).toBe(BUSY);
  });

  it('never gives a case to an Observer, who may read but not work', async () => {
    await givenStaff(OBSERVER, 'Observer', 'Visa', ['Tashkent']);

    expect(await forVisaInTashkent()).toBeNull();
  });

  it('never gives a case to a deactivated staff member', async () => {
    await givenStaff(BUSY, 'Support', 'Visa', ['Tashkent'], false);

    expect(await forVisaInTashkent()).toBeNull();
  });

  describe('the System bypass', () => {
    /**
     * **The trap in this whole part.** `staffCovering` returns every active
     * System member *unconditionally* — that is the bypass, it is correct, and
     * it is why a case in a region nobody covers still reaches somebody.
     *
     * Reused unchanged for assignment it would be quite wrong: every case in the
     * country would be handed to a System administrator, who is the person of
     * last resort rather than the person who works the queue. Worse, it would
     * empty `/cases unassigned` while making the backlog invisible, which is the
     * exact failure R4 exists to catch.
     */
    it('does not hand a case to System just because System can see everything', async () => {
      await givenStaff(SYSTEM, 'System', 'None', []);
      await givenStaff(BUSY, 'Support', 'Visa', ['Tashkent']);
      await givenCases(BUSY, 20);

      expect(await forVisaInTashkent()).toBe(BUSY);
    });

    it('leaves a case nobody covers UNOWNED rather than giving it to System', async () => {
      /**
       * This is what keeps `/cases unassigned` meaningful once assignment is
       * automatic. Before Part 5H that list meant "nobody has picked this up";
       * afterwards it means something sharper and more useful — **no active
       * staff member holds this queue in this region**, which is a staffing gap
       * somebody has to close.
       *
       * A System member still *sees* it, through the bypass, exactly as before.
       */
      await givenStaff(SYSTEM, 'System', 'None', []);
      await givenStaff(OTHER_REGION, 'Support', 'Visa', ['Samarkand']);

      expect(await forVisaInTashkent()).toBeNull();
    });
  });

  describe('the rank preference — D3, 5 August 2026', () => {
    /**
     * The head of project took the Program admin and the System member out of
     * the rotation, in their words because the Program admin is *"the MoPSE
     * employee that doesn't wanna be bothered with IT stuff"*. Both keep the
     * ability to own a case: `/assign` still works on them, and a case given
     * that way behaves like any other.
     *
     * The fallback below is what lets "every case has an owner" be stated with
     * no exception. It is not expected to fire in this ministry, because a
     * Support member covers every category in every region.
     */
    it('gives it to a Support member while a Program member sits idle', async () => {
      // Under the plain fewest-open rule she won every time, precisely because
      // nobody had given her anything yet.
      await givenStaff(BUSY, 'Support', 'Visa', ['Tashkent']);
      await givenStaff(PROGRAM, 'Program', 'Visa', ['Tashkent']);
      await givenCases(BUSY, 3);

      expect(await forVisaInTashkent()).toBe(BUSY);
    });

    it('gives it to a Lead as readily as to a Support member', async () => {
      // One tier, not two. A Lead works cases.
      await givenStaff(LEAD, 'Lead', 'Visa', ['Tashkent']);
      await givenStaff(PROGRAM, 'Program', 'Visa', ['Tashkent']);

      expect(await forVisaInTashkent()).toBe(LEAD);
    });

    it('falls back to Program when nobody below it covers the case', async () => {
      await givenStaff(PROGRAM, 'Program', 'Visa', ['Tashkent']);

      expect(await forVisaInTashkent()).toBe(PROGRAM);
    });

    it('falls all the way to System when nobody else is active at all', async () => {
      // A System member whose queue and region genuinely reach the case is not a
      // bypass row, so this tier is real rather than a restatement of the trap
      // the block above guards.
      await givenStaff(SYSTEM, 'System', 'Visa', ['Tashkent']);

      expect(await forVisaInTashkent()).toBe(SYSTEM);
    });

    it('prefers the rank before the load, never the other way about', async () => {
      // The sharpest version of the rule: the Support member has nine open cases
      // and the Program admin none, and the Support member still gets it.
      await givenStaff(BUSY, 'Support', 'Visa', ['Tashkent']);
      await givenStaff(PROGRAM, 'Program', 'Visa', ['Tashkent']);
      await givenCases(BUSY, 9);

      expect(await forVisaInTashkent()).toBe(BUSY);
    });

    it('still picks the least loaded inside the tier it settles on', async () => {
      await givenStaff(BUSY, 'Support', 'Visa', ['Tashkent']);
      await givenStaff(IDLE, 'Lead', 'Visa', ['Tashkent']);
      await givenCases(BUSY, 2);

      expect(await forVisaInTashkent()).toBe(IDLE);
    });
  });

  it('is stable when nobody has any cases, so the same case does not move about', async () => {
    // Ties are broken deterministically. A picker that returned a different
    // answer on each call would make the choice untestable and, worse, would
    // make a retried write assign the same case to two different people.
    await givenStaff(IDLE, 'Support', 'Visa', ['Tashkent']);
    await givenStaff(BUSY, 'Support', 'Visa', ['Tashkent']);

    const first = await forVisaInTashkent();
    expect(await forVisaInTashkent()).toBe(first);
    expect(first).not.toBeNull();
  });

  it('spreads ties by who was given work least recently', async () => {
    /**
     * Without this, the lowest id wins every tie and takes every case until it
     * is no longer tied — which on a two-person queue is a queue with one
     * person on it.
     */
    await givenStaff(BUSY, 'Support', 'Visa', ['Tashkent']);
    await givenStaff(IDLE, 'Support', 'Visa', ['Tashkent']);
    await givenCases(BUSY, 1);
    await givenCases(IDLE, 1);
    // BUSY's case is the newer one, so IDLE has waited longer for work.
    await db.execute(sql`
      UPDATE cases SET created_at = now() - make_interval(days => 5) WHERE owner = ${IDLE}
    `);

    expect(await forVisaInTashkent()).toBe(IDLE);
  });

  it('treats a teacher with no region as reachable by everybody', async () => {
    // A case whose teacher has no region is visible to every staff member (D10)
    // — over-routed rather than misrouted — so it must be assignable too.
    await givenStaff(BUSY, 'Support', 'Visa', ['Samarkand']);

    expect(await chooseOwner(db, { category: CASE_CATEGORY.VISA, region: null })).toBe(BUSY);
  });
});
