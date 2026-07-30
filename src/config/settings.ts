/**
 * Runtime policy — the few things a named person must be able to change without
 * a deploy.
 *
 * The boundary against the other two homes for a value:
 *
 *   Program constant (src/config/constants.ts) — anything that, if changed,
 *   would break a promise made to a teacher or a legal statement. Those belong
 *   in git where they are reviewed and diffable. The timezone is the model case.
 *
 *   Environment (src/config/env.ts) — site-specific, must be known before the
 *   database is usable, and a wrong value should stop the server.
 *
 *   Here — policy that must be flippable in seconds during an incident or a
 *   business decision, where the cost of being wrong is that someone fixes it
 *   in seconds.
 *
 * Reads are cached briefly. A settings lookup on the hot path of every message
 * would be a query per message to answer a question whose answer almost never
 * changes; a minute of staleness on maintenance mode is acceptable, and the
 * cache is cleared on write.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { settings } from '../db/schema.js';
import { log } from '../log.js';
import { RETENTION_SETTING, type RetentionPeriods, parsePeriod } from './retention.js';

export const SETTING = {
  /**
   * Blocks new case creation while staff deal with something.
   *
   * FAQ browsing and Check My Case deliberately stay live: a teacher looking up
   * an answer or the status of an existing case is not creating work for anyone,
   * and turning the whole bot off would tell them nothing.
   */
  MAINTENANCE_MODE: 'MAINTENANCE_MODE',
  /** Days before an open case is treated as overdue in the daily digest. */
  OVERDUE_DAYS: 'OVERDUE_DAYS',
  /**
   * The three retention periods, spread from `retention.ts` rather than written
   * out again here.
   *
   * They are declared there because the rules that read them are there — the
   * purge and the re-consent comparison — and a settings key listed in two files
   * is two lists that have to agree with nothing enforcing it. That is the exact
   * shape of the fault `status.ts` was created to fix, where the case vocabulary
   * existed three times and agreed only by luck.
   *
   * `RETENTION_DAYS` used to sit here and is **deleted, not renamed** (plan
   * D34). It was never read by anything, and one number could not carry three
   * different promises. A renamed key would leave a plausible-looking value in a
   * production settings table that nothing consumes.
   */
  ...RETENTION_SETTING,
} as const;

export type SettingKey = (typeof SETTING)[keyof typeof SETTING];

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  readonly value: string | null;
  readonly readAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Read a setting, or the supplied default when it has never been set.
 *
 * A missing row returns the default rather than throwing. A bot that refuses to
 * serve teachers because a settings row is absent is a worse failure than one
 * that assumes normal operation — and "normal operation" is the safe assumption
 * for every key here.
 */
export async function getSetting(
  db: Database,
  key: SettingKey,
  fallback: string | null = null,
): Promise<string | null> {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.readAt < CACHE_TTL_MS) return cached.value ?? fallback;

  try {
    const rows = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1);
    const value = rows[0]?.value ?? null;
    cache.set(key, { value, readAt: Date.now() });
    return value ?? fallback;
  } catch (err) {
    // Serve the last known value rather than failing the request. A database
    // blip must not decide whether a teacher can open a case.
    log.error({ err, key }, 'could not read a setting; using the last known value');
    return cached?.value ?? fallback;
  }
}

export async function getSettingNumber(db: Database, key: SettingKey, fallback: number): Promise<number> {
  const raw = await getSetting(db, key);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) {
    log.error({ key, raw }, 'setting is not a number; using the fallback');
    return fallback;
  }
  return parsed;
}

/**
 * The same spellings an operator will actually type, for the same reason the
 * spreadsheet parser accepts them: typing "Yes" and silently getting nothing is
 * the failure mode worth designing out.
 */
const TRUTHY = new Set(['TRUE', 'YES', 'Y', '1', 'ON']);

export async function isMaintenanceMode(db: Database): Promise<boolean> {
  const raw = await getSetting(db, SETTING.MAINTENANCE_MODE);
  return raw !== null && TRUTHY.has(raw.trim().toUpperCase());
}

/**
 * Write a setting and drop its cached value.
 *
 * Present here so the cache cannot be bypassed by a writer that does not know
 * about it. The commands that call this arrive with staff management.
 */
export async function setSetting(
  db: Database,
  key: SettingKey,
  value: string,
  updatedBy: string | null = null,
): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedBy, updatedAt: new Date() },
    });
  cache.delete(key);
}

/**
 * The three retention periods, as the deletion job and the notice read them.
 *
 * Read together rather than one at a time so that a caller cannot honour two of
 * them and forget the third — the notice states all three, and the job that
 * enforces them must be looking at exactly what the notice said.
 *
 * **Every unusable value becomes `null`, and `null` deletes nothing** (D30).
 * That includes a missing row, an empty string, a zero and anything that is not
 * a plain number of days. `parsePeriod` decides, so the wording of the notice
 * and the behaviour of the job cannot disagree about what a bad value means.
 *
 * Each is parsed independently: a mistyped `MESSAGE_RETENTION_DAYS` must not
 * stop cases being deleted on the period MoPSE did set correctly.
 */
export async function retentionPeriods(db: Database): Promise<RetentionPeriods> {
  const [caseDays, urgentCaseDays, messageDays] = await Promise.all([
    getSetting(db, SETTING.CASE_RETENTION_DAYS),
    getSetting(db, SETTING.URGENT_CASE_RETENTION_DAYS),
    getSetting(db, SETTING.MESSAGE_RETENTION_DAYS),
  ]);

  return {
    caseDays: parsePeriod(caseDays),
    urgentCaseDays: parsePeriod(urgentCaseDays),
    messageDays: parsePeriod(messageDays),
  };
}

/** Test seam, and the escape hatch after an out-of-band change. */
export function clearSettingsCache(): void {
  cache.clear();
}
