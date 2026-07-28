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

/**
 * The reference prefix a case gets, by category — `VISA-2026-0001`.
 *
 * Typed as a total map over `CaseCategory`, so adding a category without giving
 * it a prefix is a compile error rather than a run of cases quietly filed under
 * the fallback. The fallback exists for a category read back from a database row
 * written by newer code, which the type system cannot reach.
 */
export const CASE_REFERENCE_PREFIX: Readonly<Record<CaseCategory, string>> = {
  [CASE_CATEGORY.VISA]: 'VISA',
  [CASE_CATEGORY.TRAVEL]: 'TRAVEL',
  [CASE_CATEGORY.CONTRACT]: 'CONTRACT',
  [CASE_CATEGORY.ACCOMMODATION]: 'ACCOM',
  [CASE_CATEGORY.SUBMIT_DOCS]: 'DOCS',
  [CASE_CATEGORY.CONTACT_SUPPORT]: 'SUPPORT',
};

/** Used only for a category this build does not know about. See above. */
export const CASE_REFERENCE_PREFIX_FALLBACK = 'CASE';

/**
 * The categories a teacher may file a case under.
 *
 * Deliberately five, not the eleven FAQ topics and not the six case categories:
 * `MenuHandler.gs:270-282` records that only the four topics with a matching
 * admin queue, plus a general fallback, can actually be routed. `SUBMIT_DOCS` is
 * absent because documents arrive through their own flow, not this menu.
 *
 * `label` is the display text. `OTHER` reads "Something else" rather than
 * "Contact Support" (`MenuHandler.gs:293`) — held here so the keyboard builder
 * does not need a special case.
 */
export const CASE_TOPIC_CHOICES = [
  { key: 'VISA', category: CASE_CATEGORY.VISA, label: CASE_CATEGORY.VISA, emoji: '🛂' },
  { key: 'TRAVEL', category: CASE_CATEGORY.TRAVEL, label: CASE_CATEGORY.TRAVEL, emoji: '✈️' },
  { key: 'CONTRACT', category: CASE_CATEGORY.CONTRACT, label: CASE_CATEGORY.CONTRACT, emoji: '📝' },
  {
    key: 'ACCOMMODATION',
    category: CASE_CATEGORY.ACCOMMODATION,
    label: CASE_CATEGORY.ACCOMMODATION,
    emoji: '🏠',
  },
  { key: 'OTHER', category: CASE_CATEGORY.CONTACT_SUPPORT, label: 'Something else', emoji: '💬' },
] as const;

export type CaseTopicChoice = (typeof CASE_TOPIC_CHOICES)[number];
export type CaseTopicKey = CaseTopicChoice['key'];

const CASE_TOPICS_BY_KEY = new Map<string, CaseTopicChoice>(
  CASE_TOPIC_CHOICES.map((c) => [c.key, c]),
);

/** Resolve a filing choice from callback data. Unknown keys return null. */
export function caseTopicByKey(key: string): CaseTopicChoice | null {
  return CASE_TOPICS_BY_KEY.get(key) ?? null;
}

/**
 * A new case in the same category within this window returns the existing case
 * instead of opening a second one (`CaseManager.gs:28`). It is what makes a
 * double-tap harmless.
 */
export const CASE_DEDUP_WINDOW_HOURS = 24;

/**
 * Roster verification is an identity check against real teacher addresses, so it
 * cannot be an unlimited guessing game (`MenuHandler.gs:38`). Generous enough
 * that a teacher mistyping their own address is never locked out in practice.
 *
 * The count lives in the conversation state and expires with it (D3), so five
 * typos pause a teacher for the rest of the window rather than durably — no
 * Stage 3 command exists to release one.
 */
export const MAX_VERIFICATION_ATTEMPTS = 5;

/**
 * A retry that can never succeed must end in a clear message rather than loop
 * silently until the state expires (`MenuHandler.gs:43`).
 */
export const MAX_CASE_DETAIL_ATTEMPTS = 3;

/**
 * How long an in-progress conversation survives without a reply
 * (`MenuHandler.gs:25`).
 *
 * Enforced when the state is read, never by a sweeper (D4). An expired state is
 * treated as absent, so an abandoned case from two days ago cannot capture the
 * teacher's next FAQ question as its detail.
 */
