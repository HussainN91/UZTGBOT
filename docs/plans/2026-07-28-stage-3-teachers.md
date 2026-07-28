# Stage 2.5 + Stage 3 Implementation Plan — Operational Floor and Teachers

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship everything a teacher can do — sign in, browse the FAQ, open and check cases, escalate an urgent one — on a foundation where a restart, a double-tap or a redelivered update cannot corrupt anything.

**Architecture:** Two stages. **2.5** is an operational floor: the prerequisites Stage 3 turns out to depend on, plus corrections to Stage 2 that are cheaper to make before anything reads those tables. **3** is the teacher journey, built leaves-first — pure functions with no database, then the stores, then the flows. Per-chat PostgreSQL advisory locks replace the Apps Script global script lock, so two teachers can never block each other.

**Tech Stack:** TypeScript on Node 22, grammY, PostgreSQL 17 via Drizzle, graphile-worker, Vitest.

---

## Decisions recorded

These were open questions. They are now settled, with the reasoning, so they stay decisions rather than becoming accidents.

### D1 — Duplicate identity is DETECTED, not blocked

**Decision:** Drop `teachers_identifier_unique` (`src/db/schema.ts:224`). Detect a duplicate by querying for other verified holders *before* the bind, allow the bind, and alarm.

**Why:** `BOT-SPEC.md:205` states it outright — *"Duplicate identity bindings are detected, not blocked"* — and `reference/apps-script/UserSession.gs:305-310` gives the reasoning: a teacher switching phones produces exactly this signal, and locking them out is worse than a false alarm a human can dismiss. The unique index added in Stage 2 silently reversed that decision in a code comment.

Blocking creates two failures worse than the one it prevents:
- A teacher who changes phone or Telegram account is **permanently locked out**, and no Stage 3 command can release the identifier — staff lifecycle commands are Stage 4.
- A first-mover attacker who signs in with a leaked recruitment email **permanently locks out the real teacher**. That is a denial-of-service the risk register does not contemplate; `CONCERNS-AND-IT-ACTIONS.md` B7 only describes undetected impersonation.

It also interacts badly with revocation: a `Revoked` teacher still holds the identifier under a unique index, so revoking someone would permanently burn that roster identity unless revocation also nulls the column — which destroys the history linkage `schema.ts:186-192` exists to preserve.

**Consequence:** the alarm must be reliable, because it is now the only control. That is why the Telegram alerter moves into Stage 2.5.

### D2 — New-case staff notification defers to Stage 4

**Decision:** Stage 3 creates cases and emits a case-created event through the existing `Alerter` (`src/sync/alerts.ts:26`). It does **not** implement targeted per-admin notification.

**Why:** `BOT-SPEC.md:471-484` routes notification through queue *and* region matching — that is the Stage 4 permission model in full, including a `staff.queue` vocabulary that does not exist anywhere yet. And `staff` is empty during Stage 3, so a targeted implementation would notify nobody while looking finished. Emitting through the alerter gives real visibility now and leaves one clean seam for Stage 4 to widen.

### D3 — Attempt counters live in `conversation_states.payload`, not on `teachers`

**Decision:** The 5-attempt verification cap lives in the conversation state, expiring with it.

**Why:** In Apps Script the cap was per 30-minute cache session and self-healing (`MenuHandler.gs:421`). Persisting it to `teachers` changes its character — five typos would lock a teacher out durably, and no Stage 3 command could clear it. Preserving the self-healing behaviour is the smaller change and the kinder one.

### D4 — Expiry is enforced at READ time, not by a sweeper

**Decision:** Every read of `conversation_states` and every consumption of `urgent_codes` filters on expiry in the same statement. The Stage 5 sweeper becomes a disk-space job, not a correctness one.

**Why:** Otherwise Stage 3 is *incorrect until Stage 5 ships* — an abandoned `AWAITING_CASE_DETAIL` from two days ago would capture the teacher's next FAQ question as a case. `CacheService` gave expiry for free; PostgreSQL does not.

### D5 — Urgent code consumption moves to case creation

**Decision:** Consume the code in the same transaction as the case insert, not at code-entry time.

**Why:** `CONCERNS-AND-IT-ACTIONS.md` B8 says the full fix "requires validating the code without consuming it and consuming it at case creation, which opens a double-use race." The conditional `UPDATE … WHERE used_at IS NULL` closes that race, so B8's stated blocker is simply false now. This is a capability that became available and nobody noticed.

**Critical sub-case:** the dedup path can legitimately return an *existing* case (`MenuHandler.gs:315`), and that path **must still consume the code** — the escalation is what the code bought. `BOT-SPEC.md:7.3` says urgent+deduplicated is the common path, not an edge case. A naive "consume only on insert" gives urgent escalations away free.

### D6 — Re-staging

Seven pieces were assigned to later stages but are Stage 3 prerequisites. They move to Stage 2.5:

| Work | Was | Why it must move |
|---|---|---|
| Telegram alerter + `OPS_ALERT_CHAT_ID` | Stage 4 | D1 makes the alarm the only impersonation control; it cannot land in an unread log |
| `settings` reader | Stage 4 | Maintenance mode gates teacher case flows; Stage 4 keeps the writer |
| `job_runs` heartbeat | Stage 5 | `schema.ts:479` promises silence becomes an alarm; nothing writes it |
| `processed_updates` dedup | unstaged | `BOT-SPEC.md:776` lists it as shipped; lost in the rebuild |
| Keyword normalisation | — | Amends Stage 2's parser; `e-visa` can never match today |
| FAQ ordering column | — | Amends Stage 2's schema and sync; pagination is nondeterministic |
| `backup.sh` fixes | Stage 1 | The launch-blocker backup has never worked |

---

## File structure

**Stage 2.5 — new files**

