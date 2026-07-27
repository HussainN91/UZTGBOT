/**
 * The web process: answers teachers, and nothing slow ever runs here.
 *
 * Anything that takes real time — announcements to 1,800 teachers, the daily
 * digest, the spreadsheet sync, clean-ups — belongs in the worker. That split is
 * the fix for the throughput problem, not extra machinery: in the Apps Script
 * version a single announcement occupied the only execution slot for about 108
 * seconds, during which no teacher got a reply.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { webhookCallback } from 'grammy';
import { env } from '../config/env.js';
import { assertDatabaseReachable, closePool, getPool } from '../db/client.js';
import { log } from '../log.js';
import { createBot } from '../telegram/bot.js';
import { HEALTH_PATH, WEBHOOK_PATH } from './routes.js';

async function main(): Promise<void> {
  const settings = env();
  const bot = createBot();

  // Fail before accepting traffic rather than on a teacher's first message.
  await assertDatabaseReachable();
  await bot.init();
  log.info({ username: bot.botInfo.username }, 'telegram credentials accepted');

  /**
   * `secretToken` makes grammY compare the X-Telegram-Bot-Api-Secret-Token
   * header and reject anything that does not match, so the endpoint cannot be
   * driven by anyone who merely knows its address.
   *
   * The Apps Script version carried this secret in the webhook URL's query
   * string because Apps Script could not read request headers reliably. Query
   * strings turn up in proxy logs, access logs and browser history; headers do
   * not. Moving it is one of the concerns list's open items, closed here.
   *
   * `onTimeout: 'return'` preserves the other half of the rule: a slow handler
   * still returns 200, so Telegram does not resend the update forever.
   */
  const handleUpdate = webhookCallback(bot, 'http', {
    secretToken: settings.TELEGRAM_WEBHOOK_SECRET,
    onTimeout: 'return',
    timeoutMilliseconds: 25_000,
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';

    if (req.method === 'GET' && (url === HEALTH_PATH || url === '/')) {
      void respondHealth(res);
      return;
    }

    if (req.method === 'POST' && url === WEBHOOK_PATH) {
      void handleUpdate(req, res).catch((err: unknown) => {
        // grammY already swallows handler errors via bot.catch; reaching here
        // means the failure was in decoding or responding. Still acknowledge:
        // an update we cannot parse will not parse on the retry either, and
        // refusing it would have Telegram replay it indefinitely.
        log.error({ err }, 'webhook transport failed; acknowledging to stop Telegram retrying');
        if (!res.headersSent) res.writeHead(200);
        if (!res.writableEnded) res.end();
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  });

  server.listen(settings.PORT, () => {
    log.info({ port: settings.PORT, path: WEBHOOK_PATH }, 'web process listening');
  });

  installShutdown(server);
}

async function respondHealth(res: ServerResponse): Promise<void> {
  try {
    await getPool().query('SELECT 1');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  } catch (err) {
    // Health must reflect the database, not just the process. A web process that
    // answers 200 while Postgres is unreachable is worse than one that is
    // plainly down: it keeps traffic arriving at something that cannot serve it.
    log.error({ err }, 'health check failed: database unreachable');
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'degraded', reason: 'database unreachable' }));
  }
}

function installShutdown(server: ReturnType<typeof createServer>): void {
  let shuttingDown = false;
  const stop = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down web process');
    server.close(() => {
      void closePool().then(() => process.exit(0));
    });
    // Do not let a hung connection hold the process open through a deploy.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((err: unknown) => {
  log.fatal({ err }, 'web process failed to start');
  process.exit(1);
});
