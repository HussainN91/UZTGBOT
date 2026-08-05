# The Ministry case record — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or
> `superpowers:executing-plans` to work through this task by task. Steps use `- [ ]` checkboxes.

**Goal:** the bot writes every case into a second Google spreadsheet, one row per case, kept current
within ten minutes, and can never write anywhere else.

**Architecture:** two new layer-2 modules — `sheets/writer.ts` (talks to Google, knows nothing about
cases) and `sync/case-record.ts` (knows about cases, calls the writer). One new nullable column on
`cases` records what has been written. The existing ten-minute `sync_sheets` worker task calls it
after the reads and swallows its failures.

**Tech stack:** TypeScript, Drizzle, `google-auth-library` (JWT), the Google Sheets v4 REST API via
`fetch`, vitest against real PostgreSQL.

**Design:** `docs/plans/2026-08-05-ministry-case-record-design.md`. Decisions are cited as D48–D56;
read it before starting.

---

## Before you start

Read `CLAUDE.md` in full. Four rules govern every task here:

1. **Layers.** Layer 1 `config/ send.ts callback-data.ts`; layer 2 `cases/ staff/ forms/ sheets/
   sync/ conversation/ db/`; layer 3 `telegram/`; layer 4 `worker/ web/ scripts/`. Nothing imports
   from a layer above it. **Nothing in this plan may import from `telegram/`** — in particular
   `formatTashkent` lives in `telegram/commands/context.ts` and is off limits. Timestamps are
   formatted in SQL instead, which is also what avoids trap 1 below.
2. **Raw SQL through `db.execute` does not parse types.** A `timestamptz` comes back as a **string**,
   not a `Date`. Every timestamp in this feature is formatted to text inside PostgreSQL and typed as
   `string` all the way out. Do not add a `Date` anywhere in the row shape.
3. **Comments explain *why*, in prose, at the density of the surrounding file.** `sheets/client.ts`
   and `sync/sheets-sync.ts` are the two files these sit beside; match them.
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

**Never pipe vitest through `head`** — it closes the pipe and the run continues invisibly. Filter
with `Select-String`. **Never start a second run while one is going.** Do not run the full suite
until Task 8.

---

## File structure

| File | Layer | Responsibility |
|---|---|---|
| `src/config/env.ts` | 1 | **Modify.** `GOOGLE_CASE_SHEET_ID`, optional. Absent means the feature is off |
| `src/db/schema.ts` | 2 | **Modify.** `cases.exported_at` and an index |
| `drizzle/00NN_case_record_export.sql` | — | **Create** via `drizzle-kit generate`. Additive only |
| `src/sheets/client.ts` | 2 | **Modify.** Export the credential reader so the writer shares it |
| `src/sheets/writer.ts` | 2 | **Create.** `SheetWriter`: read a column, append rows, update rows. `RAW` |
| `src/sheets/writer.test.ts` | — | **Create.** Unit, fake `fetch` |
| `src/cases/queries.ts` | 2 | **Modify.** `casesNeedingExport`, deliberately unscoped |
| `src/sync/case-record.ts` | 2 | **Create.** Chooses, builds, writes, stamps, records, alerts |
| `src/sync/case-record.integration.test.ts` | — | **Create.** Real PostgreSQL, fake writer |
| `src/worker/tasks/sync-sheets.ts` | 4 | **Modify.** Call it after the reads; never let it throw |
| `docs/dependency-tree.md` | — | **Regenerate** with `npm run deps` |
| `RUNBOOK.md`, `BOT-SPEC.md`, `docs/google-sheets-setup-guide.md` | — | Documents, Task 9 |

---

## Task 1: The column that remembers what has been written

**Files:**
- Modify: `src/db/schema.ts` (the `cases` table, after `closedAt`)
- Create: `drizzle/00NN_case_record_export.sql` (generated)

- [ ] **Step 1: Add the column**

In `src/db/schema.ts`, inside the `cases` table definition, immediately after `closedAt`:

```ts
    /**
     * When this case was last written to the Ministry record spreadsheet (D54).
     *
     * Null means never written. Older than `updated_at` means the case has
     * changed since it was, which is the whole predicate — a per-case column
     * rather than a high-water mark on `sync_runs`, because a watermark loses
     * any case whose `updated_at` falls in the same instant as the cut, and
     * loses it silently.
     *
     * Stamped **after** Google confirms the write, so a failed write leaves it
     * untouched and the next cycle retries on its own without anything having
     * to remember that something went wrong.
     */
    exportedAt: tsz('exported_at'),
```

And in the same table's index list, after `cases_chasing_idx`:

```ts
    /**
     * Serves the export sweep. Approximate on purpose: the real predicate is
     * `exported_at IS NULL OR exported_at < updated_at`, which no single index
     * serves well. This one carries the null case, which is the one that matters
     * on a table where almost every row is already written.
     */
    index('cases_export_idx').on(t.exportedAt),
```

- [ ] **Step 2: Generate the migration**

```bash
npx drizzle-kit generate
```

- [ ] **Step 3: Read the generated SQL before accepting it**

Open the new file in `drizzle/`. It must contain **only** an `ADD COLUMN` and a `CREATE INDEX`.
**If it contains any `DROP`, stop and report it** — this project has had `drizzle-kit` emit a
destructive `DROP TYPE` once before.

Then rename the file to the existing convention (`00NN_case_record_export.sql`, `NN` being the next
number) and change the `tag` in `drizzle/meta/_journal.json` to match.

- [ ] **Step 4: Apply it to the test database and confirm the column exists**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/sync/sheets-sync.integration.test.ts
```

Expected: PASS, 0 skipped. The global setup applies the schema, so a green run here proves the
migration applies cleanly. A run reporting skips means `TEST_DATABASE_URL` did not reach vitest.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat: cases remember whether they have reached the Ministry record"
```

---

