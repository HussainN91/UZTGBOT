import { GrammyError, HttpError } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import type { Api } from 'grammy';
import { TelegramSendError, classifyError, isRetryable, send, trySend } from './send.js';

/** Build the error shape grammY raises for a given Telegram API response. */
function apiError(error_code: number, description: string, parameters: Record<string, unknown> = {}) {
  return new GrammyError(
    'Call to sendMessage failed',
    { ok: false, error_code, description, parameters },
    'sendMessage',
    {},
  );
}

const okApi = (messageId = 42) =>
  ({ sendMessage: vi.fn().mockResolvedValue({ message_id: messageId }) }) as unknown as Api;

const failingApi = (err: unknown) =>
  ({ sendMessage: vi.fn().mockRejectedValue(err) }) as unknown as Api;

describe('send throws rather than letting a caller assume delivery', () => {
  it('returns the message id when Telegram confirms', async () => {
    await expect(send(okApi(7), '123', 'hello')).resolves.toBe(7);
  });

  it('throws when Telegram refuses, so an unchecked call cannot report success', async () => {
    const api = failingApi(apiError(403, 'Forbidden: bot was blocked by the user'));
    await expect(send(api, '123', 'hello')).rejects.toBeInstanceOf(TelegramSendError);
  });

  it('carries the classified reason on the thrown error', async () => {
    const api = failingApi(apiError(403, 'Forbidden: bot was blocked by the user'));
    await expect(send(api, '123', 'hi')).rejects.toMatchObject({
      chatId: '123',
      failure: { kind: 'blocked' },
    });
  });
});

describe('trySend reports the outcome for bulk delivery', () => {
  it('reports success without throwing', async () => {
    await expect(trySend(okApi(9), '123', 'hello')).resolves.toEqual({ ok: true, messageId: 9 });
  });

  it('reports failure without throwing, so one bad recipient cannot abort a broadcast', async () => {
    const result = await trySend(failingApi(apiError(403, 'blocked')), '123', 'hello');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('blocked');
  });
});

describe('classifying failures decides retry or write-off', () => {
  it('treats a blocked bot as permanent', () => {
    const failure = classifyError(apiError(403, 'Forbidden: bot was blocked by the user'));
    expect(failure.kind).toBe('blocked');
    expect(isRetryable(failure)).toBe(false);
  });

  it('treats a deactivated account as permanent', () => {
    expect(classifyError(apiError(403, 'Forbidden: user is deactivated')).kind).toBe('blocked');
  });

  it('treats an unknown chat as permanent', () => {
    expect(classifyError(apiError(400, 'Bad Request: chat not found')).kind).toBe('chat_not_found');
  });

  it('extracts the wait from a rate limit and marks it retryable', () => {
    const failure = classifyError(apiError(429, 'Too Many Requests', { retry_after: 17 }));
    expect(failure).toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 17 });
    expect(isRetryable(failure)).toBe(true);
  });

  it('treats a Telegram outage as retryable', () => {
    expect(isRetryable(classifyError(apiError(502, 'Bad Gateway')))).toBe(true);
  });

  it('treats a network failure as retryable', () => {
    const failure = classifyError(new HttpError('network down', new Error('ECONNRESET')));
    expect(failure.kind).toBe('transient');
    expect(isRetryable(failure)).toBe(true);
  });

  it('does not retry a request Telegram considers malformed', () => {
    const failure = classifyError(apiError(400, 'Bad Request: message text is empty'));
    expect(failure.kind).toBe('other');
    expect(isRetryable(failure)).toBe(false);
  });

  it('survives something that is not an Error at all', () => {
    expect(classifyError('exploded').kind).toBe('other');
  });
});
