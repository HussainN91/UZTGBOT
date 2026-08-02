/**
 * Settling an identity dispute — the one implementation, shared by two callers.
 *
 * **It lives here rather than in `router.ts` because of a cycle, and the cycle
 * was telling the truth.** `commands/index.ts` imports every staff command, and
 * `router.ts` imports the dispatcher — so `/dispute_resolve` cannot reach into
 * the router without closing a loop. Part 5H.3 hit exactly this and drew exactly
 * this conclusion: the thing both a button and a typed command need belongs in
 * neither of them.
 *
 * **The consequence is the safety argument.** Settling by button is not merely
 * *as* careful as `/dispute_resolve`; it **is** `/dispute_resolve`. The refusal
 * for a chat that is not a party, the no-op on a second tap, the revocations, the
 * closed cases, the audit row and the messages to every party all come from the
 * one function that has ever had them, so there is no second implementation to
 * drift.
 *
 * Layer 3. It composes layer-2 stores and returns messages; it sends nothing, and
 * `deliver` speaks only after the transaction commits.
 */
import type { Database } from '../db/index.js';
import { disputeResolvedMessages } from '../teachers/dispute-notify.js';
import { resolveDispute } from '../teachers/disputes.js';
import { reply } from './commands/context.js';
import type { RouterOutcome } from './router.js';

export interface SettleDisputeRequest {
  readonly disputeId: number;
  readonly keptChatId: string;
  readonly actor: string;
  readonly outcome: string;
  readonly supportContact: string;
}

/**
 * Settle a dispute and say so to everybody who needs to hear it.
 *
 * Shared by the button and by `/dispute_resolve`, so the two cannot drift: the
 * refusals, the revocations, the closed cases and the messages to the parties all
 * come from one place, exactly as Part 5H.3's menu taps run the typed command
 * rather than a copy of it.
 */
export async function settleAndAnnounce(
  db: Database,
  actorChatId: string,
  request: SettleDisputeRequest,
): Promise<RouterOutcome> {
  const outcome = await resolveDispute(db, {
    disputeId: request.disputeId,
    keptChatId: request.keptChatId,
    actor: request.actor,
    outcome: request.outcome,
    closingNote:
      'Closed because the Ministry confirmed this account is not the one registered '
      + `to this teacher. If you believe that is wrong, contact ${request.supportContact}.`,
  });

  if (outcome.kind === 'unknown') {
    return reply(
      actorChatId,
      `I cannot find dispute ${String(request.disputeId)}.\n\n/disputes lists everything still waiting.`,
    );
  }

  if (outcome.kind === 'notAParty') {
    return reply(
      actorChatId,
      `${request.keptChatId} is not one of the accounts in dispute ${String(request.disputeId)}.\n\n`
        + 'The chat id has to be one of the accounts claiming the identity, and it is the '
        + 'one that KEEPS it. /disputes shows which they are.',
    );
  }

  if (outcome.kind === 'alreadyResolved') {
    return reply(
      actorChatId,
      `Dispute ${String(request.disputeId)} is already settled.\n\n`
        + `The account kept was ${outcome.keptChatId ?? 'not recorded'}. Nothing has changed and `
        + 'nobody has been told again.',
    );
  }

  const told = disputeResolvedMessages({
    keptChatId: outcome.keptChatId,
    revoked: outcome.revoked,
    closedCases: outcome.closedCases,
    supportContact: request.supportContact,
  });

  return {
    messages: [
      {
        chatId: actorChatId,
        text: [
          `✅ Dispute ${String(request.disputeId)} is settled.`,
          '',
          `${outcome.keptChatId} keeps the account.`,
          outcome.revoked.length === 0
            ? 'No other account had to be revoked.'
            : `Revoked: ${outcome.revoked.join(', ')}.`,
          outcome.closedCases.length === 0
            ? 'They had no open cases.'
            : `Closed ${String(outcome.closedCases.length)} case${outcome.closedCases.length === 1 ? '' : 's'}: ${outcome.closedCases.join(', ')}.`,
          '',
          'Everyone involved has been told. /restore undoes a revocation; the closed',
          'cases stay closed.',
        ].join('\n'),
      },
      ...told.messages,
    ],
    alerts: told.alerts,
  };
}
