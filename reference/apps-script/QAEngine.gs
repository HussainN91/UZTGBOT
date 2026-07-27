/**
 * QAEngine.gs — keyword-matched FAQ lookup, scoped to one category at a
 * time (never searched globally — proposal §4.2: precision over recall for
 * visa/contract/reimbursement questions).
 *
 * CACHING (proposal §8 quota mitigation). CacheService has a hard 100 KB
 * limit per value and throws on a larger put(). The FAQ sheet is meant to
 * hold the full approved answer bank, which is comfortably larger than that,
 * so storing the whole sheet under one key would have thrown on the first
 * real content pass — and because doPost() catches everything, the visible
 * symptom would have been menu buttons doing nothing at all, with no error.
 * The cache is therefore split across numbered chunk keys, and EVERY cache
 * operation degrades to a direct sheet read on failure rather than
 * propagating. A slow bot beats a silent one.
 *
 * MATCHING. Scoring is token-based, not raw substring: the old
 * `query.indexOf(keyword)` matched "fee" inside "coffee" and happily
 * returned that as a definitive approved answer. Keywords now match on word
 * boundaries, multi-word keywords are matched as phrases, and a conservative
 * edit-distance pass tolerates typos ("visaa", "acommodation") — but a
 * typo-only match scores lower than an exact one and is never enough on its
 * own to return a definitive answer. Below that confidence bar the teacher
 * gets buttons to choose from, never a guess (proposal §1.2: the bot must
 * not invent or mis-attribute an approved answer).
 */

// A row must score at least this to be considered a candidate at all.
const FAQ_MATCH_MIN_SCORE = 1;
// ...and at least this to be returned directly as THE answer. A score of 1
// means the only evidence was a fuzzy/typo match, which earns a picker
// instead of a confident reply.
const FAQ_CONFIDENT_SCORE = 2;
const FAQ_MAX_BUTTONS = 8;

// Cache layout. Chunk size is in CHARACTERS while CacheService's limit is in
// BYTES, so this is deliberately well under 100 KB to stay safe even if the
// content is multi-byte (Russian/Uzbek later).
const FAQ_CACHE_KEY_PREFIX_ = 'faq_rows_v2_';
const FAQ_CACHE_COUNT_KEY_ = 'faq_rows_v2_count';
const FAQ_CACHE_CHUNK_CHARS_ = 32000;
const FAQ_CACHE_MAX_CHUNKS_ = 40;

// ---- Cache ----

function readFaqCache_() {
  try {
    const cache = CacheService.getScriptCache();
    const countRaw = cache.get(FAQ_CACHE_COUNT_KEY_);
    if (!countRaw) return null;
    const count = parseInt(countRaw, 10);
    if (!count || count < 1 || count > FAQ_CACHE_MAX_CHUNKS_) return null;

    const keys = [];
    for (let i = 0; i < count; i++) keys.push(FAQ_CACHE_KEY_PREFIX_ + i);
    const all = cache.getAll(keys);

    let json = '';
    for (let i = 0; i < count; i++) {
      const part = all[FAQ_CACHE_KEY_PREFIX_ + i];
      // Cache entries can be evicted individually and early — a partial set
      // is unusable, so fall back to the sheet and repopulate.
      if (part === undefined || part === null) return null;
      json += part;
    }
    return JSON.parse(json);
  } catch (err) {
    console.error('readFaqCache_ failed, falling back to sheet: ' + err);
    return null;
  }
}

