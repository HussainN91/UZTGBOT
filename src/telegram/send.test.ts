import { GrammyError, HttpError } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import type { Api } from 'grammy';
import {
  TelegramSendError,
  classifyError,
  isRetryable,
  send,
  sendDocument,
  trySend,
} from './send.js';

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

describe('sendDocument', () => {
  const okDocApi = (messageId = 11) =>
    ({ sendDocument: vi.fn().mockResolvedValue({ message_id: messageId }) }) as unknown as Api;

  const failingDocApi = (err: unknown) =>
    ({ sendDocument: vi.fn().mockRejectedValue(err) }) as unknown as Api;

  it('returns the message id when Telegram confirms', async () => {
    await expect(sendDocument(okDocApi(11), '123', 'cases.csv', 'a,b\r\n')).resolves.toBe(11);
  });

  it('throws when Telegram refuses, exactly as send does', async () => {
    // A file that did not arrive must not look like one that did. The whole
    // reason `send` throws rather than returning {ok} applies unchanged here.
    const api = failingDocApi(apiError(403, 'Forbidden: bot was blocked by the user'));
    await expect(sendDocument(api, '123', 'x.csv', 'a')).rejects.toBeInstanceOf(TelegramSendError);
  });

  it('classifies its failures through the same function the text path uses', async () => {
    const api = failingDocApi(apiError(429, 'Too Many Requests', { retry_after: 12 }));
    await expect(sendDocument(api, '123', 'x.csv', 'a')).rejects.toMatchObject({
      failure: { kind: 'rate_limited', retryAfterSeconds: 12 },
    });
  });

  it('sends the filename and the bytes, not a path', () => {
    // Nothing is written to disk. An export is built in memory and handed
    // straight to Telegram — a temporary file is a copy of case data sitting on
    // a server with no retention rule of its own.
    const api = okDocApi();
    void sendDocument(api, '123', 'cases-2026-07-30.csv', 'a,b\r\n', 'Cases you can see');
    const [, document] = (api.sendDocument as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(document).toMatchObject({ filename: 'cases-2026-07-30.csv' });
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
