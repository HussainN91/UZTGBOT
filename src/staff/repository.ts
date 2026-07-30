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
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { isUniqueViolation } from '../db/errors.js';
import type { Database } from '../db/index.js';
import { type StaffRole, staff } from '../db/schema.js';
import { recordAudit } from '../log/audit.js';
import { CAPABILITY, rolesHolding } from './roles.js';

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
  /** `@handle` without the `@`, or null for "not published" (D47). */
  readonly telegramUsername: string | null;
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
  telegramUsername: staff.telegramUsername,
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
    if (isUniqueViolation(err)) {
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

// ---------------------------------------------------------------------------
// The handle a teacher is shown, and the person behind it — Task 66, D47
// ---------------------------------------------------------------------------

/**
 * The one thing this module needs from Telegram.
 *
 * Narrowed to a single method so the rule can be exercised with three lines of
 * fake rather than a bot, and so nothing here can grow the ability to *send*.
 * `getChat('@handle')` returns the chat; comparing its id to the staff row's
 * `telegram_id` is the whole of the check.
 */
export interface TelegramLookup {
  getChat(handle: string): Promise<{ id: number | string }>;
}

/**
 * Telegram's own rule for a username: 5–32 of `[A-Za-z0-9_]`, starting with a
 * letter. Checked before the API call so an obvious typo costs nothing, and
 * because the value is interpolated into a message 1,800 people read.
 */
const HANDLE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

/** `@karimov`, `karimov` and `https://t.me/karimov` are the same handle. */
export function normaliseHandle(raw: string): string | null {
  const trimmed = raw.trim().replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '').replace(/^@/, '');
  return HANDLE.test(trimmed) ? trimmed : null;
}

export type SetUsernameOutcome =
  | { readonly ok: true; readonly handle: string }
  /** Not a Telegram username at all. Refused before any API call. */
  | { readonly ok: false; readonly reason: 'malformed' }
  /** Telegram has never heard of it, or it belongs to nobody right now. */
  | { readonly ok: false; readonly reason: 'unknown' }
  /**
   * It resolves, to somebody else. **The column is not written.**
   *
   * The failure R33 exists for: a released handle can be claimed by anybody, so
   * a wrong one here would point 1,800 teachers at a stranger under the
   * ministry's name.
   */
  | { readonly ok: false; readonly reason: 'belongsToSomebodyElse' };

/**
 * Publish a staff member's Telegram handle, having checked it is theirs.
 *
 * **Verified, never trusted** (D47). The check is one API call against a value
 * that changes about never, and it turns a silent wrong answer into a refusal
 * the staff member reads immediately.
 *
 * Nothing is written unless the handle resolves to this exact row, so every
 * failure leaves the previous state alone — including the state "not published",
 * which is the safe one.
 */
export async function setUsername(
  db: Database,
  api: TelegramLookup,
  telegramId: string,
  raw: string,
): Promise<SetUsernameOutcome> {
  const handle = normaliseHandle(raw);
  if (handle === null) return { ok: false, reason: 'malformed' };

  let resolved: string;
  try {
    const chat = await api.getChat(`@${handle}`);
    resolved = String(chat.id);
  } catch {
    // Telegram answers "chat not found" for a handle nobody holds, which is a
    // legitimate answer to the question rather than a fault to propagate.
    return { ok: false, reason: 'unknown' };
  }

  if (resolved !== telegramId) return { ok: false, reason: 'belongsToSomebodyElse' };

  await db.update(staff).set({ telegramUsername: handle }).where(eq(staff.telegramId, telegramId));
  return { ok: true, handle };
}

/**
 * Stop publishing a handle.
 *
 * Called by `/username clear` and by the daily check when a handle stops
 * matching. Returns what was cleared so the alarm can name it — "your handle was
 * removed" is not actionable; "@karimov no longer resolves to you" is.
 */
