# MoPSE's live forms — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MoPSE's three live Google Forms readable — each one's answers sit in its own
spreadsheet, and two of them have two columns headed identically — and separate "what to gather"
from "ask the teacher to write".

**Architecture:** One new optional column on the FORMS tab names the spreadsheet a form's answers
are in; blank keeps today's behaviour. `EMAIL_COLUMN` gains a second resolution step — a column
letter — tried only when no heading matches exactly. `CATEGORY` becomes the switch that decides
whether a form asks the teacher to describe their problem, freeing `PREPARE` to mean only what it
says.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), grammY, Drizzle over PostgreSQL, Zod,
Vitest against a real database.

**Design of record:** `docs/plans/2026-08-06-live-forms-design.md`. Read it before task 1.

---

## ⚠️ Corrections made on 6 August 2026, before execution

Three things in the plan below were checked against the code and against a later instruction from the
head of project, and are wrong as written. **These corrections win wherever they disagree with the
task text.**

1. **The migration is `0015_form_responses_sheet`, not `0014`.** ~~`drizzle/0014_form_responses_sheet.sql`~~
   `drizzle/0015_form_responses_sheet.sql`. `0014_pre_urgent_status` already exists and is applied on
   the live server; reusing the number would either be skipped as already-run or collide in the
   journal. Every mention of `0014` in task 3 and in the file-structure table means `0015`.

2. **Two forms go live, not three.** The head of project's instruction on 6 August: *"accomodation,
   and travel and visa reimbursements these are what we need atm"*. ~~Medical Leave~~ is deferred.
   Task 7 step 2 writes **two** rows, `ACCOM` and `REIMBURSE`. The Medical Leave row, its spreadsheet
   id and its `PREPARE` draft stay in this document for when it is wanted, and are not written to the
   sheet now.

3. **Task 3's forced sync deactivates three of three, not two of three.** Task 7 step 3's arithmetic
   assumed `MEDICAL` was reused and would upsert. It is not being written any more, so all three
   existing rows (`PASSPORT`, `DIPLOMA`, `MEDICAL`) deactivate at once — a 100% removal. The
   `--force` override is still the answer and is still recorded on the sync run; only the number in
   the explanation changes.

**Task 4 is still built.** Its switch — a category, not preparation notes, is what makes a form ask
the teacher to write — is the right rule whether or not a live form uses the quiet path today. With
Medical Leave deferred, no production row exercises the no-category branch, so its tests are the only
thing holding it. Say so rather than assuming the sheet will show it.

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
**Never run the full suite until task 6.**

### The live values these tasks use

Real, and checked on 6 August 2026. The spreadsheet ids are not secret — access is granted by
sharing, not by knowing the id.

| Form | Spreadsheet id | Tab |
|---|---|---|
| Accommodation | `11qaIcRFkRqGYS_eM_Sxhe9ULD1A7cFw-DnRmiyTYFNU` | `Form Responses 1` |
| Reimbursement | `17_GGERVyIH0qu7quWZJG7vwWgKiUcRUU27lq_vqDHwA` | `Form Responses 1` |
| Medical Leave | `15f3w5ZQqD7EIfxs_wOUZcvANYCz6BAxemRSKl8qJodI` | `Form Responses 1` |

**When a step you expect to fail passes instead, stop and find out why.**

---

## File structure

| File | Layer | Responsibility |
|---|---|---|
| `src/sheets/parse.ts` | 2 | **Modify.** `findEmailColumn` resolves a column letter; `FormRow` gains `responsesSheetId` |
| `src/sheets/client.ts` | 2 | **Modify.** `readTab` takes an optional spreadsheet id |
| `src/db/schema.ts` | 2 | **Modify.** `form_links` gains `responses_sheet_id` |
| `drizzle/0014_form_responses_sheet.sql` | — | **Create**, via `drizzle-kit generate`. Additive only |
| `src/forms/repository.ts` | 2 | **Modify.** `FormLink` carries `responsesSheetId` |
| `src/sync/sheets-sync.ts` | 2 | **Modify.** `syncForms` writes it |
| `src/sync/form-responses.ts` | 2 | **Modify.** Passes the spreadsheet id to the reader |
| `src/telegram/router.ts` | 3 | **Modify.** `chooseDocForm` keys the prompt off `category` |
| `RUNBOOK.md` | — | **Modify.** §4.18 |

---

### Task 1: `EMAIL_COLUMN` accepts a column letter

Independent of everything else and the smallest piece. It is fault B — two of the three live forms
have two columns headed exactly `Email Address`, so no heading can pick between them.

**Files:**
- Modify: `src/sheets/parse.ts` (`findEmailColumn`, `EmailColumnError`)
- Test: `src/sheets/parse.test.ts`

- [x] **Step 1: Write the failing tests**

Add to `src/sheets/parse.test.ts`, inside the existing `describe('finding the teacher’s email
column', …)` block:

```typescript
  /**
   * MoPSE's Accommodation and Reimbursement sheets, verbatim on 6 August 2026.
   * B and D are the SAME STRING — Google's "Collect email addresses" adds B, and
   * the form asks the question again as D. No heading can pick between them, and
   * D is the one the teacher typed.
   */
  const DUPLICATE = ['Timestamp', 'Email Address', 'Full Name', 'Email Address'];

  it('resolves a column letter when two headings are identical', () => {
    expect(findEmailColumn('TAB', DUPLICATE, 'D')).toBe(3);
    expect(findEmailColumn('TAB', DUPLICATE, 'B')).toBe(1);
    expect(findEmailColumn('TAB', DUPLICATE, 'A')).toBe(0);
  });

  it('accepts a lowercase letter and surrounding space', () => {
    expect(findEmailColumn('TAB', DUPLICATE, ' d ')).toBe(3);
  });

  it('resolves a two-letter column', () => {
    const wide = Array.from({ length: 30 }, (_, i) => `Q${i}`);
    // AA is the 27th column, index 26.
    expect(findEmailColumn('TAB', wide, 'AA')).toBe(26);
  });

  /**
   * A heading always wins. Naming a real column can never be overridden by a
   * coincidence of spelling, which is what makes the letter form safe to add.
   */
  it('prefers a real heading over reading the same text as a letter', () => {
    expect(findEmailColumn('TAB', ['Timestamp', 'D', 'Email Address'], 'D')).toBe(1);
  });

  it('refuses a letter past the end of the header, naming the width', () => {
    try {
      findEmailColumn('ACCOM_RESPONSES', DUPLICATE, 'Z');
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('Z');
      expect(message).toContain('ACCOM_RESPONSES');
      expect(message).toContain('4');
    }
  });

  /**
   * Not a letter and not a heading is the ordinary mistake, and the message must
   * not start talking about columns the operator never mentioned.
   */
  it('still reports an unmatched heading as an unmatched heading', () => {
    try {
      findEmailColumn('TAB', DUPLICATE, 'E-mail');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('E-mail');
      expect((err as Error).message).toContain('EMAIL_COLUMN');
    }
  });
```

- [x] **Step 2: Run it and watch it fail**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/sheets/parse.test.ts -t "column letter"
```

Expected: FAIL — `findEmailColumn('TAB', DUPLICATE, 'D')` throws `EmailColumnError`, because `D` is
matched as a heading and no heading reads `D`.

- [x] **Step 3: Add the letter resolution**

In `src/sheets/parse.ts`, add this above `findEmailColumn`:

```typescript
/**
 * `A` → 0, `B` → 1, `AA` → 26. Null when the text is not a column reference.
 *
 * Spreadsheet columns are what a person reading the sheet actually sees along
 * the top, which is why the letter form is the one offered rather than a number:
 * "the fourth column" and "column D" are the same fact, and only one of them is
 * printed on the screen they are looking at.
 */
function columnLetterToIndex(value: string): number | null {
  const text = value.trim().toUpperCase();
  if (!/^[A-Z]{1,2}$/.test(text)) return null;
  let index = 0;
  for (const ch of text) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}
```

Then replace the `named` branch inside `findEmailColumn` with:

```typescript
  if (named !== null && named.trim() !== '') {
    const wanted = named.trim();

    /**
     * A heading is tried first and always wins.
     *
     * That order is the whole safety of the letter form: a tab with a column
     * genuinely headed "D" resolves to that column, so naming a real heading can
     * never be silently overridden by a coincidence of spelling. The letter is
     * only ever reached when nothing in the tab is called that.
     */
    const byHeading = header.findIndex((h) => h.trim() === wanted);
    if (byHeading !== -1) return byHeading;

    /**
     * Then the letter, which exists because two of MoPSE's three live forms have
     * two columns headed exactly `Email Address`. Google's "Collect email
     * addresses" setting adds one and the form asks the question again as
     * another, so the headings are the same string and no name can pick between
     * them. The teacher's own answer is the second, and a letter is the only
     * thing that says so.
     */
    const byLetter = columnLetterToIndex(wanted);
    if (byLetter !== null) {
      if (byLetter >= header.length) {
        throw new EmailColumnError(tab, [], wanted, header, 'past-end');
      }
      return byLetter;
    }

    throw new EmailColumnError(tab, [], wanted, header);
  }