export const CONVERSATION_TTL_MINUTES = 30;

/**
 * How long a teacher has to describe an urgent case after their code is
 * accepted.
 *
 * The Apps Script version used six hours, and MenuHandler.gs:27-33 says plainly
 * that six was the ceiling CacheService allowed — not a considered figure. The
 * consequence of it lapsing is a burned single-use code and a teacher who has
 * to phone a Regional admin again. PostgreSQL has no such ceiling, so this is
 * chosen on its merits: a teacher who starts an urgent case in the evening can
 * finish it the next morning.
 */
export const URGENT_DETAIL_TTL_HOURS = 24;

/**
 * The category an urgent case is filed under.
 *
 * Urgent Case deliberately has no topic picker (`MenuHandler.gs:445`): a teacher
 * in an emergency should not be made to classify it first. Everything urgent
 * therefore lands in the general queue, which is also why urgent-plus-duplicate
 * is the *common* path rather than an edge case — every ordinary Contact Support
 * case files here too.
 */
export const URGENT_CASE_CATEGORY = CASE_CATEGORY.CONTACT_SUPPORT;

/**
 * How many wrong urgent codes one chat may offer inside the window below.
 *
 * New, and not carried over — it exists because the rebuild made something safer
 * and thereby made something else unsafe. `consumeUrgentCode_`
 * (`AdminCommands.gs:1261`) deleted the code whether it was right or wrong, so a
 * guess cost the guesser the thing they were guessing at. The conditional
 * `UPDATE` that makes a code genuinely single-use leaves a *wrong* code
 * untouched, so guessing became free — and the code space is six characters.
 *
 * No document mentions a limit, because until the consumption became atomic
 * there was nothing to limit.
 */
export const URGENT_CODE_MAX_ATTEMPTS = 5;

/**
 * The window the cap above is counted over.
 *
 * Rolling and self-healing, for D3's reason: a durable counter would need a
 * command to release it, and no such command exists before Stage 4. A teacher
 * who fat-fingers a code five times waits an hour; a script working through the
 * code space is slowed to sixty guesses a day, which is not a search.
 *
 * Counted in its own table rather than in the conversation state, which the
 * cap in `MAX_VERIFICATION_ATTEMPTS` uses: tapping Main Menu clears the
 * conversation state, so a state-held counter would reset on demand. That is
 * tolerable for an address a teacher is trying to remember and useless against
 * somebody guessing.
 */
export const URGENT_CODE_ATTEMPT_WINDOW_MINUTES = 60;

/**
 * How long after a code is spent a case must exist before it is treated as an
 * error.
 *
 * Under D5 a code and its case are written in one transaction, so a spent code
 * with no case cannot happen. This is the alarm for "cannot happen" happening —
 * it fires only if something has consumed a code outside the one write path.
 */
export const URGENT_CODE_STRANDED_AFTER_MINUTES = 60;

/** Questions listed per page when browsing one topic (`QAEngine.gs:376`). */
export const FAQ_PAGE_SIZE = 8;

/**
 * The most rows a disambiguation picker may offer.
 *
 * New here, and not carried over: `QAEngine.gs:267` hands the picker *every* row
 * in the category when nothing matched, so a topic holding forty answers built a
 * forty-button keyboard. Capping it costs a teacher nothing — past a handful the
 * list has stopped being a choice — and the Contact Support control below it is
 * the real escape hatch.
 */
export const FAQ_MAX_PICKER_BUTTONS = 8;

/** Below this a row is not a match at all (`QAEngine.gs:28`). */
export const FAQ_MATCH_MIN_SCORE = 1;

/**
 * At or above this, and alone at the top, an answer is sent directly; otherwise
 * the teacher is offered a choice (`QAEngine.gs:32`). This is where "the bot
 * must never guess" is actually enforced.
 */
export const FAQ_CONFIDENT_SCORE = 2;

/** Most recent cases shown by Check My Case (`MenuHandler.gs:266`). */
export const CHECK_MY_CASE_CAP = 10;
