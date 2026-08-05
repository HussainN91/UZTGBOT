/**
 * The staff command dispatcher, and the one place a command is refused — D9.
 *
 * Commands run *inside* the update pipeline, not beside it. A `bot.command`
 * handler would run outside the update claim, outside the chat lock and outside
 * the interaction log: a redelivered `/close` would close a case twice, and two
 * staff members acting at once would not be serialised at all. Matching here
 * gives the same ordering guarantee as a registration and keeps one path.
 *
 * Two rules govern everything below, and both depart from `BOT-SPEC.md` §6.5:
 *
 *   A command word this build does not have is not a command. It returns null
 *   and the message goes to ordinary handling, which is what lets a teacher
 *   describing a broken boiler start a sentence with a slash.
 *
 *   A sender with no active staff row is told nothing. The denial is logged and
 *   the message *still* falls through. `routeAdminCommand_` answered
 *   "You are not registered as an admin" and consumed the message
 *   (`AdminCommands.gs:409-417`) — which confirmed to any stranger that the
 *   command exists, and cost a teacher mid-case everything they had typed.
 *
 * A staff member whose rank is too low is a different person and is answered
 * plainly: they already know the command exists, and silence would send a Lead's
 * `/maintenance` to the teacher topic picker.
 */
import { clearState, saveState, type ConversationState } from '../../conversation/state.js';
import type { Database } from '../../db/index.js';
import { logInteraction } from '../../log/interactions.js';
import { findStaff } from '../../staff/repository.js';
import { CAPABILITY, type Capability, can, capabilitiesFor, floorFor } from '../../staff/roles.js';
import type { RouterDeps, RouterOutcome } from '../router.js';
import {
  type StaffCommand,
  type StaffContext,
  describeCapabilities,
  reply,
  scopeOf,
} from './context.js';
import { ANNOUNCE_COMMANDS } from './announce.js';
import { caseMenuView, commandForCaseText } from './case-menu.js';
import { CASE_COMMANDS } from './cases.js';
import { OPS_COMMANDS } from './ops.js';
import { parseCommand } from './parse.js';
import { PEOPLE_COMMANDS, staffAddView, staffMenuList, staffMenuView } from './staff.js';

export type { StaffCommand, StaffContext };

/**
 * Logged whenever a command is recognised and refused, whoever refused it.
 *
 * `BOT-SPEC.md` §13 asks that every authorization denial leave a trace, so that
 * somebody working through the command list from a stranger's account is visible
 * in the same table as everything else. The row carries the command word and its
 * first argument only — D16's prefix rule, applied by `redactDetail`.
 */
export const STAFF_DENIED = 'STAFF_DENIED';

/**
 * Every command this build has.
 *
 * A word absent from here is not recognised at all, which is deliberate: an
 * unbuilt command that answered "not implemented" would tell a stranger the
 * command list, and would consume a teacher's message to say it.
 */
export const STAFF_COMMANDS: readonly StaffCommand[] = [
  ...PEOPLE_COMMANDS,
  ...CASE_COMMANDS,
  ...OPS_COMMANDS,
  ...ANNOUNCE_COMMANDS,
];

/**
 * Match, authorise, and run one staff command.
 *
 * Returns `null` for "this is not a staff command from someone who may use it",
 * which the router treats as "carry on as if nothing had been matched". Both
 * reasons for null — an unknown word, and a sender who is not staff — must look
 * identical from outside, because that is what stops the deny path from being a
 * command-existence oracle.
 *
 * `state` is the conversation state the router already read, and it is not
 * optional decoration. The denial is logged with it, so a teacher part-way
 * through describing a case has their words redacted as case detail rather than
 * written into `messages` as a command argument. Without it, refusing a command
 * becomes a second route by which case detail reaches the interaction log — the
 * exact leak D16 closed.
 *
 * `commands` defaults to the production registry. It is a parameter so that the
 * rank-too-low branch could be tested the day it was written, rather than three
 * tasks later when the first capability-gated command arrives.
 */
