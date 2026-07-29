/**
 * Reading and writing the staff table.
 *
 * The table has existed since stage 2 with no reader and no writer — it was
 * built for this stage. Everything that decides what a person may do goes
 * through `findStaff`, and everything that changes who they are writes an audit
 * row in the same statement's transaction (D18).
 *
 * Managed only through bot commands. In the Apps Script version this was a
 * spreadsheet tab, so anyone who could edit the spreadsheet could make
 * themselves a full administrator. The first System member is still created by
 * hand — by SQL over the SSH tunnel, documented in the runbook (D13) — because
 * every automated alternative is a permanent back door.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { type StaffRole, staff } from '../db/schema.js';
import { recordAudit } from '../log/audit.js';

export interface StaffRecord {
  readonly telegramId: string;
  readonly name: string | null;
  readonly role: StaffRole;
  readonly queue: string;
  /** Empty means every region. Never means none. */
  readonly regions: readonly string[];
  readonly active: boolean;
  readonly addedBy: string | null;
  readonly addedAt: Date;
}

/** Thrown when `addStaff` is given somebody who already has a row, active or not. */
export class StaffAlreadyExistsError extends Error {
  constructor(readonly telegramId: string) {
    super(`${telegramId} already has a staff row`);
    this.name = 'StaffAlreadyExistsError';
  }
}

const COLUMNS = {
  telegramId: staff.telegramId,
  name: staff.name,
  role: staff.role,
  queue: staff.queue,
  regions: staff.regions,
  active: staff.active,
  addedBy: staff.addedBy,
  addedAt: staff.addedAt,
};

/**
 * The authorization lookup. Deactivated members are not returned.
 *
 * `null` is the ordinary answer, not an error — most people typing into this bot
 * are teachers. Excluding inactive rows here rather than at the call sites is
 * what stops a command added later from forgetting the check; `can()` refuses an
 * inactive principal too, so the rule is enforced twice on purpose.
 */
