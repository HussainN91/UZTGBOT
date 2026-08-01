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
 * How long a teacher has to write out a priority request before the prompt
 * lapses.
 *
 * Far longer than the thirty minutes every other prompt gets, and it stays that
 * way now the one-time code is gone. The original argument was that lapsing
 * burned a single-use code; the remaining one is simpler and was always the
 * better half of it. Somebody asking for their case to be moved ahead of others
 * is being asked to explain *why*, which means finding a date, a letter or an
 * appointment reference — and a prompt that expires while they go and look is a
 * prompt that gets answered with two words instead.
 */
export const URGENT_DETAIL_TTL_HOURS = 24;

/**
 * The category a priority request is filed under.
 *
 * The request path deliberately has no topic picker (`MenuHandler.gs:445`): a
 * teacher who needs something looked at quickly should not be made to classify
 * it first. Everything therefore lands in the general queue, which is also why
 * request-plus-duplicate is the *common* path rather than an edge case — every
 * ordinary Contact Support case files here too.
 */
export const URGENT_CASE_CATEGORY = CASE_CATEGORY.CONTACT_SUPPORT;

/**
 * Six constants used to live here, and all six were withdrawn on 1 August 2026:
 * the code alphabet and length, its two-day life, the guess cap, the window that
 * cap was counted over, and the delay before a spent-but-unused code raised an
 * alarm.
 *
 * They existed to make a six-character credential safe to read down a telephone
 * line, because a teacher had to be told one before the bot would let them
 * describe an urgent problem. The gate moved: nothing now stands between the
 * button and the writing, and a regional coordinator decides afterwards whether
 * the case is actually a priority. A credential nobody has to hold needs no
 * alphabet, no expiry, and no lockout.
 */

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

/**
 * Cases shown in one staff list, before "and N more".
 *
 * A cap rather than pagination because a Telegram message has a hard 4096
 * character limit and a list that silently loses its tail is worse than one that
 * says how much it is not showing. The count of the rest is always reported, so
 * a staff member can tell a long queue from a short one — `handleListCases_`
 * showed twenty and said nothing, which made a backlog of two hundred look
 * identical to a backlog of twenty.
 */
export const STAFF_CASE_LIST_CAP = 20;

/**
 * How many of those rows get a button under them — Part 5G.
 *
 * **Deliberately well below `STAFF_CASE_LIST_CAP`.** Twenty rows of buttons is a
 * wall a staff member has to scroll past to reach anything else in their chat,
 * and the buttons are a convenience rather than the list: the text is still
 * there to scan, and `/case <reference>` still works for everything below the
 * cut. Eight covers the top of a queue, which is where somebody is working.
 *
 * The text list is **not** shortened to match. A row without a button is still a
 * row, and hiding work because it did not fit on a keyboard would be the same
 * fault as a list that silently loses its tail.
 */
export const CASE_LIST_BUTTON_CAP = 8;

/**
 * How many staff get a button on the `/staff` menu — Part 5H.3.
 *
 * Larger than the case cap, because the two lists are read differently. A case
 * list is a queue somebody works from the top of, so eight covers what they are
 * doing now and the rest is scrolled past. A staff list is a directory, and the
 * person being looked for is as likely to be at the bottom of it as the top —
 * a cap that hid them would mean the buttons could not do the job at all.
 *
 * A ministry with more staff than this still has `/staff`, which lists everybody
 * as text, and the menu says so rather than pretending the list ends here.
 */
export const STAFF_BUTTON_CAP = 20;

/**
 * The most staff members one new case may notify.
 *
 * A latency bound, not a policy. `deliver` sends sequentially inside the webhook
 * request, which `src/web/main.ts:40-44` configures with a 25-second timeout and
 * `onTimeout: 'return'` — twenty sends at Telegram's response times is a second
 * or two, and an unbounded fan-out is how one busy afternoon turns into
 * timed-out webhooks for everybody.
 *
 * Apps Script called it `NEW_CASE_NOTIFY_MAX_ADMINS_`. It lives here rather than
 * in a prose reference to a deleted file because a number that governs how long
 * a webhook request takes has to be findable.
 *
 * If the staff list ever grows past this, the answer is to move the fan-out to
 * the worker rather than to raise it — which is the same threshold `/announce`
 * will have to respect in stage 5.
 */
export const NEW_CASE_NOTIFY_CAP = 20;

/**
 * Notes shown when a staff member opens one case, most recent first.
 *
 * The rest are counted, not dropped silently. This is the number that stops
 * `/case` reproducing the Apps Script failure where an internal thread
 * accumulated inside `detail` until reading a case exceeded Telegram's limit.
 */
export const CASE_NOTES_SHOWN = 5;

/**
 * Telegram's hard limit on one message, in characters.
 *
 * Not a preference and not adjustable: past this the API returns a 400, `send`
 * throws, and the staff member who asked for something gets nothing while an
 * operator gets an alarm. `/case` is the command that can reach it — it prints a
 * teacher's own words, which have no length limit and which the urgent path
 * appends to, plus several staff notes that have none either.
 *
 * This is the failure `handleCaseDetail_` carried a comment about, and the
 * reason D8 moved notes out of `cases.detail`: an internal thread accumulating
 * inside a field that also held the teacher's original description, until
 * reading a case exceeded what Telegram would deliver. Moving the notes stopped
 * the field growing without limit; it did not make either one short.
 */
