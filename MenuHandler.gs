/**
 * MenuHandler.gs — the main menu (8 Phase 1 buttons + Change Language and
 * Urgent Case added in Phase 2/3) and all routing glue. Ties together
 * UserSession.gs, CaseManager.gs, QAEngine.gs, AdminCommands.gs's
 * consumeUrgentCode_ (Urgent Case's code check), and FormRouter.gs's
 * docTypeList_/formUrlForDocType_ (Submit Documents, Phase 4).
 *
 * Verification scope (per PLAN.md Phase 2 exit check, revised by Phase 5):
 * case-creation and case-lookup ("Contact Support", "Check My Case",
 * "Urgent Case", and — since Phase 5 — "Submit Documents") require a
 * roster-verified identity. FAQ browsing (Visa/Travel/Contract/
 * Accommodation/FAQ hub) stays open to any chat. Submit Documents was
 * folded in during Phase 5 because Triggers.gs's onFormSubmit calls
 * createCase(), which hard-requires isVerified_(chatId) — gating the menu
 * button the same way keeps a teacher from reaching a form only to have
 * their eventual submission silently become an "unresolved submitter" case.
 *
 * Conversation state (which category a chat is mid-question with, whether
 * it's mid-verification, whether it's mid-case-detail) lives in one
 * consolidated CacheService entry per chat_id rather than several
 * independent flag keys, so there's a single TTL and no risk of two flags
 * disagreeing about what the chat is doing.
 */

const CHAT_STATE_TTL_SECONDS = 30 * 60;

// The urgent-detail state gets the longest TTL CacheService allows (its
// ceiling is 6 hours). By the time this state is set, consumeUrgentCode_ has
// already destroyed the teacher's single-use, 48-hour, admin-issued code — so
// letting the state lapse after the ordinary 30 minutes burned that code for
// nothing: a teacher who stepped away came back to "I didn't understand that"
// with no way to recover it and no way to re-issue it themselves.
const URGENT_DETAIL_STATE_TTL_SECONDS = 6 * 60 * 60;

// Roster verification is an identity check against real teacher email
// addresses, so it cannot be an unlimited guessing game. Generous enough that
// a teacher mistyping their own address is never locked out in practice.
const MAX_VERIFICATION_ATTEMPTS = 5;

// Same shape as MAX_VERIFICATION_ATTEMPTS, for the same reason: a retry that can
// never succeed must end in a clear message rather than silently looping until
// the state TTL expires — which is six hours for an urgent case.
const MAX_CASE_DETAIL_ATTEMPTS = 3;

function getChatState_(chatId) {
  try {
    const raw = CacheService.getScriptCache().get('chat_state_' + chatId);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error('getChatState_ failed for ' + chatId + ': ' + err);
    return {};
  }
}

function setChatState_(chatId, state, ttlSeconds) {
  try {
    CacheService.getScriptCache().put('chat_state_' + chatId, JSON.stringify(state), ttlSeconds || CHAT_STATE_TTL_SECONDS);
  } catch (err) {
    console.error('setChatState_ failed for ' + chatId + ': ' + err);
  }
}

function clearChatState_(chatId) {
  try {
    CacheService.getScriptCache().remove('chat_state_' + chatId);
  } catch (err) {
    console.error('clearChatState_ failed for ' + chatId + ': ' + err);
  }
}

/** True for any browsable FAQ topic — used to validate a 'CAT:' or 'FAQPG:'
 * callback before acting on it, so a hand-crafted callback can't push an
 * arbitrary string through as a category name. Derived from Config.gs's
 * FAQ_TOPICS rather than a hardcoded list, so a new topic is valid the moment
 * it is added there. */
function isKnownCategory_(category) {
  return faqTopicLabels_().indexOf(category) !== -1;
}

// ---- Main menu ----

/**
 * Topic shortcuts are generated from the FAQ_TOPICS entries flagged
 * onMainMenu, then the action buttons. Only a few topics get a shortcut: with
 * eleven topics, listing them all here alongside six actions would make a
 * seventeen-button wall. Everything is reachable via "All FAQ topics".
 */