```

- [x] **Step 4: Extend the error message**

Replace `EmailColumnError`'s constructor signature and its `wanted` branch:

```typescript
export class EmailColumnError extends Error {
  constructor(
    readonly tab: string,
    readonly matches: readonly string[],
    /** The heading `EMAIL_COLUMN` asked for, when it asked for one. */
    readonly wanted?: string,
    /** Every heading in the tab, so the sheet's owner can see what to name. */
    readonly headings?: readonly string[],
    /** Set when `wanted` was a valid column letter beyond the tab's width. */
    readonly why?: 'past-end',
  ) {
    super(
      wanted !== undefined
        ? why === 'past-end'
          ? `EMAIL_COLUMN for this form is "${wanted}", but the "${tab}" tab only has ` +
            `${(headings ?? []).length} columns, so there is no such column. Count the columns ` +
            `along the top of the responses sheet and use the letter of the one holding the ` +
            `teacher's own email address. Nothing was filed.`
          : `The "${tab}" tab has no column called "${wanted}", which is what EMAIL_COLUMN names ` +
            `for this form. Its columns are: ${(headings ?? []).map((h) => `"${h.trim()}"`).join(', ')}. ` +
            `Correct EMAIL_COLUMN on the FORMS tab — either the exact heading, or a column letter ` +
            `such as D. Nothing was filed.`
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

**The two messages that already existed are unchanged.** Tests assert their wording — see
`parse.test.ts` for `Reword`, `worse than not filing them` and `RESPONSES_TAB`.

- [x] **Step 5: Run the whole file and watch it pass**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/sheets/parse.test.ts
```

Expected: 0 failed.

- [x] **Step 6: Commit**

```bash
git add src/sheets/parse.ts src/sheets/parse.test.ts && git commit -m "feat: EMAIL_COLUMN can name a column by its letter"
```

---

### Task 2: `readTab` can read another spreadsheet

**Files:**
- Modify: `src/sheets/client.ts` (`SheetReader`, `createSheetReader`)
- Test: `src/sheets/client.test.ts` — **create if absent**

- [x] **Step 1: Write the failing test**

Check whether `src/sheets/client.test.ts` exists. If it does, add to it; if not, create it with this
whole content. `createSheetReader` calls `fetch` and mints a JWT, so the test asserts the URL that is
built rather than a live call — the credential path is not what changed.

```typescript
/**
 * The URL `readTab` builds.
 *
 * Worth its own test for one reason: which spreadsheet a form's answers are read
 * from is now a value from the sheet rather than a constant, and getting it
 * wrong reads somebody else's spreadsheet or none at all. The credentials path
 * is unchanged and is not what this covers.
 */
import { describe, expect, it } from 'vitest';
import { spreadsheetValuesUrl } from './client.js';

describe('which spreadsheet a tab is read from', () => {
  const MAIN = 'MAIN_SHEET_ID';

  it('reads from the configured spreadsheet when no other is named', () => {
    const url = spreadsheetValuesUrl(MAIN, null, 'ROSTER');
    expect(url).toContain('/spreadsheets/MAIN_SHEET_ID/');
    expect(url).toContain('/values/ROSTER');
  });

  it('reads from the form’s own spreadsheet when one is named', () => {
    const url = spreadsheetValuesUrl(MAIN, 'FORM_SHEET_ID', 'Form Responses 1');
    expect(url).toContain('/spreadsheets/FORM_SHEET_ID/');
    expect(url).not.toContain('MAIN_SHEET_ID');
  });

  /**
   * A tab name with a space is the normal case here — every one of MoPSE's live
   * forms writes to a tab called "Form Responses 1" — and an unencoded space
   * makes Google reject the whole request.
   */
  it('encodes a tab name containing spaces', () => {
    const url = spreadsheetValuesUrl(MAIN, null, 'Form Responses 1');
    expect(url).toContain('Form%20Responses%201');
    expect(url).not.toMatch(/values\/Form Responses/);
  });

  it('keeps the render options that stop a locale rewriting values', () => {
    const url = spreadsheetValuesUrl(MAIN, null, 'FAQ');
    expect(url).toContain('valueRenderOption=UNFORMATTED_VALUE');
    expect(url).toContain('dateTimeRenderOption=FORMATTED_STRING');
  });
});
```

- [x] **Step 2: Run it and watch it fail**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/sheets/client.test.ts
```

Expected: FAIL — `spreadsheetValuesUrl` does not exist.

- [x] **Step 3: Extract the URL builder and widen the interface**

In `src/sheets/client.ts`, add above `createSheetReader`:

```typescript
/**
 * The values URL for one tab, of one spreadsheet.
 *
 * Exported so it can be tested without credentials or a network. `override` is
 * the spreadsheet a form's own row names; null means the configured one, which
 * is what every caller but the response sync passes.
 */
export function spreadsheetValuesUrl(
  configuredId: string,
  override: string | null,
  tab: string,
): string {
  const sheetId = override ?? configuredId;
  return (
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
    `/values/${encodeURIComponent(tab)}` +
    // UNFORMATTED_VALUE keeps a locale from turning a date or a number into
    // something we then have to parse back. FORMATTED_STRING on the wire
    // would also silently apply the sheet's display formatting.
    `?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`
  );
}
```

Then change the interface:

```typescript
export interface SheetReader {
  /**
   * Every cell of one tab, as rows of strings. Row 0 is the header.
   *
   * `spreadsheetId` names the spreadsheet to read from, and is optional because
   * only the response sync ever needs it. Google's default when a form is linked
   * to Sheets is a **new** spreadsheet, so each of MoPSE's live forms keeps its
   * answers in a file of its own — the FAQ, the roster and the forms list are
   * all in the configured one and pass nothing.
   */
  readTab(tab: string, spreadsheetId?: string | null): Promise<string[][]>;
}
```

And in `createSheetReader`, replace the signature and the `url` construction:

```typescript
    async readTab(tab: string, spreadsheetId: string | null = null): Promise<string[][]> {
      const configured = env().GOOGLE_SHEET_ID;
      if (!configured && spreadsheetId === null) {
        throw new SheetsConfigurationError('GOOGLE_SHEET_ID is not set, so there is nothing to sync from.');
      }
      const { email, key } = credentials();
      const auth = new JWT({ email, key, scopes: [SCOPE] });
      const token = await auth.getAccessToken();
      if (!token.token) {
        throw new SheetsConfigurationError('Google refused an access token for the service account.');
      }

      const url = spreadsheetValuesUrl(configured ?? '', spreadsheetId, tab);
```

Leave the `!response.ok` branch alone except to name the spreadsheet, which is now a variable and is
the likeliest thing to be wrong:

```typescript
        throw new Error(
          `Google Sheets returned ${response.status} for tab "${tab}"` +
            (spreadsheetId === null ? '' : ` in spreadsheet ${spreadsheetId}`) + `. ` +
            `Check the sheet id and that the service account has Viewer access. ${body.slice(0, 300)}`,
        );
```

- [x] **Step 4: Run and watch it pass.** Whole file, 0 failed.

- [x] **Step 5: Commit**

```bash
git add src/sheets/client.ts src/sheets/client.test.ts && git commit -m "feat: a tab can be read from a spreadsheet other than the configured one"
```

---

### Task 3: `RESPONSES_SHEET_ID`, from the sheet to the reader

**Files:**
- Modify: `src/sheets/parse.ts` (`FormRow`, `parseFormsTab`), `src/db/schema.ts`,
  `src/forms/repository.ts`, `src/sync/sheets-sync.ts`, `src/sync/form-responses.ts`
- Create: `drizzle/0014_form_responses_sheet.sql` via `drizzle-kit generate`
- Test: `src/sheets/parse.test.ts`, `src/sync/forms.integration.test.ts`

- [x] **Step 1: Write the failing parse test**

Add to the `describe('the three columns that make a form an area', …)` block in
`src/sheets/parse.test.ts`. That block already has an eight-column `HEADER` and a `row()` helper
returning eight values. **Leave both alone** — these tests extend them per-test instead, so the
existing tests in that block keep proving that the column is genuinely optional.

```typescript
  it('reads the spreadsheet a form’s answers live in', () => {
    const header = [...HEADER, 'RESPONSES_SHEET_ID'];
    const result = parseFormsTab([header, [...row(), 'SHEET_ABC']]);
    expect(result.rows[0]?.responsesSheetId).toBe('SHEET_ABC');
  });

  it('treats a blank spreadsheet id as “the main one”', () => {
    const header = [...HEADER, 'RESPONSES_SHEET_ID'];
    const result = parseFormsTab([header, [...row(), '']]);
    expect(result.rows[0]?.responsesSheetId).toBeNull();
  });

  it('does not require the column to exist at all', () => {
    const result = parseFormsTab([HEADER, row()]);
    expect(result.rejections).toHaveLength(0);
    expect(result.rows[0]?.responsesSheetId).toBeNull();
  });
```

- [x] **Step 2: Run and watch it fail.** Expected: `responsesSheetId` does not exist on `FormRow`.

- [x] **Step 3: Add it to `FormRow` and the parser**

In `src/sheets/parse.ts`, add to `FormRow` after `emailColumn`:

```typescript
  /**
   * The spreadsheet this form's answers are in, or null for the configured one.
   *
   * It exists because Google's default when linking a form to Sheets is a **new**
   * spreadsheet, so "put the responses in the same file as the FAQ" is a rule
   * that fights the tool and loses — it already lost once, as a response tab that
   * alarmed every ten minutes for weeks. The bot reads where the answers are.
   */
  readonly responsesSheetId: string | null;
```

In `parseFormsTab`, beside the existing `emailColumn` read:

```typescript
    const responsesSheetId = cell(raw_row, headers.get('RESPONSES_SHEET_ID'));
```

and in the pushed row, beside the others:

```typescript
      responsesSheetId: responsesSheetId === '' ? null : responsesSheetId,
```

- [x] **Step 4: Run and watch the parse tests pass.**

- [x] **Step 5: Add the database column**

In `src/db/schema.ts`, in `formLinks`, after `emailColumn`:

```typescript
    /**
     * The spreadsheet this form's answers are in, or null for the configured
     * one. Google creates a new spreadsheet per form by default, so this is the
     * ordinary case rather than the exception.
     */
    responsesSheetId: text('responses_sheet_id'),
```

```bash
npx drizzle-kit generate
```

**Read the generated SQL before accepting it.** It must contain exactly one `ADD COLUMN` and nothing
else — drizzle has emitted a destructive `DROP TYPE` in this project once. Rename the file to
`drizzle/0014_form_responses_sheet.sql` and change the `tag` in `drizzle/meta/_journal.json` to
`0014_form_responses_sheet`.

- [x] **Step 6: Carry it through the repository and the sync**

In `src/forms/repository.ts`, add to the `FormLink` interface:

```typescript
  /** The spreadsheet this form's answers are in, or null for the configured one. */
  readonly responsesSheetId: string | null;
```

and add `responsesSheetId: formLinks.responsesSheetId,` to **all three** `select({...})` calls —
`activeForms`, `activeFormByType` and `formsWithResponses`.

In `src/sync/sheets-sync.ts`, `syncForms`, add to **both** the `values(...)` mapping and the
`onConflictDoUpdate` `set`:

```typescript
                responsesSheetId: r.responsesSheetId,
```
```typescript
                responsesSheetId: sql`excluded.responses_sheet_id`,
```

**Both, or the column updates on insert and never again.**

In `src/sync/form-responses.ts`, pass it to the reader:

```typescript
      const raw = await reader.readTab(form.responsesTab, form.responsesSheetId);
```

- [x] **Step 7: Write the failing integration test**

Add to `src/sync/forms.integration.test.ts`, inside `describe('reading submissions back', …)`. The
`readerReturning` helper in that file takes tab names only, so add this helper beside it at the top
of the file:

```typescript
/**
 * A reader that answers on `(spreadsheetId, tab)` rather than tab alone, so a
 * form pointed at the wrong spreadsheet is a miss rather than a silent hit.
 */
function readerForSheets(sheets: Record<string, Record<string, string[][]>>): SheetReader {
  return {
    readTab: async (tab: string, spreadsheetId?: string | null) => {
      const key = spreadsheetId ?? 'MAIN';
      const found = sheets[key]?.[tab];
      if (found === undefined) throw new Error(`no tab "${tab}" in spreadsheet ${key}`);
      return found;
    },
  };
}
```

Then the tests:

```typescript
    it('reads a form’s answers from the spreadsheet its row names', async () => {
      await syncForms(
        db,
        readerReturning({
          FORMS: [
            ['TYPE', 'BUTTON_TEXT', 'URL', 'RESPONSES_TAB', 'ACTIVE', 'RESPONSES_SHEET_ID', 'EMAIL_COLUMN'],
            ['ACCOM', 'Accommodation', 'https://forms.gle/a', 'Form Responses 1', 'TRUE', 'THEIR_SHEET', 'D'],
          ],
        }),
      );
      await signedInTeacher('950001', 'a@example.com');

      const report = await syncFormResponses(
        db,
        readerForSheets({
          THEIR_SHEET: {
            'Form Responses 1': [
              ['Timestamp', 'Email Address', 'Full Name', 'Email Address'],
              ['t', 'personal@gmail.com', 'A Teacher', 'a@example.com'],
            ],
          },
        }),
      );

      expect(report.filed).toBe(1);
      const cases = await db.select().from(schema.cases);
      expect(cases[0]?.teacherChatId).toBe('950001');
    });

    /**
     * The other half: a form with no spreadsheet id still reads from the
     * configured one, so nothing that works today changes meaning.
     */
    it('still reads from the main spreadsheet when no id is given', async () => {
      await syncForms(db, readerReturning({ FORMS: [FORMS_HEADER, formRow('PASSPORT')] }));
      await signedInTeacher('950001', 'a@example.com');

      const report = await syncFormResponses(
        db,
        readerForSheets({
          MAIN: { PASSPORT_RESPONSES: [RESPONSES_HEADER, submission('a@example.com')] },
        }),
      );
      expect(report.filed).toBe(1);
    });

    /**
     * D41 through the new path: one form pointed at a spreadsheet the bot cannot
     * read must not hold back everybody else's documents.
     */
    it('keeps filing the other forms when one spreadsheet cannot be read', async () => {
      await syncForms(
        db,
        readerReturning({
          FORMS: [
            ['TYPE', 'BUTTON_TEXT', 'URL', 'RESPONSES_TAB', 'ACTIVE', 'RESPONSES_SHEET_ID'],
            ['PASSPORT', 'Passport', 'https://forms.gle/p', 'PASSPORT_RESPONSES', 'TRUE', ''],
            ['ACCOM', 'Accommodation', 'https://forms.gle/a', 'Form Responses 1', 'TRUE', 'WRONG_ID'],
          ],
        }),
      );
      await signedInTeacher('950001', 'a@example.com');
      const alerter = collectingAlerter();

      const report = await syncFormResponses(
        db,
        readerForSheets({
          MAIN: { PASSPORT_RESPONSES: [RESPONSES_HEADER, submission('a@example.com')] },
        }),
        { alerter },
      );

      expect(report.filed).toBe(1);
      expect(alerter.alerts.some((a) => a.title.includes('could not be read'))).toBe(true);
    });

    /**
     * ⚠️ The property the whole marker table exists for, carried through the new
     * read path. `form_submissions` is keyed on `(form_type, sheet_row)` and says
     * nothing about which spreadsheet the row came from — so reading the same
     * submission from another file must still file exactly one case, or the
     * change made above quietly turns one submission into a case every ten
     * minutes.
     */
    it('files exactly one case however many times another spreadsheet is read', async () => {
      await syncForms(
        db,
        readerReturning({
          FORMS: [
            ['TYPE', 'BUTTON_TEXT', 'URL', 'RESPONSES_TAB', 'ACTIVE', 'RESPONSES_SHEET_ID', 'EMAIL_COLUMN'],
            ['ACCOM', 'Accommodation', 'https://forms.gle/a', 'Form Responses 1', 'TRUE', 'THEIR_SHEET', 'D'],
          ],
        }),
      );
      await signedInTeacher('950001', 'a@example.com');
      const reader = readerForSheets({
        THEIR_SHEET: {
          'Form Responses 1': [
            ['Timestamp', 'Email Address', 'Full Name', 'Email Address'],
            ['t', 'personal@gmail.com', 'A Teacher', 'a@example.com'],
          ],
        },
      });

      const first = await syncFormResponses(db, reader);
      const second = await syncFormResponses(db, reader);

      expect(first.filed).toBe(1);
      expect(second.filed).toBe(0);
      expect(second.alreadySeen).toBe(1);
      expect(await db.select().from(schema.cases)).toHaveLength(1);
    });
```

- [x] **Step 8: Run and watch them pass**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/sync/ src/forms/ src/sheets/
```

Expected: 0 failed.

- [x] **Step 9: Commit**

```bash
git add src/ drizzle/ && git commit -m "feat: a form's answers can live in their own spreadsheet"
```

---

### Task 4: `CATEGORY` decides whether the bot asks for a message

Fault C. As built, `PREPARE` does two unrelated jobs, so Medical Leave cannot both tell teachers what
to bring and stay out of their chat.

**Files:**
- Modify: `src/telegram/router.ts` (`chooseDocForm`, ~line 1795)
- Test: `src/telegram/router.integration.test.ts`

- [x] **Step 1: Write the failing tests**

In `src/telegram/router.integration.test.ts`, inside `describe('a complaint and its paperwork,
together', …)`, add:

```typescript
    /**
     * Medical Leave: notes but no prompt. Typing medical detail into a chat
     * message stores it as case text, where the form keeps it in Google — so this
     * form tells teachers what to bring and then gets out of the way.
     */
    it('shows the notes without asking for a message when there is no category', async () => {
      await verify();
      await db.execute(sql`
        INSERT INTO form_links (type, sheet_row, button_text, url, prepare, active)
        VALUES ('MEDICAL', 1, 'Medical Leave', 'https://forms.gle/m',
                'Have your dates and any medical documents ready.', true)
      `);

      const shown = await tap(encodeCallback(CALLBACK.DOC_TYPE, 'MEDICAL'));
      expect(firstText(shown)).toContain('Have your dates and any medical documents ready.');
      expect(firstText(shown)).toContain('forms.gle');
      expect(firstText(shown)).not.toContain('tell us what you need');

      // And the next thing they type is NOT captured as a case.
      const after = await text('how long does a visa take');
      expect(firstText(after)).not.toContain('has been opened');
      expect((await db.execute(sql`SELECT reference FROM cases`)).rows).toHaveLength(0);
      expect(await loadState(db, CHAT)).toBeNull();
    });

    /**
     * And a category with no notes still asks. The two cells are independent now,
     * so all four combinations have to behave, not just the two we happen to use.
     */
    it('asks for a message when there is a category but no notes', async () => {
      await verify();
      await db.execute(sql`
        INSERT INTO form_links (type, sheet_row, button_text, url, category, active)
        VALUES ('ACCOM', 1, 'Accommodation', 'https://forms.gle/a', 'Accommodation', true)
      `);

      const shown = await tap(encodeCallback(CALLBACK.DOC_TYPE, 'ACCOM'));
      expect(firstText(shown)).toContain('tell us what you need');

      await text('the boiler has not worked since I arrived');
      const rows = await db.execute<{ category: string; form_type: string }>(
        sql`SELECT category, form_type FROM cases`,
      );
      expect(rows.rows[0]?.category).toBe('Accommodation');
      expect(rows.rows[0]?.form_type).toBe('ACCOM');
    });
```

**The existing test `files under Contact Support when the area names no category` asserts the rule
this task reverses.** Delete it, and say so in your report — an empty `CATEGORY` no longer means
`Contact Support`, it means "do not ask". The design's §3 carries the reasoning.

- [x] **Step 2: Run and watch them fail**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/telegram/router.integration.test.ts -t "paperwork"
```

Expected: FAIL — the Medical form has `prepare` set, so it asks for a message.

- [x] **Step 3: Key the prompt off `category`**

In `src/telegram/router.ts`, in `chooseDocForm`, change the branch condition and its comment:

```typescript
  /**
   * **A category is what makes a form a place to complain**, not the presence of
   * preparation notes.
   *
   * The two were one cell until 6 August 2026 and that conflated two unrelated
   * things: what a teacher should bring, and whether they are asked to describe a
   * problem. Medical Leave is where it broke — it should say what to have ready
   * and should not invite a teacher to type their medical situation into a chat
   * message, where it becomes case text rather than staying in the form.
   *
   * `category` is the right switch because a form with nowhere to file a
   * complaint has no business asking for one, so "does it ask?" and "where does
   * it go?" are the same question and cannot drift apart.
   */
  if (form.category !== null) {
```

Then inside that branch, make the notes optional, since a category no longer implies them:

```typescript
    return {
      text:
        `${form.buttonText}\n\n` +
        (form.prepare === null ? '' : `${form.prepare}\n\n`) +
        `${form.url}\n\n` +
        '⚠️ The form asks for your email. Use the same address you signed in here ' +
        'with — that is how we know the documents are yours.\n\n' +
        'Now tell us what you need, and we will open a case for you.',
      keyboard: backToMenuKeyboard(),
    };
```

And in the final `return` — the no-category path — show the notes when there are any:

```typescript
  return {
    text:
      `${form.buttonText}\n\n` +
      (form.prepare === null ? '' : `${form.prepare}\n\n`) +
      `${form.url}\n\n` +
      '⚠️ The form asks for your email. Use the same address you signed in here ' +
      'with — that is how we know the documents are yours.\n\n' +
      'You do not need to send anything back to me. Once you submit the form, ' +
      'it reaches us on its own.',
    keyboard: backToMenuKeyboard(),
  };
```

- [x] **Step 4: Simplify `handleFormComplaint`**

The fallback to `Contact Support` for an unknown category stays — a rollback could leave an older
build reading a newer sheet — but the "blank means Contact Support" case can no longer occur, because
a blank category means the state was never saved. Replace the category resolution with:

```typescript
  /**
   * A category this build does not recognise falls back to the general queue
   * rather than refusing. `parseFormsTab` rejects an unknown category with its
   * row number, so one should never reach the database; if a rollback ever leaves
   * an older build reading a newer sheet, filing the teacher's words somewhere a
   * person will read them beats losing them.
   *
   * A **null** category cannot arrive here at all — `chooseDocForm` only saves
   * this state for a form that has one — but it is handled the same way rather
   * than asserted, because a crash on the path that files a teacher's complaint
   * is a worse answer than filing it under Contact Support.
   */
  const known = Object.values(CASE_CATEGORY) as string[];
  const category: CaseCategory =
    form.category !== null && known.includes(form.category)
      ? (form.category as CaseCategory)
      : CASE_CATEGORY.CONTACT_SUPPORT;
```

That is the code already there — confirm it, and leave it alone if so.

- [x] **Step 5: Run and watch them pass.** Whole file, 0 failed.

- [x] **Step 6: Commit**

```bash
git add src/telegram/router.ts src/telegram/router.integration.test.ts && git commit -m "feat: a form's category decides whether it asks the teacher to write"
```

---

### Task 5: The runbook

**Files:** Modify `RUNBOOK.md` §4.18 and §4a

- [x] **Step 1: Update the FORMS column table**

Add `RESPONSES_SHEET_ID` to the table in step 4, described as: which spreadsheet the answers are in,
blank meaning the main one, and that Google creates a new spreadsheet per form **by default** so this
is usually needed. Say how to find it: it is the long string in the responses spreadsheet's web
address, between `/d/` and `/edit`.

- [x] **Step 2: Update the `EMAIL_COLUMN` guidance**

Say it takes either the exact heading **or** a column letter such as `D`, that a heading wins when
both could match, and **why the letter exists**: Google's "Collect email addresses" adds a column
headed `Email Address` and a form that also asks the question produces a second one with the same
name, which no heading can tell apart. Say plainly that the teacher's own answer is the later column.

- [x] **Step 3: Rewrite §4a's opening**

It currently says filling in `PREPARE` is what makes a form an area. Replace with: **`CATEGORY` is
what makes a form a place to complain.** Fill it in and the teacher is asked to describe their
problem and a case opens; leave it blank and the form is just a link. `PREPARE` is what to gather and
is shown either way. Remove the sentence saying a blank `CATEGORY` means `Contact Support`.

- [x] **Step 4: Commit**

```bash
git add RUNBOOK.md && git commit -m "docs: the new spreadsheet column, column letters, and what makes a form ask"
```

---

### Task 6: The full verification run

Nothing before this may claim to be done.

- [x] **Step 1: Regenerate the graph**

```bash
npm run deps
```

- [x] **Step 2: Check for strays**

```
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*vitest*' }
```

Expected: nothing.

- [x] **Step 3: The suite**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run
```

Expected: **0 failed and 0 skipped.** Hundreds of skips means `TEST_DATABASE_URL` was not set and the
run proved nothing.

- [x] **Step 4: The other four**

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

- [x] **Step 5: Commit the graph if it changed, and report every number plainly.**

```bash
git add docs/dependency-tree.md && git commit -m "docs: regenerate the dependency tree"
```

---

### Task 7: Deploy, then fill in the sheet

**Do not start this until task 6 is green.**

> **⏳ Step 1 is done. Steps 2 to 5 are outstanding, and steps 2 and 3 are in that order for a
> reason.** The deployment went out on 6 August and the live server is at `e6b11c7`. **Nothing has
> reached a teacher yet**, because the FORMS tab is still empty and that is the head of project's own
> action. Until the two rows are written, the ten-minutely FORMS sync keeps refusing itself — *"would
> deactivate 3 of 3 active rows (100%)"* — which harms nothing and stops of its own accord the moment
> they exist.

- [x] **Step 1: Deploy in `RUNBOOK.md` §2.1's order** — **done 6 August 2026**

Take a `pg_dump` into `~/pre-deploy-backups/` first — this carries a migration. Then pull, build,
stop web and worker, migrate, start worker, start web. The app is at **`/home/ubuntu/UZTGBOT`**.

Confirm afterwards: ~~15 migrations applied~~ **migrations 15 → 16 applied**, four containers
healthy, `/healthz` 200, and the data counts unchanged from before.

**What was confirmed:** backup `~/pre-deploy-backups/pre-live-forms-20260806.sql`, 771,553 bytes and
verified complete; `form_links.responses_sheet_id` present and null on all three existing rows; four
containers healthy; `/healthz` 200 checked four ways; the webhook at 0 pending with a `last_error`
from the day before; every data count unchanged — 8 roster, 4 teachers, 9 cases, 4 staff, 3 forms,
1 submission. `findEmailColumn` was then run **inside both containers** against MoPSE's real
duplicate-heading header and returned column 3 for `'D'`, which proves the behaviour rather than
proving a file was copied.

- [ ] **⏳ OUTSTANDING — Step 2: Write the ~~three~~ two rows into the FORMS tab** *(the head of
  project's own action; `MEDICAL` is deferred and is not written)*

The head of project's FORMS tab is empty. The columns, in order:

`TYPE` · `BUTTON_TEXT` · `URL` · `RESPONSES_TAB` · `ACTIVE` · `CATEGORY` · `PREPARE` ·
`EMAIL_COLUMN` · `RESPONSES_SHEET_ID`

| TYPE | BUTTON_TEXT | URL | RESPONSES_TAB | ACTIVE | CATEGORY | EMAIL_COLUMN | RESPONSES_SHEET_ID |
|---|---|---|---|---|---|---|---|
| `ACCOM` | `🏠 Accommodation` | `https://forms.gle/KF36ZqbttnE6uSZGA` | `Form Responses 1` | `TRUE` | `Accommodation` | `D` | `11qaIcRFkRqGYS_eM_Sxhe9ULD1A7cFw-DnRmiyTYFNU` |
| `REIMBURSE` | `💵 Travel and Visa Reimbursement` | `https://forms.gle/5S8RHcX6vjk6MkAcA` | `Form Responses 1` | `TRUE` | `Travel and Arrival` | `D` | `17_GGERVyIH0qu7quWZJG7vwWgKiUcRUU27lq_vqDHwA` |
| `MEDICAL` | `🏥 Medical Leave` | `https://forms.gle/tpuUfPD8P81N1Lgr6` | `Form Responses 1` | `TRUE` | *(blank)* | `D` | `15f3w5ZQqD7EIfxs_wOUZcvANYCz6BAxemRSKl8qJodI` |

`PREPARE` is drafted below from each form's own questions. It is spreadsheet content — offer it, and
let the head of project edit it.

**Accommodation:**

```
Before you start, have these ready:
• Your passport number and arrival date in Uzbekistan
• Your school number, region and district
• The address where you are living now
• Your school director's name and phone number
• Photos of any problems, if you are reporting that the accommodation is not acceptable
```

**Reimbursement:**

```
Before you start, have these ready:
• Your passport number
• Your bank details — IBAN or card number
• Your school number and location
• Every receipt, scanned and combined into ONE PDF using the reimbursement sheet the form links to

Photos must be readable. Do not include documents belonging to another teacher.
```

**Medical Leave:**

```
Before you start, have these ready:
• The dates you need, and the total number of days
• The name and position of the person at your school you told
• A phone number or email for your school
• Your medical documents, if you have them
• Your lesson compensation schedule, if your school requires one
```

- [ ] **⏳ OUTSTANDING — Step 3: One forced sync. Do not run this until step 2 is done.**

**Running it against the empty tab would deactivate all three current rows and leave nothing in their
place**, which takes Submit Documents away from teachers altogether.

The three test rows (`PASSPORT`, `DIPLOMA`, `MEDICAL`) are still active in the database, and removing
them is a 100% deactivation, which the damage limit refuses. ~~`MEDICAL` is reused above and upserts
rather than deactivating, so the removal is 2 of 3 — still over the 20% limit.~~ **`MEDICAL` is not
being written any more, so it is 3 of 3 — a 100% deactivation.** So it needs the override once:

```bash
docker compose run --rm --no-deps web node dist/scripts/sync-sheets.js --forms --force
```

The override is recorded on the sync run, which is the point of it.

- [ ] **⏳ OUTSTANDING — Step 4: Prove it end to end**

Submit the Accommodation form yourself using a roster email that has signed in. Within ten minutes a
case should exist under `Accommodation` with a note naming the form. Check with:

```bash
docker compose exec -T postgres psql -U mopse -d mopse -c "SELECT reference, category, form_type, awaiting_form FROM cases ORDER BY created_at DESC LIMIT 5;"
```

- [ ] **⏳ OUTSTANDING — Step 5: Take the unused key off the server** *(not confirmed done; treat as
  still to do)*

The second service account is no longer needed — the existing one reads all four spreadsheets.

```bash
cd /home/ubuntu/UZTGBOT && cp .env .env.bak-$(date +%Y%m%d-%H%M%S) && grep -v '^GOOGLE_FORMS_SERVICE_ACCOUNT_JSON=' .env.bak-* > .env.new && mv .env.new .env && chmod 600 .env
```

Check the variable is gone and nothing else changed, then restart web and worker.

---

### Task 8: Correct the documents

- [x] Mark `docs/plans/2026-08-06-live-forms-design.md` **✅ BUILT** with the verification numbers, in
  the format `2026-08-03-form-areas-design.md` uses. Strike through what changed while building.
- [x] Correct `BOT-SPEC.md` §10.1 — it says `PREPARE` is what makes a form an area, and says an empty
  `CATEGORY` means `Contact Support`. Both are now wrong. Add `RESPONSES_SHEET_ID` to §10's column
  list and the column-letter form to its email-column paragraph. **Six statements were corrected, in
  §10 and §10.1 both** — the whole file was searched rather than only the two sections named.
- [ ] **⏳ OUTSTANDING — Ask before touching the artifact.** Not touched. It is at v9 and is now
  further out of date, and updating it is its own piece of work to be agreed first.

```bash
git add docs/ BOT-SPEC.md && git commit -m "docs: the live forms, as built"
```

---

## What this plan does not do

- **No Holiday Leave form.** It exists and is out of scope by decision.
- **No second service account.** Its key comes off the server in task 7.
- **No writing to Sheets.** The scope stays `spreadsheets.readonly`.
- **No backfill.** All three response sheets were empty on 6 August.
- **Nothing about the Google call timeout**, the missing backups, or telling a case's owner when
  paperwork arrives. All three are real and all three are their own work.
