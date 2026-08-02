/**
 * Arguments about who a roster identity belongs to — Feature A.
 *
 * A dispute opens when a second Telegram account signs in as a teacher who is
 * already bound. **It does not gate the sign-in, and that is the decision rather
 * than an omission** (D1, restated in Part 2 of the programme plan): blocking the
 * second chat would lock out every teacher who changes phone, and would hand
 * anyone holding a leaked recruitment address a way to lock the real teacher out
 * permanently — turning an impersonation risk into a denial of service. The
 * second chat signs in, and the argument runs alongside.
 *
 * Four properties are load-bearing:
 *
 *   **Nobody in here decides anything.** Both parties may tap, both taps are
 *   recorded, and neither is given wording that lets it certify itself. The
 *   decision is `resolveDispute`, which floors at System.
 *
 *   **One open dispute per identity, enforced by the database.** Two chats
 *   presenting the same address at the same moment take two *different* chat
 *   locks — `withChatLock` is the sender's — so nothing above SQL can make "is
 *   one already open?" safe (R2). The partial unique index does it, and it is
 *   also what makes a third chat *join* rather than open a second record.
 *
 *   **Every write is guarded on the state it expects, in the same statement.**
 *   A button sits in a Telegram scrollback for ever, so two System members
 *   tapping a minute apart must produce one resolution, one audit row and one set
 *   of revocations — not two of each. That is a `WHERE` clause, never a branch
 *   above it.
 *
 *   **Nothing here sends.** It returns what happened; layer 3 turns that into
 *   messages, after the transaction commits. `dispute-notify.ts` computes who is
 *   told. This is the rule Part 0 names as the single easiest one to break, and a
 *   store whose whole subject is telling people would break it first.
 *
 * Revocation and case-closing are **reused, not reimplemented**. `revokeTeacher`
 * already writes the `TEACHER_REVOKED` audit row, and `updateCase` already keeps
 * `closed_at` and the teacher's chase clock correct — retention measures from
 * `closed_at`, so a hand-written `UPDATE` here would strand cases the clean-up
 * would never reach. Writing the second copy is what `CLAUDE.md` forbids.
 */
import { sql } from 'drizzle-orm';
import { TIMEZONE } from '../config/constants.js';
import { listCases } from '../cases/queries.js';
import { updateCase } from '../cases/service.js';
import type { Database } from '../db/index.js';
import type { IdentityDisputeClaim, IdentityDisputeState } from '../db/schema.js';
import { recordAudit } from '../log/audit.js';
import type { StaffScope } from '../staff/visibility.js';
import { revokeTeacher } from './repository.js';

/**
 * The scope `resolveDispute` reads a losing chat's cases at.
 *
 * System, because the *action* is System-floored, not because the person running
 * it happens to be. See the call site.
 */
const SYSTEM_SCOPE: StaffScope = { role: 'System', queue: 'All', regions: [] };

export interface OpenDisputeRequest {
  readonly identifier: string;
  /** The chat that has just signed in. */
  readonly chatId: string;
  /**
   * Every other chat already holding this identity.
   *
   * This is `priorHolders` from `verifyIdentifier`, unchanged. It is read before
   * the binding for a reason recorded there — read afterwards, the new chat is in
   * its own list and every sign-in looks like a duplicate.
   */
  readonly otherChatIds: readonly string[];
}

export interface OpenDisputeResult {
  readonly disputeId: number;
  /** False when this joined a dispute that was already open. */
  readonly isNew: boolean;
  readonly parties: readonly string[];
}

/**
 * Open a dispute over this identity, or join the one already open.
 *
 * The insert is `ON CONFLICT … DO NOTHING` against the partial unique index
 * rather than a read followed by a write, because the two chats involved are, by
 * definition, two different senders holding two different locks. A read-then-write
 * would open two records for the same argument roughly as often as two people
 * sign in within the same second — which, for the impersonation case this feature
 * exists to catch, is exactly when it matters.
 */
