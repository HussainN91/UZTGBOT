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
import type { ConversationState } from '../../conversation/state.js';
import type { Database } from '../../db/index.js';
import { logInteraction } from '../../log/interactions.js';
import { findStaff } from '../../staff/repository.js';
import { type Capability, can, capabilitiesFor, floorFor } from '../../staff/roles.js';
import type { RouterDeps, RouterOutcome } from '../router.js';
import {
  type StaffCommand,
  type StaffContext,
  describeCapabilities,
  reply,
  scopeOf,
} from './context.js';
import { parseCommand } from './parse.js';
import { whoami } from './staff.js';

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
export const STAFF_COMMANDS: readonly StaffCommand[] = [whoami];

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
  ].join('\n');
}