export async function routeStaffCommand(
  db: Database,
  chatId: string,
  text: string,
  state: ConversationState | null,
  deps: RouterDeps,
  commands: readonly StaffCommand[] = STAFF_COMMANDS,
): Promise<RouterOutcome | null> {
  const parsed = parseCommand(text);
  if (parsed === null) return null;

  const command = commands.find((c) => c.name === parsed.name);
  if (command === undefined) return null;

  /**
   * `findStaff` returns only active rows, so a deactivated member is a stranger
   * here — and that is the right answer. A deactivated System member is not a
   * System member, and `can()` refuses one too: the rule is enforced twice on
   * purpose.
   */
  const member = await findStaff(db, chatId);
  if (member === null) {
    await logInteraction(db, chatId, STAFF_DENIED, text, state);
    return null;
  }

  if (command.capability !== null && !can(member, command.capability)) {
    await logInteraction(db, chatId, STAFF_DENIED, text, state);
    return reply(chatId, refusalText(command.name, command.capability, member.role));
  }

  return command.handle({
    db,
    member,
    scope: scopeOf(member),
    rest: parsed.rest,
    deps,
  });
}

/**
 * One tap on a staff-management menu — Part 5H.3.
 *
 * It lives here rather than beside the menus it draws, and the reason is worth
 * keeping: the acting taps run by handing the equivalent typed command to
 * `routeStaffCommand` **above**, and `staff.ts` cannot call that without a cycle
 * — this file already imports its commands. The cycle was telling the truth, so
 * `staff.ts` decides what should happen and this decides nothing except how to
 * carry it out.
 *
 * **The consequence is the safety argument for the whole part.** A tap that
 * changes somebody's rank is not merely *as* authorised as `/staff_role`; it
 * **is** `/staff_role`, so the refusal that protects the last active System
 * member, the notice sent to the person whose access changed, and the audit row
 * written in the same transaction all come from the one place that has ever had
 * them. There is no second implementation to drift.
 *
 * The gate here is the same shape as the dispatcher's above: no active staff row
 * is answered with silence, because a reply saying "you are not staff" tells a
 * stranger the button they guessed at is real; a rank too low is answered
 * plainly, because they can see the button and would otherwise keep tapping it.
 */
export async function routeStaffMenu(
  db: Database,
  chatId: string,
  parts: readonly string[],
  state: ConversationState | null,
  deps: RouterDeps,
): Promise<RouterOutcome | null> {
  const member = await findStaff(db, chatId);
  if (member === null) {
    await logInteraction(db, chatId, STAFF_DENIED, 'staff menu', state);
    return null;
  }

  if (!can(member, CAPABILITY.STAFF_MANAGE)) {
    await logInteraction(db, chatId, STAFF_DENIED, 'staff menu', state);
    return reply(chatId, refusalText('/staff', CAPABILITY.STAFF_MANAGE, member.role));
  }

  const step = await staffMenuView(db, chatId, parts);
  if (step.kind === 'show') return step.outcome;

  const done = await routeStaffCommand(db, chatId, step.command, state, deps);
  if (done === null) return null;

  /**
   * The command's own answer first, then the list again.
   *
   * The first message is the one that says what changed, or refuses with a
   * reason — including the refusals only the command knows, like the last active
   * System member keeping their rank. The list follows so the next change does
   * not need `/staff` retyped, which is the entire point of the part.
   */
  const list = await staffMenuList(db, chatId);
  return {
    messages: [...done.messages, ...list.messages],
    alerts: [...done.alerts, ...list.alerts],
  };
}

/**
 * One tap on a case menu.
 *
 * It lives here rather than beside the menu it draws, for `routeStaffMenu`'s
 * reason: the acting taps run by handing the equivalent typed command to
 * `routeStaffCommand` above, and `case-menu.ts` cannot call that without a
 * cycle. **The consequence is the safety argument for the whole part.** A tap
 * that closes a case is not merely *as* authorised as `/close`; it **is**
 * `/close`, so the refusal on an already-finished case, the warning when a
 * teacher can no longer read the message, and the row recording who did it all
 * come from the one place that has ever had them.
 *
 * The gate is `case.view`, which is the least any of these needs — the action's
 * own capability is checked again inside `routeStaffCommand` when the command
 * runs, which is what refuses a Support member the owner button they were never
 * shown. Silence for no staff row, a plain answer for a rank too low: the same
 * shape as the dispatcher above, and for the same reasons.
 */
