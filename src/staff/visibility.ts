/**
 * The single visibility rule: queue AND region must both permit it.
 *
 * A SQL fragment rather than a filter over fetched rows, which is what
 * `adminCanSeeCase_` had to be. That forced `caseRegionMap_` to exist, whose own
 * comment says the memoisation is "not an optimisation — it is a correctness
 * requirement" against the execution limit; the whole apparatus is an artefact
 * of not having a join. It also means `LIMIT` can be pushed into the query
 * rather than applied after fetching every case in order to display twenty.
 *
 * Every staff-facing case query applies this. None of them re-derives it.
 */
import { type SQL, and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { type StaffRole, cases, rosterEntries, teachers } from '../db/schema.js';
import { categoriesVisibleTo } from './queues.js';

/** What the predicate needs to know about the person asking. */
export interface StaffScope {
  readonly role: StaffRole;
  readonly queue: string;
  /** Empty means every region. Never means none. */
  readonly regions: readonly string[];
}

/**
 * The region a case is judged by.
 *
 * The same precedence `regionFor` applies, for the same reason (D20, R12): an
 * explicit decision by a named person beats an import, and the roster is read
 * live rather than from the copy taken at sign-in.
 *
 * It must NOT read `teachers.region`. That column is the snapshot written once
 * by `bindTeacher`, and this predicate is the most important consumer of a
 * region there is — reading it here would leave the fault `regionFor` exists to
 * fix alive in the one place that decides who sees a teacher's emergency, while
 * every other caller was correct.
 */
const caseRegion = sql<string | null>`coalesce(${teachers.regionOverride}, ${rosterEntries.region})`;

/**
 * Queue AND region, as one fragment.
 *
 * ⚠️ A JS array cannot be interpolated into a `sql` template. Drizzle expands
 * `${someArray}` into a *parameter list* — `($1, $2)` — not into an array
 * literal, so `= ANY(${arr})` becomes `= ANY(($1, $2))` and PostgreSQL rejects
 * it outright. A `::text[]` cast does not rescue it, and an empty array yields
 * `()`, which is a syntax error too. `inArray` is used throughout instead: it
 * emits `in ($1, $2)` and degrades safely on an empty list. This fails at the
 * database, where neither the typechecker nor a reading can see it.
 */
export function visibleToStaff(scope: StaffScope): SQL {
  /**
   * A System member bypasses both axes, exactly as `adminCanSeeCase_` does
   * (`AdminCommands.gs:290-294`). Returned before anything else is computed so
   * that a System member with a misconfigured queue still sees everything.
   */
  if (scope.role === 'System') return sql`true`;

  const categories = [...categoriesVisibleTo(scope.queue)];

  /**
   * An empty regions list means every region, and it is decided here in
   * JavaScript rather than with `cardinality()` in SQL — partly because the
   * array cannot be bound at all, and partly because a branch that reads as a
   * branch is clearer than one hidden inside a boolean expression.
   *
   * `IS NULL` is load-bearing and not obvious: a teacher with no region on
   * either the override or the roster must be visible to everybody. Without it
   * they file cases no region-scoped staff member can see, and nobody finds out.
   */
  const regionClause =
    scope.regions.length === 0
      ? sql`true`
      : sql`(${caseRegion} IS NULL OR ${inArray(
          sql`lower(${caseRegion})`,
          scope.regions.map((r) => r.toLowerCase()),
        )})`;

  return and(inArray(cases.category, categories), regionClause)!;
}

/**
 * The joins every caller must apply, stated here because the predicate above is
 * meaningless without them and the LEFT is not a detail:
 *
 *   .innerJoin(teachers, eq(cases.teacherChatId, teachers.chatId))
 *   .leftJoin(rosterEntries, eq(teachers.identifier, rosterEntries.identifier))
 *
 * `teachers` is INNER and that is safe — `cases.teacher_chat_id` is a non-null
 * foreign key, so every case has one.
 *
 * `roster_entries` must be LEFT. A teacher whose roster row was removed still
 * has cases, and an INNER join would make those cases invisible to everybody,
 * which is precisely the failure this predicate exists to prevent. There is a
 * test for it.
 *
 * Written as a comment rather than a helper function: the drizzle query builder
 * types each join into the row shape, so a generic wrapper needs casts that
 * defeat the type checking this codebase relies on to catch a renamed column.
 */

/**
 * The references a staff member may see.
 *
 * Deliberately small: it exists so the rule can be tested on its own, before any
 * command depends on it. The real listing queries live in `cases/queries.ts` and
 * apply the same fragment with their own columns, ordering and limits.
 */
export async function visibleCaseReferences(db: Database, scope: StaffScope): Promise<string[]> {
  const rows = await db
    .select({ reference: cases.reference })
    .from(cases)
    .innerJoin(teachers, eq(cases.teacherChatId, teachers.chatId))
    .leftJoin(rosterEntries, eq(teachers.identifier, rosterEntries.identifier))
    .where(visibleToStaff(scope));
  return rows.map((r) => r.reference);
}
