/**
 * Webhook.gs — single entry point for all Telegram updates.
 * doPost() validates the request, rejects anything that isn't a private chat,
 * and routes the update to MenuHandler.gs / QAEngine.gs / UserSession.gs /
 * AdminCommands.gs (Phase 3 admin commands, checked before falling through
 * to normal text handling).
 */

// Telegram redelivers an update until the webhook answers it, and Apps Script
// can miss that window on a slow update (a large /announce, a cold spreadsheet
// read, a lock wait). Without a dedup gate the redelivery is processed as if it
// were new: /announce re-broadcasts to every teacher, a case detail files
// twice, an urgent code is consumed again. update_id is unique per bot, so a
// short-lived cache marker makes reprocessing a no-op.
const UPDATE_DEDUP_TTL_SECONDS_ = 10 * 60;

function isDuplicateUpdate_(updateId) {
  if (updateId === undefined || updateId === null || updateId === '') return false;
  const key = 'update_' + updateId;
  try {
    const cache = CacheService.getScriptCache();
    if (cache.get(key)) return true;
    cache.put(key, '1', UPDATE_DEDUP_TTL_SECONDS_);
    return false;
  } catch (err) {
    // Cache unavailable — process the update rather than silently dropping it.
    console.error('isDuplicateUpdate_ failed (processing anyway): ' + err);
    return false;
  }
}

function doPost(e) {
  try {
    if (!isValidWebhookRequest_(e)) {
      // Wrong/missing secret token — do not process, do not reveal why.
      return ContentService.createTextOutput('');
    }

    const update = JSON.parse(e.postData.contents);

    // Checked after the secret so an unauthenticated caller can't poison the
    // dedup cache with update_ids it guessed.
    if (isDuplicateUpdate_(update.update_id)) {
      console.log('Ignoring redelivered update_id ' + update.update_id);
      return ContentService.createTextOutput('');
    }
    // Only genuinely NEW messages are handled. An edited_message used to be
    // treated identically to a new one, which meant editing a previous
    // message re-ran the handler for it — a teacher tidying up the wording of
    // their case description would file it a second time, and an edited
    // verification attempt would be re-checked out of context.
    const message = update.message;
    const editedMessage = update.edited_message;
    const callbackQuery = update.callback_query;
    const myChatMember = update.my_chat_member;

    // Private-chat only (proposal §7 critical warning: no group support for personal cases).
    const chat = (message && message.chat) ||
      (editedMessage && editedMessage.chat) ||
      (callbackQuery && callbackQuery.message && callbackQuery.message.chat) ||
      (myChatMember && myChatMember.chat);
    if (chat && chat.type !== 'private') {
      // Phase 6: if this update is the bot itself being added to a group/
      // supergroup (my_chat_member with a non-left/kicked new status), leave
      // immediately rather than just staying silent in it. Anything else
      // (a stray message/callback from a group) is still silently ignored.
      if (myChatMember && myChatMember.new_chat_member && ['left', 'kicked'].indexOf(myChatMember.new_chat_member.status) === -1) {
        leaveChat_(chat.id);
      }
      return ContentService.createTextOutput('');
    }

    // An edit is acknowledged but never acted on. It used to be handled as if
    // it were a new message, so a teacher tidying up the wording of their case
    // description filed it a second time, and an edited verification attempt
    // was re-checked out of context. Telling them beats silence, since from
    // their side the edit simply appeared to do nothing.
    if (!message && !callbackQuery && !myChatMember && editedMessage) {
      const editedChatId = editedMessage.chat && editedMessage.chat.id;
      if (editedChatId) {
        logInteraction(editedChatId, 'IGNORED_EDITED_MESSAGE', '');
        sendMessage(editedChatId, 'I only read new messages, so I did not see that edit. Please send your update as a new message.');
      }
      return ContentService.createTextOutput('');
    }

    routeUpdate_(update, message, callbackQuery);

    return ContentService.createTextOutput('');
  } catch (err) {
    console.error('doPost error: ' + err);
    return ContentService.createTextOutput('');
  }
}