## Task 2: The environment variable

**Files:**
- Modify: `src/config/env.ts:92-96`

- [ ] **Step 1: Add the variable**

Replace the two existing Google entries with three, so the comments stay honest about which sheet is
which:

```ts
  /** Google Sheet the FAQ and roster are read from. Read-only; the bot never writes to it. */
  GOOGLE_SHEET_ID: z.string().trim().min(1).optional(),
  /**
   * The Ministry case record — a SECOND spreadsheet, which the bot writes to (D48).
   *
   * Deliberately not the same id as `GOOGLE_SHEET_ID`, and the separation is the
   * load-bearing safety decision of that feature: the service account holds
   * Editor here and stays Viewer on the sheet above, so a write aimed at the
   * wrong id fails with a permission error instead of damaging the roster.
   *
   * Unset means the feature is simply off. That is the correct default for a
   * server that has not been given a spreadsheet yet, and it is what lets this
   * ship before MoPSE has finished creating one.
   */
  GOOGLE_CASE_SHEET_ID: z.string().trim().min(1).optional(),
  /** Service-account JSON key, as a single line. Read on the sheet above, write on the record. */
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().trim().min(1).optional(),
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/config/env.ts
git commit -m "feat: a second spreadsheet id, for the one the bot may write to"
```

---

## Task 3: Share the service-account credentials with the writer

**Files:**
- Modify: `src/sheets/client.ts:37-63`

`credentials()` is currently private. The writer needs the same key and must not carry a second copy
of the parsing and the `\n` repair.

- [ ] **Step 1: Export it, renamed for a reader who finds it from the other file**

Change the signature line only — the body is unchanged:

```ts
/**
 * The service account, parsed once and shared by both directions.
 *
 * Exported rather than duplicated in `writer.ts`: the `\n` repair below is the
 * kind of thing that gets fixed in one copy.
 */
export function serviceAccountCredentials(): { email: string; key: string } {
```

Update the one call site inside `createSheetReader` (`const { email, key } = credentials();`) to
`serviceAccountCredentials()`.

Also correct the file's opening comment, which currently claims the bot never writes to Sheets. It
now says:

```ts
/**
 * Reading the Google Sheet.
 *
 * Read-only, deliberately and at every level: the scope requested is
 * `spreadsheets.readonly`, and the service account should hold Viewer on that
 * one spreadsheet and nothing else. **This file never writes.** `writer.ts` does,
 * to a different spreadsheet, and D48 says why the two are different files and
 * different permissions rather than one of each.
 *
 * The spreadsheet owns the FAQ bank and the roster, the database owns everything
 * else, and information flows one way so the two can never disagree about which
 * copy is correct.
 */
```

- [ ] **Step 2: Typecheck and lint**

```bash
npm run typecheck
```

```bash
npm run lint
```

Expected: both clean, 0 warnings.

- [ ] **Step 3: Commit**

```bash
git add src/sheets/client.ts
git commit -m "refactor: one reader of the service-account key, not two"
```

---

## Task 4: The writer — the failing tests first

**Files:**
- Create: `src/sheets/writer.test.ts`

This module talks to Google over `fetch` and nothing else, so a fake `fetch` tests all of it. The
three properties worth testing are the three that fail silently in production: the wrong
`valueInputOption`, a range built off by one row, and an error response swallowed.

- [ ] **Step 1: Write the failing tests**

```ts
/**
 * Unit tests for the case-record writer.
 *
 * `fetch` is replaced rather than the module mocked, because what needs asserting
 * is the *request* — `RAW` versus `USER_ENTERED` is the difference between a
 * teacher's name and a live formula in a spreadsheet the Ministry reads (D56),
 * and it is invisible to every other kind of test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSheetWriter, type SheetWriter } from './writer.js';

const SHEET_ID = 'record-sheet-id';

interface Captured {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

let captured: Captured[];

function respondWith(payload: unknown, ok = true, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      captured.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return {
        ok,
        status,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      } as unknown as Response;
    }),
  );
}

describe('the case-record writer', () => {
  let writer: SheetWriter;

  beforeEach(() => {
    captured = [];
    vi.stubEnv('GOOGLE_CASE_SHEET_ID', SHEET_ID);
    vi.stubEnv(
      'GOOGLE_SERVICE_ACCOUNT_JSON',
      JSON.stringify({ client_email: 'bot@example.com', private_key: 'key' }),
    );
    // The JWT is not under test; only the requests made with its token are.
    vi.mock('google-auth-library', () => ({
      JWT: class {
        async getAccessToken(): Promise<{ token: string }> {
          return { token: 'test-token' };
        }
      },
    }));
    writer = createSheetWriter();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe('reading the reference column', () => {
    it('returns each reference against the row it is on, counting from row 2', async () => {
      respondWith({ values: [['C-001'], ['C-002'], ['C-003']] });

      const rows = await writer.readReferenceColumn();

      // Row 1 is the header, so the first reference read is on row 2.
      expect(rows.get('C-001')).toBe(2);
      expect(rows.get('C-002')).toBe(3);
      expect(rows.get('C-003')).toBe(4);
    });

    it('skips a blank cell rather than counting it as a case', async () => {
      respondWith({ values: [['C-001'], [''], ['C-003']] });

      const rows = await writer.readReferenceColumn();

      expect(rows.size).toBe(2);
      // The blank row is still occupied, so C-003 keeps its real row number.
      expect(rows.get('C-003')).toBe(4);
    });

    it('returns nothing at all for a sheet with only a header', async () => {
      respondWith({});
      expect((await writer.readReferenceColumn()).size).toBe(0);
    });
  });

  describe('appending new cases', () => {
    it('sends the values RAW, so a name beginning with = stays text', async () => {
      respondWith({});

      await writer.appendRows([['=cmd()', 'b']]);

      const request = captured[0];
      expect(request?.method).toBe('POST');
      expect(request?.url).toContain('valueInputOption=RAW');
      expect(request?.url).not.toContain('USER_ENTERED');
      expect(request?.url).toContain('insertDataOption=INSERT_ROWS');
      expect(request?.body).toEqual({ values: [['=cmd()', 'b']] });
    });

    it('makes no request at all when there is nothing to append', async () => {
      respondWith({});
      await writer.appendRows([]);
      expect(captured).toHaveLength(0);
    });
  });

  describe('updating cases already in the sheet', () => {
    it('addresses each row by its own range and sends them in one request', async () => {
      respondWith({});

      await writer.updateRows([
        { row: 5, values: ['C-005', 'x'] },
        { row: 9, values: ['C-009', 'y'] },
      ]);

      expect(captured).toHaveLength(1);
      expect(captured[0]?.url).toContain('values:batchUpdate');
      expect(captured[0]?.body).toEqual({
        valueInputOption: 'RAW',
        data: [
          { range: 'CASES!A5:K5', values: [['C-005', 'x']] },
          { range: 'CASES!A9:K9', values: [['C-009', 'y']] },
        ],
      });
    });

    it('makes no request at all when there is nothing to update', async () => {
      respondWith({});
      await writer.updateRows([]);
      expect(captured).toHaveLength(0);
    });
  });

  describe('when Google refuses', () => {
    it('raises an error naming the likely cause rather than the status alone', async () => {
      respondWith({ error: { message: 'The caller does not have permission' } }, false, 403);

      await expect(writer.appendRows([['a']])).rejects.toThrow(/403/);
      await expect(writer.appendRows([['a']])).rejects.toThrow(/Editor/);
    });
  });

  describe('when no record spreadsheet is configured', () => {
    it('says so plainly instead of failing at Google', async () => {
      vi.stubEnv('GOOGLE_CASE_SHEET_ID', '');
      respondWith({});

      await expect(createSheetWriter().appendRows([['a']])).rejects.toThrow(
        /GOOGLE_CASE_SHEET_ID/,
      );
    });
  });
});
```

