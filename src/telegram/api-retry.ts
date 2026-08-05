/**
 * Trying a Telegram call again when it never reached Telegram.
 *
 * **Measured before it was written**, on the live server on 3 August 2026, from
 * inside the running container. Cloudflare and Google each answered 40 calls
 * with no stall at all; Telegram produced a 21-second hang in the same minute,
 * and a 60-second failure in an earlier sample. The server itself was idle,
 * there was no packet loss to Telegram, DNS resolved in a millisecond and TCP
 * connected in ninety. The path to Telegram simply stops completing now and
 * then, and no setting on this server can mend somebody else's route.
 *
 * What this file controls is the part that *is* ours: how long the bot waits
 * before deciding the answer is not coming, and whether it asks again.
 *
 * **Nothing here is Telegram-specific and nothing here talks to the network.**
 * It takes a function, a policy, a predicate and a sleep, so it can be tested
 * without either. `bot.ts` supplies the Telegram-flavoured parts.
 */

export interface RetryPolicy {
  /** Total attempts including the first. `1` means never retry. */
  readonly attempts: number;
  /**
   * The wait before the second attempt, doubled for each one after that.
   *
   * A retry that fires instantly against a stalled route is a retry into the
   * same stall, so the wait is what gives the path a moment to recover rather
   * than politeness towards Telegram.
   */
  readonly backoffMs: number;
}

/**
 * Run `call`, retrying while `shouldRetry` says the failure is worth repeating.
 *
 * **`shouldRetry` is the whole safety argument, and the caller owns it.** A
 * network failure means the request never arrived, so asking again costs
 * nothing and risks nothing. Telegram *answering* with an error means the
 * request did arrive and was refused, and repeating it only asks a question
 * that has already been answered — at best wasted, at worst a second identical
 * message to a teacher.
 *
 * `sleep` is injected for the same reason the predicate is: a test that waits
 * real seconds is a test somebody eventually deletes.
 *
 * `onRetry` is optional and exists because a retry that *works* used to leave no
 * trace at all. A stalled call that succeeded on the second attempt cost a
 * teacher fifteen seconds and was recorded nowhere, so the commonest form of the
 * slowness people were reporting was also the invisible one. It is a callback
 * rather than a log line for the same reason the sleep is injected: nothing in
 * this file may reach for the network, the clock or the logger.
 *
 * It is called after the decision to retry and before the wait, so a run that
 * has given up does not claim it is trying again. A reporter that throws is
 * swallowed — instrumentation does not get to break the thing it is watching.
 */
export async function withRetry<T>(
  call: () => Promise<T>,
  policy: RetryPolicy,
  shouldRetry: (err: unknown) => boolean,
  sleep: (ms: number) => Promise<void>,
  onRetry?: (attempt: number, err: unknown) => void,
): Promise<T> {
  let wait = policy.backoffMs;
  let last: unknown;

  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    try {
      return await call();
    } catch (err) {
      last = err;

      /**
       * Stop on the last attempt without sleeping first.
       *
       * Sleeping after a failure nobody will act on adds delay to a call that
       * has already given up, and the caller is usually a teacher waiting.
       */
      if (attempt === policy.attempts || !shouldRetry(err)) break;

      try {
        onRetry?.(attempt, err);
      } catch {
        // Deliberately silent; see the note on `onRetry` above.
      }

      await sleep(wait);
      wait *= 2;
    }
  }

  throw last;
}