export async function openDispute(
  db: Database,
  request: OpenDisputeRequest,
): Promise<OpenDisputeResult> {
  const inserted = await db.execute<{ id: number }>(sql`
    INSERT INTO identity_disputes (identifier, state)
    VALUES (${request.identifier}, 'Open')
    ON CONFLICT (identifier) WHERE resolved_at IS NULL DO NOTHING
    RETURNING id
  `);

  const isNew = inserted.rows.length > 0;
  const disputeId =
    inserted.rows[0]?.id
    ?? (
      await db.execute<{ id: number }>(sql`
        SELECT id FROM identity_disputes
        WHERE identifier = ${request.identifier} AND resolved_at IS NULL
      `)
    ).rows[0]?.id;

  /**
   * No open dispute, and the insert did nothing.
   *
   * Only reachable if one was resolved between the two statements above, which
   * needs a System member settling this exact identity in the same instant. The
   * honest answer is to report the state we found rather than to retry into a
   * loop: the caller is a sign-in, and a teacher must not wait on a race.
   */
  if (disputeId === undefined) {
    return { disputeId: 0, isNew: false, parties: [] };
  }

  /**
   * Every party, including the chats that were already here.
   *
   * `ON CONFLICT DO NOTHING` on the composite key, so a chat that signs in three
   * times joins once and keeps the claim it may already have made. Re-inserting
   * would silently clear a party's answer, which is the one thing this table is
   * for.
   */
  const everyone = [request.chatId, ...request.otherChatIds];
  for (const chatId of everyone) {
    await db.execute(sql`
      INSERT INTO identity_dispute_parties (dispute_id, chat_id)
      VALUES (${disputeId}, ${chatId})
      ON CONFLICT (dispute_id, chat_id) DO NOTHING
    `);
  }

  const parties = await partyChatIds(db, disputeId);
  return { disputeId, isNew, parties };
}

export type ClaimOutcome =
  | {
      readonly kind: 'recorded';
      readonly identifier: string;
      /**
       * True only for the tap that moved the dispute out of `Open`.
       *
       * It is what decides whether the region's reviewers are told, so a second
       * party answering does not page the same people again about the same
       * argument.
       */
      readonly isFirstClaim: boolean;
      readonly parties: readonly string[];
    }
  /** The tapping chat is not on this dispute. A guessed payload, or a stale one. */
  | { readonly kind: 'notAParty' }
  /** No such dispute. A button from a build that no longer exists. */
  | { readonly kind: 'unknown' }
  | { readonly kind: 'alreadyResolved'; readonly keptChatId: string | null };

/**
 * Record what one party says, and report whether it was the first answer.
 *
 * **The claim is recorded against the chat the tap arrived from, never against a
 * chat named in the payload.** That is the whole authorisation of this path:
 * there is no staff row involved, because the people tapping are teachers, and a
 * payload that named its own party would let either account answer for the other
 * in a feature whose entire subject is two accounts disagreeing.
 *
 * One conditional `UPDATE`, joined against the dispute so that a settled dispute
 * cannot be claimed on. The `before` sub-select is not tidiness: `RETURNING`
 * yields post-update values, so asking "was this the first claim?" against the
 * updated row would answer itself every time — the trap `requestUrgentCase`
 * records and `clearUsername` was bitten by.
 */
export async function recordClaim(
  db: Database,
  disputeId: number,
  chatId: string,
  claim: IdentityDisputeClaim,
): Promise<ClaimOutcome> {
  const dispute = await disputeRow(db, disputeId);
  if (dispute === undefined) return { kind: 'unknown' };
  if (dispute.resolved_at !== null) {
    return { kind: 'alreadyResolved', keptChatId: dispute.kept_chat_id };
  }

  const updated = await db.execute<{ is_first_claim: boolean }>(sql`
    UPDATE identity_dispute_parties AS p
    SET claim = ${claim}, claimed_at = now()
    FROM (
      SELECT claimed_at AS was_claimed_at, resolved_at
      FROM identity_disputes WHERE id = ${disputeId}
    ) AS d
    WHERE p.dispute_id = ${disputeId}
      AND p.chat_id = ${chatId}
      AND d.resolved_at IS NULL
    RETURNING (d.was_claimed_at IS NULL) AS is_first_claim
  `);

  const row = updated.rows[0];
  if (row === undefined) return { kind: 'notAParty' };

  /**
   * Advance the dispute, guarded on `claimed_at IS NULL` so that two parties
   * tapping at once still produce one transition and one escalation. The state
   * and both stamps move together: `claimed_at` answers "when did somebody first
   * respond" and `escalated_at` answers "when were staff told", which share this
   * transaction but are genuinely two questions.
   */
  if (row.is_first_claim) {
    await db.execute(sql`
      UPDATE identity_disputes
      SET state = 'Claimed', claimed_at = now(), escalated_at = now()
      WHERE id = ${disputeId} AND claimed_at IS NULL
    `);
  }

  return {
    kind: 'recorded',
    identifier: dispute.identifier,
    isFirstClaim: row.is_first_claim,
    parties: await partyChatIds(db, disputeId),
  };
}

