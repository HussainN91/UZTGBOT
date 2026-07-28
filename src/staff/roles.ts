/**
 * What each role may do.
 *
 * One table, read by the gates AND by /whoami, so the bot can never describe a
 * permission model different from the one it enforces — `handleWhoAmI_`
 * (AdminCommands.gs:453) records that as a deliberate property and it is worth
 * keeping. The Apps Script version drifted precisely because the answer to
 * "what am I allowed to do" was computed in a different place from the answer
 * to "may I do this".
 *
 * `announce` and `export` have no command until stage 5. They are here so that
 * stage adds a command rather than a permission model, and so /whoami does not
 * have to change twice.
 *
 * Pure by construction: no database, no Telegram, no clock. `can()` takes
 * `{ role, active }` rather than a whole staff row so that this file never has
 * to know what a staff row looks like.
 */
import { STAFF_ROLE_ORDER, type StaffRole } from '../db/schema.js';

export const CAPABILITY = {
  CASE_VIEW: 'case.view',
  CASE_UPDATE: 'case.update',
  CASE_MARK: 'case.mark',
  CASE_ASSIGN: 'case.assign',
  URGENT_ISSUE: 'urgent.issue',
  TEACHER_REGION: 'teacher.region',
  TEACHER_REVOKE: 'teacher.revoke',
  STAFF_MANAGE: 'staff.manage',
  MAINTENANCE: 'maintenance',
  ANNOUNCE: 'announce',
  EXPORT: 'export',
} as const;

export type Capability = (typeof CAPABILITY)[keyof typeof CAPABILITY];

/**
 * The lowest rank that holds each capability.
 *
 * Stated as a floor rather than as a list of roles because the ladder is a
 * ladder: every rank has everything the rank below it has. Writing the roles out
 * one by one is how a grant gets added to `Program` and forgotten for `System`,
 * which in Apps Script produced senior staff who could do less than their
 * juniors (the exact-match check at `AdminCommands.gs:185-193`).
 *
 * A System member additionally bypasses every queue and region check — that is
 * enforced in the visibility predicate, not here, because it is a question about
 * which cases exist rather than about which verbs are permitted.
 */
const FLOOR: Readonly<Record<Capability, StaffRole>> = {
  'case.view': 'Observer',
  'case.update': 'Support',
  'case.mark': 'Support',
  'case.assign': 'Lead',
  'urgent.issue': 'Support',
  'teacher.region': 'Lead',
  'teacher.revoke': 'Program',
  'staff.manage': 'System',
  maintenance: 'System',
  announce: 'Program',
  export: 'Program',
};

export const ALL_CAPABILITIES = Object.values(CAPABILITY);

/** Where a role sits on the ladder. Higher index is more authority. */
const rankOf = (role: StaffRole): number => STAFF_ROLE_ORDER.indexOf(role);

/**
 * Is `role` at least as senior as `floor`?
 *
 * A comparison, never an equality check. "At least Lead" must include Program
 * and System without anybody having to remember to list them.
 */
export const atLeast = (role: StaffRole, floor: StaffRole): boolean =>
  rankOf(role) >= rankOf(floor);

/** The shape every gate asks about: a rank, and whether the row is still live. */
export interface StaffPrincipal {
  readonly role: StaffRole;
  readonly active: boolean;
}

/**
 * The single authorization question.
 *
 * `null` — no staff row for this chat — is a legitimate and common answer, not
 * an error: most people typing into this bot are teachers. It is refused the
 * same way a deactivated member is.
 *
 * Deactivation is checked before the table, so a member who has been removed
 * cannot retain a capability through any path. Doing it here rather than at
 * each call site means a command added in stage 5 inherits the rule instead of
 * having to remember it.
 */
export const can = (principal: StaffPrincipal | null, capability: Capability): boolean => {
  if (principal === null || !principal.active) return false;
  return atLeast(principal.role, FLOOR[capability]);
};

/**
 * Everything a role may do, in ladder order.
 *
 * Read by /whoami. It derives from `FLOOR`, so a capability cannot appear in
 * what the bot reports without also being enforced — which is the property this
 * whole file exists to guarantee.
 */
export const capabilitiesFor = (role: StaffRole): readonly Capability[] =>
  ALL_CAPABILITIES.filter((capability) => atLeast(role, FLOOR[capability]));