| File | Responsibility |
|---|---|
| `src/telegram/alerter.ts` | `Alerter` implementation that sends to `OPS_ALERT_CHAT_ID` |
| `src/config/settings.ts` | Typed reader over the `settings` table, 60-second cache |
| `src/worker/job-run.ts` | `recordJobRun(name, interval, fn)` wrapper writing `job_runs` |
| `src/telegram/dedup.ts` | `processed_updates` insert-or-skip |

**Stage 2.5 — modified**

- `src/db/schema.ts` — drop `teachers_identifier_unique`; add `processed_updates`; add `faqEntries.sheetRow`
- `src/sheets/parse.ts` — normalise keywords consistently; capture sheet row
- `src/sync/sheets-sync.ts` — carry `sheetRow` through the upsert
- `src/config/env.ts` — `OPS_ALERT_CHAT_ID`
- `deploy/backup.sh`, `deploy/restore-drill.sh`, `docker-compose.yml`

**Stage 3 — new files**

| File | Responsibility |
|---|---|
| `src/config/privacy.ts` | Notice text + version, interpolating `SUPPORT_CONTACT` |
| `src/faq/scoring.ts` | Pure matching: normalise, tokenize, edit distance, score, select |
| `src/faq/repository.ts` | Queries against `faq_entries` |
| `src/telegram/keyboards.ts` | Every keyboard builder, all routed through `encodeCallback` |
| `src/conversation/state.ts` | Typed conversation state store with read-time expiry |
| `src/conversation/lock.ts` | Per-chat advisory lock — the one lock discipline |
| `src/log/interactions.ts` | `messages` writer with non-optional redaction |
| `src/log/audit.ts` | `audit_log` writer |
| `src/teachers/verify.ts` | Sign-in, duplicate detection, privacy acceptance |
| `src/teachers/repository.ts` | `loadTeacher` — one lookup, full row |
| `src/cases/reference.ts` | `case_sequences` allocation |
| `src/cases/service.ts` | `createCase` / `updateCase` — the single write path |
| `src/cases/urgent.ts` | Code consumption |
| `src/telegram/handlers/*.ts` | Routing per flow |

---

# STAGE 2.5 — Operational floor

### Task 1: Drop the unique index on `teachers.identifier`

Implements D1.

**Files:** Modify `src/db/schema.ts:224`; generate `drizzle/0001_*.sql`

- [ ] **Step 1: Replace the unique index with a plain one**

In `src/db/schema.ts`, replace the `uniqueIndex('teachers_identifier_unique')` entry and its comment with:

```ts
    /**
     * Deliberately NOT unique. BOT-SPEC.md:205: "Duplicate identity bindings are
     * detected, not blocked." Identity here is a recruitment email that
     * colleagues routinely know, so a second binding is a signal for a human,
     * not something to refuse — a teacher switching phones produces exactly this
     * signal, and a unique index would lock them out permanently with no command
     * to release it. It would also let anyone holding a leaked email lock the
     * real teacher out for good. The index serves the duplicate-holder lookup.
     */
    index('teachers_identifier_idx').on(t.identifier),
```

- [ ] **Step 2: Generate the migration**

Run: `npx drizzle-kit generate --name=identifier_detect_not_block`
Expected: a new file under `drizzle/` containing `DROP INDEX "teachers_identifier_unique"` and `CREATE INDEX "teachers_identifier_idx"`.

- [ ] **Step 3: Verify the generated SQL is additive-safe**

