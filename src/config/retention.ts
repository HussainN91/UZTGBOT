/**
 * How long records are kept, and when a teacher must be asked to read the
 * privacy notice again.
 *
 * Two rules live here and both are load-bearing in a way that is easy to miss:
 *
 *   **A period nobody set deletes nothing.** Not a default, not a guess, not a
 *   sensible-looking fallback. There is no undo for a deletion, and a job that
 *   invents a retention period removes real records against a number nobody
 *   chose. `overdueDays` already follows this rule for `OVERDUE_DAYS`, and the
 *   argument is stronger here because that one only decides what a list shows.
 *
 *   **Lengthening a period asks teachers again; shortening one does not.** Plan
 *   D28. Keeping data longer than somebody was promised is a change to what
 *   they agreed to. Deleting it sooner breaks no commitment to anybody, and
 *   putting 1,800 people through a re-consent to be told their data goes sooner
 *   is a cost with no beneficiary.
 *
 * Pure by construction: no database, no Telegram, no clock. The rules have to be
 * checkable against a promise made to teachers by somebody reading them, and a
 * rule you need a running system to exercise is a rule nobody checks.
 */

/**
 * The three keys. One number cannot carry three different promises — a case a
 * teacher filed, an emergency somebody escalated, and a line in the interaction
 * log are kept for different reasons and for different lengths of time.
 */
export const RETENTION_SETTING = {
  /** A resolved case whose `importance` is `Normal`. */
  CASE_RETENTION_DAYS: 'CASE_RETENTION_DAYS',
  /** A resolved case marked `Urgent` or `Critical`. Read from `importance`, never `status`. */
  URGENT_CASE_RETENTION_DAYS: 'URGENT_CASE_RETENTION_DAYS',
  /** Rows in `messages`, and everything else holding the same class of content. */
  MESSAGE_RETENTION_DAYS: 'MESSAGE_RETENTION_DAYS',
} as const;

export type RetentionSettingKey = (typeof RETENTION_SETTING)[keyof typeof RETENTION_SETTING];

/**
 * What was agreed on 29 July 2026 (plan D28).
 *
 * **Not a fallback.** Nothing reads these to fill in an unset period — that is
 * the whole of the first rule above. They are quoted to whoever is typing
 * `/retention`, so the numbers in the runbook's launch insert and the numbers
 * the head of project agreed to cannot drift apart without somebody seeing it.
 */
export const RETENTION_AGREED = {
  caseDays: 7,
  urgentCaseDays: 180,
  messageDays: 3,
} as const;

/**
 * `null` means **keep indefinitely**, in every direction and at every layer.
 *
 * Never "unknown" and never "use the default". The purge reads it as "delete
 * nothing of this class", the notice reads it as "kept until the Ministry sets a
 * period", and the re-consent rule reads it as the longest period there is.
 */
export interface RetentionPeriods {
  readonly caseDays: number | null;
  readonly urgentCaseDays: number | null;
  readonly messageDays: number | null;
}

/**
 * The largest period anybody could sensibly mean, in days — about 270 years.
 *
 * Not pedantry. `make_interval(days => …)` with an absurd value throws inside
 * the nightly job, and a retention job that throws deletes nothing while
 * appearing to have run. Anything past this is a typo or a paste, and both mean
 * the same thing: do not delete against it.
 */
const MAX_PERIOD_DAYS = 100_000;

/**
 * Read a period out of whatever is in the settings table.
 *
 * Digits only, deliberately. `7.5` and `-7` and `1e3` are all refused rather
 * than coerced, because every one of them is somebody meaning something the
 * system cannot honour, and `parseInt` would silently turn two of them into a
 * number of days nobody typed.
 */
export function parsePeriod(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;

  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;

  const days = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(days) || days <= 0 || days > MAX_PERIOD_DAYS) return null;

  return days;
}

/**
 * Is `a` a longer period than `b`, with `null` meaning for ever?
 *
 * The whole asymmetry of the re-consent rule rests on this one comparison, which
 * is why it is a named function with its own tests rather than an inline `>`
 * somebody later "simplifies" into one that treats `null` as zero.
 */
export function isLongerThan(a: number | null, b: number | null): boolean {
  const left = a ?? Number.POSITIVE_INFINITY;
  const right = b ?? Number.POSITIVE_INFINITY;
  return left > right;
}

/**
 * What a teacher agreed to: a wording, and the numbers that wording stated.
 *
 * Both halves are needed and neither is enough. The wording version alone cannot
 * see a settings change, which happens with no deploy and no review. The numbers
 * alone cannot see a rewritten paragraph.
 */
export interface PrivacyAcceptance {
  readonly version: string;
  readonly periods: RetentionPeriods;
}

/**
 * Must this teacher be asked to read the notice again?
 *
 * `null` — no recorded acceptance at all — is `true`. Teachers bound before
 * these columns existed genuinely have no record, and inventing one for them is
 * worse than admitting it.
 *
 * Note what this is *not*: a comparison of the rendered notice. A digest of the
 * text changes when a period is shortened, and D28 says plainly that shortening
 * must not ask anybody anything. An asymmetric rule cannot be expressed as an
 * equality check, which is the trap this function exists to avoid falling into.
 */
export function requiresReconsent(
  accepted: PrivacyAcceptance | null,
  current: PrivacyAcceptance,
): boolean {
  if (accepted === null) return true;
  if (accepted.version !== current.version) return true;

  return (
    isLongerThan(current.periods.caseDays, accepted.periods.caseDays) ||
    isLongerThan(current.periods.urgentCaseDays, accepted.periods.urgentCaseDays) ||
    isLongerThan(current.periods.messageDays, accepted.periods.messageDays)
  );
}