export async function clearUsername(db: Database, telegramId: string): Promise<string | null> {
  /**
   * The old value comes from a sub-select, not from `RETURNING`.
   *
   * `RETURNING` on an `UPDATE` yields the row **after** the write, so returning
   * `telegram_username` there is always `null` — the write is what made it null.
   * The sub-select is evaluated against the pre-update snapshot, which is the
   * only way to get the handle back out in one statement.
   */
  const result = await db.execute<{ was: string | null }>(sql`
    UPDATE staff SET telegram_username = NULL
    FROM (SELECT telegram_username AS was FROM staff WHERE telegram_id = ${telegramId}) AS before
    WHERE staff.telegram_id = ${telegramId} AND staff.telegram_username IS NOT NULL
    RETURNING before.was
  `);

  return result.rows[0]?.was ?? null;
}

/** Every active staff member with a handle published, for the daily re-check. */
export async function publishedUsernames(
  db: Database,
): Promise<{ telegramId: string; handle: string }[]> {
  const rows = await db
    .select({ telegramId: staff.telegramId, handle: staff.telegramUsername })
    .from(staff)
    .where(and(eq(staff.active, true), sql`${staff.telegramUsername} IS NOT NULL`))
    .orderBy(asc(staff.telegramId));

  return rows.map((r) => ({ telegramId: r.telegramId, handle: r.handle! }));
}

export interface RegionManager {
  readonly telegramId: string;
  readonly name: string | null;
  readonly telegramUsername: string | null;
  readonly region: string;
}

/**
 * The person a teacher should be sent to — Q2, and the second teacher-visible
 * change in this stage.
 *
 * **The lowest rank that covers them, and exactly one of them** (step 3). A list
 * of five names is a teacher deciding who to bother, and the senior people are
 * the ones who get chosen.
 *
 * The rules, and what each rules out:
 *
 *   Holds `case.update`, so they can actually reply, close and take a case.
 *   R14, for the third time: naming an Observer sends a teacher to somebody who
 *   is not permitted to move their problem.
 *
 *   Active. A removed staff member is exactly the stale value this feature must
 *   not publish.
 *
 *   Their region covers the teacher's, resolved through `regionFor` by the
 *   caller — never `teachers.region`, which is the sign-in snapshot (R12).
 *
 *   Their queue is not `None`. A teacher has no category, so there is no queue
 *   question to ask them — but somebody who sees no cases at all is nobody's
 *   contact.
 *
 * **A staff member who names the teacher's region explicitly is preferred over
 * one who covers every region**, before rank is considered. That is a
 * judgement the plan did not settle and it decides who 1,800 people are pointed
 * at: an empty `regions` array means "every region", so without this tie-break
 * the first all-region Support member in id order becomes the named manager of
 * the entire country. One `ORDER BY` clause changes it if that is wrong.
 */
export async function regionManagerFor(
  db: Database,
  region: string | null,
): Promise<RegionManager | null> {
  // An unplaced teacher has no region, so there is no regional person to name.
  // The support contact is the honest answer and the caller gives it.
  if (region === null || region.trim() === '') return null;

  const roles = [...rolesHolding(CAPABILITY.CASE_UPDATE)];
  if (roles.length === 0) return null;

  const covers = sql`lower(${region}) IN (SELECT lower(r) FROM unnest(${staff.regions}) AS r)`;

  const rows = await db
    .select({
      telegramId: staff.telegramId,
      name: staff.name,
      telegramUsername: staff.telegramUsername,
      explicit: sql<boolean>`${covers}`,
    })
    .from(staff)
    .where(
      and(
        eq(staff.active, true),
        inArray(staff.role, roles),
        sql`${staff.queue} <> 'None'`,
        sql`(cardinality(${staff.regions}) = 0 OR ${covers})`,
      ),
    )
    /**
     * Explicitly regional first, then the lowest rank, then the id so the same
     * teacher is given the same name every time. `array_position` reads the
     * ladder out of the enum rather than restating it here.
     */
    .orderBy(
      sql`${staff.regions} <> ARRAY[]::text[] DESC`,
      sql`array_position(enum_range(NULL::staff_role), ${staff.role})`,
      asc(staff.telegramId),
    )
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;

  return {
    telegramId: row.telegramId,
    name: row.name,
    telegramUsername: row.telegramUsername,
    region,
  };
}
