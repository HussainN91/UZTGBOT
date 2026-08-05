# A quieter bot, phase one: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One case produces one message, to one person, in three lines and a button,
and a Program admin can take an urgent marking back.

**Architecture:** The `queue` column currently means both "what may I see" and "what
may I be handed". This phase leaves the first alone and moves the second into the
assigner, which now prefers Support and Lead and falls back through Program to
System. With one owner per case, notification stops fanning out and simply writes to
the owner. The un-urgent button is a new layer-3 action module beside
`dispute-actions.ts`, for the cycle reason recorded there.

**Tech stack:** TypeScript, drizzle-orm over PostgreSQL, grammY, vitest. Layer rules
in `CLAUDE.md` §2. Nothing in this plan may import upward.

**Design of record:** `docs/plans/2026-08-05-a-quieter-bot-design.md`. Decisions are
cited as D1 to D9 from its §3.

---

## Before you start

**The test database is a container with no volume and is probably not running.**

```bash
docker desktop start && docker compose -f docker-compose.test.yml up -d && docker inspect --format "{{.State.Health.Status}}" mopse-test-postgres-1
```

Wait for `healthy`. Then every test command in this plan is run in PowerShell with:

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run <path>
```

**Never pipe vitest through `head`.** It closes the pipe, the shell returns, and the
run continues invisibly. Filter with `Select-String`.

**On D9 and what it does and does not mean.** The head of project asked for one full
suite run at the end of both phases rather than one per phase. That is about the
*full* suite. Every task below still runs its own test file, because a plan that
defers all testing is not test-driven and the failures would arrive in a heap. The
full `npx vitest run` with no path happens once, after phase two.

---

## File structure

| File | Layer | Responsibility after this phase |
|---|---|---|
| `src/staff/queues.ts` | 2 | The category-to-queue map. Uncategorised now means Accommodation |
| `src/staff/recipients.ts` | 2 | Who covers a case. Now reports each person's rank alongside their id |
| `src/staff/assignment.ts` | 2 | Who is given a case. Owns the rank preference |
| `src/cases/service.ts` | 2 | Opens a case. Now returns the owner it chose |
| `src/cases/notify.ts` | 2 | What is said about a case and to whom. Now one recipient |
| `src/cases/urgent.ts` | 2 | The urgent gate. Gains un-marking |
| `src/db/schema.ts` | 2 | One new nullable column on `cases` |
| `src/telegram/urgent-actions.ts` | 3 | **New.** The un-urgent action, shared by the button and any later command |
| `src/telegram/callback-data.ts` | 1 | One new prefix |
| `src/telegram/router.ts` | 3 | Routes the new tap, passes the owner into the notice |

---

## Task 1: An uncategorised case goes to Accommodation

D6. Today `Contact Support` and `Submit Documents` map to the `All` queue, which
means every staff member sees them. Accommodation is a narrowing.

**Files:**
- Modify: `src/staff/queues.ts:56-63`
- Test: `src/staff/queues.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/staff/queues.test.ts`:

```typescript
describe('an uncategorised case', () => {
  it('belongs to Accommodation rather than to everybody', () => {
    // D6. "Contact Support" is by definition the case the teacher did not
    // classify. Routing it to All meant every staff member was shown every
    // unclassified problem in the country, which is most of them.
    expect(queueForCategory('Contact Support')).toBe('Accommodation');
    expect(queueForCategory('Submit Documents')).toBe('Accommodation');
  });

  it('is still visible from the All queue', () => {
    // The narrowing must not hide it from somebody who covers everything.
    expect(categoriesVisibleTo('All')).toContain('Contact Support');
    expect(queuesCovering('Contact Support')).toContain('All');
    expect(queuesCovering('Contact Support')).toContain('Accommodation');
  });

  it('is no longer visible from an unrelated queue', () => {
    expect(queuesCovering('Contact Support')).not.toContain('Visa');
    expect(categoriesVisibleTo('Visa')).not.toContain('Contact Support');
  });

  it('still routes a category this build has never heard of to everybody', () => {
    // The asymmetry in the header of queues.ts is deliberate and survives D6:
    // an unknown category widens, an unknown queue narrows. A case written by a
    // newer build must still be worked.
    expect(queueForCategory('Something From 2027')).toBe('All');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/staff/queues.test.ts
```

Expected: fails with `expected 'All' to be 'Accommodation'`.

- [ ] **Step 3: Change the map**

In `src/staff/queues.ts`, replace the two `QUEUE.ALL` entries:

```typescript
export const QUEUE_FOR_CATEGORY: Readonly<Record<CaseCategory, Queue>> = {
  [CASE_CATEGORY.VISA]: QUEUE.VISA,
  [CASE_CATEGORY.TRAVEL]: QUEUE.TRAVEL,
  [CASE_CATEGORY.CONTRACT]: QUEUE.CONTRACT,
  [CASE_CATEGORY.ACCOMMODATION]: QUEUE.ACCOMMODATION,
  /**
   * Both moved from `All` to `Accommodation` on 5 August 2026, D6.
   *
   * `All` was the safe answer when nothing else was known: an uncategorised case
   * reaching nobody is the failure the new-case alert exists to catch, so it went
   * to everybody instead. That was correct and it was also most of the noise a
   * MoPSE employee reported, because "Contact Support" is the category a teacher
   * picks when they have not classified their problem, which is often.
   *
   * Accommodation is the desk that takes general questions in this ministry. The
   * case is still visible from `All`, so nobody covering everything loses sight of
   * it, and `queuesCovering` still returns both.
   */
  [CASE_CATEGORY.SUBMIT_DOCS]: QUEUE.ACCOMMODATION,
  [CASE_CATEGORY.CONTACT_SUPPORT]: QUEUE.ACCOMMODATION,
};
```

- [ ] **Step 4: Run the test again**

Same command. Expected: PASS.

- [ ] **Step 5: Run the visibility tests, which read the same map**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/staff/visibility.integration.test.ts src/cases/queries.integration.test.ts
```

Expected: PASS. If a test fails asserting that a Visa-queue member sees a Contact
Support case, **the test is right to fail and its expectation changes**, because
that is exactly what D6 removes. Update the expectation and say so in the commit.

- [ ] **Step 6: Commit**

```bash
git add src/staff/queues.ts src/staff/queues.test.ts && git commit -m "feat: an unclassified problem goes to a desk, not to everybody"
```

---

## Task 2: `staffWorking` reports each person's rank

The assigner is about to need it. Nothing else changes behaviour in this task.

**Files:**
- Modify: `src/staff/recipients.ts:120-166`
- Modify: `src/staff/assignment.ts:72-84` (call site only, to keep it compiling)
- Test: `src/staff/recipients.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/staff/recipients.integration.test.ts`, inside the existing top-level
`describe`:

```typescript
it('reports the rank beside each candidate, so the assigner can prefer one', async () => {
  // The assigner has to tell a Support member from a Program one, and it must
  // read that from the same query that decided who covers the case rather than
  // going back for it. Two queries is two answers to one question.
  await db.execute(sql`
    INSERT INTO staff (telegram_id, name, role, queue, regions, active) VALUES
      ('770001', 'A Support', 'Support', 'All', ARRAY[]::text[], true),
      ('770002', 'A Program', 'Program', 'All', ARRAY[]::text[], true)
  `);

  const working = await staffWorking(db, {
    capability: CAPABILITY.CASE_UPDATE,
    category: 'Visa',
    region: 'Tashkent',
  });

  expect(working).toContainEqual({ telegramId: '770001', role: 'Support' });
  expect(working).toContainEqual({ telegramId: '770002', role: 'Program' });
});
```

Add `staffWorking` to the import from `./recipients.js` at the top of that file if
it is not already there.

- [ ] **Step 2: Run it and watch it fail**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/staff/recipients.integration.test.ts
```

Expected: fails, because `staffWorking` returns an array of strings.

- [ ] **Step 3: Carry the rank out of the query**

In `src/staff/recipients.ts`, change the import to include the role type:

```typescript
import { type StaffRole, staff } from '../db/schema.js';
```

Add the rank to `CoveringRow` and select it:

```typescript
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
  /**
   * Their rank, carried for the assigner rather than for authorisation.
   *
   * `chooseOwner` prefers Support and Lead and falls back through Program to
   * System (D3), which it cannot decide without this. Read from the same row that
   * answered "does this person cover the case", because asking twice is how two
   * answers to one question start disagreeing.
   */
  readonly role: StaffRole;
}
```

In `coveringRows`, add `role: staff.role` to the `.select({...})` object, and to
the returned mapping:

```typescript
  return rows.map((r) => ({ telegramId: r.telegramId, bypassed: r.bypassed, role: r.role }));
```

Replace `staffWorking` with:

```typescript
export interface WorkingCandidate {
  readonly telegramId: string;
  readonly role: StaffRole;
}

export async function staffWorking(db: Database, query: RecipientQuery): Promise<WorkingCandidate[]> {
  return (await coveringRows(db, query))
    .filter((r) => !r.bypassed)
    .map((r) => ({ telegramId: r.telegramId, role: r.role }));
}
```

- [ ] **Step 4: Keep the one caller compiling, with no behaviour change yet**

In `src/staff/assignment.ts`, `chooseOwner` currently reads `candidates` as chat
ids. Change only the extraction:

```typescript
  const working = await staffWorking(db, {
    category: query.category,
    region: query.region,
    capability: CAPABILITY.CASE_UPDATE,
  });
  const candidates = working.map((c) => c.telegramId);
```

- [ ] **Step 5: Run the tests**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/staff/recipients.integration.test.ts src/staff/assignment.integration.test.ts
```

Expected: PASS, both files. Assignment behaviour is unchanged in this task.

- [ ] **Step 6: Typecheck, then commit**

```bash
npm run typecheck && git add src/staff/recipients.ts src/staff/assignment.ts src/staff/recipients.integration.test.ts && git commit -m "refactor: who covers a case now says what rank they hold"
```

---

## Task 3: New cases go to Support and Lead first

D3. The Program admin and the System member leave the rotation. They can still be
given a case with `/assign`, and they still see everything.

**Files:**
- Modify: `src/staff/assignment.ts`
- Test: `src/staff/assignment.integration.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/staff/assignment.integration.test.ts`:

```typescript
describe('who is offered a new case', () => {
  it('gives it to a Support member while a Program member sits idle', async () => {
    // D3. The Program admin is "the MoPSE employee that doesn't wanna be
    // bothered with IT stuff". Having no open cases must not make her the
    // obvious candidate, which under the plain fewest-open rule it did: she was
    // the least loaded person in the ministry precisely because nobody had given
    // her anything yet.
    await givenStaff('880001', 'Support', 'All', []);
    await givenStaff('880002', 'Program', 'All', []);
    await givenCases('880001', 3);

    expect(await forVisaInTashkent()).toBe('880001');
  });

  it('falls back to Program when no Support or Lead member covers it', async () => {
    // The fallback is what makes "every case has an owner" (D4) absolute. It is
    // not expected to fire in this ministry, because a Support member covers
    // every region, and that is what lets the rule be stated with no exception.
    await givenStaff('880003', 'Program', 'All', []);

    expect(await forVisaInTashkent()).toBe('880003');
  });

  it('falls all the way to System when nobody else is active at all', async () => {
    // A System member with a queue and regions that genuinely reach the case is
    // not a bypass row, so `staffWorking` returns them and this tier is real.
    await givenStaff('880004', 'System', 'All', []);

    expect(await forVisaInTashkent()).toBe('880004');
  });

  it('still picks the least loaded within the rank it settles on', async () => {
    // The preference decides which tier. Inside a tier nothing has changed.
    await givenStaff('880005', 'Lead', 'All', []);
    await givenStaff('880006', 'Support', 'All', []);
    await givenCases('880005', 2);

    expect(await forVisaInTashkent()).toBe('880006');
  });
});
```

`givenStaff(id, role, queue, regions)`, `givenCases(owner, count)` and
`forVisaInTashkent()` are the helpers this file already defines at lines 39 to 65.
Use them. Do not add a second way to do the same setup.

- [ ] **Step 2: Run and watch the first two fail**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/staff/assignment.integration.test.ts
```

Expected: the idle-Program test fails with `expected '880002' to be '880001'`.

- [ ] **Step 3: Add the rank preference**

In `src/staff/assignment.ts`, add the import and the tiers above `chooseOwner`:

```typescript
import type { StaffRole } from '../db/schema.js';

/**
 * The ranks a new case is offered to, best first — D3, 5 August 2026.
 *
 * The head of project asked for the Program admin and the System member to leave
 * the rotation and keep the ability to own a case. Both halves matter: `/assign`
 * still works on them, and a case given that way behaves exactly as any other.
 *
 * **A rank rule rather than a switch on the staff row.** Nothing has to be
 * configured, so nothing can be left unconfigured, and the fallback makes D4
 * absolute: a tier can be empty, but the chain cannot run out while any staff
 * member covers the case. If a second Program admin is ever hired who does work
 * cases, this becomes a per-person "takes new cases" column and this constant goes
 * away.
 *
 * In this ministry the first tier always wins, because a Support member covers
 * every category in every region. The rest is a guarantee rather than a path.
 */
const RANK_PREFERENCE: readonly (readonly StaffRole[])[] = [
  ['Support', 'Lead'],
  ['Program'],
  ['System'],
];
```

Replace the body of `chooseOwner`:

```typescript
export async function chooseOwner(db: Database, query: OwnerQuery): Promise<string | null> {
  const working = await staffWorking(db, {
    category: query.category,
    region: query.region,
    capability: CAPABILITY.CASE_UPDATE,
  });

  if (working.length === 0) return null;

  /**
   * The first tier with anybody in it, and nobody from a lower one.
   *
   * Walked in order rather than filtered once, so a Program member never competes
   * with a Support member on load. Merging the tiers and sorting by rank would be
   * the same thing until two people tie, and then it would quietly hand the case
   * upward.
   */
  const tier =
    RANK_PREFERENCE.map((ranks) => working.filter((c) => ranks.includes(c.role))).find(
      (found) => found.length > 0,
    ) ?? [];

  const candidates = tier.map((c) => c.telegramId);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0] ?? null;

  const loads = await loadsFor(db, candidates);
  return leastLoaded(candidates, loads);
}
```

- [ ] **Step 4: Run the tests**

Same command. Expected: PASS, all four new tests and every existing one. **If an
existing test fails because it expected a Program or System member to be given a
case, it is right to fail** and its expectation changes.

- [ ] **Step 5: Commit**

```bash
npm run typecheck && git add src/staff/assignment.ts src/staff/assignment.integration.test.ts && git commit -m "feat: new work goes to the people hired to do it"
```

---

## Task 4: A created case reports who it was given to

`notifyNewCase` is about to write to the owner, and only `createCase` knows who
that is. Today it is chosen, written and forgotten.

**Files:**
- Modify: `src/cases/service.ts:96-100` and the insert that follows
- Test: `src/cases/service.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('reports the owner it chose, so the notice can be sent to one person', async () => {
  // D1. Notification used to recompute the recipients from scratch, which is how
  // one case reached twenty people. The owner is decided here and nowhere else,
  // so it travels out of here rather than being asked for a second time.
  await db.execute(sql`
    INSERT INTO staff (telegram_id, name, role, queue, regions, active)
    VALUES ('990001', 'A Support', 'Support', 'All', ARRAY[]::text[], true)
  `);

  const created = await createCase(db, {
    chatId: TEACHER,
    category: CASE_CATEGORY.VISA,
    detail: 'visa refused',
  });

  expect(created.owner).toBe('990001');
});

it('reports a null owner when nobody covers the case', async () => {
  const created = await createCase(db, {
    chatId: TEACHER,
    category: CASE_CATEGORY.VISA,
    detail: 'visa refused',
  });

  expect(created.owner).toBeNull();
});
```

The second test requires no active staff row, so place it where the fixture has
none, or delete the staff rows first with
`await db.execute(sql\`DELETE FROM staff\`);` inside the test.

- [ ] **Step 2: Run and watch it fail**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/cases/service.integration.test.ts
```

Expected: fails, `owner` is not a property of the result.

- [ ] **Step 3: Return it**

In `src/cases/service.ts`:

```typescript
export interface CreateCaseResult {
  readonly reference: string;
  /** False when an open case in the same category already existed. */
  readonly isNew: boolean;
  /**
   * The staff member the case was given to, or null when nobody covers it.
   *
   * Returned because notification writes to exactly this person (D1) and this is
   * the only place the choice is made. `null` is an answer rather than a failure:
   * it means no active staff member holds this queue and region, the case sits in
   * `/cases unassigned`, and the operations chat is told.
   *
   * On the deduplicated path it is the **existing** case's owner, not a fresh
   * choice, because nothing is being assigned. Nothing is announced on that path
   * either, so it is read rather than acted on.
   */
  readonly owner: string | null;
}
```

Return `owner` from both exits of `createCase`. On the new-case path it is the
value `chooseOwner` returned. On the duplicate path, extend the existing lookup to
select the owner alongside the reference:

```typescript
  const existing = await db
    .select({ reference: cases.reference, owner: cases.owner })
    .from(cases)
    .where(
```

and return `{ reference: existing[0].reference, isNew: false, owner: existing[0].owner }`
in whatever shape that branch already uses.

- [ ] **Step 4: Run the tests**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run typecheck && git add src/cases/service.ts src/cases/service.integration.test.ts && git commit -m "feat: a new case says who it went to"
```

---

## Task 5: One case, one message

D1, and the short wording. This is the task the whole phase is for.

**Files:**
- Modify: `src/cases/notify.ts:48-139` and `440-522`
- Modify: `src/telegram/router.ts:798-804`
- Test: `src/cases/notify.integration.test.ts`

- [ ] **Step 1: Write the failing tests**

This file already has `fileAndNotify(teacherChatId, category)`, which opens a case
and announces it inside one transaction. **Extend it to return the owner** that
`createCase` chose, alongside whatever it returns today, and use it here rather
than calling `notifyNewCase` with a hand-written reference.

```typescript
describe('a new case, announced', () => {
  it('writes to the owner and to nobody else', async () => {
    // D1, and the whole point of this phase. Several staff members cover a Visa
    // case in Tashkent. Exactly one of them hears about it.
    const { outcome, owner } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.VISA);

    expect(owner).toBe(VISA_SUPPORT_TASHKENT);
    expect(outcome.messages).toHaveLength(1);
    expect(outcome.messages[0]?.chatId).toBe(VISA_SUPPORT_TASHKENT);
  });

  it('says three lines and carries the case on a button', async () => {
    const { outcome, reference } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.VISA);

    const text = outcome.messages[0]?.text ?? '';
    expect(text).toContain('New case for you');
    expect(text).toContain('Visa');
    // Every typed command is gone, and so is the teacher's chat id.
    expect(text).not.toContain('/case ');
    expect(text).not.toContain('/assign');
    expect(text.split('\n').filter((l) => l.trim() !== '')).toHaveLength(3);

    expect(outcome.messages[0]?.keyboard?.[0]?.[0]?.callback_data).toBe(`CO:${reference}`);
  });

  it('has no em dash anywhere in it', async () => {
    // §7 of the design. The humanizer bans them outright, and they are most of
    // what made these messages read like a machine explaining itself.
    const { outcome } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.VISA);

    expect(outcome.messages[0]?.text).not.toContain('—');
  });

  it('tells the operations chat, and nobody personally, when nobody covers it', async () => {
    // The case is filed and the teacher has their reference. Nobody's phone goes
    // off about a case nobody can be given.
    await db.execute(sql`DELETE FROM staff`);

    const { outcome } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.VISA);

    expect(outcome.messages).toHaveLength(0);
    expect(outcome.alerts).toHaveLength(1);
    expect(outcome.alerts[0]?.severity).toBe('critical');
  });

  it('still moves the case off New', async () => {
    // D25 step 2a. The status move lives on this path and must survive the
    // recipient change, or a case stays at New for ever and /cases lies.
    const { reference } = await fileAndNotify(TASHKENT_TEACHER, CASE_CATEGORY.VISA);

    expect(await statusOf(reference)).toBe('Received');
  });
});
```

`TASHKENT_TEACHER`, `VISA_SUPPORT_TASHKENT`, `statusOf` and `CASE_CATEGORY` are all
already in this file.

- [ ] **Step 2: Run and watch them fail**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/cases/notify.integration.test.ts
```

Expected: fails on the unknown `owner` property.

- [ ] **Step 3: Take the owner and write to them alone**

In `src/cases/notify.ts`, extend the notice:

```typescript
export interface NewCaseNotice {
  readonly reference: string;
  readonly category: string;
  readonly teacherChatId: string;
  /**
   * The staff member this case was given to, or null when nobody covers it.
   *
   * **Passed in rather than computed here, and that is the change of 5 August
   * 2026 (D1).** This function used to ask `staffCovering` who could work the
   * case and write to all of them, up to twenty people. On a four-person team
   * that was three or four phones for one teacher's problem, and a MoPSE employee
   * reported the result as overwhelming.
   *
   * The owner is decided once, by `chooseOwner`, inside `createCase`. Recomputing
   * a recipient list here would be a second answer to a question that already has
   * one.
   */
  readonly owner: string | null;
}
```

Replace the body of `notifyNewCase` from the `staffCovering` call down to the
return:

```typescript
export async function notifyNewCase(
  db: Database,
  notice: NewCaseNotice,
): Promise<NotificationOutcome> {
  const region = await regionFor(db, notice.teacherChatId);

  if (notice.owner === null) {
    /**
     * Nobody covers this queue and region, so there is nobody to write to.
     *
     * It goes to the operations chat rather than to individuals, and that is D5
     * carried out: the head of project's rule is that somebody always covers
     * every region, so this is a misconfiguration rather than a working state.
     * The people who can fix a staffing hole are in that chat. A caseworker
     * reading it can do nothing about it and was the person most alarmed by the
     * old wording.
     */
    await logFanOut(db, notice.reference, 'STAFF_NOTIFIED_NEW', 0, 0);
    return { messages: [], alerts: [unownedAlert(notice, region)] };
  }

  const facts = await caseFacts(db, notice.reference);

  /**
   * D25, step 2a. Only a case still at `New` moves — the guard is inside
   * `markCaseReceived` and it is what stops an urgent case being demoted out of
   * `Escalated`, which is what puts it in `/urgent`.
   */
  await markCaseReceived(db, notice.reference);
  await logFanOut(db, notice.reference, 'STAFF_NOTIFIED_NEW', 1, 1);

  return {
    messages: [
      {
        chatId: notice.owner,
        text: noticeText(notice, region, facts),
        purpose: 'a new case notification',
        keyboard: [
          [
            {
              text: `📂 Open ${notice.reference}`,
              callback_data: encodeCallback(CALLBACK.CASE_OPEN, notice.reference),
            },
          ],
        ],
      },
    ],
    alerts: [],
  };
}
```

Replace `noticeText` entirely:

```typescript
/**
 * What the owner sees on their phone.
 *
 * Three lines and a button, down from seven lines and two typed commands. What
 * was cut is not gone: it is behind the button, which opens the case exactly as
 * tapping it in `/cases` does.
 *
 * **"for you" is only sayable because of D1.** When this went to everybody who
 * could work the case it had to be impersonal. One recipient means the message
 * can say whose case it is, which is the single most useful word in it.
 *
 * The reference sits on the button rather than in the body, so it is there when
 * it is needed and costs no line. No em dash, and no word that reads as an
 * accusation: §7 of the design, and the reason this rewrite exists.
 */
function noticeText(notice: NewCaseNotice, region: string | null, facts: CaseFacts): string {
  return [
    '🆕 New case for you',
    '',
    [notice.category, region ?? 'region not recorded'].join(' · '),
    facts.filedAt,
    ...(facts.area === null
      ? []
      : [facts.area.awaitingForm ? `📄 ${facts.area.label}, not sent yet` : `📄 ${facts.area.label}, sent`]),
  ].join('\n');
}
```

**The three-line assertion counts non-empty lines**, so a case raised in a form
area has four. Adjust that one test to build a case with no `form_type`, which the
fixture already does.

Change `caseFacts` to format a shorter date. In its SQL, replace the `to_char`
format string `'DD Mon YYYY, HH24:MI'` with `'DD Mon, HH24:MI'`.

**The mockup in the design said "Today at 08:15" and this says "05 Aug, 08:15".**
Deliberate: "today" needs a clock, and the module that would hold it is one of the
pure ones. The date is computed by PostgreSQL in Tashkent, as it already was.

Rename `unworkableAlert` to `unownedAlert`, take the `watchers` parameter out, and
rewrite the body:

```typescript
/** Nobody covers this case, so nobody was given it. R4, and D5 says it cannot happen. */
function unownedAlert(notice: NewCaseNotice, region: string | null): Alert {
  return {
    severity: 'critical',
    title: 'A case was filed that nobody covers',
    body: [
      `Case: ${notice.reference}`,
      `Category: ${notice.category}`,
      `Region: ${region ?? 'not recorded'}`,
      '',
      'No active staff member holds this queue in this region, so the case has no',
      'owner and nobody has been written to about it. The teacher has their reference',
      'and the case is safe at status New.',
      '',
      'Widen somebody’s queue or regions, or add a staff member. It will appear in',
      '/cases unassigned for whoever gains it.',
    ].join('\n'),
  };
}
```

Add `CALLBACK` and `encodeCallback` to the existing import from
`../telegram/callback-data.js` if `encodeCallback` is not already imported, and
delete the now-unused `staffCovering` and `CAPABILITY` imports **only if nothing
else in the file uses them**. `notifyUrgentConfirmed` still uses both, so check
before deleting.

- [ ] **Step 4: Pass the owner in at the call site**

In `src/telegram/router.ts` around line 798:

```typescript
    const notice = result.isNew
      ? await notifyNewCase(db, {
          reference: result.reference,
          category: filing.category,
          teacherChatId: chatId,
          owner: result.owner,
        })
      : NO_NOTIFICATION;
```

- [ ] **Step 5: Run the tests**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/cases/notify.integration.test.ts src/telegram/router.integration.test.ts
```

Expected: PASS. Existing tests asserting that several staff were notified **are
right to fail** and their expectations change to one recipient.

- [ ] **Step 6: Commit**

```bash
npm run typecheck && git add src/cases/notify.ts src/telegram/router.ts src/cases/notify.integration.test.ts && git commit -m "feat: one case, one message, three lines"
```

---

## Task 6: The priority request goes to the owner

**Files:**
- Modify: `src/cases/notify.ts:173-238`
- Test: `src/cases/notify.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('asks the owner about priority, not everybody in the region', async () => {
  // The same argument as D1 one message along. The person who will do the work
  // is the person who decides whether it jumps the queue.
  await db.execute(sql`
    INSERT INTO staff (telegram_id, name, role, queue, regions, active) VALUES
      ('660001', 'Owner',   'Support', 'All', ARRAY[]::text[], true),
      ('660002', 'Another', 'Support', 'All', ARRAY[]::text[], true)
  `);

  const outcome = await notifyUrgentRequest(db, {
    reference: 'VISA-2026-00311',
    teacherChatId: TEACHER,
    isNew: true,
    owner: '660001',
  });

  expect(outcome.messages).toHaveLength(1);
  expect(outcome.messages[0]?.chatId).toBe('660001');
  expect(outcome.messages[0]?.text).not.toContain('—');
  expect(outcome.messages[0]?.text).not.toContain('staffing gap');
});

it('sends one message, not two, when a case is filed and made urgent at once', async () => {
  // Both notices now go to the same person. Without the overlap strip this
  // design would put two messages about one case in one chat a second apart,
  // which is the exact thing it exists to remove.
  const outcome = await notifyUrgentRequestOnCase(db, {
    reference: 'VISA-2026-00311',
    teacherChatId: TEACHER,
    isNew: true,
    category: 'Visa',
    owner: '660001',
  });

  expect(outcome.messages).toHaveLength(1);
  expect(outcome.messages[0]?.text).toContain('Priority asked for');
});
```

- [ ] **Step 2: Run and watch it fail**

Same command as Task 5.

- [ ] **Step 3: Take the owner, drop the fan-out, shorten the words**

Add `readonly owner: string | null;` to `UrgentRequestNotice`, with a comment
pointing at `NewCaseNotice.owner` rather than repeating the argument.

In `notifyUrgentRequest`, replace the `regionalRecipients` call and the empty check
with the same `owner === null` branch shape used in Task 5, keeping
`noCoordinatorAlert` for the null case and taking its "nobody covers this region"
wording down to a plain statement.

**This function does not currently read the case row, and now needs to.** Add the
call beside the existing `teacherIdentity` one:

```typescript
  const facts = await caseFacts(db, notice.reference);
```

Then replace the message text with:

```typescript
  const text = [
    '⏫ Priority asked for',
    '',
    who.name ?? 'Name not on the roster',
    [notice.reference, region ?? 'region not recorded', facts.filedAt].join(' · '),
  ].join('\n');
```

and keep the existing `⏫ Confirm urgent` button, relabelled `⏫ Make it a priority`,
adding a second button in the same row:

```typescript
      keyboard: [
        [
          {
            text: '📂 Open case',
            callback_data: encodeCallback(CALLBACK.CASE_OPEN, notice.reference),
          },
          {
            text: '⏫ Make it a priority',
            callback_data: encodeCallback(CALLBACK.URGENT_CONFIRM, notice.reference),
          },
        ],
      ],
```

The roster identifier line comes out. It was there because checking meant typing a
command first; opening is one tap now.

`notifyUrgentRequestOnCase` needs `owner` added to its parameter type and passed
through to both calls. **Do not touch its overlap strip.** Its comment explains
that it keeps the request message and drops the new-case one; under D1 both go to
the same person, so that strip is now the thing preventing a double message rather
than an optimisation. Add a line to its doc comment saying so.

- [ ] **Step 4: Pass the owner at the call site**

`src/telegram/router.ts:935`. The urgent path calls `createCase` too, so
`result.owner` is available the same way.

- [ ] **Step 5: Run the tests**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/cases/notify.integration.test.ts src/cases/urgent.integration.test.ts src/telegram/router.integration.test.ts
```

- [ ] **Step 6: Commit**

```bash
npm run typecheck && git add -A src/cases src/telegram/router.ts && git commit -m "feat: the person who will do the work decides if it jumps the queue"
```

---

## Task 7: Remember what the status was before it was escalated

**Files:**
- Modify: `src/db/schema.ts` (the `cases` table, beside `urgentConfirmedAt`)
- Create: one migration in `drizzle/`

- [ ] **Step 1: Add the column to the schema**

```typescript
    /**
     * The status this case held before a confirmed urgent request moved it to
     * `Escalated`, or null when it was never escalated.
     *
     * Written so that un-marking can put the case back where it was. A case that
     * was `Under review` when somebody escalated it should return to `Under
     * review`, and without this column the only honest answer would be `Received`,
     * which throws away real progress and would read to staff as the case having
     * been reset.
     *
     * Null on every case escalated before this column existed, which is why the
     * restore coalesces to `Received`.
     */
    preUrgentStatus: caseStatusEnum('pre_urgent_status'),
```

- [ ] **Step 2: Generate the migration**

```bash
npx drizzle-kit generate
```

- [ ] **Step 3: Read the generated SQL before accepting it**

Open the new file in `drizzle/`. It must contain exactly one `ALTER TABLE ... ADD
COLUMN` and nothing else. **If it contains `DROP TYPE`, do not use it** — this
project has had drizzle-kit emit a destructive `DROP TYPE` once before. Write the
`ALTER TABLE` by hand instead.

Rename the file to match the existing convention in that folder and change the
`tag` in `drizzle/meta/_journal.json` to match.

- [ ] **Step 4: Apply it to the test database and check it landed**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/cases/urgent.integration.test.ts
```

The suite applies migrations on start. Expected: PASS, nothing changed yet.

- [ ] **Step 5: Commit**

```bash
npm run typecheck && git add src/db/schema.ts drizzle/ && git commit -m "feat: a case remembers what it was before it became urgent"
```

---

## Task 8: Record the replaced status when confirming

**Files:**
- Modify: `src/cases/urgent.ts:270-295`
- Test: `src/cases/urgent.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('remembers the status it replaced when it escalates', async () => {
  const filed = await requestUrgentCase(db, { chatId: CHAT, detail: DETAIL });
  await updateCase(db, filed.reference, { status: 'Under review' }, COORDINATOR);

  await confirmUrgentRequest(db, filed.reference, COORDINATOR);

  const rows = await db.execute<{ before: string | null; now: string }>(sql`
    SELECT pre_urgent_status AS before, status AS now
    FROM cases WHERE reference = ${filed.reference}
  `);
  expect(rows.rows[0]?.now).toBe('Escalated');
  expect(rows.rows[0]?.before).toBe('Under review');
});
```

`requestUrgentCase`, `updateCase`, `CHAT`, `DETAIL` and `COORDINATOR` are already
imported and defined at the top of this file. The raw query is written out rather
than added to the existing `caseRow` helper, because `pre_urgent_status` is read by
these two tests and by nothing else.

- [ ] **Step 2: Run and watch it fail**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/cases/urgent.integration.test.ts
```

Expected: `before` is null.

- [ ] **Step 3: Extend the sub-select that is already there**

In `confirmUrgentRequest`, the `FROM (...) AS before` clause exists because
`RETURNING` yields post-update values. Add the status to it and write it back:

```sql
    UPDATE cases
    SET importance = GREATEST(importance, 'Urgent'::case_importance),
        status = 'Escalated',
        pre_urgent_status = before.was_status,
        closed_at = NULL,
        teacher_chased_at = NULL,
        teacher_chase_count = 0,
        urgent_confirmed_by = ${actor},
        urgent_confirmed_at = now(),
        updated_at = now(),
        last_actor = ${actor}
    FROM (
      SELECT closed_at AS was_closed_at, status AS was_status
      FROM cases WHERE reference = ${reference}
    ) AS before
```

**Read the old status through that sub-select, never through `RETURNING`.** The
statement writes `status` itself, so `RETURNING status` would hand back
`Escalated` every time and the column would record the value it was meant to
replace. That trap has already cost this file one fault.

- [ ] **Step 4: Run the tests**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run typecheck && git add src/cases/urgent.ts src/cases/urgent.integration.test.ts && git commit -m "feat: escalating a case writes down what it interrupted"
```

---

## Task 9: `unmarkUrgent`

D8. Refuses a closed case, for the retention reason in §6.1 of the design.

**Files:**
- Modify: `src/cases/urgent.ts`
- Test: `src/cases/urgent.integration.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
describe('taking an urgent marking back', () => {
  it('puts the case back where it was and clears the confirmation', async () => {
    const filed = await requestUrgentCase(db, { chatId: CHAT, detail: DETAIL });
    await updateCase(db, filed.reference, { status: 'Under review' }, COORDINATOR);
    await confirmUrgentRequest(db, filed.reference, COORDINATOR);

    const outcome = await unmarkUrgent(db, filed.reference, COORDINATOR);

    expect(outcome.kind).toBe('unmarked');
    const row = await caseRow(filed.reference);
    expect(row.status).toBe('Under review');
    expect(row.importance).toBe('Normal');
    expect(row.confirmed_by).toBeNull();
  });

  it('falls back to Received for a case escalated before the column existed', async () => {
    const filed = await requestUrgentCase(db, { chatId: CHAT, detail: DETAIL });
    await confirmUrgentRequest(db, filed.reference, COORDINATOR);
    // Every case escalated before this column shipped looks exactly like this.
    await db.execute(sql`
      UPDATE cases SET pre_urgent_status = NULL WHERE reference = ${filed.reference}
    `);

    await unmarkUrgent(db, filed.reference, COORDINATOR);

    expect((await caseRow(filed.reference)).status).toBe('Received');
  });

  it('refuses a closed case, because retention would delete it', async () => {
    // §6.1 of the design. Retention keys off importance and only ever touches a
    // case carrying a closed_at. Dropping a closed case to Normal could put it
    // past the line, and the nightly pass would delete it that night.
    const filed = await requestUrgentCase(db, { chatId: CHAT, detail: DETAIL });
    await confirmUrgentRequest(db, filed.reference, COORDINATOR);
    await updateCase(db, filed.reference, { status: 'Completed' }, COORDINATOR);

    const outcome = await unmarkUrgent(db, filed.reference, COORDINATOR);

    expect(outcome.kind).toBe('closed');
    expect((await caseRow(filed.reference)).importance).toBe('Urgent');
  });

  it('is a no-op on a case that was asked about but never confirmed', async () => {
    // The teacher asking must not be undoable as though it were a decision.
    const filed = await requestUrgentCase(db, { chatId: CHAT, detail: DETAIL });

    expect((await unmarkUrgent(db, filed.reference, COORDINATOR)).kind).toBe('notUrgent');
  });

  it('says so for a reference that does not exist', async () => {
    expect((await unmarkUrgent(db, 'VISA-2026-99999', COORDINATOR)).kind).toBe('unknown');
  });

  it('writes exactly one audit row however many times it is tapped', async () => {
    // A button sits in a chat for ever and two people may tap the same one.
    const filed = await requestUrgentCase(db, { chatId: CHAT, detail: DETAIL });
    await confirmUrgentRequest(db, filed.reference, COORDINATOR);

    await unmarkUrgent(db, filed.reference, COORDINATOR);
    await unmarkUrgent(db, filed.reference, OTHER_COORDINATOR);

    const rows = await db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM audit_log WHERE action = 'URGENT_UNMARKED'`,
    );
    expect(Number(rows.rows[0]?.n)).toBe(1);
  });
});
```

`caseRow`, `CHAT`, `DETAIL`, `COORDINATOR` and `OTHER_COORDINATOR` are already in
this file. `caseRow` returns `status`, `importance` and `confirmed_by`, which is
everything these assertions need.

- [ ] **Step 2: Run and watch them fail**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/cases/urgent.integration.test.ts
```