- [ ] **Step 2: Run them and confirm they fail for the right reason**

```
npx vitest run src/sheets/writer.test.ts
```

Expected: FAIL, every test, with `Failed to resolve import "./writer.js"`. A different error means
something in the test file is wrong, not the missing module.

- [ ] **Step 3: Commit the failing tests**

```bash
git add src/sheets/writer.test.ts
git commit -m "test: what the case-record writer has to do before it exists"
```

---

## Task 5: The writer

**Files:**
- Create: `src/sheets/writer.ts`

- [ ] **Step 1: Write it**

```ts
/**
 * Writing the Ministry case record.
 *
 * The only file in this project that writes to Google, and it writes to exactly
 * one spreadsheet: `GOOGLE_CASE_SHEET_ID`, which is deliberately not the sheet
 * `client.ts` reads (D48). The scope requested here is read/write, and scopes
 * are per-token rather than per-file — so the thing that actually stops this
 * touching the roster is the Drive sharing: Editor on the record, Viewer on the
 * other one. That is written down in D49 rather than assumed, because a reader
 * who sees the wider scope should find the reasoning and not a mistake.
 *
 * It knows nothing about cases. It is given rows of strings and a row number.
 */
import { JWT } from 'google-auth-library';
import { env } from '../config/env.js';
import { serviceAccountCredentials, SheetsConfigurationError } from './client.js';

/** Read and write. See the file comment for what does and does not constrain it. */
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/** The tab the record lives on. The sheet handed to MoPSE is built with this name. */
export const RECORD_TAB = 'CASES';

/** Eleven columns, A to K (D50). The writer only needs to know the last letter. */
const LAST_COLUMN = 'K';

/** Row 1 is the header, so the first case is on row 2. */
const FIRST_DATA_ROW = 2;

export interface RowUpdate {
  /** 1-based, as the spreadsheet counts. */
  readonly row: number;
  readonly values: readonly string[];
}

export interface SheetWriter {
  /** Reference → the row it is on. Built fresh each cycle, never stored (D52). */
  readReferenceColumn(): Promise<Map<string, number>>;
  appendRows(rows: readonly (readonly string[])[]): Promise<void>;
  updateRows(updates: readonly RowUpdate[]): Promise<void>;
}

function sheetId(): string {
  const id = env().GOOGLE_CASE_SHEET_ID;
  if (!id) {
    throw new SheetsConfigurationError(
      'GOOGLE_CASE_SHEET_ID is not set, so there is no Ministry record to write to.',
    );
  }
  return id;
}

async function token(): Promise<string> {
  const { email, key } = serviceAccountCredentials();
  const auth = new JWT({ email, key, scopes: [SCOPE] });
  const granted = await auth.getAccessToken();
  if (!granted.token) {
    throw new SheetsConfigurationError('Google refused an access token for the service account.');
  }
  return granted.token;
}

async function call(url: string, method: string, body?: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${await token()}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Google Sheets returned ${response.status} writing the Ministry record. ` +
        `Check GOOGLE_CASE_SHEET_ID, and that the service account has been shared the ` +
        `spreadsheet as an Editor rather than a Viewer. ${detail.slice(0, 300)}`,
    );
  }
  return response.json();
}

