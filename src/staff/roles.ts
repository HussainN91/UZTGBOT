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
  /**
   * Anonymising a teacher on request. Floored at System, above `teacher.revoke`.
   *
   * The gap between the two is the whole argument of D44: `/revoke` is
   * reversible and `/restore` exists so the mistake is cheap, while this has no
   * undo whatsoever. Two named System members exist by launch-checklist
   * requirement, so a removal request reaching the support desk is escalated to
   * one of two people — which for a request of this kind is correct handling
   * rather than an obstacle.
   */
  TEACHER_FORGET: 'teacher.forget',
  /**
   * Looking at an identity dispute, and handing it to a System administrator.
   *
   * **Floored at `Support`, and the floor is the decision rather than an
   * oversight.** `staffRoleEnum` records that a MoPSE "regional admin" is usually
   * a `Support` row with a region set — the rank ladder and the org chart are
   * different axes. Floor this at `Program`, where `teacher.revoke` sits, and no
   * actual regional admin would hold it: every dispute would fall through to the
   * System fallback, and the regional routing this whole feature is built on
   * would be dead on arrival while still looking configured.
   *
   * It sits beside `urgent.issue` for the same stated reason — the person a
   * teacher reaches is whoever is on the desk. A reviewer can look and forward.
   * Deciding is the capability below, and it is three ranks away.
   */
  DISPUTE_REVIEW: 'dispute.review',
  /**
   * Deciding which chat keeps a contested teacher identity.
   *
   * `System`, with `teacher.forget` rather than with `teacher.revoke`, because it
   * does more than a revocation: it revokes every losing chat AND closes their
   * cases with a stated reason. `/restore` makes the revocation reversible; the
   * closed cases stay closed, and that asymmetry is why the rank is what it is.
   */
  DISPUTE_RESOLVE: 'dispute.resolve',
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
  /**
   * Moving a case to somebody else — raised from `Lead` to `Program` on
   * 1 August 2026, Part 5H.2, at the head of project's instruction: *"staff
   * cannot TAKE OVER a case, no one can do that except system and program
   * admin."*
   *
   * **It reads as a tightening and is really a consequence.** Until Part 5H.1
   * a manual `/assign` was the only thing that ever set an owner, so this floor
   * was the floor on work being distributed at all. Cases now arrive with an
   * owner already on them, chosen by who has the fewest open — so what is left
   * here is *overriding* that choice, which is a different and rarer act, and
   * worth two ranks rather than one.
   *
   * **The order was load-bearing.** Raising it before automatic assignment
   * existed would have left almost every case unowned, and `/mycases` emptier
   * than it already was.
   */
  'case.assign': 'Program',
  'urgent.issue': 'Support',
  'teacher.region': 'Lead',
  'teacher.revoke': 'Program',
  'teacher.forget': 'System',
  'dispute.review': 'Support',
  'dispute.resolve': 'System',
  'staff.manage': 'System',
  maintenance: 'System',
  announce: 'Program',
  export: 'Program',
};

export const ALL_CAPABILITIES = Object.values(CAPABILITY);

/**
 * The lowest rank that holds a capability, for a refusal that says what is
 * missing.
 *
 * Read only to explain a denial. Telling somebody "that needs System" is worth
 * more than "you may not", because the recovery is asking a named person for a
 * rank rather than guessing which of five they need — and taking the answer from
 * the same table that enforced the refusal is what stops the explanation
 * drifting from the rule.
 */
export const floorFor = (capability: Capability): StaffRole => FLOOR[capability];

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
 * Every rank that holds a capability, in ladder order.
 *
 * The inverse of `can()`, and it exists for exactly one kind of question: "who
 * should be told about this", where the answer has to become a SQL `IN` list
 * rather than a decision taken one row at a time. Derived from `FLOOR`, so a
 * fan-out cannot reach a rank the gates would refuse — new-case notification
 * filters on `case.update` (R14), and hand-listing the ranks that hold it is how
 * an Observer ends up being paged about work they cannot do.
 */
export const rolesHolding = (capability: Capability): readonly StaffRole[] =>
  STAFF_ROLE_ORDER.filter((role) => atLeast(role, FLOOR[capability]));

/**
 * Everything a role may do, in ladder order.
 *
 * Read by /whoami. It derives from `FLOOR`, so a capability cannot appear in
 * what the bot reports without also being enforced — which is the property this
 * whole file exists to guarantee.
 */
export const capabilitiesFor = (role: StaffRole): readonly Capability[] =>
  ALL_CAPABILITIES.filter((capability) => atLeast(role, FLOOR[capability]));
