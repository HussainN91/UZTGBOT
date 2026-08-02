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
import type { TelegramLookup } from '../staff/repository.js';
import { telegramAlerter } from './alerter.js';
import { verdictForChat } from './chat-gate.js';
import { claimUpdate, releaseUpdate } from './dedup.js';
import type { InboundUpdate, RouterOutcome } from './router.js';
import { route } from './router.js';
import { send, sendDocument } from './send.js';
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
      /**
       * A file, when the router asked for one, with the text as its caption.
       *
       * `sendDocument` throws exactly as `send` does, so an export that did not
       * arrive raises the alarm below rather than being indistinguishable from
       * one that did — which for a report somebody is about to plan from is the
       * whole point.
       */
      if (message.document !== undefined) {
        await sendDocument(
          api,
          message.chatId,
          message.document.filename,
          message.document.contents,
          message.text,
        );
        continue;
      }

      const replyMarkup = toReplyMarkup(message.keyboard);
      await send(api, message.chatId, message.text, replyMarkup === undefined ? {} : { replyMarkup });
    } catch (err) {
      log.error({ err, chatId: message.chatId }, 'could not deliver a reply after committing');
      /**
       * What this message was, in the operator's words.
       *
       * `messages[0]` is always the answer to whoever wrote in. Everything after
       * it goes to somebody else and says what it is — before `purpose` existed
       * this branch asserted "a duplicate sign-in notice" for every such
       * message, which was true only while that was the only one. The fallback
       * is deliberately vague rather than a guess: an alarm that admits it does
       * not know beats one that confidently names the wrong thing.
       */
      const what =
        index === 0
          ? 'This was the answer to something they had just done. Whatever it was\n' +
            'succeeded — the database has committed — but they have been told nothing,\n' +
            'so from their side the bot ignored them.'
          : `This was ${message.purpose ?? 'a notice about somebody else\'s action'}.\n` +
            'It happened, but the person who needed to know has not been told.';

      await alerter.send({
        severity: 'critical',
        title:
          index === 0
            ? 'A teacher was not told what happened'
            : 'Somebody was not told about something that happened',
        body: [
          `Chat: ${message.chatId}`,
          what,
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
  /**
   * The one Telegram *read* the router makes, for `/username` (D47).
   *
   * Optional so the suite can drive this with no Telegram at all, exactly as
   * before. `/username` refuses to write an unchecked handle when it is absent,
   * which is the safe direction — see `RouterDeps.telegram`.
   */
  telegram?: TelegramLookup,
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
  return withChatLock(db, update.chatId, (tx) =>
    route(tx, update, { supportContact, ...(telegram !== undefined ? { telegram } : {}) }),
  );
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

  /**
   * The group gate — D15, before anything else happens.
   *
   * **Before `processUpdate`, deliberately.** A non-private update must not
   * consume an update claim or take a chat lock: `claimUpdate` writes a row, and
   * `withChatLock` hashes a chat id that is negative and would then fail the
   * digits check on `conversation_states` — inside a transaction that rolls back
   * silently. Refusing here costs one comparison and reaches neither.
   *
   * Nothing is said to the group. A bot that answers "I only work in private
   * chats" is a bot that answers, which in a group of forty teachers is both
   * noise and a confirmation that it is listening. `Webhook.gs:57-69` was silent
   * too.
   */
  const gate = (ctx: Context): boolean => {
    const chat = ctx.chat;
    if (chat === undefined) return false;

    const verdict = verdictForChat(chat.type, String(chat.id), env().OPS_ALERT_CHAT_ID);
    if (verdict === 'handle') return true;

    log.debug({ chatId: chat.id, type: chat.type, verdict }, 'update from a non-private chat');
    if (verdict === 'leave') void leaveQuietly(ctx);
    return false;
  };

  /**
   * Leave, and never let leaving break the process.
   *
   * `bot.catch` would swallow a throw here anyway; failing loudly gains nothing
   * and a bot that cannot leave a group is a nuisance rather than an incident —
   * the gate above has already made sure it will not *act* there.
   */
  const leaveQuietly = async (ctx: Context): Promise<void> => {
    try {
      await ctx.leaveChat();
    } catch (err) {
      log.error({ err, chatId: ctx.chat?.id }, 'could not leave a group');
    }
  };

  /**
   * A teacher's message that failed to process used to vanish.
   *
   * The claim is taken before the work and committed on its own; the work runs
   * in a transaction. So a throw rolled the work back and left the claim
   * standing, Telegram's redelivery was discarded as a duplicate, and the
   * teacher's message was gone — with `bot.catch` writing a line to the log and
   * raising no alarm at all. In a system whose founding concern is that nobody
   * notices when something breaks, that was the one failure nobody was told
   * about.
   *
   * **This lives here rather than in `processUpdate`, and that is the whole
   * ripple argument.** `processUpdate` is exported so the suite can drive it with
   * a real database and no Telegram, and it has no alerter; passing one in
   * changes its signature and every integration test that calls it. `run()`
   * already holds the alerter, already has the update id, and is called by no
   * test. Signature unchanged, zero test ripple.
   *
   * The release comes first and is itself wrapped, because a release that throws
   * must not stop the alarm — an unreleased claim with an alarm raised is a
   * person looking at it, and an unraised alarm is nobody.
   */
  const run = async (ctx: Context, update: InboundUpdate): Promise<void> => {
    if (!gate(ctx)) return;

    const updateId = ctx.update.update_id;

    let outcome;
    try {
      outcome = await processUpdate(
        getDb(),
        updateId,
        update,
        supportContact,
        /**
         * `getChat` only, narrowed at the boundary so nothing reachable from the
         * router can grow the ability to send. The handle check is a read; every
         * send in this file happens after the transaction commits.
         */
        { getChat: (handle: string) => ctx.api.getChat(handle) },
      );
    } catch (err) {
      let released = false;
      try {
        released = await releaseUpdate(getDb(), updateId);
      } catch (releaseErr) {
        log.error({ err: releaseErr, updateId }, 'could not release a failed update claim');
      }

      log.error({ err, updateId, released }, 'handling an update failed');
      await alerter.send({
        severity: 'critical',
        title: 'A message could not be handled',
        body: [
          `Chat: ${update.chatId}`,
          `Update: ${updateId}`,
          '',
          released
            ? 'The claim on this update was released, so Telegram will retry it and it may\n'
              + 'yet succeed on its own. If the same update id appears here again and again,\n'
              + 'it will not, and somebody has to look at what this person was trying to do.'
            : 'The claim on this update could NOT be released, so Telegram’s retry will be\n'
              + 'discarded as a duplicate and this message is lost. Somebody has to find out\n'
              + 'what this person was trying to say and ask them to send it again.',
          '',
          `Reason: ${err instanceof Error ? err.message : String(err)}`,
        ].join('\n'),
      });
      return;
    }

    if (outcome !== null) await deliver(ctx.api, alerter, outcome);
  };

  /**
   * Being added to a group, which is the moment worth catching.
   *
   * Waiting for somebody to type gives the bot a stretch of time sitting in a
   * group it should not be in, and `my_chat_member` fires on the addition
   * itself. The exemption is read from the same function, so the chat every
   * alarm in this system depends on — including the alarm that would report
   * this going wrong — is never the one it walks out of (R8).
   */
  bot.on('my_chat_member', async (ctx) => {
    const chat = ctx.chat;
    if (verdictForChat(chat.type, String(chat.id), env().OPS_ALERT_CHAT_ID) !== 'leave') return;

    const status = ctx.myChatMember.new_chat_member.status;
    if (status === 'left' || status === 'kicked') return;

    log.warn({ chatId: chat.id, type: chat.type }, 'added to a group; leaving');
    await leaveQuietly(ctx);
  });

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
