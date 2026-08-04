# Form areas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MoPSE's four real Google Forms readable, stop retired forms alarming for ever, and let
a teacher raise a complaint and its paperwork together in one place.

**Architecture:** Everything that describes a form stays in the FORMS tab of the spreadsheet, so
MoPSE can change it without a deployment. Three new optional columns — `CATEGORY`, `PREPARE`,
`EMAIL_COLUMN` — give a form a button of its own without giving it a new case category, a queue, a
reference prefix or a retention rule. A submission arriving for a teacher who already has an open
case in that area attaches to it rather than opening a second one.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), grammY, Drizzle over PostgreSQL, Zod,
Vitest against a real database.

**Design of record:** `docs/plans/2026-08-03-form-areas-design.md`. Read it before task 1.

---

## Before you start

Read `CLAUDE.md` in full. Four rules govern every task here:

1. **Layers.** Layer 1 `config/ send.ts callback-data.ts`; layer 2 `cases/ staff/ forms/ sheets/
   sync/ conversation/ db/`; layer 3 `telegram/`. Nothing imports from a layer above it.
2. **Stores must not send.** Layer 2 returns what needs saying; layer 3 sends it.
3. **Comments explain *why*, in prose, at the density of the surrounding file.** `sheets/parse.ts`
   and `sync/form-responses.ts` are unusually discursive on purpose. Match them.
4. **Test-first**, and **migrations are forward-only with no down path.**

### Starting the test database

Assume it is not running — the container has no volume and does not survive a Docker restart.

```bash
docker desktop start && docker compose -f docker-compose.test.yml up -d && docker inspect --format "{{.State.Health.Status}}" mopse-test-postgres-1
```

