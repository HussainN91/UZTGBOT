/**
 * Every keyboard the teacher-facing bot builds.
 *
 * One module, so Telegram's 64-byte callback ceiling is measured in one place.
 * `QAEngine.gs:411` had to re-check the limit manually in a second place
 * precisely because keyboard building was scattered, and the two checks were
 * free to disagree.
 *
 * Pure: no database, no network, no clock. An over-long code is *reported* here
 * rather than alerted on, because alerting is a network call and this is a leaf.
 * The handler that owns the alerter decides what to do with `skipped`.
 */
import {
  CASE_TOPIC_CHOICES,
  FAQ_PAGE_SIZE,
  FAQ_TOPICS,
  faqTopicByCode,
} from '../config/constants.js';
import { CALLBACK, CallbackDataTooLongError, encodeCallback } from './callback-data.js';

export interface InlineButton {
  readonly text: string;
  readonly callback_data: string;
}

export type InlineKeyboardRow = readonly InlineButton[];
export type InlineKeyboard = readonly InlineKeyboardRow[];

/** The minimum a row needs to become a button. */
export interface ButtonableFaqRow {
  readonly code: string;
  readonly buttonText: string;
}

/**
 * A keyboard plus the answer codes left out of it.
 *
 * `skipped` is almost always empty. When it is not, a content owner has entered
 * a code long enough to break the button, and somebody needs telling — silently
 * dropping it is how an answer becomes unreachable with nothing to show for it.
 */
export interface KeyboardBuild {
  readonly keyboard: InlineKeyboard;
  readonly skipped: readonly string[];
}

/** Top-level destinations. Kept here because they exist only as buttons. */
export const MENU_ACTION = {
  MAIN: 'MAIN',
  FAQ: 'FAQ',
  CHECK_CASE: 'CHECK_CASE',
  CONTACT_SUPPORT: 'CONTACT_SUPPORT',
  URGENT_CASE: 'URGENT_CASE',
  /** "Who covers my region?" — Q2. Deliberately not behind the sign-in gate. */
  MY_MANAGER: 'MY_MANAGER',
} as const;

const HOME_BUTTON: InlineButton = {
  text: '🏠 Main Menu',
  callback_data: encodeCallback(CALLBACK.MENU, MENU_ACTION.MAIN),
};

const CONTACT_SUPPORT_BUTTON: InlineButton = {
  text: '📞 Contact Support',
  callback_data: encodeCallback(CALLBACK.MENU, MENU_ACTION.CONTACT_SUPPORT),
};

function topicButton(code: string, emoji: string, label: string): InlineButton {
  return { text: `${emoji} ${label}`, callback_data: encodeCallback(CALLBACK.TOPIC, code) };
}

/**
 * The main menu.
 *
 * Only the four highest-traffic topics get a shortcut; all eleven would be a
 * seventeen-button wall, and everything stays reachable through the FAQ hub.
 *
 * Submit Documents is absent until Stage 6 — `mainMenuKeyboard_` hid it behind
 * `documentSubmissionEnabled_()` for the same reason, that offering it would
 * send a teacher who had just verified to a dead end. Change Language is absent
 * for the same reason: the translations are promised, not written.
 */
export function mainMenuKeyboard(): InlineKeyboard {
  const rows: InlineKeyboardRow[] = FAQ_TOPICS.filter((t) => t.onMainMenu).map((t) => [
    topicButton(t.code, t.emoji, t.label),
  ]);
  rows.push([
    { text: '❓ All FAQ topics', callback_data: encodeCallback(CALLBACK.MENU, MENU_ACTION.FAQ) },
  ]);
  rows.push([
    {
      text: '🔍 Check My Case',
      callback_data: encodeCallback(CALLBACK.MENU, MENU_ACTION.CHECK_CASE),
    },
  ]);
  rows.push([CONTACT_SUPPORT_BUTTON]);
  rows.push([
    {
      text: '🚨 Urgent Case',
      callback_data: encodeCallback(CALLBACK.MENU, MENU_ACTION.URGENT_CASE),
    },
  ]);
  /**
   * Last, and below Urgent Case, on purpose (Q2, step 7).
   *
   * A teacher who does not know who to call is a teacher who is not in the
   * middle of anything, so this does not need to compete with the two buttons
   * that file work. Putting it above them would move traffic out of the system
   * that records it, which is R34's cost paid for nothing.
   */
  rows.push([
    {
      text: '👤 Who covers my region?',
      callback_data: encodeCallback(CALLBACK.MENU, MENU_ACTION.MY_MANAGER),
    },
  ]);
  return rows;
}