function mainMenuKeyboard_() {
  const rows = FAQ_TOPICS
    .filter(t => t.onMainMenu)
    .map(t => [{ text: t.emoji + ' ' + t.label, callback_data: 'MENU:' + t.key }]);

  rows.push([{ text: '❓ All FAQ topics', callback_data: 'MENU:FAQ' }]);
  // Hidden entirely until a real Google Form exists — offering it would send a
  // teacher a dead link after making them verify to reach it.
  if (documentSubmissionEnabled_()) {
    rows.push([{ text: '📤 Submit Documents', callback_data: 'MENU:SUBMIT_DOCS' }]);
  }
  rows.push([{ text: '🔍 Check My Case', callback_data: 'MENU:CHECK_CASE' }]);
  rows.push([{ text: '📞 Contact Support', callback_data: 'MENU:CONTACT_SUPPORT' }]);
  rows.push([{ text: '🌐 Change Language', callback_data: 'MENU:CHANGE_LANGUAGE' }]);
  rows.push([{ text: '🚨 Urgent Case', callback_data: 'MENU:URGENT_CASE' }]);

  return { inline_keyboard: rows };
}

// Phase 6: /help text (Webhook.gs's handleHelpCommand_ appends
// AdminCommands.gs's adminCommandsHelpText_ for admins). Kept as a plain
// function, not tied to mainMenuKeyboard_'s button list, so wording can
// differ from the button labels without the two drifting into contradicting
// each other by accident.
function teacherHelpText_() {
  const lines = [
    'MoPSE Teacher Support Bot — quick help:',
    '/start or /menu — show the main menu',
    // Generated from FAQ_TOPICS so this line cannot drift out of sync with the
    // actual menu the way the old hardcoded four-topic list did.
    FAQ_TOPICS.filter(t => t.onMainMenu).map(t => t.emoji + ' ' + t.label).join(' / ') +
      ' — browse FAQ answers by topic',
    '❓ All FAQ topics — the full list (' + FAQ_TOPICS.length +
      ' topics, including salary, workload, leave, placement, health and living in Uzbekistan)'
  ];
  if (documentSubmissionEnabled_()) {
    lines.push('📤 Submit Documents — get the right form link for visa, contract, passport, ticket, reimbursement, certificate, or correction documents');
  }
  lines.push('🔍 Check My Case — see the status of cases you have opened');
  lines.push('📞 Contact Support — open a new case with our support team');
  lines.push('🚨 Urgent Case — only if you already have a one-time code from a MoPSE Regional admin');
  lines.push('/privacy — what information we hold about you and how to have it removed');
  lines.push('🌐 Change Language — English only for now');
  return lines.join('\n');
}

function showMainMenu(chatId) {
  clearChatState_(chatId);
  sendMessage(chatId, 'Welcome to the MoPSE Teacher Support Bot. Choose a topic:', { reply_markup: mainMenuKeyboard_() });
}

function backToMenuKeyboard_() {
  return { reply_markup: { inline_keyboard: [[{ text: '🏠 Main Menu', callback_data: 'MENU:MAIN' }]] } };
}

// Back-to-topic + Home for screens reached from inside a category
// (proposal §10 requires both) is QAEngine.gs's faqNavKeyboard_ — it lives
// there because it needs the category vocabulary the FAQ rows carry.

// ---- Category browsing (Visa / Travel / Contract / Accommodation) ----