function base(): string {
  return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId())}`;
}

export function createSheetWriter(): SheetWriter {
  return {
    async readReferenceColumn(): Promise<Map<string, number>> {
      // Column A from row 2 down, as a column rather than as rows, so one array
      // comes back instead of one array per row.
      const url =
        `${base()}/values/${encodeURIComponent(`${RECORD_TAB}!A${FIRST_DATA_ROW}:A`)}` +
        `?majorDimension=COLUMNS`;
      const payload = (await call(url, 'GET')) as { values?: unknown[][] };
      const column = payload.values?.[0] ?? [];

      const rows = new Map<string, number>();
      column.forEach((cell, i) => {
        const reference = typeof cell === 'string' ? cell.trim() : '';
        // A blank is skipped but still counted, because the rows below it have
        // not moved up. Counting only non-blanks would shift every later case
        // by one and write onto the wrong one.
        if (reference !== '') rows.set(reference, FIRST_DATA_ROW + i);
      });
      return rows;
    },

    async appendRows(rows: readonly (readonly string[])[]): Promise<void> {
      if (rows.length === 0) return;
      const url =
        `${base()}/values/${encodeURIComponent(`${RECORD_TAB}!A1`)}:append` +
        `?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
      await call(url, 'POST', { values: rows });
    },

    async updateRows(updates: readonly RowUpdate[]): Promise<void> {
      if (updates.length === 0) return;
      await call(`${base()}/values:batchUpdate`, 'POST', {
        valueInputOption: 'RAW',
        data: updates.map((u) => ({
          range: `${RECORD_TAB}!A${u.row}:${LAST_COLUMN}${u.row}`,
          values: [u.values],
        })),
      });
    },
  };
}
```

- [ ] **Step 2: Run the tests**

```
npx vitest run src/sheets/writer.test.ts
```

Expected: PASS, all of them.

- [ ] **Step 3: Prove the RAW test can fail**

Temporarily change `valueInputOption=RAW` to `valueInputOption=USER_ENTERED` in `appendRows`, run the
file again, and confirm the "sends the values RAW" test **fails**. Then put it back and confirm the
run is green again. A test that cannot fail is not protecting anything, and this is the one whose
subject is invisible everywhere else.

- [ ] **Step 4: Typecheck, lint, commit**

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
git add src/sheets/writer.ts
git commit -m "feat: the one file allowed to write to a spreadsheet"
```

---

## Task 6: The rows to write

**Files:**
- Modify: `src/cases/queries.ts`

Every value is formatted to text **inside PostgreSQL**. Two reasons, both from `CLAUDE.md` §3: a
`timestamptz` read through raw SQL comes back as a string whatever the type annotation says, and the
only Tashkent formatter in the codebase lives in layer 3 where this cannot reach it.

- [ ] **Step 1: Write the failing test**

Create `src/sync/case-record.integration.test.ts` with the row-shape test only. The rest of the file
arrives in Task 7.

```ts
/**
 * Integration tests for the Ministry case record, against a real PostgreSQL.
 *
 * Everything interesting here is state that has to survive a cycle: what has
 * been written, what changed since, and what happens when Google refuses. A
 * mock database would confirm the code calls the right functions, not that a
 * failed write actually leaves `exported_at` alone.
 */
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { casesNeedingExport } from '../cases/queries.js';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const CHAT = '700000001';
const STAFF = '800000001';

/** A verified teacher and an active staff member, because cases need both. */
async function seedPeople(db: Database): Promise<void> {
  await db.insert(schema.teachers).values({
    chatId: CHAT,
    name: 'Dilnoza Karimova',
    verificationState: 'Verified',
    regionOverride: 'Samarqand',
  });
  await db.insert(schema.staff).values({ telegramId: STAFF, name: 'Ali Yusupov', role: 'Support' });
}

async function seedCase(
  db: Database,
  reference: string,
  overrides: Partial<typeof schema.cases.$inferInsert> = {},
): Promise<void> {
  await db.insert(schema.cases).values({
    reference,
    category: 'Visa',
    teacherChatId: CHAT,
    status: 'New',
    ...overrides,
  });
}

describe.skipIf(!TEST_DATABASE_URL)('the Ministry case record', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as NodePgDatabase<typeof schema> as Database;
    await db.execute(
      sql`TRUNCATE cases, teachers, staff, roster_entries, sync_runs RESTART IDENTITY CASCADE`,
    );
    await seedPeople(db);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('the row a case becomes', () => {
    it('carries the eleven columns, with the teacher name and no teacher words', async () => {
      await seedCase(db, 'VISA-2026-00001', {
        detail: 'my visa has not arrived and I am worried',
        owner: STAFF,
        importance: 'Urgent',
        status: 'Under review',
      });

      const [row] = await casesNeedingExport(db, 10);

      expect(row).toBeDefined();
      expect(row?.reference).toBe('VISA-2026-00001');
      expect(row?.teacher).toBe('Dilnoza Karimova');
      expect(row?.region).toBe('Samarqand');
      expect(row?.category).toBe('Visa');
      expect(row?.status).toBe('Under review');
      expect(row?.importance).toBe('Urgent');
      expect(row?.owner).toBe('Ali Yusupov');
      // D50: the teacher's own words are not in the record, at all.
      expect(JSON.stringify(row)).not.toContain('worried');
    });

    it('renders every timestamp as Tashkent text, never as a Date', async () => {
      await seedCase(db, 'VISA-2026-00002');

      const [row] = await casesNeedingExport(db, 10);

      expect(row?.created).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      expect(typeof row?.created).toBe('string');
      // Not set on a new case, and an empty cell is what the sheet should show.
      expect(row?.due).toBe('');
      expect(row?.closed).toBe('');
    });

    it('distinguishes a case nobody owns from one owned by an unnamed staff member', async () => {
      await seedCase(db, 'VISA-2026-00003');
      await db.update(schema.staff).set({ name: null }).where(sql`telegram_id = ${STAFF}`);
      await seedCase(db, 'VISA-2026-00004', { owner: STAFF });

      const rows = await casesNeedingExport(db, 10);
      const byRef = new Map(rows.map((r) => [r.reference, r]));

      expect(byRef.get('VISA-2026-00003')?.owner).toBe('');
      expect(byRef.get('VISA-2026-00004')?.owner).toBe('Unnamed staff member');
    });
  });

  describe('choosing what needs writing', () => {
    it('returns a case that has never been written', async () => {
      await seedCase(db, 'VISA-2026-00005');
      expect(await casesNeedingExport(db, 10)).toHaveLength(1);
    });

    it('does not return one written since it last changed', async () => {
      await seedCase(db, 'VISA-2026-00006');
      await db.execute(sql`UPDATE cases SET exported_at = now()`);
      expect(await casesNeedingExport(db, 10)).toHaveLength(0);
    });

    it('returns one that changed after it was written', async () => {
      await seedCase(db, 'VISA-2026-00007');
      await db.execute(sql`UPDATE cases SET exported_at = now() - interval '1 hour'`);
      await db.execute(sql`UPDATE cases SET updated_at = now(), status = 'Escalated'`);
      expect(await casesNeedingExport(db, 10)).toHaveLength(1);
    });

    it('honours the cap, oldest first, so a backfill makes progress in order', async () => {
      for (let i = 10; i < 16; i += 1) await seedCase(db, `VISA-2026-000${i}`);
      const rows = await casesNeedingExport(db, 4);
      expect(rows).toHaveLength(4);
      expect(rows[0]?.reference).toBe('VISA-2026-00010');
    });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/sync/case-record.integration.test.ts
```