function writeFaqCache_(rows) {
  try {
    const cache = CacheService.getScriptCache();
    const json = JSON.stringify(rows);
    const chunkCount = Math.max(1, Math.ceil(json.length / FAQ_CACHE_CHUNK_CHARS_));
    if (chunkCount > FAQ_CACHE_MAX_CHUNKS_) {
      // Content has outgrown the cache design. Not fatal — every lookup just
      // reads the sheet directly — but it should be noticed and fixed.
      console.error('writeFaqCache_: FAQ content needs ' + chunkCount + ' chunks, over the ' +
        FAQ_CACHE_MAX_CHUNKS_ + ' limit. Caching skipped; every FAQ read will hit the sheet.');
      return;
    }
    const entries = {};
    for (let i = 0; i < chunkCount; i++) {
      entries[FAQ_CACHE_KEY_PREFIX_ + i] = json.slice(i * FAQ_CACHE_CHUNK_CHARS_, (i + 1) * FAQ_CACHE_CHUNK_CHARS_);
    }
    entries[FAQ_CACHE_COUNT_KEY_] = String(chunkCount);
    cache.putAll(entries, FAQ_CACHE_TTL_SECONDS);
  } catch (err) {
    console.error('writeFaqCache_ failed (continuing without cache): ' + err);
  }
}

/**
 * Drop the cached FAQ so the next lookup re-reads the sheet. Called
 * automatically by Triggers.gs's onEdit handler when someone edits the FAQ
 * tab — without it, an approved content correction would take up to
 * FAQ_CACHE_TTL_SECONDS (6 hours) to reach teachers. Also safe to run by
 * hand from the Apps Script editor.
 */
function clearFaqCache() {
  try {
    const cache = CacheService.getScriptCache();
    const keys = [FAQ_CACHE_COUNT_KEY_];
    for (let i = 0; i < FAQ_CACHE_MAX_CHUNKS_; i++) keys.push(FAQ_CACHE_KEY_PREFIX_ + i);
    cache.removeAll(keys);
  } catch (err) {
    console.error('clearFaqCache failed: ' + err);
  }
}

function readFaqRowsFromSheet_() {
  const sheet = getSpreadsheet().getSheetByName(SHEETS.FAQ);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values.shift();
  return values
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => {
        // Dates would serialize to strings through the cache but stay Date
        // objects on a direct read; normalize so cached and uncached rows
        // are the same shape.
        obj[h] = row[i] instanceof Date ? row[i].toISOString() : row[i];
      });
      return obj;
    })
    .filter(r => r.CODE && String(r.ACTIVE).toUpperCase() === 'TRUE');
}

function getFaqRows_() {
  const cached = readFaqCache_();
  if (cached) return cached;
  const rows = readFaqRowsFromSheet_();
  writeFaqCache_(rows);
  return rows;
}

function getFaqRowsForCategory_(category) {
  return getFaqRows_().filter(r => r.CATEGORY === category);
}

function findFaqByCode_(code) {
  return getFaqRows_().filter(r => r.CODE === code)[0] || null;
}

// ---- Matching ----

// Explicit punctuation list rather than \w, which would strip accented
// characters out of names and non-English content.
const FAQ_PUNCTUATION_RE_ = /[.,\/#!$%^&*;:{}=\-_`~()?"'“”‘’«»\[\]|+<>]/g;

function normalizeText_(s) {
  return String(s === undefined || s === null ? '' : s)
    .toLowerCase()
    .replace(FAQ_PUNCTUATION_RE_, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize_(s) {
  const n = normalizeText_(s);
  return n ? n.split(' ') : [];
}

/**
 * Bounded Levenshtein: returns true if `a` and `b` are within `max` edits.
 * Bails out early on a length difference, so the DP only runs on genuinely
 * near-miss pairs.
 */
function withinEditDistance_(a, b, max) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > max) return false;

  let prev = [];
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return false; // no cell in this row can lead to a win
    prev = cur;
  }
  return prev[b.length] <= max;
}

/**
 * Typo tolerance scales with word length — short words are excluded entirely
 * because at 4 characters an edit distance of 1 makes almost everything match
 * almost everything ("visa"/"visit"), which is precisely the false-confidence
 * the proposal warns against.
 */
function allowedTypos_(word) {
  if (word.length >= 8) return 2;
  if (word.length >= 5) return 1;
  return 0;
}