Wait for `healthy`. Every test command below is run from **PowerShell**:

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run <path>
```

**Never pipe vitest through `head`** — it closes the pipe and the run continues invisibly.
**Never run the full suite until task 11.**

### Three lessons this codebase has already paid for

1. **A test that asserts only a length can be green over nothing.** Assert values.
2. **An assertion that can never fail, or never pass, is broken.** Two refusal messages compared with
   `toBe()` when each echoes its own reference is the example.
3. **Check enum and constant values against the schema before writing a fixture.** `'Submitted'` is
   not a `case_status`.

**When a step you expect to fail passes instead, stop and find out why.**

---

## File structure

| File | Layer | Responsibility |
|---|---|---|
| `src/sheets/parse.ts` | 2 | **Modify.** `FormRow` gains three fields; `findEmailColumn` takes an optional named heading |
| `src/db/schema.ts` | 2 | **Modify.** `form_links` gains three nullable text columns |
| `drizzle/00NN_form_areas.sql` | — | **Create**, via `drizzle-kit generate`. Additive only |
| `src/forms/repository.ts` | 2 | **Modify.** `FormLink` carries the three; `formsWithResponses` filters on `active` |
| `src/sync/sheets-sync.ts` | 2 | **Modify.** `syncForms` writes the three |
| `src/sync/form-responses.ts` | 2 | **Modify.** Named email column; attach to an open case in the area |
| `src/conversation/state.ts` | 2 | **Modify.** `AwaitingFormComplaint` joins the union. No migration |
| `src/telegram/router.ts` | 3 | **Modify.** `chooseDocForm` shows `PREPARE`; the typed message becomes a case |
| `src/cases/notify.ts` | 2 | **Modify.** The new-case notice says whether the form has arrived |
| `RUNBOOK.md` | — | **Modify.** §4.18 |

---

### Task 1: A retired form stops being read

Independent of everything else, and it is the fault the head of project actually reported. **Ship it
first** — it stops the alert noise on the next deploy whatever happens to the rest.

**Files:**
- Modify: `src/forms/repository.ts` (`formsWithResponses`, ~line 74)
- Test: `src/sync/forms.integration.test.ts` (~line 360)

- [ ] **Step 1: Invert the test that asserts today's rule**

`src/sync/forms.integration.test.ts:360` currently reads:

```typescript
    it('still reads a form that staff have switched off', async () => {
      // Its submissions from last night are still somebody's documents.
```

**That test is correct about today's behaviour and is being deliberately reversed.** Replace it with
this, keeping it in the same place:

```typescript
    /**
     * Reversed on 3 August 2026, and the comment it replaces was right.
     *
     * It read: *"Its submissions from last night are still somebody's
     * documents."* That is true, and the head of project chose the other side of
     * it anyway with the cost stated — a form retired at 9am, whose last
     * submission arrived at 11pm the night before and has not yet been swept,
     * loses that submission silently. Nobody is told, not the teacher and not
     * staff.
     *
     * What was bought is that a form retired weeks ago stops raising a critical
     * alert every ten minutes for ever, which is what the old rule did: removing
     * a row from the sheet only marks it inactive, and nothing ever stopped
     * reading it.
     *
     * The habit that mitigates it is in RUNBOOK.md §4.18 — leave a retired
     * form's row on the sheet, with its RESPONSES_TAB intact, for a day after
     * you stop advertising it. That is a process rather than a guarantee, which
     * is exactly why the cost is written here rather than only in the design.
     */
    it('does not read a form that staff have switched off', async () => {
      await syncForms(
        db,
        readerReturning({ FORMS: [FORMS_HEADER, formRow('PASSPORT', 'PASSPORT_RESPONSES', 'FALSE')] }),
      );
      await signedInTeacher('950001', 'a@example.com');

      const report = await syncFormResponses(
        db,
        readerReturning({ PASSPORT_RESPONSES: [RESPONSES_HEADER, submission('a@example.com')] }),
      );
      expect(report.filed).toBe(0);
      expect(report.formsRead).toBe(0);
    });

    /**
     * The other half, and the one that proves this is not simply "read nothing".
     * A form still on the sheet is still read.
     */
    it('reads a form that is still on the sheet', async () => {
      await syncForms(
        db,
        readerReturning({ FORMS: [FORMS_HEADER, formRow('PASSPORT', 'PASSPORT_RESPONSES', 'TRUE')] }),
      );
      await signedInTeacher('950001', 'a@example.com');

      const report = await syncFormResponses(
        db,
        readerReturning({ PASSPORT_RESPONSES: [RESPONSES_HEADER, submission('a@example.com')] }),
      );
      expect(report.filed).toBe(1);
    });
```

Check `formRow`'s signature in that file before assuming the third argument is the active flag. If it
differs, adapt the call and **say so in your report**.

- [ ] **Step 2: Run it and watch the first one fail**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/sync/forms.integration.test.ts -t "switched off"
```

Expected: FAIL — `report.filed` is 1 because the inactive form is still read. The second new test
should already pass.

- [ ] **Step 3: Make the change**

In `src/forms/repository.ts`, `formsWithResponses`. Replace the whole doc comment and the `where`:

```typescript
/**
 * The forms whose responses the bot can read.
 *
 * **Active forms only, since 3 August 2026, and the rule this replaced was not
 * silly.** It ignored `active` deliberately, so that a form switched off this
 * morning still had last night's submissions filed — losing a teacher's
 * documents silently is the failure this whole stage exists to prevent.
 *
 * What sank it is that the rule had no end. Removing a row from the FORMS tab
 * only sets `active = false`; the row stays for ever. So a form retired weeks
 * ago was still read on every sync, its response tab no longer existed, and each
 * failure raised a **critical** alert — for ever, with no way to stop it short
 * of editing the database by hand. That is what the head of project reported.
 *
 * The cost is stated rather than hidden: a submission arriving between the last
 * sweep and the moment a form is retired is now lost silently. The head of
 * project was told that and chose it over a grace period. `RUNBOOK.md` §4.18
 * carries the habit that mitigates it, and a habit is not a guarantee.
 */
export async function formsWithResponses(db: Database): Promise<FormWithResponses[]> {
  const rows = await db
    .select({
      type: formLinks.type,
      buttonText: formLinks.buttonText,
      url: formLinks.url,
      responsesTab: formLinks.responsesTab,
    })
    .from(formLinks)
    .where(and(eq(formLinks.active, true), isNotNull(formLinks.responsesTab)))
    .orderBy(asc(formLinks.sheetRow), asc(formLinks.type));
  return rows.filter((r): r is FormWithResponses => r.responsesTab !== null);
}
```

`and` is already imported in that file. Confirm it.

- [ ] **Step 4: Run it and watch both pass**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/sync/forms.integration.test.ts
```

Expected: 0 failed, the whole file.

- [ ] **Step 5: Commit**

```bash
git add src/forms/repository.ts src/sync/forms.integration.test.ts && git commit -m "fix: a retired form was read, and alarmed, for ever"
```

---

### Task 2: `EMAIL_COLUMN`, held by the headings that caused the fault

**Files:**
- Modify: `src/sheets/parse.ts` (`findEmailColumn`, `parseResponsesTab`)
- Test: `src/sheets/parse.test.ts`

- [ ] **Step 1: Write the failing test, using MoPSE's real headings**

These are verbatim from the four response sheets on 3 August 2026, **including the trailing space on
the emergency-contact heading**. Do not tidy them — they are the data that caused the fault.

Add to `src/sheets/parse.test.ts`:

```typescript
describe('finding the teacher’s email column', () => {
  /**
   * MoPSE's four live forms, as their response sheets actually read on
   * 3 August 2026. Every one has more than one heading containing "email", so
   * every one of them filed nothing at all.
   *
   * Two causes and both are normal. Google's "Collect email addresses" adds an
   * `Email Address` column, and each form also asks for the address as a
   * question. Holiday and Medical then ask for a school contact email and an
   * emergency contact email, which are the right questions to ask.
   *
   * The trailing space on the emergency heading is real. It is kept because a
   * fixture tidied up is a fixture that stops matching the thing it stands for.
   */
  const HOLIDAY = [
    'Timestamp',
    'Email Address',
    'Full name as shown on your Passport',
    'Email address',
    'Emergency email / phone number while on leave ',
    'School contact email or telephone number',
  ];
  const MEDICAL = [
    'Timestamp',
    'Email Address',
    'Full name as shown on your passport',
    'Email address',
    'School contact email or telephone number',
  ];
  const ACCOMMODATION = ['Timestamp', 'Email Address', 'Full Name', 'Email Address'];
  const REIMBURSEMENT = ['Timestamp', 'Email Address', 'Full Name', 'Email Address'];

  it('refuses each of the four real forms when no column is named', () => {
    for (const header of [HOLIDAY, MEDICAL, ACCOMMODATION, REIMBURSEMENT]) {
      expect(() => findEmailColumn('TAB', header, null)).toThrow(EmailColumnError);
    }
  });

  it('finds the named column in each of the four', () => {
    expect(findEmailColumn('TAB', HOLIDAY, 'Email address')).toBe(3);
    expect(findEmailColumn('TAB', MEDICAL, 'Email address')).toBe(3);
    // Both candidates read `Email Address` exactly, so the first is the answer
    // and naming it is the only way to say which was meant.
    expect(findEmailColumn('TAB', ACCOMMODATION, 'Email Address')).toBe(1);
    expect(findEmailColumn('TAB', REIMBURSEMENT, 'Email Address')).toBe(1);
  });

  it('still finds a single unnamed column, so no existing sheet changes meaning', () => {
    expect(findEmailColumn('TAB', ['Timestamp', 'Your email'], null)).toBe(1);
  });

  it('matches a named heading after trimming, and infers nothing else', () => {
    expect(findEmailColumn('TAB', ['Timestamp', '  Email address  '], 'Email address')).toBe(1);
    // Not a substring match: naming a column means naming it.
    expect(() => findEmailColumn('TAB', ['Timestamp', 'Email address'], 'Email')).toThrow(
      EmailColumnError,
    );
  });

  /**
   * The message is the whole value of this branch. A named column that is not
   * there must say what it looked for and what it found, or somebody is left
   * comparing a spreadsheet against a silence.
   */
  it('names the column it wanted and lists the ones that exist', () => {
    try {
      findEmailColumn('LEAVE_RESPONSES', ['Timestamp', 'Email address'], 'E-mail');
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('E-mail');
      expect(message).toContain('Email address');
      expect(message).toContain('LEAVE_RESPONSES');
    }
  });
});
```

Add `findEmailColumn` and `EmailColumnError` to that file's imports if they are not there.

- [ ] **Step 2: Run it and watch it fail**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/sheets/parse.test.ts -t "email column"
```

Expected: FAIL — `findEmailColumn` takes two arguments today, so every call is a type error.

- [ ] **Step 3: Make the change**

In `src/sheets/parse.ts`, replace `findEmailColumn` entirely:

```typescript
/**
 * Which column holds the teacher's own email address.
 *
 * **`named` is the answer when there is one, and the reason it had to exist is
 * that the four real forms all have several.** Google's "Collect email
 * addresses" setting adds a column, each form also asks for the address as a
 * question, and two of them ask for a school contact email and an emergency
 * contact email besides. All four are reasonable questions and all four contain
 * the word.
 *
 * Named columns are matched **exactly, after trimming, and nothing is inferred**
 * — not a substring, not a case-insensitive guess. A convention would be the
 * mistake this whole module avoids: the person who owns the sheet cannot correct
 * a rule they cannot see, and here the rule decides whose documents get filed.
 *
 * With no name, the old behaviour is unchanged: exactly one heading containing
 * the letters `email`, and a refusal otherwise. So no sheet that works today
 * changes meaning, and `EmailColumnError` goes on refusing to guess — which was
 * always right and was never the fault.
 */
export function findEmailColumn(
  tab: string,
  header: readonly string[],
  named: string | null,
): number {
  if (named !== null && named.trim() !== '') {
    const wanted = named.trim();
    const at = header.findIndex((h) => h.trim() === wanted);
    if (at === -1) throw new EmailColumnError(tab, [], wanted, header);
    return at;
  }

  const matches: string[] = [];
  let found = -1;
  header.forEach((name, i) => {
    /**
     * Letters only before the comparison, so "E-mail", "E‑MAIL" and
     * "Your e mail address" all match. A plain `includes('email')` reads the
     * hyphen as a difference and refuses a heading a person would call obviously
     * correct — which would turn the runbook's one simple rule into a trap.
     */
    if (name.toLowerCase().replace(/[^a-z]/g, '').includes('email')) {
      matches.push(name.trim());
      if (found === -1) found = i;
    }
  });
  if (matches.length !== 1) throw new EmailColumnError(tab, matches);
  return found;
}
```

Then replace `EmailColumnError` (currently at `src/sheets/parse.ts:285`) with this. **The
several-columns message changes**, and that is deliberate rather than incidental — see below:

```typescript
export class EmailColumnError extends Error {
  constructor(
    readonly tab: string,
    readonly matches: readonly string[],
    /** The heading `EMAIL_COLUMN` asked for, when it asked for one. */
    readonly wanted?: string,
    /** Every heading in the tab, so the sheet's owner can see what to name. */
    readonly headings?: readonly string[],
  ) {
    super(
      wanted !== undefined
        ? `The "${tab}" tab has no column called "${wanted}", which is what EMAIL_COLUMN names for ` +
          `this form. Its columns are: ${(headings ?? []).map((h) => `"${h.trim()}"`).join(', ')}. ` +
          `Correct EMAIL_COLUMN on the FORMS tab, or rename the question to match. Nothing was filed.`
        : matches.length === 0
          ? `The "${tab}" tab has no column whose heading contains "email", so no submission in it ` +
            `can be matched to a teacher. Add an email question to the form — its title must contain ` +
            `the word "email" — or correct RESPONSES_TAB if this is the wrong tab. Nothing was filed.`
          : `The "${tab}" tab has ${matches.length} columns whose headings contain "email": ` +
            `${matches.join(', ')}. The bot cannot tell which address identifies the teacher, and ` +
            `filing their documents under somebody else is worse than not filing them. ` +
            `Set EMAIL_COLUMN on this form's row in the FORMS tab to the exact heading of the ` +
            `teacher's own address. Nothing was filed.`,
    );
    this.name = 'EmailColumnError';
  }
}
```

**The no-column message is copied verbatim from the current constructor.** Do not reword it.

**The several-columns message is deliberately changed, and leaving it alone would be the mistake.**
It currently ends *"Only one may … Reword the others."* That was the only advice available before
this task and it is now wrong: rewording "School contact email or telephone number" so it stops
containing the word "email" would damage a question that is asking exactly the right thing. The
message has to point at `EMAIL_COLUMN`, or the person reading it does the harmful thing the message
told them to.

**A test asserts this wording.** Find it — search `parse.test.ts` for `Reword` — and update it in the
same commit, keeping what it was protecting: that the message names the tab and lists the offending
headings, so somebody can act on it without opening the spreadsheet twice.

Then thread the argument through `parseResponsesTab`:

```typescript
export function parseResponsesTab(
  tab: string,
  raw: readonly string[][],
  emailColumn: string | null = null,
): ParseResult<ResponseRow> {
  const header = (raw[0] ?? []).map((h) => h.trim());
  const emailAt = findEmailColumn(tab, header, emailColumn);
```

Note the header is already trimmed here, and `findEmailColumn` trims again. That is deliberate
belt-and-braces: this function is called from two places and only one of them trims first.

- [ ] **Step 4: Run and watch it pass**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/sheets/parse.test.ts
```

Expected: 0 failed, the whole file. **If the existing `EmailColumnError` wording test fails, you did
not copy the message verbatim.**

- [ ] **Step 5: Commit**

```bash
git add src/sheets/parse.ts src/sheets/parse.test.ts && git commit -m "feat: a form can name which of its columns is the teacher's email"
```

---

### Task 3: The three new columns, in the sheet and the database

**Files:**
- Modify: `src/sheets/parse.ts` (`FormRow`, `parseFormsTab`), `src/db/schema.ts`
- Create: `drizzle/00NN_form_areas.sql` via `drizzle-kit generate`
- Test: `src/sheets/parse.test.ts`

- [ ] **Step 1: Write the failing test**

`src/sheets/parse.test.ts` already has `FORMS_HEADER` and a `formRow` helper around line 225. Extend
the header and add:

```typescript
describe('the three columns that make a form an area', () => {
  const HEADER = ['TYPE', 'BUTTON_TEXT', 'URL', 'RESPONSES_TAB', 'ACTIVE', 'CATEGORY', 'PREPARE', 'EMAIL_COLUMN'];
  const row = (over: Record<string, string> = {}): string[] => [
    over['TYPE'] ?? 'REIMBURSE',
    over['BUTTON_TEXT'] ?? 'Reimbursement',
    over['URL'] ?? 'https://forms.gle/abc',
    over['RESPONSES_TAB'] ?? 'REIMBURSE_RESPONSES',
    over['ACTIVE'] ?? 'TRUE',
    over['CATEGORY'] ?? 'Travel and Arrival',
    over['PREPARE'] ?? 'Have your receipts ready as one PDF.',
    over['EMAIL_COLUMN'] ?? 'Email Address',
  ];

  it('reads all three', () => {
    const result = parseFormsTab([HEADER, row()]);
    expect(result.rows[0]?.category).toBe('Travel and Arrival');
    expect(result.rows[0]?.prepare).toBe('Have your receipts ready as one PDF.');
    expect(result.rows[0]?.emailColumn).toBe('Email Address');
  });

  it('treats all three as absent when blank', () => {
    const result = parseFormsTab([HEADER, row({ CATEGORY: '', PREPARE: '', EMAIL_COLUMN: '' })]);
    expect(result.rows[0]?.category).toBeNull();
    expect(result.rows[0]?.prepare).toBeNull();
    expect(result.rows[0]?.emailColumn).toBeNull();
  });

  /**
   * A sheet written before this feature must go on working untouched. The three
   * columns are optional in the same way RESPONSES_TAB already is.
   */
  it('does not require any of the three columns to exist at all', () => {
    const old = ['TYPE', 'BUTTON_TEXT', 'URL'];
    const result = parseFormsTab([old, ['DOC', 'Documents', 'https://forms.gle/abc']]);
    expect(result.rejections).toHaveLength(0);
    expect(result.rows[0]?.category).toBeNull();
  });

  /**
   * The rule that stops an area being silently unreachable. It is the same
   * failure a misspelled FAQ topic causes, and it is answered the same way:
   * reject the row with its number, name the real values, and let every other
   * row sync.
   */
  it('rejects a category this build does not have, and keeps the other rows', () => {
    const result = parseFormsTab([
      HEADER,
      row({ TYPE: 'GOOD' }),
      row({ TYPE: 'BAD', CATEGORY: 'Dentistry' }),
    ]);

    expect(result.rows.map((r) => r.type)).toEqual(['GOOD']);
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]?.reason).toContain('Dentistry');
    expect(result.rejections[0]?.reason).toContain('Travel and Arrival');
  });
});
```

- [ ] **Step 2: Run and watch it fail.** Expected: the fields do not exist.

- [ ] **Step 3: Extend `FormRow` and the parser**

In `src/sheets/parse.ts`:

```typescript
export interface FormRow {
  readonly type: string;
  readonly sheetRow: number;
  readonly buttonText: string;
  readonly url: string;
  readonly responsesTab: string | null;
  /**
   * The existing case category a complaint in this area is filed under, or null
   * for `Contact Support`.
   *
   * **A category, never a queue.** `QUEUE_FOR_CATEGORY` already turns one into
   * the other, and naming the queue here would put a second answer to "who works
   * this" beside it. Two answers drift, and the one that drifts is the one
   * nobody was looking at.
   */
  readonly category: string | null;
  /** What to gather, shown above the form link. Null means no such message. */
  readonly prepare: string | null;
  /** The exact heading of the teacher's own email column. See `findEmailColumn`. */
  readonly emailColumn: string | null;
}
```

In `parseFormsTab`, after the existing `responsesTab` read, add the three reads and the category
check. `CASE_CATEGORY` is imported from `../config/constants.js`:

```typescript
    const category = cell(raw_row, headers.get('CATEGORY'));
    const prepare = cell(raw_row, headers.get('PREPARE'));
    const emailColumn = cell(raw_row, headers.get('EMAIL_COLUMN'));

    /**
     * A category nobody has is rejected with its row number rather than filed
     * under something plausible. The Apps Script version let a misspelled
     * category through and the answer was permanently unreachable with nothing
     * reported anywhere — that is the failure this whole parser is shaped
     * around, and a form area is no different from an FAQ row here.
     */
    const categories = Object.values(CASE_CATEGORY) as string[];
    if (category !== '' && !categories.includes(category)) {
      rejections.push({
        row: rowNumber,
        reason: `CATEGORY "${category}" is not an area this bot has, so complaints here would go nowhere. The areas are: ${categories.join(', ')}.`,
        value: type,
      });
      continue;
    }
```

And add the three to the pushed row, each `=== '' ? null : value`.

**Check where `continue` belongs** relative to the existing rejection branches in that loop, and put
this one with them rather than after the row is built.

- [ ] **Step 4: Run and watch it pass.** Whole file, 0 failed.

- [ ] **Step 5: Add the database columns**

In `src/db/schema.ts`, in `formLinks`, after `responsesTab`:

```typescript
    /**
     * The existing case category a complaint in this area files under, or null
     * for `Contact Support`. A cell rather than a constant, so MoPSE can move an
     * area between queues without a deployment.
     */
    category: text('category'),
    /** What a teacher is told to gather, shown above the form link. */
    prepare: text('prepare'),
    /** Which column of the response tab holds the teacher's own address. */
    emailColumn: text('email_column'),
```

```bash
npx drizzle-kit generate
```

**Read the generated SQL before accepting it.** It must contain three `ADD COLUMN` statements and
nothing else — drizzle has emitted a destructive `DROP TYPE` in this project once. Then rename the
file to the existing convention and change the `tag` in `drizzle/meta/_journal.json` to match.

- [ ] **Step 6: Commit**

```bash
git add src/sheets/parse.ts src/sheets/parse.test.ts src/db/schema.ts drizzle/ && git commit -m "feat: a form row can name its area, its paperwork and its email column"
```

---

### Task 4: Carry the three through the sync and the repository

**Files:**
- Modify: `src/sync/sheets-sync.ts` (`syncForms`), `src/forms/repository.ts`
- Modify: `src/sync/form-responses.ts` (pass the named column)
- Test: `src/sync/forms.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('carries the area, the paperwork and the email column into the database', async () => {
  await syncForms(
    db,
    readerReturning({
      FORMS: [
        ['TYPE', 'BUTTON_TEXT', 'URL', 'RESPONSES_TAB', 'ACTIVE', 'CATEGORY', 'PREPARE', 'EMAIL_COLUMN'],
        ['REIMBURSE', 'Reimbursement', 'https://forms.gle/abc', 'REIMBURSE_RESPONSES', 'TRUE',
         'Travel and Arrival', 'Have your receipts ready.', 'Email Address'],
      ],
    }),
  );

  const rows = await db.select().from(schema.formLinks);
  expect(rows[0]?.category).toBe('Travel and Arrival');
  expect(rows[0]?.prepare).toBe('Have your receipts ready.');
  expect(rows[0]?.emailColumn).toBe('Email Address');
});

/**
 * The fault this whole feature started from, end to end: a real response tab
 * with two email columns files nothing until one is named, and files normally
 * once it is.
 */
it('files a submission from a tab with two email columns, once one is named', async () => {
  await syncForms(
    db,
    readerReturning({
      FORMS: [
        ['TYPE', 'BUTTON_TEXT', 'URL', 'RESPONSES_TAB', 'ACTIVE', 'EMAIL_COLUMN'],
        ['ACCOM', 'Accommodation', 'https://forms.gle/abc', 'ACCOM_RESPONSES', 'TRUE', 'Email address'],
      ],
    }),
  );
  await signedInTeacher('950001', 'a@example.com');

  const report = await syncFormResponses(
    db,
    readerReturning({
      ACCOM_RESPONSES: [
        ['Timestamp', 'Email Address', 'Full Name', 'Email address'],
        ['t', 'personal@gmail.com', 'A Teacher', 'a@example.com'],
      ],
    }),
  );

  expect(report.filed).toBe(1);
});
```

- [ ] **Step 2: Run and watch both fail.**

- [ ] **Step 3: Carry them through**

In `src/sync/sheets-sync.ts`, `syncForms`, add the three to both the `values(...)` mapping and the
`onConflictDoUpdate` `set`. **Both, or a column updates on insert and never again** — the existing
fields show the pattern, `sql\`excluded.column_name\``.

In `src/forms/repository.ts`, add `category`, `prepare` and `emailColumn` to the `FormLink` interface
and to the three `select({...})` calls. `FormWithResponses` inherits them.

In `src/sync/form-responses.ts`, pass the named column through:

```typescript
      const parsed = parseResponsesTab(form.responsesTab, raw, form.emailColumn);
```

- [ ] **Step 4: Run and watch both pass.**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/sync/ src/forms/
```

Expected: 0 failed.

- [ ] **Step 5: Commit**

```bash
git add src/sync/ src/forms/ && git commit -m "feat: MoPSE's four real forms can now be read"
```

---

### Task 5: A submission joins the complaint it belongs to

**Files:**
- Modify: `src/sync/form-responses.ts`
- Test: `src/sync/forms.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe('a submission joins an open complaint in its own area', () => {
  it('attaches to the case the teacher already opened, rather than opening a second', async () => {
    await syncForms(
      db,
      readerReturning({
        FORMS: [
          ['TYPE', 'BUTTON_TEXT', 'URL', 'RESPONSES_TAB', 'ACTIVE', 'CATEGORY'],
          ['ACCOM', 'Accommodation', 'https://forms.gle/a', 'ACCOM_RESPONSES', 'TRUE', 'Accommodation'],
        ],
      }),
    );
    await signedInTeacher('950001', 'a@example.com');

    // The teacher's own complaint, filed by typing.
    const opened = await createCase(db, {
      chatId: '950001',
      category: 'Accommodation',
      detail: 'the boiler has not worked since I arrived',
      formType: 'ACCOM',
    });

    await syncFormResponses(
      db,
      readerReturning({ ACCOM_RESPONSES: [RESPONSES_HEADER, submission('a@example.com')] }),
    );

    const cases = await db.select().from(schema.cases);
    expect(cases).toHaveLength(1);
    expect(cases[0]?.reference).toBe(opened.reference);
    expect(cases[0]?.awaitingForm).toBe(false);

    const notes = await db.select().from(schema.caseNotes);
    expect(notes.some((n) => n.body.includes('submission'))).toBe(true);
  });

  /**
   * The area is part of the match, not just the teacher. A reimbursement package
   * must not land on an accommodation complaint.
   */
  it('does not attach to an open case in a different area', async () => {
    await syncForms(
      db,
      readerReturning({
        FORMS: [
          ['TYPE', 'BUTTON_TEXT', 'URL', 'RESPONSES_TAB', 'ACTIVE', 'CATEGORY'],
          ['ACCOM', 'Accommodation', 'https://forms.gle/a', 'ACCOM_RESPONSES', 'TRUE', 'Accommodation'],
        ],
      }),
    );
    await signedInTeacher('950001', 'a@example.com');
    await createCase(db, {
      chatId: '950001',
      category: 'Travel and Arrival',
      detail: 'my flight money',
      formType: 'REIMBURSE',
    });

    await syncFormResponses(
      db,
      readerReturning({ ACCOM_RESPONSES: [RESPONSES_HEADER, submission('a@example.com')] }),
    );

    expect(await db.select().from(schema.cases)).toHaveLength(2);
  });

  it('still opens a case for a teacher who submits without writing anything', async () => {
    await syncForms(
      db,
      readerReturning({
        FORMS: [
          ['TYPE', 'BUTTON_TEXT', 'URL', 'RESPONSES_TAB', 'ACTIVE', 'CATEGORY'],
          ['ACCOM', 'Accommodation', 'https://forms.gle/a', 'ACCOM_RESPONSES', 'TRUE', 'Accommodation'],
        ],
      }),
    );
    await signedInTeacher('950001', 'a@example.com');

    const report = await syncFormResponses(
      db,
      readerReturning({ ACCOM_RESPONSES: [RESPONSES_HEADER, submission('a@example.com')] }),
    );

    expect(report.filed).toBe(1);
    expect(await db.select().from(schema.cases)).toHaveLength(1);
  });
});
```

This test needs two things that do not exist yet: `cases.awaiting_form` and `createCase` accepting a
`formType`. Both are added in this task.

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Add the two case columns**

In `src/db/schema.ts`, in `cases`:

```typescript
    /**
     * The form area this case was raised in, or null for a case raised any other
     * way. Not a foreign key to `form_links`: an area MoPSE retires must not take
     * the cases raised under it with it, and `form_submissions` already keeps its
     * `form_type` for the same reason.
     */
    formType: text('form_type'),
    /**
     * Raised in a form area, and the paperwork has not arrived.
     *
     * Written true when a teacher writes their complaint, cleared when their
     * submission turns up. It is what lets staff be told **immediately** and
     * still know the difference — the head of project chose telling them at once
     * over waiting to see whether a form followed, because a complaint invisible
     * to staff while the teacher believes it is being handled is the worse
     * failure.
     */
    awaitingForm: boolean('awaiting_form').notNull().default(false),
```

```bash
npx drizzle-kit generate
```

**Read the SQL.** Two `ADD COLUMN`, nothing else. Rename it and update `_journal.json`.

- [ ] **Step 4: Accept `formType` in `createCase`**

In `src/cases/service.ts`, add `formType?: string` to `CreateCaseRequest` and write it, with
`awaitingForm` set to `formType !== undefined`. **Leave the de-duplication read exactly as it is** —
it matches on chat, category and window, and adding the area to it would let one teacher open two
cases in the same category inside the window by using two areas.

- [ ] **Step 5: Attach rather than create**

In `src/sync/form-responses.ts`, in the loop, before the `createCase` call, look for an open case in
the same area for that teacher. Use `sql` through drizzle's query builder, not `db.execute` — the raw
path returns a `timestamptz` as a **string**, and there is no reason to take that trap here.

```typescript
        /**
         * The complaint this package belongs to, if the teacher wrote one.
         *
         * **Matched on the area as well as the teacher.** A teacher may have an
         * open accommodation complaint and an open reimbursement complaint at
         * once, and putting the reimbursement package on the accommodation case
         * is the kind of wrong that looks right on every screen.
         *
         * Newest first, because a teacher who raised the same complaint twice
         * means the later one.
         */
        const open = await tx
          .select({ reference: cases.reference })
          .from(cases)
          .where(
            and(
              eq(cases.teacherChatId, match.chatId),
              eq(cases.formType, form.type),
              inArray(cases.status, [...OPEN_CASE_STATUSES]),
            ),
          )
          .orderBy(desc(cases.createdAt))
          .limit(1);
```

If there is one: `addNote` recording the submission and its sheet row, set `awaitingForm` false, and
`mark` the row `FILED` — **all inside the same transaction as the marker**, for the reason that block
already states: two writes with a crash between them files the same submission again ten minutes
later.

If there is not, call `createCase` exactly as today.

**`OPEN_CASE_STATUSES` is exported from `../db/schema.js`, not from `cases/status.js`** — check the
import before assuming. `desc` comes from `drizzle-orm` and may not be imported in this file yet.

- [ ] **Step 6: Run and watch the three pass.**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/sync/ src/cases/
```

- [ ] **Step 7: Commit**

```bash
git add -A src/ drizzle/ && git commit -m "feat: a form submission joins the complaint it belongs to"
```

---

### Task 6: The teacher writes their complaint

**Files:**
- Modify: `src/conversation/state.ts`, `src/telegram/router.ts`
- Test: `src/telegram/handlers/faq.integration.test.ts` or a new forms router test

- [ ] **Step 1: Add the state**

In `src/conversation/state.ts`, in the union:

```typescript
  /**
   * Shown a form area's paperwork and its link, and now writing the complaint
   * that goes with it.
   *
   * The area is held rather than the case, because there is no case yet — the
   * message they are about to type is what creates it. It expires with
   * everything else, and a teacher who wanders off simply files nothing, which
   * is the right outcome for an unfinished sentence.
   */
  z.object({ kind: z.literal('AwaitingFormComplaint'), formType: z.string() }),
```

No migration.

- [ ] **Step 2: Write the failing test**

```typescript
it('shows the paperwork, the link, and files what the teacher then writes', async () => {
  // Seed a form area with PREPARE and CATEGORY, sign a teacher in, then:
  const shown = await send({
    chatId: TEACHER,
    kind: 'callback',
    text: encodeCallback(CALLBACK.DOC_TYPE, 'REIMBURSE'),
  });
  expect(shown.messages[0]?.text).toContain('Have your receipts ready');
  expect(shown.messages[0]?.text).toContain('forms.gle');

  const filed = await send({
    chatId: TEACHER,
    kind: 'text',
    text: 'the embassy charged me twice for the visa',
  });
  expect(filed.messages[0]?.text).toMatch(/[A-Z]+-2026-\d{5}/);

  const rows = await db.select().from(schema.cases);
  expect(rows[0]?.category).toBe('Travel and Arrival');
  expect(rows[0]?.formType).toBe('REIMBURSE');
  expect(rows[0]?.awaitingForm).toBe(true);
});
```

Build the fixture from the neighbouring integration tests in that directory rather than inventing
one.

- [ ] **Step 3: Change `chooseDocForm`**

It currently returns the link. It now returns `PREPARE` (when there is one), the link, and a line
asking for the message, and the router saves `AwaitingFormComplaint`.

Then in `routeText`'s state switch, `AwaitingFormComplaint` files the case through `createCase` with
the area's category and `formType`, and clears the state. **Route it through the same helper
`AwaitingCaseDetail` uses** rather than writing a second filing path — the attempt counter, the
length guard and the confirmation wording are all there already.

The area is re-read from the database at the moment the message arrives, not trusted from the state:
a form withdrawn while the teacher was typing must not still file under it.

- [ ] **Step 4: Run, then commit**

```bash
git add -A src/ && git commit -m "feat: a complaint and its paperwork are raised in one place"
```

---

### Task 7: Staff are told whether the paperwork is in

**Files:**
- Modify: `src/cases/notify.ts`
- Test: `src/cases/notify.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/cases/notify.integration.test.ts`, matching that file's existing fixture style:

```typescript
describe('a complaint raised in a form area', () => {
  it('tells staff the paperwork has not arrived yet', async () => {
    // Build a case with formType 'REIMBURSE' and awaitingForm true, using this
    // file's existing helper for seeding a case and its staff recipient.
    const notices = await newCaseNotices(db);
    const body = notices[0]?.text ?? '';

    expect(body).toContain('Reimbursement');
    expect(body).toMatch(/form has not arrived|no paperwork yet/i);
  });

  it('says nothing about paperwork on a case raised any other way', async () => {
    // Same, with formType null and awaitingForm false.
    const notices = await newCaseNotices(db);
    expect(notices[0]?.text ?? '').not.toMatch(/paperwork|form has not arrived/i);
  });
});
```

**Read the file first and use its real helper names** — `newCaseNotices` is a stand-in for whatever
it actually calls the function that produces the notices. Say in your report if it differs.

- [ ] **Step 2: Add the line**

The notice gains one line, and only when `formType` is not null:

```typescript
      row.awaitingForm
        ? `📄 ${row.buttonText} — the form has not arrived yet. The teacher was given the link.`
        : `📄 ${row.buttonText} — the form has been submitted.`,
```

`buttonText` means joining `form_links` on `cases.form_type`. **A left join, not an inner one**: an
area MoPSE retires must not make its existing cases stop notifying, and `form_type` is deliberately
not a foreign key for that reason. Fall back to the raw `form_type` when the join finds nothing.

**`notify.ts` reads through `db.execute`, so a `timestamptz` comes back as a string, not a `Date`.**
You are adding a boolean and two text values, so the trap does not bite here — but do not add a
timestamp to this query without reading the file's header first, and never type a raw row's column
as `Date`.

- [ ] **Step 3: Run, then commit**

```bash
git add src/cases/notify.ts src/cases/notify.integration.test.ts && git commit -m "feat: the new-case notice says whether the paperwork arrived"
```

---

### Task 8: The runbook

**Files:** Modify `RUNBOOK.md` §4.18

- [ ] **Step 1: Write the section**

Cover: the eight FORMS columns with an example row per real form; the recommended
area-to-category mapping; how to find the exact `EMAIL_COLUMN` heading (open the response sheet and
copy the heading, including any trailing space); **and the retirement habit** —

> Leave a retired form's row on the sheet, with its `RESPONSES_TAB` intact, for a day after you stop
> telling teachers about it. The bot stops reading a form the moment it leaves the sheet, so a
> submission that arrives after you remove it is never filed and nobody is told.

- [ ] **Step 2: Commit**

```bash
git add RUNBOOK.md && git commit -m "docs: how to add a form area, and how to retire one safely"
```

---

### Task 9: The full verification run

Nothing before this may claim to be done.

- [ ] **Step 1: Regenerate the graph**

```bash
npm run deps
```

- [ ] **Step 2: Check for strays**

```
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*vitest*' }
```

Expected: nothing.

- [ ] **Step 3: The suite**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run
```

Expected: **0 failed and 0 skipped.** Hundreds of skips means `TEST_DATABASE_URL` was not set and the
run proved nothing.

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

- [ ] **Step 5: Commit the graph and report every number plainly.**

```bash
git add docs/dependency-tree.md && git commit -m "docs: regenerate the dependency tree"
```

---

### Task 10: Correct the documents

- [ ] Mark the design `✅ BUILT` with the verification numbers, in the format
  `2026-08-03-buttons-for-cases-and-staff-design.md` uses. Strike through what changed while building
  rather than writing over it.
- [ ] Add the form areas to `BOT-SPEC.md`.
- [ ] **Ask before touching the artifact.**

```bash
git add docs/ BOT-SPEC.md && git commit -m "docs: form areas, as built"
```

---

## What this plan does not do

- **No new case category.** Holiday Leave and Medical Leave are buttons over existing areas.
- **No deletion from `form_links`.** The retired test rows stay as history and go quiet.
- **No change to how a teacher reaches Submit Documents**, or to the two gates in front of it.
- **Nothing about the four forms' own contents.** MoPSE owns those, and the API access for their
  sheets was still outstanding on 3 August 2026.