export async function routeCaseMenu(
  db: Database,
  chatId: string,
  parts: readonly string[],
  state: ConversationState | null,
  deps: RouterDeps,
): Promise<RouterOutcome | null> {
  const member = await findStaff(db, chatId);
  if (member === null) {
    await logInteraction(db, chatId, STAFF_DENIED, 'case menu', state);
    return null;
  }

  if (!can(member, CAPABILITY.CASE_VIEW)) {
    await logInteraction(db, chatId, STAFF_DENIED, 'case menu', state);
    return reply(chatId, refusalText('/case', CAPABILITY.CASE_VIEW, member.role));
  }

  const step = await caseMenuView(db, chatId, scopeOf(member), parts);
  if (step.kind === 'show') return step.outcome;

  /**
   * Asked for words. The state is written here rather than inside the view, so
   * that every write in this path happens in the same place — and so that a
   * refusal above this line can never leave a chat waiting for a message nobody
   * asked it for.
   */
  if (step.kind === 'ask') {
    await saveState(db, chatId, {
      kind: 'AwaitingCaseText',
      action: step.action,
      reference: step.reference,
    });
    return step.outcome;
  }

  const done = await routeStaffCommand(db, chatId, step.command, state, deps);
  if (done === null) return null;

  /**
   * The command's answer first, then the case again.
   *
   * The first message says what changed, or refuses with a reason only the
   * command knows. The case follows so the next action is another tap rather
   * than another `/cases` — which is the entire point of the part.
   *
   * `/mycases` is the one exception: it *is* a list, so re-showing a case after
   * it would be showing a case nobody asked for.
   */
  if (step.command === '/mycases') return done;

  const [reference = ''] = parts;
  const again = await routeStaffCommand(db, chatId, `/case ${reference}`, state, deps);

  return {
    messages: [...done.messages, ...(again?.messages ?? [])],
    alerts: [...done.alerts, ...(again?.alerts ?? [])],
  };
}

/**
 * The add-somebody flow.
 *
 * `staff.manage` floors at Program and is checked here before anything is shown,
 * so somebody who guesses the payload is refused at the first step rather than
 * after choosing a rank. It is checked again inside `/staff_add` when the last
 * tap runs — the rule is enforced twice on purpose, exactly as it is for every
 * other staff button.
 */
export async function routeStaffAdd(
  db: Database,
  chatId: string,
  parts: readonly string[],
  state: ConversationState | null,
  deps: RouterDeps,
): Promise<RouterOutcome | null> {
  const member = await findStaff(db, chatId);
  if (member === null) {
    await logInteraction(db, chatId, STAFF_DENIED, 'staff add', state);
    return null;
  }

  if (!can(member, CAPABILITY.STAFF_MANAGE)) {
    await logInteraction(db, chatId, STAFF_DENIED, 'staff add', state);
    return reply(chatId, refusalText('/staff_add', CAPABILITY.STAFF_MANAGE, member.role));
  }

  const step = staffAddView(chatId, parts);

  if (step.kind === 'ask') {
    await saveState(db, chatId, { kind: 'AwaitingStaffId' });
    return step.outcome;
  }
  if (step.kind === 'show') return step.outcome;

  const done = await routeStaffCommand(db, chatId, step.command, state, deps);
  if (done === null) return null;

  const list = await staffMenuList(db, chatId);
  return {
    messages: [...done.messages, ...list.messages],
    alerts: [...done.alerts, ...list.alerts],
  };
}

