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

  it('routes document cases to Accommodation, before stage 6 can file one', () => {
    expect(queueForCategory(CASE_CATEGORY.SUBMIT_DOCS)).toBe(QUEUE.ACCOMMODATION);
  });

  it('routes an unknown category to All rather than to nobody', () => {
    // cases.category is text, so a row written by a newer build can hold a value
    // this one does not know. Failing open is right: a case seen by too many
    // people is recoverable, a case seen by nobody is not.
    expect(queueForCategory('Something Stage 9 invented')).toBe(QUEUE.ALL);
  });

  it('routes Contact Support to Accommodation, not to everybody', () => {
    /**
     * D6, 5 August 2026, and it reverses this file's original answer.
     *
     * `All` was right while nothing gave a case an owner: an uncategorised case
     * reaching nobody is the failure the new-case alert exists to catch, so it
     * went to everybody instead. Automatic assignment removed the premise. Every
     * case now gets an owner, so an unclassified one cannot go unworked, and
     * routing it to every queue meant every staff member was shown every
     * unclassified problem in the country. That was most of the noise a MoPSE
     * employee reported as overwhelming.
     */
    expect(queueForCategory(CASE_CATEGORY.CONTACT_SUPPORT)).toBe(QUEUE.ACCOMMODATION);
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
  it('shows a specialist their own category and nothing else', () => {
    /**
     * **This assertion was the opposite way round until 5 August 2026**, and the
     * reason it gave was good: a Visa staff member should see Contact Support
     * cases, because those are the ones nobody has categorised and they are
     * exactly what goes unworked.
     *
     * What removed the argument was automatic assignment rather than a change of
     * mind. An unclassified case now has an owner from the moment it is filed, so
     * it cannot go unworked, and showing it to all five queues was showing every
     * staff member every unclassified problem in the country. D6.
     */
    const visible = categoriesVisibleTo(QUEUE.VISA);
    expect(visible).toContain(CASE_CATEGORY.VISA);
    expect(visible).not.toContain(CASE_CATEGORY.CONTACT_SUPPORT);
    expect(visible).not.toContain(CASE_CATEGORY.SUBMIT_DOCS);
    expect(visible).not.toContain(CASE_CATEGORY.TRAVEL);
  });

  it('shows the Accommodation queue the unclassified cases as well as its own', () => {
    // The other half of D6: what a Visa specialist stopped seeing, somebody has
    // to be seeing. Accommodation is the desk that takes general questions.
    const visible = categoriesVisibleTo(QUEUE.ACCOMMODATION);
    expect(visible).toContain(CASE_CATEGORY.ACCOMMODATION);
    expect(visible).toContain(CASE_CATEGORY.CONTACT_SUPPORT);
    expect(visible).toContain(CASE_CATEGORY.SUBMIT_DOCS);
  });

  it('shows an All queue every category', () => {
    // `Object.values` already returns a fresh array, so sorting it in place is safe.
    expect([...categoriesVisibleTo(QUEUE.ALL)].sort()).toEqual(Object.values(CASE_CATEGORY).sort());
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

  it('sends an uncategorised case to Accommodation and to All, and nowhere else', () => {
    // D6. It used to go to every queue but None. Routing it to a specialist is
    // still guessing, which is why Accommodation is named as the general desk
    // rather than deduced from the problem.
    expect([...queuesCovering(CASE_CATEGORY.CONTACT_SUPPORT)].sort()).toEqual(
      [QUEUE.ACCOMMODATION, QUEUE.ALL].sort(),
    );
  });

  it('still reaches somebody who covers everything', () => {
    // The narrowing must not hide an unclassified case from a person whose queue
    // is All, which on this team is most of them.
    expect(queuesCovering(CASE_CATEGORY.CONTACT_SUPPORT)).toContain(QUEUE.ALL);
    expect(queuesCovering(CASE_CATEGORY.SUBMIT_DOCS)).toContain(QUEUE.ALL);
  });

  it('still routes a category this build has never heard of to everybody', () => {
    // The asymmetry in the header of queues.ts survives D6: an unknown category
    // widens, an unknown queue narrows. A case written by a newer build must
    // still be worked by somebody.
    expect(queueForCategory('Something From 2027')).toBe(QUEUE.ALL);
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
