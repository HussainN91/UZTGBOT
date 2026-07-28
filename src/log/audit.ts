/**
 * The permanent record of privileged actions.
 *
 * Separate from the interaction log on purpose. That one is operational and is
 * pruned on the retention schedule; this is the answer to "who granted that
 * person access, and when", and is not pruned with it.
 *
 * The other deliberate difference is failure behaviour. `logInteraction`
 * swallows its errors, because losing a log line must never cost a teacher the
 * case they just filed. This one propagates: if the record of who was granted
 * access cannot be written, the grant itself should fail rather than happen
 * unrecorded. Silent success is the worse outcome for exactly the actions that
 * end up in here.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';

export interface AuditEntry {
  /** Who did it — a staff chat id, or 'SYSTEM' for something the bot decided. */
  readonly actor: string;
  /** What they did, e.g. 'STAFF_ADDED'. */
  readonly action: string;
  /** What it was done to, where that makes sense — a chat id, a case reference. */
  readonly subject?: string;
  /** Anything else worth keeping, as structured data rather than a sentence. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

/**
 * Write one audit row. Call inside the same transaction as the action it
 * records, so the two cannot disagree.
 */
export async function recordAudit(db: Database, entry: AuditEntry): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit_log (actor, action, subject, detail)
    VALUES (
      ${entry.actor},
      ${entry.action},
      ${entry.subject ?? null},
      ${JSON.stringify(entry.detail ?? {})}::jsonb
    )
  `);
}
