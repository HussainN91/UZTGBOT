/**
 * Deciding what to do with one inbound update.
 *
 * The order here is the design, not an implementation detail, and each step is
 * ordered against a specific way the Apps Script version went wrong:
 *
 *   1. Claim the update, or stop.        Telegram resends anything it thinks
 *                                        failed; a replay must not file a second
 *                                        case or a second priority request.
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
import { confirmUrgentRequest, requestUrgentCase } from '../cases/urgent.js';
import { TeacherNotVerifiedError, createCase } from '../cases/service.js';
import {
  NO_NOTIFICATION,
  notifyNewCase,
  notifyUrgentConfirmed,
  notifyUrgentRequestOnCase,
  type NotificationOutcome,
} from '../cases/notify.js';
import { clearState, loadState, saveState, type ConversationState } from '../conversation/state.js';
import type { Database } from '../db/index.js';
import { activeFormByType, activeForms } from '../forms/repository.js';
import { logInteraction } from '../log/interactions.js';
import type { IdentityDisputeClaim } from '../db/schema.js';
import {
  disputeOpenedMessages,
  notifyDisputeEscalated,
  notifyDisputeWithSystem,
} from '../teachers/dispute-notify.js';
import { disputeDetail, forwardToSystem, openDispute, recordClaim } from '../teachers/disputes.js';
import { settleAndAnnounce } from './dispute-actions.js';
import { privacyAcceptance, recordAcceptance } from '../teachers/privacy.js';
import { findTeacher, teacherHasAccess } from '../teachers/repository.js';
import { verifyIdentifier } from '../teachers/verify.js';
import type { Alert } from '../sync/alerts.js';
import { findCase } from '../cases/queries.js';
import { CAPABILITY, can, floorFor } from '../staff/roles.js';
import { CALLBACK, decodeCallback } from './callback-data.js';
import {
  STAFF_DENIED,
  routeCaseMenu,
  routeStaffCommand,
  routeStaffMenu,
  routeStaffWriting,
  staffHelpSection,
} from './commands/index.js';
import { reply, scopeOf } from './commands/context.js';
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
import { type TelegramLookup, findStaff, regionManagerFor } from '../staff/repository.js';
import {
  confirmRegion,
  flagRegionMismatch,
  markRegionAsked,
  regionCheckDue,
  regionFor,
} from '../teachers/region.js';
import {
  urgentAlreadyReply,
  urgentAppendedReply,
  urgentDetailPromptReply,
  urgentGrantedReply,
  urgentRequestedReply,
  urgentStillPendingReply,
  urgentUnavailableReply,
} from './handlers/urgent.js';
import {
  MENU_ACTION,
  backToMenuKeyboard,
  formsKeyboard,
  mainMenuKeyboard,
  type MenuAccess,
} from './keyboards.js';
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
    /**
     * The menu, for everybody — Part 5F.
     *
     * This used to hand a chat we did not know a sign-in prompt and hold them in
     * `AwaitingIdentifier`, which meant the answer bank — deliberately open to
     * everybody, and most needed by somebody who *cannot* sign in — was
     * unreachable through the front door. A door that is open and unreachable is
     * closed.
     *
     * A teacher whose access has ended is the one exception, and is told so
     * rather than shown a menu with nothing on it they came for.
     * `accessEndedReply` carries a Main Menu button, so the answer bank is still
     * one tap away for them.
     */
    const access = await menuAccessFor(db, update.chatId);
    if (access === 'accessEnded') {
      return only(update.chatId, accessEndedReply(deps.supportContact));
    }
    return menuWithRegionCheck(db, update.chatId, access);
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
  /**
   * A staff member who was asked for words — the one place a staff path runs
   * ahead of the command dispatcher.
   *
   * Guarded twice over: it fires only for `AwaitingCaseText`, which no teacher
   * can ever be in, and `routeStaffWriting` returns null for a chat with no
   * active staff row. So the teacher state machine below is untouched and its
   * order is unchanged.
   */
  const writing = await routeStaffWriting(db, update.chatId, text, state, deps);
  if (writing !== null) return writing;

  const staffOutcome = await routeStaffCommand(db, update.chatId, text, state, deps);
  if (staffOutcome !== null) return staffOutcome;

  switch (state?.kind) {
    case 'AwaitingIdentifier':
      return handleIdentifier(db, update.chatId, text, state, deps);
    case 'AwaitingCaseDetail':
      return handleCaseDetail(db, update.chatId, text, state, deps);
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
      keyboard: mainMenuKeyboard(await menuAccessFor(db, update.chatId)),
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
async function menuWithRegionCheck(
  db: Database,
  chatId: string,
  access: MenuAccess,
): Promise<RouterOutcome> {
  const menu = only(chatId, mainMenuReply(access));

  /**
   * Only a teacher who can actually use the bot is asked to maintain our record
   * of them — Part 5F.
   *
   * `regionCheckDue` filters on `Verified`, which already excludes a chat that
   * has never signed in. It does **not** exclude a revoked one: revocation
   * leaves a row that was `Verified` an hour ago with a stale `region_asked_at`,
   * and asking that teacher to confirm which region covers them is asking them
   * to keep tidy a record for a bot they have just been told they cannot use.
   */
  if (access !== 'signedIn') return menu;

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
 * Which of the three menus this chat is owed, and — the same question — whether
 * it may be let into sign-in.
 *
 * **This is the one place the rule lives.** Sign-in can now be reached from four
 * directions: `/start`, the Sign in button, any of the four gated actions, and
 * `verifyIdentifier` itself at the end. Every one of them has to refuse a chat
 * whose access has ended, because sign-in reaches `bindTeacher`, which clears
 * `revoked_at` — so a teacher who is let in undoes a staff member's deliberate
 * revocation by typing an email address, and nothing announces that it happened.
 * That exact hole existed on `/start`, was closed at `a37fef8`, and is the
 * reason `/restore` has to exist at all.
 *
 * Four doors sharing one expression of the rule cannot drift apart. Four doors
 * with four copies of it eventually will, and the copy that drifts will be the
 * one nobody was looking at.
 *
 * **There are two ways to have lost access and only one of them is `Revoked`.**
 * A teacher whose roster row was deactivated — which is what every administrator
 * assumes removing a row from the sheet does — keeps `verificationState =
 * 'Verified'` and fails `teacherHasAccess` on the roster flag. Testing for
 * `Revoked` alone would hand that teacher the sign-in prompt, which is the loop
 * `accessEndedReply` exists to avoid.
 */
async function menuAccessFor(db: Database, chatId: string): Promise<MenuAccess> {
  const teacher = await findTeacher(db, chatId);
  if (teacherHasAccess(teacher)) return 'signedIn';

  const hadAccess =
    teacher !== null &&
    (teacher.verificationState === 'Revoked' || teacher.verificationState === 'Verified');
  return hadAccess ? 'accessEnded' : 'signInOffered';
}

/**
 * The menu, for a caller that has not already resolved who is asking.
 *
 * Used on the recovery paths — an unreadable payload, a stale button, a
 * conversation state from a build that no longer exists. `mainMenuReply` itself
 * stays pure and cannot fail; this is the one lookup in front of it, and it is
 * the same indexed read every gated action already makes.
 */
async function menuReplyFor(db: Database, chatId: string): Promise<Reply> {
  return mainMenuReply(await menuAccessFor(db, chatId));
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

  if (outcome.priorHolders.length > 0) {
    /**
     * Feature A. A dispute record opens in the same transaction as the binding,
     * and its messages are returned rather than sent — `deliver` commits first
     * and speaks afterwards, so an argument is never announced over a binding
     * that can still roll back.
     *
     * **It does not gate the sign-in above, and that is D1 rather than an
     * oversight.** Blocking the second chat would lock out every teacher who
     * changes phone, and would hand anyone holding a leaked recruitment address a
     * way to lock the real teacher out permanently — turning an impersonation
     * risk into a denial of service. The teacher signs in; the argument runs
     * alongside.
     *
     * The plain duplicate-sign-in notice this replaced said the same thing and
     * led nowhere. `disputeOpenedMessages` says it and carries a button; sending
     * both would put two near-identical messages in the prior holder's chat a
     * second apart, and the second is the one that leads somewhere.
     */
    const dispute = await openDispute(db, {
      identifier: outcome.identifier,
      chatId,
      otherChatIds: outcome.priorHolders,
    });

    const opened = disputeOpenedMessages({
      disputeId: dispute.disputeId,
      identifier: outcome.identifier,
      newChatId: chatId,
      priorChatIds: outcome.priorHolders,
      supportContact: deps.supportContact,
    });
    messages.push(...opened.messages);
    alerts.push(...opened.alerts);

    /**
     * The operations alarm stays, unchanged and beside the dispute rather than
     * replaced by it. **It is the thing that fires when nobody taps anything** —
     * a dispute waits on a party responding, and a silent impersonation is
     * precisely the case where neither party does.
     */
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
  // No lookup: this runs in the same transaction as a `verifyIdentifier` that
  // has just succeeded, so the answer is known and re-reading it would only
  // create a way for the two to disagree.
  return mainMenuReply('signedIn');
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

/**
 * A teacher's description of something they want treated as a priority.
 *
 * The state is cleared *before* anything is announced, on every path out. A
 * teacher whose request left them still in `AwaitingUrgentDetail` would have
 * their next message — the FAQ question they ask five minutes later — appended
 * to the case as more urgent detail.
 */
async function handleUrgentDetail(
  db: Database,
  chatId: string,
  text: string,
  state: Extract<ConversationState, { kind: 'AwaitingUrgentDetail' }>,
  deps: RouterDeps,
): Promise<RouterOutcome> {
  if (text === '') {
    /**
     * The counter was stored and never incremented, so this prompt had no end.
     *
     * The state has carried an `attempts` field since it was written, and
     * nothing ever added to it — so a teacher sending photographs instead of
     * text was held at this prompt for the whole 30-minute life of the state,
     * being told the same sentence every time, while the ordinary case prompt
     * beside it gives up after three tries and says so. The person likeliest to
     * hit this is the one with an emergency and a photograph of a document.
     *
     * `retryCaseDetail`'s shape exactly, and deliberately not a shared function:
     * the two differ in what they say and in what a teacher should do next, and
     * the counting is three lines. No schema change — the count lives in the
     * state's JSON payload, which is already typed for it.
     */
    const attempts = state.attempts + 1;
    if (attempts >= MAX_CASE_DETAIL_ATTEMPTS) {
      await clearState(db, chatId);
      return only(chatId, {
        text:
          'I still have not got any text.\n\n' +
          'Let us start again — tap Main Menu, then Ask for Priority. If it is easier to ' +
          `speak to somebody, contact ${deps.supportContact}.`,
        keyboard: backToMenuKeyboard(),
      });
    }

    await saveState(db, chatId, { ...state, attempts });
    return only(chatId, {
      text:
        'I did not get any text. Please describe the problem in one message, and say ' +
        'why it cannot wait its turn.',
    });
  }

  try {
    const result = await requestUrgentCase(db, { chatId, detail: text });
    await clearState(db, chatId);

    /**
     * Nobody is asked to decide something that has already been decided.
     *
     * A case at `Urgent` or `Critical` has had its judgement; a case with a
     * request already pending has one waiting. In both situations the teacher's
     * words are kept — that happened inside `requestUrgentCase` — and no
     * coordinator is paged, because a second identical message about a decision
     * somebody is already sitting on is how the button stops being read.
     *
     * This is the deduplicated path, and it is the *common* one rather than an
     * edge case: a priority request has no topic picker, so it files under the
     * general category and so does every ordinary Contact Support case.
     */
    if (result.alreadyUrgent) {
      return only(chatId, urgentAlreadyReply(result.reference, deps.supportContact));
    }
    if (result.alreadyRequested) {
      return only(chatId, urgentStillPendingReply(result.reference, deps.supportContact));
    }

    const notice = await notifyUrgentRequestOnCase(db, {
      reference: result.reference,
      category: URGENT_CASE_CATEGORY,
      teacherChatId: chatId,
      isNew: result.isNew,
    });

    return withNotice(
      chatId,
      result.isNew
        ? urgentRequestedReply(result.reference, deps.supportContact)
        : urgentAppendedReply(result.reference, deps.supportContact),
      notice,
    );
  } catch (err) {
    if (err instanceof TeacherNotVerifiedError) {
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
  if (decoded === null) return only(update.chatId, await menuReplyFor(db, update.chatId));

  const [first = '', second = ''] = decoded.parts;

  switch (decoded.prefix) {
    case CALLBACK.MENU:
      return routeMenu(db, update.chatId, first, deps);

    /**
     * The four answer-bank taps carry `access` for one reason — Part 5F. Each
     * has a path that lands on the **main menu** when what was tapped no longer
     * exists, and browsing is open to chats that have never signed in, so the
     * menu drawn there has to be the one that chat is owed. See the note on
     * `unknownTopicReply`.
     */
    case CALLBACK.TOPIC:
      return only(
        update.chatId,
        await topicListingReply(db, first, await menuAccessFor(db, update.chatId)),
      );

    case CALLBACK.TOPIC_PAGE: {
      const page = Number.parseInt(second, 10);
      return only(
        update.chatId,
        await topicListingReply(
          db,
          first,
          await menuAccessFor(db, update.chatId),
          Number.isFinite(page) ? page : 1,
        ),
      );
    }

    case CALLBACK.QUERY_TOPIC: {
      /**
       * The topic for a question already typed. If the state has expired — the
       * teacher left this button sitting for half an hour — there is nothing to
       * answer, so they get the topic's questions instead of a shrug.
       */
      const access = await menuAccessFor(db, update.chatId);
      if (state?.kind !== 'AwaitingQuestionTopic') {
        return only(update.chatId, await topicListingReply(db, first, access));
      }
      await clearState(db, update.chatId);
      return only(update.chatId, await questionReply(db, first, state.query, access));
    }

    case CALLBACK.ANSWER:
      return only(
        update.chatId,
        await answerReply(db, first, await menuAccessFor(db, update.chatId)),
      );

    case CALLBACK.ANSWER_HELPFUL:
    case CALLBACK.ANSWER_UNHELPFUL:
      return recordFeedback(db, update.chatId, decoded.prefix, first, state);

    case CALLBACK.CASE_TOPIC:
      return chooseCaseTopic(db, update.chatId, first, deps);

    /**
     * A document form was tapped — D24.
     *
     * Behind both gates for the same reason the other three actions are: the
     * form asks for the teacher's recruitment email, and a chat that has not
     * signed in has no business being handed one.
     */
    case CALLBACK.DOC_TYPE:
      return (await requireSignIn(db, update.chatId, MENU_ACTION.SUBMIT_DOCS, deps))
        ?? (await requireReconsent(db, update.chatId, MENU_ACTION.SUBMIT_DOCS, deps))
        ?? only(update.chatId, await chooseDocForm(db, first, deps));

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

    /**
     * The first button in this system a staff member taps rather than a teacher.
     *
     * It goes through the same authorization the typed commands do and then
     * through the case scope on top of it, which is not belt and braces: the
     * button was sent to whoever covered the region when the request arrived,
     * and a message sits in a Telegram scrollback for ever. The person tapping
     * it today may have been demoted, deactivated, or moved to another region
     * since — and none of those would change the payload sitting in their chat.
     */
    case CALLBACK.URGENT_CONFIRM:
      return confirmUrgent(db, update.chatId, first, state, deps);

    /**
     * "Open this case" from a list — Part 5G.
     *
     * **It is handed to the command dispatcher as `/case <reference>`, and that
     * is the whole implementation.** Not a shortcut: the button is not merely
     * *as* authorized as the command, it **is** the command, so there is no
     * second place for "may this person see this case" to be computed and
     * therefore no second place for it to drift. The active-staff check, the
     * `case.view` capability, the scope through `findCase`, the identical answer
     * for "no such case" and "not yours", and the `messages` row recording who
     * read which case all come free.
     *
     * `null` means the tapper has no active staff row. They get the menu, the
     * same answer an unreadable payload gets and for `confirmUrgent`'s reason:
     * a reply saying "you are not staff" tells a stranger that the button they
     * guessed at is real.
     *
     * `first` is untrusted — it arrives from the network and can be
     * hand-crafted. It is not validated here because it does not need to be:
     * `findCase` takes it as a value to match, never as a lookup key, and an
     * unmatched reference is an ordinary "no case you can see".
     */
    case CALLBACK.CASE_OPEN:
      return (
        (await routeStaffCommand(db, update.chatId, `/case ${first}`, state, deps))
        ?? only(update.chatId, await menuReplyFor(db, update.chatId))
      );

    /**
     * One action on one case.
     *
     * The whole payload is handed over rather than picked apart here: it is a
     * three-level menu and the router has no business knowing its levels. What
     * it does know is the same thing it knows about every other staff tap —
     * `null` means the tapper is not staff, and gets the ordinary menu rather
     * than an answer confirming the button is real.
     */
    case CALLBACK.CASE_ACTION:
      return (
        (await routeCaseMenu(db, update.chatId, decoded.parts, state, deps))
        ?? only(update.chatId, await menuReplyFor(db, update.chatId))
      );

    /**
     * Staff management by button — Part 5H.3.
     *
     * The whole payload is handed over rather than picked apart here: this is a
     * three-level menu and the router has no business knowing its levels. What
     * it does know is the same thing it knows about every other staff tap —
     * `null` means the tapper is not staff, and gets the ordinary menu rather
     * than an answer confirming the button is real.
     */
    case CALLBACK.STAFF_MENU:
      return (
        (await routeStaffMenu(db, update.chatId, decoded.parts, state, deps))
        ?? only(update.chatId, await menuReplyFor(db, update.chatId))
      );

    /**
     * A party's answer on an identity dispute — Feature A.
     *
     * **The only button in this system authorised by something other than a staff
     * row.** The people tapping it are teachers, and what entitles them to answer
     * is being *on the dispute*: `recordClaim` refuses any chat that is not a
     * party, which is the whole check. The claim travels in the payload; the
     * party never does, so neither account can answer for the other.
     *
     * A stranger who guesses `DC:1:Mine` gets the ordinary menu — the same answer
     * an unreadable payload gets, and for `confirmUrgent`'s reason: a reply
     * confirming the dispute exists tells them their guess was real.
     */
    case CALLBACK.DISPUTE_CLAIM:
      return claimDispute(db, update.chatId, first, second, deps);

    case CALLBACK.DISPUTE_ESCALATE:
      return (
        (await forwardDispute(db, update.chatId, first, state))
        ?? only(update.chatId, await menuReplyFor(db, update.chatId))
      );

    case CALLBACK.DISPUTE_RESOLVE:
      return (
        (await settleDispute(db, update.chatId, first, second, state, deps))
        ?? only(update.chatId, await menuReplyFor(db, update.chatId))
      );

    default:
      return only(update.chatId, await menuReplyFor(db, update.chatId));
  }
}

/**
 * A coordinator agreeing that a case should jump the queue.
 *
 * Four things are checked and each rules out a different way of getting this
 * wrong:
 *
 *   **An active staff row**, and silence without one. A tap from a chat with no
 *   staff row is answered with the main menu, exactly as an unreadable payload
 *   is — the dispatcher's rule (`commands/index.ts`), and for its reason: an
 *   answer that says "you are not staff" tells a stranger that the button they
 *   guessed at is real.
 *
 *   **`urgent.issue`**, answered plainly for somebody who *is* staff. They know
 *   the button exists because it is in their chat; refusing silently would leave
 *   them tapping it.
 *
 *   **The case, through `findCase`**, which applies the visibility scope. The
 *   note in `updateCase` is the whole argument: it takes a bare reference and
 *   writes, so a caller that skips the scoped lookup lets a staff member change
 *   a case in a queue or region they do not hold, and nothing would notice.
 *
 *   **The request's own state**, inside `confirmUrgentRequest`, in the same
 *   statement as the write. That is what makes a second tap a no-op rather than
 *   a second audit row and a second message to the teacher.
 */
async function confirmUrgent(
  db: Database,
  chatId: string,
  reference: string,
  state: ConversationState | null,
  deps: RouterDeps,
): Promise<RouterOutcome> {
  const member = await findStaff(db, chatId);
  if (member === null) {
    await logInteraction(db, chatId, STAFF_DENIED, `urgent confirm ${reference}`, state);
    return only(chatId, await menuReplyFor(db, chatId));
  }

  if (!can(member, CAPABILITY.URGENT_ISSUE)) {
    await logInteraction(db, chatId, STAFF_DENIED, `urgent confirm ${reference}`, state);
    return only(chatId, {
      text:
        'Confirming an urgent request is not available at your rank.\n\n' +
        `It needs ${floorFor(CAPABILITY.URGENT_ISSUE)} or above. Yours is ${member.role}.`,
    });
  }

  const found = await findCase(db, scopeOf(member), reference);
  if (found === null) {
    return only(chatId, {
      text:
        `I cannot find ${reference}, or it is outside your queue and regions.\n\n` +
        'It may have been removed by the retention schedule, or your coverage may have ' +
        'changed since this message was sent.',
    });
  }

  const outcome = await confirmUrgentRequest(db, found.reference, member.telegramId);

  if (outcome.kind === 'unknown' || outcome.kind === 'notRequested') {
    return only(chatId, {
      text:
        `Nothing to confirm on ${found.reference}.\n\n` +
        'No priority request is waiting on it. If it needs raising anyway, use ' +
        `/mark ${found.reference} Urgent.`,
    });
  }

  if (outcome.kind === 'alreadyConfirmed') {
    return only(chatId, {
      text:
        `${found.reference} is already marked urgent.\n\n` +
        `Confirmed by ${outcome.by ?? 'somebody whose id was not recorded'}. Nothing has changed ` +
        'and nobody has been told again.',
    });
  }

  const notice = await notifyUrgentConfirmed(db, {
    reference: outcome.reference,
    teacherChatId: outcome.teacherChatId,
    owner: outcome.owner,
    confirmedBy: member.telegramId,
  });

  /**
   * Three audiences, and the order is `deliver`'s contract rather than a
   * preference. `messages[0]` is the answer to whoever acted — the coordinator —
   * because that is the position `deliver` words its failure alarm from.
   *
   * The teacher's message is sent from here and not from `notify.ts` for the
   * same reason: it is not the answer to anything they just did. They asked
   * hours ago and have been told it was passed on.
   */
  const granted = urgentGrantedReply(outcome.reference, deps.supportContact);
  return {
    messages: [
      {
        chatId,
        text:
          `⏫ ${outcome.reference} is now urgent.\n\n` +
          'It has moved to Escalated and appears in /urgent. The teacher has been told, ' +
          `${outcome.owner === null ? 'and it still has no owner — /assign it.' : 'and so has its owner.'}` +
          /**
           * Only when it applies, and it rarely will.
           *
           * The button lives in a coordinator's chat for ever, so this tap can
           * land long after somebody else closed the case. Confirming still
           * works — the teacher's request was never answered and closing the
           * case did not answer it — but the coordinator has just undone another
           * person's deliberate close, and being told is the difference between
           * that and it happening quietly.
           */
          (outcome.reopened
            ? '\n\nThis case had been closed, and confirming has opened it again. ' +
              'If that was not what you wanted, /status it back.'
            : ''),
      },
      {
        chatId: outcome.teacherChatId,
        text: granted.text,
        keyboard: granted.keyboard,
        purpose: 'telling a teacher their case was accepted as urgent',
      },
      ...notice.messages,
    ],
    alerts: notice.alerts,
  };
}

/**
 * A teacher answering on a dispute about their own account — Feature A.
 *
 * **No staff gate**, and that is deliberate rather than missing: the people who
 * tap this are the two teachers arguing. Authorisation is party membership, which
 * `recordClaim` checks against the database, and the claim is recorded against
 * the chat the tap arrived from rather than against anything in the payload.
 *
 * Every failing branch returns the ordinary main menu rather than a sentence
 * about disputes. A stranger who hand-crafts `DC:1:Mine` must not learn whether
 * dispute 1 exists, who is on it, or whether their guess was close.
 */
async function claimDispute(
  db: Database,
  chatId: string,
  rawId: string,
  rawClaim: string,
  deps: RouterDeps,
): Promise<RouterOutcome> {
  const disputeId = Number.parseInt(rawId, 10);
  /**
   * The claim is validated against the two values the enum holds before it
   * reaches SQL. It arrives from the network and can be hand-crafted, and an
   * unchecked value would reach a `::identity_dispute_claim` cast and throw
   * rather than being refused.
   */
  const claim: IdentityDisputeClaim | null =
    rawClaim === 'Mine' ? 'Mine' : rawClaim === 'NotMine' ? 'NotMine' : null;

  if (!Number.isFinite(disputeId) || claim === null) {
    return only(chatId, await menuReplyFor(db, chatId));
  }

  const outcome = await recordClaim(db, disputeId, chatId, claim);

  if (outcome.kind === 'unknown' || outcome.kind === 'notAParty') {
    return only(chatId, await menuReplyFor(db, chatId));
  }

  if (outcome.kind === 'alreadyResolved') {
    return only(chatId, {
      text:
        'This has already been settled.\n\n'
        + 'Ministry staff have decided which account belongs to this teacher, so there '
        + 'is nothing left to answer here.\n\n'
        + `If you think the decision is wrong, contact ${deps.supportContact}.`,
      keyboard: backToMenuKeyboard(),
    });
  }

  const thanks: Reply = {
    text:
      '✅ Thank you — that is recorded.\n\n'
      + 'A member of Ministry staff will look at both accounts and decide. You do not '
      + 'need to do anything else, and you are not locked out while they look.\n\n'
      + `If anything changes, contact ${deps.supportContact}.`,
    keyboard: backToMenuKeyboard(),
  };

  /**
   * Only the first answer pages the region. A second party tapping is recorded
   * and told the same thing, but the reviewers are not asked twice about one
   * argument — the failure `NO_NOTIFICATION` exists to prevent, one table along.
   */
  if (!outcome.isFirstClaim) return only(chatId, thanks);

  const detail = await disputeDetail(db, disputeId);
  const escalation = await notifyDisputeEscalated(db, {
    disputeId,
    identifier: outcome.identifier,
    parties: detail?.partyDetail ?? [],
  });

  return {
    messages: [{ chatId, text: thanks.text, keyboard: thanks.keyboard }, ...escalation.messages],
    alerts: escalation.alerts,
  };
}

/**
 * A regional reviewer handing a dispute to a System administrator.
 *
 * The same four checks `confirmUrgent` makes, in the same order and for the same
 * reasons: an active staff row with silence when there is none, the capability
 * the *action* needs, the subject itself, and the subject's own state inside the
 * store's conditional `UPDATE`. A message sits in a Telegram chat for ever and
 * the person tapping it may have been demoted since it was sent.
 *
 * There is no queue or region scope on a dispute — it is not a case and has no
 * queue. `dispute.review` is the scope.
 */
async function forwardDispute(
  db: Database,
  chatId: string,
  rawId: string,
  state: ConversationState | null,
): Promise<RouterOutcome | null> {
  const member = await findStaff(db, chatId);
  if (member === null) {
    await logInteraction(db, chatId, STAFF_DENIED, `dispute forward ${rawId}`, state);
    return null;
  }

  if (!can(member, CAPABILITY.DISPUTE_REVIEW)) {
    await logInteraction(db, chatId, STAFF_DENIED, `dispute forward ${rawId}`, state);
    return reply(
      chatId,
      'Passing on an identity dispute is not available at your rank.\n\n'
        + `It needs ${floorFor(CAPABILITY.DISPUTE_REVIEW)} or above. Yours is ${member.role}.`,
    );
  }

  const disputeId = Number.parseInt(rawId, 10);
  if (!Number.isFinite(disputeId)) return reply(chatId, 'I cannot read that dispute number.');

  const outcome = await forwardToSystem(db, disputeId, member.telegramId);

  if (outcome.kind === 'unknown') {
    return reply(
      chatId,
      `I cannot find dispute ${String(disputeId)}.\n\n`
        + 'It may have been settled and removed, or this button may be from an older '
        + 'version of the bot. /disputes lists everything still waiting.',
    );
  }

  if (outcome.kind === 'alreadyResolved') {
    return reply(
      chatId,
      `Dispute ${String(disputeId)} is already settled.\n\n`
        + `The account kept was ${outcome.keptChatId ?? 'not recorded'}. Nothing has changed.`,
    );
  }

  if (outcome.kind === 'alreadyWithSystem') {
    return reply(
      chatId,
      `Dispute ${String(disputeId)} is already with a system administrator.\n\n`
        + 'Nothing has changed and nobody has been told again.',
    );
  }

  const detail = await disputeDetail(db, disputeId);
  const notice = await notifyDisputeWithSystem(db, {
    disputeId,
    identifier: outcome.identifier,
    parties: detail?.partyDetail ?? [],
    forwardedBy: member.telegramId,
  });

  return {
    messages: [
      {
        chatId,
        text:
          `📤 Dispute ${String(disputeId)} is now with the system administrators.\n\n`
          + 'They decide which account keeps the identity. Nothing else is needed from you.',
      },
      ...notice.messages,
    ],
    alerts: notice.alerts,
  };
}

/**
 * A System administrator deciding which account is the teacher's.
 *
 * The heaviest button in the bot: it revokes every other party and closes their
 * cases. `resolveDispute` holds the guarantee that a second tap changes nothing —
 * the guard is in the `WHERE` clause of the write, not in a branch here.
 *
 * The closing note is built here rather than in the store because it has to name
 * the support contact, and layer 2 has no route to one. It states a reason and
 * accuses nobody: if the decision went the wrong way, this is the only thing
 * standing between a real teacher and silence.
 */
async function settleDispute(
  db: Database,
  chatId: string,
  rawId: string,
  keptChatId: string,
  state: ConversationState | null,
  deps: RouterDeps,
): Promise<RouterOutcome | null> {
  const member = await findStaff(db, chatId);
  if (member === null) {
    await logInteraction(db, chatId, STAFF_DENIED, `dispute resolve ${rawId}`, state);
    return null;
  }

  if (!can(member, CAPABILITY.DISPUTE_RESOLVE)) {
    await logInteraction(db, chatId, STAFF_DENIED, `dispute resolve ${rawId}`, state);
    return reply(
      chatId,
      'Settling an identity dispute is not available at your rank.\n\n'
        + `It needs ${floorFor(CAPABILITY.DISPUTE_RESOLVE)} or above. Yours is ${member.role}.\n\n`
        + 'It revokes every other account and closes its cases, which is why it sits there.',
    );
  }

  const disputeId = Number.parseInt(rawId, 10);
  if (!Number.isFinite(disputeId)) return reply(chatId, 'I cannot read that dispute number.');

  return settleAndAnnounce(db, chatId, {
    disputeId,
    keptChatId,
    actor: member.telegramId,
    outcome: `Settled by button by ${member.telegramId}`,
    supportContact: deps.supportContact,
  });
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
      return menuWithRegionCheck(db, chatId, await menuAccessFor(db, chatId));

    case MENU_ACTION.FAQ:
      return only(chatId, faqHubReply());

    /**
     * The Sign in button — Part 5F, and the fourth door into sign-in.
     *
     * **It is the same door.** `requireSignIn` is the function standing in front
     * of the four gated actions, and routing this through it rather than writing
     * a fourth prompt is the entire safety argument for putting a sign-in
     * control on a menu at all: a revoked chat is refused here because it is
     * refused there, not because somebody remembered to check again.
     *
     * `null` means they are already signed in, which is what a stale button from
     * before they signed in looks like. They get the menu rather than being
     * asked to do a thing they have done — and the region question with it, on
     * the same footing as the Main Menu button above.
     *
     * The resume is `MAIN`: they asked to sign in, not to do something that
     * required it, so the menu is what they were after.
     */
    case MENU_ACTION.SIGN_IN:
      return (
        (await requireSignIn(db, chatId, MENU_ACTION.MAIN, deps))
        ?? (await menuWithRegionCheck(db, chatId, 'signedIn'))
      );

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

    case MENU_ACTION.SUBMIT_DOCS:
      return (await requireSignIn(db, chatId, MENU_ACTION.SUBMIT_DOCS, deps))
        ?? (await requireReconsent(db, chatId, MENU_ACTION.SUBMIT_DOCS, deps))
        ?? only(chatId, await submitDocsReply(db, deps));

    default:
      return only(chatId, await menuReplyFor(db, chatId));
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
  const access = await menuAccessFor(db, chatId);
  if (access === 'signedIn') return null;

  /**
   * Access that has been taken away is not re-offered as a sign-in prompt.
   *
   * Two different reasons a verified teacher can fail the gate — a staff member
   * ran `/revoke`, or their roster row was deactivated or removed — and neither
   * is fixed by typing an email address again. Prompting would send them round a
   * loop that `verifyIdentifier` refuses at the end, telling them nothing about
   * why. It would also let somebody undo a deliberate revocation simply by
   * signing in again, on the one path where `bindTeacher` clears `revoked_at`.
   *
   * The condition itself lives in `menuAccessFor` and is deliberately not
   * restated here — see its note. This function is now the *only* way into the
   * prompt, which is what lets the Sign in button be safe by construction.
   */
  if (access === 'accessEnded') return only(chatId, accessEndedReply(deps.supportContact));

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
    return only(chatId, await menuReplyFor(db, chatId));
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
/**
 * The list of document forms — D24, and the whole teacher-facing half of Stage 6.
 *
 * **The bot never accepts, holds or stores a file.** It hands out links to Google
 * Forms and reads the answers back later; `sendDocument` exists for `/export`
 * and has no receive path, deliberately.
 *
 * Paused by maintenance mode alongside Contact Support and Ask for Priority. A
 * submission becomes a case, so it is work arriving, and the reason for pausing
 * new cases applies to it unchanged.
 *
 * An empty list is its own message rather than an empty keyboard. Before the
 * FORMS tab is filled in this is what every teacher sees, and "no forms are
 * available yet" is an answer where a menu with one Home button is a puzzle.
 */
async function submitDocsReply(db: Database, deps: RouterDeps): Promise<Reply> {
  if (await isMaintenanceMode(db)) {
    return {
      text:
        'Document submission is paused while the support team deals with something.\n\n' +
        'The FAQ and Check My Case still work. ' +
        `If this cannot wait, contact ${deps.supportContact}.`,
      keyboard: backToMenuKeyboard(),
    };
  }

  const forms = await activeForms(db);
  if (forms.length === 0) {
    return {
      text:
        'There are no document forms available at the moment.\n\n' +
        `If you were asked to send a document, contact ${deps.supportContact}.`,
      keyboard: backToMenuKeyboard(),
    };
  }

  return {
    text:
      'Submit Documents\n\n' +
      'Choose what you need to send. Each one opens a form.\n\n' +
      '⚠️ Use the same email address you sign in here with, or we cannot match ' +
      'your documents to you.',
    keyboard: formsKeyboard(forms),
  };
}

/**
 * One form's link, looked up again at the moment of the tap.
 *
 * Re-read rather than trusted from the payload, and `activeFormByType` checks
 * the active flag again. A teacher can tap a button in scrollback weeks later,
 * and a form staff withdrew this morning must not still be reachable through it.
 *
 * The email warning is repeated here and not only on the list. This is the last
 * message before the teacher leaves Telegram, and matching the submission back
 * to a person depends entirely on their typing the address the roster holds.
 */
async function chooseDocForm(db: Database, type: string, deps: RouterDeps): Promise<Reply> {
  if (await isMaintenanceMode(db)) {
    return {
      text:
        'Document submission has just been paused while the support team deals with something.\n\n' +
        `If this cannot wait, contact ${deps.supportContact}.`,
      keyboard: backToMenuKeyboard(),
    };
  }

  const form = await activeFormByType(db, type);
  if (form === null) {
    return {
      text:
        'That form is no longer available.\n\n' +
        'It may have been replaced — open Submit Documents again for the current list.',
      keyboard: backToMenuKeyboard(),
    };
  }

  return {
    text:
      `${form.buttonText}\n\n` +
      `${form.url}\n\n` +
      '⚠️ The form asks for your email. Use the same address you signed in here ' +
      'with — that is how we know the documents are yours.\n\n' +
      'You do not need to send anything back to me. Once you submit the form, ' +
      'it reaches us on its own.',
    keyboard: backToMenuKeyboard(),
  };
}

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

/**
 * Ask for the problem, with nothing in front of it.
 *
 * The whole of the change made on 1 August 2026 is visible in this function:
 * where it used to write `AwaitingUrgentCode` and demand a six-character string
 * a Regional admin had read down the telephone, it now writes the detail state
 * directly. Maintenance mode is still checked, because asking for priority opens
 * a case and that is the thing maintenance pauses.
 */
async function startUrgent(db: Database, chatId: string, deps: RouterDeps): Promise<Reply> {
  if (await isMaintenanceMode(db)) {
    return urgentUnavailableReply(deps.supportContact);
  }
  await saveState(db, chatId, { kind: 'AwaitingUrgentDetail', attempts: 0 });
  return urgentDetailPromptReply();
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
    keyboard: mainMenuKeyboard(await menuAccessFor(db, chatId)),
  });
}

/** Exported for the suite: the five filing choices, so a test cannot drift from the menu. */
export const CASE_TOPIC_KEYS = CASE_TOPIC_CHOICES.map((c) => c.key);
