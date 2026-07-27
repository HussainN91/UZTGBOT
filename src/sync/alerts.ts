/**
 * Telling someone when a sync refuses to run or rejects content.
 *
 * "Nobody notices when something breaks" is on the concerns list: errors went to
 * a log nobody opened, so a broken feature stayed broken until a teacher
 * complained. A sync that aborts on the damage limit is the system working
 * correctly — but it is invisible unless somebody is actually told.
 *
 * The delivery mechanism is injected rather than hardcoded so this stage does
 * not depend on the staff table existing yet. Stage 4 supplies an alerter that
 * messages System-role staff in Telegram; until then the logging one records
 * everything, and the sync_runs table keeps the durable record either way.
 */
import { log } from '../log.js';

export type AlertSeverity = 'warning' | 'critical';

export interface Alert {
  readonly severity: AlertSeverity;
  /** Short subject, e.g. "FAQ sync refused". */
  readonly title: string;
  /** What happened and what to do about it, in terms a content owner understands. */
  readonly body: string;
}

export interface Alerter {
  send(alert: Alert): Promise<void>;
}

/**
 * The default. Writes the alert at a level that will be picked up by whatever
 * ships the logs, and never throws — an alerting failure must not roll back a
 * sync that otherwise succeeded.
 */
export const loggingAlerter: Alerter = {
  async send(alert: Alert): Promise<void> {
    const line = `${alert.title}: ${alert.body}`;
    if (alert.severity === 'critical') log.error({ alert: alert.title }, line);
    else log.warn({ alert: alert.title }, line);
  },
};

/** Wraps an alerter so a delivery failure is reported but never propagates. */
export function neverThrows(alerter: Alerter): Alerter {
  return {
    async send(alert: Alert): Promise<void> {
      try {
        await alerter.send(alert);
      } catch (err) {
        log.error({ err, alert: alert.title }, 'could not deliver an alert');
      }
    },
  };
}
