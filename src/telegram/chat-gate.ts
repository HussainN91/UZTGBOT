/**
 * Which chats this bot will talk in — D15, and the exemption is R8.
 *
 * A control `BOT-SPEC.md` §1, §8.1.1 and §13 all describe as shipped, and which
 * **did not exist anywhere in `src/`**. `Webhook.gs:57-69` rejected any
 * non-private chat and left groups it was added to; the rebuild dropped it, the
 * same way stage 2.5 dropped `update_id` deduplication while the documents went
 * on listing it.
 *
 * It is not cosmetic. The operations alert chat is a group and the bot must be a
 * member of it, so today any message typed in that group enters the pipeline
 * with a **negative** chat id, reaches `saveState`, and violates
 * `conversation_states`' `CHECK (chat_id ~ '^[0-9]+$')`. The transaction rolls
 * back and `bot.catch` swallows it, so the whole thing is invisible. Stage 4 is
 * also the stage where staff start using the bot, and staff put bots in groups.
 *
 * **One function, read by both the ignore path and the leave path**, and that is
 * the point of the file rather than a tidiness preference. Two expressions of
 * the exemption could disagree in either direction, and both directions are bad:
 * a bot that ignores the operations chat's messages but still leaves it, or one
 * that stays and then tries to hold a conversation in it.
 *
 * Pure — no grammY, no network, no database, no environment read. The ops chat
 * id is passed in, so the rule can be tested with a real value rather than by
 * setting an environment variable and hoping.
 */

export type ChatVerdict =
  /** A private chat with one teacher or one staff member. The ordinary case. */
  | 'handle'
  /** Not private, but exempt. Read the message, do nothing, stay. */
  | 'ignore'
  /** Not private and not exempt. Say nothing and leave. */
  | 'leave';

/**
 * Telegram's `chat.type`. Anything that is not `private` is a place where more
 * than one person can read what the bot says, which is the whole distinction.
 */
const PRIVATE = 'private';

/**
 * What to do with an update from this chat.
 *
 * `opsChatId` is `undefined` outside production, where `OPS_ALERT_CHAT_ID` is
 * optional. That deliberately means **no exemption**: a developer with no
 * operations chat configured has no group to protect, and the failure of getting
 * this backwards — treating "unset" as "exempt everything" — would switch the
 * gate off entirely in exactly the environment where nobody is watching.
 *
 * Compared as strings, because that is what both sides already are: `chat.id` is
 * a number in the Telegram payload and is stringified at the boundary, and
 * `OPS_ALERT_CHAT_ID` is validated as a numeric string, negative sign and all.
 * A `-100…` supergroup id is beyond `Number.MAX_SAFE_INTEGER`'s comfortable
 * range for identity comparison, and two ids that differ in their last digit
 * must never compare equal.
 */
export function verdictForChat(
  chatType: string,
  chatId: string,
  opsChatId: string | undefined,
): ChatVerdict {
  if (chatType === PRIVATE) return 'handle';
  if (opsChatId !== undefined && chatId === opsChatId) return 'ignore';
  return 'leave';
}
