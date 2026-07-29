# Stage 4 handoff — 29 July 2026

Written at the end of a session that took Stage 4 from "planned, no code" to "Layers 1 and 2
complete". Read this before touching anything; then read
`docs/plans/2026-07-28-stage-4-staff.md`, which is the plan and is now accurate.

---

## 1. State, in one paragraph

Stage 3 (teachers) shipped as `d743d72`. This session settled the three answers that were
blocking Stage 4, then built every store, rule and query the staff commands will need. **Layers 1
and 2 are done and committed. Layer 3 — the commands themselves — has not been started.** The
working tree is clean at `231e61e`.

```
495 tests, 35 files, none skipped · typecheck clean · build clean
```

Verify it yourself before trusting it — see §6.

## 2. Commits this session

| Commit | What |
|---|---|
| `5551c10` | Layer 1: role ladder, queue map, parser. The migration. The `/` log rule. Three answers made permanent |
| `c894f6e` | Staff repository, region resolution, and nine corrections to the plan |
| `aab86a5` | Layer 2 complete: visibility, queries, notes, importance, revocation |
| `231e61e` | R10's fix pulled forward; one shape for all case queries |

## 3. The three answers, now permanent

Asked as one question at the start of the session and answered immediately. All three are
recorded in the plan as **D7** and **D25**.

- **The observer rank is `Observer`.** "Jstaff" was considered and dropped.
- **The rank `Regional` is renamed `Lead`.** Region remains a separate column. The teacher-facing
  phrase "Regional admin" is MoPSE's job title for a person and is **deliberately left alone** in
  `src/cases/urgent.ts`, `src/telegram/handlers/urgent.ts` and `RUNBOOK.md`. Do not "fix" it.
- **The eight case statuses stay; four commands write four of them** (D25).

Both enum changes are in the database now. Changing either from here is a migration and a
retraining.

## 4. What is built, and the four things that will bite if you forget them

Layer 1 and 2 are listed with their files in the plan's "Where this stands" table. Four properties
are load-bearing and not obvious from reading the code:

**`visibleToStaff` only works with both joins.** INNER `teachers`, LEFT `roster_entries`. The LEFT
is not a detail — a teacher whose roster row was removed still has cases, and an INNER join hides
them from everybody, which is the exact failure the predicate exists to prevent. A query missing
the joins fails loudly at the database, which is the good outcome, but the fragment cannot enforce
it. `src/cases/queries.ts` has them in one place; copy that.

**`teacherHasAccess` is the gate now**, not `verificationState === 'Verified'`. Anything new that
gates on being signed in must use it, or it silently skips the roster re-check and reintroduces
the fault Task 30 just closed.

**A JS array cannot be interpolated into a `sql` template.** Drizzle expands `${arr}` into a
parameter list — `($1, $2)` — not an array literal, so `= ANY(${arr})` is a syntax error and a
`::text[]` cast does not rescue it. Use `inArray()`. This has now cost three faults in this
codebase; it is documented at the top of `src/staff/visibility.ts`.

**`db.execute` does not parse types.** A `timestamptz` comes back as a string. The query builder
does parse. Format in SQL when using raw execute.

## 5. Deliberate departures from the plan

Each is explained in a comment at the site. Do not revert them.

1. **`purpose` on `OutgoingMessage` was built now, not at Task 39.** Task 32 creates the second
   kind of multi-recipient message, and Task 39 was seven tasks later — leaving a window where a
   failed staff notification alerted an operator as a duplicate sign-in. **Task 32 must set
   `purpose` on every notification it emits.**
2. **All five case queries return `{ cases, total }`,** including the two that cannot exceed the
   cap. Uniformity beats the marginal honesty of a bare array when layer 3 calls all five.
3. **`staleCases` reads `OVERDUE_DAYS` itself** rather than taking it as an argument, so "return
   nothing when unset" cannot be forgotten by a caller. Same reasoning as `redactDetail`.
4. **`findCase` lives in `queries.ts`, not `service.ts`.** It needs the visibility scope; `service.ts`
   is the write path.
5. **The migration's enum statements are hand-written.** `drizzle-kit` generated a `DROP TYPE` and
   recreate, which passes on an empty test database and breaks on a server with data. If a future
   `generate` re-emits it, hand-fix it the same way — the snapshot in `drizzle/meta/` is correct.
6. **`requireSignIn` refuses a revoked teacher rather than prompting them to sign in.** Prompting
   sent them round a loop `verifyIdentifier` refuses at the end, and — worse — signing in again
   clears `revoked_at`, so a revoked teacher could undo their own revocation.

## 6. Running anything

The test database is a container **with no volume**. It does not survive a `down` or a Docker
restart, and it did not exist at the start of this session.

```bash
docker compose -f "D:\Telegram Bot server\docker-compose.test.yml" up -d
```

Wait for health before running the suite — the global setup connects immediately:

```bash
docker inspect --format "{{.State.Health.Status}}" mopse-test-postgres-1
```

Then, in PowerShell:

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run
```

`docker` **is** on the PATH — Docker Desktop 4.84 installs per-user at
`%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin\docker.exe`, which is why
`C:\Program Files\Docker\` is empty. Do not call it through `wsl`; that distro refuses.

**A run reporting ~183 skipped tests means the database is down**, not that the tests are fine. A
skipped test is not a passing test.

## 7. What to do next

**Task 31 — the dispatcher, the deny path and `/whoami`.** Then **Task 32**, which closes the last
of the four audit faults: today a teacher files a case and nothing anywhere is told.

Build order from here, unchanged from the plan:

```
31 · 32 · 33 · 34 · 35 · 45 · 46 · 36 · 37 · 38 · 39(partly done) · 41
```

Two things in Task 31 that are easy to get wrong, both already argued in D9:

- A teacher mid-way through describing a case who types something starting with `/` must **keep
  their text**. Under the Apps Script rule they lost it and were told they are not an admin.
- A non-staff sender is **not told the command exists**. The denial is logged as `STAFF_DENIED`
  and the message falls through to ordinary handling.

## 8. Open questions for the head of project

1. **Retention for ordinary cases and the message log.** The only one of the original four answers
   still open. Belongs to Stage 5, blocks nothing now. Do not let anyone write a default in — the
   test that fails on one is still there.
2. **D25's `Action required` mapping.** "Approved or processing" has no exact home among the eight
   statuses; it is mapped to `Action required` and the runbook will define that as "accepted and
   being worked". If MoPSE reads it as *the teacher* must act, that one row changes and nothing
   else does. Cheap until Task 34 ships.
3. **There is no way to restore a revoked teacher from inside the bot.** Revoking the wrong person
   currently means editing the database. The plan never specified a counterpart to `/revoke`. My
   recommendation is a restore command in Task 36, because revoking the wrong teacher is an
   ordinary mistake and reaching for the database is not an ordinary recovery. **Not yet decided.**

## 9. How this project is run

- **The head of project is not an engineer.** Plain English, no jargon; recommend rather than
  survey; correct a wrong premise directly rather than working around it.
- **Do not commit per task.** Work through a stage uncommitted and offer once at a boundary. They
  ask for commits directly — "commit" — and that is the standing pattern.
- **Verify before claiming done.** Tests, typecheck, build, with the numbers stated plainly. This
  project has repeatedly found faults in code that was written, reviewed and committed the day
  before, and every one was found by running something rather than by reading.
- **The artifact** at `https://claude.ai/code/artifact/64bce4b9-a63e-4dee-a883-9b0ecb457b53` is
  their document, in plain English. Update it **in place** by passing that URL as `url`. Never
  mint a new one.
