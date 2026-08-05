/**
 * Browsing the answer bank, and asking it a question.
 *
 * Every path that cannot find what it was asked for falls back to a menu rather
 * than throwing. Callback data arrives from the network and can be hand-crafted
 * or simply stale, so "no such topic" is an ordinary input here, not an error —
 * and a throw would reach `bot.catch`, which acknowledges the update and says
 * nothing, leaving the teacher with silence.
 */
import { FAQ_PAGE_SIZE, faqTopicByCode } from '../../config/constants.js';
import type { Database } from '../../db/index.js';
import { answersForScoring, findAnswer, listTopicAnswers } from '../../faq/repository.js';
import { selectAnswer } from '../../faq/scoring.js';
import {
  answerKeyboard,
  faqHubKeyboard,
  mainMenuKeyboard,
  pickerKeyboard,
  questionTopicKeyboard,
  topicListingKeyboard,
  type MenuAccess,
} from '../keyboards.js';
import type { Reply } from '../reply.js';

const MAIN_MENU_PROMPT = 'What would you like to do?';

/** Every topic, for the teacher who wants one that is not on the main menu. */
export function faqHubReply(): Reply {
  return { text: 'Choose a topic:', keyboard: faqHubKeyboard() };
}

/**
 * `access` is threaded through this module for one reason — Part 5F.
 *
 * Two paths in here land a teacher on the **main menu**: a topic button whose
 * topic no longer exists, and an answer withdrawn since the button was drawn.
 * Both are ordinary rather than exceptional, and both are reached by chats that
 * have never signed in, because browsing the answer bank is open to everybody.
 *
 * Drawing the full menu there would undo the part: a stranger who taps a stale
 * FAQ button would be handed Contact Support and Ask for Priority, which then
 * stop and ask for an email address. The rule is that **the main menu is never
 * drawn without knowing who is looking at it**, and it holds here too.
 */
function unknownTopicReply(access: MenuAccess): Reply {
  // Not an error. A stale button from a previous version of the taxonomy looks
  // exactly like this, and the teacher should land somewhere useful.
  return { text: MAIN_MENU_PROMPT, keyboard: mainMenuKeyboard(access) };
}

/** One page of a topic's questions. */
export async function topicListingReply(
  db: Database,
  topicCode: string,
  access: MenuAccess,
  page = 1,
): Promise<Reply> {
  const topic = faqTopicByCode(topicCode);
  if (topic === null) return unknownTopicReply(access);

  const rows = await listTopicAnswers(db, topic.code);
  if (rows.length === 0) {
    return {
      text:
        `${topic.emoji} ${topic.label}\n\n` +
        'There are no answers under this topic yet. ' +
        'Contact Support and a person will help.',
      keyboard: topicListingKeyboard([], topic.code, 1).keyboard,
    };
  }

  const built = topicListingKeyboard(rows, topic.code, page);
  const pageCount = Math.max(1, Math.ceil(rows.length / FAQ_PAGE_SIZE));
  const heading =
    pageCount > 1
      ? `${topic.emoji} ${topic.label} (page ${Math.min(Math.max(1, page), pageCount)} of ${pageCount})`
      : `${topic.emoji} ${topic.label}`;

  return {
    text: `${heading}\n\nPick a question, or type your own:`,
    keyboard: built.keyboard,
    skipped: built.skipped,
  };
}

/** One approved answer. */
export async function answerReply(
  db: Database,
  code: string,
  access: MenuAccess,
): Promise<Reply> {
  const answer = await findAnswer(db, code);
  if (answer === null) {
    /**
     * Either the code is nonsense, or the answer has been withdrawn since the
     * button was drawn. Both are ordinary: the sync deactivates rather than
     * deletes, and a teacher's scrollback keeps old buttons forever. Say so
     * plainly instead of pretending the button did nothing.
     */
    return {
      text:
        'That answer is no longer available. It may have been updated or withdrawn.\n\n' +
        'Please pick another question, or contact support.',
      keyboard: mainMenuKeyboard(access),
    };
  }

  return {
    text: `${answer.buttonText}\n\n${answer.officialAnswer}`,
    keyboard: answerKeyboard(answer.code, answer.topicCode),
  };
}

/**
 * A question typed against one topic.
 *
 * The scorer decides between answering and offering a choice; this only turns
 * that decision into something to send. "The bot must never guess" is enforced
 * in `faq/scoring.ts`, not here.
 */
export async function questionReply(
  db: Database,
  topicCode: string,
  query: string,
  access: MenuAccess,
): Promise<Reply> {
  const topic = faqTopicByCode(topicCode);
  if (topic === null) return unknownTopicReply(access);

  const rows = await answersForScoring(db, topic.code);
  const match = selectAnswer(query, rows);

  if (match.kind === 'answer') {
    return {
      text: `${match.row.buttonText}\n\n${match.row.officialAnswer}`,
      keyboard: answerKeyboard(match.row.code, topic.code),
    };
  }

  if (match.kind === 'picker') {
    const built = pickerKeyboard(match.rows, topic.code, match.lowConfidence);
    return {
      text: match.lowConfidence
        ? 'I am not certain I understood that. Did you mean one of these?'
        : 'I found a few things that might match. Pick the closest one:',
      keyboard: built.keyboard,
      skipped: built.skipped,
    };
  }

  /**
   * A clean miss. The teacher gets the topic's questions and a route to a
   * person, never a least-bad answer. This is also the most valuable content
   * signal there is, and the router logs it as one.
   */
  const built = topicListingKeyboard(rows, topic.code, 1);
  return {
    text:
      'I could not match that to an answer. ' +
      'Did you mean one of these, or tap Contact Support to reach a person:',
    keyboard: built.keyboard,
    skipped: built.skipped,
  };
}

/**
 * A question typed before any topic was chosen — the most natural thing a
 * teacher can do, and the one the answer bank cannot be searched for directly.
 *
 * Matching is scoped to one topic on purpose (`BOT-SPEC.md:9.0`): precision over
 * recall, so a visa question is never answered out of the accommodation bank.
 * The cost of that scoping used to be a dead end — typing a question outside a
 * topic searched nothing and said so. The question is remembered instead, and
 * one tap answers it, so the teacher types once.
 */
export function questionWithoutTopicReply(): Reply {
  return {
    text:
      'I can look that up. Which of these is it about?\n\n' +
      'Tap a topic and I will answer the question you just asked, or tap ' +
      'Contact Support to reach a person.',
    keyboard: questionTopicKeyboard(),
  };
}
