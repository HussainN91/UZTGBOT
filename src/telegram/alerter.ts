/**
 * Delivering operational alarms to a person.
 *
 * The concerns register records that errors went to a log nobody opened, so a
 * broken feature stayed broken until someone complained. Stage 2's sync already
 * raises well-written alerts; until now they had nowhere to go.
 *
 * This is deliberately not the staff-notification system. It reaches one
 * operations chat, needs no staff records to exist, and works from the first
 * deploy. When staff management lands, targeted notification is built alongside
 * it — this stays as the channel for things no particular staff member owns.
 */
import type { Api } from 'grammy';
import { env } from '../config/env.js';
import { log } from '../log.js';
import type { Alert, Alerter } from '../sync/alerts.js';
import { loggingAlerter, neverThrows } from '../sync/alerts.js';
import { trySend } from './send.js';

const ICON: Record<Alert['severity'], string> = {
  critical: '🔴',
  warning: '🟠',
};

/**
 * Telegram's message limit. An alert listing every rejected FAQ row can exceed
 * it, and a rejected send means the alarm is lost entirely — so it is trimmed
 * here rather than at each call site.
 */
const MAX_ALERT_CHARS = 3500;

/**
 * An alerter that messages the operations chat and always also logs.
 *
 * `trySend`, not `send`: a failure to deliver an alarm must never abort the
 * operation that raised it. Logging unconditionally means an undelivered alarm
 * still leaves a trace, which matters precisely when Telegram is the thing that
 * is broken.
 */
export function telegramAlerter(api: Api): Alerter {
  return neverThrows({
    async send(alert: Alert): Promise<void> {
      await loggingAlerter.send(alert);

      const chatId = env().OPS_ALERT_CHAT_ID;
      if (chatId === undefined) return;

      const body =
        alert.body.length > MAX_ALERT_CHARS
          ? `${alert.body.slice(0, MAX_ALERT_CHARS)}\n\n…truncated. See the logs for the rest.`
          : alert.body;

      const result = await trySend(api, chatId, `${ICON[alert.severity]} ${alert.title}\n\n${body}`);
      if (!result.ok) {
        log.error(
          { reason: result.failure.kind, alert: alert.title },
          'could not deliver an alert to the operations chat — is OPS_ALERT_CHAT_ID a chat the bot can message?',
        );
      }
    },
  });
}