export type ForwardOutcome =
  | { readonly kind: 'forwarded'; readonly identifier: string; readonly parties: readonly string[] }
  | { readonly kind: 'alreadyWithSystem' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'alreadyResolved'; readonly keptChatId: string | null };

/**
 * A regional reviewer handing the argument to a System administrator.
 *
 * Guarded on `system_notified_at IS NULL`, so two reviewers tapping the same
 * message produce one forward and System is paged once. A reviewer can do exactly
 * two things with a dispute — read it and pass it on — and this is the second.
 */
export async function forwardToSystem(
  db: Database,
  disputeId: number,
  actor: string,
): Promise<ForwardOutcome> {
  const dispute = await disputeRow(db, disputeId);
  if (dispute === undefined) return { kind: 'unknown' };
  if (dispute.resolved_at !== null) {
    return { kind: 'alreadyResolved', keptChatId: dispute.kept_chat_id };
  }

  const updated = await db.execute<{ identifier: string }>(sql`
    UPDATE identity_disputes
    SET state = 'WithSystem', system_notified_at = now()
    WHERE id = ${disputeId}
      AND resolved_at IS NULL
      AND system_notified_at IS NULL
    RETURNING identifier
  `);

  if (updated.rows.length === 0) return { kind: 'alreadyWithSystem' };

  await recordAudit(db, {
    actor,
    action: 'IDENTITY_DISPUTE_ESCALATED',
    subject: dispute.identifier,
    detail: { disputeId },
  });

  return {
    kind: 'forwarded',
    identifier: dispute.identifier,
    parties: await partyChatIds(db, disputeId),
  };
}

export interface ResolveDisputeRequest {
  readonly disputeId: number;
  /** The chat judged to be the teacher's own. Every other party loses. */
  readonly keptChatId: string;
  readonly actor: string;
  /** What the resolver said, in their words. Staff-facing; no teacher reads it. */
  readonly outcome: string;
  /**
   * The `public_update` written on each closed case — and a teacher does read it.
   *
   * A parameter rather than a constant, because it has to name the support
   * contact and layer 2 has no route to one. It must state a reason and accuse
   * nobody: if the losing chat was the real teacher, this is the only thing that
   * tells them what happened and how to argue.
   */
  readonly closingNote: string;
}

export type ResolveOutcome =
  | {
      readonly kind: 'resolved';
      readonly identifier: string;
      readonly keptChatId: string;
      readonly revoked: readonly string[];
      readonly closedCases: readonly string[];
    }
  | { readonly kind: 'notAParty' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'alreadyResolved'; readonly keptChatId: string | null };

/**
 * Decide who the account belongs to — System only, and the one place it happens.
 *
 * **The losing chats are derived from the party list at this moment**, never
 * taken from the payload. A dispute that has acquired a third party since the
 * button was drawn would otherwise be half-settled: one loser revoked, one left
 * holding the identity, and nothing anywhere reporting it.
 *
 * **Closed, not deleted**, and Part 2's three reasons still hold: it contradicts
 * the reversible revoke chosen alongside it; if the losing chat was the imposter
 * its cases are the evidence of what they did and saw; and the audit trail here
 * is deliberately never pruned. Retention removes them on the ordinary schedule.
 *
 * The guard is the `WHERE` clause, not a branch. Everything after it runs only
 * because this statement changed a row, so a second System member tapping a
 * minute later revokes nobody and writes no second audit row.
 */