Run: `grep -E "DROP|CREATE" drizzle/0001_*.sql`
Expected: only the index drop and create. No table or column drops.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts drizzle && git commit -m "fix: detect duplicate identity bindings rather than blocking them"
```

---

### Task 2: Fix keyword normalisation between the sync and the scorer

The scorer strips punctuation from the query; the sync does not strip it from stored keywords. `e-visa` becomes unmatchable.

**Files:** Modify `src/sheets/parse.ts`; Test `src/sheets/parse.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/sheets/parse.test.ts`:

```ts
it('normalises keyword punctuation the same way the scorer normalises a query', () => {
  const result = parseFaqTab([FAQ_HEADER, faqRow({ KEYWORDS: "e-visa, teacher's contract, work/permit" })]);
  // The scorer strips punctuation from the query, so a stored keyword that
  // keeps its hyphen can never match the token stream it is compared against.
  expect(result.rows[0]?.keywords).toEqual(['e visa', 'teacher s contract', 'work permit']);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/sheets/parse.test.ts -t "normalises keyword punctuation"`
Expected: FAIL — received `['e-visa', "teacher's contract", 'work/permit']`.

- [ ] **Step 3: Export the shared normaliser**

Create `src/faq/normalise.ts`:

```ts
/**
 * The one definition of "same text" in this system.
 *
 * Both sides of every FAQ comparison run through this. In the Apps Script
 * version the query was normalised (QAEngine.gs:155) but stored keywords were
 * only lowercased, so any keyword containing punctuation was compared against a
 * token stream that could never contain it — `e-visa` was permanently dead and
 * nothing reported it.
 */
const PUNCTUATION = /[^\p{L}\p{N}\s]+/gu;

export function normaliseText(value: string): string {
  return value.toLowerCase().replace(PUNCTUATION, ' ').replace(/\s+/g, ' ').trim();
}
```

- [ ] **Step 4: Use it in the parser**

In `src/sheets/parse.ts`, import it and replace the keywords mapping:

```ts
      keywords: cell(raw_row, headers.get('KEYWORDS'))
        .split(',')
        .map((k) => normaliseText(k))
        .filter((k) => k.length > 0),
```

- [ ] **Step 5: Run the suite**

Run: `npx vitest run src/sheets`
Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add src/faq/normalise.ts src/sheets/parse.ts src/sheets/parse.test.ts
git commit -m "fix: normalise FAQ keywords the same way queries are normalised"
```

---

### Task 3: Give the FAQ a deterministic order

Without an ordering column, "Next ➡️" can repeat and skip entries between taps.

**Files:** Modify `src/db/schema.ts`, `src/sheets/parse.ts`, `src/sync/sheets-sync.ts`; Test `src/sheets/parse.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('records the spreadsheet row so listings have a stable order', () => {
  const result = parseFaqTab([FAQ_HEADER, faqRow({ CODE: 'A-1' }), faqRow({ CODE: 'A-2' })]);
  expect(result.rows.map((r) => r.sheetRow)).toEqual([2, 3]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/sheets/parse.test.ts -t "stable order"`
Expected: FAIL — `sheetRow` does not exist on `FaqRow`.

- [ ] **Step 3: Add the field to the parser**

In `src/sheets/parse.ts`, add `readonly sheetRow: number;` to `FaqRow`, and `sheetRow: rowNumber,` to the pushed object.

- [ ] **Step 4: Add the column**

In `src/db/schema.ts`, inside `faqEntries`:

```ts
    /**
     * The row this answer occupies in the spreadsheet.
     *
     * Ordering. The sheet had an implicit order that pagination relied on; SQL
     * without ORDER BY returns rows arbitrarily, so paging a topic could repeat
     * and skip answers between taps. Ordering by code would reorder the bank
     * against the content owner's intent — they arrange the sheet deliberately.
     */
    sheetRow: integer('sheet_row').notNull().default(0),
```

Add `.on(t.topicCode, t.active, t.sheetRow)` to `faq_entries_topic_idx` so the listing query is index-ordered.

- [ ] **Step 5: Carry it through the sync**

In `src/sync/sheets-sync.ts`, add `sheetRow: r.sheetRow,` to the `values` mapping and `sheetRow: sql\`excluded.sheet_row\`,` to the `onConflictDoUpdate` set.

- [ ] **Step 6: Generate the migration and run the suite**

Run: `npx drizzle-kit generate --name=faq_sheet_row && npx vitest run && npx tsc -p tsconfig.json`
Expected: migration adds a defaulted column; all tests pass; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/sheets/parse.ts src/sync/sheets-sync.ts src/sheets/parse.test.ts drizzle
git commit -m "feat: deterministic FAQ ordering from the spreadsheet row"
```

---

### Task 4: Restore `update_id` deduplication

`BOT-SPEC.md:776` lists this as a shipped control. It was lost in the rebuild. Without it a redelivered update files a second case or consumes a second urgent code.

**Files:** Modify `src/db/schema.ts`; Create `src/telegram/dedup.ts`, `src/telegram/dedup.integration.test.ts`

- [ ] **Step 1: Add the table**

```ts
/**
 * Updates already handled.
 *
 * Telegram resends any update it does not get a 2xx for, and the web process is
 * configured to return 200 on timeout (src/web/main.ts) while the handler keeps
 * running — so a redelivery can overlap a still-executing original. The two
 * things a replay corrupts are exactly the teacher-facing ones: a case filed
 * twice, and an urgent code consumed twice.
 */
export const processedUpdates = pgTable('processed_updates', {
  updateId: text('update_id').primaryKey(),
  at: tsz('at').notNull().defaultNow(),
});
```

- [ ] **Step 2: Write the claim function**

Create `src/telegram/dedup.ts`:

```ts
import { sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';

/**
 * Claim an update for processing. False means someone already has it.
 *
 * One statement, so two concurrent deliveries of the same update cannot both
 * win. A SELECT-then-INSERT would reintroduce exactly the race this exists to
 * close.
 */
export async function claimUpdate(db: Database, updateId: number | string): Promise<boolean> {
  const result = await db.execute<{ update_id: string }>(
    sql`INSERT INTO processed_updates (update_id) VALUES (${String(updateId)})
        ON CONFLICT (update_id) DO NOTHING RETURNING update_id`,
  );
  return result.rows.length > 0;
}
```

- [ ] **Step 3: Write the integration test**

In `src/telegram/dedup.integration.test.ts`, mirroring the skip guard in `src/sync/sheets-sync.integration.test.ts`:

```ts
it('lets exactly one caller claim an update', async () => {
  const [first, second] = await Promise.all([claimUpdate(db, 12345), claimUpdate(db, 12345)]);
  expect([first, second].filter(Boolean)).toHaveLength(1);
});
```

- [ ] **Step 4: Generate the migration, typecheck, test**

Run: `npx drizzle-kit generate --name=processed_updates && npx tsc -p tsconfig.json && npx vitest run`
Expected: clean; the integration test skips without `TEST_DATABASE_URL`.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/telegram/dedup.ts src/telegram/dedup.integration.test.ts drizzle
git commit -m "feat: restore update_id deduplication lost in the rebuild"
```

---

### Task 5: Telegram alerter and `OPS_ALERT_CHAT_ID`

Implements the D1 consequence: the alarm must reach a human.

**Files:** Modify `src/config/env.ts`, `.env.example`; Create `src/telegram/alerter.ts`; Test `src/config/env.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('requires an operational alert recipient in production', () => {
  expect(() => loadEnv({ ...valid, NODE_ENV: 'production' })).toThrow(/OPS_ALERT_CHAT_ID/);
});

it('accepts a digits-only chat id', () => {
  expect(loadEnv({ ...valid, OPS_ALERT_CHAT_ID: '123456789' }).OPS_ALERT_CHAT_ID).toBe('123456789');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/config/env.test.ts -t "alert recipient"`
Expected: FAIL — no error thrown.

- [ ] **Step 3: Add the variable**

In `src/config/env.ts`, add to the schema:

```ts
  /**
   * Where operational alarms go until Stage 4 populates the staff table.
   *
   * Every alert this system raises currently lands in a log, which is precisely
   * the failure the concerns register names. Required in production because the
   * duplicate-identity alarm is, by decision D1, the only impersonation control
   * there is — an alarm nobody receives is the same as no alarm.
   */
  OPS_ALERT_CHAT_ID: z.string().trim().regex(/^\d+$/).optional(),
```

and after the `safeParse`, before returning, require it in production:

```ts
  if (parsed.data.NODE_ENV === 'production' && !parsed.data.OPS_ALERT_CHAT_ID) {
    throw new Error(
      'OPS_ALERT_CHAT_ID is required in production. Without it every alarm — including ' +
        'the duplicate-identity alarm, which is the only impersonation control — goes to a log nobody reads.',
    );
  }
```

- [ ] **Step 4: Write the alerter**

Create `src/telegram/alerter.ts`:

```ts
import type { Api } from 'grammy';
import { env } from '../config/env.js';
import type { Alert, Alerter } from '../sync/alerts.js';
import { loggingAlerter, neverThrows } from '../sync/alerts.js';
import { trySend } from './send.js';

/**
 * Sends alerts to the operations chat, and always also logs them.
 *
 * trySend, not send: a failure to deliver an alarm must never abort the
 * operation that raised it. Logging unconditionally means an undelivered alarm
 * still leaves a trace.
 */
export function telegramAlerter(api: Api): Alerter {
  const chatId = env().OPS_ALERT_CHAT_ID;
  return neverThrows({
    async send(alert: Alert): Promise<void> {
      await loggingAlerter.send(alert);
      if (!chatId) return;
      const icon = alert.severity === 'critical' ? '🔴' : '🟠';
      await trySend(api, chatId, `${icon} ${alert.title}\n\n${alert.body}`);
    },
  });
}
```

- [ ] **Step 5: Document it, run the suite, commit**

Add `OPS_ALERT_CHAT_ID=` to `.env.example` with the comment above it.
Run: `npx vitest run && npx tsc -p tsconfig.json`
Expected: PASS, clean.

```bash
git add src/config/env.ts src/config/env.test.ts src/telegram/alerter.ts .env.example
git commit -m "feat: deliver operational alerts to Telegram, not only to a log"
```

---

### Task 6: `settings` reader

Stage 3 needs maintenance mode. Stage 4 keeps the writer.

**Files:** Create `src/config/settings.ts`, `src/config/settings.integration.test.ts`

- [ ] **Step 1: Write it**

```ts
/**
 * Runtime policy, changeable without a deploy.
 *
 * The boundary against env and constants: a setting belongs here only if a
 * named person must be able to change it during an incident or a business
 * decision. Anything that would break a promise made to a teacher, or a legal
 * statement, is a program constant instead — see src/config/constants.ts.
 */
export const SETTING = {
  /** Blocks new case creation. FAQ and Check My Case stay live. */
  MAINTENANCE_MODE: 'MAINTENANCE_MODE',
  /** Days before records are pruned. Owned by MoPSE, consumed in Stage 5. */
  RETENTION_DAYS: 'RETENTION_DAYS',
} as const;
```

with a 60-second cached `getSetting(db, key)` and `isMaintenanceMode(db)`, plus `clearSettingsCache()` for tests. A missing row returns the supplied default rather than throwing — a bot that refuses to serve because a settings row is absent is worse than one that assumes normal operation.

- [ ] **Step 2: Integration test** — set the row, read it, confirm the cache expires.

- [ ] **Step 3: Typecheck, test, commit**

```bash
git add src/config/settings.ts src/config/settings.integration.test.ts
git commit -m "feat: settings reader with a short cache"
```

---

### Task 7: `job_runs` heartbeat

`schema.ts:479` promises silence becomes an alarm. Nothing writes it.

**Files:** Create `src/worker/job-run.ts`; Modify `src/worker/tasks/sync-sheets.ts`, `src/worker/main.ts`

- [ ] **Step 1: Write `recordJobRun(db, name, expectedIntervalSeconds, fn)`** — stamps `lastStartedAt`, then on success `lastSuccessAt` and `consecutiveFailures = 0`, on failure `lastFailureAt`, `lastError` and an increment, then rethrows so graphile-worker still retries.

- [ ] **Step 2: Write `checkHeartbeats(db, alerter)`** — alerts on any row where `lastSuccessAt < now() - expectedIntervalSeconds`, setting `alertedAt` so it does not repeat more than hourly.

- [ ] **Step 3: Wrap the sync task** and add a `heartbeat` cron entry every five minutes to `CRONTAB` in `src/worker/main.ts`.

- [ ] **Step 4: Let the backup report in** — add to `deploy/backup.sh`, after the off-site confirmation:

```bash
psql "$BACKUP_DATABASE_URL" -q -c "INSERT INTO job_runs (job_name, last_success_at, expected_interval_seconds)
  VALUES ('nightly_backup', now(), 108000)
  ON CONFLICT (job_name) DO UPDATE SET last_success_at = now(), consecutive_failures = 0;" \
  || log "WARNING: could not record the backup heartbeat"
```

30 hours, so one missed night alarms. `deploy/backup.sh` already claims the worker's heartbeat covers this; this is what makes the claim true.

- [ ] **Step 5: Typecheck, test, commit**

```bash
git commit -am "feat: job heartbeats so a job that stops running raises an alarm"
```

---

### Task 8: Fix the backup, and bound the logs

The backup has never worked. Two independent faults.

**Files:** Modify `deploy/backup.sh`, `deploy/restore-drill.sh`, `.env.example`, `deploy/README.md`, `docker-compose.yml`

- [ ] **Step 1: Separate the backup connection string**

Host cron cannot resolve `postgres` — that hostname only exists inside the compose network, while Postgres is published on `127.0.0.1:5432`. In both scripts replace `DATABASE_URL` with:

```bash
: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL is required — DATABASE_URL uses the compose hostname \"postgres\", which the host cannot resolve}"
```

Add to `.env.example`:

```
# The host runs the backup, and cannot resolve the compose hostname "postgres".
# Postgres is published on loopback (docker-compose.yml), so point at that.
BACKUP_DATABASE_URL=postgres://mopse:PASSWORD@127.0.0.1:5432/mopse
```

- [ ] **Step 2: Fix the client version**

Ubuntu 24.04 ships `postgresql-client` 16; the server is `postgres:17-alpine`, and `pg_dump` refuses to dump a newer server. In `deploy/README.md` replace the install line:

```bash
sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc --fail https://www.postgresql.org/media/keys/ACCC4CF8.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list
sudo apt-get update && sudo apt-get install -y postgresql-client-17 gnupg rclone
```

- [ ] **Step 3: Add a version assertion to `backup.sh`**

```bash
DUMP_MAJOR="$(pg_dump --version | grep -oE '[0-9]+' | head -1)"
SERVER_MAJOR="$(psql "$BACKUP_DATABASE_URL" -tAc 'SHOW server_version_num' | cut -c1-2)"
[ "$DUMP_MAJOR" -ge "$SERVER_MAJOR" ] || die "pg_dump is $DUMP_MAJOR but the server is $SERVER_MAJOR — pg_dump refuses to dump a newer server. Install postgresql-client-$SERVER_MAJOR."
```

- [ ] **Step 4: Bound the container logs**

`docker-compose.yml` sets no logging limits, so the default `json-file` driver grows without bound. Stage 3 logs every inbound message, and a full 50 GB disk stops Postgres, which stops everything. Add to `web`, `worker` and `postgres`:

```yaml
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "5" }
```

- [ ] **Step 5: Verify and commit**

Run: `bash -n deploy/backup.sh && bash -n deploy/restore-drill.sh`
Expected: both clean.

```bash
git commit -am "fix: the nightly backup could never have run; bound container logs"
```

---

# STAGE 3 — Teachers

## Layer 1 — leaves (no database, no network)

### Task 9: Stage 3 constants

Every one of these is a bare number in the reference with no home yet.

**Files:** Modify `src/config/constants.ts`; Test `src/config/constants.test.ts`

- [ ] **Step 1: Add them, each with its provenance**

`CASE_REFERENCE_PREFIX` (Visa→`VISA`, Travel→`TRAVEL`, Contract→`CONTRACT`, Accommodation→`ACCOM`, Contact Support→`SUPPORT`, Submit Documents→`DOCS`, fallback `CASE`), `CASE_DEDUP_WINDOW_HOURS = 24`, `MAX_VERIFICATION_ATTEMPTS = 5`, `MAX_CASE_DETAIL_ATTEMPTS = 3`, `CONVERSATION_TTL_MINUTES = 30`, `FAQ_PAGE_SIZE = 8`, `FAQ_MAX_PICKER_BUTTONS = 8`, `FAQ_MATCH_MIN_SCORE = 1`, `FAQ_CONFIDENT_SCORE = 2`, `CHECK_MY_CASE_CAP = 10`, `CASE_TOPIC_CHOICES` (the five filing options including `OTHER` → Contact Support).

`URGENT_DETAIL_TTL_HOURS = 24`, **not 6.** Carry this comment:

```ts
/**
 * How long a teacher has to describe an urgent case after their code is
 * accepted.
 *
 * The Apps Script version used six hours, and MenuHandler.gs:28-33 says plainly
 * that six was the ceiling CacheService allowed — not a considered figure. The
 * consequence of it lapsing is a burned single-use code and a teacher who has
 * to phone a Regional admin again. PostgreSQL has no such ceiling, so this is
 * chosen on its merits: a teacher who starts an urgent case in the evening can
 * finish it the next morning.
 */
```

- [ ] **Step 2: Test that every case category has a reference prefix**

```ts
it('maps every case category to a reference prefix', () => {
  for (const category of Object.values(CASE_CATEGORY)) {
    expect(CASE_REFERENCE_PREFIX[category]).toMatch(/^[A-Z]+$/);
  }
});
```

This is the guard against a category being added later with no prefix, which would silently file cases as `CASE-2026-…`.

- [ ] **Step 3: Run, commit**

```bash
git add src/config/constants.ts src/config/constants.test.ts
git commit -m "feat: Stage 3 constants, with the urgent window chosen on merit"
```

---

### Task 10: The FAQ scorer

The single highest-value leaf — where "the bot must never guess" lives (`BOT-SPEC.md:640`). Pure functions over `FaqRow`-shaped input.

**Files:** Create `src/faq/scoring.ts`, `src/faq/scoring.test.ts`

- [ ] **Step 1: Write the tests first**, porting the intent from `QAEngine.gs:155-290`:

```ts
describe('the bot must never guess', () => {
  it('answers directly only on a single confident match', () => { /* … */ });
  it('offers a picker rather than choosing between tied matches', () => { /* … */ });
  it('offers a picker when the best match is below the confidence floor', () => { /* … */ });
  it('returns no match rather than the least-bad answer', () => { /* … */ });
});

describe('typo tolerance', () => {
  it('matches a keyword one character out', () => { /* … */ });
  it('does not match a short word one character out', () => {
    // allowedTypos_ scales with length: 'visa' vs 'lisa' must not match, or
    // every four-letter word matches every other.
  });
});

describe('punctuation', () => {
  it('matches a hyphenated keyword typed without the hyphen', () => {
    // The Task 2 fix, proven from the query side.
  });
});
```

- [ ] **Step 2: Run and watch them fail.** Run: `npx vitest run src/faq`

- [ ] **Step 3: Implement** `tokenize`, `withinEditDistance`, `allowedTypos`, `scoreRow`, and `selectAnswer(query, rows)` returning a discriminated union:

```ts
export type FaqMatch =
  | { kind: 'answer'; row: FaqRow }
  | { kind: 'picker'; rows: readonly FaqRow[]; lowConfidence: boolean }
  | { kind: 'none' };
```

A union rather than a nullable row, so the caller cannot accidentally treat a low-confidence guess as an answer.

- [ ] **Step 4: Run until green. Step 5: Commit.**

```bash
git commit -am "feat: FAQ answer matching, ported with its judgement intact"
```

---

### Task 11: Keyboards, and the extended button-size test

**Files:** Create `src/telegram/keyboards.ts`; Modify `src/telegram/callback-data.ts`, `src/telegram/callback-data.test.ts`

- [ ] **Step 1: Add the two missing callback prefixes**

`ANSWER_HELPFUL: 'OK'` — `BOT-SPEC.md:589` requires the ✅/❌ pair as the content feedback loop, and only `BAD` exists. `QUERY_TOPIC: 'QT'` — `BOT-SPEC.md:588`, the recovery path for a teacher who types a question without picking a topic first, which is the most natural thing they can do.

- [ ] **Step 2: Narrow the case-topic test**

`callback-data.test.ts:24` currently encodes `CASE:` with all eleven FAQ topic codes. Only five are valid filing options (`MenuHandler.gs:274-282`). Change it to iterate `CASE_TOPIC_CHOICES` — a test asserting a wider surface than the design allows is a test that will not notice the design breaking.

- [ ] **Step 3: Build every keyboard through `encodeCallback`**

One module, so the 64-byte ceiling is enforced in one place. `QAEngine.gs:411` had to re-check the limit manually in a second place precisely because it was not.

- [ ] **Step 4: Handle the oversized-code case as a skip, not a throw**

`encodeCallback` throws (`callback-data.ts:76`), where `faqButtonRows_` skipped the row and logged (`QAEngine.gs:343`). One over-long FAQ code would take down an entire topic listing instead of hiding one button — strictly worse than the code being replaced. In the keyboard builder, catch `CallbackDataTooLongError`, omit that button, and alert. The throw stays the default everywhere else.

- [ ] **Step 5: Test that a listing survives one bad code. Step 6: Commit.**

---

### Task 12: Privacy notice text and version

**Files:** Create `src/config/privacy.ts`, `src/config/privacy.test.ts`

- [ ] **Step 1: Write it as a constant, not a setting**

```ts
/**
 * A legal statement about what data is held, so it lives in git where it is
 * reviewed and diffable — the same reasoning as TIMEZONE. An environment
 * variable can be blank, and a blank privacy notice shown immediately before
 * collecting an email address is exactly the failure this is meant to prevent.
 *
 * Bump PRIVACY_NOTICE_VERSION in the same commit as any wording change. The
 * version is recorded against each acceptance, so "who agreed to what" survives
 * a revision — a timestamp alone cannot answer that.
 */
export const PRIVACY_NOTICE_VERSION = '2026-07-28.1';
export function privacyNotice(supportContact: string): string { /* … */ }
```

- [ ] **Step 2: Test that the support contact is interpolated and the version is non-empty. Step 3: Commit.**

---

## Layer 2 — stores (database, no Telegram)

### Task 13: Per-chat advisory lock — the one lock discipline

**Files:** Create `src/conversation/lock.ts`

This exists before the stores because both of them need it and because taking two different locks in two different orders is how deadlocks are written.

- [ ] **Step 1: Write it**

```ts
/**
 * Serialise everything one teacher does, and nothing else.
 *
 * Apps Script had a single global script lock, so every action in the bot
 * queued behind every other action system-wide — its own notes called that the
 * throughput ceiling of the whole bot. A per-chat lock removes the ceiling: two
 * teachers can never block each other.
 *
 * ONE lock, taken in ONE place, at the top of the update handler. Case dedup
 * and conversation state are two tables that both need serialising for the same
 * chat; locking them separately would mean two locks acquired in different
 * orders on different paths, which is the classic deadlock recipe.
 */
export async function withChatLock<T>(db: Database, chatId: string, fn: (tx: Database) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${chatId}))`);
    return fn(tx as Database);
  });
}
```

`pg_advisory_xact_lock` releases with the transaction, so a crashed handler cannot strand a lock.

- [ ] **Step 2: Integration test that two concurrent callers serialise. Step 3: Commit.**

---

### Task 14: Conversation state store

**Files:** Create `src/conversation/state.ts`, `src/conversation/state.integration.test.ts`

- [ ] **Step 1: Define the states as a discriminated union**

```ts
/**
 * Where a teacher is in a conversation.
 *
 * A discriminated union with a typed payload per state, exported from one
 * place. `conversation_states.state` is free text in the database on purpose —
 * so adding a state needs no migration — but an untyped string here would let
 * Stage 6 invent a seventh value that this router silently falls through to
 * "I didn't understand that".
 */