Expected: FAIL — `casesNeedingExport` is not exported from `../cases/queries.js`. **If it reports
skipped instead, the environment variable did not reach vitest** — fix that before continuing, since
a skipped run proves nothing.

- [ ] **Step 3: Write the query**

In `src/cases/queries.ts`, at the end of the file:

```ts
/**
 * The cases whose row in the Ministry record is missing or out of date (D54).
 *
 * **Deliberately unscoped**, and that is a departure worth naming: every
 * staff-facing read in this module applies `visibleToStaff`, because every one
 * of them is answering "what may *this person* see?". A scheduled job is not a
 * person and has no region. The precedent is the retention pass, which reads
 * cases the same way for the same reason.
 *
 * The guard is that it has exactly one caller, in the worker, whose output goes
 * to one fixed spreadsheet. **It must never acquire a second**, because an
 * unscoped case query is the exact shape of a future permission fault.
 *
 * Every column comes back as text, formatted in PostgreSQL. Timestamps because
 * a `timestamptz` through raw SQL is a string whatever it is typed as, and the
 * only Tashkent formatter in the codebase is in layer 3 where this cannot reach
 * it; the rest for uniformity, since the destination is a spreadsheet cell.
 */
export interface CaseRecordRow {
  readonly reference: string;
  readonly teacher: string;
  readonly region: string;
  readonly category: string;
  readonly status: string;
  readonly importance: string;
  readonly owner: string;
  readonly created: string;
  readonly updated: string;
  readonly due: string;
  readonly closed: string;
}

/**
 * `::text` on the zone is not decoration. A bare parameter next to `AT TIME
 * ZONE` gets its type inferred from its neighbours, which is the trap that made
 * `make_interval` reject 1.5 in stage 5.
 */
const tashkent = (column: SQL | PgColumn): SQL<string> =>
  sql<string>`coalesce(to_char(${column} AT TIME ZONE ${TIMEZONE}::text, 'YYYY-MM-DD HH24:MI'), '')`;

export async function casesNeedingExport(db: Database, limit: number): Promise<CaseRecordRow[]> {
  const rows = await db
    .select({
      reference: cases.reference,
      teacher: sql<string>`coalesce(${teachers.name}, '')`,
      region: sql<string>`coalesce(${teachers.regionOverride}, ${rosterEntries.region}, '')`,
      category: cases.category,
      status: sql<string>`${cases.status}::text`,
      importance: sql<string>`${cases.importance}::text`,
      /**
       * Blank means nobody has taken it. A staff member with no name set reads
       * as "Unnamed staff member" rather than blank, because "unassigned" and
       * "assigned to someone we cannot name" are different facts and a reader
       * of this sheet would otherwise see them as the same one. The chat id is
       * not used as a fallback — it means nothing to a Ministry reader and is
       * an identifier that does not need to travel.
       */
      owner: sql<string>`case
        when ${cases.owner} is null then ''
        else coalesce(nullif(${staff.name}, ''), 'Unnamed staff member')
      end`,
      created: tashkent(cases.createdAt),
      updated: tashkent(cases.updatedAt),
      due: tashkent(cases.dueAt),
      closed: tashkent(cases.closedAt),
    })
    .from(cases)
    .leftJoin(teachers, eq(teachers.chatId, cases.teacherChatId))
    .leftJoin(rosterEntries, eq(rosterEntries.identifier, teachers.identifier))
    .leftJoin(staff, eq(staff.telegramId, cases.owner))
    .where(sql`${cases.exportedAt} is null or ${cases.exportedAt} < ${cases.updatedAt}`)
    .orderBy(asc(cases.createdAt))
    .limit(limit);

  return rows;
}
```

Add whatever is missing to the file's existing imports: `asc` from `drizzle-orm`, `staff` from
`../db/schema.js`, `TIMEZONE` from `../config/constants.js`, and the types `SQL` from `drizzle-orm`
and `PgColumn` from `drizzle-orm/pg-core`. **Check the roster join** — copy the identifier column
name from the existing `COLUMNS` object at the top of the file rather than trusting this snippet, and
match whatever join `scoped()` already uses so the region resolves the same way `/case` resolves it.

- [ ] **Step 4: Run the tests**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/sync/case-record.integration.test.ts
```

Expected: PASS, 0 skipped.

- [ ] **Step 5: Commit**

```bash
git add src/cases/queries.ts src/sync/case-record.integration.test.ts
git commit -m "feat: the rows a case becomes in the Ministry record"
```

---

## Task 7: The sync

**Files:**
- Create: `src/sync/case-record.ts`
- Modify: `src/sync/case-record.integration.test.ts` (add the cases below)

- [ ] **Step 1: Add the failing tests**

Append to the test file, and add these imports at the top:
`import { syncCaseRecord, RECORD_ROW_CAP } from './case-record.js';`,
`import type { RowUpdate, SheetWriter } from '../sheets/writer.js';`,
`import type { Alert, Alerter } from './alerts.js';`

```ts
/**
 * A spreadsheet that remembers what it was told, so a test can assert on where
 * a write landed rather than only that one happened.
 */