/** Every topic, for the teacher who wants the one that is not on the menu. */
export function faqHubKeyboard(): InlineKeyboard {
  const rows: InlineKeyboardRow[] = FAQ_TOPICS.map((t) => [
    topicButton(t.code, t.emoji, t.label),
  ]);
  rows.push([HOME_BUTTON]);
  return rows;
}

/**
 * The same topics, but each one answers a question the teacher has already
 * typed.
 *
 * Identical in appearance to the hub above and different in what it does: these
 * buttons carry `QT`, so the router scores the remembered question inside the
 * topic that is tapped instead of listing that topic's questions. It is what
 * turns "typed a question at the main menu" from a dead end into two taps.
 */
export function questionTopicKeyboard(): InlineKeyboard {
  const rows: InlineKeyboardRow[] = FAQ_TOPICS.map((t) => [
    {
      text: `${t.emoji} ${t.label}`,
      callback_data: encodeCallback(CALLBACK.QUERY_TOPIC, t.code),
    },
  ]);
  rows.push([CONTACT_SUPPORT_BUTTON]);
  rows.push([HOME_BUTTON]);
  return rows;
}

/** The five categories a case may be filed under. */
export function caseTopicKeyboard(): InlineKeyboard {
  const rows: InlineKeyboardRow[] = CASE_TOPIC_CHOICES.map((choice) => [
    {
      text: `${choice.emoji} ${choice.label}`,
      callback_data: encodeCallback(CALLBACK.CASE_TOPIC, choice.key),
    },
  ]);
  rows.push([HOME_BUTTON]);
  return rows;
}

export function backToMenuKeyboard(): InlineKeyboard {
  return [[HOME_BUTTON]];
}

/**
 * Two answers to "is the region we hold for you still right?" — D21.
 *
 * There is deliberately no third button and no list of regions. Region decides
 * which staff receive a teacher's emergency, so a picker is a menu of whose
 * problem this becomes, and a wrong tap sends an urgent case to the wrong
 * region. The teacher is the best source of the signal and the worst source of
 * the record: they report, and a manager makes the change with `/region`.
 *
 * No Main Menu button either, and that is not an oversight. This keyboard hangs
 * under a second message that arrives *beside* the menu, never instead of it —
 * the menu is already on screen with its own Home button, and repeating it would
 * suggest the question has to be dealt with before anything else can happen.
 */
export function regionCheckKeyboard(): InlineKeyboard {
  return [
    [{ text: '✅ Yes, still right', callback_data: encodeCallback(CALLBACK.REGION_CONFIRMED) }],
    [{ text: '📍 No, I have moved', callback_data: encodeCallback(CALLBACK.REGION_MOVED) }],
  ];
}

/**
 * One button under the re-consent notice — D32.
 *
 * **One button, and no "no thanks".** That is not a dark pattern: the teacher
 * can simply not tap it, and everything they could do without accepting — the
 * answer bank, `/privacy`, `/help`, `/start` — stays exactly where it was. A
 * decline button would have to *do* something, and the only thing it could do is
 * end their access, which is a decision for a person and not for a tap.
 *
 * The version and the periods travel in the payload so that a settings change
 * between this being sent and this being tapped shows the notice again rather
 * than recording an acceptance for text the teacher never saw (R20).
 */
export function privacyAcceptKeyboard(version: string, periodsField: string): InlineKeyboard {
  return [
    [
      {
        text: '✅ I have read this',
        callback_data: encodeCallback(CALLBACK.PRIVACY_ACCEPTED, version, periodsField),
      },
    ],
  ];
}

/**
 * Shown under an approved answer.
 *
 * Both halves of the feedback pair, then Back *and* Home. Only Home existed
 * before, so reading one answer dead-ended at the main menu and the teacher had
 * to navigate back into the topic to read the next one.
 */