export type ConversationState =
  | { kind: 'AwaitingIdentifier'; attempts: number; resumeAction?: string }
  | { kind: 'AwaitingCaseTopic' }
  | { kind: 'AwaitingCaseDetail'; category: CaseCategory; attempts: number }
  | { kind: 'AwaitingUrgentCode'; attempts: number }
  | { kind: 'AwaitingUrgentDetail'; codeAccepted: string; attempts: number };
```

- [ ] **Step 2: Write the tests**

```ts
it('treats an expired state as absent', async () => { /* D4 */ });
it('returns the main menu for an unrecognised state rather than throwing', async () => {
  // A rollback to older code must not break every teacher mid-conversation.
});
it('does not resurrect an expired state when the sweeper has not run', async () => { /* D4 */ });
```

- [ ] **Step 3: Implement `load`/`save`/`clear`**, with `expires_at > now()` in the read predicate. Never rely on deletion.

- [ ] **Step 4: Run, commit.**

---

### Task 15: Interaction log with non-optional redaction

**Files:** Create `src/log/interactions.ts`, `src/log/audit.ts`, and tests

- [ ] **Step 1: Make redaction impossible to skip**

```ts
/**
 * Writes one row per interaction, redacting by conversation state.
 *
 * The redaction is inside this function, not a parameter, because a parameter
 * is a thing a caller forgets. When a teacher is in AwaitingIdentifier their
 * message IS their email address, and BOT-SPEC.md:255 records that logging it
 * verbatim was found and fixed once already.
 *
 * Never throws. The Apps Script version took a lock to append a log row and
 * gave up after three seconds, discarding entries exactly when the system was
 * busiest — which is when you most want to read them back.
 */
