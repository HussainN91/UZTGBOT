/**
 * Who gets told, when the answer depends on a region.
 *
 * Extracted from `cases/notify.ts`, which had the only copy of this query and
 * was about to acquire a second caller with slightly different needs. The
 * identity-dispute feature will be the third: a dispute is escalated to whoever
 * covers **the roster region of the disputed identifier**, which is the same
 * question this file answers and a different question from "who works this
 * case".
 *
 * The whole reason it is one module rather than three similar `SELECT`s is that
 * the rules are subtle in ways that do not survive being retyped:
 *
 *   **An empty `regions` array means every region, never none** (`schema.ts`).
 *   A copy that reads `region = ANY(regions)` and stops there silently excludes
 *   every all-region staff member, which on a small team is everybody.
 *
 *   **A null region widens rather than narrows** (D10). A teacher with no
 *   recorded region must reach somebody, so "we do not know where they are"
 *   cannot become "so nobody is told".
 *
 *   **System bypasses both axes**, exactly as `visibleToStaff` does. Without it
 *   a System member with a misconfigured queue is the one person who can never
 *   be told about anything.
 *
 * Nothing here sends. It returns chat ids; layer 3 turns them into messages.
 * That is the rule Part 0 of the programme plan names as the single easiest one
 * to break, and a store that could send would break it here first — this is the
 * module whose whole subject is who to talk to.
 */
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { staff } from '../db/schema.js';
import { queuesCovering } from './queues.js';
import { type Capability, rolesHolding } from './roles.js';

export interface RecipientQuery {
  /**
   * What the recipient must be permitted to do.
   *
   * Filtered on the capability the message asks them to *exercise*, never on
   * `case.view` — R14, and it is the mistake `notifyAdminsOfNewCase_` made by
   * filtering on visibility alone. An Observer can read every case in their
   * queue and change none of them, so paging one is paging somebody about work
   * they are not permitted to do.
   */
  readonly capability: Capability;
  /**
   * Narrow to the queues that cover this case category.
   *
   * Omitted means the queue axis is not consulted at all, which is right for a
   * message that is not about a case — an identity dispute is not filed under a
   * category and has no queue, so filtering by one would silently exclude
   * everybody whose queue happened not to be `All`.
   */
  readonly category?: string;
  /** `null` widens to everybody. See the header. */
  readonly region: string | null;
}

/**
 * The region half of the predicate, as SQL.
 *
 * The `null` branch is taken in JavaScript rather than in SQL because binding a
 * null parameter into `$1 IS NULL` leaves PostgreSQL unable to infer its type.
 *
 * Note that `region` here is a *value* and `staff.regions` is the column, so the
 * array-interpolation trap documented in `visibility.ts` does not apply —
 * `unnest` is over the staff row's own column.
 */
function regionClause(region: string | null) {
  if (region === null) return sql`true`;
  return sql`(cardinality(${staff.regions}) = 0
              OR lower(${region}) IN (SELECT lower(r) FROM unnest(${staff.regions}) AS r))`;
}

/**
 * Active staff who hold `capability` and whose queue and region reach this.
 *
 * The inverse of the visibility predicate — that one asks "which cases may this
 * person see", this asks "which people may see this" — and both read the same
 * two maps rather than restating the rule.
 *
 * Ordered by id so the same people are chosen for the same case whichever way
 * the rows happen to come back. Uncapped: the cap is a latency bound that
 * belongs to the caller doing the sending, not to the question of who is
 * eligible, and a lookup that silently truncated would make "nobody covers
 * this" and "twenty-one people cover this" indistinguishable to a caller that
 * only wanted to count.
 */
export async function staffCovering(db: Database, query: RecipientQuery): Promise<string[]> {
  return (await coveringRows(db, query)).map((r) => r.telegramId);
}

/**
 * Active staff who could actually **work** this case — the covering set, minus
 * anybody who is only in it through the System bypass. Part 5H.1.
 *
 * **The distinction is the whole reason this exists**, and reusing
 * `staffCovering` for assignment would have been quietly wrong in a way nothing
 * would report. A System member is returned by that function unconditionally, so
 * that a case in a region nobody covers still *reaches* somebody — which is
 * correct, and is what the bypass is for. But being able to see every case in
 * the country is not the same as being the person who works it, and an assigner
 * that could not tell the difference would hand every case to a System
 * administrator.
 *
 * It would also destroy the one thing `/cases unassigned` is for. Every case
 * would have an owner, so the intake backlog would read as empty while the
 * staffing gap it exists to expose went on growing — R4, restored exactly as it
 * was before this system was rebuilt.
 *
 * So the answer here is deliberately allowed to be **nobody**. A case no active
 * staff member holds the queue and region for stays unowned, and that is the
 * signal. It is still visible to System, through the bypass, exactly as before.
 *
 * The bypass flag is read from `coveringRows` rather than recomputed, so this
 * cannot drift from what "System" means to the rest of the file.
 */