export function answerKeyboard(code: string, topicCode: string): InlineKeyboard {
  const rows: InlineKeyboardRow[] = [
    [
      { text: '✅ That helped', callback_data: encodeCallback(CALLBACK.ANSWER_HELPFUL, code) },
      {
        text: '❌ Did not answer it',
        callback_data: encodeCallback(CALLBACK.ANSWER_UNHELPFUL, code),
      },
    ],
  ];
  const topic = faqTopicByCode(topicCode);
  if (topic !== null) {
    rows.push([
      {
        text: `⬅️ Back to ${topic.label}`,
        callback_data: encodeCallback(CALLBACK.TOPIC, topic.code),
      },
    ]);
  }
  rows.push([HOME_BUTTON]);
  return rows;
}

/**
 * One button per answer, skipping any whose payload will not fit.
 *
 * The throw stays the default everywhere else — an oversized payload is a
 * programming error. Here it is a content error, and hiding one button beats
 * failing the whole listing.
 */
function answerButtons(rows: readonly ButtonableFaqRow[]): KeyboardBuild {
  const keyboard: InlineKeyboardRow[] = [];
  const skipped: string[] = [];
  for (const row of rows) {
    try {
      keyboard.push([
        { text: row.buttonText, callback_data: encodeCallback(CALLBACK.ANSWER, row.code) },
      ]);
    } catch (err) {
      if (err instanceof CallbackDataTooLongError) {
        skipped.push(row.code);
        continue;
      }
      throw err;
    }
  }
  return { keyboard, skipped };
}

/** 1-based, clamped, so a hand-crafted PG:VISA:99 lands on a real page. */
function pageCountFor(total: number): number {
  return Math.max(1, Math.ceil(total / FAQ_PAGE_SIZE));
}

/**
 * One page of a topic's answers, with paging controls only when they are needed.
 *
 * `rows` arrives already ordered by the caller — by sheet row, so the listing
 * matches the order the content owner arranged, and the same page shows the same
 * answers between taps.
 */
export function topicListingKeyboard(
  rows: readonly ButtonableFaqRow[],
  topicCode: string,
  page: number,
): KeyboardBuild {
  const pageCount = pageCountFor(rows.length);
  const current = Math.min(Math.max(1, Math.trunc(page)), pageCount);
  const slice = rows.slice((current - 1) * FAQ_PAGE_SIZE, current * FAQ_PAGE_SIZE);

  const built = answerButtons(slice);
  const keyboard: InlineKeyboardRow[] = [...built.keyboard];

  if (pageCount > 1) {
    const controls: InlineButton[] = [];
    if (current > 1) {
      controls.push({
        text: '⬅️ Previous',
        callback_data: encodeCallback(CALLBACK.TOPIC_PAGE, topicCode, String(current - 1)),
      });
    }
    if (current < pageCount) {
      controls.push({
        text: 'Next ➡️',
        callback_data: encodeCallback(CALLBACK.TOPIC_PAGE, topicCode, String(current + 1)),
      });
    }
    keyboard.push(controls);
  }

  keyboard.push([CONTACT_SUPPORT_BUTTON]);
  keyboard.push([HOME_BUTTON]);
  return { keyboard, skipped: built.skipped };
}

/**
 * The disambiguation keyboard, offered instead of a guess.
 *
 * `lowConfidence` adds Contact Support: when the only evidence was a near-miss,
 * the most likely truth is that the answer bank does not cover the question, and
 * the teacher must not be cornered by a list of wrong choices.
 */
export function pickerKeyboard(
  rows: readonly ButtonableFaqRow[],
  topicCode: string,
  lowConfidence: boolean,
): KeyboardBuild {
  const built = answerButtons(rows);
  const keyboard: InlineKeyboardRow[] = [...built.keyboard];

  if (lowConfidence) keyboard.push([CONTACT_SUPPORT_BUTTON]);

  const topic = faqTopicByCode(topicCode);
  if (topic !== null) {
    keyboard.push([
      {
        text: `⬅️ Back to ${topic.label}`,
        callback_data: encodeCallback(CALLBACK.TOPIC, topic.code),
      },
    ]);
  }
  keyboard.push([HOME_BUTTON]);
  return { keyboard, skipped: built.skipped };
}
