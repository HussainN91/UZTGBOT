/**
 * How long a call took — the number this system did not have.
 *
 * On 5 August 2026 the web process had written four lines in forty-eight hours,
 * all of them start-up messages. It had been answering teachers throughout and
 * had recorded nothing about any of it. So when a teacher reported waiting
 * eleven seconds for a reply there was no way to tell whether the wait was
 * Telegram delivering the message to us, our database, our own handling, or our
 * reply going back out. Every answer was a guess.
 *
 * The stalls this is pointed at are intermittent — a hundred calls measured on
 * the live server on 5 August found no stall at all, on a route that produced a
 * twenty-second hang two days earlier. Something that happens a few times a day
 * cannot be caught by looking; it has to be recorded while nobody is looking.
 *
 * **Nothing here talks to the network, reads a clock or writes a log.** It takes
 * a call, a clock and a reporter, exactly as `withRetry` takes a sleep, so it
 * can be tested without any of the three.
 */

/** What happened to the call, as the reporter is told it. */
export type TimedOutcome = 'ok' | 'failed';

/**
 * Run `call`, and report how long it took.
 *
 * **Reported on failure as well as on success, which is the whole point.** A
 * stall is a call that never comes back, and a call that never comes back
 * eventually throws. Timing only the successes would measure everything except
 * the thing being investigated.
 *
 * The value and the error both pass through untouched. A reporter that throws is
 * swallowed: this observes the bot, it does not get to break it — a broken log
 * line must never be the reason a teacher goes unanswered.
 */
export async function timed<T>(
  call: () => Promise<T>,
  now: () => number,
  report: (ms: number, outcome: TimedOutcome) => void,
): Promise<T> {
  const startedAt = now();

  const tell = (outcome: TimedOutcome): void => {
    try {
      report(now() - startedAt, outcome);
    } catch {
      // Deliberately silent. There is nowhere left to complain to — the thing
      // that failed is the thing that would carry the complaint.
    }
  };

  try {
    const result = await call();
    tell('ok');
    return result;
  } catch (err) {
    tell('failed');
    throw err;
  }
}
