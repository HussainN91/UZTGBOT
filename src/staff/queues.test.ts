import { describe, expect, it } from 'vitest';
import { CASE_CATEGORY } from '../config/constants.js';
import {
  ALL_QUEUES,
  QUEUE,
  QUEUE_FOR_CATEGORY,
  categoriesVisibleTo,
  isQueue,
  queueForCategory,
  queuesCovering,
} from './queues.js';

describe('queue routing', () => {
  it('maps every case category to a queue', () => {
    // The guard against a category being added later with no queue, which would
    // route those cases to a queue nobody holds and hide them from everybody.
    for (const category of Object.values(CASE_CATEGORY)) {
      expect(QUEUE_FOR_CATEGORY[category]).toBeDefined();
    }
  });

  it('routes document cases to All, before stage 6 can file one', () => {
    expect(queueForCategory(CASE_CATEGORY.SUBMIT_DOCS)).toBe(QUEUE.ALL);
  });

  it('routes an unknown category to All rather than to nobody', () => {
    // cases.category is text, so a row written by a newer build can hold a value
    // this one does not know. Failing open is right: a case seen by too many
    // people is recoverable, a case seen by nobody is not.
    expect(queueForCategory('Something Stage 9 invented')).toBe(QUEUE.ALL);
  });

  it('routes Contact Support to All, because it is by definition uncategorised', () => {
    expect(queueForCategory(CASE_CATEGORY.CONTACT_SUPPORT)).toBe(QUEUE.ALL);
  });

  it('routes the four real categories to their own queues', () => {
    expect(queueForCategory(CASE_CATEGORY.VISA)).toBe(QUEUE.VISA);
    expect(queueForCategory(CASE_CATEGORY.TRAVEL)).toBe(QUEUE.TRAVEL);
    expect(queueForCategory(CASE_CATEGORY.CONTRACT)).toBe(QUEUE.CONTRACT);
    expect(queueForCategory(CASE_CATEGORY.ACCOMMODATION)).toBe(QUEUE.ACCOMMODATION);
  });

  it('never routes anything to None', () => {
    // None is a thing a staff member can hold, not a thing a case can be in.
    for (const category of Object.values(CASE_CATEGORY)) {
      expect(QUEUE_FOR_CATEGORY[category]).not.toBe(QUEUE.NONE);
    }
  });
});

describe('categoriesVisibleTo', () => {
  it('shows a specialist their own category and the ones routed to everybody', () => {
    // A Visa staff member must still see Contact Support cases: those are the
    // ones nobody has categorised, and they are exactly what goes unworked.
    const visible = categoriesVisibleTo(QUEUE.VISA);
    expect(visible).toContain(CASE_CATEGORY.VISA);
    expect(visible).toContain(CASE_CATEGORY.CONTACT_SUPPORT);
    expect(visible).toContain(CASE_CATEGORY.SUBMIT_DOCS);
    expect(visible).not.toContain(CASE_CATEGORY.TRAVEL);
  });

  it('shows an All queue every category', () => {
    expect([...categoriesVisibleTo(QUEUE.ALL)].sort()).toEqual(
      [...Object.values(CASE_CATEGORY)].sort(),
    );
  });

  it('shows a None queue nothing', () => {
    // Not the same as All. Somebody parked with no queue sees no cases by queue,
    // which is what makes None usable as a deliberate setting rather than a bug.
    expect(categoriesVisibleTo(QUEUE.NONE)).toEqual([]);
  });

  it('shows an unrecognised queue nothing, and does not throw', () => {
    // The mirror of failing open on category. A staff row holding a queue this
    // build does not know is a misconfiguration; widening their sight to
    // everything on the strength of a typo is the wrong direction to fail.
    expect(categoriesVisibleTo('Recruitment')).toEqual([]);
  });
});

describe('queuesCovering', () => {
  it('agrees with categoriesVisibleTo for every queue and every category', () => {
    // The two are inverses of one rule, asked from opposite ends: "which cases
    // may this person see" and "which people may see this case". Two
    // expressions of one rule is exactly what `adminCanSeeCase_` became, applied
    // by hand at six call sites; this walks all thirty-six pairs so they cannot
    // drift apart.
    for (const queue of ALL_QUEUES) {
      const visible: readonly string[] = categoriesVisibleTo(queue);
      for (const category of Object.values(CASE_CATEGORY)) {
        expect(queuesCovering(category).includes(queue)).toBe(visible.includes(category));
      }
    }
  });

  it('sends an uncategorised case to every queue except None', () => {
    // Contact Support is by definition the case nobody has classified. Routing
    // it to a specialist would be guessing.
    expect([...queuesCovering(CASE_CATEGORY.CONTACT_SUPPORT)].sort()).toEqual(
      ALL_QUEUES.filter((q) => q !== QUEUE.NONE).sort(),
    );
  });

  it('sends a categorised case to its own queue and to All, and nowhere else', () => {
    expect([...queuesCovering(CASE_CATEGORY.VISA)].sort()).toEqual([QUEUE.ALL, QUEUE.VISA].sort());
  });

  it('sends a category this build does not know to every queue', () => {
    // The same direction `queueForCategory` fails in: seen by too many people is
    // a nuisance, seen by nobody is what this system exists to prevent.
    expect(queuesCovering('Recruitment')).toContain(QUEUE.VISA);
    expect(queuesCovering('Recruitment')).not.toContain(QUEUE.NONE);
  });
});

describe('isQueue', () => {
  it('accepts every queue it lists and rejects anything else', () => {
    for (const queue of ALL_QUEUES) {
      expect(isQueue(queue)).toBe(true);
    }
    expect(isQueue('Technical')).toBe(false);
    expect(isQueue('visa')).toBe(false);
  });
});
