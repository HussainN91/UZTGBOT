/**
 * The bot instance and its global error handling.
 *
 * Stage 1 registers only enough behaviour to prove the pipeline works end to
 * end — Telegram reaches the server, the server reaches the database, and a
 * reply comes back. The real teacher and staff handlers arrive in stages 3 and 4
 * and replace the placeholder below.
 */
import { Bot, type Api } from 'grammy';
import { env } from '../config/env.js';
import { log } from '../log.js';

/**
 * A Telegram client with no handlers, for processes that only ever send.
 *
 * The worker needs to send — alerts now, announcements and digests later — but
 * it must never receive: two processes polling or handling the same updates
 * would double-process every message.
 */
export function createApi(): Api {
  return new Bot(env().TELEGRAM_BOT_TOKEN).api;
}

export function createBot(): Bot {
  const bot = new Bot(env().TELEGRAM_BOT_TOKEN);

  /**
   * Nothing may escape a handler.
   *
   * Telegram treats a non-2xx webhook response as "not delivered" and resends
   * the same update, backing off but never giving up. A handler that throws on
   * one particular message would therefore have Telegram replay that message
   * indefinitely — the bot would appear stuck, and one malformed update could
   * bury every other teacher's traffic. Catching here means the update is always
   * acknowledged; the failure goes to the log and, for anything operationally
   * significant, to an alert.
   */
  bot.catch((err) => {
    log.error(
      { err: err.error, updateId: err.ctx.update.update_id },
      'handler threw; update acknowledged anyway so Telegram does not resend it forever',
    );
  });

  bot.command('start', async (ctx) => {
    await ctx.reply(
      'The MoPSE Teacher Support Bot is running.\n\n' +
        'Teacher sign-in, the FAQ and support cases are not switched on yet.',
    );
  });

  return bot;
}