/**
 * Score one FAQ row against a query.
 *   +2  exact phrase match (multi-word keyword found in the query)
 *   +2  exact token match (single-word keyword equals a query word)
 *   +1  fuzzy token match (query word is a near-miss for the keyword)
 * A row scoring only 1 has nothing but typo evidence behind it and will be
 * offered as a button, not returned as the answer.
 */
function scoreFaqRow_(row, queryNormalized, queryTokens) {
  const keywords = String(row.KEYWORDS || '')
    .split(',')
    .map(k => normalizeText_(k))
    .filter(Boolean);

  let score = 0;
  keywords.forEach(kw => {
    if (kw.indexOf(' ') !== -1) {
      // Multi-word keyword ("airport pickup", "wrong passport number"):
      // padded so it only matches on word boundaries.
      if ((' ' + queryNormalized + ' ').indexOf(' ' + kw + ' ') !== -1) score += 2;
      return;
    }
    let best = 0;
    for (let i = 0; i < queryTokens.length; i++) {
      const t = queryTokens[i];
      if (t === kw) { best = 2; break; }
      const tolerance = Math.min(allowedTypos_(kw), allowedTypos_(t));
      if (tolerance > 0 && withinEditDistance_(t, kw, tolerance)) best = Math.max(best, 1);
    }
    score += best;
  });
  return score;
}

/**
 * Match free-typed text against the FAQ rows for one category and reply.
 * Never invents an answer: below the confidence threshold, or with more
 * than one equally-good match, the teacher is shown buttons to pick from
 * instead of a guessed answer.
 */
function answerFaqQuery(chatId, category, queryText) {
  const rows = getFaqRowsForCategory_(category);
  if (rows.length === 0) {
    sendMessage(chatId, 'No FAQ content is loaded for "' + category + '" yet. Tap Contact Support if you need help.',
      { reply_markup: faqNavKeyboard_(null, true).reply_markup });
    return;
  }

  const queryNormalized = normalizeText_(queryText);
  const queryTokens = tokenize_(queryText);
  const scored = rows
    .map(r => ({ row: r, score: scoreFaqRow_(r, queryNormalized, queryTokens) }))
    .filter(s => s.score >= FAQ_MATCH_MIN_SCORE)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    // A question the approved bank cannot answer is the most valuable content
    // signal there is, and it was previously recorded nowhere — RECEIVED_MESSAGE
    // captures the text but not the fact that it failed, so gaps were
    // unfindable. Truncated because a MESSAGES cell is not a transcript.
    logInteraction(chatId, 'FAQ_NO_MATCH', category + ' | ' + String(queryText).slice(0, 200));
    sendFaqPicker_(chatId, rows, category,
      "I couldn't match that to an approved answer. Did you mean one of these, or tap Contact Support to reach a person:", true);
    return;
  }

  const topScore = scored[0].score;
  const topMatches = scored.filter(s => s.score === topScore).map(s => s.row);

  // One clear winner AND enough confidence to stand behind it.
  if (topMatches.length === 1 && topScore >= FAQ_CONFIDENT_SCORE) {
    sendFaqAnswer_(chatId, topMatches[0]);
    return;
  }

  // Logged separately from a clean miss: a tie or fuzzy-only match usually means
  // two answers need distinguishing keywords, not that content is missing.
  logInteraction(chatId, 'FAQ_LOW_CONFIDENCE',
    category + ' | ' + String(queryText).slice(0, 200) + ' | top=' + topScore + ' ties=' + topMatches.length);

  // Either several rows tied, or the only evidence was a fuzzy match. Both
  // cases get a choice rather than a guess.
  const prompt = topScore < FAQ_CONFIDENT_SCORE
    ? 'I am not certain I understood that. Did you mean one of these?'
    : 'I found a few things that might match — pick the closest one:';
  sendFaqPicker_(chatId, topMatches, category, prompt, topScore < FAQ_CONFIDENT_SCORE);
}

