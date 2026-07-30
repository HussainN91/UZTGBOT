/**
 * Sending messages to Telegram.
 *
 * The Apps Script version had a rule its authors had to remember: never report
 * success unless Telegram actually confirmed it. It returned `{ok, description}`
 * and every caller was responsible for checking — so a forgotten check silently
 * told a teacher their case was filed when nothing had been delivered.
 *
 * Here the rule is enforced instead of remembered. `send` throws on failure, so
 * an unchecked call cannot report success by omission. `trySend` is the explicit
 * opt-out for the one place individual failures are normal and expected —
 * broadcasting to 1,800 teachers, some of whom have blocked the bot — and it
 * returns a result that has to be inspected before anything can be read from it.
 */
import { GrammyError, HttpError, InputFile } from 'grammy';
import type { Api } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';

export interface SendOptions {
  readonly replyMarkup?: InlineKeyboardMarkup;
  /** Telegram's own formatting. Left off by default: teacher text is never trusted as markup. */
  readonly parseMode?: 'HTML' | 'MarkdownV2';
  readonly disableNotification?: boolean;
}

/** Why a send failed, in the terms the caller actually needs to act on. */
export type SendFailure =
  /** The teacher blocked the bot, or deleted their account. Permanent — stop trying. */
  | { readonly kind: 'blocked'; readonly description: string }
  /** Wrong or stale chat id. Permanent. */
  | { readonly kind: 'chat_not_found'; readonly description: string }
  /** Too fast. Retryable after the stated delay. */
  | { readonly kind: 'rate_limited'; readonly retryAfterSeconds: number; readonly description: string }
  /** Network or Telegram outage. Retryable. */
  | { readonly kind: 'transient'; readonly description: string }
  /** Anything else — a malformed request, an oversized payload, an unknown code. */
  | { readonly kind: 'other'; readonly description: string };

export type SendResult =
  | { readonly ok: true; readonly messageId: number }
  | { readonly ok: false; readonly failure: SendFailure };

export class TelegramSendError extends Error {
  constructor(
    readonly chatId: string,
    readonly failure: SendFailure,
  ) {
    super(`Telegram refused a message to ${chatId} (${failure.kind}): ${failure.description}`);
    this.name = 'TelegramSendError';
  }
}

/** Turn whatever grammY threw into a failure the caller can branch on. */
export function classifyError(err: unknown): SendFailure {
  if (err instanceof GrammyError) {
    const description = err.description;
    const retryAfter = err.parameters.retry_after;
    if (typeof retryAfter === 'number') {
      return { kind: 'rate_limited', retryAfterSeconds: retryAfter, description };
    }
    // 403 covers "bot was blocked by the user", "user is deactivated" and
    // "bot was kicked" — all permanent from our side, all meaning stop trying.
    if (err.error_code === 403) return { kind: 'blocked', description };
    if (err.error_code === 400 && /chat not found/i.test(description)) {
      return { kind: 'chat_not_found', description };
    }
    if (err.error_code >= 500) return { kind: 'transient', description };
    return { kind: 'other', description };
  }
  if (err instanceof HttpError) {
    return { kind: 'transient', description: `network error reaching Telegram: ${String(err.error)}` };
  }
  return { kind: 'other', description: err instanceof Error ? err.message : String(err) };
}

function buildOptions(options: SendOptions): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (options.replyMarkup) payload['reply_markup'] = options.replyMarkup;
  if (options.parseMode) payload['parse_mode'] = options.parseMode;
  if (options.disableNotification) payload['disable_notification'] = true;
  return payload;
}

/**
 * Send a message, or throw.
 *
 * Use this everywhere a failure means the surrounding operation did not really
 * happen — confirming a case reference, answering a question, alerting staff.
 */
export async function send(
  api: Api,
  chatId: string,
  text: string,
  options: SendOptions = {},
): Promise<number> {
  try {
    const message = await api.sendMessage(chatId, text, buildOptions(options));
    return message.message_id;
  } catch (err) {
    throw new TelegramSendError(chatId, classifyError(err));
  }
}

/**
 * Send a file, or throw.
 *
 * The same contract as `send` and for the same reason: a report that did not
 * arrive must not be indistinguishable from one that did. `/export` is the only
 * caller, and an export that silently failed is a staff member planning from a
 * file they never received.
 *
 * **The contents are held in memory and never written to disk.** A temporary
 * file is a second copy of case data sitting on a server with no retention rule
 * of its own and nothing that deletes it — which is precisely the property the
 * nightly job exists to give the first copy.
 *
 * This is the only half of document handling this system has. D24 keeps teachers
 * submitting documents through Google Forms and the bot never accepts or stores
 * a file, so there is deliberately no `receiveDocument` beside this.
 */
export async function sendDocument(
  api: Api,
  chatId: string,
  filename: string,
  contents: string,
  caption?: string,
): Promise<number> {
  try {
    const message = await api.sendDocument(
      chatId,
      new InputFile(Buffer.from(contents, 'utf8'), filename),
      caption === undefined ? {} : { caption },
    );
    return message.message_id;
  } catch (err) {
    throw new TelegramSendError(chatId, classifyError(err));
  }
}

/**
 * Send a message, reporting the outcome instead of throwing.
 *
 * Only for bulk delivery, where one unreachable recipient must not abort the
 * run and the reason for each failure decides whether that recipient is retried
 * or written off. Everywhere else, use `send`.
 */
export async function trySend(
  api: Api,
  chatId: string,
  text: string,
  options: SendOptions = {},
): Promise<SendResult> {
  try {
    const message = await api.sendMessage(chatId, text, buildOptions(options));
    return { ok: true, messageId: message.message_id };
  } catch (err) {
    return { ok: false, failure: classifyError(err) };
  }
}

/** True when retrying this recipient could ever succeed. */
export function isRetryable(failure: SendFailure): boolean {
  return failure.kind === 'rate_limited' || failure.kind === 'transient';
}
