/**
 * Signing a teacher in against the roster. Implements D1 and D3.
 *
 * Two decisions live here and both are deliberate inversions of what a first
 * guess would do:
 *
 *   D1 — a second Telegram account presenting an identity that is already bound
 *   is ALLOWED, and reported. Blocking it locks out any teacher who changes
 *   phone, with no command in stage 3 to release them, and hands anyone holding
 *   a leaked recruitment email the power to lock the real teacher out for good.
 *
 *   D3 — failed attempts are counted in the conversation state, which expires.
 *   Five typos pause a teacher for the rest of the window rather than durably,
 *   because no command exists yet to unlock one.
 *
 * This function does no locking and opens no transaction. It is called under
 * `withChatLock`, which is already a transaction — one lock, taken in one place.
 * Opening another here would be a savepoint pretending to be a commit.
 */
import { MAX_VERIFICATION_ATTEMPTS } from '../config/constants.js';
import { PRIVACY_NOTICE_VERSION } from '../config/privacy.js';
import type { Database } from '../db/index.js';
import { normaliseIdentifier } from '../sheets/parse.js';
import { bindTeacher, findOtherHolders, findRosterEntry, findTeacher } from './repository.js';

export type VerificationOutcome =
  | {
      readonly kind: 'verified';
      readonly identifier: string;
      readonly name: string;
      readonly region: string | null;
      /**
       * Chats that already held this identity — empty in the ordinary case.
       *
       * When it is not empty the caller MUST raise an operational alert and tell
       * each prior holder, *after* its transaction commits. It is returned rather
       * than sent from here because sending inside the caller's open transaction
       * would announce a binding that can still be rolled back.
       */
      readonly priorHolders: readonly string[];
    }
  | {
      readonly kind: 'refused';
      /**
       * `accessRevoked` is not a failed sign-in and is never counted as one.
       * It is a chat that already holds a roster identity and has had it taken
       * away by a named person — see the refusal below.
       */
      readonly reason: 'notOnRoster' | 'rosterRowDeactivated' | 'accessRevoked';
      /** False when this chat is re-presenting the identity it already holds. */
      readonly consumedAttempt: boolean;
      readonly attempts: number;
      readonly attemptsRemaining: number;
    }
  | { readonly kind: 'lockedOut'; readonly attempts: number };

/**
 * @param attemptsSoFar failures already recorded in this conversation state. The
 * caller owns the counter, because the counter's lifetime is the conversation's
 * (D3) — storing it on the teacher row would make five typos permanent.
 */
export async function verifyIdentifier(
  db: Database,
  chatId: string,
  rawIdentifier: string,
  attemptsSoFar: number,
): Promise<VerificationOutcome> {
  const identifier = normaliseIdentifier(rawIdentifier);
  const teacher = await findTeacher(db, chatId);

  /**
   * Re-presenting the identity this chat already holds is not a guess, so it
   * never costs an attempt. Without this distinction an administrator correcting
   * a roster row can lock out the very teacher they are correcting: the row goes
   * inactive, the teacher retries, and five honest retries exhaust the budget.
   */
  const isOwnIdentity = identifier !== '' && teacher?.identifier === identifier;

  /**
   * A revoked chat cannot sign itself back in, whatever it types.
   *
   * `bindTeacher` below clears `revoked_at` and writes `Verified` — that is
   * correct for a teacher who changed phone, and catastrophic for one whose
   * access a staff member deliberately ended. Without this check, `/revoke` is
   * undone by typing an email address, and D27's `/restore` has no meaning
   * because nobody needs it.
   *
   * The routes into sign-in refuse a revoked chat before it gets this far
   * (`startReply` and `requireSignIn` both do). This is the guarantee rather
   * than the courtesy: it is at the one function that writes, so a fourth route
   * added in a later stage cannot reopen the hole, and it also covers the teacher
   * who was revoked *while* already sitting at the identifier prompt.
   *
   * It costs no attempt. Nothing was guessed — this chat is presenting an
   * identity, usually its own, and the answer would be the same every time.
   */
  if (teacher?.verificationState === 'Revoked') {
    return {
      kind: 'refused',
      reason: 'accessRevoked',
      consumedAttempt: false,
      attempts: attemptsSoFar,
      attemptsRemaining: Math.max(0, MAX_VERIFICATION_ATTEMPTS - attemptsSoFar),
    };
  }

  if (!isOwnIdentity && attemptsSoFar >= MAX_VERIFICATION_ATTEMPTS) {
    return { kind: 'lockedOut', attempts: attemptsSoFar };
  }

  const refuse = (reason: 'notOnRoster' | 'rosterRowDeactivated'): VerificationOutcome => {
    const attempts = isOwnIdentity ? attemptsSoFar : attemptsSoFar + 1;
    return {
      kind: 'refused',
      reason,
      consumedAttempt: !isOwnIdentity,
      attempts,
      attemptsRemaining: Math.max(0, MAX_VERIFICATION_ATTEMPTS - attempts),
    };
  };

  const roster = await findRosterEntry(db, identifier);
  if (roster === null) return refuse('notOnRoster');
  if (!roster.active) return refuse('rosterRowDeactivated');

  // Read who already holds this identity BEFORE binding, or this chat is in the
  // list and every verification looks like a duplicate.
  const priorHolders = await findOtherHolders(db, identifier, chatId);

  await bindTeacher(db, {
    chatId,
    identifier: roster.identifier,
    name: roster.name,
    region: roster.region,
    privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
  });

  return {
    kind: 'verified',
    identifier: roster.identifier,
    name: roster.name,
    region: roster.region,
    priorHolders,
  };
}
