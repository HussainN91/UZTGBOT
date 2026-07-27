/**
 * Paths the web process serves.
 *
 * Kept apart from `main.ts` so the webhook-registration script can name the same
 * path without importing a module whose side effect is starting a server. The
 * registration and the route can no longer drift apart.
 */

/**
 * Where Telegram posts updates.
 *
 * The path itself is not a secret and is not treated as one. Authentication is
 * the X-Telegram-Bot-Api-Secret-Token header, checked on every request.
 */
export const WEBHOOK_PATH = '/webhook/telegram';

/** Liveness and readiness. Reports 503 when the database is unreachable. */
export const HEALTH_PATH = '/healthz';
