/**
 * TelegramAPI.gs — thin wrappers over the Telegram Bot API.
 * https://core.telegram.org/bots/api
 *
 * Two rules this file enforces for every caller:
 *
 *  1. Nothing here ever throws. A network failure, an HTTP error, or a
 *     non-JSON body all come back as { ok: false, description: ... }, so one
 *     bad send can never abort doPost() halfway through an update.
 *
 *  2. Precisely because of (1), callers MUST check the returned `.ok` before
 *     telling a human "sent". The previous version swallowed failures while
 *     reporting success — that is what made /announce report delivery counts
 *     it had not actually verified, and made a failed /reply read as
 *     "Reply sent and case updated."
 *
 * Message length: Telegram rejects sendMessage over 4096 characters with an
 * HTTP 400. Approved FAQ answers and admin case dumps (DETAIL grows every
 * time /note appends to it) routinely run longer than that, and previously
 * they vanished with nothing but a console line. sendMessage() now splits
 * oversized text itself rather than relying on every caller to remember.
 */

// Telegram's hard limit. TELEGRAM_SAFE_CHUNK_CHARS leaves headroom so a split
// never lands exactly on the boundary.
const TELEGRAM_MAX_MESSAGE_CHARS = 4096;
const TELEGRAM_SAFE_CHUNK_CHARS = 3900;

function callTelegramApi_(method, payload) {
  const url = 'https://api.telegram.org/bot' + getBotToken() + '/' + method;
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  let response;
  try {
    response = UrlFetchApp.fetch(url, options);
  } catch (err) {
    // Network-level failure (DNS, timeout, quota). Never propagate.
    console.error('Telegram API fetch failed [' + method + ']: ' + err);
    return { ok: false, description: 'fetch failed: ' + err };
  }

  const code = response.getResponseCode();
  const body = response.getContentText();

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    // Telegram occasionally returns an HTML error page rather than JSON.
    console.error('Telegram API non-JSON response [' + method + ']: ' + code + ' ' + body.slice(0, 300));
    return { ok: false, description: 'non-JSON response (HTTP ' + code + ')' };
  }

  if (code !== 200 || !parsed.ok) {
    console.error('Telegram API error [' + method + ']: ' + code + ' ' + body.slice(0, 300));
    if (parsed.ok === undefined) parsed.ok = false;
  }
  return parsed;
}

/**
 * Break text into Telegram-sized pieces, preferring to split on a paragraph
 * break, then a line break, then a space, and only hard-cutting mid-word when
 * there is no sensible break point in the whole window (e.g. one enormous
 * unbroken string).
 */
function splitMessageText_(text, limit) {
  const s = String(text === undefined || text === null ? '' : text);
  if (s.length <= limit) return [s];

  const chunks = [];
  let rest = s;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // Only accept a break point in the back half of the window — otherwise a
    // stray early newline would produce a stream of tiny messages.
    const minCut = Math.floor(limit * 0.5);
    let cut = window.lastIndexOf('\n\n');
    if (cut < minCut) cut = window.lastIndexOf('\n');
    if (cut < minCut) cut = window.lastIndexOf(' ');
    if (cut < minCut) cut = limit;
    chunks.push(rest.slice(0, cut).replace(/\s+$/, ''));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) chunks.push(rest);
  // A chunk that trimmed down to nothing (a run of blank lines landing on a
  // boundary) would be an empty sendMessage, which Telegram rejects.
  return chunks.filter(c => c.length > 0);
}

/**
 * Send a text message, splitting it across several if it exceeds Telegram's
 * limit. `options` may include reply_markup (inline keyboard), parse_mode,
 * disable_web_page_preview, etc. per the sendMessage docs.
 *
 * When the text is split, reply_markup is attached only to the FINAL piece —
 * otherwise the same keyboard would repeat under every chunk.
 *
 * @returns {{ok: boolean, description?: string, chunks?: number}} `ok` is
 *   false if ANY chunk failed. Check it before reporting success to a human.
 */