function enterCategory_(chatId, category, page) {
  setChatState_(chatId, { mode: 'CATEGORY', category: category });
  logInteraction(chatId, 'MENU_CATEGORY', category);

  // Keyboard construction, paging, and the Telegram-limit checks on each
  // button all live in QAEngine.gs's faqCategoryKeyboard_ — it owns the FAQ
  // row vocabulary, and the picker path needs the same button rules.
  const view = faqCategoryKeyboard_(category, page);

  if (view.total === 0) {
    sendMessage(chatId, 'No FAQ content is loaded for "' + category + '" yet. Type your question anyway, or tap Contact Support.',
      { reply_markup: { inline_keyboard: [
        [{ text: '📞 Contact Support', callback_data: 'MENU:CONTACT_SUPPORT' }],
        [{ text: '🏠 Main Menu', callback_data: 'MENU:MAIN' }]
      ] } });
    return;
  }

  const prompt = view.pageCount > 1
    ? 'Topic: ' + category + ' — page ' + (view.current + 1) + ' of ' + view.pageCount +
      ' (' + view.total + ' questions). Pick one below, or type your own:'
    : 'Topic: ' + category + '. Pick a question below, or type your own:';
  sendMessage(chatId, prompt, { reply_markup: view.keyboard });
}

// FAQ hub: a picker for the 4 topics that have FAQ content, for teachers who
// tap "FAQ" without already knowing which category their question is under.
function showFaqHub_(chatId) {
  clearChatState_(chatId);
  // Every topic, not just the main-menu shortcuts — this hub is the complete
  // index, and is the only route to topics without a shortcut.
  const rows = FAQ_TOPICS.map(t => [{ text: t.emoji + ' ' + t.label, callback_data: 'MENU:' + t.key }]);
  rows.push([{ text: '🏠 Main Menu', callback_data: 'MENU:MAIN' }]);
  sendMessage(chatId, 'Which topic is your question about?', { reply_markup: { inline_keyboard: rows } });
}

// ---- Submit Documents (Phase 4: doc-type -> form URL mapping now owned by
// FormRouter.gs — see that file's header — rather than this file reading
// Config.gs's FORM_URLS directly.) ----

function showSubmitDocsMenu_(chatId) {
  clearChatState_(chatId);
  const keyboard = { inline_keyboard: docTypeList_().map(d => [{ text: d.label, callback_data: 'DOC:' + d.key }]) };
  keyboard.inline_keyboard.push([{ text: '🏠 Main Menu', callback_data: 'MENU:MAIN' }]);
  sendMessage(chatId, 'Which document are you submitting?', { reply_markup: keyboard });
}

function sendDocFormLink_(chatId, docKey) {
  const url = formUrlForDocType_(chatId, docKey);
  if (!url) { showMainMenu(chatId); return; }
  logInteraction(chatId, 'DOC_LINK_SENT', docKey);
  sendMessage(chatId, 'Use this form to submit: ' + url, {
    reply_markup: { inline_keyboard: [
      [{ text: '⬅️ Back to Submit Documents', callback_data: 'MENU:SUBMIT_DOCS' }],
      [{ text: '🏠 Main Menu', callback_data: 'MENU:MAIN' }]
    ] }
  });
}

// ---- Change Language (Phase 2: EN only at launch — button exists and says
// so, rather than being absent or a dead end. Real translations land later.) ----

function sendChangeLanguageComingSoon_(chatId) {
  logInteraction(chatId, 'CHANGE_LANGUAGE_TAPPED', '');
  sendMessage(chatId, 'English is the only language available right now. Russian and Uzbek are coming soon.', backToMenuKeyboard_());
}

// ---- Check My Case / Contact Support (case-creation, identity-gated) ----

// Phase 6: "pause submissions, keep FAQ live." createCase() only ever runs
// from Contact Support, Urgent Case, and (once a real form is submitted)
// Submit Documents — all three route through this function, so gating here
// covers every case-creation entry point in one place. Check My Case is
// deliberately excluded: it's read-only, not a submission, and PLAN.md's
// Oracle note on /maintenance is specifically about pausing submissions, not
// locking teachers out of their own case status.
function startCaseFeature_(chatId, action) {
  if (action !== 'CHECK_CASE' && isMaintenanceMode_()) {
    sendMessage(chatId, 'Submissions are temporarily paused for maintenance. FAQ browsing is still available — please try again later.', backToMenuKeyboard_());
    return;
  }
  if (!isVerified_(chatId)) {
    setChatState_(chatId, { mode: 'AWAITING_IDENTIFIER', pendingAction: action });
    startVerification_(chatId);
    return;
  }
  runCaseFeature_(chatId, action);
}