Expected: `unmarkUrgent is not a function`.

- [ ] **Step 3: Write it**

Add to `src/cases/urgent.ts`:

```typescript
export type UrgentUnmarked =
  | { readonly kind: 'unmarked'; readonly reference: string; readonly status: string; readonly owner: string | null; readonly wasConfirmedBy: string | null }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'notUrgent' }
  | { readonly kind: 'closed' };

/**
 * Take back a confirmed urgent marking — D8, 5 August 2026.
 *
 * Asked for by the head of project alongside keeping the oversight message: one
 * regional coordinator can raise a case above every other case in the country
 * with no second signature, so the people who see that happen need a way to
 * disagree.
 *
 * **It refuses a closed case, and that is a data-loss guard rather than a
 * nicety.** Retention keys off `importance`, and a closed case at `Urgent` is
 * kept for `URGENT_CASE_RETENTION_DAYS` instead of `CASE_RETENTION_DAYS`.
 * Dropping a case that is already closed back to `Normal` can put it the wrong
 * side of the line, and the nightly pass would delete it that night rather than
 * eventually. Retention only ever touches rows with a `closed_at`, so refusing
 * those makes the whole class of accident unreachable. Anybody who means it can
 * reopen the case first.
 *
 * **The teacher is not told.** They were told their case had been prioritised
 * when it was marked, so after this they still believe it is. That was the head
 * of project's explicit instruction and the alternative is telling a worried
 * teacher their problem has been downgraded.
 *
 * The status goes back to whatever `confirmUrgentRequest` recorded, read through
 * a sub-select in `FROM` because `RETURNING` yields post-update values and this
 * statement writes the column it needs to read.
 */
export async function unmarkUrgent(
  db: Database,
  reference: string,
  actor: string,
): Promise<UrgentUnmarked> {
  const updated = await db.execute<{
    reference: string;
    status: string;
    owner: string | null;
    was_confirmed_by: string | null;
  }>(sql`
    UPDATE cases
    SET importance = 'Normal'::case_importance,
        status = COALESCE(before.pre_status, 'Received'::case_status),
        pre_urgent_status = NULL,
        urgent_confirmed_by = NULL,
        urgent_confirmed_at = NULL,
        updated_at = now(),
        last_actor = ${actor}
    FROM (
      SELECT pre_urgent_status AS pre_status, urgent_confirmed_by AS confirmed_by
      FROM cases WHERE reference = ${reference}
    ) AS before
    WHERE cases.reference = ${reference}
      AND cases.urgent_confirmed_at IS NOT NULL
      AND cases.closed_at IS NULL
    RETURNING cases.reference, cases.status, cases.owner,
              before.confirmed_by AS was_confirmed_by
  `);

  const row = updated.rows[0];
  if (row !== undefined) {
    await recordAudit(db, { actor, action: 'URGENT_UNMARKED', subject: reference });
    return {
      kind: 'unmarked',
      reference: row.reference,
      status: row.status,
      owner: row.owner,
      wasConfirmedBy: row.was_confirmed_by,
    };
  }

  /**
   * The write did nothing, and the three reasons need different sentences. Read
   * only on the failing path, exactly as `confirmUrgentRequest` does.
   */
  const existing = await db.execute<{ confirmed: boolean; closed: boolean }>(sql`
    SELECT urgent_confirmed_at IS NOT NULL AS confirmed,
           closed_at IS NOT NULL AS closed
    FROM cases WHERE reference = ${reference}
  `);

  const found = existing.rows[0];
  if (found === undefined) return { kind: 'unknown' };
  if (!found.confirmed) return { kind: 'notUrgent' };
  return { kind: 'closed' };
}
```

