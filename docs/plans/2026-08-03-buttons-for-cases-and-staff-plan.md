# Buttons for cases and staff — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put every case action and the adding of a staff member on a button, so a staff member
never types a case reference or a rank again, and reword the sign-in prompt and privacy notice.

**Architecture:** Every button turns into the typed command it is equivalent to and is handed to
`routeStaffCommand`, so no rule this bot enforces acquires a second copy. Actions that carry free
text park one row in `conversation_states` — the table that already holds where a teacher is — and
the staff member's next message becomes the argument. This copies Part 5H.3's staff menu exactly
rather than inventing a second pattern.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), grammY, Drizzle over PostgreSQL, Zod for
state payloads, Vitest for integration tests against a real database.

**Design of record:** `docs/plans/2026-08-03-buttons-for-cases-and-staff-design.md`.

---

## Before you start

Read `CLAUDE.md` in full. Four rules from it govern every task below and none of them is a
compile error:

1. **Nothing imports from a layer above it.** Layer 1 `send.ts` / `callback-data.ts`; layer 2
   `cases/ staff/ conversation/ db/`; layer 3 `telegram/`; layer 4 `worker/ web/ scripts/`.
   `import type` may point upward and is not a violation.
2. **Stores must not send.** A layer-2 module returns what needs saying; layer 3 sends it.
3. **Callback payloads have a 64-byte ceiling** and Telegram truncates silently.
4. **Test-first.** The interesting tests here are integration tests against a real PostgreSQL.

### Starting the test database

The test database is a container with no volume. It does not survive a `down` or a Docker restart,
so assume it is not running. Docker Desktop is often stopped on this machine, and can also be
paused — in which case a run hangs with no output at all.

```bash
docker desktop start && docker compose -f docker-compose.test.yml up -d && docker inspect --format "{{.State.Health.Status}}" mopse-test-postgres-1
```

