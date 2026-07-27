import { describe, expect, it } from 'vitest';
import { DAMAGE_LIMIT_RATIO, assessDamage } from './damage-limit.js';

describe('the damage limit', () => {
  /** The scenario the guard exists for. */
  it('refuses a sync that would empty the roster', () => {
    const assessment = assessDamage(1800, 1800);
    expect(assessment.allowed).toBe(false);
    expect(assessment.reason).toMatch(/Refusing to sync/);
  });

  it('says plainly that nothing was changed, because refusing is the safe outcome', () => {
    expect(assessDamage(1800, 1800).reason).toMatch(/Nothing was changed/);
  });

  it('suggests the likely causes rather than only reporting a number', () => {
    expect(assessDamage(1800, 900).reason).toMatch(/cleared|filter|pasted/);
  });

  it('allows an ordinary week of leavers', () => {
    // Twelve teachers off a roster of 1,800 is normal churn, not an accident.
    expect(assessDamage(1800, 12).allowed).toBe(true);
  });

  it('allows exactly the limit and refuses just over it', () => {
    expect(assessDamage(1000, 200).allowed).toBe(true);
    expect(assessDamage(1000, 201).allowed).toBe(false);
  });

  it('uses a fifth, as the plan specifies', () => {
    expect(DAMAGE_LIMIT_RATIO).toBe(0.2);
  });

  it('reports the share as a percentage a person can read', () => {
    expect(assessDamage(1000, 500).reason).toMatch(/50%/);
  });
});

describe('cases where the guard must not fire', () => {
  it('allows the very first sync, when there is nothing to lose', () => {
    const assessment = assessDamage(0, 0);
    expect(assessment.allowed).toBe(true);
    expect(assessment.reason).toMatch(/first sync/);
  });

  it('allows a sync that deactivates nothing', () => {
    expect(assessDamage(1800, 0).allowed).toBe(true);
  });

  it('does not divide by zero when nothing is active yet', () => {
    expect(assessDamage(0, 5).ratio).toBe(0);
    expect(assessDamage(0, 5).allowed).toBe(true);
  });
});

describe('the override', () => {
  it('allows a genuine bulk removal when a person forces it', () => {
    expect(assessDamage(1800, 1700, { force: true }).allowed).toBe(true);
  });

  it('records that the limit was exceeded and overridden, so it cannot pass unnoticed', () => {
    const assessment = assessDamage(1800, 1700, { force: true });
    expect(assessment.reason).toMatch(/OVERRIDDEN/);
    expect(assessment.reason).toMatch(/allowed by a person/);
  });

  it('does not mention an override when the sync was within the limit anyway', () => {
    expect(assessDamage(1800, 10, { force: true }).reason).not.toMatch(/OVERRIDDEN/);
  });
});
