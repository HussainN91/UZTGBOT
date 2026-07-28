/**
 * Serialise everything one teacher does, and nothing else.
 *
 * Apps Script had a single global script lock, so every action in the bot queued
 * behind every other action system-wide — its own notes called that the
 * throughput ceiling of the whole bot. A per-chat lock removes the ceiling: two
 * teachers can never block each other.
 *
 * ONE lock, taken in ONE place, at the top of the update handler. Case dedup and
 * conversation state are two tables that both need serialising for the same
 * chat; locking them separately would mean two locks acquired in different
 * orders on different paths, which is the classic deadlock recipe.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';

/**
 * Run `fn` with this chat serialised against every other caller for the same
 * chat.
 *
 * `pg_advisory_xact_lock` releases when the transaction ends, however it ends,
 * so a handler that throws or a process that dies cannot strand a lock. That is
 * the whole reason for the transaction-scoped variant over the session-scoped
 * one, which would need an explicit unlock in a `finally` and would leak on a
 * hard kill.
 *
 * `fn` receives the transaction, not the pool. Everything it does is part of the
 * same transaction as the lock, which is what makes "dedup and insert in one
 * transaction under the chat lock" expressible at all.
 *
 * On `hashtext`: it returns a 32-bit integer, so two different chat ids can in
 * principle collide and be serialised against each other unnecessarily. That
 * costs a little concurrency between two unrelated teachers in a vanishingly
 * rare case; it can never cause the same chat to skip its lock, which is the
 * only property that matters here.
 */
export async function withChatLock<T>(
  db: Database,
  chatId: string,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${chatId}))`);
    return fn(tx as unknown as Database);
  });
}
