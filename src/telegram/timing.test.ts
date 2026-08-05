/**
 * Measuring how long a call took, including when it failed.
 *
 * Pure unit tests. No database, no network, no real clock — the clock is
 * injected for the same reason `withRetry` injects its sleep: a test that waits
 * real seconds is a test somebody eventually deletes.
 */
import { describe, expect, it, vi } from 'vitest';
import { timed } from './timing.js';

/** A clock that advances by a fixed step on each read. */
function clockAdvancingBy(...steps: number[]): () => number {
  let at = 0;
  let index = 0;
  return () => {
    const now = at;
    at += steps[index] ?? 0;
    index += 1;
    return now;
  };
}

describe('timed', () => {
  it('returns the call’s value unchanged', async () => {
    const report = vi.fn();

    await expect(timed(async () => 'ok', clockAdvancingBy(120), report)).resolves.toBe('ok');
  });

  it('reports how long a successful call took', async () => {
    const report = vi.fn();

    await timed(async () => 'ok', clockAdvancingBy(214), report);

    expect(report).toHaveBeenCalledWith(214, 'ok');
  });

  /**
   * The case this exists for.
   *
   * A stall is a call that does not come back, and a call that does not come
   * back eventually throws. Reporting only on success would measure everything
   * except the thing being investigated.
   */
  it('reports how long a failing call took, and still throws', async () => {
    const report = vi.fn();
    const call = async (): Promise<never> => {
      throw new Error('stalled');
    };

    await expect(timed(call, clockAdvancingBy(15_000), report)).rejects.toThrow('stalled');

    expect(report).toHaveBeenCalledWith(15_000, 'failed');
  });

  it('reports exactly once per call', async () => {
    const report = vi.fn();

    await timed(async () => 'ok', clockAdvancingBy(10), report);

    expect(report).toHaveBeenCalledTimes(1);
  });

  /**
   * A reporter that throws must not turn a working call into a failed one.
   * This is instrumentation; it observes the bot, it does not get to break it.
   */
  it('does not let a failing reporter break the call', async () => {
    const report = (): never => {
      throw new Error('the log is broken');
    };

    await expect(timed(async () => 'ok', clockAdvancingBy(10), report)).resolves.toBe('ok');
  });

  it('does not let a failing reporter hide the call’s own error', async () => {
    const report = (): never => {
      throw new Error('the log is broken');
    };
    const call = async (): Promise<never> => {
      throw new Error('stalled');
    };

    await expect(timed(call, clockAdvancingBy(10), report)).rejects.toThrow('stalled');
  });
});