class FakeWriter implements SheetWriter {
  /** Reference → row, exactly as the real sheet's column A would read back. */
  readonly rows = new Map<string, number>();
  readonly appended: string[][] = [];
  readonly updates: RowUpdate[] = [];
  /** Set true to make every call fail the way an unreachable Google does. */
  fail = false;

  private refuseIfFailing(): void {
    if (this.fail) throw new Error('Google Sheets returned 503');
  }

  async readReferenceColumn(): Promise<Map<string, number>> {
    this.refuseIfFailing();
    // A copy, so a test that re-sorts the sheet has to say so explicitly.
    return new Map(this.rows);
  }

  async appendRows(rows: readonly (readonly string[])[]): Promise<void> {
    this.refuseIfFailing();
    for (const row of rows) {
      this.appended.push([...row]);
      this.rows.set(String(row[0]), this.rows.size + 2);
    }
  }

  async updateRows(updates: readonly RowUpdate[]): Promise<void> {
    this.refuseIfFailing();
    this.updates.push(...updates);
  }
}

const fakeWriter = (): FakeWriter => new FakeWriter();

function collectingAlerter(): Alerter & { alerts: Alert[] } {
  const alerts: Alert[] = [];
  return { alerts, send: async (alert: Alert) => void alerts.push(alert) };
}

describe('writing the record', () => {
  it('appends every existing case on the first run and nothing on the second', async () => {
    await seedCase(db, 'VISA-2026-00100');
    await seedCase(db, 'VISA-2026-00101');
    const writer = fakeWriter();

    const first = await syncCaseRecord(db, writer);
    expect(first.outcome).toBe('applied');
    expect(writer.appended).toHaveLength(2);

    const second = await syncCaseRecord(db, writer);
    expect(second.outcome).toBe('applied');
    expect(writer.appended).toHaveLength(2);
    expect(writer.updates).toHaveLength(0);
  });

  it('updates a changed case in its existing row rather than adding a second', async () => {
    await seedCase(db, 'VISA-2026-00102');
    const writer = fakeWriter();
    await syncCaseRecord(db, writer);

    await db.execute(sql`UPDATE cases SET status = 'Completed', updated_at = now()`);
    await syncCaseRecord(db, writer);

    expect(writer.appended).toHaveLength(1);
    expect(writer.updates).toHaveLength(1);
    expect(writer.updates[0]?.row).toBe(2);
    expect(writer.updates[0]?.values[4]).toBe('Completed');
  });

  /**
   * The test D52 exists for. Somebody sorting the sheet is an ordinary thing to
   * do and is invisible to the bot; a stored row number would send this write
   * onto another teacher's case.
   */
  it('follows a case that somebody moved by sorting the sheet', async () => {
    await seedCase(db, 'VISA-2026-00103');
    await seedCase(db, 'VISA-2026-00104');
    const writer = fakeWriter();
    await syncCaseRecord(db, writer);

    // The sheet is re-sorted by hand: the two cases swap rows.
    writer.rows.set('VISA-2026-00103', 3);
    writer.rows.set('VISA-2026-00104', 2);

    await db.execute(sql`UPDATE cases SET status = 'Closed', updated_at = now()
      WHERE reference = 'VISA-2026-00103'`);
    await syncCaseRecord(db, writer);

    expect(writer.updates).toHaveLength(1);
    expect(writer.updates[0]?.row).toBe(3);
    expect(writer.updates[0]?.values[0]).toBe('VISA-2026-00103');
  });

  it('leaves exported_at alone when Google refuses, and retries next cycle', async () => {
    await seedCase(db, 'VISA-2026-00105');
    const writer = fakeWriter();
    writer.fail = true;

    const failed = await syncCaseRecord(db, writer, { alerter: collectingAlerter() });
    expect(failed.outcome).toBe('failed');

    const [stored] = await db
      .select({ exportedAt: schema.cases.exportedAt })
      .from(schema.cases)
      .where(sql`reference = 'VISA-2026-00105'`);
    expect(stored?.exportedAt).toBeNull();

    writer.fail = false;
    const recovered = await syncCaseRecord(db, writer);
    expect(recovered.outcome).toBe('applied');
    expect(writer.appended).toHaveLength(1);
  });

  it('alerts a person when it fails, because a silent record is a stale one', async () => {
    await seedCase(db, 'VISA-2026-00106');
    const writer = fakeWriter();
    writer.fail = true;
    const alerter = collectingAlerter();

    await syncCaseRecord(db, writer, { alerter });

    expect(alerter.alerts).toHaveLength(1);
    expect(alerter.alerts[0]?.severity).toBe('warning');
  });

  it('records a run against its own source so the record has a durable history', async () => {
    await seedCase(db, 'VISA-2026-00107');
    await syncCaseRecord(db, fakeWriter());

    const runs = await db.select().from(schema.syncRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.source).toBe('CASE_RECORD');
    expect(runs[0]?.outcome).toBe('applied');
  });

  it('writes no more than the cap in one cycle and finishes the rest on the next', async () => {
    for (let i = 0; i < RECORD_ROW_CAP + 3; i += 1) {
      await seedCase(db, `BULK-${String(i).padStart(5, '0')}`);
    }
    const writer = fakeWriter();

    await syncCaseRecord(db, writer);
    expect(writer.appended).toHaveLength(RECORD_ROW_CAP);

    await syncCaseRecord(db, writer);
    expect(writer.appended).toHaveLength(RECORD_ROW_CAP + 3);
  });

  it('never deletes a row for a case that has gone from the database', async () => {
    await seedCase(db, 'VISA-2026-00108');
    const writer = fakeWriter();
    await syncCaseRecord(db, writer);

    await db.execute(sql`DELETE FROM cases WHERE reference = 'VISA-2026-00108'`);
    const report = await syncCaseRecord(db, writer);

    expect(report.outcome).toBe('applied');
    // Retention removed the case; the record keeps it, which is the point (D50).
    expect(writer.rows.has('VISA-2026-00108')).toBe(true);
  });
});
```

**The cap test is slow** — if `RECORD_ROW_CAP` is 1,000 it inserts 1,003 cases one at a time. Insert
them in one statement with a generated series if it takes more than a few seconds.

- [ ] **Step 2: Run and confirm they fail on the missing module**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/sync/case-record.integration.test.ts
```