export const TELEGRAM_MESSAGE_MAX_CHARS = 4096;

/**
 * How much of a teacher's own words `/case` shows before it says it is
 * truncating.
 *
 * The two budgets below are chosen to fit inside the limit above with the
 * header, the fields and five notes: 1200 + 5 × 280 = 2600, leaving room for
 * everything else and a wide margin. They are the *stated* protection; the clamp
 * applied to every staff message is the guarantee, because a budget is
 * arithmetic and arithmetic goes wrong quietly.
 *
 * Truncated with a marker saying how much is missing, never silently. A staff
 * member who cannot see the last paragraph must know there is one — the whole
 * argument behind `STAFF_CASE_LIST_CAP` reporting its total.
 */
export const CASE_DETAIL_SHOWN_CHARS = 1200;

/** The same, per note. Five of these fit alongside the detail above. */
export const CASE_NOTE_SHOWN_CHARS = 280;

/**
 * The longest a case may be snoozed for.
 *
 * A snooze suppresses chasing, not the case, and a cap is what stops it becoming
 * a way to make an inconvenient case disappear. Ninety days is longer than any
 * legitimate wait described in the FAQ bank and short enough that a snoozed case
 * resurfaces inside one recruitment cycle.
 */
export const MAX_SNOOZE_DAYS = 90;

/**
 * How long a case may sit at `Action required` before the TEACHER is reminded.
 *
 * The teacher, not the staff member. A case waiting on the teacher is one the
 * person holding it is correctly doing nothing about, and a digest that nags
 * people about work they are not permitted to move is a digest they learn to
 * ignore (plan D26, D40).
 *
 * Three days rather than one, for D21's reason one axis along: a teacher is
 * being asked to do something that may need a document, an appointment or a
 * trip to an office, and a daily reminder for a thing that takes a week is how
 * a person learns to mute the bot that files their emergencies.
 */
export const TEACHER_CHASE_AFTER_DAYS = 3;

/**
 * How many reminders one case may send its teacher before it stops.
 *
 * Three unanswered reminders over nine days is a teacher who has left, changed
 * number, or given up — and at that point the useful act is not a fourth
 * message. The case's owner is told instead, which is the situation
 * `/close <ref> unresolved <reason>` was built for (D26) and which nothing has
 * ever produced a signal for.
 *
 * The count is also the marker for "the owner has been told": one past this
 * means the report has gone out. A sixth column on `cases` for a boolean that
 * one query reads is not worth a migration.
 */
export const TEACHER_CHASE_MAX = 3;

/**
 * Cases shown in one list inside the daily digest, before "and N more".
 *
 * Smaller than `STAFF_CASE_LIST_CAP` because a digest carries three lists at
 * once and arrives unasked. Somebody who wants the whole queue types `/cases`;
 * this is the summary that tells them whether they need to.
 */
export const DIGEST_LIST_CAP = 10;

/**
 * Recipients one run of the announcement sweeper may send to.
 *
 * A latency bound on a single job run, not a policy about how many people may be
 * messaged. The worker is deliberately `concurrency: 1`, so a job that paced
 * itself through 1,800 sends would hold the only slot for minutes — during which
 * the ten-minute sync and the five-minute heartbeat do not run, and the first
 * symptom is a false alarm that the sheet sync has stopped, raised late by the
 * heartbeat that was itself starved.
 *
 * At 200 a run and one run a minute, 1,800 teachers take about nine minutes and
 * no single run takes more than a few seconds.
 */
export const ANNOUNCEMENT_BATCH = 200;

/**
 * How long the per-recipient delivery rows of a finished announcement are kept.
 *
 * A constant rather than a settings key, deliberately (D33). It governs
 * operational bookkeeping — 1,800 chat ids and a delivery state per broadcast —
 * and not anything the privacy notice states, so it is not one of the three
 * periods a teacher is told about. Nine settings is a control panel nobody can
 * hold in their head; three periods are three sentences.
 *
 * After a month, "was this teacher's copy delivered" answers no question anybody
 * asks. The `announcements` row itself is never pruned: it is the record of what
 * the ministry told teachers, and it holds no teacher's words.
 */
export const ANNOUNCEMENT_RECIPIENT_RETENTION_DAYS = 30;

/**
 * The most rows one export may contain.
 *
 * A cap rather than pagination, for `STAFF_CASE_LIST_CAP`'s reason and one more:
 * the file is built in memory and handed to Telegram, which refuses a document
 * past 50MB. Ten thousand rows is far inside that and far past what anybody
 * reads — and the count of what is not included is always stated, because a
 * truncated report that does not say it is truncated is one somebody plans from.
 */
export const EXPORT_ROW_CAP = 10_000;

/**
 * How long between asking one teacher whether the region we hold is still right.
 *
 * Deliberately rare, and D21 gives the reason: there is no session to attach the
 * question to — only messages and a thirty-minute conversation state — so
 * "every new session" becomes "most times they come back", which for 1,800
 * people is a question tapped through unread. A field that decides who receives
 * somebody's emergency is the last one that should be filled by reflex.
 *
 * Half a year is roughly one recruitment cycle: long enough that nobody is being
 * nagged, short enough that a teacher who moved in March is asked before the
 * year is out. It is measured from when the question was last *shown*, so a
 * teacher who ignores it is asked again rather than never again.
 */
export const REGION_CONFIRM_AFTER_DAYS = 180;
