/**
 * The PostgreSQL connection pool.
 *
 * One pool per process. Web and worker each hold their own, which is the point
 * of splitting them: a 108-second announcement run in the worker cannot occupy
 * connections the web process needs to answer a teacher.
 */
import pg from 'pg';
import { env } from '../config/env.js';
import { log } from '../log.js';

const { Pool } = pg;

/**
 * Postgres returns BIGINT as a string by default, because it does not fit in a
 * JavaScript number. Every bigint in this schema — Telegram chat ids, row ids —
 * is either an identifier we only ever compare and store, or a count small
 * enough to be safe. Telegram chat ids in particular already exceed 2^32 and
 * will eventually exceed 2^53, so they stay strings all the way through and are
 * never parsed into a number. Leaving this default alone is deliberate.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => value);

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;
  pool = new Pool({
    connectionString: env().DATABASE_URL,
    // Small on purpose: a 2-CPU box with one web and one worker process does not
    // benefit from a large pool, and an oversized one turns a slow query into
    // memory pressure instead of visible backpressure.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', (err) => {
    // An idle client erroring is not fatal — the pool replaces it — but it is
    // exactly the kind of thing that used to disappear into an unread log.
    log.error({ err }, 'idle postgres client errored');
  });
  return pool;
}

/** Fail fast at start-up rather than on a teacher's first message. */
export async function assertDatabaseReachable(): Promise<void> {
  const result = await getPool().query<{ now: Date }>('SELECT now() AS now');
  log.info({ serverTime: result.rows[0]?.now }, 'connected to postgres');
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}
