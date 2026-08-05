/**
 * Which staff member works which kind of case.
 *
 * One of the two axes that decide whether somebody may see a case; the other is
 * region. Both are evaluated together, in SQL, by the visibility predicate —
 * this file only holds the vocabulary and the map, and knows nothing about the
 * database.
 *
 * Deliberately shorter than Apps Script's list. `ADMIN_QUEUE` carried
 * `Recruitment` and `Technical` as "reserved for case types the proposal
 * describes but this bot doesn't yet model" (`AdminCommands.gs:53`) — a queue
 * that structurally cannot match anything is a setting that looks configured and
 * does nothing, which is the failure mode this rebuild exists to remove. Add one
 * when a category needs it.
 */
import { CASE_CATEGORY, type CaseCategory } from '../config/constants.js';

export const QUEUE = {
  VISA: 'Visa',
  TRAVEL: 'Travel',
  CONTRACT: 'Contract',
  ACCOMMODATION: 'Accommodation',
  ALL: 'All',
  NONE: 'None',
} as const;

export type Queue = (typeof QUEUE)[keyof typeof QUEUE];

export const ALL_QUEUES = Object.values(QUEUE);

const QUEUE_VALUES = new Set<string>(ALL_QUEUES);

/** Is this text one of the queues this build knows? */
export const isQueue = (value: string): value is Queue => QUEUE_VALUES.has(value);

/**
 * Every case category, routed.
 *
 * Typed as a total record over `CaseCategory`, so adding a category to
 * `CASE_CATEGORY` without routing it is a compile error rather than a class of
 * case that quietly reaches nobody.
 *
 * `Submit Documents` has no producer until stage 6 and is mapped now on purpose:
 * the map must be total *today*, so the first document case cannot be filed into
 * a queue nobody holds. `Contact Support` is mapped to `All` because it is by
 * definition the case that has not been categorised — routing it to a specialist
 * would be guessing, and an uncategorised case reaching nobody is precisely the
 * failure the new-case alert exists to catch.
 *
 * `queueForCategory_` also mapped seven newer FAQ topic labels
 * (`AdminCommands.gs:215-221`). Those mappings are dead here by construction: a
 * case's category is a `CaseCategory`, of which there are six, because
 * `createCase` accepts nothing else. In Apps Script a case could be filed under
 * an FAQ topic *label*; here it cannot.
 */
export const QUEUE_FOR_CATEGORY: Readonly<Record<CaseCategory, Queue>> = {
  [CASE_CATEGORY.VISA]: QUEUE.VISA,
  [CASE_CATEGORY.TRAVEL]: QUEUE.TRAVEL,
  [CASE_CATEGORY.CONTRACT]: QUEUE.CONTRACT,
  [CASE_CATEGORY.ACCOMMODATION]: QUEUE.ACCOMMODATION,
  /**
   * Both moved from `All` to `Accommodation` on 5 August 2026, D6.
   *
   * **`All` was right, and then its premise went away.** An uncategorised case
   * reaching nobody is the failure the new-case alert exists to catch, so before
   * anything gave a case an owner, sending it to every queue was the safe answer.
   * Automatic assignment removed that risk: every case is given to somebody the
   * moment it is filed, so an unclassified one cannot go unworked whoever can see
   * it.
   *
   * What was left was the cost. `Contact Support` is what a teacher picks when
   * they have not classified their problem, which is often, and routing it to all
   * five queues meant showing every staff member every unclassified problem in
   * the country. A MoPSE employee described the result as overwhelming, and this
   * is the largest single share of it.
   *
   * Accommodation is the desk that takes general questions in this ministry.
   * Anybody whose queue is `All` still sees these, which on this team is most
   * people, so the narrowing removes noise rather than sight.
   */
  [CASE_CATEGORY.SUBMIT_DOCS]: QUEUE.ACCOMMODATION,
  [CASE_CATEGORY.CONTACT_SUPPORT]: QUEUE.ACCOMMODATION,
};

/**
 * The queue a case belongs to.
 *
 * Takes `string` rather than `CaseCategory` because `cases.category` is a text
 * column, and a row written by a newer build can hold a value this one has never
 * heard of. Such a case routes to `All`: seen by too many people is a nuisance,
 * seen by nobody is the thing this system exists to prevent.
 */
export const queueForCategory = (category: string): Queue =>
  QUEUE_FOR_CATEGORY[category as CaseCategory] ?? QUEUE.ALL;

/**
 * The categories a staff member holding `queue` may see.
 *
 * Returned as a list so the visibility predicate can push the filter into SQL as
 * `category = ANY($1)` rather than expressing this map in SQL — the map stays in
 * one place, and it is this one.
 *
 * Note the asymmetry with `queueForCategory`, which is deliberate. An unknown
 * *category* widens to everybody; an unknown *queue* narrows to nobody. A case
 * this build cannot classify must still be worked, so it goes to everyone. A
 * staff row holding a queue this build cannot classify is a misconfiguration,
 * and granting sight of every teacher's case on the strength of a typo is the
 * wrong direction to fail.
 */
/**
 * The queues from which a case of this category can be seen.
 *
 * The inverse of `categoriesVisibleTo`, and it exists because notification asks
 * the question the other way round: given one case, which staff rows match?
 * That has to be a SQL `IN` list over `staff.queue` rather than a map evaluated
 * per row.
 *
 * The two must agree for every pair, and there is a test that walks all of them
 * — two expressions of one rule is precisely what `adminCanSeeCase_` became.
 * They do agree because both read `QUEUE_FOR_CATEGORY`: a category whose home
 * queue is `All` is visible from every queue, which is the uncategorised case
 * reaching everybody, and `None` sees nothing from either direction.
 */
export const queuesCovering = (category: string): readonly Queue[] => {
  const home = queueForCategory(category);
  return ALL_QUEUES.filter(
    (queue) =>
      queue !== QUEUE.NONE && (queue === QUEUE.ALL || home === QUEUE.ALL || home === queue),
  );
};

export const categoriesVisibleTo = (queue: string): readonly CaseCategory[] => {
  if (queue === QUEUE.ALL) return Object.values(CASE_CATEGORY);
  if (!isQueue(queue) || queue === QUEUE.NONE) return [];

  return Object.values(CASE_CATEGORY).filter(
    (category) =>
      QUEUE_FOR_CATEGORY[category] === queue || QUEUE_FOR_CATEGORY[category] === QUEUE.ALL,
  );
};
