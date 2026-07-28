/**
 * Making sure one Telegram update is acted on exactly once.
 *
 * Telegram retries any update it does not get a 2xx for. The web process
 * deliberately answers 200 even when a handler is slow or has thrown, because
 * anything else has Telegram replaying that update forever — but that means a
 * redelivery can arrive while the original is still running, and a crash between
 * committing a case and replying gets the update redelivered too.
 *
 * Without this, a replay files a second case or spends a second urgent code. The
 * Apps Script version guarded against exactly this and the rebuild dropped it.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { log } from '../log.js';

/**
 * Claim an update for processing. `false` means someone else already has it and
 * this delivery must be ignored.
 *
 * One statement, so two concurrent deliveries of the same update cannot both
 * win. A `SELECT` followed by an `INSERT` would reintroduce precisely the race
 * this exists to close.
 */
export async function claimUpdate(db: Database, updateId: number | string): Promise<boolean> {
  const result = await db.execute<{ update_id: string }>(
    sql`INSERT INTO processed_updates (update_id) VALUES (${String(updateId)})
        ON CONFLICT (update_id) DO NOTHING
        RETURNING update_id`,
  );
  const claimed = result.rows.length > 0;
  if (!claimed) log.warn({ updateId: String(updateId) }, 'ignoring a redelivered update');
  return claimed;
}

/**
 * Forget claims older than the cutoff.
 *
 * Telegram gives up retrying long before a day, so anything older cannot be
 * replayed and is only taking up space.
 */
export async function pruneProcessedUpdates(db: Database, olderThanHours = 24): Promise<number> {
  const result = await db.execute(
    sql`DELETE FROM processed_updates WHERE at < now() - make_interval(hours => ${olderThanHours})`,
  );
  return result.rowCount ?? 0;
}
