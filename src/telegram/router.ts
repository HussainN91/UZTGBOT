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
  REGION_CONFIRM_AFTER_DAYS,
  URGENT_CASE_CATEGORY,
  caseTopicByKey,
} from '../config/constants.js';
import { PRIVACY_NOTICE_VERSION } from '../config/privacy.js';
import { parsePeriodsField, renderPeriodsField, requiresReconsent } from '../config/retention.js';
import { isMaintenanceMode, retentionPeriods } from '../config/settings.js';
import { fileUrgentCase, checkUrgentCode } from '../cases/urgent.js';
import { TeacherNotVerifiedError, createCase } from '../cases/service.js';
import { NO_NOTIFICATION, notifyNewCase, type NotificationOutcome } from '../cases/notify.js';
import { clearState, loadState, saveState, type ConversationState } from '../conversation/state.js';
import type { Database } from '../db/index.js';
import { logInteraction } from '../log/interactions.js';
import { privacyAcceptance, recordAcceptance } from '../teachers/privacy.js';
import { findTeacher, teacherHasAccess } from '../teachers/repository.js';
import { verifyIdentifier } from '../teachers/verify.js';
import type { Alert } from '../sync/alerts.js';
import { CALLBACK, decodeCallback } from './callback-data.js';
import { routeStaffCommand, staffHelpSection } from './commands/index.js';
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
import {
  accessEndedReply,
  helpReply,
  mainMenuReply,
  privacyReply,
  reconsentReply,
  regionCheckReply,
  regionManagerReply,
  signInPromptReply,
} from './handlers/menu.js';
import { type TelegramLookup, regionManagerFor } from '../staff/repository.js';
import {
  confirmRegion,
  flagRegionMismatch,
  markRegionAsked,
  regionCheckDue,
  regionFor,
} from '../teachers/region.js';
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
  /**
   * A few words naming what this message is, used only when it fails to send.
   *
   * `deliver` alerts on a failed send, and until this existed it described every
   * message after the first as "a notice about somebody else's action (a
   * duplicate sign-in)" — true while that was the only such message, and about
   * to stop being true the moment new-case notification is built. An operator
   * reading an alarm at three in the morning is the last person who should be
   * told the wrong thing about what did not arrive.
   *
   * Optional, and the answer to the sender does not set it: `messages[0]` is
   * always the reply to whoever wrote in, and `deliver` says so.
   */
  readonly purpose?: string;
  /**
   * A file to send instead of a plain message, with `text` as its caption.
   *
   * Returned rather than sent, exactly as every message here is, so that it
   * leaves after the transaction commits — an export that went out and then
   * rolled back would be a file in somebody's chat with no audit row behind it.
   *
   * Held in memory and never written to disk (`sendDocument` says why). `/export`
   * is the only thing that sets this, and D24 keeps the opposite direction
   * closed: the bot sends a file and never accepts one.
   */
  readonly document?: {
    readonly filename: string;
    readonly contents: string;
  };
}

/**
 * What the router decided.
 *
 * Messages and alerts are returned rather than sent so that every one of them
 * happens after the transaction commits. `messages[0]` is the answer to the
 * teacher who wrote in; anything after it goes to somebody else, and carries a
 * `purpose` saying what it was.
 */
export interface RouterOutcome {
  readonly messages: readonly OutgoingMessage[];
  readonly alerts: readonly Alert[];
}

