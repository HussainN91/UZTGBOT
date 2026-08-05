/**
 * Retrying a Telegram call that never got there.
 *
 * Measured on the live server on 3 August 2026: from inside the container,
 * Cloudflare and Google answered 40 calls each with no stall at all, while
 * Telegram produced a 21-second hang in the same minute. The path to Telegram
 * intermittently stops completing, and nothing on our side can mend somebody
 * else's route. What we can control is how long the bot waits before deciding
 * it is not coming, and whether it tries again.
 *
 * Pure unit tests. No database, no network, no clock.
 */
import { describe, expect, it, vi } from 'vitest';
import { withRetry } from './api-retry.js';

const never = (): boolean => false;
const always = (): boolean => true;
const noSleep = async (): Promise<void> => {};

describe('withRetry', () => {
  it('calls once and returns when the call succeeds', async () => {
    const call = vi.fn(async () => 'ok');

    await expect(withRetry(call, { attempts: 3, backoffMs: 10 }, always, noSleep)).resolves.toBe(
      'ok',
    );
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('tries again after a failure it is told to retry, and returns the later success', async () => {
    // The shape the measurement actually found: one call stalls, and a fresh
    // one straight afterwards succeeds in about 230ms.
    let calls = 0;
    const call = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('stalled');
      return 'ok';
    });

    await expect(withRetry(call, { attempts: 3, backoffMs: 10 }, always, noSleep)).resolves.toBe(
      'ok',
    );
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('does not retry a failure it is told to leave alone', async () => {
    /**
     * The distinction that matters most here. A network failure means the
     * request never arrived and trying again is free. Telegram *answering* with
     * an error means it arrived and was refused, and repeating it just asks a
     * question that has already been answered.
     */
    const call = vi.fn(async () => {
      throw new Error('Telegram said no');
    });

    await expect(
      withRetry(call, { attempts: 5, backoffMs: 10 }, never, noSleep),
    ).rejects.toThrow('Telegram said no');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('gives up after the last attempt and reports the final failure', async () => {
    const call = vi.fn(async () => {
      throw new Error('still stalled');
    });

    await expect(
      withRetry(call, { attempts: 3, backoffMs: 10 }, always, noSleep),
    ).rejects.toThrow('still stalled');
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('waits between attempts, and not after the last one', async () => {
    // A retry that fires instantly against a stalled route is a retry into the
    // same stall. The wait is not politeness; it is what gives the path a
    // moment to come back.
    const slept: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      slept.push(ms);
    };
    const call = async (): Promise<never> => {
      throw new Error('nope');
    };

    await expect(
      withRetry(call, { attempts: 3, backoffMs: 250 }, always, sleep),
    ).rejects.toThrow('nope');

    // Two waits for three attempts. Sleeping after the final failure would add
    // delay to a call that has already given up.
    expect(slept).toEqual([250, 500]);
  });

  /**
   * A retry that works used to leave no trace whatsoever.
   *
   * That is the shape of the slowness teachers were reporting: the call stalls,
   * the second attempt succeeds, the teacher waits fifteen seconds and the bot
   * records a perfectly ordinary reply. The invisible case was the common one.
   */
  it('reports each retry it makes, with the attempt that failed', async () => {
    const retries: number[] = [];
    const call = vi.fn(async () => {
      throw new Error('stalled');
    });

    await expect(
      withRetry(call, { attempts: 3, backoffMs: 10 }, always, noSleep, (attempt) => {
        retries.push(attempt);
      }),
    ).rejects.toThrow('stalled');

    // Two reports for three attempts: the third has nothing after it to try.
    expect(retries).toEqual([1, 2]);
  });

  it('reports nothing when the call succeeds first time', async () => {
    const onRetry = vi.fn();

    await withRetry(async () => 'ok', { attempts: 3, backoffMs: 10 }, always, noSleep, onRetry);

    expect(onRetry).not.toHaveBeenCalled();
  });

  it('does not report a retry it is not going to make', async () => {
    // A refusal from Telegram is not retried, so nothing should claim it was.
    const onRetry = vi.fn();
    const call = async (): Promise<never> => {
      throw new Error('Telegram said no');
    };

    await expect(
      withRetry(call, { attempts: 3, backoffMs: 10 }, never, noSleep, onRetry),
    ).rejects.toThrow('Telegram said no');

    expect(onRetry).not.toHaveBeenCalled();
  });

  it('hands the reporter the error that caused the retry', async () => {
    const seen: unknown[] = [];
    const boom = new Error('stalled');
    let calls = 0;
    const call = async (): Promise<string> => {
      calls += 1;
      if (calls === 1) throw boom;
      return 'ok';
    };

    await withRetry(call, { attempts: 3, backoffMs: 10 }, always, noSleep, (_attempt, err) => {
      seen.push(err);
    });

    expect(seen).toEqual([boom]);
  });

  it('does not let a failing reporter break the retry', async () => {
    // Instrumentation does not get to break the thing it is watching.
    let calls = 0;
    const call = async (): Promise<string> => {
      calls += 1;
      if (calls === 1) throw new Error('stalled');
      return 'ok';
    };
    const onRetry = (): never => {
      throw new Error('the log is broken');
    };

    await expect(
      withRetry(call, { attempts: 3, backoffMs: 10 }, always, noSleep, onRetry),
    ).resolves.toBe('ok');
  });

  it('runs exactly once when only one attempt is allowed', async () => {
    const call = vi.fn(async () => {
      throw new Error('nope');
    });

    await expect(
      withRetry(call, { attempts: 1, backoffMs: 10 }, always, noSleep),
    ).rejects.toThrow('nope');
    expect(call).toHaveBeenCalledTimes(1);
  });
});
