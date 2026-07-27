/**
 * Config.gs — all constants for the MoPSE Telegram Bot.
 * No secrets live here. Secrets (bot token, webhook secret, spreadsheet ID)
 * are stored in Script Properties (File > Project properties > Script properties,
 * or via the PropertiesService calls below) and read at runtime.
 */

// ---- Script Property keys (values set once via Apps Script editor, not in code) ----
const PROP_KEYS = {
  BOT_TOKEN: 'BOT_TOKEN',
  WEBHOOK_SECRET: 'WEBHOOK_SECRET',
  SPREADSHEET_ID: 'SPREADSHEET_ID',
  WEBAPP_URL: 'WEBAPP_URL'
};

function getProp_(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) throw new Error('Missing script property: ' + key + '. Set it in Project Settings > Script Properties.');
  return value;
}

function getBotToken() { return getProp_(PROP_KEYS.BOT_TOKEN); }
function getWebhookSecret() { return getProp_(PROP_KEYS.WEBHOOK_SECRET); }
function getSpreadsheetId() { return getProp_(PROP_KEYS.SPREADSHEET_ID); }
function getWebAppUrl() { return getProp_(PROP_KEYS.WEBAPP_URL); }

function getSpreadsheet() {
  return SpreadsheetApp.openById(getSpreadsheetId());
}

// ---- Sheet (tab) names ----
const SHEETS = {
  FAQ: 'FAQ',
  CASES: 'CASES',
  USERS: 'USERS',
  MESSAGES: 'MESSAGES',
  ADMINS: 'ADMINS',
  SETTINGS: 'SETTINGS',
  ANNOUNCEMENTS: 'ANNOUNCEMENTS',
  ROSTER: 'ROSTER'
};

/**
 * ---- Case categories: the value written to a CASES row's CATEGORY column ----
 *
 * This is a DIFFERENT axis from FAQ_TOPICS below, and conflating the two was
 * the original design flaw here: this object used to also hold 'Check My Case'
 * and 'FAQ', which are menu actions, not categories — nothing ever read them
 * (they were dead config), while the four topic values below are read by
 * CaseManager.casePrefixForCategory_ and AdminCommands.queueForCategory_.
 *
 * All six values are live. Contact Support asks the teacher which topic their
 * question is about and files the case under it (MenuHandler.gs's
 * caseTopicChoices_), so VISA/TRAVEL/CONTRACT/ACCOMMODATION reach
 * CaseManager.casePrefixForCategory_ and AdminCommands.queueForCategory_ as
 * real, routed categories. CONTACT_SUPPORT remains the value for Urgent Case
 * and "Something else"; SUBMIT_DOCS for a document form.
 */
const CATEGORIES = {
  VISA: 'Visa',
  TRAVEL: 'Travel and Arrival',
  CONTRACT: 'Contract Signing',
  ACCOMMODATION: 'Accommodation',
  SUBMIT_DOCS: 'Submit Documents',
  CONTACT_SUPPORT: 'Contact Support'
};

/**
 * ---- FAQ topics: the browsable knowledge-base taxonomy ----
 *
 * THE single source of truth for which topics exist. The main menu, the FAQ
 * hub, the 'CAT:'/'FAQPG:' callback validation (isKnownCategory_), and the
 * FAQ sheet's CATEGORY column all derive from this one list — previously each
 * of those hardcoded its own copy of four topics, so adding a topic meant
 * editing four places and silently broke if you missed one.
 *
 * `label` MUST match the FAQ sheet's CATEGORY cell EXACTLY (QAEngine's
 * getFaqRowsForCategory_ filters on strict equality). The first four reference
 * CATEGORIES so the two axes cannot drift apart where they legitimately
 * overlap.
 *
 * `onMainMenu` keeps the top-level menu at a usable length: everything is
 * reachable from the FAQ hub, and only the four highest-traffic topics also
 * get a main-menu shortcut. Putting all eleven on the main menu would make it
 * a seventeen-button wall.
 *
 * ⚠️ Adding a topic here is safe for case handling. This list is the FAQ
 * browsing taxonomy only — it is NOT the list of categories a case can be filed
 * under. That is MenuHandler.gs's caseTopicChoices_, which deliberately offers
 * just the four topics with a matching ADMIN_QUEUE plus a generic fallback, so
 * a new topic added here cannot produce a case nobody is queued to see.
 * AdminCommands.queueForCategory_ maps all eleven labels onto an existing queue
 * anyway, and anything unmapped defaults to ADMIN_QUEUE.ALL.
 */
