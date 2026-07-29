/**
 * Where an alarm goes — D12.
 *
 * One rule, and everything below is a way of asserting it: the operations chat
 * is the **floor**, and System staff are added on top. Never one or the other.
 * Read alone, `alerts.ts` line 10 — "an alerter that messages System-role staff"
 * — reads like an instruction to replace the environment variable, and replacing
 * it would make every alarm depend on the staff table being right, including the
 * alarms about the staff table being wrong.
 *
 * No database and no network: the staff reader is injected and the Telegram API
 * is a stub that records what it was asked to send.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Api } from 'grammy';
import { resetEnvForTests } from '../config/env.js';
import { telegramAlerter } from './alerter.js';

const OPS = '-1001234567890';

/**
 * `env()` caches on first read, so changing `OPS_ALERT_CHAT_ID` between tests
 * needs the cache dropped as well — otherwise every test after the first would
 * silently assert against the first one's value.
 */
const REQUIRED_ENV = {
  DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
  TELEGRAM_BOT_TOKEN: '1234567:not-a-real-token-and-never-used-here',
  TELEGRAM_WEBHOOK_SECRET: 'x'.repeat(32),
  PUBLIC_URL: 'https://example.invalid',
  SUPPORT_CONTACT: '+998 71 000 0000',
};
const SYSTEM_ONE = '991001';
const SYSTEM_TWO = '991002';

interface Sent {
  readonly chatId: string;
  readonly text: string;
}

/** Records every send. `sendMessage` is the only method the alerter touches. */
const stubApi = (sent: Sent[], failFor: string[] = []): Api =>
  ({
    sendMessage: (chatId: string, text: string) => {
      if (failFor.includes(String(chatId))) throw new Error('Telegram said no');
      sent.push({ chatId: String(chatId), text });
      return Promise.resolve({ message_id: sent.length });
    },
  }) as unknown as Api;

const ALERT = { severity: 'critical' as const, title: 'Something broke', body: 'the details' };

describe('where an alarm goes', () => {
  let sent: Sent[];

  beforeEach(() => {
    sent = [];
    for (const [key, value] of Object.entries(REQUIRED_ENV)) process.env[key] = value;
    process.env['OPS_ALERT_CHAT_ID'] = OPS;
    resetEnvForTests();
  });

  afterEach(() => {
    for (const key of Object.keys(REQUIRED_ENV)) delete process.env[key];
    delete process.env['OPS_ALERT_CHAT_ID'];
    resetEnvForTests();
    vi.restoreAllMocks();
  });

  it('sends to the operations chat and to every active System member', async () => {
    const alerter = telegramAlerter(stubApi(sent), () => Promise.resolve([SYSTEM_ONE, SYSTEM_TWO]));

    await alerter.send(ALERT);

    expect(sent.map((s) => s.chatId)).toEqual([OPS, SYSTEM_ONE, SYSTEM_TWO]);
    expect(sent.every((s) => s.text.includes('Something broke'))).toBe(true);
  });

  it('still alerts when the staff table is empty', async () => {
    // The bootstrap case. Before the first System row exists — which is a
    // hand-written INSERT, D13 — the operations chat is the only recipient
    // there is, and RUNBOOK Part 3 step 8 treats its arrival as the proof that
    // the alerting path works at all.
    const alerter = telegramAlerter(stubApi(sent), () => Promise.resolve([]));

    await alerter.send(ALERT);

    expect(sent.map((s) => s.chatId)).toEqual([OPS]);
  });

  it('still alerts when the staff table cannot be read at all', async () => {
    // The case D12 is actually about. "The staff table is wrong" is a state
    // whose alarm must not depend on the staff table.
    const alerter = telegramAlerter(stubApi(sent), () => Promise.reject(new Error('database is down')));

    await alerter.send(ALERT);

    expect(sent.map((s) => s.chatId)).toEqual([OPS]);
  });

  it('reaches System staff even when the operations chat refuses the message', async () => {
    // The floor failing must not take the fan-out with it. This is the shape of
    // a mistyped OPS_ALERT_CHAT_ID, or the bot being removed from that group.
    const alerter = telegramAlerter(stubApi(sent, [OPS]), () => Promise.resolve([SYSTEM_ONE]));

    await alerter.send(ALERT);

    expect(sent.map((s) => s.chatId)).toEqual([SYSTEM_ONE]);
  });

  it('one unreachable System member does not cost the others theirs', async () => {
    // trySend rather than send, per recipient. A System member who has never
    // opened a chat with the bot cannot be messaged at all, and that is an
    // ordinary state rather than an incident.
    const alerter = telegramAlerter(stubApi(sent, [SYSTEM_ONE]), () =>
      Promise.resolve([SYSTEM_ONE, SYSTEM_TWO]),
    );

    await alerter.send(ALERT);

    expect(sent.map((s) => s.chatId)).toEqual([OPS, SYSTEM_TWO]);
  });

  it('does not send twice when a System member IS the operations chat', async () => {
    const alerter = telegramAlerter(stubApi(sent), () => Promise.resolve([OPS, SYSTEM_ONE]));

    await alerter.send(ALERT);

    expect(sent.map((s) => s.chatId)).toEqual([OPS, SYSTEM_ONE]);
  });

  it('reaches System staff when no operations chat is configured', async () => {
    // OPS_ALERT_CHAT_ID is optional outside production. The fan-out is not
    // conditional on it — that would make the floor a prerequisite rather than
    // a floor.
    delete process.env['OPS_ALERT_CHAT_ID'];
    resetEnvForTests();
    const alerter = telegramAlerter(stubApi(sent), () => Promise.resolve([SYSTEM_ONE]));

    await alerter.send(ALERT);

    expect(sent.map((s) => s.chatId)).toEqual([SYSTEM_ONE]);
  });

  it('never throws, whatever happens', async () => {
    // `neverThrows` wraps the whole thing, because an alerting failure must not
    // roll back the sync or the case that raised it.
    const alerter = telegramAlerter(stubApi(sent, [OPS, SYSTEM_ONE]), () =>
      Promise.resolve([SYSTEM_ONE]),
    );

    await expect(alerter.send(ALERT)).resolves.toBeUndefined();
  });
});