Expected: FAIL — cannot resolve `./case-record.js`. The Task 6 tests in the same file should still
pass.

- [ ] **Step 3: Write the module**

```ts
/**
 * Keeping the Ministry case record current.
 *
 * One row per case, updated in place (D51), found by its reference rather than
 * by a remembered row number (D52), and written on the ten-minute sync (D53).
 *
 * This is the downstream end of the system and must behave like it: a failure
 * here is alerted and retried, never propagated. The bot raising cases, telling
 * staff and answering teachers cannot be allowed to depend on Google being
 * reachable (D55).
 */
import { inArray, sql } from 'drizzle-orm';
import { casesNeedingExport, type CaseRecordRow } from '../cases/queries.js';
import type { Database } from '../db/index.js';
import { cases, syncRuns } from '../db/schema.js';
import { log } from '../log.js';
import type { SheetWriter, RowUpdate } from '../sheets/writer.js';
import { loggingAlerter, neverThrows, type Alerter } from './alerts.js';

/**
 * How many rows one cycle will write.
 *
 * It exists for the first run, which has every case that has ever been raised to
 * get through. A backfill spread over a few ten-minute cycles finishes on its
 * own and needs nobody to start it; one enormous request is a thing that can
 * time out halfway and be repeated for ever.
 */
export const RECORD_ROW_CAP = 1000;

export interface CaseRecordReport {
  readonly outcome: 'applied' | 'failed';
  readonly appended: number;
  readonly updated: number;
  readonly message: string;
}

export interface CaseRecordOptions {
  readonly alerter?: Alerter;
}

/** The eleven columns of D50, in the order the sheet's header row has them. */
function toRow(row: CaseRecordRow): string[] {
  return [
    row.reference,
    row.teacher,
    row.region,
    row.category,
    row.status,
    row.importance,
    row.owner,
    row.created,
    row.updated,
    row.due,
    row.closed,
  ];
}

export async function syncCaseRecord(
  db: Database,
  writer: SheetWriter,
  options: CaseRecordOptions = {},
): Promise<CaseRecordReport> {
  const alerter = neverThrows(options.alerter ?? loggingAlerter);
  const startedAt = new Date();

  try {
    const pending = await casesNeedingExport(db, RECORD_ROW_CAP);
    if (pending.length === 0) {
      const report = { outcome: 'applied' as const, appended: 0, updated: 0, message: 'nothing to write' };
      await recordRun(db, startedAt, report);
      return report;
    }

    /**
     * Read every reference in the sheet first, and read it every cycle. This is
     * the one extra round trip D52 buys the design with, and what it buys is
     * that sorting or inserting a row by hand cannot make the next write land
     * on somebody else's case.
     */
    const existing = await writer.readReferenceColumn();

    const appended: string[][] = [];
    const updates: RowUpdate[] = [];
    for (const row of pending) {
      const values = toRow(row);
      const at = existing.get(row.reference);
      if (at === undefined) appended.push(values);
      else updates.push({ row: at, values });
    }

    // Updates first: an append shifts nothing that already exists, but doing it
    // the other way round would have the appended rows counted into a reference
    // map that was read before them.
    await writer.updateRows(updates);
    await writer.appendRows(appended);

    /**
     * Stamped only now, and only for the references actually written. `now()`
     * comes from PostgreSQL rather than this process, as every stored timestamp
     * in this project does.
     */
    const written = pending.map((r) => r.reference);
    await db.update(cases).set({ exportedAt: sql`now()` }).where(inArray(cases.reference, written));

    const report = {
      outcome: 'applied' as const,
      appended: appended.length,
      updated: updates.length,
      message: `${appended.length} added, ${updates.length} updated`,
    };
    await recordRun(db, startedAt, report);
    log.info({ ...report }, 'ministry case record written');
    return report;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'could not write the ministry case record');
    await alerter.send({
      severity: 'warning',
      title: 'The Ministry case record was not updated',
      body:
        `The bot could not write to the case spreadsheet, so it is out of date. ` +
        `Cases themselves are unaffected and it will try again in ten minutes. ` +
        `If this keeps happening, check that the service account still has Editor ` +
        `access to that spreadsheet. The error was: ${message}`,
    });
    const report = { outcome: 'failed' as const, appended: 0, updated: 0, message };
    await recordRun(db, startedAt, report);
    return report;
  }
}

/** `sync_runs.source` is plain text, so `CASE_RECORD` needs no migration (D55). */
async function recordRun(
  db: Database,
  startedAt: Date,
  report: CaseRecordReport,
): Promise<void> {
  try {
    await db.insert(syncRuns).values({
      source: 'CASE_RECORD',
      startedAt,
      finishedAt: new Date(),
      outcome: report.outcome,
      rowsSeen: report.appended + report.updated,
      rowsUpserted: report.appended + report.updated,
      message: report.message,
    });
  } catch (err) {
    // Recording the run must never be the reason a good write reports failure.
    log.error({ err }, 'could not record the case record run');
  }
}
```