const FAQ_TOPICS = [
  { key: 'VISA',          label: CATEGORIES.VISA,          emoji: '🛂', onMainMenu: true },
  { key: 'TRAVEL',        label: CATEGORIES.TRAVEL,        emoji: '✈️', onMainMenu: true },
  { key: 'CONTRACT',      label: CATEGORIES.CONTRACT,      emoji: '📝', onMainMenu: true },
  { key: 'ACCOMMODATION', label: CATEGORIES.ACCOMMODATION, emoji: '🏠', onMainMenu: true },
  { key: 'SALARY',        label: 'Salary and Payment',      emoji: '💵', onMainMenu: false },
  { key: 'WORKLOAD',      label: 'Workload and Hours',      emoji: '📚', onMainMenu: false },
  { key: 'LEAVE',         label: 'Leave and Holidays',      emoji: '📅', onMainMenu: false },
  { key: 'PLACEMENT',     label: 'Placement and School',    emoji: '🏫', onMainMenu: false },
  { key: 'HEALTH',        label: 'Health and Insurance',    emoji: '🏥', onMainMenu: false },
  { key: 'CONDUCT',       label: 'Conduct and Development',  emoji: '🎓', onMainMenu: false },
  { key: 'LIVING',        label: 'Living in Uzbekistan',    emoji: '🌍', onMainMenu: false }
];

/** All valid FAQ CATEGORY cell values. */
function faqTopicLabels_() {
  return FAQ_TOPICS.map(t => t.label);
}

/** Look up a topic by its menu key ('VISA'), or null. */
function faqTopicByKey_(key) {
  return FAQ_TOPICS.filter(t => t.key === key)[0] || null;
}

// ---- Document submission types → form URL placeholders (real URLs filled in before Phase 4) ----
const FORM_URLS = {
  VISA: 'https://forms.gle/PLACEHOLDER_VISA',
  CONTRACT: 'https://forms.gle/PLACEHOLDER_CONTRACT',
  PASSPORT: 'https://forms.gle/PLACEHOLDER_PASSPORT',
  TICKET: 'https://forms.gle/PLACEHOLDER_TICKET',
  REIMBURSEMENT: 'https://forms.gle/PLACEHOLDER_REIMBURSEMENT',
  CERTIFICATE: 'https://forms.gle/PLACEHOLDER_CERTIFICATE',
  CORRECTION: 'https://forms.gle/PLACEHOLDER_CORRECTION'
};

// ---- FAQ cache TTL (seconds) — proposal §8 quota mitigation, used starting Phase 1 ----
const FAQ_CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 hours

// ---- MANUAL ENTRY REQUIRED before go-live ----
// Shown when a /start identifier doesn't match the ROSTER sheet ("contact HR"
// message, UserSession.gs) and as a general human-contact fallback.
// Replace with a real MoPSE support/HR email or phone number.
const SUPPORT_CONTACT_INFO = 'PLACEHOLDER_SUPPORT_CONTACT — replace with a real MoPSE support/HR email or phone number';

// ---- MANUAL REVIEW REQUIRED before go-live ----
// Proposal §7 requires a privacy notice before data collection. This text is
// shown at verification and via /privacy. It must be reviewed by whoever is
// accountable for MoPSE's data handling — the wording below is a starting
// point written by an engineer, not legal advice.
const PRIVACY_NOTICE_TEXT = [
  'How we use your information',
  '',
  'We store: your Telegram chat ID, the identifier you verify with, and your name and region as they appear on the official teacher roster.',
  'We also store the text of support cases you open, and a log of your interactions with this bot.',
  '',
  'We use this only to confirm you are an enrolled teacher, to answer your questions, and to track your support cases.',
  'It is visible to authorised MoPSE support staff. It is not shared with anyone else and is never sold.',
  '',
  'To ask what we hold about you, or to have it removed, contact ' + SUPPORT_CONTACT_INFO + '.'
].join('\n');
