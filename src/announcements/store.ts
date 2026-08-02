/**
 * Announcements: the audience, the freeze, the batches, and the report.
 *
 * `announcements` and `announcement_recipients` were built in stage 2 and
 * **nothing has ever written a row to either.** They were built for this, and
 * the schema records the two flaws they exist to close:
 *
 *   The Apps Script version counted the audience once to show the sender a
 *   preview and looked it up again when sending, so the number approved was not
 *   the number that received it. Here the audience is frozen when the draft is
 *   written, which is the only version where those two numbers are the same one.
 *
 *   It reported "900 not attempted, re-run for the remainder", and re-running
 *   risked messaging all 1,800 again. Here every recipient is a row with a
 *   state, so delivery resumes where it stopped and nobody is messaged twice.
 *
 * Every claim and every mark is a single statement. The sweeper runs in the
 * worker with no chat lock, and two overlapping runs must not be able to claim
 * one recipient — a read followed by a write is exactly how they would.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { ANNOUNCEMENT_MAX_ATTEMPTS } from '../config/constants.js';
import type { Database } from '../db/index.js';
import {
  announcementRecipients,
  announcements,
  rosterEntries,
  teachers,
} from '../db/schema.js';
import type { Audience } from './audience.js';
import { renderAudience } from './audience.js';

export interface AnnouncementRow {
  readonly id: string;
  readonly content: string;
  readonly audience: string;
  readonly status: 'Draft' | 'Queued' | 'Sending' | 'Sent' | 'Failed' | 'Cancelled';
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

const COLUMNS = {
  id: announcements.id,
  content: announcements.content,
  audience: announcements.audience,
  status: announcements.status,
  createdBy: announcements.createdBy,
  createdAt: announcements.createdAt,
  startedAt: announcements.startedAt,
  finishedAt: announcements.finishedAt,
};

/**
 * Who can actually receive a message right now.
 *
 * This is `teacherHasAccess` expressed in SQL, and it is the one place in the
 * system where that check becomes a set rather than a question about one person.
 * Both halves are here for the reason D17 gives: the state, which `/revoke`
 * writes, and the roster, which is the route an operator will actually use. A
 * broadcast is the largest possible way to get that check wrong.
 *
 * The roster join is INNER here, unlike everywhere else, and that is deliberate
 * rather than an oversight: a teacher with no roster row has no access, so they
 * are not a recipient. Elsewhere the join is LEFT because their *cases* must
 * stay visible to staff.
 */
function audienceWhere(audience: Audience) {
  const base = and(
    eq(teachers.verificationState, 'Verified'),
    sql`${teachers.revokedAt} IS NULL`,
    eq(rosterEntries.active, true),
  )!;

  if (audience.kind === 'all') return base;

  /**
   * Region resolved the way everything else resolves it — the staff-set override
   * first, the roster second (R12). Compared case-insensitively, as every other
   * region comparison in this system is.
   */
  return and(
    base,
    sql`lower(coalesce(${teachers.regionOverride}, ${rosterEntries.region})) = lower(${audience.region})`,
  )!;
}

/** How many would receive this, without writing anything. For a preview only. */
export async function audienceSize(db: Database, audience: Audience): Promise<number> {
  const rows = await db
    .select({ count: sql<string>`count(*)` })
    .from(teachers)
    .innerJoin(rosterEntries, eq(teachers.identifier, rosterEntries.identifier))
    .where(audienceWhere(audience));

  return Number(rows[0]?.count ?? 0);
}

export interface DraftRequest {
  readonly content: string;
  readonly audience: Audience;
  readonly createdBy: string;
}

/**
 * Write the announcement and freeze its audience, in one statement each.
 *
 * The recipient rows are written **now**, at draft time, not when the sender
 * confirms. That is what makes the count in the confirmation the count that will
 * be messaged — the flaw the schema describes, closed at the only point where
 * it can be.
 *
 * A draft with no recipients is still written. "Nobody is in that region" is a
 * thing the sender needs told, and reporting zero is more useful than refusing
 * with an error about an empty audience.
 */
export async function createDraft(
  db: Database,
  request: DraftRequest,
): Promise<{ id: string; recipients: number }> {
  const inserted = await db
    .insert(announcements)
    .values({
      content: request.content,
      audience: renderAudience(request.audience),
      status: 'Draft',
      createdBy: request.createdBy,
    })
    .returning({ id: announcements.id });

  const id = inserted[0]!.id;

  /**
   * The tables are **not** aliased here, and that is load-bearing rather than a
   * style choice. `audienceWhere` is built from drizzle column references, which
   * render as fully-qualified `"teachers"."verification_state"` — an alias makes
   * those names unresolvable and PostgreSQL rejects the statement outright. The
   * same trap `visibility.ts` documents one row along: a fragment that reads
   * fine and only fails at the database.
   */
  const frozen = await db.execute(sql`
    INSERT INTO announcement_recipients (announcement_id, chat_id)
    SELECT ${id}, teachers.chat_id
    FROM teachers
    JOIN roster_entries ON roster_entries.identifier = teachers.identifier
    WHERE ${audienceWhere(request.audience)}
  `);

  return { id, recipients: frozen.rowCount ?? 0 };
}

