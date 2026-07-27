/**
 * Values that are part of the program, not settings.
 *
 * In the Apps Script version several of these lived in a spreadsheet cell, which
 * meant a typo or a rename silently disabled a feature with no error anywhere.
 * They are code now: a mismatch is a compile error.
 */

/**
 * Every timestamp a teacher or a staff member sees, and every scheduled job, is
 * computed in this zone.
 *
 * Apps Script inherited the project's time zone automatically. A Linux server
 * defaults to UTC, which is Tashkent minus five hours — so without stating this
 * explicitly every case note, escalation and new-case alert would be stamped
 * five hours early, and the 07:00 digest would arrive at noon. That is the kind
 * of error noticed months later, if ever.
 *
 * Deliberately NOT an environment variable. A misconfigured server is exactly
 * the failure this constant exists to prevent.
 */
export const TIMEZONE = 'Asia/Tashkent' as const;

/**
 * The value written to a case's category column.
 *
 * A different axis from FAQ topics: this is how a case is routed to staff.
 * Conflating the two was the original design flaw in the Apps Script version.
 */
export const CASE_CATEGORY = {
  VISA: 'Visa',
  TRAVEL: 'Travel and Arrival',
  CONTRACT: 'Contract Signing',
  ACCOMMODATION: 'Accommodation',
  SUBMIT_DOCS: 'Submit Documents',
  CONTACT_SUPPORT: 'Contact Support',
} as const;

export type CaseCategory = (typeof CASE_CATEGORY)[keyof typeof CASE_CATEGORY];

/**
 * The browsable FAQ taxonomy — the single source of truth for which topics exist.
 *
 * `code` is what travels in a button's callback data. The Apps Script version
 * put the display label in there instead, which tied button size to the length
 * of human-readable text and would have broken outright once the promised
 * Russian and Uzbek labels arrived. A code is short, fixed, and language
 * independent, so translating the interface becomes a display change only.
 *
 * `label` must match the FAQ sheet's CATEGORY cell exactly — the sync rejects
 * and reports any row whose category is not in this list, which is what turns
 * yesterday's silent failure (a typo makes an answer permanently unreachable)
 * into a message someone can act on.
 *
 * `onMainMenu` keeps the top-level menu usable. Everything is reachable from the
 * FAQ hub; only the four highest-traffic topics also get a main-menu shortcut.
 * All eleven on the main menu would be a seventeen-button wall.
 */
export const FAQ_TOPICS = [
  { code: 'VISA', label: CASE_CATEGORY.VISA, emoji: '🛂', onMainMenu: true },
  { code: 'TRAVEL', label: CASE_CATEGORY.TRAVEL, emoji: '✈️', onMainMenu: true },
  { code: 'CONTRACT', label: CASE_CATEGORY.CONTRACT, emoji: '📝', onMainMenu: true },
  { code: 'ACCOM', label: CASE_CATEGORY.ACCOMMODATION, emoji: '🏠', onMainMenu: true },
  { code: 'SALARY', label: 'Salary and Payment', emoji: '💵', onMainMenu: false },
  { code: 'WORKLOAD', label: 'Workload and Hours', emoji: '📚', onMainMenu: false },
  { code: 'LEAVE', label: 'Leave and Holidays', emoji: '📅', onMainMenu: false },
  { code: 'PLACEMENT', label: 'Placement and School', emoji: '🏫', onMainMenu: false },
  { code: 'HEALTH', label: 'Health and Insurance', emoji: '🏥', onMainMenu: false },
  { code: 'CONDUCT', label: 'Conduct and Development', emoji: '🎓', onMainMenu: false },
  { code: 'LIVING', label: 'Living in Uzbekistan', emoji: '🌍', onMainMenu: false },
] as const;

export type FaqTopic = (typeof FAQ_TOPICS)[number];
export type FaqTopicCode = FaqTopic['code'];

const TOPICS_BY_CODE = new Map<string, FaqTopic>(FAQ_TOPICS.map((t) => [t.code, t]));
const TOPICS_BY_LABEL = new Map<string, FaqTopic>(FAQ_TOPICS.map((t) => [t.label, t]));

/** Resolve a topic from a button's callback data. Unknown codes return null. */
export function faqTopicByCode(code: string): FaqTopic | null {
  return TOPICS_BY_CODE.get(code) ?? null;
}

/**
 * Resolve a topic from a spreadsheet CATEGORY cell. Unknown labels return null,
 * which is how the sync detects a typo instead of silently orphaning the row.
 */
export function faqTopicByLabel(label: string): FaqTopic | null {
  return TOPICS_BY_LABEL.get(label.trim()) ?? null;
}

/** Every valid FAQ category cell value, for error messages that name the options. */
export function faqTopicLabels(): readonly string[] {
  return FAQ_TOPICS.map((t) => t.label);
}

/**
 * Telegram rejects callback data longer than 64 bytes, and silently truncating
 * it would route a tap to the wrong place. Everything that builds callback data
 * is measured against this, and the suite asserts the worst realistic case with
 * real values rather than trusting an estimate.
 */
export const CALLBACK_DATA_MAX_BYTES = 64;
