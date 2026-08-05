/**
 * Opening a case, and looking at your own.
 *
 * The rule that shapes this file: a teacher never sees the words they typed
 * read back to them. `detail` goes into the case record and is read only through
 * staff commands that check permissions first — Check My Case shows the
 * reference, the category, the status and whatever a staff member deliberately
 * wrote as a public update.
 */
import { CASE_TOPIC_CHOICES, CHECK_MY_CASE_CAP, TIMEZONE } from '../../config/constants.js';
import type { Database } from '../../db/index.js';
import { countCasesForChatId, getCasesForChatId } from '../../cases/service.js';
import { backToMenuKeyboard, caseTopicKeyboard } from '../keyboards.js';
import type { Reply } from '../reply.js';

/** Ask which category the case belongs to. */
export function caseTopicPromptReply(): Reply {
  return {
    text:
      'What is this about?\n\n' +
      'Choosing the right area means your case reaches the people who handle it.',
    keyboard: caseTopicKeyboard(),
  };
}

/** Ask for the description, once a category is chosen. */
export function caseDetailPromptReply(categoryLabel: string): Reply {
  return {
    text:
      `${categoryLabel}\n\n` +
      'Please describe the problem in one message. Include anything that would ' +
      'help someone act on it: dates, names of documents, what you have already tried.',
  };
}

/** Confirm a newly opened case. */
export function caseFiledReply(reference: string): Reply {
  return {
    text:
      '✅ Your case has been opened.\n\n' +
      `Reference: ${reference}\n\n` +
      'Keep this reference: you can quote it to anyone helping you. ' +
      'Check My Case shows progress.',
    keyboard: backToMenuKeyboard(),
  };
}

/**
 * Confirm that an existing case was reused rather than a second one opened.
 *
 * Said plainly rather than silently returning the old reference: a teacher who
 * taps twice and sees "opened" twice will reasonably believe there are two
 * cases, and will chase both.
 *
 * **It no longer says "your message has not been lost", because it is.** On this
 * path `createCase` returns the existing reference before writing anything, so
 * the words the teacher just typed are discarded. The claim was written when the
 * worry was a teacher believing the tap did nothing, and it answered that worry
 * with something untrue. Whether the text should instead be appended, the way
 * the priority path appends it, is a behaviour question and not one a wording
 * pass gets to decide.
 */
export function caseDeduplicatedReply(reference: string): Reply {
  return {
    text:
      'You already have an open case about this.\n\n' +
      `Reference: ${reference}\n\n` +
      'Rather than opening a second case, please reply to whoever contacts you ' +
      'about this one.',
    keyboard: backToMenuKeyboard(),
  };
}

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(value);
}

/**
 * Check My Case.
 *
 * Never includes `detail` — the type returned by `getCasesForChatId` does not
 * carry it, so this cannot echo it back even by accident.
 */
export async function checkMyCaseReply(db: Database, chatId: string): Promise<Reply> {
  const [visible, total] = await Promise.all([
    getCasesForChatId(db, chatId, CHECK_MY_CASE_CAP),
    countCasesForChatId(db, chatId),
  ]);

  if (visible.length === 0) {
    return {
      text: 'You have not opened any cases yet.',
      keyboard: backToMenuKeyboard(),
    };
  }

  const lines = visible.map((c) => {
    const update = c.publicUpdate.trim();
    return (
      `${c.reference}\n` +
      `${c.category} · ${c.status} · opened ${formatDate(c.createdAt)}` +
      (update === '' ? '' : `\n💬 ${update}`)
    );
  });

  const text = `Your cases:\n\n${lines.join('\n\n')}`;
  return {
    text:
      total > visible.length
        ? `${text}\n\n(Showing your ${visible.length} most recent of ${total}.)`
        : text,
    keyboard: backToMenuKeyboard(),
  };
}

/** The display label for a filing choice, for the detail prompt. */
export function caseCategoryLabel(key: string): string {
  return CASE_TOPIC_CHOICES.find((c) => c.key === key)?.label ?? 'Support';
}
