/**
 * What a handler decided to say.
 *
 * Handlers return this rather than calling Telegram, so the decision and the
 * delivery can be tested apart. Delivery order is the router's business, and it
 * matters: the callback query must be acknowledged before anything is resolved,
 * or a stale button spins on the teacher's phone (`Webhook.gs:225` records this
 * as a real defect).
 */
import type { InlineKeyboard } from './keyboards.js';

export interface Reply {
  readonly text: string;
  readonly keyboard?: InlineKeyboard;
  /**
   * Answer codes left out of the keyboard because their payload would exceed
   * Telegram's limit. Almost always empty; when it is not, somebody needs
   * telling, because an answer has quietly become unreachable.
   */
  readonly skipped?: readonly string[];
}