export async function staffWorking(db: Database, query: RecipientQuery): Promise<string[]> {
  return (await coveringRows(db, query)).filter((r) => !r.bypassed).map((r) => r.telegramId);
}

interface CoveringRow {
  readonly telegramId: string;
  /**
   * Reached by the System bypass rather than by queue and region.
   *
   * Carried out of the query because the two callers need different things from
   * the same rows, and recomputing it would mean a second copy of what "System"
   * means. See `regionalRecipients`.
   */
  readonly bypassed: boolean;
}

async function coveringRows(db: Database, query: RecipientQuery): Promise<CoveringRow[]> {
  const roles = [...rolesHolding(query.capability)];
  if (roles.length === 0) return [];

  const queues = query.category === undefined ? null : [...queuesCovering(query.category)];
  if (queues !== null && queues.length === 0) return [];

  const covers =
    queues === null
      ? regionClause(query.region)
      : and(inArray(staff.queue, queues), regionClause(query.region));

  const rows = await db
    .select({
      telegramId: staff.telegramId,
      /**
       * True when the row matched *only* because it is System.
       *
       * A System member whose queue and region genuinely reach this is not a
       * fallback and must not be reported as one — otherwise every message on a
       * small team where System also covers the region would carry a staffing
       * warning that is not true.
       */
      bypassed: sql<boolean>`(${eq(staff.role, 'System')} AND NOT (${covers}))`,
    })
    .from(staff)
    .where(and(eq(staff.active, true), inArray(staff.role, roles), or(eq(staff.role, 'System'), covers)))
    .orderBy(asc(staff.telegramId));

  return rows.map((r) => ({ telegramId: r.telegramId, bypassed: r.bypassed }));
}

export interface RegionalRecipients {
  readonly chatIds: readonly string[];
  /**
   * True when nobody covered the region and these are System members instead.
   *
   * Reported rather than hidden, because the two situations need different
   * words. A coordinator being asked to decide something in their own region is
   * ordinary; a System member being asked to decide something because **no
   * coordinator covers that region at all** is a staffing gap, and the message
   * has to say so or the gap is invisible for as long as somebody keeps
   * answering it.
   */
  readonly viaSystemFallback: boolean;
}

/**
 * The people who decide something about a region, with System as the floor.
 *
 * "A region nobody covers must not become a dispute nobody sees" — the
 * programme plan says it about identity disputes, and it is equally true of an
 * urgent request: the accepted risk there is that a request waits on **one**
 * regional coordinator, and that risk is only acceptable while there is always
 * one. When there is not, the request must land on somebody rather than nowhere.
 *
 * The fallback is System rather than "everybody", and the difference matters.
 * Widening to every staff member on a region miss would route a Samarkand
 * teacher's request to whoever happens to cover Bukhara, who has no way to check
 * anything about them; System is at least the rank that can fix the staffing
 * hole that caused it.
 */
export async function regionalRecipients(
  db: Database,
  query: RecipientQuery,
): Promise<RegionalRecipients> {
  const rows = await coveringRows(db, query);

  /**
   * **The fallback is not a second query, and an earlier draft of this file got
   * that wrong in a way worth recording.**
   *
   * It read "if `staffCovering` found nobody, go and fetch the System members" —
   * which can never fire, because `staffCovering` already returns every active
   * System member unconditionally. An empty result therefore meant there were no
   * System members either, so the fallback would have fetched nothing. The flag
   * was structurally always `false` and the branch was unreachable. A test
   * asserting the fallback is what found it.
   *
   * The honest question is not "did we have to fall back" but "is System the
   * *only* reason anybody is being told" — that is what the recipient needs to
   * read, because it means nobody covers the region.
   */
  return {
    chatIds: rows.map((r) => r.telegramId),
    viaSystemFallback: rows.length > 0 && rows.every((r) => r.bypassed),
  };
}