- [ ] **Step 4: Run the tests**

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/sync/case-record.integration.test.ts
```

Expected: PASS, 0 skipped.

- [ ] **Step 5: Prove the sorting test can fail**

Temporarily change the `existing.get(row.reference)` lookup to a fixed `2`, run the file, and confirm
**"follows a case that somebody moved by sorting the sheet"** fails. Put it back. That test is the
justification for an extra Google round trip every ten minutes and has to be shown to be load-bearing.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
git add src/sync/case-record.ts src/sync/case-record.integration.test.ts
git commit -m "feat: the Ministry record follows the cases without anyone maintaining it"
```

---

## Task 8: Wiring it to the ten-minute sync

**Files:**
- Modify: `src/worker/tasks/sync-sheets.ts`

- [ ] **Step 1: Add the call**

Add the imports:

```ts
import { createSheetWriter } from '../../sheets/writer.js';
import { syncCaseRecord } from '../../sync/case-record.js';
```

Then, inside `runSync`, **after** the `responses` block and **before** `const outcomes = [`:

```ts
  /**
   * The Ministry record, last and deliberately fenced off (D55).
   *
   * It runs after the reads because it is the only part of this job nobody is
   * waiting on: the FAQ reaching teachers within ten minutes is a promise made
   * to staff, and the record being one cycle late is a promise made to nobody.
   *
   * Its failure is swallowed here rather than joined to the AggregateError
   * below. Throwing would mark `sync_sheets` failed, which retries the FAQ and
   * roster syncs that had just succeeded and alarms the heartbeat about a job
   * that is working. `syncCaseRecord` already alerted and already recorded its
   * own `sync_runs` row.
   *
   * Skipped entirely when no record spreadsheet is configured — a server
   * without one is not misconfigured, it is a server that has not been given a
   * spreadsheet yet.
   */
  const record = env().GOOGLE_CASE_SHEET_ID
    ? await syncCaseRecord(db, createSheetWriter(), { alerter })
    : { outcome: 'skipped' as const, message: 'no case record spreadsheet is configured' };
```

Add `record` to the `outcomes` array:

```ts
    `CASE_RECORD: ${record.outcome} (${record.message})`,
```

Add `import { env } from '../../config/env.js';` if it is not already imported.

**Do not add `record` to the `crashed` array.** That is the point of the comment above it.

- [ ] **Step 2: Typecheck, lint, deps**

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm run deps:check
```

Expected: all clean. `deps:check` is silent on success — **the layer check is the one that matters
here**, because a layer-4 file now reaches two more layer-2 modules and nothing may point back up.

- [ ] **Step 3: Regenerate the dependency document**

```bash
npm run deps
```

- [ ] **Step 4: The full suite**

Start the database first if it is not up. Then:

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run
```

Expected: **0 failed, 0 skipped**, around five minutes. A run reporting hundreds of skips proved
nothing and must be redone. Report the real numbers — tests, files, failures, skips, seconds.

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/worker/tasks/sync-sheets.ts docs/dependency-tree.md
git commit -m "feat: the record is written on the same ten minutes as everything else"
```

---

## Task 9: The documents

**Files:**
- Modify: `docs/google-sheets-setup-guide.md`, `RUNBOOK.md`, `BOT-SPEC.md`
- Modify: `docs/plans/2026-08-05-ministry-case-record-design.md`

**Check with the head of project before editing the setup guide** — they had uncommitted changes in
it on 5 August and it is the document handed to the MoPSE account owner.

- [ ] **Step 1: `docs/google-sheets-setup-guide.md`**

Two changes. First, this sentence is now false and is the thing the Ministry account owner reads:

> The bot only ever reads the spreadsheet. It never changes anything in it, and everything it
> produces on its own — cases, notes, records — lives in its own database on the server, not in your
> sheet.

It becomes: the bot only ever reads *this* spreadsheet, and there is a second one — the case record —
which it writes to and which is a separate file for exactly that reason.

Second, a new section covering the record: upload `docs/MoPSE-case-record-template.xlsx`, **convert
it to a Google Sheet** (an `.xlsx` sitting in Drive cannot be written to at all), share it with the
same service-account email as **Editor**, and copy its id into `GOOGLE_CASE_SHEET_ID`. Say plainly
that the tab must keep the name `CASES` and the headers must stay on row 1.

- [ ] **Step 2: `RUNBOOK.md`**

- The new environment variable, and that leaving it unset turns the feature off cleanly.
- The two silent-failure traps above.
- **Beside D44's list of what `/forget` cannot remove:** a teacher's name in the case record is not
  reachable by any command. Forgetting a teacher who asks to be forgotten now also means opening the
  spreadsheet and deleting their rows by hand.
- That `sync_runs` has a `CASE_RECORD` source for checking whether the record is current.

- [ ] **Step 3: `BOT-SPEC.md`**

What the bot now does, in the same voice as the rest of that document. One row per case, within ten
minutes, no teacher's words, one-way.

- [ ] **Step 4: The design document**

Change the status line from **designed, not built** to built, with the date and the commit range, and
add a "What building it found" section — every departure from this plan, every fault found in code
that was already committed, and the real test numbers. Corrections to a decision are **struck through
with the correction against them**, never written over the top.

- [ ] **Step 5: Commit, separately from the code**

```bash
git add docs/ RUNBOOK.md BOT-SPEC.md
git commit -m "docs: the bot writes to a spreadsheet now, and one guide said it never would"
```

---

## What is not in this plan

- **Reading anything back from the spreadsheet.** §6 of the design says why that is separate work.
- **Deleting rows**, ever, including for cases retention has removed. There is a test asserting it.
- **A second spreadsheet per region or per month**, which would need Drive permission on top of Sheets.
- **Response-time reporting.** The SUMMARY tab counts; it does not measure.
