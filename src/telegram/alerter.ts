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
import { getDb } from '../db/index.js';
import { log } from '../log.js';
import { systemStaffIds } from '../staff/repository.js';
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
 * Active System members, or nobody, and it never throws — D12.
 *
 * **The whole argument for this file is in the `catch`.** "The staff table is
 * wrong" is a state whose alarm must not depend on the staff table, and neither
 * must the alarm about anything else that happens while it is wrong. A failure
 * here returns an empty list, the operations chat still receives everything, and
 * the failure is itself logged.
 *
 * Injectable, with the production reader as the default. That is departure 10's
 * shape and it is chosen for both of its properties: no call site has to pass
 * anything, so no call site can forget the fan-out, and the behaviour can still
 * be driven in a test without a database.
 */
export type SystemStaffReader = () => Promise<readonly string[]>;

const defaultSystemStaff: SystemStaffReader = async () => {
  try {
    return await systemStaffIds(getDb());
  } catch (err) {
    log.error({ err }, 'could not read System staff for an alert; the operations chat still has it');
    return [];
  }
};

/**
 * An alerter that messages the operations chat, then every active System member,
 * and always also logs.
 *
 * **Both, always, never one or the other.** `OPS_ALERT_CHAT_ID` stays the floor:
 * it is what works when the staff table is empty, wrong, or unreachable, it is
 * the only recipient during bootstrap before the first System row exists, and
 * `RUNBOOK.md` Part 3 step 8 treats its arrival as the proof that the whole
 * alerting path works. Read alone, `alerts.ts` line 10 — "an alerter that
 * messages System-role staff" — suggests replacing the environment variable.
 * It must not.
 *
 * Duplicate delivery to a System member who is also in the operations group is
 * accepted, and is not detectable from here anyway. An alarm arriving twice is a
 * nuisance; an alarm arriving nowhere is the concern this mechanism exists to
 * answer.
 *
 * `trySend` throughout, not `send`: a failure to deliver an alarm must never
 * abort the operation that raised it, and one unreachable System member must not
 * cost the others theirs.
 */
export function telegramAlerter(
  api: Api,
  systemStaff: SystemStaffReader = defaultSystemStaff,
): Alerter {
  return neverThrows({
    async send(alert: Alert): Promise<void> {
      await loggingAlerter.send(alert);

      const opsChatId = env().OPS_ALERT_CHAT_ID;

      const body =
        alert.body.length > MAX_ALERT_CHARS
          ? `${alert.body.slice(0, MAX_ALERT_CHARS)}\n\n…truncated. See the logs for the rest.`
          : alert.body;
      const text = `${ICON[alert.severity]} ${alert.title}\n\n${body}`;

      if (opsChatId !== undefined) {
        const result = await trySend(api, opsChatId, text);
        if (!result.ok) {
          log.error(
            { reason: result.failure.kind, alert: alert.title },
            'could not deliver an alert to the operations chat — is OPS_ALERT_CHAT_ID a chat the bot can message?',
          );
        }
      }

      /**
       * Read after the operations chat has already been messaged, and that
       * ordering is deliberate rather than incidental. The floor recipient must
       * not be able to wait on, or be lost to, a query against the very table an
       * alarm may be about.
       */
      for (const chatId of await systemStaff()) {
        // Not a second copy for somebody whose own chat *is* the operations chat.
        if (chatId === opsChatId) continue;

        const result = await trySend(api, chatId, text);
        if (!result.ok) {
          log.error(
            { reason: result.failure.kind, chatId, alert: alert.title },
            'could not deliver an alert to a System staff member — have they started a chat with the bot?',
          );
        }
      }
    },
  });
}