export async function resolveDispute(
  db: Database,
  request: ResolveDisputeRequest,
): Promise<ResolveOutcome> {
  const dispute = await disputeRow(db, request.disputeId);
  if (dispute === undefined) return { kind: 'unknown' };
  if (dispute.resolved_at !== null) {
    return { kind: 'alreadyResolved', keptChatId: dispute.kept_chat_id };
  }

  const parties = await partyChatIds(db, request.disputeId);
  if (!parties.includes(request.keptChatId)) return { kind: 'notAParty' };

  const settled = await db.execute<{ identifier: string }>(sql`
    UPDATE identity_disputes
    SET state = 'Resolved',
        resolved_at = now(),
        resolved_by = ${request.actor},
        kept_chat_id = ${request.keptChatId},
        outcome = ${request.outcome}
    WHERE id = ${request.disputeId} AND resolved_at IS NULL
    RETURNING identifier
  `);

  const row = settled.rows[0];
  if (row === undefined) {
    /** Somebody settled it between the read above and this write. */
    const now = await disputeRow(db, request.disputeId);
    return { kind: 'alreadyResolved', keptChatId: now?.kept_chat_id ?? null };
  }

  const losers = parties.filter((chatId) => chatId !== request.keptChatId);
  const revoked: string[] = [];
  const closedCases: string[] = [];

  for (const chatId of losers) {
    /**
     * `revokeTeacher` reports false for a chat with no teacher row, which is
     * ordinary rather than exceptional — a party can be a chat that was on the
     * dispute before its teacher row was anonymised by `/forget`.
     */
    if (await revokeTeacher(db, chatId, request.actor)) revoked.push(chatId);

    /**
     * Read at System scope, deliberately, and not at the resolver's own.
     *
     * `listCases` takes a scope because a staff member must only see their own
     * queue and region. This path is System-only — `dispute.resolve` floors
     * there — and a System scope bypasses both axes anyway, so passing the
     * resolver's own scope would change nothing on the happy path and would go
     * quietly wrong the day the floor moves: a case left open because the
     * resolver's queue did not reach it is a case still belonging to an account
     * the Ministry has just judged is not the teacher's.
     *
     * Written out rather than derived from the actor, because the reason it is
     * System is the *action*, not who happens to be performing it.
     */
    const open = await listCases(db, SYSTEM_SCOPE, { teacherChatId: chatId });
    for (const found of open.cases) {
      await updateCase(
        db,
        found.reference,
        { status: 'Closed', publicUpdate: request.closingNote },
        request.actor,
      );
      closedCases.push(found.reference);
    }
  }

  await recordAudit(db, {
    actor: request.actor,
    action: 'IDENTITY_DISPUTE_RESOLVED',
    subject: row.identifier,
    detail: {
      disputeId: request.disputeId,
      keptChatId: request.keptChatId,
      revoked,
      closedCases,
      outcome: request.outcome,
    },
  });

  return {
    kind: 'resolved',
    identifier: row.identifier,
    keptChatId: request.keptChatId,
    revoked,
    closedCases,
  };
}

export interface DisputeParty {
  readonly chatId: string;
  readonly claim: IdentityDisputeClaim | null;
  /** Formatted in SQL, in Tashkent. Null when they have not answered. */
  readonly claimedAt: string | null;
}

export interface DisputeSummary {
  readonly id: number;
  readonly identifier: string;
  readonly state: IdentityDisputeState;
  /**
   * Formatted by the database, in Tashkent.
   *
   * `db.execute` hands back the raw string PostgreSQL sent — drizzle installs its
   * own pg parsers and does not parse timestamps the way `pool.query` does — so a
   * column typed here as a `Date` compiles perfectly and throws at run time. That
   * fault has been walked into twice in this project. It is done in SQL, where
   * there is no second place to forget it.
   */
  readonly openedAt: string;
  readonly parties: readonly string[];
}

export interface DisputeDetail extends DisputeSummary {
  readonly parties: readonly string[];
  readonly partyDetail: readonly DisputeParty[];
  readonly keptChatId: string | null;
  readonly resolvedAt: string | null;
}

