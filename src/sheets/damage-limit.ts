/**
 * The limit on how much damage one sync may do.
 *
 * The sync deactivates any row that has disappeared from the spreadsheet. That
 * is the correct behaviour for a teacher who has genuinely left, and a disaster
 * if someone selects the roster tab and presses delete, or if a filter is left
 * applied, or if the API returns a partial response. Somebody clearing a tab by
 * accident must not mean 1,800 teachers cannot sign in.
 *
 * So a sync that would switch off more than a fifth of the currently active rows
 * refuses to run at all and raises an alarm. Refusing is safe: the data is still
 * there, still correct, and the next sync recovers on its own once the sheet is
 * fixed. Proceeding is not.
 */

/** More than a fifth is too much to lose to one bad sync. */
export const DAMAGE_LIMIT_RATIO = 0.2;

export interface DamageAssessment {
  readonly allowed: boolean;
  readonly activeBefore: number;
  readonly wouldDeactivate: number;
  /** Share of currently active rows this sync would switch off, 0 to 1. */
  readonly ratio: number;
  readonly reason: string;
}

export interface DamageLimitOptions {
  /**
   * Deliberate override, for a genuine bulk removal.
   *
   * Requires a person to decide, and the sync records that it was used — an
   * override nobody can see is the same as no limit at all.
   */
  readonly force?: boolean;
}

export function assessDamage(
  activeBefore: number,
  wouldDeactivate: number,
  options: DamageLimitOptions = {},
): DamageAssessment {
  const ratio = activeBefore === 0 ? 0 : wouldDeactivate / activeBefore;

  // Nothing on file yet: the first sync cannot destroy anything, and blocking it
  // would mean the guard prevented the system from ever being populated.
  if (activeBefore === 0) {
    return { allowed: true, activeBefore, wouldDeactivate, ratio, reason: 'first sync — nothing to lose' };
  }
  if (wouldDeactivate === 0) {
    return { allowed: true, activeBefore, wouldDeactivate, ratio, reason: 'no rows would be deactivated' };
  }
  if (ratio <= DAMAGE_LIMIT_RATIO) {
    return {
      allowed: true,
      activeBefore,
      wouldDeactivate,
      ratio,
      reason: `${wouldDeactivate} of ${activeBefore} rows would be deactivated, within the ${percent(DAMAGE_LIMIT_RATIO)} limit`,
    };
  }
  if (options.force === true) {
    return {
      allowed: true,
      activeBefore,
      wouldDeactivate,
      ratio,
      reason:
        `OVERRIDDEN: ${wouldDeactivate} of ${activeBefore} rows (${percent(ratio)}) deactivated by explicit force. ` +
        `This exceeded the ${percent(DAMAGE_LIMIT_RATIO)} limit and was allowed by a person.`,
    };
  }
  return {
    allowed: false,
    activeBefore,
    wouldDeactivate,
    ratio,
    reason:
      `Refusing to sync: it would deactivate ${wouldDeactivate} of ${activeBefore} active rows (${percent(ratio)}), ` +
      `over the ${percent(DAMAGE_LIMIT_RATIO)} limit. Nothing was changed. ` +
      `This usually means the spreadsheet tab was cleared, a filter is applied, or rows were pasted over. ` +
      `Check the sheet — the next sync recovers on its own once it looks right. ` +
      `If the removal is genuine, run the sync with force.`,
  };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
