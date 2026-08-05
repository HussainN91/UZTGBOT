/**
 * Which staff member a new case is given to — Part 5H.1.
 *
 * **The rule, chosen by the head of project on 1 August 2026: the person with
 * the fewest open cases**, out of the staff whose queue and region already reach
 * it.
 *
 * Part 5D of the plan recommended against building this, on the grounds that
 * `visibleToStaff` already routes a case to exactly the right people and a name
 * against it added little. That recommendation was overruled, and the reason it
 * was right to overrule it is worth keeping: visibility answers *who may work
 * this*, and ownership answers *who is going to*. Only the second makes
 * `/mycases` a list somebody works from, and only the second leaves a name
 * against a case that has gone quiet.
 *
 * Layer 2, and it sends nothing. It answers a question and the caller writes the
 * answer down.
 */
import { inArray, sql } from 'drizzle-orm';
import { cases } from '../db/schema.js';
import { OPEN_CASE_STATUSES } from '../db/schema.js';
import type { Database } from '../db/index.js';
import { CAPABILITY } from './roles.js';
import { staffWorking } from './recipients.js';

export interface OwnerQuery {
  /** The case's category, which decides the queue. */
  readonly category: string;
  /** The teacher's region, or null when we hold none — see `chooseOwner`. */
  readonly region: string | null;
}

interface Load {
  readonly owner: string;
  readonly openCases: number;
  /**
   * When they were last given anything at all, as seconds, or null if never.
   *
   * **A number rather than a `Date`, and that is not a style choice.** Typing
   * this as `Date` compiles perfectly and throws at run time: drizzle installs
   * its own pg type parsers, so a `timestamptz` selected through raw SQL arrives
   * as a **string**. It is the first of the three traps written down in
   * `CLAUDE.md`, and it was walked into here on 1 August 2026 while writing the
   * comment two fields below warning about its sibling.
   *
   * The conversion is done in PostgreSQL rather than in JavaScript, so there is
   * no second place for it to be forgotten.
   */
  readonly lastGivenSeconds: number | null;
}

/**
 * The one who should take this case, or `null` for nobody.
 *
 * **`null` is an answer, not a failure.** It means no active staff member holds
 * this queue in this region, and the case stays unowned so that
 * `/cases unassigned` shows it. That list used to mean "nobody has picked this
 * up"; from here it means something sharper — a staffing gap somebody has to
 * close. See `staffWorking` for why System is not allowed to paper over it.
 *
 * **A null region means every staff member is eligible.** A teacher whose region
 * we do not hold has their cases visible to everybody (D10) — over-routed rather
 * than misrouted — so the assignable set has to match, or a case that everyone
 * can see would be one nobody can be given.
 *
 * Candidates must hold `case.update`, which floors at Support. That is the
 * capability for *working* a case, and it is deliberately not `case.assign`:
 * assigning is now a Program action (Part 5H.2), while being assigned is what
 * every ordinary staff member is for. An Observer may read a case and may never
 * own one.
 */
export async function chooseOwner(db: Database, query: OwnerQuery): Promise<string | null> {
  const working = await staffWorking(db, {
    category: query.category,
    region: query.region,
    capability: CAPABILITY.CASE_UPDATE,
  });
  const candidates = working.map((c) => c.telegramId);

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0] ?? null;

  const loads = await loadsFor(db, candidates);
  return leastLoaded(candidates, loads);
}

/**
 * Open cases per candidate, and when each was last given anything.
 *
 * **Open cases only**, for the count. The question is who has capacity now, not
 * who has ever been busy — counting finished work would push new cases away from
 * whoever has been clearing theirs, which is precisely backwards.
 *
 * `lastGiven` reads **every** case, open or closed, because it answers a
 * different question: who has waited longest for work. Somebody who closed
 * everything this morning has not been waiting.
 *
 * `::int` is not decoration. `count(*)` comes back from PostgreSQL as `bigint`,
 * which node-postgres hands over as a **string** — the same trap that cost this
 * project three faults through `db.execute`. Casting in SQL is the fix that
 * cannot be forgotten at the call site.
 *
 * `inArray` rather than an interpolated array: binding a JavaScript array into
 * raw SQL passes the whole thing as one parameter and PostgreSQL reads it as an
 * array literal.
 */
async function loadsFor(db: Database, candidates: readonly string[]): Promise<Load[]> {
  const rows = await db
    .select({
      owner: cases.owner,
      openCases: sql<number>`count(*) FILTER (
        WHERE ${cases.status} IN ${OPEN_CASE_STATUSES}
      )::int`,
      lastGivenSeconds: sql<number | null>`extract(epoch from max(${cases.createdAt}))::float8`,
    })
    .from(cases)
    .where(inArray(cases.owner, [...candidates]))
    .groupBy(cases.owner);

  return rows.flatMap((r) =>
    r.owner === null
      ? []
      : [
          {
            owner: r.owner,
            // Coerced anyway. `::float8` is what makes this a number rather than
            // a string, and Number() is what makes that true of both branches.
            openCases: Number(r.openCases),
            lastGivenSeconds: r.lastGivenSeconds === null ? null : Number(r.lastGivenSeconds),
          },
        ],
  );
}

/**
 * Fewest open cases, then whoever has waited longest, then the earliest id.
 *
 * **Every step is deterministic, and that is a requirement rather than a
 * nicety.** `createCase` can be retried — Telegram resends anything it thinks
 * failed — and a picker that answered differently on two runs of the same
 * question would put one case in two people's names depending on which attempt
 * committed.
 *
 * A candidate with no cases at all has no row in `loads`, which is why the
 * defaults here are "nothing open, never given anything" rather than an error:
 * somebody who has never been given a case is exactly who should get the next
 * one, and they win both of the first two comparisons.
 *
 * The final tie-break is the order `staffWorking` returned, which is by id. It
 * decides nothing on its own — it is only reached when two people have the same
 * load and have waited the same length of time — but without it the answer would
 * depend on how PostgreSQL happened to group the rows.
 */
function leastLoaded(candidates: readonly string[], loads: readonly Load[]): string | null {
  const byOwner = new Map(loads.map((l) => [l.owner, l]));

  let best: string | null = null;
  let bestOpen = Number.POSITIVE_INFINITY;
  let bestGiven = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const load = byOwner.get(candidate);
    const open = load?.openCases ?? 0;
    // Never given anything sorts before everybody who has been.
    const given = load?.lastGivenSeconds ?? Number.NEGATIVE_INFINITY;

    if (open < bestOpen || (open === bestOpen && given < bestGiven)) {
      best = candidate;
      bestOpen = open;
      bestGiven = given;
    }
  }

  return best;
}