/**
 * Navigation offered under an answer or picker. Proposal §10 requires BOTH a
 * Back and a Home control from every submenu; previously only Home existed,
 * so reading an answer dead-ended at the main menu and the teacher had to
 * re-navigate into the topic to read the next one.
 */
function faqNavKeyboard_(category, includeContactSupport) {
  const rowsOut = [];
  if (includeContactSupport) {
    rowsOut.push([{ text: '📞 None of these — Contact Support', callback_data: 'MENU:CONTACT_SUPPORT' }]);
  }
  if (category && isKnownCategory_(category)) {
    rowsOut.push([{ text: '⬅️ Back to ' + category, callback_data: 'CAT:' + category }]);
  }
  rowsOut.push([{ text: '🏠 Main Menu', callback_data: 'MENU:MAIN' }]);
  return { reply_markup: { inline_keyboard: rowsOut } };
}

// ---- Keyboard building (shared with MenuHandler.gs's category browsing) ----

const FAQ_CALLBACK_PREFIX_ = 'FAQANS:';
const TELEGRAM_CALLBACK_DATA_MAX_BYTES_ = 64;

/**
 * UTF-8 byte length. Telegram's callback_data limit is in BYTES, not
 * characters, so a Cyrillic or accented CODE costs more than its length
 * suggests. encodeURIComponent renders each non-ASCII byte as %XX, so
 * collapsing those triples back to one character each gives the byte count
 * without allocating a Blob per button.
 */
function byteLength_(s) {
  return encodeURIComponent(String(s === undefined || s === null ? '' : s))
    .replace(/%[0-9A-F]{2}/gi, 'x').length;
}

/**
 * Build inline-keyboard rows for a list of FAQ entries, skipping any that
 * Telegram would reject.
 *
 * Telegram enforces two limits here, and breaking EITHER makes it reject the
 * entire sendMessage with an HTTP 400 — not merely the offending button.
 * Because callTelegramApi_ never throws and no caller on this path inspected
 * `.ok`, the symptom was a teacher tapping a topic and nothing happening at
 * all, with the root cause sitting in an operator-authored spreadsheet cell:
 *   - button text must be non-empty  (a blank BUTTON_TEXT cell)
 *   - callback_data must be 1..64 bytes  (an over-long CODE cell)
 * A bad row is now skipped and logged so the content owner can find and fix
 * it, instead of taking the whole menu down with it.
 */
function faqButtonRows_(rows) {
  const out = [];
  rows.forEach(r => {
    const label = String(r.BUTTON_TEXT === undefined || r.BUTTON_TEXT === null ? '' : r.BUTTON_TEXT).trim();
    if (!label) {
      console.error('faqButtonRows_: FAQ row "' + r.CODE + '" has a blank BUTTON_TEXT cell — button skipped.');
      return;
    }
    const data = FAQ_CALLBACK_PREFIX_ + r.CODE;
    const bytes = byteLength_(data);
    if (bytes > TELEGRAM_CALLBACK_DATA_MAX_BYTES_) {
      console.error('faqButtonRows_: FAQ code "' + r.CODE + '" produces ' + bytes +
        ' bytes of callback_data, over Telegram\'s ' + TELEGRAM_CALLBACK_DATA_MAX_BYTES_ +
        '-byte limit — button skipped. Shorten that CODE cell.');
      return;
    }
    out.push([{ text: label, callback_data: data }]);
  });
  return out;
}

/**
 * Category browsing, paginated.
 *
 * This previously rendered rows.slice(0, FAQ_MAX_BUTTONS) with no paging
 * control, so in any category holding more than FAQ_PAGE_SIZE approved
 * answers everything past the eighth was unreachable by tapping — findable
 * only by a teacher who happened to type a matching keyword. The approved
 * answer bank is far larger than eight entries per topic.
 *
 * callback_data is 'FAQPG:<page>:<category>' — page first so the category,
 * which is free text from the sheet, can be taken as the unparsed remainder.
 */
