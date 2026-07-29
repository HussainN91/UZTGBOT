/**
 * Deciding what to do with one inbound update.
 *
 * The order here is the design, not an implementation detail, and each step is
 * ordered against a specific way the Apps Script version went wrong:
 *
 *   1. Claim the update, or stop.        Telegram resends anything it thinks
 *                                        failed; a replay must not file a second
 *                                        case or spend a second urgent code.
 *   2. Take the chat's lock.             One lock, in one place. Case dedup and
 *                                        conversation state both need
 *                                        serialising for the same chat, and two
 *                                        locks taken in different orders on
 *                                        different paths is the deadlock recipe.
 *   3. Read the conversation state ONCE. `loggableMessageText_`
 *                                        (`Webhook.gs:149`) read it again to
 *                                        choose a redaction. The same read must
 *                                        serve both, and it must happen before a
 *                                        handler mutates it — otherwise a
 *                                        teacher's email is logged verbatim
 *                                        because sign-in already finished.
 *   4. Log the interaction.              Using that state, so redaction cannot be
 *                                        skipped.
 *   5. Dispatch.
 *
 * Steps 2 to 5 are one transaction. Nothing here sends anything: this function
 * *decides*, and returns what should be said. The caller commits first and
 * speaks afterwards — see `deliver` in `bot.ts`. A failed send after a good
 * commit is recoverable, because the case exists and Check My Case will show it.
 * A failed commit after a confirmation message is not.
 */
import {
  CASE_TOPIC_CHOICES,
  MAX_CASE_DETAIL_ATTEMPTS,
  caseTopicByKey,
} from '../config/constants.js';
import { isMaintenanceMode } from '../config/settings.js';
import { fileUrgentCase, checkUrgentCode } from '../cases/urgent.js';
import { TeacherNotVerifiedError, createCase } from '../cases/service.js';
import { clearState, loadState, saveState, type ConversationState } from '../conversation/state.js';
import type { Database } from '../db/index.js';
import { logInteraction } from '../log/interactions.js';
import { findTeacher, teacherHasAccess } from '../teachers/repository.js';
import { verifyIdentifier } from '../teachers/verify.js';
import type { Alert } from '../sync/alerts.js';
import { CALLBACK, decodeCallback } from './callback-data.js';
import {
  answerReply,
  faqHubReply,
  questionReply,
  questionWithoutTopicReply,
  topicListingReply,
} from './handlers/faq.js';
import {
  caseDeduplicatedReply,
  caseDetailPromptReply,
  caseFiledReply,
  caseTopicPromptReply,
  caseCategoryLabel,
  checkMyCaseReply,
} from './handlers/cases.js';
import { helpReply, mainMenuReply, privacyReply, signInPromptReply } from './handlers/menu.js';
import {
  urgentCaseEscalatedReply,
  urgentCaseFiledReply,
  urgentCaseNotEscalatedReply,
  urgentCodeAcceptedReply,
  urgentCodeLockedOutReply,
  urgentCodePromptReply,
  urgentCodeRejectedReply,
  urgentUnavailableReply,
} from './handlers/urgent.js';
import { MENU_ACTION, backToMenuKeyboard, mainMenuKeyboard } from './keyboards.js';
import type { Reply } from './reply.js';

/** One update, reduced to the only things routing depends on. */
export interface InboundUpdate {
  readonly chatId: string;
  readonly kind: 'text' | 'callback';
  /** The message text, or the button's callback payload. */
  readonly text: string;
}

export interface OutgoingMessage {
  readonly chatId: string;
  readonly text: string;
  readonly keyboard?: Reply['keyboard'];
}

/**
 * What the router decided.
 *
 * Messages and alerts are returned rather than sent so that every one of them
 * happens after the transaction commits. `messages[0]` is the answer to the
 * teacher who wrote in; anything after it goes to somebody else — today only the
 * prior holder of a duplicated identity.
 */
export interface RouterOutcome {
  readonly messages: readonly OutgoingMessage[];
  readonly alerts: readonly Alert[];
}

export interface RouterDeps {
  /** Checked at start-up; the bot refuses to run with a placeholder. */
  readonly supportContact: string;
}

/**
 * Decide everything for one update, inside the caller's transaction.
 *
 * `db` is the transaction, not the pool: every read and write below is part of
 * the same unit as the chat lock the caller took.
 */