export async function logInteraction(db, chatId, action, detail, state): Promise<void>
```

- [ ] **Step 2: Test the case that matters most**

```ts
it('redacts the identifier when the teacher is signing in', async () => {
  await logInteraction(db, '1', 'RECEIVED_MESSAGE', 'a.karimov@example.com', { kind: 'AwaitingIdentifier', attempts: 1 });
  expect(rows[0].detail).toBe('a***@example.com');
});

it('redacts when the state has EXPIRED, not only when it is present', async () => {
  // The subtle one. If the state lookup misses because it expired, a teacher
  // typing their email late gets it logged verbatim — defeating the redaction
  // exactly as it was defeated before. Absent state must be treated as
  // potentially-sensitive for free-text messages, not as safe.
});
```

- [ ] **Step 3: Implement. Step 4: Run, commit.**

---

### Task 16: Case reference allocation

**Files:** Create `src/cases/reference.ts`, integration test

- [ ] **Step 1: One statement, upsert not update**

```sql
INSERT INTO case_sequences (prefix, year, last_value) VALUES ($1, $2, 1)
ON CONFLICT (prefix, year) DO UPDATE SET last_value = case_sequences.last_value + 1
RETURNING last_value
```

`INSERT … ON CONFLICT`, not `UPDATE`: there are no seed rows, so an `UPDATE` would silently affect zero rows for the first case of every prefix in every new year.

- [ ] **Step 2: Test that concurrent allocation never reissues a reference.** Gaps are acceptable and expected; reuse is not. Document that so nobody "tidies" the counter.

- [ ] **Step 3: Commit.**

---

## Layer 3 — flows

### Task 17: Sign-in, duplicate detection, privacy acceptance

Implements D1 and D3.

**Files:** Create `src/teachers/repository.ts`, `src/teachers/verify.ts`, integration tests

- [ ] **Step 1: Write the tests**

```ts
it('verifies a teacher whose identifier is on the roster', async () => { /* … */ });