const FAQ_PAGE_SIZE = 8;

function faqCategoryKeyboard_(category, page) {
  const rows = getFaqRowsForCategory_(category);
  const pageCount = Math.max(1, Math.ceil(rows.length / FAQ_PAGE_SIZE));
  const current = Math.min(Math.max(0, page || 0), pageCount - 1);
  const slice = rows.slice(current * FAQ_PAGE_SIZE, (current + 1) * FAQ_PAGE_SIZE);

  const keyboard = { inline_keyboard: faqButtonRows_(slice) };

  if (pageCount > 1) {
    const nav = [];
    if (current > 0) {
      nav.push({ text: '⬅️ Previous', callback_data: 'FAQPG:' + (current - 1) + ':' + category });
    }
    if (current < pageCount - 1) {
      nav.push({ text: 'Next ➡️', callback_data: 'FAQPG:' + (current + 1) + ':' + category });
    }
    if (nav.length) keyboard.inline_keyboard.push(nav);
  }

  keyboard.inline_keyboard.push([{ text: '❓ Other topics', callback_data: 'MENU:FAQ' }]);
  keyboard.inline_keyboard.push([{ text: '🏠 Main Menu', callback_data: 'MENU:MAIN' }]);

  return { keyboard: keyboard, pageCount: pageCount, current: current, total: rows.length };
}

function sendFaqAnswer_(chatId, row) {
  logInteraction(chatId, 'FAQ_ANSWERED', row.CODE);
  const nav = faqNavKeyboard_(row.CATEGORY, false).reply_markup.inline_keyboard;
  // These two buttons are built here rather than through faqButtonRows_, which
  // is the only place that enforces Telegram's 64-byte callback_data ceiling.
  // Breaking it rejects the ENTIRE sendMessage with a 400, and because
  // callTelegramApi_ never throws the symptom is an answer that simply never
  // arrives — so the ceiling is re-checked here instead of assumed.
  const feedbackFits =
    byteLength_('FAQBAD:' + row.CODE) <= TELEGRAM_CALLBACK_DATA_MAX_BYTES_;
  if (!feedbackFits) {
    console.error('sendFaqAnswer_: CODE "' + row.CODE + '" is too long for feedback ' +
      'callback_data — answer sent without the ✅/❌ buttons. Shorten that CODE cell.');
  }
  const keyboard = (feedbackFits ? [[
    { text: '✅ That helped', callback_data: 'FAQOK:' + row.CODE },
    { text: '❌ Not what I meant', callback_data: 'FAQBAD:' + row.CODE }
  ]] : []).concat(nav);
  sendMessage(chatId, row.OFFICIAL_ANSWER, { reply_markup: { inline_keyboard: keyboard } });
}

function sendFaqPicker_(chatId, rows, category, promptText, includeContactSupport) {
  // No paging here on purpose: these are ranked search matches, so the top
  // FAQ_MAX_BUTTONS are the relevant ones. Paging belongs to category
  // browsing (faqCategoryKeyboard_), where the full list is the point.
  const keyboard = { inline_keyboard: faqButtonRows_(rows.slice(0, FAQ_MAX_BUTTONS)) };
  faqNavKeyboard_(category, includeContactSupport).reply_markup.inline_keyboard
    .forEach(r => keyboard.inline_keyboard.push(r));
  sendMessage(chatId, promptText, { reply_markup: keyboard });
}

function handleFaqAnswerCallback_(chatId, code) {
  const row = findFaqByCode_(code);
  if (!row) {
    // Most likely a stale button from before a content edit — the cache
    // invalidation on FAQ edits (Triggers.gs) makes this rarer, but a chat
    // scrolled back to an old message can still hit it.
    sendMessage(chatId, 'That answer is no longer available. Please pick a topic again.', faqNavKeyboard_(null, false));
    return;
  }
  sendFaqAnswer_(chatId, row);
}