export async function route(
  db: Database,
  update: InboundUpdate,
  deps: RouterDeps,
): Promise<RouterOutcome> {
  // Step 3. Read once, pass down. Nothing below re-reads it.
  const state = await loadState(db, update.chatId);

  // Step 4. Before anything mutates the state, or the redaction that depends on
  // it stops applying and an address is written out in full.
  await logInteraction(db, update.chatId, actionFor(update, state), update.text, state);

  // Step 5.
  return update.kind === 'callback'
    ? routeCallback(db, update, state, deps)
    : routeText(db, update, state, deps);
}

/**
 * The label this interaction is filed under.
 *
 * Names the *state*, not the content, so the log stays readable when the text is
 * redacted to nothing — "AWAITING_IDENTIFIER" plus a masked address is legible;
 * "MESSAGE" plus a masked address is not.
 */
function actionFor(update: InboundUpdate, state: ConversationState | null): string {
  if (update.kind === 'callback') return 'CALLBACK';
  if (state !== null) return state.kind.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
  return 'MESSAGE';
}

function only(chatId: string, reply: Reply): RouterOutcome {
  return {
    messages: [{ chatId, text: reply.text, keyboard: reply.keyboard }],
    alerts: skippedAlert(reply),
  };
}

/**
 * An answer left out of a keyboard is an answer no teacher can reach.
 *
 * The keyboard builders report it rather than alerting, because they are pure —
 * this is the one place that turns the report into something a person sees.
 */