export async function findAnnouncement(db: Database, id: string): Promise<AnnouncementRow | null> {
  const rows = await db.select(COLUMNS).from(announcements).where(eq(announcements.id, id)).limit(1);
  return (rows[0] as AnnouncementRow | undefined) ?? null;
}

/** Recent announcements, newest first, for `/announcements`. */
export async function listAnnouncements(db: Database, limit: number): Promise<AnnouncementRow[]> {
  const rows = await db
    .select(COLUMNS)
    .from(announcements)
    .orderBy(desc(announcements.createdAt))
    .limit(limit);
  return rows as AnnouncementRow[];
}

/**
 * Confirm a draft.
 *
 * Conditional on the current status, in one statement, so confirming twice
 * cannot start two sends. Returns false when it was not a draft — already sent,
 * already cancelled, or already queued — and the command says which by reading
 * the row.
 */
export async function markQueued(db: Database, id: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE announcements SET status = 'Queued'
    WHERE id = ${id} AND status = 'Draft'
  `);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Stop an announcement, and say how many had already gone.
 *
 * A cancel after sending has begun stops the remainder and cannot recall what
 * has been delivered. Reporting the number that went is the honest version;
 * claiming to have stopped something already in somebody's chat is not.
 *
 * The pending rows are marked `Skipped` rather than deleted, so the record of
 * who was *not* messaged survives alongside the record of who was.
 */
export async function cancelAnnouncement(
  db: Database,
  id: string,
): Promise<{ cancelled: boolean; alreadySent: number }> {
  const sent = await db
    .select({ count: sql<string>`count(*)` })
    .from(announcementRecipients)
    .where(and(eq(announcementRecipients.announcementId, id), eq(announcementRecipients.state, 'Sent')));

  const result = await db.execute(sql`
    UPDATE announcements SET status = 'Cancelled', finished_at = now()
    WHERE id = ${id} AND status IN ('Draft', 'Queued', 'Sending')
  `);

  if ((result.rowCount ?? 0) > 0) {
    await db.execute(sql`
      UPDATE announcement_recipients SET state = 'Skipped', last_error = 'cancelled by the sender'
      WHERE announcement_id = ${id} AND state IN ('Pending', 'Sending')
    `);
  }

  return { cancelled: (result.rowCount ?? 0) > 0, alreadySent: Number(sent[0]?.count ?? 0) };
}

/**
 * The next announcement the sweeper should work on, oldest first.
 *
 * `Sending` as well as `Queued`, because a run that stopped part-way leaves one
 * in exactly that state and it has to be picked up again. That is the whole of
 * how a restart mid-broadcast resumes: there is no separate recovery path,
 * because the ordinary path already is one.
 */
export async function nextSendable(db: Database): Promise<AnnouncementRow | null> {
  const rows = await db
    .select(COLUMNS)
    .from(announcements)
    .where(sql`${announcements.status} IN ('Queued', 'Sending')`)
    .orderBy(asc(announcements.createdAt))
    .limit(1);
  return (rows[0] as AnnouncementRow | undefined) ?? null;
}

/**
 * Take up to `limit` recipients, marking them `Sending` as they are taken.
 *
 * **One statement, and that is the whole safety of it.** Two sweeps overlapping
 * — a slow run and the next minute's — must not both claim the same teacher, and
 * a `SELECT` followed by an `UPDATE` is precisely how they would. Same shape as
 * `claimUpdate`, and for the same reason.
 *
 * `Sending` also means a recipient claimed by a run that then crashed is not
 * silently retried for ever: `resetStalledRecipients` returns them deliberately,
 * where the decision is visible.
 */
export async function claimBatch(db: Database, id: string, limit: number): Promise<string[]> {
  const result = await db.execute<{ chat_id: string }>(sql`
    UPDATE announcement_recipients SET state = 'Sending', attempts = attempts + 1
    WHERE (announcement_id, chat_id) IN (
      SELECT announcement_id, chat_id FROM announcement_recipients
      WHERE announcement_id = ${id} AND state = 'Pending'
      ORDER BY chat_id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING chat_id
  `);

  await db.execute(sql`
    UPDATE announcements SET status = 'Sending', started_at = coalesce(started_at, now())
    WHERE id = ${id} AND status = 'Queued'
  `);

  return result.rows.map((r) => r.chat_id);
}

/**
 * Hand a recipient back after a send that could still succeed — up to a point.
 *
 * Rate limits and Telegram outages are the retryable failures (`isRetryable`),
 * and the right answer to both is to try again on the next sweep rather than to
 * write the teacher off. `attempts` is incremented by the claim, so the count is
 * already there.
 *
 * **It was never read, and that was the whole fault.** With nothing consulting
 * it there was no cap: one recipient failing every time meant the sweeper
 * re-claimed them every minute for ever, the announcement stayed at `Sending`
 * indefinitely, `finishIfDone` could never fire, and the person who sent it was
 * never told it had ended. Nothing raised an alarm, because from every angle it
 * looked like a broadcast still in progress.
 *
 * The fix is this one conditional statement rather than a counter kept anywhere
 * else. Past the cap the row goes to `Failed` instead of `Pending`, which is a
 * settled state — so the sweeper stops claiming it, `finishIfDone` fires, and
 * the sender's report counts them under "Failed", which already has wording for
 * a recipient Telegram would not deliver to.
 *
 * Written as one `UPDATE` with the decision in SQL, not as a read followed by a
 * write. Two workers could otherwise both read four attempts and both decide to
 * retry.
 */
export async function returnForRetry(db: Database, id: string, chatId: string, error: string): Promise<void> {
  await db.execute(sql`
    UPDATE announcement_recipients
    SET state = CASE
          WHEN attempts >= ${ANNOUNCEMENT_MAX_ATTEMPTS} THEN 'Failed'
          ELSE 'Pending'
        END::delivery_state,
        last_error = ${error.slice(0, 500)}
    WHERE announcement_id = ${id} AND chat_id = ${chatId}
  `);
}

export type FinalRecipientState = 'Sent' | 'Failed' | 'Skipped';

/** Settle a recipient. `Skipped` is for somebody who has lost access, never for a failure. */
export async function markRecipient(
  db: Database,
  id: string,
  chatId: string,
  state: FinalRecipientState,
  error: string | null = null,
): Promise<void> {
  await db
    .update(announcementRecipients)
    .set({
      state,
      ...(state === 'Sent' ? { sentAt: sql`now()` } : {}),
      ...(error === null ? {} : { lastError: error.slice(0, 500) }),
    })
    .where(
      and(
        eq(announcementRecipients.announcementId, id),
        eq(announcementRecipients.chatId, chatId),
      ),
    );
}

export interface AnnouncementTally {
  readonly pending: number;
  readonly sent: number;
  readonly skipped: number;
  readonly failed: number;
  readonly total: number;
}

/** Where a send has got to. Read to decide whether it is finished, and to report. */
export async function tally(db: Database, id: string): Promise<AnnouncementTally> {
  const rows = await db.execute<{ state: string; n: string }>(sql`
    SELECT state, count(*) AS n FROM announcement_recipients
    WHERE announcement_id = ${id} GROUP BY state
  `);

  const by = (state: string): number =>
    Number(rows.rows.find((r) => r.state === state)?.n ?? 0);

  // `Sending` counts as pending: a recipient claimed by a run that crashed has
  // not been delivered to, and treating it as finished would report a send as
  // complete while somebody is still waiting for it.
  const pending = by('Pending') + by('Sending');
  const sent = by('Sent');
  const skipped = by('Skipped');
  const failed = by('Failed');

  return { pending, sent, skipped, failed, total: pending + sent + skipped + failed };
}

/**
 * Mark an announcement finished, once nothing is left pending.
 *
 * Conditional on there being nothing pending, in the statement itself, so a
 * sweep that raced another cannot close a send that still has recipients.
 */
export async function finishIfDone(db: Database, id: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE announcements SET status = 'Sent', finished_at = now()
    WHERE id = ${id}
      AND status = 'Sending'
      AND NOT EXISTS (
        SELECT 1 FROM announcement_recipients
        WHERE announcement_id = ${id} AND state IN ('Pending', 'Sending')
      )
  `);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Return recipients left `Sending` by a run that died mid-batch.
 *
 * Without this a crash between claiming a batch and marking it leaves those
 * teachers permanently unclaimable, and the announcement never finishes — it
 * sits at `Sending` for ever with a handful of rows nobody will ever pick up.
 * The window is generous because the alternative failure is worse: returning a
 * recipient a live run is still working on messages them twice.
 */
export async function resetStalledRecipients(db: Database, olderThanMinutes: number): Promise<number> {
  const result = await db.execute(sql`
    UPDATE announcement_recipients r SET state = 'Pending'
    WHERE r.state = 'Sending'
      AND EXISTS (
        SELECT 1 FROM announcements a
        WHERE a.id = r.announcement_id
          AND a.started_at < now() - make_interval(mins => ${olderThanMinutes})
      )
  `);
  return result.rowCount ?? 0;
}