function runCaseFeature_(chatId, action) {
  if (action === 'CHECK_CASE') { handleCheckMyCase_(chatId); return; }
  if (action === 'CONTACT_SUPPORT') { handleContactSupportStart_(chatId); return; }
  if (action === 'URGENT_CASE') { promptUrgentCode_(chatId); return; }
  if (action === 'SUBMIT_DOCS') { showSubmitDocsMenu_(chatId); return; }
}

// ---- Urgent Case (Phase 3: identity-gated like Contact Support, plus a
// single-use code from a Regional admin's /generate_urgent_code before the
// resulting case is filed as CASE_STATUS.ESCALATED instead of NEW) ----

function promptUrgentCode_(chatId) {
  setChatState_(chatId, { mode: 'AWAITING_URGENT_CODE' });
  sendMessage(chatId, 'Please enter the urgent code you were given by a MoPSE Regional admin.', backToMenuKeyboard_());
}

function handleCheckMyCase_(chatId) {
  const cases = getCasesForChatId(chatId);
  if (cases.length === 0) {
    sendMessage(chatId, 'You have no cases on file. Tap Contact Support to open one.', backToMenuKeyboard_());
    return;
  }
  const lines = cases.slice(0, 10).map(c => {
    let line = c.reference + ' — ' + c.status + ' (' + c.category + ')';
    if (c.publicUpdate) line += '\n  ' + c.publicUpdate;
    return line;
  });
  let text = 'Your cases:\n' + lines.join('\n');
  if (cases.length > 10) text += '\n\n(Showing your 10 most recent of ' + cases.length + '.)';
  sendMessage(chatId, text, backToMenuKeyboard_());
}

// Categories a case can be filed under. The four FAQ topics that have a matching
// ADMIN_QUEUE, plus a general fallback — deliberately not all eleven FAQ topics,
// because the seven newer ones have no queue to route to (see UPGRADE-PLAN.md
// Task 3.3).
function caseTopicChoices_() {
  return [
    { key: 'VISA', label: CATEGORIES.VISA, emoji: '🛂' },
    { key: 'TRAVEL', label: CATEGORIES.TRAVEL, emoji: '✈️' },
    { key: 'CONTRACT', label: CATEGORIES.CONTRACT, emoji: '📝' },
    { key: 'ACCOMMODATION', label: CATEGORIES.ACCOMMODATION, emoji: '🏠' },
    { key: 'OTHER', label: CATEGORIES.CONTACT_SUPPORT, emoji: '💬' }
  ];
}

function caseTopicByKey_(key) {
  return caseTopicChoices_().filter(t => t.key === key)[0] || null;
}

// One extra tap buys queue-based routing for the whole system: without it every
// case files under one generic category, which maps to the All queue, which
// means no admin can ever be given a narrower scope than "everything".
function handleContactSupportStart_(chatId) {
  const rows = caseTopicChoices_().map(t => [{
    text: t.emoji + ' ' + (t.key === 'OTHER' ? 'Something else' : t.label),
    callback_data: 'CASETOPIC:' + t.key
  }]);
  rows.push([{ text: '🏠 Main Menu', callback_data: 'MENU:MAIN' }]);
  sendMessage(chatId, 'What is your question about? This makes sure the right team sees it.',
    { reply_markup: { inline_keyboard: rows } });
}