function skippedAlert(reply: Reply): readonly Alert[] {
  if (reply.skipped === undefined || reply.skipped.length === 0) return [];
  return [
    {
      severity: 'warning',
      title: 'An FAQ answer could not be shown as a button',
      body: [
        'These answer codes are too long to fit in a Telegram button, so teachers',
        'cannot reach them. Shorten the CODE cell in the FAQ sheet:',
        '',
        ...reply.skipped,
      ].join('\n'),
    },
  ];
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

async function routeText(
  db: Database,
  update: InboundUpdate,
  state: ConversationState | null,
  deps: RouterDeps,
): Promise<RouterOutcome> {
  const text = update.text.trim();

  /**
   * Commands are matched before anything else, which is the point of them.
   *
   * A teacher part-way through describing a case who types `/help` must get
   * help, not have "/help" filed as their problem — and `/privacy` has to work
   * from anywhere, including from inside sign-in, because it is what the sign-in
   * prompt tells them they can read.
   */
  if (text === '/start') {
    await clearState(db, update.chatId);
    return only(update.chatId, await startReply(db, update.chatId, deps));
  }
  if (text === '/privacy') return only(update.chatId, privacyReply(deps.supportContact));
  if (text === '/help') return only(update.chatId, helpReply(deps.supportContact));

  switch (state?.kind) {
    case 'AwaitingIdentifier':
      return handleIdentifier(db, update.chatId, text, state, deps);
    case 'AwaitingCaseDetail':
      return handleCaseDetail(db, update.chatId, text, state, deps);
    case 'AwaitingUrgentCode':
      return handleUrgentCode(db, update.chatId, text, deps);
    case 'AwaitingUrgentDetail':
      return handleUrgentDetail(db, update.chatId, text, state, deps);
    case 'AwaitingCaseTopic':
      // They typed instead of tapping. Ask again rather than guessing which
      // category they meant — routing to the wrong queue is worse than a re-tap.
      return only(update.chatId, caseTopicPromptReply());
    case 'AwaitingQuestionTopic':
      // Asked again rather than tapping a topic. The newer question replaces
      // the older one, which is handled by the free-text path below.
      break;
    default:
      break;
  }

  if (text === '') {
    // A photo, a sticker, a voice note. Stage 6 gives documents a home; until
    // then, say what the bot can do rather than ignoring them.
    return only(update.chatId, {
      text: 'I can only read text messages at the moment.',
      keyboard: mainMenuKeyboard(),
    });
  }

  /**
   * Free text with no conversation open: a question.
   *
   * It is not searched immediately, because matching is scoped to one topic
   * (`BOT-SPEC.md:9.0`) — precision over recall, so a visa question is never
   * answered out of the accommodation bank. The question is remembered and the
   * teacher picks the topic, which costs one tap and never costs a retype.
   *
   * Deliberately available before sign-in. The FAQ is public information, and
   * making a teacher identify themselves to read it would collect more data, not
   * less — but it is also why messages exist for chats that have never seen the
   * privacy notice, which is written down as an open item rather than hidden.
   */
  await saveState(db, update.chatId, { kind: 'AwaitingQuestionTopic', query: text });
  return only(update.chatId, questionWithoutTopicReply());
}

/** `/start`: the menu for a teacher we know, the notice and prompt for one we do not. */
async function startReply(db: Database, chatId: string, deps: RouterDeps): Promise<Reply> {
  const teacher = await findTeacher(db, chatId);
  if (teacher?.verificationState === 'Verified') return mainMenuReply();
  await saveState(db, chatId, { kind: 'AwaitingIdentifier', attempts: 0 });
  return signInPromptReply(deps.supportContact);
}

async function handleIdentifier(
  db: Database,
  chatId: string,
  text: string,
  state: Extract<ConversationState, { kind: 'AwaitingIdentifier' }>,
  deps: RouterDeps,
): Promise<RouterOutcome> {
  const outcome = await verifyIdentifier(db, chatId, text, state.attempts);

  if (outcome.kind === 'lockedOut') {
    return only(chatId, {
      text:
        'Too many attempts. Please wait a little and tap Main Menu to start again.\n\n' +
        `If you cannot sign in, contact ${deps.supportContact}.`,
      keyboard: backToMenuKeyboard(),
    });
  }

  if (outcome.kind === 'refused') {
    await saveState(db, chatId, {
      kind: 'AwaitingIdentifier',
      attempts: outcome.attempts,
      ...(state.resumeAction !== undefined ? { resumeAction: state.resumeAction } : {}),
    });
    return only(chatId, {
      text:
        'I could not find that address on the teacher roster.\n\n' +
        'Please check it is the address you were recruited with, including any dots. ' +
        (outcome.attemptsRemaining > 0
          ? `You can try ${outcome.attemptsRemaining} more time${outcome.attemptsRemaining === 1 ? '' : 's'}.`
          : 'That was your last attempt for now.') +
        `\n\nIf it should be there, contact ${deps.supportContact}.`,
    });
  }

  await clearState(db, chatId);

  /**
   * D1: a second account presenting an identity that is already bound is
   * allowed, and reported. The alarm and the notice are returned rather than
   * sent, because `verifyIdentifier` runs inside this transaction and announcing
   * a binding that can still roll back is worse than announcing it a moment
   * later.
   */
  const messages: OutgoingMessage[] = [];
  const alerts: Alert[] = [];

  const resumed = await resumeAfterSignIn(db, chatId, state.resumeAction, deps);
  messages.push({
    chatId,
    text: `✅ Signed in as ${outcome.name}.\n\n${resumed.text}`,
    ...(resumed.keyboard !== undefined ? { keyboard: resumed.keyboard } : {}),
  });

  for (const holder of outcome.priorHolders) {
    messages.push({
      chatId: holder,
      text:
        '⚠️ Security notice\n\n' +
        'Your teacher identity has just been used to sign in from another Telegram ' +
        'account. If that was you — a new phone, for instance — nothing is wrong and ' +
        'you can ignore this.\n\n' +
        `If it was not you, contact ${deps.supportContact} now.`,
    });
  }

  if (outcome.priorHolders.length > 0) {
    alerts.push({
      severity: 'warning',
      title: 'A teacher identity is now held by more than one chat',
      body: [
        `Identifier: ${outcome.identifier}`,
        `New chat: ${chatId}`,
        `Previously held by: ${outcome.priorHolders.join(', ')}`,
        '',
        'This is allowed by design — blocking it would lock out any teacher who',
        'changes phone. It is reported because the innocent explanation and the',
        'impersonation look identical from here, and only a person can tell them',
        'apart. Telephone the teacher.',
      ].join('\n'),
    });
  }

  return { messages, alerts };
}

/**
 * Pick up whatever the teacher was trying to do before being asked to sign in.
 *
 * Without this a teacher who taps Contact Support, signs in, and is then shown
 * the main menu has to find the button again — and the commonest moment to be
 * asked to sign in is the moment you wanted something.
 */
async function resumeAfterSignIn(
  db: Database,
  chatId: string,
  resumeAction: string | undefined,
  deps: RouterDeps,
): Promise<Reply> {
  if (resumeAction === MENU_ACTION.CONTACT_SUPPORT) {
    return startCase(db, chatId, deps);
  }
  if (resumeAction === MENU_ACTION.URGENT_CASE) {
    return startUrgent(db, chatId, deps);
  }
  if (resumeAction === MENU_ACTION.CHECK_CASE) {
    return checkMyCaseReply(db, chatId);
  }
  return mainMenuReply();
}

async function handleCaseDetail(
  db: Database,
  chatId: string,
  text: string,
  state: Extract<ConversationState, { kind: 'AwaitingCaseDetail' }>,
  deps: RouterDeps,
): Promise<RouterOutcome> {
  if (text === '') return retryCaseDetail(db, chatId, state, deps, 'I did not get any text.');

  try {
    const result = await createCase(db, {
      chatId,
      category: state.category,
      detail: text,
    });
    await clearState(db, chatId);
    return only(
      chatId,
      result.isNew ? caseFiledReply(result.reference) : caseDeduplicatedReply(result.reference),
    );
  } catch (err) {
    if (err instanceof TeacherNotVerifiedError) {
      /**
       * Verified when they started, not verified now — revoked mid-conversation,
       * which is rare and entirely legitimate. Their words are not filed, and
       * they are told why rather than being left with silence.
       */
      await clearState(db, chatId);
      return only(chatId, {
        text:
          'I could not open a case because this account is no longer signed in.\n\n' +
          `Tap Main Menu to sign in again, or contact ${deps.supportContact}.`,
        keyboard: backToMenuKeyboard(),
      });
    }
    throw err;
  }
}

/**
 * Keep the teacher in the detail prompt, up to a limit.
 *
 * `MenuHandler.gs:43` records why the limit exists: a retry that can never
 * succeed must end in a clear message rather than looping silently until the
 * state expires.
 */
async function retryCaseDetail(
  db: Database,
  chatId: string,
  state: Extract<ConversationState, { kind: 'AwaitingCaseDetail' }>,
  deps: RouterDeps,
  because: string,
): Promise<RouterOutcome> {
  const attempts = state.attempts + 1;
  if (attempts >= MAX_CASE_DETAIL_ATTEMPTS) {
    await clearState(db, chatId);
    return only(chatId, {
      text: `${because}\n\nLet us start again — tap Main Menu. ` +
        `If this keeps happening, contact ${deps.supportContact}.`,
      keyboard: backToMenuKeyboard(),
    });
  }

  await saveState(db, chatId, { ...state, attempts });
  return only(chatId, {
    text: `${because} Please describe the problem in one text message.`,
  });
}

async function handleUrgentCode(
  db: Database,
  chatId: string,
  text: string,
  deps: RouterDeps,
): Promise<RouterOutcome> {
  const outcome = await checkUrgentCode(db, chatId, text);

  if (outcome.kind === 'lockedOut') {
    await clearState(db, chatId);
    return only(chatId, urgentCodeLockedOutReply(deps.supportContact));
  }

  if (outcome.kind === 'rejected') {
    // The attempt count lives in the database, not this state, so clearing the
    // state by tapping Main Menu cannot reset it. The state's own counter is
    // left alone deliberately.
    await saveState(db, chatId, { kind: 'AwaitingUrgentCode', attempts: 0 });
    return only(
      chatId,
      urgentCodeRejectedReply(outcome.attemptsRemaining, deps.supportContact),
    );
  }

  await saveState(db, chatId, {
    kind: 'AwaitingUrgentDetail',
    codeAccepted: outcome.code,
    attempts: 0,
  });
  return only(chatId, urgentCodeAcceptedReply());
}

async function handleUrgentDetail(
  db: Database,
  chatId: string,
  text: string,
  state: Extract<ConversationState, { kind: 'AwaitingUrgentDetail' }>,
  deps: RouterDeps,
): Promise<RouterOutcome> {
  if (text === '') {
    return only(chatId, {
      text:
        'I did not get any text. Please describe the emergency in one message — ' +
        'your code is still valid until you do.',
    });
  }

  try {
    const result = await fileUrgentCase(db, {
      chatId,
      code: state.codeAccepted,
      detail: text,
    });
    await clearState(db, chatId);

    if (!result.escalated) {
      /**
       * The code was good when they typed it and is not good now. The case is
       * filed anyway — see `fileUrgentCase` — and this is alerted because the
       * only two explanations are an expiry straddle or two chats holding the
       * same code, and both want a person.
       */
      return {
        messages: [
          {
            chatId,
            text: urgentCaseNotEscalatedReply(result.reference, deps.supportContact).text,
            keyboard: backToMenuKeyboard(),
          },
        ],
        alerts: [
          {
            severity: 'critical',
            title: 'An urgent code was accepted and then would not spend',
            body: [
              `Chat: ${chatId}`,
              `Case: ${result.reference} — filed, but NOT escalated.`,
              '',
              'The code passed its check when the teacher typed it and failed when',
              'their case was filed. Either it expired in between, or another chat',
              'spent it. Telephone the teacher; their case is not marked urgent.',
            ].join('\n'),
          },
        ],
      };
    }

    return only(
      chatId,
      result.isNew
        ? urgentCaseFiledReply(result.reference, deps.supportContact)
        : urgentCaseEscalatedReply(result.reference, deps.supportContact),
    );
  } catch (err) {
    if (err instanceof TeacherNotVerifiedError) {
      await clearState(db, chatId);
      return only(chatId, {
        text:
          'I could not open a case because this account is no longer signed in.\n\n' +
          `This is urgent — contact ${deps.supportContact} now.`,
        keyboard: backToMenuKeyboard(),
      });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

async function routeCallback(
  db: Database,
  update: InboundUpdate,
  state: ConversationState | null,
  deps: RouterDeps,
): Promise<RouterOutcome> {
  const decoded = decodeCallback(update.text);
  /**
   * Nothing below trusts the payload. It arrives from the network, so it can be
   * hand-crafted; and a teacher's scrollback keeps every button they were ever
   * sent, so it can simply be from a build that no longer exists. Both land on
   * the main menu rather than an error.
   */
  if (decoded === null) return only(update.chatId, mainMenuReply());

  const [first = '', second = ''] = decoded.parts;

  switch (decoded.prefix) {
    case CALLBACK.MENU:
      return routeMenu(db, update.chatId, first, deps);

    case CALLBACK.TOPIC:
      return only(update.chatId, await topicListingReply(db, first));

    case CALLBACK.TOPIC_PAGE: {
      const page = Number.parseInt(second, 10);
      return only(
        update.chatId,
        await topicListingReply(db, first, Number.isFinite(page) ? page : 1),
      );
    }

    case CALLBACK.QUERY_TOPIC: {
      /**
       * The topic for a question already typed. If the state has expired — the
       * teacher left this button sitting for half an hour — there is nothing to
       * answer, so they get the topic's questions instead of a shrug.
       */
      if (state?.kind !== 'AwaitingQuestionTopic') {
        return only(update.chatId, await topicListingReply(db, first));
      }
      await clearState(db, update.chatId);
      return only(update.chatId, await questionReply(db, first, state.query));
    }

    case CALLBACK.ANSWER:
      return only(update.chatId, await answerReply(db, first));

    case CALLBACK.ANSWER_HELPFUL:
    case CALLBACK.ANSWER_UNHELPFUL:
      return recordFeedback(db, update.chatId, decoded.prefix, first, state);

    case CALLBACK.CASE_TOPIC:
      return chooseCaseTopic(db, update.chatId, first, deps);

    default:
      return only(update.chatId, mainMenuReply());
  }
}

async function routeMenu(
  db: Database,
  chatId: string,
  action: string,
  deps: RouterDeps,
): Promise<RouterOutcome> {
  switch (action) {
    case MENU_ACTION.MAIN:
      await clearState(db, chatId);
      return only(chatId, mainMenuReply());

    case MENU_ACTION.FAQ:
      return only(chatId, faqHubReply());

    case MENU_ACTION.CHECK_CASE:
      return (await requireSignIn(db, chatId, MENU_ACTION.CHECK_CASE, deps))
        ?? only(chatId, await checkMyCaseReply(db, chatId));

    case MENU_ACTION.CONTACT_SUPPORT:
      return (await requireSignIn(db, chatId, MENU_ACTION.CONTACT_SUPPORT, deps))
        ?? only(chatId, await startCase(db, chatId, deps));

    case MENU_ACTION.URGENT_CASE:
      return (await requireSignIn(db, chatId, MENU_ACTION.URGENT_CASE, deps))
        ?? only(chatId, await startUrgent(db, chatId, deps));

    default:
      return only(chatId, mainMenuReply());
  }
}

/**
 * Ask an unverified chat to sign in, remembering what they wanted.
 *
 * Returns null when they are already verified, so the caller can simply carry
 * on. The FAQ never calls this: browsing is open, which is deliberate and is
 * also the reason messages exist for chats that have not seen the notice.
 */
async function requireSignIn(
  db: Database,
  chatId: string,
  resumeAction: string,
  deps: RouterDeps,
): Promise<RouterOutcome | null> {
  const teacher = await findTeacher(db, chatId);
  if (teacherHasAccess(teacher)) return null;

  /**
   * Access that has been taken away is not re-offered as a sign-in prompt.
   *
   * Two different reasons a verified teacher can fail the gate — a staff member
   * ran `/revoke`, or their roster row was deactivated or removed — and neither
   * is fixed by typing an email address again. Prompting would send them round a
   * loop that `verifyIdentifier` refuses at the end, telling them nothing about
   * why. It would also let somebody undo a deliberate revocation simply by
   * signing in again, on the one path where `bindTeacher` clears `revoked_at`.
   */
  const hadAccess =
    teacher !== null &&
    (teacher.verificationState === 'Revoked' || teacher.verificationState === 'Verified');
  if (hadAccess) {
    return only(chatId, {
      text:
        'Your access to this bot has ended, so new cases cannot be opened from this chat.\n\n' +
        `If you think this is a mistake, contact ${deps.supportContact}.`,
      keyboard: backToMenuKeyboard(),
    });
  }

  await saveState(db, chatId, { kind: 'AwaitingIdentifier', attempts: 0, resumeAction });
  return only(chatId, signInPromptReply(deps.supportContact));
}

/**
 * Maintenance mode stops new cases and nothing else.
 *
 * A teacher looking up an answer or checking a case they already have is not
 * creating work for anyone, and turning the whole bot off would tell them
 * nothing at all (`BOT-SPEC.md:172`).
 */
async function startCase(db: Database, chatId: string, deps: RouterDeps): Promise<Reply> {
  if (await isMaintenanceMode(db)) {
    return {
      text:
        'New cases are paused while the support team deals with something.\n\n' +
        'The FAQ and Check My Case still work. ' +
        `If this cannot wait, contact ${deps.supportContact}.`,
      keyboard: backToMenuKeyboard(),
    };
  }
  await saveState(db, chatId, { kind: 'AwaitingCaseTopic' });
  return caseTopicPromptReply();
}

async function startUrgent(db: Database, chatId: string, deps: RouterDeps): Promise<Reply> {
  if (await isMaintenanceMode(db)) {
    return urgentUnavailableReply(deps.supportContact);
  }
  await saveState(db, chatId, { kind: 'AwaitingUrgentCode', attempts: 0 });
  return urgentCodePromptReply();
}

async function chooseCaseTopic(
  db: Database,
  chatId: string,
  key: string,
  deps: RouterDeps,
): Promise<RouterOutcome> {
  const choice = caseTopicByKey(key);
  if (choice === null) return only(chatId, caseTopicPromptReply());

  const gate = await requireSignIn(db, chatId, MENU_ACTION.CONTACT_SUPPORT, deps);
  if (gate !== null) return gate;

  if (await isMaintenanceMode(db)) {
    // Checked again here, not only at the start: maintenance mode can be turned
    // on between choosing a topic and describing the problem, and the cheap
    // moment to stop is before the teacher has typed it all out.
    return only(chatId, {
      text:
        'New cases have just been paused while the support team deals with something.\n\n' +
        `Please try again shortly, or contact ${deps.supportContact}.`,
      keyboard: backToMenuKeyboard(),
    });
  }

  await saveState(db, chatId, {
    kind: 'AwaitingCaseDetail',
    category: choice.category,
    attempts: 0,
  });
  return only(chatId, caseDetailPromptReply(caseCategoryLabel(key)));
}

/**
 * Both halves of the answer feedback pair.
 *
 * Recorded in the interaction log rather than a table of its own, because what
 * makes it useful is being readable next to the question that led to it. Only
 * the ❌ half existed before, which meant the answer bank could learn what was
 * failing but never what was working.
 */
async function recordFeedback(
  db: Database,
  chatId: string,
  prefix: string,
  code: string,
  state: ConversationState | null,
): Promise<RouterOutcome> {
  const helpful = prefix === CALLBACK.ANSWER_HELPFUL;
  await logInteraction(
    db,
    chatId,
    helpful ? 'ANSWER_HELPFUL' : 'ANSWER_UNHELPFUL',
    code,
    state,
  );

  return only(chatId, {
    text: helpful
      ? 'Thank you — that helps us keep the answers useful.'
      : 'Thank you for saying so. Someone reviews these.\n\n' +
        'If you still need help, tap Contact Support and a person will take it on.',
    keyboard: mainMenuKeyboard(),
  });
}

/** Exported for the suite: the five filing choices, so a test cannot drift from the menu. */
export const CASE_TOPIC_KEYS = CASE_TOPIC_CHOICES.map((c) => c.key);