it('refuses an identifier whose roster row has been deactivated', async () => {
  // The roster sync deactivates, never deletes. Removing a teacher from the
  // sheet is what every operator will assume revokes access — without this
  // check it does nothing at all.
});

it('allows a second Telegram account to bind, and alarms', async () => {
  // D1. Detected, not blocked.
});

it('tells the prior holder that someone else has verified', async () => { /* … */ });

it('records the privacy notice version in the same transaction as the bind', async () => {
  // Otherwise a teacher is Verified with no recorded acceptance and the column
  // proves nothing.
});

it('copies the region from the roster', async () => {
  // Stage 4's entire region axis reads teachers.region, and bind time is the
  // only moment it is ever populated. Omitting it makes half of Stage 4's
  // permission model structurally dead.
});

it('consumes an attempt when the identifier is not on the roster', async () => { /* … */ });

it('does NOT consume an attempt for a teacher re-verifying their own identity', async () => {
  // Distinguish roster-miss from your-own-account, or an operator fixing a
  // sheet can lock out the very teacher they are fixing.
});
```

- [ ] **Step 2: Implement**, reading duplicate holders before the write, alarming after the transaction commits.

- [ ] **Step 3: Run, commit.**

---

### Task 18: Menus, FAQ browsing, answer feedback

**Files:** Create `src/telegram/handlers/menu.ts`, `src/telegram/handlers/faq.ts`, `src/faq/repository.ts`

- [ ] **Step 1: Filter `active` on the answer lookup too**

The sheet read filtered `ACTIVE = TRUE` before anything saw a row; `faq_entries` keeps deactivated rows. Without `AND active = true` on the `ANS:<code>` handler, a stale button in a teacher's scrollback still delivers an answer content owners deliberately withdrew.

- [ ] **Step 2: Order every listing by `sheetRow`** (Task 3), with `code` as the tiebreak so a picker built from a tie is stable between taps.

- [ ] **Step 3: Acknowledge the callback query FIRST**, before resolving anything. `Webhook.gs:225` documents this as a real defect: a stale button spins forever otherwise.

- [ ] **Step 4: Tests** — a withdrawn answer is unreachable; paging is stable across a sync; an unknown topic code falls back to the menu rather than throwing.

- [ ] **Step 5: Commit.**

---

### Task 19: Case creation, the 24-hour window, Check My Case

**Files:** Create `src/cases/service.ts`, `src/telegram/handlers/cases.ts`

- [ ] **Step 1: One write path**

`createCase` and `updateCase(reference, fields, actor)`, with `reference`, `category`, `teacherChatId` and `createdAt` non-writable, and `updatedAt`/`lastActor` set by the function. Stage 4 mutates cases, Stage 5 escalates, Stage 6 files document cases. `DEPENDENCY_TREE.md:750` records that the Apps Script version had to retrofit exactly this after callers hand-rolled their own writes.

- [ ] **Step 2: Keep the application-level verified check**

The foreign key proves a `teachers` row exists, not that its state is `Verified` — an unverified chat that reached the identifier prompt already has a row. Dropping the check because "the database handles it" would make the guardrail weaker while looking stronger.

- [ ] **Step 3: Dedup and insert in one transaction under the chat lock**

- [ ] **Step 4: Never echo `detail` back**

`getCasesForChatId` strips it (`CaseManager.gs:173`). Check My Case shows reference, category, status and public update only.

- [ ] **Step 5: Tests** — a double-tap creates one case; dedup returns the same reference; `detail` never appears in a teacher-facing message or a log row.

- [ ] **Step 6: Commit.**

---

### Task 20: Urgent cases

Implements D5.

**Files:** Create `src/cases/urgent.ts`, `src/telegram/handlers/urgent.ts`

- [ ] **Step 1: Consume in one statement, inside the case transaction**

```sql
UPDATE urgent_codes SET used_at = now(), used_by = $1, case_reference = $2
WHERE code = $3 AND used_at IS NULL AND expires_at > now()
RETURNING code
```

`rowCount = 0` covers used, expired and nonexistent alike — which is also correct behaviour, since distinguishing them for the teacher leaks whether a code exists.

- [ ] **Step 2: Consume on the deduplicated path too**

The dedup path can legitimately return an existing case, and that path must still consume the code — the escalation is what the code bought, and `BOT-SPEC.md:7.3` says urgent+deduplicated is the common path. Test this explicitly; it is the easiest thing in this stage to get silently wrong.

- [ ] **Step 3: Cap urgent-code attempts**

Apps Script deleted the code whether valid or not, so a guessed code was burned on use. A conditional `UPDATE` leaves an invalid code untouched, so it can be retried without limit — a six-character space is brute-forceable at leisure. No document mentions this; add a per-chat cap.

- [ ] **Step 4: Add `urgent_codes.case_reference`** and a heartbeat check for codes consumed over an hour ago with no case, so a stranded teacher is visible.

- [ ] **Step 5: Tests** — a code cannot be used twice; a restart between consumption and detail resumes correctly; an expired code is refused; the deduplicated path consumes.

- [ ] **Step 6: Commit.**

---

### Task 21: Wire the router

**Files:** Modify `src/telegram/bot.ts`

- [ ] **Step 1: Middleware order, which is itself the design**

1. `claimUpdate` — stop immediately if already handled (Task 4)
2. `withChatLock` — one lock, one place (Task 13)
3. Load conversation state once, and pass it down. `loggableMessageText_` (`Webhook.gs:149`) reads the state on every inbound message purely to choose a redaction; that must be the *same* read, not a second query, and it must happen before any handler mutates it.
4. Log the interaction
5. Dispatch

- [ ] **Step 2: Commit before you speak**

The transaction commits, then the Telegram send happens. A failed send after a successful commit is recoverable — the case exists and Check My Case will show it — but must alert, because the teacher believes nothing happened. A failed commit after a confirmation message is unrecoverable.

- [ ] **Step 3: Register `/privacy` and `/help` before any catch-all text handler.**

- [ ] **Step 4: Honour maintenance mode** on case creation only. FAQ and Check My Case stay live (`BOT-SPEC.md:172`).

- [ ] **Step 5: Full suite, typecheck, build, commit.**

---

### Task 22: Update the documentation this stage invalidates

Not optional. `RUNBOOK.md` §4.1 currently tells staff an FAQ edit *"goes live immediately — the edit clears the cache"*. It now takes up to ten minutes. Uncorrected, staff file that as a bug on day one.

- [ ] **Step 1: `BOT-SPEC.md`** — §5.1 verification caching (delete: no cache, no epoch), §6.6 urgent lifecycle (every mechanism named is wrong), §7.2 reference generation, §8.1 state machine, §8.3 callback protocol (**already wrong today** — every prefix differs from `src/telegram/callback-data.ts`), §12 concurrency (the whole lock table is obsolete), §13 security.
- [ ] **Step 2: `RUNBOOK.md`** — §4.1/§4.2 the ten-minute delay, §4.4 revoking a teacher, §4.6 urgent codes, PART 3 smoke test (rewrite; add restart-mid-conversation and double-tap steps, which the old runbook could not test because state lived in memory).
- [ ] **Step 3: `CONCERNS-AND-IT-ACTIONS.md`** — close A2 and A9; rewrite A5, A7, A8, B7, B8; **promote B2's retention half into Part A** — it is now purely a privacy commitment with no technical excuse left; **rewrite B4** rather than closing it, because its true current form is "no integration test has ever run against a real PostgreSQL."
- [ ] **Step 4: Commit.**

---

## Deploy-day checklist

Migrate before serving, always. The schema must be at least as new as the newest running process — new code against an old schema errors on every teacher message, and `bot.catch` turns that into *silence* rather than an error, which is the worst possible failure shape.

```bash
docker compose build web worker
docker compose stop web worker
docker compose run --rm --no-deps web node dist/db/migrate.js   # not `exec` — nothing serving
docker compose up -d worker    # worker first: catches crash-loop-on-old-schema while nobody is served
docker compose up -d web
```

**Rollback is code-only.** Drizzle is forward-only; `drizzle/meta/_journal.json` is append-only and there are no down migrations. That works only because every migration in this plan is additive. Prove it on deploy day, before any teacher is served, by booting the previous image against the new schema — free then, impossible later.

**Add one permanent roster row** so the smoke test is repeatable on every future deploy with no cleanup:

| IDENTIFIER | NAME | REGION |
|---|---|---|
| `deploy-check@mopse.uz` | Deployment Check | Tashkent |

Permanent because removing it would not remove the bound `teachers` row anyway — the sync only deactivates, and the case foreign key is `ON DELETE RESTRICT`.

The three smoke-test steps that matter most, because they were impossible to test before:

1. **Restart mid-conversation.** Start Contact Support, `docker compose restart web` before typing the detail, then type it. The case must file correctly.
2. **Double-tap.** Tap confirm twice fast. One case, not two.
3. **Duplicate identity.** Verify the same identifier from a second account. The binding is allowed, the first chat gets a security notice, and `OPS_ALERT_CHAT_ID` receives a message. If the alert does not arrive, the observability work is not done.

---

## Open items this plan deliberately does not close

- **`RETENTION_DAYS` is still unset.** Stage 3 is what starts filling `messages`, so the decision is now on the clock. The privacy notice already promises removal.
- **Erasure is blocked by the database.** `cases.teacher_chat_id` is `ON DELETE RESTRICT`, so a teacher who has ever opened a case cannot be deleted. Honouring the notice's removal promise needs a deliberate anonymisation path, which is Stage 4 or later — but it is now a database-enforced obstacle, not merely an unimplemented feature.
- **Data is collected before the notice is shown.** FAQ browsing is open to anyone and every inbound message writes a `messages` row. Apps Script had the identical flaw; the difference is that `privacy_notice_accepted_at` now makes it *auditable* — messages whose chat has a null acceptance are a directly queryable list.
