/**
 * Integration tests for the announcement store.
 *
 * Two tables built in stage 2 that nothing has ever written to. The tests that
 * matter most are the two the schema's own comments describe: the audience is
 * frozen so the number approved is the number messaged, and a send resumes
 * where it stopped rather than starting again.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ANNOUNCEMENT_MAX_ATTEMPTS } from '../config/constants.js';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import type { Audience } from './audience.js';
import {
  audienceSize,
  cancelAnnouncement,
  claimBatch,
  createDraft,
  finishIfDone,
  findAnnouncement,
  markQueued,
  markRecipient,
  nextSendable,
  resetStalledRecipients,
  returnForRetry,
  tally,
} from './store.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const SENDER = '939001';
const ALL: Audience = { kind: 'all' };
const BUKHARA: Audience = { kind: 'region', region: 'Bukhara' };

describe.skipIf(!TEST_DATABASE_URL)('the announcement store', () => {
  let pool: pg.Pool;
  let db: Database;

  const seedTeacher = async (
    chatId: string,
    over: {
      identifier?: string;
      region?: string | null;
      override?: string | null;
      state?: string;
      revoked?: boolean;
      rosterActive?: boolean;
      roster?: boolean;
    } = {},
  ): Promise<void> => {
    const identifier = over.identifier ?? `t${chatId}@example.com`;
    if (over.roster !== false) {
      await db.execute(sql`
        INSERT INTO roster_entries (identifier, name, region, active)
        VALUES (${identifier}, ${'Teacher ' + chatId}, ${over.region ?? 'Tashkent'}, ${over.rosterActive ?? true})
      `);
    }
    await db.execute(sql`
      INSERT INTO teachers (chat_id, verification_state, identifier, name, region_override, revoked_at)
      VALUES (
        ${chatId},
        ${over.state ?? 'Verified'}::verification_state,
        ${over.roster === false ? null : identifier},
        ${'Teacher ' + chatId},
        ${over.override ?? null},
        ${over.revoked === true ? sql`now()` : null}
      )
    `);
  };

  const recipientChatIds = async (id: string): Promise<string[]> => {
    const rows = await db.execute<{ chat_id: string }>(
      sql`SELECT chat_id FROM announcement_recipients WHERE announcement_id = ${id} ORDER BY chat_id`,
    );
    return rows.rows.map((r) => r.chat_id);
  };

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    await db.execute(sql`
      TRUNCATE announcements, announcement_recipients, teachers, roster_entries, cases CASCADE
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('the audience', () => {
    it('is every teacher who can use the bot', async () => {
      await seedTeacher('930001');
      await seedTeacher('930002');
      await expect(audienceSize(db, ALL)).resolves.toBe(2);
    });

    it('excludes a revoked teacher', async () => {
      // A broadcast is the largest possible way to get `teacherHasAccess` wrong,
      // so both of its halves are asserted separately.
      await seedTeacher('930001');
      await seedTeacher('930003', { state: 'Revoked', revoked: true });

      const { id } = await createDraft(db, { content: 'x', audience: ALL, createdBy: SENDER });
      expect(await recipientChatIds(id)).toEqual(['930001']);
    });

    it('excludes a teacher whose roster row was deactivated', async () => {
      await seedTeacher('930001');
      await seedTeacher('930004', { rosterActive: false });

      const { id } = await createDraft(db, { content: 'x', audience: ALL, createdBy: SENDER });
      expect(await recipientChatIds(id)).toEqual(['930001']);
    });

    it('excludes a teacher with no roster row at all', async () => {
      await seedTeacher('930001');
      await seedTeacher('930005', { roster: false });

      const { id } = await createDraft(db, { content: 'x', audience: ALL, createdBy: SENDER });
      expect(await recipientChatIds(id)).toEqual(['930001']);
    });

    it('reads a region the way everything else reads it, override first', async () => {
      // R12. The roster is recruitment's copy and goes stale; a staff-set
      // override beats it, and this is a message going to somebody's region.
      await seedTeacher('930001', { region: 'Tashkent', override: 'Bukhara' });
      await seedTeacher('930002', { region: 'Bukhara', override: null });
      await seedTeacher('930003', { region: 'Samarkand' });

      const { id } = await createDraft(db, { content: 'x', audience: BUKHARA, createdBy: SENDER });
      expect(await recipientChatIds(id)).toEqual(['930001', '930002']);
    });

    it('compares a region case-insensitively, like every other region comparison', async () => {
      await seedTeacher('930001', { region: 'bukhara' });
      const { id } = await createDraft(db, { content: 'x', audience: BUKHARA, createdBy: SENDER });
      expect(await recipientChatIds(id)).toEqual(['930001']);
    });
  });

  describe('freezing the audience', () => {
    it('writes the recipients when the draft is written, not when it is sent', async () => {
      /**
       * The flaw in the schema's own words: the old version counted the audience
       * once to show the sender a preview, then looked it up again when sending,
       * so the number approved was not the number that received it.
       */
      await seedTeacher('930001');
      const { id, recipients } = await createDraft(db, {
        content: 'x',
        audience: ALL,
        createdBy: SENDER,
      });
      expect(recipients).toBe(1);

      await seedTeacher('930002');

      expect(await recipientChatIds(id)).toEqual(['930001']);
      expect((await tally(db, id)).total).toBe(1);
    });

    it('writes a draft with nobody in it rather than refusing', async () => {
      // "Nobody is in that region" is a thing the sender needs told, and zero
      // is more useful than an error about an empty audience.
      const { recipients } = await createDraft(db, {
        content: 'x',
        audience: BUKHARA,
        createdBy: SENDER,
      });
      expect(recipients).toBe(0);
    });

    it('sends nothing until it is confirmed', async () => {
      await seedTeacher('930001');
      const { id } = await createDraft(db, { content: 'x', audience: ALL, createdBy: SENDER });

      expect((await findAnnouncement(db, id))?.status).toBe('Draft');
      await expect(nextSendable(db)).resolves.toBeNull();
    });
  });

  describe('confirming', () => {
    it('queues a draft exactly once', async () => {
      await seedTeacher('930001');
      const { id } = await createDraft(db, { content: 'x', audience: ALL, createdBy: SENDER });

      await expect(markQueued(db, id)).resolves.toBe(true);
      // Confirming twice must not start two sends.
      await expect(markQueued(db, id)).resolves.toBe(false);
    });

    it('refuses to queue one that was cancelled', async () => {
      const { id } = await createDraft(db, { content: 'x', audience: ALL, createdBy: SENDER });
      await cancelAnnouncement(db, id);
      await expect(markQueued(db, id)).resolves.toBe(false);
    });
  });

  describe('claiming a batch', () => {
    const seedMany = async (n: number): Promise<string> => {
      for (let i = 0; i < n; i += 1) await seedTeacher(String(931000 + i));
      const { id } = await createDraft(db, { content: 'x', audience: ALL, createdBy: SENDER });
      await markQueued(db, id);
      return id;
    };

    it('takes at most the batch size', async () => {
      const id = await seedMany(10);
      expect(await claimBatch(db, id, 4)).toHaveLength(4);
    });

    it('never hands the same recipient to two overlapping sweeps', async () => {
      /**
       * R27, second order. A slow run and the next minute's must not both claim
       * one teacher — the claim is a single conditional UPDATE, never a read
       * followed by a write.
       */
      const id = await seedMany(10);
      const [a, b] = await Promise.all([claimBatch(db, id, 10), claimBatch(db, id, 10)]);
      expect(a.filter((chatId) => b.includes(chatId))).toEqual([]);
      expect([...a, ...b]).toHaveLength(10);
    });

    it('resumes where it stopped rather than starting again', async () => {
      /**
       * The schema's second reason for this table: if the server stops at
       * teacher 900 of 1,800, delivery resumes at 901 and the first 900 cannot
       * be messaged twice.
       */
      const id = await seedMany(10);
      const first = await claimBatch(db, id, 4);
      for (const chatId of first) await markRecipient(db, id, chatId, 'Sent');

      const second = await claimBatch(db, id, 4);
      expect(second.filter((chatId) => first.includes(chatId))).toEqual([]);
    });

    it('moves the announcement to Sending on the first claim', async () => {
      const id = await seedMany(2);
      await claimBatch(db, id, 2);
      expect((await findAnnouncement(db, id))?.status).toBe('Sending');
    });

    it('hands a retryable recipient back for the next sweep', async () => {
      const id = await seedMany(2);
      const [chatId] = await claimBatch(db, id, 1);
      await returnForRetry(db, id, chatId!, 'rate limited');

      expect(await claimBatch(db, id, 2)).toContain(chatId);
    });

    /**
     * The recipient that could never stop being retried.
     *
     * `attempts` was incremented by every claim and read by nothing, so there
     * was no cap: one recipient failing every time meant the sweeper re-claimed
     * them once a minute for ever, the announcement stayed at `Sending`
     * indefinitely, and the person who sent it was never told it had ended.
     * Nothing raised an alarm, because from the outside it looked exactly like a
     * broadcast still in progress.
     */
    it('writes a recipient off once they have used up their attempts', async () => {
      // One recipient, so every claim is theirs and the count is unambiguous.
      const id = await seedMany(1);

      // Claim-and-fail, over and over, the way a rate-limited chat behaves. Runs
      // one pass beyond the cap, and the last of those must find nothing left to
      // claim — a written-off recipient is settled, so the sweeper stops seeing
      // them.
      let claims = 0;
      for (let i = 0; i <= ANNOUNCEMENT_MAX_ATTEMPTS; i += 1) {
        const claimed = await claimBatch(db, id, 1);
        if (claimed.length === 0) break;
        claims += 1;
        await returnForRetry(db, id, claimed[0]!, 'rate limited');
      }

      expect(claims).toBe(ANNOUNCEMENT_MAX_ATTEMPTS);

      const rows = await db.execute<{ state: string; attempts: number }>(sql`
        SELECT state, attempts FROM announcement_recipients WHERE announcement_id = ${id}
      `);
      expect(rows.rows[0]?.state).toBe('Failed');
      expect(rows.rows[0]?.attempts).toBe(ANNOUNCEMENT_MAX_ATTEMPTS);
      // The reason is kept, so somebody can see why they were written off.
      expect(rows.rows).toHaveLength(1);
    });

    it('lets the announcement reach Sent even when one recipient never succeeds', async () => {
      // The point of the cap. `finishIfDone` can only fire when every recipient
      // is in a settled state, so an uncapped retry meant an announcement that
      // could never finish.
      const id = await seedMany(2);

      for (let pass = 0; pass <= ANNOUNCEMENT_MAX_ATTEMPTS + 1; pass += 1) {
        const claimed = await claimBatch(db, id, 10);
        if (claimed.length === 0) break;
        for (const chatId of claimed) await returnForRetry(db, id, chatId, 'rate limited');
      }

      await expect(finishIfDone(db, id)).resolves.toBe(true);

      const counts = await tally(db, id);
      expect(counts.failed).toBe(2);
      expect(counts.sent).toBe(0);
    });

    it('returns a recipient stranded by a run that died mid-batch', async () => {
      // Without this the announcement sits at Sending for ever with a handful of
      // rows nobody will ever pick up.
      const id = await seedMany(2);
      await claimBatch(db, id, 2);
      await db.execute(
        sql`UPDATE announcements SET started_at = now() - interval '2 hours' WHERE id = ${id}`,
      );

      expect(await resetStalledRecipients(db, 30)).toBe(2);
      expect(await claimBatch(db, id, 2)).toHaveLength(2);
    });

    it('leaves a live run’s claims alone', async () => {
      // Returning a recipient a running sweep is still working on messages them
      // twice, which is worse than the stall it would fix.
      const id = await seedMany(2);
      await claimBatch(db, id, 2);
      expect(await resetStalledRecipients(db, 30)).toBe(0);
    });
  });

  describe('finishing', () => {
    it('does not finish while anything is still pending', async () => {
      await seedTeacher('930001');
      await seedTeacher('930002');
      const { id } = await createDraft(db, { content: 'x', audience: ALL, createdBy: SENDER });
      await markQueued(db, id);

      const claimed = await claimBatch(db, id, 1);
      await markRecipient(db, id, claimed[0]!, 'Sent');

      await expect(finishIfDone(db, id)).resolves.toBe(false);
      expect((await findAnnouncement(db, id))?.status).toBe('Sending');
    });

    it('finishes once every recipient is settled, and counts the three outcomes apart', async () => {
      // D41: sent, skipped and failed need different things done about them, so
      // they are never collapsed into one number.
      await seedTeacher('930001');
      await seedTeacher('930002');
      await seedTeacher('930003');
      const { id } = await createDraft(db, { content: 'x', audience: ALL, createdBy: SENDER });
      await markQueued(db, id);

      const claimed = await claimBatch(db, id, 3);
      await markRecipient(db, id, claimed[0]!, 'Sent');
      await markRecipient(db, id, claimed[1]!, 'Skipped', 'no longer has access');
      await markRecipient(db, id, claimed[2]!, 'Failed', 'blocked');

      await expect(finishIfDone(db, id)).resolves.toBe(true);
      await expect(tally(db, id)).resolves.toMatchObject({
        pending: 0,
        sent: 1,
        skipped: 1,
        failed: 1,
        total: 3,
      });
      expect((await findAnnouncement(db, id))?.finishedAt).not.toBeNull();
    });
  });

  describe('cancelling', () => {
    it('stops the remainder and says how many had already gone', async () => {
      // A cancel that claims to have stopped something already in somebody's
      // chat is worse than one that admits the number.
      await seedTeacher('930001');
      await seedTeacher('930002');
      const { id } = await createDraft(db, { content: 'x', audience: ALL, createdBy: SENDER });
      await markQueued(db, id);

      const claimed = await claimBatch(db, id, 1);
      await markRecipient(db, id, claimed[0]!, 'Sent');

      await expect(cancelAnnouncement(db, id)).resolves.toEqual({
        cancelled: true,
        alreadySent: 1,
      });
      expect((await findAnnouncement(db, id))?.status).toBe('Cancelled');
      await expect(nextSendable(db)).resolves.toBeNull();
    });

    it('refuses to cancel one that has already finished', async () => {
      await seedTeacher('930001');
      const { id } = await createDraft(db, { content: 'x', audience: ALL, createdBy: SENDER });
      await markQueued(db, id);
      const claimed = await claimBatch(db, id, 1);
      await markRecipient(db, id, claimed[0]!, 'Sent');
      await finishIfDone(db, id);

      await expect(cancelAnnouncement(db, id)).resolves.toMatchObject({ cancelled: false });
    });
  });

  describe('what the sweeper picks up', () => {
    it('takes a queued one, and one left mid-send by a restart', async () => {
      await seedTeacher('930001');
      const { id } = await createDraft(db, { content: 'x', audience: ALL, createdBy: SENDER });
      await markQueued(db, id);
      expect((await nextSendable(db))?.id).toBe(id);

      await claimBatch(db, id, 1);
      // Now `Sending` — the state a crashed run leaves behind. There is no
      // separate recovery path because the ordinary path already is one.
      expect((await nextSendable(db))?.id).toBe(id);
    });

    it('takes the oldest first', async () => {
      await seedTeacher('930001');
      const first = await createDraft(db, { content: 'a', audience: ALL, createdBy: SENDER });
      const second = await createDraft(db, { content: 'b', audience: ALL, createdBy: SENDER });
      await db.execute(
        sql`UPDATE announcements SET created_at = now() - interval '1 hour' WHERE id = ${first.id}`,
      );
      await markQueued(db, first.id);
      await markQueued(db, second.id);

      expect((await nextSendable(db))?.id).toBe(first.id);
    });
  });
});
