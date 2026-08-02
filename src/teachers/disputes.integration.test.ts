/**
 * Integration tests for identity disputes — Feature A.
 *
 * Against a real PostgreSQL, because almost everything interesting here is a
 * conditional `UPDATE` or a partial unique index, and neither can be reasoned
 * about from above the database. "The third chat joins rather than opening a
 * second record" is a property of an index, not of a branch.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   $env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CASE_CATEGORY } from '../config/constants.js';
import { createCase } from '../cases/service.js';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import {
  disputeDetail,
  openDispute,
  openDisputes,
  forwardToSystem,
  recordClaim,
  resolveDispute,
} from './disputes.js';
import { findTeacher } from './repository.js';
import { verifyIdentifier } from './verify.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const IDENT = 'dispute.tester@example.com';
const CHAT_A = '930001';
const CHAT_B = '930002';
const CHAT_C = '930003';
const SYSTEM_STAFF = '939999';
const STRANGER = '930777';
const NOTE = 'Closed by the Ministry. If this is wrong, contact support@example.com.';

const NO_PERIODS = { caseDays: null, urgentCaseDays: null, messageDays: null };

describe.skipIf(!TEST_DATABASE_URL)('identity disputes', () => {
  let pool: pg.Pool;
  let db: Database;

  /** Sign a chat in against the shared roster identity, the way the router does. */
  const signIn = (chatId: string): Promise<unknown> =>
    verifyIdentifier(db, chatId, IDENT, 0, NO_PERIODS);

  const partiesOf = async (disputeId: number): Promise<string[]> => {
    const detail = await disputeDetail(db, disputeId);
    return [...(detail?.parties ?? [])].sort();
  };

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as unknown as Database;
    /**
     * `staff` is truncated here even though most of these tests never read it.
     * Part 5H.1 recorded the fault this avoids: `urgent.integration.test.ts` did
     * not clean `staff`, a row left behind by another file leaked in, and the
     * moment automatic assignment made staff rows load-bearing inside
     * `createCase` a test asserting "no owner" failed against a person it had
     * never heard of. Resolution in this file closes cases, which goes through
     * exactly that path.
     */
    await db.execute(sql`
      TRUNCATE identity_dispute_parties, identity_disputes, cases, case_notes,
               teachers, roster_entries, case_sequences, staff, audit_log CASCADE
    `);
    await db.execute(sql`
      INSERT INTO roster_entries (identifier, name, region, active)
      VALUES (${IDENT}, 'Dispute Tester', 'Samarkand', true)
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  // -------------------------------------------------------------------------
  // Opening, and the third chat
  // -------------------------------------------------------------------------

  it('opens one dispute and puts both chats on it', async () => {
    const first = await openDispute(db, { identifier: IDENT, chatId: CHAT_A, otherChatIds: [] });
    const second = await openDispute(db, {
      identifier: IDENT,
      chatId: CHAT_B,
      otherChatIds: [CHAT_A],
    });

    expect(second.disputeId).toBe(first.disputeId);
    expect(second.isNew).toBe(false);
    expect(await partiesOf(first.disputeId)).toEqual([CHAT_A, CHAT_B]);
  });

  it('joins a third chat to the same dispute rather than opening a second', async () => {
    // The requirement the two-table model exists to satisfy. A record with
    // `prior_chat_id` and `new_chat_id` has nowhere to put this chat.
    const one = await openDispute(db, { identifier: IDENT, chatId: CHAT_A, otherChatIds: [] });
    await openDispute(db, { identifier: IDENT, chatId: CHAT_B, otherChatIds: [CHAT_A] });
    const three = await openDispute(db, {
      identifier: IDENT,
      chatId: CHAT_C,
      otherChatIds: [CHAT_A, CHAT_B],
    });

    expect(three.disputeId).toBe(one.disputeId);
    expect(await partiesOf(one.disputeId)).toEqual([CHAT_A, CHAT_B, CHAT_C]);
  });

  it('joins a chat that signs in twice exactly once', async () => {
    const one = await openDispute(db, { identifier: IDENT, chatId: CHAT_A, otherChatIds: [] });
    await openDispute(db, { identifier: IDENT, chatId: CHAT_B, otherChatIds: [CHAT_A] });
    await openDispute(db, { identifier: IDENT, chatId: CHAT_B, otherChatIds: [CHAT_A] });

    expect(await partiesOf(one.disputeId)).toEqual([CHAT_A, CHAT_B]);
  });

  it('opens a fresh dispute once the previous one is settled', async () => {
    // The unique index is partial on `resolved_at IS NULL` precisely so that an
    // identity contested twice gets two records rather than one reopened.
    const first = await openDispute(db, { identifier: IDENT, chatId: CHAT_A, otherChatIds: [] });
    await openDispute(db, { identifier: IDENT, chatId: CHAT_B, otherChatIds: [CHAT_A] });
    await resolveDispute(db, {
      disputeId: first.disputeId,
      keptChatId: CHAT_A,
      actor: SYSTEM_STAFF,
      outcome: 'checked',
      closingNote: NOTE,
    });

    const second = await openDispute(db, {
      identifier: IDENT,
      chatId: CHAT_C,
      otherChatIds: [CHAT_A],
    });
    expect(second.disputeId).not.toBe(first.disputeId);
    expect(second.isNew).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Claiming
  // -------------------------------------------------------------------------

  it('records a claim and moves the dispute to Claimed', async () => {
    const { disputeId } = await openDispute(db, {
      identifier: IDENT,
      chatId: CHAT_A,
      otherChatIds: [],
    });
    await openDispute(db, { identifier: IDENT, chatId: CHAT_B, otherChatIds: [CHAT_A] });

    const claimed = await recordClaim(db, disputeId, CHAT_A, 'NotMine');

    expect(claimed.kind).toBe('recorded');
    expect((await disputeDetail(db, disputeId))?.state).toBe('Claimed');
  });

  it('lets the second party claim too, and reports it is not the first', async () => {
    // `isFirstClaim` is what decides whether reviewers are told, so the second
    // tap must be distinguishable or a dispute pages the region twice.
    const { disputeId } = await openDispute(db, {
      identifier: IDENT,
      chatId: CHAT_A,
      otherChatIds: [],
    });
    await openDispute(db, { identifier: IDENT, chatId: CHAT_B, otherChatIds: [CHAT_A] });

    const first = await recordClaim(db, disputeId, CHAT_A, 'NotMine');
    const second = await recordClaim(db, disputeId, CHAT_B, 'Mine');

    expect(first.kind === 'recorded' && first.isFirstClaim).toBe(true);
    expect(second.kind === 'recorded' && second.isFirstClaim).toBe(false);
  });

  it('keeps both claims, so neither party overwrites the other', async () => {
    const { disputeId } = await openDispute(db, {
      identifier: IDENT,
      chatId: CHAT_A,
      otherChatIds: [],
    });
    await openDispute(db, { identifier: IDENT, chatId: CHAT_B, otherChatIds: [CHAT_A] });

    await recordClaim(db, disputeId, CHAT_A, 'NotMine');
    await recordClaim(db, disputeId, CHAT_B, 'Mine');

    const detail = await disputeDetail(db, disputeId);
    expect(detail?.partyDetail.find((p) => p.chatId === CHAT_A)?.claim).toBe('NotMine');
    expect(detail?.partyDetail.find((p) => p.chatId === CHAT_B)?.claim).toBe('Mine');
  });

  it('lets one party change its mind without re-escalating', async () => {
    const { disputeId } = await openDispute(db, {
      identifier: IDENT,
      chatId: CHAT_A,
      otherChatIds: [],
    });
    await recordClaim(db, disputeId, CHAT_A, 'NotMine');
    const again = await recordClaim(db, disputeId, CHAT_A, 'Mine');

    expect(again.kind === 'recorded' && again.isFirstClaim).toBe(false);
    const detail = await disputeDetail(db, disputeId);
    expect(detail?.partyDetail.find((p) => p.chatId === CHAT_A)?.claim).toBe('Mine');
  });

  it('refuses a claim from a chat that is not a party', async () => {
    // A stranger who guesses `DC:1:Mine` must not be able to write anything.
    const { disputeId } = await openDispute(db, {
      identifier: IDENT,
      chatId: CHAT_A,
      otherChatIds: [],
    });

    expect((await recordClaim(db, disputeId, STRANGER, 'Mine')).kind).toBe('notAParty');
  });

  it('reports a claim on a dispute that no longer exists', async () => {
    expect((await recordClaim(db, 999_999, CHAT_A, 'Mine')).kind).toBe('unknown');
  });

  it('reports a claim on a settled dispute rather than recording it', async () => {
    // A button sits in a teacher's scrollback for ever. Tapping one after the
    // decision must say so and change nothing.
    const { disputeId } = await openDispute(db, {
      identifier: IDENT,
      chatId: CHAT_A,
      otherChatIds: [],
    });
    await openDispute(db, { identifier: IDENT, chatId: CHAT_B, otherChatIds: [CHAT_A] });
    await resolveDispute(db, {
      disputeId,
      keptChatId: CHAT_A,
      actor: SYSTEM_STAFF,
      outcome: 'checked',
      closingNote: NOTE,
    });

    const late = await recordClaim(db, disputeId, CHAT_B, 'Mine');
    expect(late.kind).toBe('alreadyResolved');
    expect(late.kind === 'alreadyResolved' && late.keptChatId).toBe(CHAT_A);
  });

  // -------------------------------------------------------------------------
  // Forwarding to System
  // -------------------------------------------------------------------------

  it('forwards to System once, and reports a second forward as a no-op', async () => {
    const { disputeId } = await openDispute(db, {
      identifier: IDENT,
      chatId: CHAT_A,
      otherChatIds: [],
    });

    expect((await forwardToSystem(db, disputeId, SYSTEM_STAFF)).kind).toBe('forwarded');
    expect((await forwardToSystem(db, disputeId, SYSTEM_STAFF)).kind).toBe('alreadyWithSystem');
    expect((await disputeDetail(db, disputeId))?.state).toBe('WithSystem');
  });

  it('refuses to forward a settled dispute', async () => {
    const { disputeId } = await openDispute(db, {
      identifier: IDENT,
      chatId: CHAT_A,
      otherChatIds: [],
    });
    await resolveDispute(db, {
      disputeId,
      keptChatId: CHAT_A,
      actor: SYSTEM_STAFF,
      outcome: 'checked',
      closingNote: NOTE,
    });

    expect((await forwardToSystem(db, disputeId, SYSTEM_STAFF)).kind).toBe('alreadyResolved');
  });

  // -------------------------------------------------------------------------
  // Resolving
  // -------------------------------------------------------------------------

  it('revokes every losing chat, closes their cases, and leaves the winner alone', async () => {
    await signIn(CHAT_A);
    await signIn(CHAT_B);
    await createCase(db, { chatId: CHAT_B, category: CASE_CATEGORY.VISA, detail: 'my visa' });
    await createCase(db, { chatId: CHAT_A, category: CASE_CATEGORY.VISA, detail: 'mine too' });

    const { disputeId } = await openDispute(db, {
      identifier: IDENT,
      chatId: CHAT_A,
      otherChatIds: [],
    });
    await openDispute(db, { identifier: IDENT, chatId: CHAT_B, otherChatIds: [CHAT_A] });

    const outcome = await resolveDispute(db, {
      disputeId,
      keptChatId: CHAT_A,
      actor: SYSTEM_STAFF,
      outcome: 'telephoned the school',
      closingNote: NOTE,
    });

    expect(outcome.kind).toBe('resolved');
    expect(outcome.kind === 'resolved' && outcome.revoked).toEqual([CHAT_B]);
    expect((await findTeacher(db, CHAT_B))?.verificationState).toBe('Revoked');
    expect((await findTeacher(db, CHAT_A))?.verificationState).toBe('Verified');

    const losing = await db.execute<{ status: string; public_update: string | null }>(
      sql`SELECT status, public_update FROM cases WHERE teacher_chat_id = ${CHAT_B}`,
    );
    expect(losing.rows.every((r) => r.status === 'Closed')).toBe(true);
    expect(losing.rows[0]?.public_update).toBe(NOTE);

    // The winner's own case is untouched — closing it would punish the teacher
    // the decision went in favour of.
    const winning = await db.execute<{ status: string }>(
      sql`SELECT status FROM cases WHERE teacher_chat_id = ${CHAT_A}`,
    );
    expect(winning.rows.every((r) => r.status !== 'Closed')).toBe(true);
  });

  it('stamps closed_at on the cases it closes, so retention can find them', async () => {
    // Retention measures from `closed_at`, and a hand-written UPDATE here would
    // strand it — which is why this goes through `updateCase` rather than SQL.
    await signIn(CHAT_A);
    await signIn(CHAT_B);
    await createCase(db, { chatId: CHAT_B, category: CASE_CATEGORY.VISA, detail: 'my visa' });

    const { disputeId } = await openDispute(db, {
      identifier: IDENT,
      chatId: CHAT_A,
      otherChatIds: [],
    });
    await openDispute(db, { identifier: IDENT, chatId: CHAT_B, otherChatIds: [CHAT_A] });
    await resolveDispute(db, {
      disputeId,
      keptChatId: CHAT_A,
      actor: SYSTEM_STAFF,
      outcome: 'checked',
      closingNote: NOTE,
    });

    const rows = await db.execute<{ closed: boolean }>(
      sql`SELECT closed_at IS NOT NULL AS closed FROM cases WHERE teacher_chat_id = ${CHAT_B}`,
    );
    expect(rows.rows.every((r) => r.closed)).toBe(true);
  });

  it('revokes both losers when three chats are disputing', async () => {
    await signIn(CHAT_A);
    await signIn(CHAT_B);
    await signIn(CHAT_C);

    const { disputeId } = await openDispute(db, {
      identifier: IDENT,
      chatId: CHAT_A,
      otherChatIds: [],
    });
    await openDispute(db, { identifier: IDENT, chatId: CHAT_B, otherChatIds: [CHAT_A] });
    await openDispute(db, { identifier: IDENT, chatId: CHAT_C, otherChatIds: [CHAT_A, CHAT_B] });

    const outcome = await resolveDispute(db, {
      disputeId,
      keptChatId: CHAT_B,
      actor: SYSTEM_STAFF,
      outcome: 'checked',
      closingNote: NOTE,
    });

    expect(outcome.kind === 'resolved' && [...outcome.revoked].sort()).toEqual([CHAT_A, CHAT_C]);
  });

  it('refuses to settle in favour of a chat that is not a party', async () => {
    const { disputeId } = await openDispute(db, {
      identifier: IDENT,
      chatId: CHAT_A,
      otherChatIds: [],
    });

    const outcome = await resolveDispute(db, {
      disputeId,
      keptChatId: STRANGER,
      actor: SYSTEM_STAFF,
      outcome: 'x',
      closingNote: NOTE,
    });
    expect(outcome.kind).toBe('notAParty');
  });

  it('makes a second resolution a no-op rather than a second set of revocations', async () => {
    // Two System members tapping the same message a minute apart. The guard is in
    // the WHERE clause of the UPDATE, not in a branch above it.
    await signIn(CHAT_A);
    await signIn(CHAT_B);

    const { disputeId } = await openDispute(db, {
      identifier: IDENT,
      chatId: CHAT_A,
      otherChatIds: [],
    });
    await openDispute(db, { identifier: IDENT, chatId: CHAT_B, otherChatIds: [CHAT_A] });
    await resolveDispute(db, {
      disputeId,
      keptChatId: CHAT_A,
      actor: SYSTEM_STAFF,
      outcome: 'first',
      closingNote: NOTE,
    });

    const again = await resolveDispute(db, {
      disputeId,
      keptChatId: CHAT_B,
      actor: SYSTEM_STAFF,
      outcome: 'second',
      closingNote: NOTE,
    });

    expect(again.kind).toBe('alreadyResolved');
    expect((await findTeacher(db, CHAT_A))?.verificationState).toBe('Verified');
    expect((await findTeacher(db, CHAT_B))?.verificationState).toBe('Revoked');
  });

  it('writes exactly one audit row for a resolution', async () => {
    await signIn(CHAT_A);
    await signIn(CHAT_B);

    const { disputeId } = await openDispute(db, {
      identifier: IDENT,
      chatId: CHAT_A,
      otherChatIds: [],
    });
    await openDispute(db, { identifier: IDENT, chatId: CHAT_B, otherChatIds: [CHAT_A] });
    await resolveDispute(db, {
      disputeId,
      keptChatId: CHAT_A,
      actor: SYSTEM_STAFF,
      outcome: 'checked',
      closingNote: NOTE,
    });
    await resolveDispute(db, {
      disputeId,
      keptChatId: CHAT_B,
      actor: SYSTEM_STAFF,
      outcome: 'again',
      closingNote: NOTE,
    });

    const rows = await db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM audit_log WHERE action = 'IDENTITY_DISPUTE_RESOLVED'`,
    );
    expect(rows.rows[0]?.n).toBe('1');
  });

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  it('lists open disputes and drops them once settled', async () => {
    const { disputeId } = await openDispute(db, {
      identifier: IDENT,
      chatId: CHAT_A,
      otherChatIds: [],
    });
    await openDispute(db, { identifier: IDENT, chatId: CHAT_B, otherChatIds: [CHAT_A] });

    const before = await openDisputes(db, 10);
    expect(before.length).toBe(1);
    expect(before[0]?.parties.length).toBe(2);
    // Formatted by the database in Tashkent, never handed back as a Date.
    expect(typeof before[0]?.openedAt).toBe('string');

    await resolveDispute(db, {
      disputeId,
      keptChatId: CHAT_A,
      actor: SYSTEM_STAFF,
      outcome: 'checked',
      closingNote: NOTE,
    });
    expect(await openDisputes(db, 10)).toEqual([]);
  });
});