/**
 * Urgent + deduplicated is the awkward case, and it is the COMMON one rather
 * than an edge case: every case today files under the single generic
 * CONTACT_SUPPORT category, so a teacher who opened an ordinary support case
 * in the last 24 hours will always dedup against it.
 *
 * The old behaviour dropped the escalation entirely on a dedup — which meant
 * the teacher's single-use, 48-hour, admin-issued urgent code was consumed
 * for nothing and neither they nor the issuing admin were told. Instead of
 * duplicating the case (the original reasoning for skipping, which was
 * sound) the urgent detail is now appended to the existing case and that
 * case is escalated if it isn't already. The code still buys exactly what it
 * promised: attention on the teacher's problem.
 */
function escalateExistingCase_(reference, text) {
  const existing = findCaseByReference_(reference);
  if (!existing) return false;
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  const fields = {
    DETAIL: (existing.DETAIL ? existing.DETAIL + '\n' : '') + '[' + stamp + ' URGENT follow-up] ' + text
  };
  if (existing.STATUS !== CASE_STATUS.ESCALATED) fields.STATUS = CASE_STATUS.ESCALATED;
  updateCaseFields_(reference, fields);
  return true;
}

/**
 * @returns {boolean} true when the teacher's message was CONSUMED — a case was
 *   filed, deduplicated, or escalated — and the caller should clear the chat
 *   state. false when createCase failed and the chat must stay in
 *   AWAITING_CASE_DETAIL so the next message is still read as a case
 *   description.
 *
 * State is owned by the caller, not by this function, exactly as it is for
 * verification: attemptVerify_ returns an outcome and handleTextMessage_ owns
 * the state and the attempt counter. Transient messages are sent from here
 * (this function knows what failed); the give-up message is sent by the caller
 * (only it knows how many attempts have been made) — the same split that keeps
 * attemptVerify_ from double-messaging on the final attempt.
 */
function handleCaseDetailMessage_(chatId, text, urgent, category) {
  category = category || CATEGORIES.CONTACT_SUPPORT;
  let result;
  try {
    result = createCase(chatId, category, (urgent ? '[URGENT] ' : '') + text);
  } catch (err) {
    console.error('handleCaseDetailMessage_ failed: ' + err);
    // No state change here. The teacher is still mid-report; their next message
    // must be read as the case description, not as a fresh FAQ query. For an
    // urgent case this is the difference between one retry and a lost
    // single-use code, since consumeUrgentCode_ has already destroyed it.
    sendMessage(chatId, 'Something went wrong opening your case — nothing you typed was lost. ' +
      'Please send your description again in a moment.', backToMenuKeyboard_());
    return false;
  }

  if (result.isNew) {
    if (urgent) {
      try {
        updateCaseFields_(result.reference, { STATUS: CASE_STATUS.ESCALATED });
      } catch (err) {
        console.error('handleCaseDetailMessage_: escalation failed for ' + result.reference + ': ' + err);
      }
    }
    logInteraction(chatId, 'CASE_CREATED', result.reference);
    notifyAdminsOfNewCase_(result.reference, urgent);
    sendMessage(chatId,
      'Case opened' + (urgent ? ' and marked urgent' : '') + '. Your reference is ' + result.reference +
      '. Use Check My Case to see its status.', backToMenuKeyboard_());
    return true;
  }

  // Deduplicated against an existing open case.
  if (urgent) {
    let escalated = false;
    try {
      escalated = escalateExistingCase_(result.reference, text);
    } catch (err) {
      console.error('handleCaseDetailMessage_: could not escalate existing ' + result.reference + ': ' + err);
    }
    logInteraction(chatId, escalated ? 'CASE_ESCALATED_EXISTING' : 'CASE_DUPLICATE_RETURNED', result.reference);
    if (escalated) notifyAdminsOfNewCase_(result.reference, true);
    sendMessage(chatId, escalated
      ? 'You already have an open case on this topic (' + result.reference + '), so I have added your urgent details to it and marked it urgent rather than opening a second case.'
      : 'You already have an open case on this topic: ' + result.reference + '. Please contact your Regional admin if it needs urgent attention.',
      backToMenuKeyboard_());
    return true;
  }

  logInteraction(chatId, 'CASE_DUPLICATE_RETURNED', result.reference);
  sendMessage(chatId, 'You already have an open case on this topic: ' + result.reference + '. It has not been duplicated.', backToMenuKeyboard_());
  return true;
}

