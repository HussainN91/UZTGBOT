/**
 * Apply pending migrations.
 *
 * This replaces `createAllSheets()`, which had to be run by hand from the Apps
 * Script editor and was easy to forget after a deploy — the runbook carried it
 * as a manual checklist item, and a tab created before a column was added kept
 * the old header while new code wrote the new shape.
 *
 * Run it before starting the web and worker processes:
 *
 *   npm run db:migrate
 *
 * Safe to re-run: Drizzle records which migrations have been applied and skips
 * them. Migrations run inside a transaction, so a failure leaves the schema
 * exactly as it was.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closePool } from './client.js';
import { getDb } from './index.js';
import { log } from '../log.js';

const here = dirname(fileURLToPath(import.meta.url));
/** drizzle/ sits at the repo root, two levels above both src/db and dist/db. */
const migrationsFolder = resolve(here, '../../drizzle');

export async function runMigrations(): Promise<void> {
  log.info({ migrationsFolder }, 'applying migrations');
  await migrate(getDb(), { migrationsFolder });
  log.info('migrations up to date');
}

/**
 * Only run when this file is the entry point, so importing `runMigrations` from
 * a test or from the worker does not start a migration as a side effect.
 * Comparing resolved paths works whether it was started as TypeScript via tsx or
 * as compiled JavaScript via node.
 */
const entryPoint = process.argv[1];
const invokedDirectly =
  entryPoint !== undefined && resolve(entryPoint) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  runMigrations()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      log.fatal({ err }, 'migration failed; schema unchanged');
      process.exit(1);
    });
}
