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

export const SETTING = {
  /**
   * Blocks new case creation while staff deal with something.
   *
   * FAQ browsing and Check My Case deliberately stay live: a teacher looking up
   * an answer or the status of an existing case is not creating work for anyone,
   * and turning the whole bot off would tell them nothing.
   */
  MAINTENANCE_MODE: 'MAINTENANCE_MODE',
  /**
   * How long records are kept. Owned by MoPSE, consumed by the retention job.
   *
   * Still unset. The privacy notice promises teachers their data can be removed,
   * so this is a commitment already made, not a preference.
   */
  RETENTION_DAYS: 'RETENTION_DAYS',
  /** Days before an open case is treated as overdue in the daily digest. */
  OVERDUE_DAYS: 'OVERDUE_DAYS',
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

/** Test seam, and the escape hatch after an out-of-band change. */
export function clearSettingsCache(): void {
  cache.clear();
}