Wait for `healthy`. Then every test command in this plan is run from PowerShell as:

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run <path>
```

**Never pipe `vitest` through `head`** — it closes the pipe, the shell returns, and the run keeps
going invisibly. Filter with `Select-String` instead. **Never start a second run while one is
going.**

### The one thing the head of project asked for explicitly

**Do not run the full suite until every task in this plan is finished.** Run the single test file
you are working on, task by task. The full five-check run is Task 17, and it happens once.

---

## File structure

| File | Layer | Responsibility | Piece |
|---|---|---|---|
| `src/telegram/callback-data.ts` | 1 | **Modify.** Two new prefixes: `CASE_ACTION: 'CA'`, `STAFF_ADD: 'SA'` | 1, 2 |
| `src/telegram/commands/case-menu.ts` | 3 | **Create.** Keyboards for a case, what one tap means, and what a captured message becomes. Knows nothing about how a command is executed | 1, 2 |
| `src/telegram/commands/cases.ts` | 3 | **Modify.** `oneCase` hangs the keyboard under the case it already renders. One import, one changed line | 1 |
| `src/telegram/commands/index.ts` | 3 | **Modify.** `routeCaseMenu` and `routeStaffWriting`, both shaped exactly like the existing `routeStaffMenu` | 1, 2 |
| `src/telegram/router.ts` | 3 | **Modify.** Two `case` arms in `routeCallback`, and one branch in `routeText` | 1, 2 |
| `src/conversation/state.ts` | 2 | **Modify.** Two staff states join the discriminated union. No migration | 2 |
| `src/telegram/commands/staff.ts` | 3 | **Modify.** The `➕ Add somebody` button and the `SA` flow | 2 |
| `src/telegram/handlers/menu.ts` | 3 | **Modify.** `signInPromptReply` reordered and reworded | 2 |
| `src/config/privacy.ts` | 1 | **Modify.** The notice reworded; version bumped | 2 |

**Why `case-menu.ts` is a new file.** `cases.ts` is already 1,240 lines holding fourteen commands,
and the menu is a different job — `cases.ts` answers "what does this command do", the menu answers
"what does this tap mean". `staff.ts` kept its menu inline and is now 1,937 lines, which is the
outcome being avoided rather than repeated.

**The dependency direction, which must not be reversed.** `cases.ts` imports the keyboard from
`case-menu.ts`. `case-menu.ts` imports **nothing** from `cases.ts`. And `case-menu.ts` cannot import
`routeStaffCommand`, because `index.ts` already imports the commands — so `case-menu.ts` decides
*what* should happen and `index.ts` carries it out. This is Part 5H.3's split, copied.

---

# PIECE 1 — the case menu, no typing

Four actions that need no words: **Reopen**, **Give it an owner**, **How serious is it**, **Snooze**.
Close is deliberately not here — both halves of it need words. See the design, §11.

---

### Task 1: The `CA` callback prefix, measured

**Files:**
- Modify: `src/telegram/callback-data.ts`
- Test: `src/telegram/callback-data.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/telegram/callback-data.test.ts`:

```typescript
describe('the case action prefix', () => {
  /**
   * `CONTRACT-2026-99999` is the longest reference this system can build: the
   * longest category name, a four-digit year and a five-digit sequence. Measured
   * with a real value rather than trusted to arithmetic.
   */
  const LONGEST_REFERENCE = 'CONTRACT-2026-99999';

  it('fits the longest importance payload inside the limit', () => {
    const data = encodeCallback(CALLBACK.CASE_ACTION, LONGEST_REFERENCE, 'M', 'Critical');
    expect(byteLength(data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
  });

  it('fits the longest owner payload inside the limit', () => {
    // Telegram ids are at most ten digits today; a spare digit costs nothing.
    const data = encodeCallback(CALLBACK.CASE_ACTION, LONGEST_REFERENCE, 'OWN', '99999999999');
    expect(byteLength(data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
  });

  it('fits the longest snooze payload inside the limit', () => {
    const data = encodeCallback(CALLBACK.CASE_ACTION, LONGEST_REFERENCE, 'SN', '30');
    expect(byteLength(data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
  });
});
```

Check the imports at the top of that file already include `CALLBACK_DATA_MAX_BYTES` and
`byteLength`. If not, add them.

- [ ] **Step 2: Run it and watch it fail**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/telegram/callback-data.test.ts
```

Expected: FAIL, three tests, `CALLBACK.CASE_ACTION` is `undefined` so `encodeCallback` builds
`undefined:CONTRACT-...`. A TypeScript error in the editor is the same news arriving earlier.

- [ ] **Step 3: Add the prefix**

In `src/telegram/callback-data.ts`, inside the `CALLBACK` object, immediately after `CASE_OPEN: 'CO'`:

```typescript
  /**
   * One action on one case — `CA:<reference>[:<action>[:<value>]]`.
   *
   * The same three depths as `STAFF_MENU`, for the same reasons and by
   * deliberate copy:
   *
   * ```
   * CA:VISA-2026-00311           → the case, with its keyboard
   * CA:VISA-2026-00311:M         → which level of importance?
   * CA:VISA-2026-00311:M:Urgent  → do it
   * ```
   *
   * **The reference travels in the payload rather than in conversation state.**
   * A menu sits in a chat for ever, and one holding "whichever case we were
   * looking at" would act on a case chosen an hour ago. A self-contained payload
   * cannot.
   *
   * It is not a permission and carries none. Every acting tap is executed by
   * handing the equivalent typed command to the same dispatcher a typed command
   * goes through, so a payload replayed by somebody demoted last week buys
   * exactly nothing.
   *
   * `CA:CONTRACT-2026-99999:OWN:99999999999` is 38 bytes against the 64-byte
   * limit, and `CONTRACT-2026-99999` is the longest reference this system can
   * build. Tests measure all three shapes with real values.
   */
  CASE_ACTION: 'CA',
```

- [ ] **Step 4: Run it and watch it pass**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/telegram/callback-data.test.ts
```

Expected: PASS, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/callback-data.ts src/telegram/callback-data.test.ts && git commit -m "feat: a callback prefix for acting on one case"
```

---

### Task 2: The keyboard, built from what the tapper holds

The keyboard is a pure function of the case row and the staff record. No database, no clock. That is
what makes it testable without a container, and it is the same discipline `keyboards.ts` holds.

**Files:**
- Create: `src/telegram/commands/case-menu.ts`
- Create: `src/telegram/commands/case-menu.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/telegram/commands/case-menu.test.ts`:

```typescript
/**
 * The case keyboard — a pure function, tested without a database.
 *
 * The property under test is the one the design calls load-bearing: **a button
 * is never drawn for somebody who would be refused for tapping it.** A button
 * shown and then refused is worse than no button, because the person cannot
 * tell whether they did it wrong.
 */
import { describe, expect, it } from 'vitest';
import type { StaffRecord } from '../../staff/repository.js';
import type { StaffCaseRow } from '../../cases/queries.js';
import { caseActionKeyboard } from './case-menu.js';

const member = (over: Partial<StaffRecord> = {}): StaffRecord => ({
  telegramId: '994001',
  name: 'A Member',
  role: 'Support',
  queue: 'Visa',
  regions: [],
  active: true,
  addedBy: null,
  addedAt: new Date(),
  telegramUsername: null,
  ...over,
});

const openCase = (over: Partial<StaffCaseRow> = {}): StaffCaseRow =>
  ({
    reference: 'VISA-2026-00311',
    status: 'Under review',
    importance: 'Normal',
    category: 'Visa',
    region: 'Tashkent',
    ...over,
  }) as StaffCaseRow;

/** Every button's payload, flattened, so a test can ask "is it there at all". */
const payloads = (member_: StaffRecord, row: StaffCaseRow): string[] =>
  caseActionKeyboard(row, member_).flat().map((b) => b.callback_data);

describe('who is shown which case buttons', () => {
  it('does not offer an owner to somebody who may not assign one', () => {
    // case.assign floors at Program. Support holds case.update and no more.
    const shown = payloads(member({ role: 'Support' }), openCase());
    expect(shown.some((p) => p.includes(':OWN'))).toBe(false);
  });

  it('offers an owner to Program', () => {
    const shown = payloads(member({ role: 'Program' }), openCase());
    expect(shown.some((p) => p.includes(':OWN'))).toBe(true);
  });

  it('offers nothing that writes to an Observer', () => {
    // case.view floors at Observer and every action here needs more than that.
    const shown = payloads(member({ role: 'Observer' }), openCase());
    expect(shown.some((p) => p.includes(':SN'))).toBe(false);
    expect(shown.some((p) => p.includes(':M'))).toBe(false);
    expect(shown.some((p) => p.includes(':RO'))).toBe(false);
  });

  it('offers nothing at all to a deactivated member who still holds the rank', () => {
    const shown = payloads(member({ role: 'System', active: false }), openCase());
    expect(shown.some((p) => p.startsWith('CA:'))).toBe(false);
  });
});

describe('which buttons suit the case as it stands', () => {
  it('offers reopen on a finished case and not on an open one', () => {
    const open = payloads(member({ role: 'Program' }), openCase({ status: 'Under review' }));
    const done = payloads(member({ role: 'Program' }), openCase({ status: 'Completed' }));
    expect(open.some((p) => p.includes(':RO'))).toBe(false);
    expect(done.some((p) => p.includes(':RO'))).toBe(true);
  });

  it('does not offer a snooze on a finished case', () => {
    const done = payloads(member({ role: 'Program' }), openCase({ status: 'Completed' }));
    expect(done.some((p) => p.includes(':SN'))).toBe(false);
  });

  /**
   * Importance is deliberately allowed on a finished case. D22 calls it a
   * judgement somebody makes after reading, retention keys off it and never off
   * the status, so marking a closed case is the one thing that keeps it.
   */
  it('offers importance on a finished case', () => {
    const done = payloads(member({ role: 'Program' }), openCase({ status: 'Completed' }));
    expect(done.some((p) => p.includes(':M'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/telegram/commands/case-menu.test.ts
```

Expected: FAIL — `Cannot find module './case-menu.js'`.

- [ ] **Step 3: Create the module with the keyboard only**

Create `src/telegram/commands/case-menu.ts`:

```typescript
/**
 * What one tap on a case means — the case half of Part 5H.3's pattern.
 *
 * **Nothing in this file decides anything.** Every acting tap is turned back
 * into the typed command it is equivalent to, and `index.ts` hands that to the
 * same dispatcher a typed command goes through. So `/close` remains the single
 * place that knows a finished case may not be closed twice, `/assign` the single
 * place that checks the new owner can see it, and `/snooze` the single place
 * that holds the cap. **A second copy of any of those is the thing this file
 * must not create**, and copying the staff menu is how it avoids one.
 *
 * It cannot call `routeStaffCommand` itself: `index.ts` already imports the
 * commands, so the call would be a cycle. The cycle was telling the truth — this
 * decides *what* should happen and the dispatcher does it.
 *
 * Nothing here touches the database. The keyboard is a pure function of the case
 * and the person looking at it, which is what lets it be tested without a
 * container, and it is the same rule `keyboards.ts` holds for the teacher side.
 */
import type { StaffCaseRow } from '../../cases/queries.js';
import { isOpenStatus } from '../../cases/status.js';
import type { StaffRecord } from '../../staff/repository.js';
import { CAPABILITY, can } from '../../staff/roles.js';
import { CALLBACK, encodeCallback } from '../callback-data.js';
import type { InlineButton, InlineKeyboard, InlineKeyboardRow } from '../keyboards.js';

/**
 * The actions a payload may name. Matched exactly; anything else lands on the
 * case itself, which is the safe landing everywhere in this file.
 *
 * Short codes rather than words, for `callback-data.ts`'s reason: the byte
 * budget is shared with a nineteen-character reference and the values that hang
 * off some of these are region-length strings we do not control.
 */
export const CASE_ACTION = {
  REOPEN: 'RO',
  OWNER: 'OWN',
  IMPORTANCE: 'M',
  SNOOZE: 'SN',
} as const;

const forCase = (reference: string, action: string): string =>
  encodeCallback(CALLBACK.CASE_ACTION, reference, action);

/**
 * The buttons under one case.
 *
 * **Built from what the tapper holds, using the same function that does the
 * refusing.** `case.update` floors at Support and `case.assign` at Program, so a
 * Support member must not be shown "Give it an owner" — a button shown and then
 * refused is worse than no button, and Part 5G wrote that down as a constraint
 * before any of this was built. There is no second table of who-sees-what here;
 * `can` is asked directly, so the advertised keyboard and the enforced rule
 * cannot drift apart.
 *
 * The case's own state is the second filter. A snooze on a finished case
 * suppresses chasing that has nothing left to chase, and `/snooze` refuses one —
 * so it is not drawn. Importance is drawn on a finished case deliberately: D22
 * calls it a judgement made after reading, and retention reads the marker and
 * never the status.
 */
export function caseActionKeyboard(row: StaffCaseRow, member: StaffRecord): InlineKeyboard {
  const rows: InlineKeyboardRow[] = [];
  const open = isOpenStatus(row.status);
  const mayUpdate = can(member, CAPABILITY.CASE_UPDATE);

  if (mayUpdate && !open) {
    rows.push([{ text: '↩️ Reopen', callback_data: forCase(row.reference, CASE_ACTION.REOPEN) }]);
  }

  if (can(member, CAPABILITY.CASE_ASSIGN)) {
    rows.push([{ text: '👤 Give it an owner', callback_data: forCase(row.reference, CASE_ACTION.OWNER) }]);
  }

  if (can(member, CAPABILITY.CASE_MARK)) {
    rows.push([
      { text: '❗ How serious is it', callback_data: forCase(row.reference, CASE_ACTION.IMPORTANCE) },
    ]);
  }

  if (mayUpdate && open) {
    rows.push([{ text: '😴 Snooze', callback_data: forCase(row.reference, CASE_ACTION.SNOOZE) }]);
  }

  /**
   * The way back, and it is `/mycases` rather than `/cases`: it is the list a
   * staff member arrives from most often and the only one that needs no
   * argument. Drawn for anybody who can see a case at all, which is everybody
   * who reached this keyboard.
   */
  rows.push([backToMyCasesButton]);
  return rows;
}

const backToMyCasesButton: InlineButton = {
  text: '⬅️ Back to my cases',
  callback_data: encodeCallback(CALLBACK.CASE_ACTION, '', 'MINE'),
};
```

Note the last button uses an empty reference — `CA::MINE`. `encodeCallback` permits an empty part,
and `decodeCallback` returns it as `''`, which the resolver in Task 4 reads as "no case named".

- [ ] **Step 4: Run it and watch it pass**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/telegram/commands/case-menu.test.ts
```

Expected: PASS, 7 tests, 0 failed.

If the Observer test fails because `':M'` matches inside `'MINE'` — it will, because
`CA::MINE` contains `:M` — change the assertion helper to match whole action fields instead:

```typescript
const payloads = (member_: StaffRecord, row: StaffCaseRow): string[] =>
  caseActionKeyboard(row, member_)
    .flat()
    .map((b) => b.callback_data.split(':')[2] ?? '');
```

and change every `p.includes(':X')` to `p === 'X'`. **Do this now rather than leaving a test that
passes for the wrong reason** — it is exactly the "green tick over an empty scan" `CLAUDE.md`
warns about.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/commands/case-menu.ts src/telegram/commands/case-menu.test.ts && git commit -m "feat: the buttons under a case, filtered by rank and by state"
```

---

### Task 3: Hang the keyboard under `/case`

**Files:**
- Modify: `src/telegram/commands/cases.ts:430-454` (`oneCase`)
- Test: `src/telegram/commands/cases.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/telegram/commands/cases.integration.test.ts`, inside the existing top-level `describe`:

```typescript
describe('the buttons under a case', () => {
  it('gives a Support member the buttons they may use and no others', async () => {
    await givenCase({
      reference: 'VISA-2026-00901',
      teacher: TASHKENT_TEACHER,
      category: CASE_CATEGORY.VISA,
    });

    const outcome = await send({
      chatId: VISA_TASHKENT,
      kind: 'text',
      text: '/case VISA-2026-00901',
    });

    const keyboard = outcome.messages[0]?.keyboard ?? [];
    const actions = keyboard.flat().map((b) => b.callback_data.split(':')[2] ?? '');

    expect(actions).toContain('M');
    expect(actions).toContain('SN');
    expect(actions).toContain('MINE');
    // case.assign floors at Program; VISA_TASHKENT is Support.
    expect(actions).not.toContain('OWN');
  });

  it('carries the same buttons when the case is opened by tapping it', async () => {
    await givenCase({
      reference: 'VISA-2026-00902',
      teacher: TASHKENT_TEACHER,
      category: CASE_CATEGORY.VISA,
    });

    const outcome = await send({
      chatId: VISA_TASHKENT,
      kind: 'callback',
      text: encodeCallback(CALLBACK.CASE_OPEN, 'VISA-2026-00902'),
    });

    expect(outcome.messages[0]?.keyboard?.length ?? 0).toBeGreaterThan(0);
  });
});
```

Confirm `VISA_TASHKENT` is seeded as `Support` in that file's `beforeEach`. If it is seeded at a
different rank, adjust the two rank-specific assertions to match rather than changing the fixture —
other tests depend on it.

- [ ] **Step 2: Run it and watch it fail**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/telegram/commands/cases.integration.test.ts -t "buttons under a case"
```

Expected: FAIL — the keyboard is `undefined`, so `actions` is empty.

- [ ] **Step 3: Hang it**

In `src/telegram/commands/cases.ts`, add to the imports:

```typescript
import { caseActionKeyboard } from './case-menu.js';
```

Then change the last line of `oneCase.handle` from:

```typescript
    return reply(member.telegramId, renderCase(row, notes, noteTotal));
```

to:

```typescript
    /**
     * The keyboard is built from `member`, not from the case alone — Part 5I.
     * Two people opening the same case see different buttons, because
     * `case.assign` floors three ranks above `case.update`, and a button shown
     * and then refused is worse than no button at all.
     */
    return reply(member.telegramId, renderCase(row, notes, noteTotal), caseActionKeyboard(row, member));
```

- [ ] **Step 4: Run it and watch it pass**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/telegram/commands/cases.integration.test.ts
```

Expected: PASS, 0 failed. The whole file, not just the new block — `oneCase` is used by other tests
and a keyboard appearing where none did before must not break them.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/commands/cases.ts src/telegram/commands/cases.integration.test.ts && git commit -m "feat: a case now arrives with the things you can do to it"
```

---

### Task 4: What one tap means

`caseMenuView` mirrors `staffMenuView` in `staff.ts:1623` exactly — read that function before writing
this one. It returns either something to show or a command to run, and it re-reads the case on every
tap.

**Files:**
- Modify: `src/telegram/commands/case-menu.ts`
- Test: `src/telegram/commands/case-menu.integration.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/telegram/commands/case-menu.integration.test.ts`. Copy the fixture block —
`describe.skipIf`, the pool, `send`, `givenCase`, the staff seeding in `beforeEach` — from
`src/telegram/commands/cases.integration.test.ts` lines 1-160 verbatim, then add:

```typescript
describe('one tap on a case menu', () => {
  it('reopens a finished case and shows it again with its buttons', async () => {
    await givenCase({
      reference: 'VISA-2026-00910',
      teacher: TASHKENT_TEACHER,
      category: CASE_CATEGORY.VISA,
      status: 'Completed',
    });

    const outcome = await send({
      chatId: VISA_TASHKENT,
      kind: 'callback',
      text: encodeCallback(CALLBACK.CASE_ACTION, 'VISA-2026-00910', 'RO'),
    });

    // The command's own answer first, then the case again.
    expect(outcome.messages[0]?.text).toContain('open again');
    expect(outcome.messages[1]?.text).toContain('VISA-2026-00910');
    expect(outcome.messages[1]?.keyboard?.length ?? 0).toBeGreaterThan(0);
  });

  it('offers the three levels of importance before writing one', async () => {
    await givenCase({
      reference: 'VISA-2026-00911',
      teacher: TASHKENT_TEACHER,
      category: CASE_CATEGORY.VISA,
    });

    const outcome = await send({
      chatId: VISA_TASHKENT,
      kind: 'callback',
      text: encodeCallback(CALLBACK.CASE_ACTION, 'VISA-2026-00911', 'M'),
    });

    const labels = (outcome.messages[0]?.keyboard ?? []).flat().map((b) => b.text);
    expect(labels.join(' ')).toContain('Critical');
    expect(labels.join(' ')).toContain('Urgent');
  });

  it('writes the importance when a level is tapped', async () => {
    await givenCase({
      reference: 'VISA-2026-00912',
      teacher: TASHKENT_TEACHER,
      category: CASE_CATEGORY.VISA,
    });

    await send({
      chatId: VISA_TASHKENT,
      kind: 'callback',
      text: encodeCallback(CALLBACK.CASE_ACTION, 'VISA-2026-00912', 'M', 'Critical'),
    });

    const rows = await db.execute<{ importance: string }>(
      sql`SELECT importance FROM cases WHERE reference = 'VISA-2026-00912'`,
    );
    expect(rows.rows[0]?.importance).toBe('Critical');
  });

  /**
   * The refusal, not the absence. A Support member is never shown this button —
   * but the payload is four visible characters and the message it came in sits
   * in a chat for ever, so it must be tapped and refused rather than merely
   * hidden.
   */
  it('refuses an owner change from somebody who may not make one', async () => {
    await givenCase({
      reference: 'VISA-2026-00913',
      teacher: TASHKENT_TEACHER,
      category: CASE_CATEGORY.VISA,
      owner: null,
    });

    const outcome = await send({
      chatId: VISA_TASHKENT,
      kind: 'callback',
      text: encodeCallback(CALLBACK.CASE_ACTION, 'VISA-2026-00913', 'OWN', SYSTEM),
    });

    expect(outcome.messages[0]?.text).toContain('not available at your rank');

    const rows = await db.execute<{ owner: string | null }>(
      sql`SELECT owner FROM cases WHERE reference = 'VISA-2026-00913'`,
    );
    expect(rows.rows[0]?.owner).toBeNull();
  });

  /**
   * A case in another queue and region. The refusal must be identical to "no
   * such case": confirming a reference exists tells the tapper a teacher filed
   * something, which is what the visibility rule protects.
   */
  it('answers a case outside the tapper’s scope exactly as it answers a missing one', async () => {
    await givenCase({
      reference: 'ACCOM-2026-00914',
      teacher: SAMARKAND_TEACHER,
      category: CASE_CATEGORY.ACCOMMODATION,
    });

    const hidden = await send({
      chatId: VISA_TASHKENT,
      kind: 'callback',
      text: encodeCallback(CALLBACK.CASE_ACTION, 'ACCOM-2026-00914', 'M'),
    });
    const missing = await send({
      chatId: VISA_TASHKENT,
      kind: 'callback',
      text: encodeCallback(CALLBACK.CASE_ACTION, 'VISA-2026-09999', 'M'),
    });

    expect(hidden.messages[0]?.text).toBe(missing.messages[0]?.text);
  });

  it('sends somebody with no staff row the ordinary teacher menu', async () => {
    const outcome = await send({
      chatId: TASHKENT_TEACHER,
      kind: 'callback',
      text: encodeCallback(CALLBACK.CASE_ACTION, 'VISA-2026-00911', 'M', 'Critical'),
    });

    expect(outcome.messages[0]?.text).not.toContain('not available at your rank');
    expect(outcome.messages[0]?.text).not.toContain('VISA-2026-00911');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/telegram/commands/case-menu.integration.test.ts
```

Expected: FAIL, seven tests. The `CA` payload has no arm in `routeCallback` yet, so every tap falls
to `default` and returns the main menu.

- [ ] **Step 3: Write the resolver**

Append to `src/telegram/commands/case-menu.ts`:

```typescript
import { IMPORTANCE_ORDER } from '../../cases/importance.js';
import { SNOOZE_CHOICES } from '../../config/constants.js';
import type { Database } from '../../db/index.js';
import { findCase } from '../../cases/queries.js';
import type { StaffScope } from '../../staff/visibility.js';
import type { RouterOutcome } from '../router.js';
import { reply } from './context.js';

/**
 * What one tap should produce — either something to show, or a command to run.
 *
 * The same split as `StaffMenuStep`, and it exists for the same reason: this
 * module cannot call the dispatcher without a cycle, so it decides and the
 * dispatcher does. That also means an acting tap runs through exactly the
 * function a typed command runs through, rather than through something that
 * resembles it.
 */
export type CaseMenuStep =
  | { readonly kind: 'show'; readonly outcome: RouterOutcome }
  | { readonly kind: 'run'; readonly command: string };

const show = (outcome: RouterOutcome): CaseMenuStep => ({ kind: 'show', outcome });
const run = (command: string): CaseMenuStep => ({ kind: 'run', command });

/**
 * One tap, resolved.
 *
 * **The case is re-read on every tap**, never trusted from the payload beyond
 * being a reference to look up, and it is read through `findCase` under the
 * tapper's own scope — which is what applies the visibility rule. A menu sits in
 * a chat for ever and the person tapping may have moved queue since it was
 * drawn.
 *
 * Authorisation for the *action* is not done here. The dispatcher checks
 * `case.view` before calling, and `routeStaffCommand` checks the action's own
 * capability again when the command runs.
 */
export async function caseMenuView(
  db: Database,
  chatId: string,
  scope: StaffScope,
  parts: readonly string[],
): Promise<CaseMenuStep> {
  const [reference = '', action = '', value = ''] = parts;

  /**
   * No reference: the way back, which `backToMyCasesButton` builds as `CA::MINE`
   * — an empty first field. It is also where an unreadable or hand-crafted
   * payload lands, and a list is the right thing to show somebody whose button
   * meant nothing.
   */
  if (reference === '') return run('/mycases');

  const row = await findCase(db, scope, reference);
  if (row === null) {
    /**
     * "No such case" and "not yours" are the same answer, deliberately and
     * indistinguishably — the wording is `/case`'s own, so the two cannot drift
     * into telling a tapper apart from a reader.
     */
    return show(
      reply(
        chatId,
        `No case ${reference.toUpperCase()} that you can see. Check the reference, or /cases for what is open.`,
      ),
    );
  }

  // No action: the case itself. This is what every Back button leads to.
  if (action === '') return run(`/case ${row.reference}`);

  if (action === CASE_ACTION.REOPEN) return run(`/reopen ${row.reference}`);

  if (value === '') return show(await choicesFor(db, chatId, row, action));

  if (action === CASE_ACTION.IMPORTANCE) return run(`/mark ${row.reference} ${value}`);
  if (action === CASE_ACTION.OWNER) return run(`/assign ${row.reference} ${value}`);
  if (action === CASE_ACTION.SNOOZE) return run(`/snooze ${row.reference} ${value}`);

  // An action this build does not have: a hand-crafted payload, or a menu from
  // an older build. The case is the safe landing, as it is everywhere here.
  return run(`/case ${row.reference}`);
}
```

Then the choices. Append:

```typescript
/**
 * The second level: which value, for an action that takes one.
 *
 * Every one of these ends in a payload that names the action *and* the value, so
 * a tap at this level is a complete instruction on its own — nothing is
 * remembered between the two taps and nothing can go stale between them.
 */
async function choicesFor(
  db: Database,
  chatId: string,
  row: StaffCaseRow,
  action: string,
): Promise<RouterOutcome> {
  if (action === CASE_ACTION.IMPORTANCE) {
    return reply(
      chatId,
      `How serious is ${row.reference}?\n\nIt is ${row.importance} now.`,
      choiceKeyboard(
        row.reference,
        CASE_ACTION.IMPORTANCE,
        IMPORTANCE_ORDER.map((level) => ({
          value: level,
          label: level === row.importance ? `✅ ${level}` : level,
        })),
      ),
    );
  }

  if (action === CASE_ACTION.SNOOZE) {
    return reply(
      chatId,
      [
        `Stop chasing ${row.reference} for how long?`,
        '',
        'It stays open, stays yours and stays at the same status.',
        'A snooze stops the chasing, not the work.',
      ].join('\n'),
      choiceKeyboard(row.reference, CASE_ACTION.SNOOZE, [
        ...SNOOZE_CHOICES.map((days) => ({ value: String(days), label: `${String(days)} days` })),
        { value: 'clear', label: 'Start chasing it again' },
      ]),
    );
  }

  if (action === CASE_ACTION.OWNER) return ownerChoices(db, chatId, row);

  return reply(chatId, `Nothing to choose for ${row.reference}.`, [[backToCaseButton(row.reference)]]);
}

const backToCaseButton = (reference: string): InlineButton => ({
  text: '⬅️ Back to the case',
  callback_data: encodeCallback(CALLBACK.CASE_ACTION, reference),
});

function choiceKeyboard(
  reference: string,
  action: string,
  choices: readonly { readonly value: string; readonly label: string }[],
): InlineKeyboard {
  const rows: InlineKeyboardRow[] = [];
  for (const choice of choices) {
    /**
     * A choice that will not fit is skipped rather than thrown — the rule
     * `staff.ts` applies to region names and `answerButtons` applies to FAQ
     * codes. Nothing here can actually reach it today, because every value is a
     * constant from this repository, and it is written anyway so that the first
     * value which comes from outside does not have to remember.
     */
    if (callbackPartProblem(CALLBACK.CASE_ACTION, choice.value) !== null) continue;
    rows.push([
      {
        text: choice.label,
        callback_data: encodeCallback(CALLBACK.CASE_ACTION, reference, action, choice.value),
      },
    ]);
  }
  rows.push([backToCaseButton(reference)]);
  return rows;
}
```

Add `callbackPartProblem` to the `callback-data.js` import at the top of the file.

- [ ] **Step 4: Add `SNOOZE_CHOICES` and check `IMPORTANCE_ORDER` exists**

In `src/config/constants.ts`, beside `MAX_SNOOZE_DAYS`:

```typescript
/**
 * The snooze lengths offered as buttons — Part 5I.
 *
 * Three, not a keypad. The point of the button is to remove a decision, and a
 * staff member choosing between 13 and 14 days is doing arithmetic rather than
 * work. `/snooze <ref> <days>` still takes any number up to `MAX_SNOOZE_DAYS`,
 * so nothing is lost — this is the common case made one tap.
 *
 * Every value must stay at or below `MAX_SNOOZE_DAYS`, or a button would be
 * drawn that `setSnooze` refuses. A test asserts it.
 */
export const SNOOZE_CHOICES = [7, 14, 30] as const;
```

Add to `src/config/constants.test.ts`:

```typescript
it('offers no snooze button longer than a snooze may be', () => {
  for (const days of SNOOZE_CHOICES) {
    expect(days).toBeLessThanOrEqual(MAX_SNOOZE_DAYS);
  }
});
```

Then check `src/cases/importance.ts` exports an ordered list. Run:

```bash
grep -n "export" src/cases/importance.ts
```

If it exports `IMPORTANCE_ORDER`, use it. If it only exports `importanceList()` and
`parseImportance()`, add the ordered constant beside them and have `importanceList` render from it,
so there is one order rather than two:

```typescript
/** Every level, least serious first. The one order; `importanceList` renders it. */
export const IMPORTANCE_ORDER = ['Normal', 'Urgent', 'Critical'] as const;
```

- [ ] **Step 5: Write the owner choices**

Append to `src/telegram/commands/case-menu.ts`:

```typescript
/**
 * Who could own this case.
 *
 * `staffCovering` already answers "which people may see this", is the inverse of
 * the visibility predicate, and holds the three rules that do not survive being
 * retyped — an empty `regions` means every region, a null region widens rather
 * than narrows, and System bypasses both axes. **No new query, and no second
 * expression of who covers what.**
 *
 * It is asked for `case.update` rather than `case.view`, so an Observer who can
 * read the case but change nothing is not offered as its owner. That makes this
 * list *narrower* than `/assign` would accept, never wider — and narrower is the
 * safe direction: the command re-checks every candidate through `findCase` under
 * their own scope, so a button can only ever offer somebody the command would
 * also allow.
 *
 * An empty list says so in `/case`'s own words rather than drawing an empty
 * keyboard. That sentence means a staffing gap, not an unclaimed queue (Part
 * 5H.2), and it is the same sentence `/case` prints against `Owner:`.
 */
async function ownerChoices(db: Database, chatId: string, row: StaffCaseRow): Promise<RouterOutcome> {
  const ids = await staffCovering(db, {
    capability: CAPABILITY.CASE_UPDATE,
    category: row.category,
    region: row.region,
  });

  const people = (await listStaff(db)).filter((m) => ids.includes(m.telegramId));

  if (people.length === 0) {
    return reply(
      chatId,
      [
        `Nobody can own ${row.reference} — no active staff member covers this queue and region.`,
        '',
        'That is a staffing gap rather than a queue. It stays on /cases unassigned until',
        'somebody covers it.',
      ].join('\n'),
      [[backToCaseButton(row.reference)]],
    );
  }

  return reply(
    chatId,
    `Who should own ${row.reference}?\n\n${row.owner === null ? 'Nobody owns it now.' : `${row.owner} owns it now.`}`,
    choiceKeyboard(
      row.reference,
      CASE_ACTION.OWNER,
      people.slice(0, STAFF_BUTTON_CAP).map((m) => ({
        value: m.telegramId,
        label: m.telegramId === row.owner ? `✅ ${m.name ?? m.telegramId}` : (m.name ?? m.telegramId),
      })),
    ),
  );
}
```

Add these imports at the top of the file:

```typescript
import { STAFF_BUTTON_CAP } from '../../config/constants.js';
import { listStaff } from '../../staff/repository.js';
import { staffCovering } from '../../staff/recipients.js';
```

- [ ] **Step 6: Run — it still fails, and that is expected**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/telegram/commands/case-menu.integration.test.ts
```

Expected: still FAIL. Nothing routes `CA` yet — that is Task 5. Do not chase it here.

- [ ] **Step 7: Commit**

```bash
git add src/telegram/commands/case-menu.ts src/config/constants.ts src/config/constants.test.ts src/cases/importance.ts && git commit -m "feat: what a tap on a case menu means"
```

---

### Task 5: Route the taps

**Files:**
- Modify: `src/telegram/commands/index.ts`
- Modify: `src/telegram/router.ts:1042` area (the `routeCallback` switch)
- Test: `src/telegram/commands/case-menu.integration.test.ts` (already written, Task 4)

- [ ] **Step 1: Add the dispatcher**

In `src/telegram/commands/index.ts`, add to the `./case-menu.js` import list and append this function
after `routeStaffMenu`:

```typescript
/**
 * One tap on a case menu — Part 5I.
 *
 * It lives here rather than beside the menu it draws, for `routeStaffMenu`'s
 * reason: the acting taps run by handing the equivalent typed command to
 * `routeStaffCommand` above, and `case-menu.ts` cannot call that without a
 * cycle. **The consequence is the safety argument for the whole part.** A tap
 * that closes a case is not merely *as* authorised as `/close`; it **is**
 * `/close`, so the refusal on an already-finished case, the warning when a
 * teacher can no longer read the message, and the row recording who did it all
 * come from the one place that has ever had them.
 *
 * The gate is `case.view`, which is the least any of these needs — the action's
 * own capability is checked again inside `routeStaffCommand` when the command
 * runs, which is what refuses a Support member the owner button they were never
 * shown. Silence for no staff row, a plain answer for a rank too low: the same
 * shape as the dispatcher above, and for the same reasons.
 */
export async function routeCaseMenu(
  db: Database,
  chatId: string,
  parts: readonly string[],
  state: ConversationState | null,
  deps: RouterDeps,
): Promise<RouterOutcome | null> {
  const member = await findStaff(db, chatId);
  if (member === null) {
    await logInteraction(db, chatId, STAFF_DENIED, 'case menu', state);
    return null;
  }

  if (!can(member, CAPABILITY.CASE_VIEW)) {
    await logInteraction(db, chatId, STAFF_DENIED, 'case menu', state);
    return reply(chatId, refusalText('/case', CAPABILITY.CASE_VIEW, member.role));
  }

  const step = await caseMenuView(db, chatId, scopeOf(member), parts);
  if (step.kind === 'show') return step.outcome;

  const done = await routeStaffCommand(db, chatId, step.command, state, deps);
  if (done === null) return null;

  /**
   * The command's answer first, then the case again.
   *
   * The first message says what changed, or refuses with a reason only the
   * command knows. The case follows so the next action is another tap rather
   * than another `/cases` — which is the entire point of the part.
   *
   * `/mycases` is the one exception: it *is* a list, so re-showing a case after
   * it would be showing a case nobody asked for.
   */
  if (step.command === '/mycases') return done;

  const [reference = ''] = parts;
  const again = await routeStaffCommand(db, chatId, `/case ${reference}`, state, deps);

  return {
    messages: [...done.messages, ...(again?.messages ?? [])],
    alerts: [...done.alerts, ...(again?.alerts ?? [])],
  };
}
```

Add the import:

```typescript
import { caseMenuView } from './case-menu.js';
```

- [ ] **Step 2: Wire the router**

In `src/telegram/router.ts`, add to the `./commands/index.js` import list `routeCaseMenu`, and add
this arm to the `switch (decoded.prefix)` in `routeCallback`, immediately after the
`case CALLBACK.CASE_OPEN:` arm:

```typescript
    /**
     * One action on one case — Part 5I.
     *
     * The whole payload is handed over rather than picked apart here: it is a
     * three-level menu and the router has no business knowing its levels. What
     * it does know is the same thing it knows about every other staff tap —
     * `null` means the tapper is not staff, and gets the ordinary menu rather
     * than an answer confirming the button is real.
     */
    case CALLBACK.CASE_ACTION:
      return (
        (await routeCaseMenu(db, update.chatId, decoded.parts, state, deps))
        ?? only(update.chatId, await menuReplyFor(db, update.chatId))
      );
```

- [ ] **Step 3: Run the tests and watch them pass**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/telegram/commands/case-menu.integration.test.ts
```

Expected: PASS, 7 tests, 0 failed.

- [ ] **Step 4: Run the neighbouring files**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/telegram/commands/ src/telegram/router.integration.test.ts
```

Expected: 0 failed. **If a test fails here, the test is usually right** — read what it asserts
before changing anything.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/commands/index.ts src/telegram/router.ts && git commit -m "feat: a tap on a case runs the command it stands for"
```

---

### Task 6: Regenerate the dependency graph and verify piece 1

**Files:**
- Modify: `docs/dependency-tree.md` (generated — do not hand-edit)

- [ ] **Step 1: Regenerate**

```bash
npm run deps
```

- [ ] **Step 2: Check the gate**

```bash
npm run deps:check
```

Expected: silent, exit 0. It is non-zero on a cycle, an unresolvable import, or a dead file. **If it
reports a cycle, `case-menu.ts` has imported something from `cases.ts` or from `index.ts`** — remove
the import rather than adding an override.

- [ ] **Step 3: Typecheck, build, lint**

```bash
npm run typecheck
```

```bash
npm run build
```

```bash
npm run lint
```

Expected: clean, clean, 0 warnings.

- [ ] **Step 4: Commit**

```bash
git add docs/dependency-tree.md && git commit -m "docs: regenerate the dependency tree for the case menu"
```

**Piece 1 is now shippable.** Tell the head of project it can be tried on the live bot before piece
2 starts, and ask whether the button layout is right.

---

# PIECE 2 — the writing states, `/staff_add`, and the wording

---

### Task 7: Two staff states

**Files:**
- Modify: `src/conversation/state.ts`
- Test: `src/conversation/state.integration.test.ts`

**No migration.** `conversation_states.state` is free text in the database on purpose, so adding a
state needs none. Do not run `drizzle-kit generate` for this task.

- [ ] **Step 1: Write the failing test**

Add to `src/conversation/state.integration.test.ts`:

```typescript
describe('the staff states', () => {
  it('remembers which case somebody is writing about', async () => {
    await saveState(db, '994001', {
      kind: 'AwaitingCaseText',
      action: 'reply',
      reference: 'VISA-2026-00311',
    });

    const loaded = await loadState(db, '994001');
    expect(loaded).toEqual({
      kind: 'AwaitingCaseText',
      action: 'reply',
      reference: 'VISA-2026-00311',
    });
  });

  it('remembers that somebody is adding a staff member', async () => {
    await saveState(db, '994001', { kind: 'AwaitingStaffId' });
    expect(await loadState(db, '994001')).toEqual({ kind: 'AwaitingStaffId' });
  });

  /**
   * A payload a newer build wrote, or an action this build has never had. It
   * must read as "no state" rather than throw — throwing here breaks every
   * subsequent message from that chat, not just this one.
   */
  it('reads an unknown action as no state at all', async () => {
    await db.execute(sql`
      INSERT INTO conversation_states (chat_id, state, payload, updated_at, expires_at)
      VALUES ('994009', 'AwaitingCaseText', '{"action":"teleport","reference":"X"}'::jsonb, now(), now() + interval '1 hour')
    `);
    expect(await loadState(db, '994009')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/conversation/state.integration.test.ts
```

Expected: FAIL — the first two, on a TypeScript error and on `loadState` returning null because the
union does not parse them. The third passes already, which is correct and worth keeping: it is the
guard that made adding these safe.

- [ ] **Step 3: Add the states**

In `src/conversation/state.ts`, add to the `z.discriminatedUnion('kind', [...])` array, after
`AwaitingUrgentDetail`:

```typescript
  /**
   * A staff member writing the words for an action they tapped — Part 5I.
   *
   * **The first staff-facing conversation state in this system.** Everything
   * above it is a teacher's. It exists because a button cannot carry a sentence:
   * tapping "Reply to teacher" has to be followed by the sentence, and something
   * has to remember which case it belongs to in between.
   *
   * The reference is held rather than the case, so nothing goes stale — the case
   * is re-read when the message arrives, through `findCase` under the writer's
   * own scope, exactly as a tap is. `action` is the command the message becomes.
   *
   * It expires with everything else after `CONVERSATION_TTL_MINUTES`, which is
   * the point: a staff member who taps Reply and then goes home does not have
   * their next message tomorrow sent to a teacher.
   */
  z.object({
    kind: z.literal('AwaitingCaseText'),
    action: z.enum(['reply', 'await', 'note', 'due', 'close', 'close-unresolved']),
    reference: z.string(),
  }),
  /**
   * Adding a staff member, and waiting for the one thing that cannot be a
   * button — Part 5I.
   *
   * It carries nothing. The chat id being typed *is* the whole payload, and
   * everything chosen afterwards travels in the button that chose it, for
   * `CALLBACK.STAFF_MENU`'s reason: a menu left for an hour must not act on
   * whoever was chosen an hour ago.
   */
  z.object({ kind: z.literal('AwaitingStaffId') }),
```

- [ ] **Step 4: Run it and watch it pass**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/conversation/state.integration.test.ts
```

Expected: PASS, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src/conversation/state.ts src/conversation/state.integration.test.ts && git commit -m "feat: the bot can remember what a staff member is writing"
```

---

### Task 8: Prompt for the words, and capture them

**Files:**
- Modify: `src/telegram/commands/case-menu.ts`
- Modify: `src/telegram/commands/index.ts`
- Modify: `src/telegram/router.ts`
- Test: `src/telegram/commands/case-menu.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/telegram/commands/case-menu.integration.test.ts`:

```typescript
describe('writing the words for an action', () => {
  it('asks for the reply, then sends what was typed to the teacher', async () => {
    await givenCase({
      reference: 'VISA-2026-00920',
      teacher: TASHKENT_TEACHER,
      category: CASE_CATEGORY.VISA,
    });

    const prompt = await send({
      chatId: VISA_TASHKENT,
      kind: 'callback',
      text: encodeCallback(CALLBACK.CASE_ACTION, 'VISA-2026-00920', 'REP'),
    });
    expect(prompt.messages[0]?.text).toContain('VISA-2026-00920');

    const done = await send({
      chatId: VISA_TASHKENT,
      kind: 'text',
      text: 'your visa is with the embassy and should be ready on Friday',
    });

    const toTeacher = done.messages.find((m) => m.chatId === TASHKENT_TEACHER);
    expect(toTeacher?.text).toContain('should be ready on Friday');
  });

  /**
   * The rule the design calls out. Without it this sentence is matched as
   * `/close`, refused for having no reference, and the staff member's words are
   * gone.
   */
  it('treats a message beginning with a slash as the words, not as a command', async () => {
    await givenCase({
      reference: 'VISA-2026-00921',
      teacher: TASHKENT_TEACHER,
      category: CASE_CATEGORY.VISA,
    });

    await send({
      chatId: VISA_TASHKENT,
      kind: 'callback',
      text: encodeCallback(CALLBACK.CASE_ACTION, 'VISA-2026-00921', 'REP'),
    });

    const done = await send({
      chatId: VISA_TASHKENT,
      kind: 'text',
      text: '/close the window in her flat is broken, we are chasing the landlord',
    });

    const toTeacher = done.messages.find((m) => m.chatId === TASHKENT_TEACHER);
    expect(toTeacher?.text).toContain('the window in her flat is broken');
  });

  it('lets somebody out with /cancel, changing nothing', async () => {
    await givenCase({
      reference: 'VISA-2026-00922',
      teacher: TASHKENT_TEACHER,
      category: CASE_CATEGORY.VISA,
      status: 'Submitted',
    });

    await send({
      chatId: VISA_TASHKENT,
      kind: 'callback',
      text: encodeCallback(CALLBACK.CASE_ACTION, 'VISA-2026-00922', 'REP'),
    });
    await send({ chatId: VISA_TASHKENT, kind: 'text', text: '/cancel' });

    // The next message is an ordinary one again, not a reply to a teacher.
    const after = await send({ chatId: VISA_TASHKENT, kind: 'text', text: '/mycases' });
    expect(after.messages.every((m) => m.chatId === VISA_TASHKENT)).toBe(true);

    const rows = await db.execute<{ status: string }>(
      sql`SELECT status FROM cases WHERE reference = 'VISA-2026-00922'`,
    );
    expect(rows.rows[0]?.status).toBe('Submitted');
  });

  it('does not put an Observer into a writing state at all', async () => {
    await givenCase({
      reference: 'VISA-2026-00923',
      teacher: TASHKENT_TEACHER,
      category: CASE_CATEGORY.VISA,
    });

    await send({
      chatId: OBSERVER,
      kind: 'callback',
      text: encodeCallback(CALLBACK.CASE_ACTION, 'VISA-2026-00923', 'REP'),
    });

    const next = await send({ chatId: OBSERVER, kind: 'text', text: 'anything at all' });
    expect(next.messages.some((m) => m.chatId === TASHKENT_TEACHER)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/telegram/commands/case-menu.integration.test.ts -t "writing the words"
```

Expected: FAIL, four tests. `REP` is not an action this build has, so every tap lands on the case.

- [ ] **Step 3: Add the writing actions and their prompts**

In `src/telegram/commands/case-menu.ts`, extend `CASE_ACTION`:

```typescript
export const CASE_ACTION = {
  REOPEN: 'RO',
  OWNER: 'OWN',
  IMPORTANCE: 'M',
  SNOOZE: 'SN',
  REPLY: 'REP',
  AWAIT: 'AWT',
  NOTE: 'N',
  DUE: 'D',
  CLOSE: 'C',
} as const;
```

Add a third arm to `CaseMenuStep`:

```typescript
export type CaseMenuStep =
  | { readonly kind: 'show'; readonly outcome: RouterOutcome }
  | { readonly kind: 'run'; readonly command: string }
  /**
   * Ask for the words, and remember what they are for.
   *
   * A third kind rather than a `show` that happens to save a state, because a
   * state written from inside a function that claims only to render is exactly
   * the kind of side effect nobody finds. `index.ts` writes it, where every
   * other write in this path happens.
   */
  | { readonly kind: 'ask'; readonly outcome: RouterOutcome; readonly action: CaseTextAction; readonly reference: string };

export type CaseTextAction = 'reply' | 'await' | 'note' | 'due' | 'close' | 'close-unresolved';

const ask = (outcome: RouterOutcome, action: CaseTextAction, reference: string): CaseMenuStep => ({
  kind: 'ask',
  outcome,
  action,
  reference,
});
```

In `caseMenuView`, before the `if (value === '')` line, add:

```typescript
  const asking = promptFor(chatId, row, action, value);
  if (asking !== null) return asking;
```

And append the prompt builder:

```typescript
/**
 * The prompt for an action that carries words, or null if this action does not.
 *
 * Every prompt names the case, because the message sits in a chat where the case
 * itself has scrolled away by the time somebody comes back to it, and a bot
 * asking "what should I tell them?" with no subject is a bot nobody trusts.
 *
 * Every prompt carries Cancel. The alternative is a staff member whose next
 * message goes somewhere they did not intend, and the 30-minute expiry is a
 * backstop rather than an answer.
 */
function promptFor(
  chatId: string,
  row: StaffCaseRow,
  action: string,
  value: string,
): CaseMenuStep | null {
  const cancel: InlineKeyboard = [[{ text: '✖️ Cancel', callback_data: encodeCallback(CALLBACK.CASE_ACTION, row.reference) }]];

  if (action === CASE_ACTION.REPLY) {
    return ask(
      reply(chatId, [`Writing a reply to the teacher on ${row.reference}.`, '', 'Type it now. They will be sent exactly what you write, and can read it again in Check My Case.'].join('\n'), cancel),
      'reply',
      row.reference,
    );
  }

  if (action === CASE_ACTION.AWAIT) {
    return ask(
      reply(chatId, [`What do you need from the teacher on ${row.reference}?`, '', 'Type it now. The case is marked “Action required” and cannot move until they do it.'].join('\n'), cancel),
      'await',
      row.reference,
    );
  }

  if (action === CASE_ACTION.NOTE) {
    return ask(
      reply(chatId, [`Writing a note on ${row.reference}.`, '', 'Type it now. No teacher ever sees these, and the case is not touched — a note is a record, not progress.'].join('\n'), cancel),
      'note',
      row.reference,
    );
  }

  if (action === CASE_ACTION.DUE) {
    return ask(
      reply(chatId, [`When is ${row.reference} promised by?`, '', 'Type a date — 2026-08-15, or 15 Aug 2026.', 'Type “clear” to take the date off again.', '', 'The teacher is not told. A date staff agree among themselves is not a promise until somebody makes it.'].join('\n'), cancel),
      'due',
      row.reference,
    );
  }

  /**
   * Closing asks a question first. "We fixed it" and "we gave up" are the most
   * useful thing a later reader can know, and the two write different statuses,
   * send the teacher different things and record the reason in different places.
   */
  if (action === CASE_ACTION.CLOSE && value === '') {
    return {
      kind: 'show',
      outcome: reply(
        chatId,
        [`Closing ${row.reference}. Was it resolved?`, '', 'Either way the teacher is told the case is closed.'].join('\n'),
        [
          [{ text: '✅ Yes — it was resolved', callback_data: encodeCallback(CALLBACK.CASE_ACTION, row.reference, CASE_ACTION.CLOSE, 'ok') }],
          [{ text: '⚠️ No — closing it unresolved', callback_data: encodeCallback(CALLBACK.CASE_ACTION, row.reference, CASE_ACTION.CLOSE, 'no') }],
          ...cancel,
        ],
      ),
    };
  }

  if (action === CASE_ACTION.CLOSE && value === 'ok') {
    return ask(
      reply(chatId, [`Closing ${row.reference} as resolved.`, '', 'What should I tell the teacher? They will be sent exactly what you write.'].join('\n'), cancel),
      'close',
      row.reference,
    );
  }

  if (action === CASE_ACTION.CLOSE && value === 'no') {
    return ask(
      reply(chatId, [`Closing ${row.reference} without resolving it.`, '', 'Why? This goes on the case as a note for whoever reads it later — the teacher is told the case is closed, not why.'].join('\n'), cancel),
      'close-unresolved',
      row.reference,
    );
  }

  return null;
}
```

Finally, the function that turns a captured message back into a command. Append:

```typescript
/**
 * The typed command a captured message is equivalent to.
 *
 * **This is the whole of what the writing states buy**, and it is deliberately
 * one small total function: every state maps to a command that already exists,
 * with the reference the state remembered and the words the staff member typed.
 * Nothing is parsed, nothing is validated, nothing is decided — `/reply` refuses
 * a finished case, `/due` refuses a date in the past, and `/close` writes the
 * note. They keep doing all of it.
 */
export function commandForCaseText(
  action: CaseTextAction,
  reference: string,
  text: string,
): string {
  switch (action) {
    case 'reply':
      return `/reply ${reference} ${text}`;
    case 'await':
      return `/await ${reference} ${text}`;
    case 'note':
      return `/note ${reference} ${text}`;
    case 'due':
      return `/due ${reference} ${text}`;
    case 'close':
      return `/close ${reference} ${text}`;
    case 'close-unresolved':
      return `/close ${reference} unresolved ${text}`;
  }
}
```

- [ ] **Step 4: Write the state, and capture the message**

In `src/telegram/commands/index.ts`, in `routeCaseMenu`, add before the `if (step.kind === 'show')`
line:

```typescript
  /**
   * Asked for words. The state is written here rather than inside the view, so
   * that every write in this path happens in the same place — and so that a
   * refusal above this line can never leave a chat waiting for a message nobody
   * asked it for.
   */
  if (step.kind === 'ask') {
    await saveState(db, chatId, {
      kind: 'AwaitingCaseText',
      action: step.action,
      reference: step.reference,
    });
    return step.outcome;
  }
```

Then append the capture function to the same file:

```typescript
/**
 * A staff member's next message, when they were asked for one — Part 5I.
 *
 * **It runs ahead of the command dispatcher, which nothing else does**, and that
 * is the decision the design records: a reply beginning with `/close` is the
 * words, not a command. Matched as a command it would be refused for having no
 * reference, and the staff member's sentence would be gone.
 *
 * The cost is that no command works while the bot is waiting. There are three
 * ways out and all are cheap — the Cancel button, `/cancel`, and the ordinary
 * 30-minute expiry that needs nobody to remember it.
 *
 * `null` means "this is not somebody in a writing state", and the router carries
 * on exactly as it did. That includes a chat whose staff row has gone since the
 * state was written, which is why the row is re-read rather than assumed.
 */
export async function routeStaffWriting(
  db: Database,
  chatId: string,
  text: string,
  state: ConversationState | null,
  deps: RouterDeps,
): Promise<RouterOutcome | null> {
  if (state?.kind !== 'AwaitingCaseText') return null;

  const member = await findStaff(db, chatId);
  if (member === null) {
    // Their staff row went while they were typing. Forget the state rather than
    // leaving a chat that swallows every message it sends.
    await clearState(db, chatId);
    return null;
  }

  if (text.trim().toLowerCase() === '/cancel') {
    await clearState(db, chatId);
    return reply(chatId, `Cancelled. Nothing was changed on ${state.reference}.`);
  }

  /**
   * Cleared before the command runs, not after. A command that throws would
   * otherwise leave the chat still waiting, and the staff member's next message
   * — quite possibly "what happened?" — would be sent to a teacher.
   */
  await clearState(db, chatId);

  const done = await routeStaffCommand(
    db,
    chatId,
    commandForCaseText(state.action, state.reference, text),
    null,
    deps,
  );
  if (done === null) return null;

  const again = await routeStaffCommand(db, chatId, `/case ${state.reference}`, null, deps);
  return {
    messages: [...done.messages, ...(again?.messages ?? [])],
    alerts: [...done.alerts, ...(again?.alerts ?? [])],
  };
}
```

Add these imports to `index.ts`:

```typescript
import { clearState, saveState } from '../../conversation/state.js';
import { caseMenuView, commandForCaseText } from './case-menu.js';
```

Note the `null` passed as `state` to `routeStaffCommand` in both calls: the state has just been
cleared, and passing the stale one would redact the log entry against a state that no longer exists.

- [ ] **Step 5: Wire the router**

In `src/telegram/router.ts`, in `routeText`, add **immediately before** the
`const staffOutcome = await routeStaffCommand(...)` line:

```typescript
  /**
   * A staff member who was asked for words — Part 5I, and the one place a staff
   * path runs ahead of the command dispatcher.
   *
   * Guarded twice over: it fires only for `AwaitingCaseText`, which no teacher
   * can ever be in, and `routeStaffWriting` returns null for a chat with no
   * active staff row. So the teacher state machine below is untouched and its
   * order is unchanged.
   */
  const writing = await routeStaffWriting(db, update.chatId, text, state, deps);
  if (writing !== null) return writing;
```

Add `routeStaffWriting` to the `./commands/index.js` import list.

- [ ] **Step 6: Run it and watch it pass**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/telegram/commands/case-menu.integration.test.ts
```

Expected: PASS, 11 tests, 0 failed.

- [ ] **Step 7: Add the writing buttons to the keyboard**

In `caseActionKeyboard`, add inside the `if (mayUpdate && open)` block, **above** the snooze row:

```typescript
    rows.push([{ text: '💬 Reply to teacher', callback_data: forCase(row.reference, CASE_ACTION.REPLY) }]);
    rows.push([{ text: '📥 Ask them for something', callback_data: forCase(row.reference, CASE_ACTION.AWAIT) }]);
    rows.push([{ text: '✅ Close it', callback_data: forCase(row.reference, CASE_ACTION.CLOSE) }]);
    rows.push([{ text: '📅 Promised by', callback_data: forCase(row.reference, CASE_ACTION.DUE) }]);
```

And add a note button that is drawn whether or not the case is open, immediately after that block:

```typescript
  /**
   * A note is allowed on a finished case, unlike everything else that writes.
   * Something worth recording often turns up after the fact, and a note is a
   * record rather than an action — `/note` already permits it.
   */
  if (mayUpdate) {
    rows.push([{ text: '📝 Add a note', callback_data: forCase(row.reference, CASE_ACTION.NOTE) }]);
  }
```

- [ ] **Step 8: Extend the keyboard test**

Add to `src/telegram/commands/case-menu.test.ts`:

```typescript
it('offers a note on a finished case and a reply only on an open one', () => {
  const open = payloads(member({ role: 'Support' }), openCase({ status: 'Under review' }));
  const done = payloads(member({ role: 'Support' }), openCase({ status: 'Completed' }));
  expect(open).toContain('REP');
  expect(done).not.toContain('REP');
  expect(open).toContain('N');
  expect(done).toContain('N');
});
```

- [ ] **Step 9: Run both files**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/telegram/commands/case-menu.test.ts src/telegram/commands/case-menu.integration.test.ts
```

Expected: PASS, 0 failed.

- [ ] **Step 10: Commit**

```bash
git add src/telegram/commands/case-menu.ts src/telegram/commands/case-menu.test.ts src/telegram/commands/case-menu.integration.test.ts src/telegram/commands/index.ts src/telegram/router.ts && git commit -m "feat: tap the action, type the words, and never type a reference"
```

---

### Task 9: Adding a staff member by button

**Files:**
- Modify: `src/telegram/callback-data.ts`
- Modify: `src/telegram/commands/staff.ts`
- Modify: `src/telegram/commands/index.ts`
- Modify: `src/telegram/router.ts`
- Test: `src/telegram/commands/staff.integration.test.ts`

- [ ] **Step 1: Measure the new prefix, asserting the value**

Add to `src/telegram/callback-data.test.ts`:

```typescript
describe('the staff add prefix', () => {
  /**
   * The payload it built, not merely its length — the lesson of commit
   * `417f821`. `vitest` transpiles rather than type-checks, so a `CALLBACK`
   * member that does not exist is `undefined` at runtime, `encodeCallback`
   * stringifies it, and a length-only assertion passes over nothing at all.
   */
  it('builds the longest add payload, inside the limit', () => {
    const data = encodeCallback(CALLBACK.STAFF_ADD, '9999999999', 'System', 'Accommodation');
    expect(data).toBe('SA:9999999999:System:Accommodation');
    expect(byteLength(data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
  });
});
```

- [ ] **Step 2: Write the failing flow test**

Add to `src/telegram/commands/staff.integration.test.ts`:

```typescript
describe('adding somebody by button', () => {
  it('walks from the id through rank and queue to a staff row', async () => {
    // SYSTEM_MEMBER holds staff.manage. Check the fixture name in this file's
    // beforeEach and use whichever chat id is seeded as System.
    const start = await send({
      chatId: SYSTEM_MEMBER,
      kind: 'callback',
      text: encodeCallback(CALLBACK.STAFF_ADD),
    });
    expect(start.messages[0]?.text).toContain('chat id');

    const afterId = await send({ chatId: SYSTEM_MEMBER, kind: 'text', text: '995500' });
    const rankLabels = (afterId.messages[0]?.keyboard ?? []).flat().map((b) => b.text);
    expect(rankLabels.join(' ')).toContain('Support');

    const afterRank = await send({
      chatId: SYSTEM_MEMBER,
      kind: 'callback',
      text: encodeCallback(CALLBACK.STAFF_ADD, '995500', 'Support'),
    });
    const queueLabels = (afterRank.messages[0]?.keyboard ?? []).flat().map((b) => b.text);
    expect(queueLabels.join(' ')).toContain('Visa');

    await send({
      chatId: SYSTEM_MEMBER,
      kind: 'callback',
      text: encodeCallback(CALLBACK.STAFF_ADD, '995500', 'Support', 'Visa'),
    });

    const rows = await db.execute<{ role: string; queue: string; regions: string[] }>(
      sql`SELECT role, queue, regions FROM staff WHERE telegram_id = '995500'`,
    );
    expect(rows.rows[0]?.role).toBe('Support');
    expect(rows.rows[0]?.queue).toBe('Visa');
    // Regions are not asked for; empty means every region, never none.
    expect(rows.rows[0]?.regions).toEqual([]);
  });

  it('refuses the whole flow to somebody who may not manage staff', async () => {
    const outcome = await send({
      chatId: SUPPORT_MEMBER,
      kind: 'callback',
      text: encodeCallback(CALLBACK.STAFF_ADD, '995501', 'System', 'All'),
    });

    expect(outcome.messages[0]?.text).toContain('not available at your rank');
    const rows = await db.execute(sql`SELECT 1 FROM staff WHERE telegram_id = '995501'`);
    expect(rows.rows).toHaveLength(0);
  });
});
```

Read this file's `beforeEach` and replace `SYSTEM_MEMBER` and `SUPPORT_MEMBER` with the constants it
actually seeds.

- [ ] **Step 3: Run it and watch it fail**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/telegram/commands/staff.integration.test.ts -t "adding somebody by button"
```

Expected: FAIL — `CALLBACK.STAFF_ADD` is undefined.

- [ ] **Step 4: Add the prefix**

In `src/telegram/callback-data.ts`, after `STAFF_MENU: 'SM'`:

```typescript
  /**
   * Adding a staff member — `SA[:<chat id>[:<rank>[:<queue>]]]` — Part 5I.
   *
   * The one flow in this system whose first step cannot be a button, because the
   * chat id is the one thing only the person adding knows. So the id is typed
   * once, into `AwaitingStaffId`, and travels in the payload from then on — the
   * rank and the queue are chosen, and each choice carries everything decided
   * before it. A menu left for an hour therefore cannot add whoever was chosen
   * an hour ago.
   *
   * Regions are deliberately not part of it. The row is created covering every
   * region, which is exactly what `/staff_add 991001 Support Visa` does today
   * with no regions given, and "Change regions" is on their row immediately
   * afterwards.
   *
   * `SA:9999999999:Accommodation` is 27 bytes against the 64-byte limit. Ranks
   * and queues are constants in this repository, so unlike a region their length
   * is ours to guarantee.
   */
  STAFF_ADD: 'SA',
```

- [ ] **Step 5: Add the button and the flow**

In `src/telegram/commands/staff.ts`, in `staffMenuList`, change the keyboard argument from
`staffListKeyboard(everybody)` to `[...staffListKeyboard(everybody), [addSomebodyButton]]`, and add:

```typescript
const addSomebodyButton: InlineButton = {
  text: '➕ Add somebody',
  callback_data: encodeCallback(CALLBACK.STAFF_ADD),
};

/**
 * One tap on the add-somebody flow, resolved.
 *
 * The same show-or-run split as `staffMenuView`, plus the one step that asks for
 * a typed value. Nothing here creates a staff row: the last tap runs
 * `/staff_add`, which is the single place that knows what a queue means, refuses
 * a rank it does not recognise, and answers a chat id that already has a row.
 */
export async function staffAddView(
  db: Database,
  chatId: string,
  parts: readonly string[],
): Promise<StaffAddStep> {
  const [subject = '', role = '', queue = ''] = parts;

  if (subject === '') {
    return {
      kind: 'ask',
      outcome: reply(
        chatId,
        [
          'Send me their Telegram chat id.',
          '',
          'It is the number, not an @handle — they can get it from any “what is my id” bot,',
          'or it is on their case if they have ever written in.',
        ].join('\n'),
        [[{ text: '✖️ Cancel', callback_data: encodeCallback(CALLBACK.STAFF_MENU) }]],
      ),
    };
  }

  if (role === '') {
    return {
      kind: 'show',
      outcome: reply(
        chatId,
        `Adding ${subject}. Which rank?`,
        addChoiceKeyboard(
          STAFF_ROLE_ORDER.map((r) => ({ label: r, parts: [subject, r] })),
        ),
      ),
    };
  }

  if (queue === '') {
    return {
      kind: 'show',
      outcome: reply(
        chatId,
        [
          `Adding ${subject} as ${role}. Which queue?`,
          '',
          'The queue decides which teachers’ problems they can read, so it is asked',
          'rather than guessed.',
        ].join('\n'),
        addChoiceKeyboard(
          ALL_QUEUES.map((q) => ({ label: q, parts: [subject, role, q] })),
        ),
      ),
    };
  }

  return { kind: 'run', command: `/staff_add ${subject} ${role} ${queue}` };
}

export type StaffAddStep =
  | { readonly kind: 'show'; readonly outcome: RouterOutcome }
  | { readonly kind: 'ask'; readonly outcome: RouterOutcome }
  | { readonly kind: 'run'; readonly command: string };

function addChoiceKeyboard(
  choices: readonly { readonly label: string; readonly parts: readonly string[] }[],
): InlineKeyboard {
  const rows: InlineKeyboardRow[] = choices.map((c) => [
    { text: c.label, callback_data: encodeCallback(CALLBACK.STAFF_ADD, ...c.parts) },
  ]);
  rows.push([backToStaffButton]);
  return rows;
}
```

- [ ] **Step 6: Route it**

In `src/telegram/commands/index.ts`, append:

```typescript
/**
 * The add-somebody flow — Part 5I.
 *
 * `staff.manage` floors at System and is checked here before anything is shown,
 * so a Support member who guesses the payload is refused at the first step
 * rather than after choosing a rank. It is checked again inside `/staff_add`
 * when the last tap runs.
 */
export async function routeStaffAdd(
  db: Database,
  chatId: string,
  parts: readonly string[],
  state: ConversationState | null,
  deps: RouterDeps,
): Promise<RouterOutcome | null> {
  const member = await findStaff(db, chatId);
  if (member === null) {
    await logInteraction(db, chatId, STAFF_DENIED, 'staff add', state);
    return null;
  }

  if (!can(member, CAPABILITY.STAFF_MANAGE)) {
    await logInteraction(db, chatId, STAFF_DENIED, 'staff add', state);
    return reply(chatId, refusalText('/staff_add', CAPABILITY.STAFF_MANAGE, member.role));
  }

  const step = await staffAddView(db, chatId, parts);

  if (step.kind === 'ask') {
    await saveState(db, chatId, { kind: 'AwaitingStaffId' });
    return step.outcome;
  }
  if (step.kind === 'show') return step.outcome;

  const done = await routeStaffCommand(db, chatId, step.command, state, deps);
  if (done === null) return null;

  const list = await staffMenuList(db, chatId);
  return {
    messages: [...done.messages, ...list.messages],
    alerts: [...done.alerts, ...list.alerts],
  };
}
```

Then extend `routeStaffWriting` to handle the id state as well. **Replace the whole function body**
written in Task 8 with this — do not patch it line by line, because the order of the `clearState`
calls is the part that matters:

```typescript
export async function routeStaffWriting(
  db: Database,
  chatId: string,
  text: string,
  state: ConversationState | null,
  deps: RouterDeps,
): Promise<RouterOutcome | null> {
  if (state === null) return null;
  if (state.kind !== 'AwaitingCaseText' && state.kind !== 'AwaitingStaffId') return null;

  const member = await findStaff(db, chatId);
  if (member === null) {
    // Their staff row went while they were typing. Forget the state rather than
    // leaving a chat that swallows every message it sends.
    await clearState(db, chatId);
    return null;
  }

  if (text.trim().toLowerCase() === '/cancel') {
    await clearState(db, chatId);
    return reply(
      chatId,
      state.kind === 'AwaitingStaffId'
        ? 'Cancelled. Nobody was added.'
        : `Cancelled. Nothing was changed on ${state.reference}.`,
    );
  }

  /**
   * Cleared before anything runs, on every path, and that ordering is the point.
   * A command that throws would otherwise leave the chat still waiting, and the
   * staff member's next message — quite possibly "what happened?" — would be
   * sent to a teacher.
   */
  await clearState(db, chatId);

  /**
   * The typed chat id. It is not validated here: `/staff_add` already refuses a
   * value that is not a chat id, and `addStaff` already answers a row that
   * exists. Validating here would be the second copy of both.
   */
  if (state.kind === 'AwaitingStaffId') {
    return routeStaffAdd(db, chatId, [text.trim()], null, deps);
  }

  const done = await routeStaffCommand(
    db,
    chatId,
    commandForCaseText(state.action, state.reference, text),
    null,
    deps,
  );
  if (done === null) return null;

  const again = await routeStaffCommand(db, chatId, `/case ${state.reference}`, null, deps);
  return {
    messages: [...done.messages, ...(again?.messages ?? [])],
    alerts: [...done.alerts, ...(again?.alerts ?? [])],
  };
}
```

`routeStaffAdd` is declared above this in the same file, so the call needs no import.

- [ ] **Step 7: Wire the router**

In `src/telegram/router.ts`, add after the `case CALLBACK.STAFF_MENU:` arm:

```typescript
    case CALLBACK.STAFF_ADD:
      return (
        (await routeStaffAdd(db, update.chatId, decoded.parts, state, deps))
        ?? only(update.chatId, await menuReplyFor(db, update.chatId))
      );
```

Add `routeStaffAdd` to the `./commands/index.js` import list.

- [ ] **Step 8: Run it and watch it pass**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/telegram/commands/staff.integration.test.ts
```

Expected: PASS, 0 failed, the whole file.

- [ ] **Step 9: Commit**

```bash
git add src/telegram/callback-data.ts src/telegram/commands/staff.ts src/telegram/commands/index.ts src/telegram/router.ts src/telegram/commands/staff.integration.test.ts && git commit -m "feat: adding somebody to staff is now a chat id and two taps"
```

---

### Task 10: The sign-in prompt

**Files:**
- Modify: `src/telegram/handlers/menu.ts:101-109`
- Test: `src/telegram/handlers/menu.test.ts` — if the file does not exist, add the test to
  `src/telegram/router.integration.test.ts` instead, beside the existing sign-in assertions

- [ ] **Step 1: Write the failing test**

```typescript
describe('the sign-in prompt', () => {
  const prompt = (): string =>
    signInPromptReply('+998 71 000 0000', { caseDays: 90, urgentCaseDays: 365, messageDays: 30 }).text;

  it('says enter, not reply with', () => {
    expect(prompt()).toContain('Enter your email address');
    expect(prompt().toLowerCase()).not.toContain('reply with');
  });

  it('puts the instruction before the notice, not after it', () => {
    const text = prompt();
    expect(text.indexOf('Enter your email address')).toBeLessThan(text.indexOf('Privacy notice'));
  });

  it('still carries the notice in the same message', () => {
    // The property the current ordering was chosen for: replying is the
    // acknowledgement, so the two cannot be separated by a teacher who scrolled.
    expect(prompt()).toContain('Privacy notice');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/telegram/handlers/
```

Expected: FAIL on the first two.

- [ ] **Step 3: Reorder and reword**

In `src/telegram/handlers/menu.ts`, replace the body of `signInPromptReply`:

```typescript
export function signInPromptReply(supportContact: string, periods: RetentionPeriods): Reply {
  return {
    text:
      'Enter your email address — the one you were recruited with.\n\n' +
      'Sending it means you have read the privacy notice below.\n\n' +
      '— — —\n\n' +
      privacyNotice(supportContact, periods),
  };
}
```

Update the doc comment above it: the notice is still in the same message and still cannot be
separated from the act that acknowledges it, but the instruction now comes first because it was
sitting after the longest message this bot sends. And `"reply with"` read as a Telegram reply, which
is a real thing a teacher can do wrongly.

- [ ] **Step 4: Run it and watch it pass**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/telegram/handlers/ src/telegram/router.integration.test.ts
```

Expected: PASS, 0 failed. **Other tests assert on this prompt's wording** — if one fails, read it:
it is probably asserting the old sentence and should be updated, not deleted.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/handlers/menu.ts src/telegram/handlers/menu.test.ts && git commit -m "fix: the sign-in message asked for a reply and buried the instruction"
```

---

### Task 11: The privacy notice

**Files:**
- Modify: `src/config/privacy.ts`
- Test: `src/config/privacy.test.ts`

**Use the `anthropic-skills:humanizer` skill for the rewrite.** Invoke it, give it the current notice
text, and apply what it returns — then check the two constraints below by hand before running the
tests.

- [ ] **Step 1: Read the existing guards**

```bash
grep -n "asterisk\|days\|source" src/config/privacy.test.ts
```

Two tests protect this file and neither may be weakened:

- **No number of days is typed into the source.** The three retention periods are settings MoPSE can
  change without a deploy, and a hard-coded sentence would silently disagree with the row.
- **No asterisk appears in the notice.** Nothing in this bot has ever turned Telegram formatting on,
  so an asterisk is punctuation a teacher reads.

- [ ] **Step 2: Write the failing test**

Add to `src/config/privacy.test.ts`:

```typescript
it('is at version 2026-08-03.1 after the rewrite', () => {
  expect(PRIVACY_NOTICE_VERSION).toBe('2026-08-03.1');
});

it('still says every one of the things it is required to say', () => {
  const text = privacyNotice('+998 71 000 0000', {
    caseDays: 90,
    urgentCaseDays: 365,
    messageDays: 30,
  });

  // The content is not being changed — only the way it is written. Each of
  // these is a promise the notice makes and none may be lost in a reword.
  expect(text).toContain('email');
  expect(text).toContain('chat id');
  expect(text).toContain('Uzbekistan');
  expect(text).toContain('+998 71 000 0000');
  expect(text).toContain('/privacy');
  expect(text).toMatch(/dispute|someone else tries to sign in/i);
  expect(text).toMatch(/90/);
});
```

- [ ] **Step 3: Run it and watch it fail**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/config/privacy.test.ts
```

Expected: FAIL on the version test only. The content test should pass against the current notice —
if it does not, fix the assertion, because it is describing today's notice wrongly.

- [ ] **Step 4: Rewrite with the humanizer skill, and bump the version**

Invoke `anthropic-skills:humanizer` on the notice body. Keep every heading and every promise. Then:

```typescript
export const PRIVACY_NOTICE_VERSION = '2026-08-03.1';
```

Add to the version's doc comment, in the style of the entries above it:

```
 * `2026-08-03.1` is a rewording and nothing else. The head of project asked for
 * it on 3 August 2026 — *"the core of the message is fine i just don't like the
 * way it is written"* — so what is held, what it is used for, who can see it,
 * how long it is kept and the access route all say the same things afterwards.
 *
 * It still costs a round of re-acceptance from every teacher who has already
 * signed in, which is why it was done in the same pass as the sign-in prompt
 * rather than separately. Eight teachers today; 1,800 after launch.
```

- [ ] **Step 5: Run it and watch it pass**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/config/ src/telegram/reconsent.integration.test.ts
```

Expected: PASS, 0 failed. `reconsent.integration.test.ts` is the file that asserts a version bump
asks teachers again — **it should still pass**, and if it fails, read it before touching it.

- [ ] **Step 6: Commit**

```bash
git add src/config/privacy.ts src/config/privacy.test.ts && git commit -m "fix: the privacy notice said the right things in the wrong words"
```

---

### Task 12: The full verification run

Nothing before this point may claim to be done. **Every fault this project has found was found by
running something.**

- [ ] **Step 1: Regenerate the dependency graph**

```bash
npm run deps
```

- [ ] **Step 2: Check for strays before starting the suite**

```
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*vitest*' }
```

Expected: nothing. If anything is listed, wait for it — **never start a second run while one is
going.**

- [ ] **Step 3: Run the whole suite**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run
```

Expected: **0 failed and 0 skipped.** A run reporting hundreds of skips proved nothing — it means
`TEST_DATABASE_URL` was not set and every integration test was skipped. It takes about five minutes.

- [ ] **Step 4: The other four**

```bash
npm run typecheck
```

```bash
npm run build
```

```bash
npm run lint
```

```bash
npm run deps:check
```

Expected: clean, clean, 0 warnings, silent with exit 0.

- [ ] **Step 5: Commit the regenerated graph**

```bash
git add docs/dependency-tree.md && git commit -m "docs: regenerate the dependency tree"
```

- [ ] **Step 6: Report the numbers plainly**

State the test count, files, failures, skips and seconds, and the result of each of the other four.
Do not round, do not summarise, and do not report a number nobody ran.

---

### Task 13: Correct the documents

Documents are a separate commit from code, and the specification documents are corrected once, at the
end, in one pass.

- [ ] **Step 1: Mark the design as built**

In `docs/plans/2026-08-03-buttons-for-cases-and-staff-design.md`, change the status line to
`**Status: ✅ BUILT — commit <hash>**` and paste the verification numbers from Task 12 under it, in
the format `docs/plans/2026-08-01-login-gating-design.md` uses.

Where building it changed something, **strike the original through and write the correction against
it** rather than writing over the top. A later reader must see what was originally decided and why it
changed.

- [ ] **Step 2: Update the plan of record**

In `docs/plans/2026-08-01-identity-and-urgent-design.md`:

- Part 5G's "What gets a button, and what cannot" — strike through the split and note that it was
  superseded on 3 August, with the reason: the estimate behind it predated Part 5H.3.
- Part 5C "Interactive `/staff_add`" — mark it built.

- [ ] **Step 3: Update `BOT-SPEC.md`**

Add the case menu and the add-somebody flow to §6, beside the typed commands they stand for. Say
plainly that the typed commands all still work.

- [ ] **Step 4: Commit**

```bash
git add docs/ BOT-SPEC.md && git commit -m "docs: the case menu, as built"
```

- [ ] **Step 5: Ask before touching the artifact**

The head of project's summary artifact is at v9 and badly stale. **Ask before spending a session's
remaining budget on it.** If they say yes: `WebFetch` the URL in `CLAUDE.md` §7, strip the frame
wrapper, **edit the remainder rather than rewriting it**, bump the version in four places, update the
metrics row, and pass the same URL as `url` so it updates in place.

---

## What this plan does not do

- **The `/staff` menu itself.** It already does what was asked. Untouched.
- **Removing any typed command.** All fourteen still work.
- **Any database migration**, any capability floor change, any change to who can see what.
- **`"TEST DATA — "`.** It is in the Google Sheet, the bot reads it read-only, and the head of
  project chose to clean the sheet. Design §8 records why there is no code here.