// ---- Text message + callback routing ----

function handleTextMessage_(chatId, text) {
  const state = getChatState_(chatId);

  if (state.mode === 'AWAITING_IDENTIFIER') {
    const outcome = attemptVerify_(chatId, text);

    // Transient failures already told the teacher to retry, and must not burn
    // an attempt against the cap below.
    if (outcome === 'BUSY' || outcome === 'ERROR') return;

    if (outcome === 'NO_MATCH') {
      // Previously the state was simply left in place, so every message was
      // another free guess against the roster — an unbounded probe for real
      // teacher email addresses from any chat that reached the bot.
      const attempts = (state.attempts || 0) + 1;
      if (attempts >= MAX_VERIFICATION_ATTEMPTS) {
        clearChatState_(chatId);
        logInteraction(chatId, 'VERIFY_ATTEMPTS_EXCEEDED', String(attempts));
        sendMessage(chatId,
          'That still does not match our records, so I have stopped checking for now. Please contact ' +
          SUPPORT_CONTACT_INFO + ' to get your details sorted out, then tap the menu option again.',
          { reply_markup: mainMenuKeyboard_() });
        return;
      }
      setChatState_(chatId, { mode: 'AWAITING_IDENTIFIER', pendingAction: state.pendingAction, attempts: attempts });
      sendMessage(chatId,
        "That doesn't match our records. Please check the email or code from your paperwork and try again — " +
        (MAX_VERIFICATION_ATTEMPTS - attempts) + ' attempt(s) left. You can also contact ' +
        SUPPORT_CONTACT_INFO + ' for help.');
      return;
    }

    // Verified. Resume whichever button (Check My Case / Contact Support / …)
    // triggered verification so the teacher doesn't dead-end after proving who
    // they are. Goes through startCaseFeature_, not runCaseFeature_ directly —
    // verification takes a moment and maintenance mode could have been switched
    // on in between, and startCaseFeature_ re-checks isMaintenanceMode_().
    clearChatState_(chatId);
    if (state.pendingAction) {
      startCaseFeature_(chatId, state.pendingAction);
    } else {
      showMainMenu(chatId);
    }
    return;
  }

  if (state.mode === 'AWAITING_CASE_DETAIL') {
    const urgent = !!state.urgent;
    // Urgent Case has no topic picker — the teacher is already in an emergency
    // and one more tap is one too many — so it falls back to the generic
    // category, which routes to the All queue. That is the correct destination
    // for something urgent enough to warrant a code.
    const category = state.category || CATEGORIES.CONTACT_SUPPORT;

    // The state is cleared only once the message has actually been CONSUMED.
    // Clearing it first meant a createCase failure — a lock timeout under the
    // load that follows an /announce is the realistic cause — silently dropped
    // the teacher back to the topic picker, and for an Urgent Case discarded
    // urgent:true after their single-use code had already been destroyed.
    if (handleCaseDetailMessage_(chatId, text, urgent, category)) {
      clearChatState_(chatId);
      return;
    }

    const attempts = (state.detailAttempts || 0) + 1;
    if (attempts >= MAX_CASE_DETAIL_ATTEMPTS) {
      clearChatState_(chatId);
      logInteraction(chatId, 'CASE_DETAIL_ATTEMPTS_EXCEEDED', String(attempts));
      sendMessage(chatId,
        'I still could not open your case after several tries, so I have stopped retrying. ' +
        'Please tap Contact Support to start again' +
        (urgent ? ', and tell your Regional admin the urgent code did not go through so they can issue another' : '') +
        '.', { reply_markup: mainMenuKeyboard_() });
      return;
    }

    // Re-set rather than left alone, because the attempt counter has to persist.
    // The TTL is re-derived from `urgent` — an urgent chat keeps the six-hour
    // window it was given, and re-setting it also restarts that clock, which is
    // the right direction to err for someone whose code is already spent.
    setChatState_(chatId,
      { mode: 'AWAITING_CASE_DETAIL', urgent: urgent, category: category, detailAttempts: attempts },
      urgent ? URGENT_DETAIL_STATE_TTL_SECONDS : CHAT_STATE_TTL_SECONDS);
    return;
  }

  if (state.mode === 'AWAITING_URGENT_CODE') {
    if (consumeUrgentCode_(text)) {
      setChatState_(chatId, { mode: 'AWAITING_CASE_DETAIL', urgent: true }, URGENT_DETAIL_STATE_TTL_SECONDS);
      sendMessage(chatId, 'Code accepted. Briefly describe your urgent issue in one message — you have several hours to reply, so take the time you need.');
    } else {
      clearChatState_(chatId);
      sendMessage(chatId, "That code isn't valid or has expired. Contact your Regional admin for a new one, or use Contact Support instead.", backToMenuKeyboard_());
    }
    return;
  }

  if (state.mode === 'CATEGORY' && state.category) {
    answerFaqQuery(chatId, state.category, text);
    return;
  }

  // A typed question with no topic selected used to get a flat "I didn't
  // understand that", which is the wrong answer to the most natural thing a
  // teacher can do. Matching across all topics at once is deliberately still
  // refused (proposal §4.2 — a visa question must never be answered from the
  // accommodation bank), but the question is remembered so the teacher does not
  // have to type it twice.
  logInteraction(chatId, 'QUERY_WITHOUT_TOPIC', String(text).slice(0, 200));
  setChatState_(chatId, { mode: 'AWAITING_TOPIC_FOR_QUERY', pendingQuery: text });
  const rows = FAQ_TOPICS.map(t => [{ text: t.emoji + ' ' + t.label, callback_data: 'QTOPIC:' + t.key }]);
  rows.push([{ text: '📞 None of these — Contact Support', callback_data: 'MENU:CONTACT_SUPPORT' }]);
  sendMessage(chatId, 'Which topic is that about? I will look up your question there.',
    { reply_markup: { inline_keyboard: rows } });
}