function sendMessage(chatId, text, options) {
  const opts = options || {};
  const raw = String(text === undefined || text === null ? '' : text);
  // An empty send is a 400 from Telegram and looks to the user like the bot
  // ignored them. Most likely cause is a blank OFFICIAL_ANSWER cell.
  const body = raw.trim() ? raw : '(No content is available for this item yet — please use Contact Support.)';

  const chunks = splitMessageText_(body, TELEGRAM_SAFE_CHUNK_CHARS);
  let last = { ok: true };
  let allOk = true;

  for (let i = 0; i < chunks.length; i++) {
    const payload = Object.assign({ chat_id: chatId, text: chunks[i] }, opts);
    if (i < chunks.length - 1) delete payload.reply_markup;
    last = callTelegramApi_('sendMessage', payload);
    if (!last.ok) {
      allOk = false;
      break; // no point pushing the remaining chunks at a chat that just rejected one
    }
  }

  if (chunks.length > 1) {
    return Object.assign({}, last, { ok: allOk, chunks: chunks.length });
  }
  return last;
}

/** Edit the text (and/or keyboard) of an existing bot message. */
function editMessageText(chatId, messageId, text, options) {
  const payload = Object.assign({
    chat_id: chatId,
    message_id: messageId,
    text: String(text || '').slice(0, TELEGRAM_MAX_MESSAGE_CHARS)
  }, options || {});
  return callTelegramApi_('editMessageText', payload);
}

/** Acknowledge a callback query (stops the button's loading spinner in-app). */
function answerCallbackQuery(callbackQueryId, options) {
  const payload = Object.assign({
    callback_query_id: callbackQueryId
  }, options || {});
  return callTelegramApi_('answerCallbackQuery', payload);
}

/** Show "typing…" / "uploading photo…" status. action e.g. 'typing'. */
function sendChatAction(chatId, action) {
  return callTelegramApi_('sendChatAction', {
    chat_id: chatId,
    action: action || 'typing'
  });
}

/**
 * Send a file. Bypasses callTelegramApi_ deliberately: sendDocument needs a
 * multipart/form-data body carrying the actual file bytes, not JSON — when
 * UrlFetchApp's payload object contains a Blob and no contentType is forced,
 * it encodes multipart automatically. Used by AdminCommands.gs's /export.
 * Same no-throw contract as callTelegramApi_.
 */
function sendDocument(chatId, blob, caption) {
  const url = 'https://api.telegram.org/bot' + getBotToken() + '/sendDocument';
  const payload = {
    chat_id: String(chatId),
    document: blob
  };
  if (caption) payload.caption = caption;

  let response;
  try {
    response = UrlFetchApp.fetch(url, { method: 'post', payload: payload, muteHttpExceptions: true });
  } catch (err) {
    console.error('Telegram API fetch failed [sendDocument]: ' + err);
    return { ok: false, description: 'fetch failed: ' + err };
  }

  const code = response.getResponseCode();
  const body = response.getContentText();
  try {
    const parsed = JSON.parse(body);
    if (code !== 200 || !parsed.ok) {
      console.error('Telegram API error [sendDocument]: ' + code + ' ' + body.slice(0, 300));
      if (parsed.ok === undefined) parsed.ok = false;
    }
    return parsed;
  } catch (err) {
    console.error('Telegram API non-JSON response [sendDocument]: ' + code + ' ' + body.slice(0, 300));
    return { ok: false, description: 'non-JSON response (HTTP ' + code + ')' };
  }
}

/** Register the webhook URL + secret token with Telegram. Used by SetWebhook.gs. */
function callSetWebhook_(url, secretToken) {
  return callTelegramApi_('setWebhook', {
    url: url,
    secret_token: secretToken
  });
}

/** Phase 6: actively leave a group/supergroup the bot was added to — this
 * bot only supports private chats (proposal §7). */
function leaveChat_(chatId) {
  return callTelegramApi_('leaveChat', { chat_id: chatId });
}

function callDeleteWebhook_() {
  return callTelegramApi_('deleteWebhook', {});
}

function callGetWebhookInfo_() {
  const url = 'https://api.telegram.org/bot' + getBotToken() + '/getWebhookInfo';
  try {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    return JSON.parse(response.getContentText());
  } catch (err) {
    console.error('getWebhookInfo failed: ' + err);
    return { ok: false, description: String(err) };
  }
}
