/**
 * Applies migrations once, before any test file runs.
 *
 * Drizzle's migrator takes no lock. It reads which migrations have already been
 * applied *outside* the transaction that applies them
 * (`drizzle-orm/pg-core/dialect.js`), so concurrent callers all read "none
 * applied" and all go on to apply `0000`. Vitest runs test files in parallel and
 * three of them called `migrate()` in `beforeEach`, so against a fresh database
 * every file but the race winner died on
 *
 *   duplicate key value violates unique constraint "pg_type_typname_nsp_index"
 *
 * — `announcement_status` being the first type `0000` creates. Which file lost
 * the race changed between runs, so the suite failed in a different place each
 * time and never in the code under test. That is the expensive kind of failure
 * to meet later, and it only appears on a database nobody has migrated yet,
 * which is to say on every fresh checkout and every CI run.
 *
 * Migrating once here is also what the server does. `deploy/README.md` applies
 * migrations as a single gated step before web and worker start, and
 * `src/db/migrate.ts` migrates only when it is the entry point, so neither
 * process migrates on boot. The tests now mirror that rather than contradict it.
 *
 * Without `TEST_DATABASE_URL` the integration suites skip themselves, so this
 * must do nothing rather than fail — the pure-logic tests still run anywhere.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** drizzle/ sits at the repo root, two levels above src/test. */
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export async function setup(): Promise<void> {
  const connectionString = process.env['TEST_DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') return;

  const pool = new pg.Pool({ connectionString });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } catch (err: unknown) {
    throw new Error(explain(err, connectionString), { cause: err });
  } finally {
    await pool.end();
  }
}

/**
 * The two ways this fails in practice are both setup mistakes, not bugs, and
 * both have a one-line remedy. Printing the remedy beats printing a stack trace
 * into which someone has to reverse-engineer it.
 */
function explain(err: unknown, connectionString: string): string {
  const target = redactPassword(connectionString);
  switch (codeOf(err)) {
    case '3D000':
      return (
        `TEST_DATABASE_URL names a database that does not exist (${target}).\n` +
        `The test stack creates "mopse_test" itself:\n\n` +
        `  docker compose -f docker-compose.test.yml up -d\n`
      );
    case 'ECONNREFUSED':
      return (
        `Nothing is listening at ${target}. Start the database first:\n\n` +
        `  docker compose -f docker-compose.test.yml up -d\n`
      );
    default:
      return `Could not apply migrations to ${target} before the test run.`;
  }
}

/**
 * Walks the `cause` chain. Drizzle wraps the driver's error in one of its own
 * ("Failed query: CREATE SCHEMA ..."), which carries `query` and `params` but no
 * `code` — so reading `code` off the error it threw finds nothing and every
 * failure looks alike. The `3D000` that says "you have not created the database"
 * is two links down. The depth bound is for a cause chain that loops.
 */
function codeOf(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 10; depth++) {
    if (typeof current !== 'object' || current === null) return undefined;
    if ('code' in current) {
      const { code } = current as { code: unknown };
      if (typeof code === 'string') return code;
    }
    if (!('cause' in current)) return undefined;
    current = (current as { cause: unknown }).cause;
  }
  return undefined;
}

/** The URL carries the password, and this string is going to a terminal. */
function redactPassword(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.password !== '') url.password = '***';
    return url.toString();
  } catch {
    return '(TEST_DATABASE_URL is not a parseable URL)';
  }
}
