/**
 * The typed database handle.
 *
 * Everything that reads or writes goes through here, so a column rename in
 * schema.ts breaks compilation at every call site rather than failing quietly at
 * runtime the way a renamed spreadsheet column used to.
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { getPool } from './client.js';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

let db: Database | null = null;

export function getDb(): Database {
  db ??= drizzle(getPool(), { schema });
  return db;
}

export { schema };