**The two casts are not decoration.** `'Received'` inside `COALESCE` next to an
enum column needs `::case_status` or PostgreSQL cannot infer the parameter type,
and `'Normal'` needs `::case_importance` for the same reason. This is trap two of
the three in `CLAUDE.md` §3.

- [ ] **Step 4: Run the tests**

Same command. Expected: PASS, all six.

- [ ] **Step 5: Commit**

```bash
npm run typecheck && git add src/cases/urgent.ts src/cases/urgent.integration.test.ts && git commit -m "feat: an urgent marking can be taken back, but never off a closed case"
```

---

## Task 10: The button, and the route behind it

**Files:**
- Modify: `src/telegram/callback-data.ts`
- Create: `src/telegram/urgent-actions.ts`
- Modify: `src/telegram/router.ts` (the callback switch, and `notifyUrgentConfirmed`'s keyboard)
- Modify: `src/cases/notify.ts` (`notifyUrgentConfirmed` gains the button)
- Test: `src/telegram/callback-data.test.ts`, `src/telegram/router.integration.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/telegram/callback-data.test.ts`, extend the existing payload-length test
rather than adding a new one. Find the test that measures the longest real payload
and add:

```typescript
    expect(byteLength(encodeCallback(CALLBACK.URGENT_UNMARK, 'CONTRACT-2026-99999')))
      .toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
```

In `src/telegram/router.integration.test.ts`:

```typescript
describe('the not urgent button', () => {
  it('is refused for a Support member, naming the rank it needs', async () => {
    const body = await tapText(encodeCallback(CALLBACK.URGENT_UNMARK, REFERENCE), SUPPORT_MEMBER);

    expect(body).toContain('Program');
    const rows = await db.execute<{ importance: string }>(
      sql`SELECT importance FROM cases WHERE reference = ${REFERENCE}`,
    );
    expect(rows.rows[0]?.importance).toBe('Urgent');
  });

  it('answers a chat with no staff row with the menu, never with a refusal', async () => {
    // The dispatcher's rule. "You are not staff" tells a stranger the button
    // they guessed at is real.
    const body = await tapText(encodeCallback(CALLBACK.URGENT_UNMARK, REFERENCE), TEACHER);

    expect(body).toContain('What would you like to do?');
  });

  it('is obeyed for a Program member, and the teacher is told nothing', async () => {
    const outcome = await tap(encodeCallback(CALLBACK.URGENT_UNMARK, REFERENCE), PROGRAM);

    expect(outcome.messages.every((m) => m.chatId !== TEACHER)).toBe(true);
    const rows = await db.execute<{ importance: string }>(
      sql`SELECT importance FROM cases WHERE reference = ${REFERENCE}`,
    );
    expect(rows.rows[0]?.importance).toBe('Normal');
  });
});
```

Use the helpers this file already has for tapping a callback and reading the first
message. Do not add new ones.

- [ ] **Step 2: Run and watch them fail**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/telegram/callback-data.test.ts src/telegram/router.integration.test.ts
```

- [ ] **Step 3: Add the prefix**

In `src/telegram/callback-data.ts`, inside `CALLBACK`, after `URGENT_CONFIRM`:

```typescript
  /**
   * "That should not have been made urgent", e.g. `UN:VISA-2026-00311` — D8.
   *
   * The counterpart to `UC`, and it sits on the oversight message rather than on
   * the coordinator's. Support grants urgency and Program takes it back, which
   * mirrors `/assign`: overriding somebody else's decision is already a Program
   * act in this system.
   *
   * `UN:CONTRACT-2026-99999` is 22 bytes against the 64-byte limit, and that is
   * the longest reference this system can build. The payload-length test measures
   * it with a real value rather than trusting the arithmetic here.
   */
  URGENT_UNMARK: 'UN',
```

- [ ] **Step 4: Create the action module**

`src/telegram/urgent-actions.ts`:

```typescript
/**
 * Taking an urgent marking back — the one implementation, so a later typed
 * command cannot answer differently.
 *
 * **It lives here rather than in `router.ts` for `dispute-actions.ts`'s reason,
 * and that reason is a real cycle rather than a preference.** `commands/index.ts`
 * imports every staff command and `router.ts` imports the dispatcher, so anything
 * both a button and a command need belongs in neither. Part 5H.3 and Feature A
 * both reached this conclusion the hard way.
 *
 * Layer 3. It composes layer-2 stores and returns messages. It sends nothing, and
 * `deliver` speaks only after the transaction commits.
 */
import { unmarkUrgent } from '../cases/urgent.js';
import type { Database } from '../db/index.js';
import { reply } from './commands/context.js';
import type { RouterOutcome } from './router.js';

/**
 * Undo a confirmed urgent marking and tell the few people it concerns.
 *
 * **Three audiences at most, and the teacher is never one of them (D8).** The
 * person who tapped is answered because they acted. The owner is told because
 * their work has just changed back, and they may be mid-way through treating it
 * as the most important thing they have. Whoever marked it urgent is told because
 * their decision has been reversed and hearing that from the system is better
 * than noticing it in a list a week later.
 *
 * Nobody else. The oversight group already saw the marking; telling them about
 * every reversal as well is how this feature becomes the noise it was built to
 * reduce.
 */
export async function unmarkAndAnnounce(
  db: Database,
  actorChatId: string,
  reference: string,
): Promise<RouterOutcome> {
  const outcome = await unmarkUrgent(db, reference, actorChatId);

  if (outcome.kind === 'unknown') {
    return reply(actorChatId, `I cannot find ${reference}.`);
  }

  if (outcome.kind === 'notUrgent') {
    return reply(actorChatId, `${reference} is not marked urgent, so there is nothing to take back.`);
  }

  if (outcome.kind === 'closed') {
    return reply(
      actorChatId,
      [
        `${reference} is closed, so its priority was left alone.`,
        '',
        'How long a closed case is kept depends on its priority, so changing it now',
        'could bring forward the day it is deleted. Reopen it first if you need to.',
      ].join('\n'),
    );
  }

  const alsoTold = [...new Set([outcome.owner, outcome.wasConfirmedBy])].filter(
    (chatId): chatId is string => chatId !== null && chatId !== actorChatId,
  );

  return {
    messages: [
      {
        chatId: actorChatId,
        text: [
          `${reference} is back to normal priority.`,
          '',
          `It is at ${outcome.status} again and has left /urgent. The teacher has not been told.`,
        ].join('\n'),
      },
      ...alsoTold.map((chatId) => ({
        chatId,
        text: [
          `${reference} is back to normal priority.`,
          '',
          `Changed by ${actorChatId}. It is at ${outcome.status} again.`,
        ].join('\n'),
        purpose: 'notice that an urgent marking was taken back',
      })),
    ],
    alerts: [],
  };
}
```

- [ ] **Step 5: Route it**

In `src/telegram/router.ts`, add to the callback switch beside
`CALLBACK.URGENT_CONFIRM`:

```typescript
    /**
     * Taking an urgent marking back — D8.
     *
     * Re-authorised on arrival like every other staff tap, and through the case
     * scope on top: the button sits in an oversight chat for ever and the person
     * tapping it today may have been demoted since.
     */
    case CALLBACK.URGENT_UNMARK:
      return unmarkUrgentTap(db, update.chatId, first, state);
```

and the handler, modelled exactly on `confirmUrgent` above it:

```typescript
async function unmarkUrgentTap(
  db: Database,
  chatId: string,
  reference: string,
  state: ConversationState | null,
): Promise<RouterOutcome> {
  const member = await findStaff(db, chatId);
  if (member === null) {
    await logInteraction(db, chatId, STAFF_DENIED, `urgent unmark ${reference}`, state);
    return only(chatId, await menuReplyFor(db, chatId));
  }

  if (!can(member, CAPABILITY.CASE_ASSIGN)) {
    await logInteraction(db, chatId, STAFF_DENIED, `urgent unmark ${reference}`, state);
    return only(chatId, {
      text:
        'Taking back an urgent marking is not available at your rank.\n\n' +
        `It needs ${floorFor(CAPABILITY.CASE_ASSIGN)} or above. Yours is ${member.role}.`,
    });
  }

  const found = await findCase(db, scopeOf(member), reference);
  if (found === null) {
    return only(chatId, { text: `I cannot find ${reference}, or it is outside your queue and regions.` });
  }

  return unmarkAndAnnounce(db, chatId, found.reference);
}
```

**`CASE_ASSIGN` is the capability, not a new one.** It already floors at Program
and already means "override somebody else's decision about a case". Adding a
capability for one button would be a second expression of the same rule.

- [ ] **Step 6: Put the button on the oversight message**

In `src/cases/notify.ts`, `notifyUrgentConfirmed` returns messages with no
keyboard. Add one, and shorten the text while you are there:

```typescript
      keyboard: [
        [
          { text: '📂 Open case', callback_data: encodeCallback(CALLBACK.CASE_OPEN, notice.reference) },
          { text: '↩️ Not urgent', callback_data: encodeCallback(CALLBACK.URGENT_UNMARK, notice.reference) },
        ],
      ],
```

The two `/case` and `/assign` command lines come out of that message's text, as
they did in Task 5.

- [ ] **Step 7: Run the tests**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/telegram/callback-data.test.ts src/telegram/router.integration.test.ts src/cases/notify.integration.test.ts
```

- [ ] **Step 8: Regenerate the dependency tree, because a file was added**

```bash
npm run deps && npm run deps:check
```

Expected: `No cycles, no unresolved imports, nothing unused, nothing importing upward.`

- [ ] **Step 9: Commit**

```bash
npm run typecheck && git add -A src/telegram src/cases/notify.ts docs/dependency-tree.md && git commit -m "feat: a marking made by one person can be undone by another"
```

---

## Task 11: The rest of the words a staff member reads

Tasks 5, 6 and 10 rewrote the three case messages. Three more pieces of staff-facing
text carry the same voice and were written by the same hand, so they get the same
pass. §7 of the design is the rule set.

**Files:**
- Modify: `src/telegram/commands/index.ts` (`refusalText`, around line 400)
- Modify: `src/telegram/commands/staff.ts` (`accessChangedNotice`, around line 485)
- Modify: `src/telegram/router.ts` (the two refusals inside `confirmUrgent`)
- Test: `src/telegram/commands/staff.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('never says em dash to a member of staff', async () => {
  // §7 of the design. A MoPSE employee described these messages as threatening,
  // and the dash is most of what makes them read like a machine explaining
  // itself. Asserted on real output rather than by reading the source, because
  // the source is where somebody will put one back.
  const messages = [
    await run('/staff_role 999999 Lead'),
    await run('/staff', SUPPORT_MEMBER),
    await run('/staff_remove'),
  ];

  for (const body of messages) expect(body).not.toContain('—');
});
```

- [ ] **Step 2: Run it and watch it fail**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/telegram/commands/staff.integration.test.ts
```

- [ ] **Step 3: Rewrite the three**

`refusalText` becomes:

```typescript
function refusalText(name: string, capability: Capability, role: string): string {
  return [
    `${name} needs ${floorFor(capability)} rank or above.`,
    '',
    `Yours is ${role}. Type /whoami to see what you can do.`,
  ].join('\n');
}
```

Three lines instead of five, no dash, and the rank a person needs is the first
thing they read rather than the third.

`accessChangedNotice` and the two `confirmUrgent` refusals: apply the same rules.
No dash, no capitals, no sentence that names a failure. Keep every fact.

**Do not touch the daily digest.** It is deferred to phase two on purpose, so that
the same voice reaches the teacher chase message and the staff summary in one pass.

- [ ] **Step 4: Run the tests**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/telegram src/cases
```

Existing tests asserting exact refusal wording **are right to fail**. Update them.

- [ ] **Step 5: Commit**

```bash
npm run typecheck && git add -A src/telegram && git commit -m "feat: the bot stops explaining itself to staff"
```

---

## Task 12: Verify the whole phase, and fix the two orphans

- [ ] **Step 1: Run every checker except the full suite**

```bash
npm run typecheck && npm run build && npm run lint && npm run deps:check
```

All four must pass. State the results plainly.

- [ ] **Step 2: Run every test file this phase touched**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/staff src/cases src/telegram
```

Expected: 0 failed, 0 skipped. **A run reporting skips proved nothing.**

- [ ] **Step 3: Assign the two cases that predate automatic assignment**

On the live server, after this phase is deployed. `VISA-2026-00002` and
`DOCS-2026-00001` were filed on 1 August, before `chooseOwner` existed, and have no
owner. Use the command rather than SQL, so the audit row exists:

```
/assign VISA-2026-00002 <a support member's telegram id>
/assign DOCS-2026-00001 <a support member's telegram id>
```

`/staff` lists the ids.

- [ ] **Step 4: Commit anything outstanding**

The working tree should be clean at this point.

---

## What this plan does not do

- **The full suite run**, which is D9: once, after phase two.
- **Phase two**, everything a teacher reads. Its own plan, after its own design
  conversation.
- **The tone pass over the digest.** The daily summary was left alone on purpose:
  it is already silent when there is nothing to say, and rewording it belongs with
  the teacher-facing pass where the same voice can be applied to both.
- **Narrowing anybody's regions.** §10 of the design says why: every case in the
  system is Tashkent, so it would change nothing while looking like progress.

## One thing to raise before starting

**Who hears about an un-marking is a decision I made while planning, not one from
the design conversation.** Task 10 tells the person who tapped, the case owner, and
whoever originally marked it urgent. It deliberately does not tell the whole
Program and System group, on the grounds that they already saw the marking and a
reversal notice to everybody would rebuild the noise this phase removes. If the
head of project wants the oversight group told both times, it is a two-line change
in `unmarkAndAnnounce` and it should be made before Task 10 rather than after.
