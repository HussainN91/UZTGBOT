/**
 * Taking an urgent marking back — the one implementation, so that a typed
 * command added later cannot answer differently from the button.
 *
 * **It lives here rather than in `router.ts` for `dispute-actions.ts`'s reason,
 * and that reason is a real cycle rather than a preference.** `commands/index.ts`
 * imports every staff command and `router.ts` imports the dispatcher, so anything
 * both a button and a command need belongs in neither of them. Part 5H.3 and
 * Feature A each reached this conclusion the hard way.
 *
 * Layer 3. It composes layer-2 stores and returns messages; it sends nothing, and
 * `deliver` speaks only after the transaction commits.
 */
import { unmarkUrgent } from '../cases/urgent.js';
import type { Database } from '../db/index.js';
import { reply } from './commands/context.js';
import type { RouterOutcome } from './router.js';

/**
 * Undo a confirmed urgent marking and tell the few people it concerns.
 *
 * **Three people at most, and the teacher is never one of them (D8).** The person
 * who tapped is answered because they acted. The owner is told because their work
 * has just changed back, and they may be part-way through treating this as the
 * most important thing they have. Whoever marked it urgent is told because their
 * decision has been reversed, and hearing that from the bot is better than
 * noticing it in a list next week.
 *
 * **Nobody else, and that is a judgement rather than an instruction.** The
 * oversight group is told when a case is *marked* urgent, because one person can
 * do that alone with no second signature. Telling all of them about every
 * reversal as well would rebuild the noise this whole change exists to remove.
 * The head of project was asked to overrule this if they wanted it symmetrical.
 */
export async function unmarkAndAnnounce(
  db: Database,
  actorChatId: string,
  reference: string,
): Promise<RouterOutcome> {
  const outcome = await unmarkUrgent(db, reference, actorChatId);

  if (outcome.kind === 'unknown') {
    return reply(actorChatId, `I cannot find ${reference}.`);
  }

  if (outcome.kind === 'notUrgent') {
    return reply(actorChatId, `${reference} is not marked urgent, so there is nothing to take back.`);
  }

  if (outcome.kind === 'closed') {
    /**
     * The one refusal here that is about data rather than permission, and it is
     * worded for somebody who has never heard of a retention period.
     */
    return reply(
      actorChatId,
      [
        `${reference} is closed, so its priority was left as it is.`,
        '',
        'How long a closed case is kept depends on its priority, so changing it now',
        'could bring forward the day it is deleted. Reopen the case first if you',
        'need to change this.',
      ].join('\n'),
    );
  }

  /**
   * Deduplicated, and the person who tapped is removed rather than the others.
   * On a small team the owner is very often also the person who marked it, and
   * two identical messages a second apart is how somebody learns to ignore both.
   */
  const alsoTold = [...new Set([outcome.owner, outcome.wasConfirmedBy])].filter(
    (chatId): chatId is string => chatId !== null && chatId !== actorChatId,
  );

  return {
    messages: [
      {
        chatId: actorChatId,
        text: [
          `${reference} is back to normal priority.`,
          '',
          `It is at ${outcome.status} again and has left /urgent. The teacher has not been told.`,
        ].join('\n'),
      },
      ...alsoTold.map((chatId) => ({
        chatId,
        text: [
          `${reference} is back to normal priority.`,
          '',
          `Changed by ${actorChatId}. It is at ${outcome.status} again.`,
        ].join('\n'),
        purpose: 'notice that an urgent marking was taken back',
      })),
    ],
    alerts: [],
  };
}
