import { describe, expect, it } from 'vitest';
import { STAFF_ROLE_ORDER } from '../db/schema.js';
import { ALL_CAPABILITIES, CAPABILITY, atLeast, can, capabilitiesFor } from './roles.js';

describe('the capability table', () => {
  it('grants every capability to System', () => {
    for (const capability of ALL_CAPABILITIES) {
      expect(can({ role: 'System', active: true }, capability)).toBe(true);
    }
  });

  it('refuses everything to a deactivated member, whatever their role', () => {
    // A deactivated System member is not a System member. This is checked here
    // rather than at the call sites so that adding a command cannot forget it.
    for (const capability of ALL_CAPABILITIES) {
      expect(can({ role: 'System', active: false }, capability)).toBe(false);
    }
  });

  it('refuses everything when there is no staff row at all', () => {
    // The ordinary case: a teacher, or a stranger, typing a staff command.
    for (const capability of ALL_CAPABILITIES) {
      expect(can(null, capability)).toBe(false);
    }
  });

  it('lets nobody below Program move a case to somebody else', () => {
    /**
     * Part 5H.2, and the floor rose from `Lead` on 1 August 2026 at the head of
     * project's instruction: *"staff cannot TAKE OVER a case, no one can do that
     * except system and program admin."*
     *
     * It is not a tightening for its own sake. Cases now arrive with an owner
     * already on them (Part 5H.1), chosen by who has the fewest open — so
     * reassignment stopped being how work is distributed and became an override
     * of that, which is a decision worth two ranks.
     *
     * **The order mattered.** Raising this before automatic assignment existed
     * would have left almost every case unowned, because a manual `/assign` was
     * the only thing that ever set an owner.
     */
    expect(can({ role: 'Support', active: true }, 'case.assign')).toBe(false);
    expect(can({ role: 'Lead', active: true }, 'case.assign')).toBe(false);
    expect(can({ role: 'Program', active: true }, 'case.assign')).toBe(true);
    expect(can({ role: 'System', active: true }, 'case.assign')).toBe(true);
  });

  it('lets an Observer see a case and change nothing', () => {
    // D7. The whole point of the rank: sight without the power to alter.
    expect(can({ role: 'Observer', active: true }, 'case.view')).toBe(true);
    for (const capability of ALL_CAPABILITIES.filter((c) => c !== 'case.view')) {
      expect(can({ role: 'Observer', active: true }, capability)).toBe(false);
    }
  });

  it('does not let an Observer issue an urgent code', () => {
    // Called out separately because it is the one capability that is not about
    // cases and would be easy to grant by pattern-matching on "read-only means
    // no writes to cases".
    expect(can({ role: 'Observer', active: true }, 'urgent.issue')).toBe(false);
  });

  it('does not let an Observer be told about new cases', () => {
    // R14, and the reason case.update rather than case.view is the filter for
    // notification: an observer paged about every new case in their region is
    // being asked to watch work they cannot do.
    expect(can({ role: 'Observer', active: true }, 'case.update')).toBe(false);
  });

  it('names every capability in the ladder order, so /whoami can list them', () => {
    expect(capabilitiesFor('Program')).toContain('announce');
    expect(capabilitiesFor('Program')).not.toContain('staff.manage');
  });

  it('gives each rank everything the rank below it has', () => {
    // The ladder is a ladder. Apps Script matched roles exactly, which is why a
    // Program-tier member could not do things a lower tier could; expressing
    // that as a property here means a future grant cannot reintroduce it.
    for (let i = 1; i < STAFF_ROLE_ORDER.length; i += 1) {
      const lower = capabilitiesFor(STAFF_ROLE_ORDER[i - 1]!);
      const higher = capabilitiesFor(STAFF_ROLE_ORDER[i]!);
      for (const capability of lower) {
        expect(higher).toContain(capability);
      }
    }
  });

  it('grants every capability to somebody', () => {
    // A capability no rank holds is a command nobody can run — the "setting
    // that looks configured and does nothing" this rebuild exists to remove.
    for (const capability of ALL_CAPABILITIES) {
      const holders = STAFF_ROLE_ORDER.filter((role) => can({ role, active: true }, capability));
      expect(holders.length).toBeGreaterThan(0);
    }
  });

  it('exposes every capability constant in ALL_CAPABILITIES', () => {
    // Guards the one mistake this file can make silently: adding a CAPABILITY
    // entry and forgetting to grant it, which would leave `can()` returning
    // undefined-ish for a real capability.
    for (const capability of Object.values(CAPABILITY)) {
      expect(ALL_CAPABILITIES).toContain(capability);
    }
  });
});

describe('atLeast', () => {
  it('compares by rank rather than by equality', () => {
    expect(atLeast('Program', 'Lead')).toBe(true);
    expect(atLeast('Lead', 'Lead')).toBe(true);
    expect(atLeast('Support', 'Lead')).toBe(false);
  });

  it('puts Observer at the bottom of the ladder', () => {
    expect(atLeast('Observer', 'Support')).toBe(false);
    expect(atLeast('Support', 'Observer')).toBe(true);
  });
});