/**
 * Telegram sends the secret token set in setWebhook() back on every request
 * as the X-Telegram-Bot-Api-Secret-Token header. Apps Script exposes request
 * headers only inconsistently for doPost, so as a first line of defense we
 * also require the secret as a URL query param on the webhook URL itself
 * (e.g. .../exec?secret=xxxx), which Apps Script always gives us via e.parameter.
 */
function isValidWebhookRequest_(e) {
  if (!e || !e.postData || !e.postData.contents) return false;
  const suppliedSecret = e.parameter && e.parameter.secret;
  return suppliedSecret === getWebhookSecret();
}

// Phase 6: a specific, useful reply per non-text message type, instead of a
// generic "please send text." This bot never accepts uploads directly in
// chat — everything goes through a Google Form (FormRouter.gs) — so every
// branch here points back to Submit Documents rather than pretending the
// file was received.
function describeNonTextMessage_(message) {
  if (message.photo) return 'photo';
  if (message.sticker) return 'sticker';
  if (message.voice) return 'voice message';
  if (message.video_note) return 'video note';
  if (message.video) return 'video';
  if (message.document) return 'file';
  if (message.audio) return 'audio message';
  if (message.location) return 'location';
  if (message.contact) return 'contact card';
  return 'that kind of message';
}

/**
 * What a RECEIVED_MESSAGE row is allowed to record.
 *
 * MESSAGES is an interaction audit trail, not a transcript. Logging the raw
 * body defeated the redaction the rest of the codebase is careful about:
 * while a chat is AWAITING_IDENTIFIER the raw text IS the teacher's email
 * address (UserSession.gs's redactIdentifier_ exists precisely to keep that
 * out of this sheet), and while it is AWAITING_CASE_DETAIL the raw text is the
 * free-text case description that CaseManager.gs's getCasesForChatId
 * deliberately strips so it is never echoed back. Both were landing in
 * MESSAGES in the clear — and MESSAGES is archived rather than deleted, so
 * they persisted indefinitely.
 *
 * The length is kept because it is the one thing that actually helps debug a
 * report of "I typed my email and nothing happened" without storing the value.
 */
const LOGGED_MESSAGE_REDACTIONS_ = {
  AWAITING_IDENTIFIER: '(identifier withheld — the value is in the USERS row)',
  AWAITING_CASE_DETAIL: '(case detail withheld — the value is in the case DETAIL column)',
  AWAITING_URGENT_CODE: '(urgent code withheld)'
};

function loggableMessageText_(chatId, text) {
  if (!text) return '(non-text message)';
  // One extra CacheService read per message, against a sheet append that is
  // already happening — cheap at this ratio.
  const mode = getChatState_(chatId).mode;
  // hasOwnProperty, not a bare lookup: same discipline as FormRouter.gs's
  // formUrlForDocType_, so an unexpected mode string can never resolve to an
  // inherited Object.prototype member and be treated as a redaction template.
  const redaction = mode && Object.prototype.hasOwnProperty.call(LOGGED_MESSAGE_REDACTIONS_, mode)
    ? LOGGED_MESSAGE_REDACTIONS_[mode]
    : null;
  return redaction ? redaction + ' [' + String(text).length + ' chars]' : text;
}

