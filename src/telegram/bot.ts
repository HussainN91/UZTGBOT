/**
 * The bot instance, and the pipeline every teacher message runs through.
 *
 * This file owns the two things the router deliberately does not: when the
 * transaction ends, and when Telegram is spoken to. The order is
 *
 *     claim → lock → decide (one transaction) → COMMIT → speak
 *
 * and the commit sits where it does on purpose. A send that fails after a good
 * commit is recoverable: the case exists, Check My Case will show it, and the
 * failure raises an alarm because the teacher believes nothing happened. A
 * commit that fails after a confirmation message has already gone out is not
 * recoverable by anything — the teacher is holding a reference number for a case
 * that does not exist.
 */
import { Bot, type Api, type Context } from 'grammy';
import { env } from '../config/env.js';
import { getDb } from '../db/index.js';
import type { Database } from '../db/index.js';
import { withChatLock } from '../conversation/lock.js';
import { log } from '../log.js';
import type { Alerter } from '../sync/alerts.js';
import { telegramAlerter } from './alerter.js';
import { claimUpdate } from './dedup.js';
import type { InboundUpdate, RouterOutcome } from './router.js';
import { route } from './router.js';
import { send } from './send.js';
import type { InlineKeyboard } from './keyboards.js';

/**
 * A Telegram client with no handlers, for processes that only ever send.
 *
 * The worker needs to send — alerts now, announcements and digests later — but
 * it must never receive: two processes handling the same updates would
 * double-process every message.
 */
export function createApi(): Api {
  return new Bot(env().TELEGRAM_BOT_TOKEN).api;
}

function toReplyMarkup(keyboard: InlineKeyboard | undefined) {
  if (keyboard === undefined) return undefined;
  return { inline_keyboard: keyboard.map((row) => row.map((b) => ({ ...b }))) };
}

/**
 * Say everything the router decided, after its transaction has committed.
 *
 * Every failure here is alerted rather than thrown. Throwing would reach
 * `bot.catch`, which acknowledges the update and says nothing — and "nothing"
 * is indistinguishable, from the teacher's side, from a bot that ignored them.
 */
async function deliver(
  api: Api,
  alerter: Alerter,
  outcome: RouterOutcome,
): Promise<void> {
  for (const [index, message] of outcome.messages.entries()) {
    try {
      const replyMarkup = toReplyMarkup(message.keyboard);
      await send(api, message.chatId, message.text, {
        ...(replyMarkup !== undefined ? { replyMarkup } : {}),
      });
    } catch (err) {
      log.error({ err, chatId: message.chatId }, 'could not deliver a reply after committing');
      await alerter.send({
        severity: 'critical',
        title: 'A teacher was not told what happened',
        body: [
          `Chat: ${message.chatId}`,
          index === 0
            ? 'This was the answer to something they had just done. Whatever it was'
            : 'This was a notice about somebody else\'s action (a duplicate sign-in).',
          index === 0
            ? 'succeeded — the database has committed — but they have been told nothing,'
            : 'It happened, but the person who needed to know has not been told.',
          index === 0 ? 'so from their side the bot ignored them.' : '',
          '',
          `Reason: ${err instanceof Error ? err.message : String(err)}`,
          '',
          `Message that failed:\n${message.text.slice(0, 500)}`,
        ].join('\n'),
      });
    }
  }

  for (const alert of outcome.alerts) {
    await alerter.send(alert);
  }
}

/**
 * Run one update through the pipeline.
 *
 * Exported so the suite can drive it with a real database and no Telegram at
 * all — `deliver` is the only part that needs the network, and it is passed in.
 */
export async function processUpdate(
  db: Database,
  updateId: number | string,
  update: InboundUpdate,
  supportContact: string,
): Promise<RouterOutcome | null> {
  /**
   * Step 1, and outside the chat lock on purpose.
   *
   * A redelivery must be dropped before it can queue behind the original and
   * then run against a state the original has already changed — which is how a
   * resend files a second case or spends a second urgent code.
   */
  if (!(await claimUpdate(db, updateId))) return null;

  // Steps 2 to 5. One lock, one transaction, taken in exactly one place.
  return withChatLock(db, update.chatId, (tx) => route(tx, update, { supportContact }));
}

/** `/help@TheBotName` is the same command as `/help`. */
function stripBotMention(text: string): string {
  return text.replace(/^(\/[A-Za-z_]+)@\S+/, '$1');
}

export function createBot(): Bot {
  const bot = new Bot(env().TELEGRAM_BOT_TOKEN);
  const alerter = telegramAlerter(bot.api);
  const supportContact = env().SUPPORT_CONTACT;

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

  const run = async (ctx: Context, update: InboundUpdate): Promise<void> => {
    const outcome = await processUpdate(
      getDb(),
      ctx.update.update_id,
      update,
      supportContact,
    );
    if (outcome !== null) await deliver(ctx.api, alerter, outcome);
  };

  /**
   * Acknowledge the button first, always.
   *
   * `Webhook.gs:225` records this as a real defect: until the callback query is
   * answered, Telegram spins a loading indicator on the teacher's phone. Doing
   * it before any database work means a slow query shows as a slow reply rather
   * than a stuck button.
   */
  bot.on('callback_query:data', async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
    } catch (err) {
      // A stale query id is ordinary — the teacher tapped a very old button.
      log.debug({ err }, 'could not acknowledge a callback query');
    }
    await run(ctx, {
      chatId: String(ctx.chat?.id ?? ctx.from.id),
      kind: 'callback',
      text: ctx.callbackQuery.data,
    });
  });

  /**
   * One entry point for every message, rather than `bot.command` registrations.
   *
   * The plan asks for `/privacy` and `/help` to be registered before any
   * catch-all text handler, and they are matched before it — but inside the
   * router, not beside it. A `bot.command` handler would run outside this
   * pipeline, which means outside the update claim, outside the chat lock and
   * outside the interaction log: `/privacy` would skip the very machinery that
   * makes the rest of the bot honest. Matching them first within `routeText`
   * gives the same ordering guarantee and keeps one path.
   */
  bot.on('message', async (ctx) => {
    await run(ctx, {
      chatId: String(ctx.chat.id),
      kind: 'text',
      text: stripBotMention(ctx.message.text ?? ''),
    });
  });

  return bot;
}