export interface RouterDeps {
  /** Checked at start-up; the bot refuses to run with a placeholder. */
  readonly supportContact: string;
  /**
   * The one Telegram read the router makes, for `/username` (D47).
   *
   * Optional, and the absence is safe rather than degraded: `/username` refuses
   * to write an unverified handle and says so. A published handle that was never
   * checked is the exact failure R33 is about — it degrades towards 1,800
   * teachers being pointed at a stranger — so "cannot check, wrote nothing" is
   * the only acceptable behaviour when the lookup is missing.
   *
   * It is a *read*, not a send, which is why it may happen inside the
   * transaction. The lock it holds for the duration is the staff member's own
   * chat lock, so the only person waiting on it is the person who typed the
   * command.
   */
  readonly telegram?: TelegramLookup;
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
 * The teacher's answer, followed by everybody else's.
 *
 * `messages[0]` stays the reply to whoever wrote in — `deliver` relies on that
 * and words its failure alarm from it — so the notification is appended, never
 * prepended. Nothing here sends: the notification was computed inside the
 * transaction and goes out after the commit, the same rule as the duplicate
 * sign-in notice, because announcing something that can still roll back is
 * worse than announcing it a moment later.
 */
function withNotice(
  chatId: string,
  reply: Reply,
  notice: NotificationOutcome,
): RouterOutcome {
  return {
    messages: [{ chatId, text: reply.text, keyboard: reply.keyboard }, ...notice.messages],
    alerts: [...skippedAlert(reply), ...notice.alerts],
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
    const start = await startReply(db, update.chatId, deps);
    // A verified teacher gets the menu, and the region question with it when one
    // is due. Anybody else is being asked to sign in, and must not be asked
    // anything else on top of that.
    return start.signedIn
      ? menuWithRegionCheck(db, update.chatId)
      : only(update.chatId, start.reply);
  }
  if (text === '/privacy') {
    // Read here rather than held in `deps`: a period changed with /retention
    // must reach the next teacher who asks, not the next deploy.
    const periods = await retentionPeriods(db);
    return only(update.chatId, privacyReply(deps.supportContact, periods));
  }
  if (text === '/help') {
    // The staff half is appended only for an active staff row, so a teacher is
    // never shown a command they would be refused for typing.
    const staffSection = await staffHelpSection(db, update.chatId);
    return only(update.chatId, helpReply(deps.supportContact, staffSection));
  }

  /**
   * Staff commands, before the teacher state machine — D9.
   *
   * A staff member part-way through their own case must still be able to run
   * /close, for the same reason a teacher mid-case must still be able to reach
   * /help.
   *
   * Returns null when the text is not a command word this build has, and *also*
   * when the sender is not active staff. Both look identical from outside, which
   * is the point: the denial is logged, and the message falls through to
   * ordinary handling rather than being answered with a rejection that both
   * confirms the command exists and discards what they typed.
   *
   * The state is handed down so the denial is redacted by the same rule the
   * message was. Without it, refusing a command is a second route by which a
   * teacher's case detail reaches the interaction log.
   */
  const staffOutcome = await routeStaffCommand(db, update.chatId, text, state, deps);
  if (staffOutcome !== null) return staffOutcome;

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

/**
 * The main menu, with the region question beside it when one is due — D21, task 46.
 *
 * **Beside it, never instead of it, and never in place of anything else.** The
 * menu stays `messages[0]`, so a teacher who ignores the question has lost
 * nothing and the bot behaves exactly as it did before. The question is a second
 * message they may leave sitting there; it comes back in
 * `REGION_CONFIRM_AFTER_DAYS`.
 *
 * Used on the two paths a teacher arrives at the menu *deliberately* — `/start`
 * and the Main Menu button — and on none of the fallbacks. Landing on the menu
 * because an answer was withdrawn, a topic vanished or a conversation state
 * expired is a recovery, and a recovery interrupted by an unrelated question is
 * the blocking behaviour D21 rules out. `mainMenuReply()` is still the thing that
 * cannot itself fail, and it is unchanged.
 *
 * The stamp is written when the question is shown. See `teachers.region_asked_at`.
 */
async function menuWithRegionCheck(db: Database, chatId: string): Promise<RouterOutcome> {
  const menu = only(chatId, mainMenuReply());

  const region = await regionCheckDue(db, chatId, REGION_CONFIRM_AFTER_DAYS);
  if (region === null) return menu;

  await markRegionAsked(db, chatId);
  const ask = regionCheckReply(region);

  return {
    messages: [
      ...menu.messages,
      {
        chatId,
        text: ask.text,
        keyboard: ask.keyboard,
        purpose: 'a question to a teacher about which region we hold for them',
      },
    ],
    alerts: [...menu.alerts, ...skippedAlert(ask)],
  };
}

/**
 * `/start`: the menu for a teacher we know, the notice and prompt for one we do not.
 *
 * `signedIn` is reported rather than re-derived by the caller, so that the
 * teacher lookup happens once. It is what decides whether the region question may
 * be asked alongside the menu: somebody being asked to sign in must not be asked
 * anything else on top of it.
 *
 * **A revoked chat is refused here, not prompted.** `requireSignIn` has always
 * refused one, for the reason set out at `accessEndedReply` — sign-in reaches
 * `bindTeacher`, which clears `revoked_at`. This path did not, and that made
 * `/start` followed by an email address a complete self-service undo of a
 * revocation. Found by Task 36's own test for exactly that (`does not let a
 * restore be faked by signing in again`), in code committed three tasks earlier.
 * The two doors into sign-in now behave the same way, and `verifyIdentifier`
 * refuses a revoked chat as well, so a third door added later inherits the rule
 * instead of reopening the hole.
 */
async function startReply(
  db: Database,
  chatId: string,
  deps: RouterDeps,
): Promise<{ readonly signedIn: boolean; readonly reply: Reply }> {
  const teacher = await findTeacher(db, chatId);
  if (teacher?.verificationState === 'Verified') return { signedIn: true, reply: mainMenuReply() };

  if (teacher?.verificationState === 'Revoked') {
    return { signedIn: false, reply: accessEndedReply(deps.supportContact) };
  }

  await saveState(db, chatId, { kind: 'AwaitingIdentifier', attempts: 0 });
  return {
    signedIn: false,
    reply: signInPromptReply(deps.supportContact, await retentionPeriods(db)),
  };
}

async function handleIdentifier(
  db: Database,
  chatId: string,
  text: string,
  state: Extract<ConversationState, { kind: 'AwaitingIdentifier' }>,
  deps: RouterDeps,
): Promise<RouterOutcome> {
  /**
   * The periods the notice stated, recorded as part of the acceptance.
   *
   * Replying with an identifier *is* the acknowledgement — the prompt says so —
   * so this is the moment a teacher agrees to a specific set of numbers, and the
   * numbers have to be written down with the version. Without this, every
   * teacher who signs in is asked to re-accept on their very next tap.
   */
  const periods = await retentionPeriods(db);
  const outcome = await verifyIdentifier(db, chatId, text, state.attempts, periods);

  if (outcome.kind === 'lockedOut') {
    return only(chatId, {
      text:
        'Too many attempts. Please wait a little and tap Main Menu to start again.\n\n' +
        `If you cannot sign in, contact ${deps.supportContact}.`,
      keyboard: backToMenuKeyboard(),
    });
  }

  /**
   * Revoked mid-prompt — rare, and the one case the guard in `startReply` cannot
   * catch, because that chat was already sitting at the identifier question when
   * a staff member ended their access.
   *
   * The state is cleared rather than re-saved. Leaving them at the prompt would
   * invite them to keep typing addresses at a question whose answer can no longer
   * be right, and "check the address, including any dots" is actively misleading
   * when the address was never the problem.
   */
  if (outcome.kind === 'refused' && outcome.reason === 'accessRevoked') {
    await clearState(db, chatId);
    return only(chatId, accessEndedReply(deps.supportContact));
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
      purpose: 'a duplicate sign-in notice',
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

    /**
     * D11. Only a genuinely new case is announced.
     *
     * A second tap inside the 24-hour duplicate window returns the case that
     * already exists, and staff were told about it when it was filed. Announcing
     * it again would page up to twenty people for something they have already
     * seen, which is how a notification becomes one people ignore. The urgent
     * path is deliberately different — see `handleUrgentDetail`.
     */
    const notice = result.isNew
      ? await notifyNewCase(db, {
          reference: result.reference,
          category: state.category,
          teacherChatId: chatId,
          urgent: false,
        })
      : NO_NOTIFICATION;

    return withNotice(
      chatId,
      result.isNew ? caseFiledReply(result.reference) : caseDeduplicatedReply(result.reference),
      notice,
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

    /**
     * Announced whether or not the case is new — the opposite of the ordinary
     * path above, and deliberately.
     *
     * Urgent cases have no topic picker, so every one of them files under the
     * general category and so does every ordinary Contact Support case: a
     * teacher who opened one yesterday always deduplicates against it. Urgent
     * plus deduplicated is the *common* path, not an edge case. Announcing only
     * on an insert would mean the escalation nobody hears about is the one a
     * teacher spent a single-use code on.
     *
     * It is announced when the code would not spend, too. The case was filed at
     * `Escalated` by `createCase` before the code was touched, so a teacher who
     * described an emergency reaches somebody either way; the failed
     * consumption has its own alarm below.
     */
    const notice = await notifyNewCase(db, {
      reference: result.reference,
      category: URGENT_CASE_CATEGORY,
      teacherChatId: chatId,
      urgent: true,
    });

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
          ...notice.messages,
        ],
        alerts: [
          ...notice.alerts,
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

    return withNotice(
      chatId,
      result.isNew
        ? urgentCaseFiledReply(result.reference, deps.supportContact)
        : urgentCaseEscalatedReply(result.reference, deps.supportContact),
      notice,
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

    /**
     * The re-consent accept button — D32.
     *
     * Safe to receive from a chat that was never gated, or gated an hour ago and
     * still has the button in its scrollback: the payload is compared against
     * what is current, and anything that does not match shows the notice again
     * instead of recording something.
     */
    case CALLBACK.PRIVACY_ACCEPTED:
      return acceptPrivacyNotice(db, update.chatId, decoded.parts, state, deps);

    /**
     * D21's two answers. Neither writes a region, and that is the decision.
     *
     * Both are safe to receive from a chat that was never asked, or asked a year
     * ago and has the button still in its scrollback: "still right" writes
     * nothing but the withdrawal of a stale flag, and "I have moved" raises a
     * flag a manager reads before acting. Neither can move a case, so neither
     * needs a guard against a replayed tap.
     */
    case CALLBACK.REGION_CONFIRMED:
      await confirmRegion(db, update.chatId);
      return only(update.chatId, {
        text:
          'Thank you — nothing has changed, and we will not ask again for a while.\n\n' +
          'If you do move, tap Contact Support and tell us.',
        keyboard: backToMenuKeyboard(),
      });

    case CALLBACK.REGION_MOVED: {
      /**
       * The flag is raised against the teacher, not against a region they typed.
       * `flagRegionMismatch` reports whether there was a teacher to flag at all;
       * a tap from a chat with no teacher row is answered the same way, because
       * the alternative tells a stranger whether we hold a record for them.
       */
      await flagRegionMismatch(db, update.chatId);
      return only(update.chatId, {
        text:
          'Thank you for telling us. One of our staff will check it and update your record.\n\n' +
          'Nothing you need to do — and if you have an urgent problem in the meantime, ' +
          'use Contact Support as usual.',
        keyboard: backToMenuKeyboard(),
      });
    }

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
      return menuWithRegionCheck(db, chatId);

    case MENU_ACTION.FAQ:
      return only(chatId, faqHubReply());

    /**
     * Deliberately behind neither gate — Q2, step 7.
     *
     * "Who do I call?" is a question from somebody who is not in the middle of
     * anything, and often from somebody who cannot sign in and needs a person to
     * say so to. Gating it would answer that teacher with the sign-in prompt,
     * which is the one answer that does not help. An unverified chat has no
     * region, so `regionManagerFor` returns null and they get the support
     * contact — the same thing they had before this existed.
     *
     * The region is resolved through `regionFor`, never `teachers.region` (R12):
     * that column is the snapshot taken at sign-in, and a teacher shown last
     * year's manager is worse than a teacher shown nobody.
     */
    case MENU_ACTION.MY_MANAGER:
      return only(
        chatId,
        regionManagerReply(
          await regionManagerFor(db, await regionFor(db, chatId)),
          deps.supportContact,
        ),
      );

    /**
     * The three gated actions, and the two gates in front of each — D32.
     *
     * `requireReconsent` sits immediately behind `requireSignIn` and returns the
     * same `RouterOutcome | null`, so a fourth action added later inherits both
     * by copying one line rather than by remembering a rule. The FAQ is
     * deliberately absent from this list: browsing has always been open, and
     * maintenance mode leaves it running for the same reason.
     */
    case MENU_ACTION.CHECK_CASE:
      return (await requireSignIn(db, chatId, MENU_ACTION.CHECK_CASE, deps))
        ?? (await requireReconsent(db, chatId, MENU_ACTION.CHECK_CASE, deps))
        ?? only(chatId, await checkMyCaseReply(db, chatId));

    case MENU_ACTION.CONTACT_SUPPORT:
      return (await requireSignIn(db, chatId, MENU_ACTION.CONTACT_SUPPORT, deps))
        ?? (await requireReconsent(db, chatId, MENU_ACTION.CONTACT_SUPPORT, deps))
        ?? only(chatId, await startCase(db, chatId, deps));

    case MENU_ACTION.URGENT_CASE:
      return (await requireSignIn(db, chatId, MENU_ACTION.URGENT_CASE, deps))
        ?? (await requireReconsent(db, chatId, MENU_ACTION.URGENT_CASE, deps))
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
  if (hadAccess) return only(chatId, accessEndedReply(deps.supportContact));

  await saveState(db, chatId, { kind: 'AwaitingIdentifier', attempts: 0, resumeAction });
  return only(chatId, signInPromptReply(deps.supportContact, await retentionPeriods(db)));
}

/**
 * Ask a signed-in teacher to read the notice again, when the promise has moved.
 *
 * Returns null when nothing is owed, so the caller carries on — the same shape
 * as `requireSignIn`, and it is called from the same three places for the same
 * reason.
 *
 * **It never gates an unverified chat.** They have accepted nothing and are
 * about to be shown the notice by the sign-in prompt, which is the
 * acknowledgement; two notices in a row is one notice nobody reads. In practice
 * `requireSignIn` has already returned by then, and this is the second guard
 * saying so where it can be read.
 *
 * The rule itself is in `requiresReconsent` and is deliberately not restated
 * here: it is asymmetric — a lengthened period asks, a shortened one does not —
 * and a second expression of it would eventually disagree with the first.
 */
async function requireReconsent(
  db: Database,
  chatId: string,
  resumeAction: string,
  deps: RouterDeps,
): Promise<RouterOutcome | null> {
  const periods = await retentionPeriods(db);
  const current = { version: PRIVACY_NOTICE_VERSION, periods };

  const accepted = await privacyAcceptance(db, chatId);
  if (!requiresReconsent(accepted, current)) return null;

  await saveState(db, chatId, { kind: 'AwaitingPrivacyAcceptance', resumeAction });

  return only(
    chatId,
    reconsentReply(
      deps.supportContact,
      periods,
      PRIVACY_NOTICE_VERSION,
      renderPeriodsField(periods),
    ),
  );
}

/**
 * The accept button — the one write this gate makes.
 *
 * **A mismatch shows the notice again rather than recording anything** (R20). A
 * period is a settings row a System member can change while a teacher is
 * reading, so the version and the numbers travel in the payload and are compared
 * against what is current at the moment of the tap. Recording an acceptance for
 * text the teacher never saw is worse than one extra tap — the whole value of
 * this record is that it says a named teacher confirmed a specific version on a
 * specific date.
 *
 * Nothing is sent from in here: the acceptance and the resume are both computed
 * inside the caller's transaction and delivered after it commits, the same rule
 * as everything else in this file.
 */
async function acceptPrivacyNotice(
  db: Database,
  chatId: string,
  parts: readonly string[],
  state: ConversationState | null,
  deps: RouterDeps,
): Promise<RouterOutcome> {
  const periods = await retentionPeriods(db);
  const resumeAction =
    state?.kind === 'AwaitingPrivacyAcceptance' ? state.resumeAction : undefined;

  const shownVersion = parts[0];
  const shownPeriods = parts[1] === undefined ? null : parsePeriodsField(parts[1]);

  /**
   * Deep equality on three numbers, written out rather than compared as JSON.
   * `null` is a real value here — "kept indefinitely" — and every shortcut that
   * treats it as absent gets this wrong in the direction that records an
   * acceptance nobody gave.
   */
  const unchanged =
    shownVersion === PRIVACY_NOTICE_VERSION &&
    shownPeriods !== null &&
    shownPeriods.caseDays === periods.caseDays &&
    shownPeriods.urgentCaseDays === periods.urgentCaseDays &&
    shownPeriods.messageDays === periods.messageDays;

  if (!unchanged) {
    await saveState(db, chatId, {
      kind: 'AwaitingPrivacyAcceptance',
      ...(resumeAction !== undefined ? { resumeAction } : {}),
    });
    return only(
      chatId,
      reconsentReply(
        deps.supportContact,
        periods,
        PRIVACY_NOTICE_VERSION,
        renderPeriodsField(periods),
      ),
    );
  }

  /**
   * A chat with no teacher row cannot accept anything, and must not be told it
   * did. `recordAcceptance` reports whether it wrote, so this is answered by the
   * database rather than by assuming the gate ran first.
   */
  if (!(await recordAcceptance(db, chatId, PRIVACY_NOTICE_VERSION, periods))) {
    await clearState(db, chatId);
    return only(chatId, mainMenuReply());
  }

  await clearState(db, chatId);

  const resumed = await resumeAfterSignIn(db, chatId, resumeAction, deps);
  return only(chatId, {
    text: `✅ Thank you.\n\n${resumed.text}`,
    ...(resumed.keyboard !== undefined ? { keyboard: resumed.keyboard } : {}),
  });
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

  /**
   * Both gates again, and not merely for symmetry.
   *
   * A teacher's scrollback keeps every button they were ever sent, so a topic
   * button from before the notice changed is a live route into filing a case
   * that never passes through the menu action. Gating only `MENU:CONTACT_SUPPORT`
   * would leave that route open — which is the same class of hole as a second
   * door into sign-in, found once already in `startReply`.
   */
  const gate =
    (await requireSignIn(db, chatId, MENU_ACTION.CONTACT_SUPPORT, deps))
    ?? (await requireReconsent(db, chatId, MENU_ACTION.CONTACT_SUPPORT, deps));
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