function routeUpdate_(update, message, callbackQuery) {
  if (message) {
    const chatId = message.chat.id;
    // A question typed as a photo/file CAPTION used to be discarded outright:
    // the teacher got "I can't accept a photo" and the question they actually
    // asked was never read. The caption is now treated as the message text,
    // while the attachment itself is still refused (uploads only ever go
    // through the Submit Documents forms).
    const captionOnly = !message.text && !!message.caption;
    const text = message.text || message.caption;
    logInteraction(chatId, 'RECEIVED_MESSAGE', loggableMessageText_(chatId, text));

    if (!text) {
      const kind = describeNonTextMessage_(message);
      sendMessage(chatId, "I can't accept a " + kind + " directly here. Use the Submit Documents menu to get the correct form link, or type your question as text.", { reply_markup: mainMenuKeyboard_() });
      return;
    }

    if (captionOnly) {
      sendMessage(chatId, "Note: I can't accept the " + describeNonTextMessage_(message) +
        ' you attached — uploads go through the Submit Documents forms. Answering the message you sent with it:');
    }

    // Telegram's deep links (t.me/YourBot?start=PAYLOAD) arrive as
    // "/start <payload>". Matching only the bare string sent anyone arriving
    // through such a link to "I didn't understand that." No payload carries
    // meaning yet, so the menu is the correct destination for all of them.
    if (text === '/start' || text === '/menu' || text.indexOf('/start ') === 0) {
      showMainMenu(chatId);
      return;
    }

    // /help is its own branch, not routed through AdminCommands.gs's
    // dispatcher — routeAdminCommand_ rejects any non-admin outright, which
    // would turn "/help" from every teacher into an admin-rejection message
    // (PLAN.md Phase 6 constraint, recorded during the Phase 3 review).
    if (text === '/help') {
      handleHelpCommand_(chatId);
      return;
    }

    // Its own branch, not routed through AdminCommands.gs's dispatcher, for the
    // same reason /help is: routeAdminCommand_ rejects any non-admin outright,
    // which would turn a teacher's privacy request into an admin rejection.
    if (text === '/privacy') {
      logInteraction(chatId, 'PRIVACY_NOTICE_REQUESTED', '');
      sendMessage(chatId, PRIVACY_NOTICE_TEXT, { reply_markup: mainMenuKeyboard_() });
      return;
    }

    // Admin commands (Phase 3) are recognized by name regardless of who sends
    // them — routeAdminCommand_ itself rejects non-admins cleanly. Anything
    // it doesn't recognize (including "/foo" typos) falls through unchanged
    // to normal text handling, same as before Phase 3 existed.
    if (text.charAt(0) === '/' && routeAdminCommand_(chatId, text)) {
      return;
    }

    handleTextMessage_(chatId, text);
    return;
  }

  if (callbackQuery) {
    // Telegram omits `message` on a callback fired against a message older
    // than ~48 hours. Reading .chat.id off it unguarded threw, doPost swallowed
    // the error, and because answerCallbackQuery ran AFTER that read the
    // button's loading spinner never stopped — the teacher saw a permanently
    // spinning button and no reply. Acknowledge first, then work out where to
    // send anything; the same guard already exists in the private-chat check
    // at the top of doPost.
    answerCallbackQuery(callbackQuery.id);

    const cbChat = callbackQuery.message && callbackQuery.message.chat;
    const chatId = (cbChat && cbChat.id) ||
      (callbackQuery.from && callbackQuery.from.id);
    if (!chatId) {
      console.error('routeUpdate_: callback_query with no resolvable chat id — acknowledged and dropped.');
      return;
    }

    logInteraction(chatId, 'RECEIVED_CALLBACK', callbackQuery.data || '');
    handleMenuCallback_(chatId, callbackQuery.data || '');
    return;
  }
}

// Phase 6: teacher-facing help always shown; admin commands appended only
// for a sender with an ADMINS row, so a teacher never sees a command list
// they can't use (and can't tell from it who else is an admin).
function handleHelpCommand_(chatId) {
  let text = teacherHelpText_();
  if (findAdminRow_(chatId)) {
    text += '\n\n' + adminCommandsHelpText_();
  }
  sendMessage(chatId, text, { reply_markup: mainMenuKeyboard_() });
}

/** Simple GET handler so visiting the deployed URL in a browser confirms it's live. */
function doGet(e) {
  return ContentService.createTextOutput('MoPSE Telegram Bot webhook is running.');
}