function handleMenuCallback_(chatId, data) {
  if (data === 'MENU:MAIN') { showMainMenu(chatId); return; }
  if (data === 'MENU:FAQ') { showFaqHub_(chatId); return; }
  if (data === 'MENU:SUBMIT_DOCS') {
    // A stale button from an earlier deployment can still arrive.
    if (!documentSubmissionEnabled_()) {
      sendMessage(chatId, 'Document submission is not open yet. Please use Contact Support and we will tell you what to send.', backToMenuKeyboard_());
      return;
    }
    startCaseFeature_(chatId, 'SUBMIT_DOCS');
    return;
  }
  if (data === 'MENU:CHECK_CASE') { startCaseFeature_(chatId, 'CHECK_CASE'); return; }
  if (data === 'MENU:CONTACT_SUPPORT') { startCaseFeature_(chatId, 'CONTACT_SUPPORT'); return; }
  if (data === 'MENU:CHANGE_LANGUAGE') { sendChangeLanguageComingSoon_(chatId); return; }
  if (data === 'MENU:URGENT_CASE') { startCaseFeature_(chatId, 'URGENT_CASE'); return; }

  // Any remaining 'MENU:<key>' is an FAQ topic, resolved from Config.gs's
  // FAQ_TOPICS instead of one hardcoded branch per topic. Adding a topic there
  // is now the only edit required — this router, the main menu, the FAQ hub
  // and isKnownCategory_ all pick it up automatically. Checked after the fixed
  // action keys above so a topic key can never shadow an action.
  if (data.indexOf('MENU:') === 0) {
    const topic = faqTopicByKey_(data.substring(5));
    if (topic) { enterCategory_(chatId, topic.label); return; }
  }
  if (data.indexOf('CASETOPIC:') === 0) {
    const topic = caseTopicByKey_(data.substring(10));
    if (!topic) { showMainMenu(chatId); return; }
    // Re-gated: verification and maintenance were checked when Contact Support
    // was tapped, but the teacher may have sat on this keyboard for a while.
    if (isMaintenanceMode_()) {
      sendMessage(chatId, 'Submissions are temporarily paused for maintenance. FAQ browsing is still available — please try again later.', backToMenuKeyboard_());
      return;
    }
    if (!isVerified_(chatId)) {
      setChatState_(chatId, { mode: 'AWAITING_IDENTIFIER', pendingAction: 'CONTACT_SUPPORT' });
      startVerification_(chatId);
      return;
    }
    setChatState_(chatId, { mode: 'AWAITING_CASE_DETAIL', category: topic.label });
    sendMessage(chatId, 'Briefly describe your issue in one message and I will open a ' +
      topic.label + ' case for you.', backToMenuKeyboard_());
    return;
  }
  if (data.indexOf('DOC:') === 0) { sendDocFormLink_(chatId, data.substring(4)); return; }
  // A typed question that arrived before a topic was chosen: answer it in the
  // topic the teacher just picked, without making them retype it.
  if (data.indexOf('QTOPIC:') === 0) {
    const topic = faqTopicByKey_(data.substring(7));
    if (!topic) { showFaqHub_(chatId); return; }
    const pending = getChatState_(chatId).pendingQuery;
    setChatState_(chatId, { mode: 'CATEGORY', category: topic.label });
    if (pending) { answerFaqQuery(chatId, topic.label, pending); return; }
    enterCategory_(chatId, topic.label);
    return;
  }
  if (data.indexOf('FAQOK:') === 0) {
    logInteraction(chatId, 'FAQ_HELPFUL', data.substring(6));
    sendMessage(chatId, 'Good — glad that helped.', { reply_markup: mainMenuKeyboard_() });
    return;
  }
  if (data.indexOf('FAQBAD:') === 0) {
    // The most actionable content signal of all: this answer was returned
    // confidently and was still wrong for the person who asked.
    logInteraction(chatId, 'FAQ_NOT_HELPFUL', data.substring(7));
    sendMessage(chatId, 'Sorry about that. Tap Contact Support and describe what you need — ' +
      'a person will pick it up.', {
        reply_markup: { inline_keyboard: [
          [{ text: '📞 Contact Support', callback_data: 'MENU:CONTACT_SUPPORT' }],
          [{ text: '❓ Try another topic', callback_data: 'MENU:FAQ' }],
          [{ text: '🏠 Main Menu', callback_data: 'MENU:MAIN' }]
        ] }
      });
    return;
  }
  if (data.indexOf('FAQANS:') === 0) { handleFaqAnswerCallback_(chatId, data.substring(7)); return; }
  // Paged category browsing: 'FAQPG:<page>:<category>'. Page is parsed first
  // so the category — free text from the sheet — is whatever remains, and it
  // is validated against the known list for the same reason 'CAT:' is.
  if (data.indexOf('FAQPG:') === 0) {
    const rest = data.substring(6);
    const sep = rest.indexOf(':');
    if (sep !== -1) {
      const page = parseInt(rest.slice(0, sep), 10);
      const category = rest.slice(sep + 1);
      if (!isNaN(page) && isKnownCategory_(category)) {
        enterCategory_(chatId, category, page);
        return;
      }
    }
    showFaqHub_(chatId);
    return;
  }
  // "Back to <topic>" from an answer or picker. Validated against the known
  // category list so an arbitrary string can't be pushed through as one.
  if (data.indexOf('CAT:') === 0) {
    const category = data.substring(4);
    if (isKnownCategory_(category)) { enterCategory_(chatId, category); return; }
    showFaqHub_(chatId);
    return;
  }
  // Unknown callback (e.g. a stale button from before a redeploy) — fall
  // back to the main menu rather than doing nothing.
  showMainMenu(chatId);
}