export async function findStaff(db: Database, telegramId: string): Promise<StaffRecord | null> {
  const rows = await db
    .select(COLUMNS)
    .from(staff)
    .where(and(eq(staff.telegramId, telegramId), eq(staff.active, true)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The management lookup, which sees deactivated rows too.
 *
 * Separate from `findStaff` deliberately. `/staff_remove` and `/staff_role` must
 * be able to address somebody who has already been deactivated, or removing a
 * person is irreversible from inside the bot and needs a database session to
 * undo (`AdminCommands.gs:1160`). Never use this to decide whether an action is
 * permitted.
 */
export async function findAnyStaff(db: Database, telegramId: string): Promise<StaffRecord | null> {
  const rows = await db.select(COLUMNS).from(staff).where(eq(staff.telegramId, telegramId)).limit(1);
  return rows[0] ?? null;
}

export interface AddStaffRequest {
  readonly telegramId: string;
  /** No default. See below. */
  readonly role: StaffRole;
  /** No default. See below. */
  readonly queue: string;
  /** Empty or omitted means every region. */
  readonly regions?: readonly string[];
  readonly name?: string | null;
  /** Who is doing this. Written to `added_by` and to the audit row. */
  readonly actor: string;
}

/**
 * Add a staff member.
 *
 * `role` and `queue` are required even though the schema defaults both. The
 * defaults exist so that adding those columns could not break existing rows; a
 * command that lets a caller omit them grants `Support` over every queue to
 * somebody the caller may have meant to restrict, which is more than they asked
 * for and is not visible in what they typed.
 *
 * Adding is adding: an existing row is refused rather than updated, whether or
 * not it is active. `/add_admin` used to upsert, and its defaulting fourth
 * argument stripped `IS_SYSTEM_ADMIN` from whatever row it landed on —
 * including the caller's own (`AdminCommands.gs:1089`). Reactivation is
 * `setStaffRole`, which is a different verb because it is a different intention.
 */
export async function addStaff(db: Database, request: AddStaffRequest): Promise<void> {
  const existing = await findAnyStaff(db, request.telegramId);
  if (existing !== null) throw new StaffAlreadyExistsError(request.telegramId);

  try {
    await db.insert(staff).values({
      telegramId: request.telegramId,
      name: request.name ?? null,
      role: request.role,
      queue: request.queue,
      regions: [...(request.regions ?? [])],
      active: true,
      addedBy: request.actor,
    });
  } catch (err: unknown) {
    /**
     * The check above is not enough on its own, and the reason is easy to miss.
     * A staff command runs under the *sender's* chat lock, so two System members
     * adding the same person at the same moment take two different locks and
     * both see no existing row. The primary key is what actually prevents the
     * duplicate; this turns its error into the same one the check raises, so the
     * command reports "they already have a row" instead of an unhandled error
     * that `bot.catch` swallows into silence.
     */
    if ((err as { code?: string }).code === '23505') {
      throw new StaffAlreadyExistsError(request.telegramId);
    }
    throw err;
  }

  await recordAudit(db, {
    actor: request.actor,
    action: 'STAFF_ADDED',
    subject: request.telegramId,
    detail: { role: request.role, queue: request.queue, regions: request.regions ?? [] },
  });
}

/**
 * Change somebody's rank, reactivating them if they were removed.
 *
 * The reactivation is the one obvious way back from `/staff_remove`, and doing
 * it here rather than in a separate command means there is no state a person can
 * be left in that needs a database session to leave.
 *
 * Returns false when there is no such row, so the command can say so. A typo'd
 * id that silently succeeds is the R3 failure — the caller believes it worked.
 */
export async function setStaffRole(
  db: Database,
  telegramId: string,
  role: StaffRole,
  actor: string,
): Promise<boolean> {
  const existing = await findAnyStaff(db, telegramId);
  if (existing === null) return false;

  await db
    .update(staff)
    .set({ role, active: true })
    .where(eq(staff.telegramId, telegramId));

  await recordAudit(db, {
    actor,
    action: 'STAFF_ROLE_SET',
    subject: telegramId,
    detail: { from: existing.role, to: role, reactivated: !existing.active },
  });
  return true;
}

/**
 * Deactivate a staff member. The row stays.
 *
 * Never a delete. `case_notes.author_chat_id` and `audit_log.actor` refer to
 * these people, and a note whose author cannot be named is worse than a note; it
 * is the same argument `teachers` makes about keeping a log entry readable.
 *
 * Refusing to remove the last active System member is the caller's job, not
 * this function's — it needs `countActiveSystem` and belongs with the command,
 * where the refusal can be explained.
 */
export async function deactivateStaff(
  db: Database,
  telegramId: string,
  actor: string,
): Promise<boolean> {
  const existing = await findAnyStaff(db, telegramId);
  if (existing === null) return false;

  await db.update(staff).set({ active: false }).where(eq(staff.telegramId, telegramId));

  await recordAudit(db, {
    actor,
    action: 'STAFF_REMOVED',
    subject: telegramId,
    detail: { role: existing.role },
  });
  return true;
}

/**
 * How many active System members there are.
 *
 * Read before `/staff_remove` completes. D13 makes the first one a hand-written
 * INSERT, so the recovery from removing the last one is a trip to the database
 * over SSH — which is exactly why the command refuses.
 */
export async function countActiveSystem(db: Database): Promise<number> {
  const rows = await db
    .select({ count: sql<string>`count(*)` })
    .from(staff)
    .where(and(eq(staff.role, 'System'), eq(staff.active, true)));
  // `count(*)` comes back as a string from pg — a bigint does not fit a JS
  // number safely, so the driver never guesses. Parsed here rather than trusted.
  return Number(rows[0]?.count ?? 0);
}

/**
 * Active System members, for the alert fan-out (D12).
 *
 * These are added to `OPS_ALERT_CHAT_ID`, never substituted for it. The
 * environment variable is what still works when this table is empty, wrong or
 * unreachable — and "the staff table is wrong" is a state whose alarm must not
 * depend on the staff table.
 */
export async function systemStaffIds(db: Database): Promise<string[]> {
  const rows = await db
    .select({ telegramId: staff.telegramId })
    .from(staff)
    .where(and(eq(staff.role, 'System'), eq(staff.active, true)))
    .orderBy(asc(staff.telegramId));
  return rows.map((r) => r.telegramId);
}

export interface ListStaffOptions {
  readonly includeInactive?: boolean;
}

/** Everybody, for `/staff`. Ordered so the list is stable between calls. */
export async function listStaff(
  db: Database,
  options: ListStaffOptions = {},
): Promise<StaffRecord[]> {
  const query = db.select(COLUMNS).from(staff);
  const rows = options.includeInactive
    ? await query.orderBy(asc(staff.telegramId))
    : await query.where(eq(staff.active, true)).orderBy(asc(staff.telegramId));
  return rows;
}