/**
 * A staff member's next message, when they were asked for one.
 *
 * **It runs ahead of the command dispatcher, which nothing else does**, and that
 * is the decision this mechanism turns on: a reply beginning with `/close` is
 * the words, not a command. Matched as a command it would be refused for having
 * no reference, and the staff member's sentence would be gone.
 *
 * The cost is that no command works while the bot is waiting. There are three
 * ways out and all are cheap — the Cancel button, `/cancel`, and the ordinary
 * thirty-minute expiry that needs nobody to remember it.
 *
 * `null` means "this is not somebody in a writing state", and the router carries
 * on exactly as it did. That includes a chat whose staff row has gone since the
 * state was written, which is why the row is re-read rather than assumed.
 */
export async function routeStaffWriting(
  db: Database,
  chatId: string,
  text: string,
  state: ConversationState | null,
  deps: RouterDeps,
): Promise<RouterOutcome | null> {
  if (state === null) return null;
  if (state.kind !== 'AwaitingCaseText' && state.kind !== 'AwaitingStaffId') return null;

  const member = await findStaff(db, chatId);
  if (member === null) {
    // Their staff row went while they were typing. Forget the state rather than
    // leaving a chat that swallows every message it sends.
    await clearState(db, chatId);
    return null;
  }

  if (text.trim().toLowerCase() === '/cancel') {
    await clearState(db, chatId);
    return reply(
      chatId,
      state.kind === 'AwaitingStaffId'
        ? 'Cancelled. Nobody was added.'
        : `Cancelled. Nothing was changed on ${state.reference}.`,
    );
  }

  /**
   * Cleared before anything runs, on every path, and that ordering is the point.
   * A command that throws would otherwise leave the chat still waiting, and the
   * staff member's next message — quite possibly "what happened?" — would be
   * sent to a teacher.
   */
  await clearState(db, chatId);

  /**
   * The typed chat id. It is not validated here: `/staff_add` already refuses a
   * value that is not a chat id, and `addStaff` already answers a row that
   * exists. Validating here would be the second copy of both.
   */
  if (state.kind === 'AwaitingStaffId') {
    return routeStaffAdd(db, chatId, [text.trim()], null, deps);
  }

  const done = await routeStaffCommand(
    db,
    chatId,
    commandForCaseText(state.action, state.reference, text),
    null,
    deps,
  );
  if (done === null) return null;

  const again = await routeStaffCommand(db, chatId, `/case ${state.reference}`, null, deps);
  return {
    messages: [...done.messages, ...(again?.messages ?? [])],
    alerts: [...done.alerts, ...(again?.alerts ?? [])],
  };
}

/**
 * Why the refusal happened, in terms the person can act on.
 *
 * Naming the rank needed turns "you may not" into "ask a System member", which
 * is a request somebody can make. The floor comes from the same table that
 * refused them, so the explanation cannot drift from the rule.
 */
function refusalText(name: string, capability: Capability, role: string): string {
  return [
    `${name} is not available at your rank.`,
    '',
    `It needs ${floorFor(capability)} or above. Yours is ${role}.`,
    '',
    'Type /whoami to see everything you can do.',
  ].join('\n');
}

/**
 * The staff half of `/help`, or nothing at all.
 *
 * `null` for anyone who is not active staff, and the caller shows them the
 * ordinary teacher help unchanged. `Webhook.gs:249` had the same rule for the
 * same reason: a teacher offered `/close` is a teacher who will type it, and
 * then be refused by a bot that had just suggested it.
 */
export async function staffHelpSection(db: Database, chatId: string): Promise<string | null> {
  const member = await findStaff(db, chatId);
  if (member === null) return null;

  return [
    `Staff commands — ${member.role}, ${member.queue} queue`,
    ...describeCapabilities(capabilitiesFor(member.role)),
    '/whoami — your rank, queue and regions',
    /**
     * Listed here rather than under a capability, because it has none: every
     * active staff member may set their own handle and nobody may set anybody
     * else's (D47). A command gated by `capability: null` has no row in the
     * capability table to be described from, so this is the one place it can be
     * advertised — and a command teachers are told about but staff are not is a
     * command nobody uses.
     */
    '/username — publish your Telegram handle to teachers in your region',
  ].join('\n');
}