/**
 * Disputes nobody has settled, oldest first.
 *
 * Oldest first because this is a backlog, and the one that has waited longest is
 * the one somebody should look at. Part 2 declines to auto-expire a dispute and
 * chooses visibility instead — so this is the query behind that choice, and a
 * dispute nobody answers has to be findable or the accepted risk is one nobody
 * can see.
 */
export async function openDisputes(db: Database, limit: number): Promise<DisputeSummary[]> {
  const rows = await db.execute<{
    id: number;
    identifier: string;
    state: IdentityDisputeState;
    opened_at: string;
    parties: string[] | null;
  }>(sql`
    SELECT d.id, d.identifier, d.state,
           to_char(d.opened_at AT TIME ZONE ${TIMEZONE}, 'DD Mon YYYY, HH24:MI') AS opened_at,
           array_agg(p.chat_id ORDER BY p.chat_id) FILTER (WHERE p.chat_id IS NOT NULL) AS parties
    FROM identity_disputes d
    LEFT JOIN identity_dispute_parties p ON p.dispute_id = d.id
    WHERE d.resolved_at IS NULL
    GROUP BY d.id
    ORDER BY d.opened_at ASC
    LIMIT ${limit}
  `);

  return rows.rows.map((r) => ({
    id: r.id,
    identifier: r.identifier,
    state: r.state,
    openedAt: r.opened_at,
    parties: r.parties ?? [],
  }));
}

/** One dispute with every party and what each of them said. */
export async function disputeDetail(
  db: Database,
  disputeId: number,
): Promise<DisputeDetail | null> {
  const rows = await db.execute<{
    id: number;
    identifier: string;
    state: IdentityDisputeState;
    opened_at: string;
    kept_chat_id: string | null;
    resolved_at: string | null;
  }>(sql`
    SELECT id, identifier, state,
           to_char(opened_at AT TIME ZONE ${TIMEZONE}, 'DD Mon YYYY, HH24:MI') AS opened_at,
           kept_chat_id,
           to_char(resolved_at AT TIME ZONE ${TIMEZONE}, 'DD Mon YYYY, HH24:MI') AS resolved_at
    FROM identity_disputes WHERE id = ${disputeId}
  `);

  const row = rows.rows[0];
  if (row === undefined) return null;

  const parties = await db.execute<{
    chat_id: string;
    claim: IdentityDisputeClaim | null;
    claimed_at: string | null;
  }>(sql`
    SELECT chat_id, claim,
           to_char(claimed_at AT TIME ZONE ${TIMEZONE}, 'DD Mon YYYY, HH24:MI') AS claimed_at
    FROM identity_dispute_parties
    WHERE dispute_id = ${disputeId}
    ORDER BY chat_id ASC
  `);

  const partyDetail = parties.rows.map((p) => ({
    chatId: p.chat_id,
    claim: p.claim,
    claimedAt: p.claimed_at,
  }));

  return {
    id: row.id,
    identifier: row.identifier,
    state: row.state,
    openedAt: row.opened_at,
    keptChatId: row.kept_chat_id,
    resolvedAt: row.resolved_at,
    parties: partyDetail.map((p) => p.chatId),
    partyDetail,
  };
}

/**
 * A type alias rather than an interface, and that is not a style choice.
 *
 * `db.execute<T>` constrains `T` to `Record<string, unknown>`. A type literal has
 * an implicit index signature and satisfies it; a declared interface does not.
 */
type DisputeRow = {
  readonly id: number;
  readonly identifier: string;
  readonly resolved_at: string | null;
  readonly kept_chat_id: string | null;
};

async function disputeRow(db: Database, disputeId: number): Promise<DisputeRow | undefined> {
  const rows = await db.execute<DisputeRow>(sql`
    SELECT id, identifier, resolved_at, kept_chat_id
    FROM identity_disputes WHERE id = ${disputeId}
  `);
  return rows.rows[0];
}

async function partyChatIds(db: Database, disputeId: number): Promise<string[]> {
  const rows = await db.execute<{ chat_id: string }>(sql`
    SELECT chat_id FROM identity_dispute_parties
    WHERE dispute_id = ${disputeId} ORDER BY chat_id ASC
  `);
  return rows.rows.map((r) => r.chat_id);
}
