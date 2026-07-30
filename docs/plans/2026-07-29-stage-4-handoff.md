# Handoff — 30 July 2026

**This document is rewritten in place at the end of every session. There is one of it, and it is
current. If you are reading a copy of this content anywhere else, that copy is stale.**

Read this in full before touching anything, then read `docs/plans/2026-07-30-stage-5-scheduled-work.md`,
which opens with a "Where this stands" table naming every task and its state.

> **The filename still says stage 4.** That is historical and deliberate: there is one handoff, it
> is this file, and it is rewritten in place whatever stage is current. Rename it if you like, but
> do it as its own change and update the references in `docs/plans/2026-07-28-stage-4-staff.md`.

---

## 1. State, in one paragraph

**Stage 4 is complete. Stage 5 is planned, and Layers 0, 1 and 2 of it are built and committed.**
Every rule the stage needs — retention, re-consent, the generated privacy notice, anonymisation,
announcements, the teacher chase — is written and tested. **None of it is reachable by a person or a
clock.** No command, no scheduled job, and no teacher-visible change has shipped. That is the
correct half-way state for a leaves-first build; nothing is half-built.

```
922 tests, 56 files, none skipped · typecheck clean · build clean · deps:check clean
```

Verify it yourself before trusting it — see §7. Do not take the numbers above on trust; this
document has been wrong before and the only reason it is not wrong now is that somebody ran things.

**Next: Task 61.** The build order and every task's state are in the Stage 5 plan's table.

## 2. Commits, oldest first

Stage 4 ran `d743d72..807284c` and is not re-listed; `git log --oneline d743d72..807284c` has it.

| Commit | What |
|---|---|
| `807284c` | End of Stage 4 — task 41, every document the stage made wrong |
| `b3112b0` `d38c639` | Documentation only: the Stage 4 handoff and its pointer at Stage 5 |
| `1f9f5ca` | **The Stage 5 plan.** Three questions answered, five faults found before any code |
| `cb791f2` | **Stage 5 Layers 0, 1 and 2** — tasks 47–55 and 57–60 |

## 3. The answers that decide what got built

**Six from Stage 4** are recorded in that plan as D7, D25, D26, D27, D28, with R16–R18 tracing the
last three. They are settled. **Do not reopen them and do not improve them.** In short: `Observer`
is the look-but-do-not-touch rank and `Regional` is now `Lead`; the eight case statuses stay and
staff type four of them; `Action required` means the **teacher** must act; `/close … unresolved`
exists with a hand-written reason; `/restore` exists; and retention is 7 days / 180 for urgent and
critical / 3 for the interaction log / never for the audit log, **as three settings rather than
constants**.

**Three more were answered on 30 July**, while the Stage 5 plan was being written. All three are
recorded at the top of that plan with their costs.

- **The nightly content roll-up: no.** Nothing is built for it. The cost stands and is written down
  twice so nobody rediscovers it in November: past three days, *what are teachers asking that the
  answer bank cannot cover* and *which confident answers are they rejecting* cannot be answered at
  all. **Task 71 must record in the runbook that §4.7 was offered and declined**, not merely
  deleted — a section that reads as an oversight is one somebody restores by accident, and a
  restored §4.7 returns nothing and looks like good news.
- **The bot names a teacher's regional manager: yes, by name and Telegram username.** Not a
  telephone number. It needed `staff.telegram_username`, which is why it had to be settled before
  the migration. **The handle is verified rather than trusted** — see D47 and R33.
- **The re-consent gate stands in front of cases and leaves the answer bank open.** The
  recommended option, and the only one that produces a record saying a named teacher confirmed a
  specific version on a specific date.

**One correction worth carrying, from Stage 4.** I proposed exempting the answer-feedback rows from
the 3-day rule and was told **"plan supersedes my choices!"** Three days means three days for every
row.

## 4. What is built in Stage 5, and the eight things that will bite

| Task | What | File |
|---|---|---|
| 47 | The migration | `drizzle/0008_retention_and_chasing.sql` |
| 48 | Retention periods, and the re-consent rule | `src/config/retention.ts` |
| 49 | The notice, generated | `src/config/privacy.ts` |
| 50 | The CSV writer | `src/export/csv.ts` |
| 51 | `sendDocument` | `src/telegram/send.ts` |
| 52 | Every message the jobs will send | `src/digest/format.ts` |
| 53 | Announcement audiences | `src/announcements/audience.ts` |
| 54 | Reading the three periods | `src/config/settings.ts` |
| 55 | Every delete and the one scrub | `src/retention/purge.ts` |
| 57 | What a teacher accepted | `src/teachers/privacy.ts` |
| 58 | Anonymising a teacher | `src/teachers/forget.ts` |
| 59 | The announcement store | `src/announcements/store.ts` |
| 60 | The chase queries and the counter reset | `cases/queries.ts`, `cases/service.ts` |

**`privacyNotice` takes the periods and renders them. Never type a number of days into
`privacy.ts`.** A test reads that module's own source and fails if you do. The whole design rests on
the notice being unable to disagree with the settings, and a literal that happens to match today
passes every other test and fails the day somebody changes a period.

**`requiresReconsent` is asymmetric on purpose. Do not replace it with a hash.** Lengthening a
period asks 1,800 teachers to read the notice again; shortening one must not. Any digest of the
notice text changes in both directions. `null` means indefinite and is the longest period there is,
in every direction and at every layer.

**Every purge function returns 0 and touches nothing when its period is `null`.** That is not
defensive coding, it is the rule (D30): a job that invents a retention period deletes real records
against a number nobody chose, and there is no undo. A `0`, a typo and an empty string all become
`null` in `parsePeriod`. **The first test in `purge.integration.test.ts` is the one asserting
nothing is deleted, and it is first deliberately.**

**The purge reads `importance` and never `status`.** A `Critical` case that was resolved is
`Completed`, and nothing about `Completed` remembers it was an emergency. There is a test.

**`deleteResolvedCases` takes no reference and must never take one** (D35). A delete that took one
would be reachable from a command, and a command that can delete a case by reference is a command
that deletes the wrong case, with `case_notes` cascading out from under it.

**The chase counters reset inside `updateCase`, beside `closed_at`.** Not in `/await`. Leaving
`Action required` and re-entering it both restart the clock, and `updateCase` is the one write path
that sees every status change — putting it in the command is the exact hole that let a reopened case
keep a stale `closed_at` for three stages.

**`casesAwaitingTeacher` and `casesExhaustedChasing` are the only unscoped functions in
`queries.ts`.** That file's guarantee is about a *person* asking; these feed a job and there is
nobody whose visibility applies. Both say so at their definition. Anything that later hands their
rows to a staff member must apply the scope itself.

**`bindTeacher` writes the accepted periods.** Without it every teacher who signs in is asked to
re-accept on their very next tap, having accepted moments earlier. `/restore` must **not** touch
those columns — restoring is undoing one act, not re-running a sign-in (D27). Both have tests.

**The audience freeze must not alias its tables.** `audienceWhere` is built from drizzle column
references that render fully qualified, and an alias makes them unresolvable. See §6.

## 5. Deliberate departures from the Stage 5 plan — four so far

Each is explained at the site. **Do not revert them.** Stage 4's own twenty-six are listed in
`docs/plans/2026-07-28-stage-4-staff.md`'s history and in the Stage 4 sections of this file's
predecessor; they remain in force and are not repeated here.

1. **Task 54 was pulled forward** out of the stated build order. Task 49 changes `privacyNotice`'s
   signature and its callers cannot compile without the settings reader — the two are one change,
   and splitting them leaves typecheck broken across a task boundary.
2. **`SETTING` spreads `RETENTION_SETTING` from `retention.ts`** rather than declaring the three
   keys a second time. Two lists that must agree with nothing enforcing it is the fault `status.ts`
   was created to fix.
3. **`forgetTeacher` reports three outcomes, not two.** `alreadyForgotten` is kept apart from
   `notFound`, because reporting the latter for somebody removed last month sends an operator
   looking for a row that is behaving correctly.
4. **The chase tests are a new file**, `src/cases/chase.integration.test.ts`. The reset lives in
   `service.ts` and the queries in `queries.ts`, so either existing home would have split one
   behaviour across two files.

Also: the three `RETENTION_DAYS` tests in `settings.integration.test.ts` are **re-pointed at
`OVERDUE_DAYS` rather than deleted** — what they pin is the reader, and all three behaviours are
still worth having. And `RETENTION_DAYS` itself is **deleted, not renamed** (D34).

## 6. Faults found by building

**Two in Stage 5, both by running things.**

**The audience freeze did not run at all.** `audienceWhere` renders drizzle column references as
fully-qualified `"teachers"."verification_state"`, and the `INSERT … SELECT` around it had aliased
its tables as `t` and `r` — so PostgreSQL could not resolve the names and rejected the statement
outright. Every test in the file failed at once. The same class of trap `visibility.ts` documents
one row along: it fails at the database, where neither the typechecker nor a reading can see it.

**`delivery_state` had no `Sending` value, and the plan assumed one.** Without it a recipient cannot
be *claimed*, so two overlapping sweeps would both read the same `Pending` rows and message that
teacher twice — the one failure a broadcast to 1,800 people must not have. Added to `0008` as
`ALTER TYPE … ADD VALUE`, which is additive and safe inside the migration transaction on PG 17. The
migration was regenerated and both paths reproven. **This was a schema change the plan did not
anticipate**, and it is recorded in the plan's own table rather than folded quietly into D45.

**Five more were found before any code was written**, by reading the system closely enough to plan
against it. All five are handled in the plan and are traced as R22–R26. The two that matter most for
what is still to build:

- **`graphile-worker` matches its crontab in UTC** (`getUTCHours` in `dist/cron.js`), whatever
  `TZ: Asia/Tashkent` in `docker-compose.yml` says. Both existing entries are intervals, so nothing
  has hit it. **The digest is the first absolute-time job in this system.** 07:00 Tashkent is
  `0 2 * * *`. `constants.ts` warns about this exact failure in these exact words.
- **`recordJobRun` must never wrap on-demand work.** `checkHeartbeats` alarms on any `job_runs` row
  whose last success is older than 1.5× its interval, so an announcement job would raise a critical
  alarm every hour in which nobody sent an announcement. Announcements are driven by a **scheduled
  sweeper** instead, which is also what makes a restart mid-broadcast resume rather than repeat.

**Stage 4's three faults in already-committed code** — a revoked teacher restoring their own access,
a reopened case keeping its `closed_at`, and the status vocabulary existing three times — are fixed
and are described in `docs/plans/2026-07-28-stage-4-staff.md`. The `closed_at` one is why Stage 5's
retention can measure from that column at all.

All of them are the same lesson: **these are found by running things and by needing to use them,
never by reading.**

## 7. Running anything

The test database is a container **with no volume**. It does not survive a `down` or a Docker
restart, so assume it is not running.

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

**A run reporting hundreds of skips proved nothing** — that is the exact shape of a no-database run,
and this project has been misled by it before. A real run reports **0 skipped**.

**Docker Desktop can be *paused*.** A run then hangs with no output at all. Check with
`docker desktop status` — if it says `paused`, **`docker desktop start` does NOT unpause it**. Only
the tray icon or the Dashboard does, and `docker desktop restart` would tear down the test database.
Ask the head of project to click Resume. `starting` is different and resolves itself.

`docker` **is** on the PATH. Do not call it through `wsl`; that distro refuses.

**Use the git that is already installed.** The Bash tool in this environment *is* their Git Bash.
Never install another.

### One intermittent failure, observed once and not reproduced

**`src/staff/repository.integration.test.ts` → `reports a duplicate as a duplicate when two callers
race` failed once**, on 30 July, and has passed in every full run since — including three today. The
assertion text was not captured, which is the reason this note is vague and is itself the lesson.
The likeliest cause is the loser getting an error code other than `23505`, which `addStaff` rethrows
rather than converting. **If it recurs, widen the `catch` to name whatever code actually arrived**
rather than loosening the assertion.

### If you touch the schema

`npx drizzle-kit generate` and then **read the SQL it emitted before accepting it.** It has emitted a
destructive `DROP TYPE`/recreate in this repository once already. Rename the file from its generated
nonsense to match the convention, and change the `tag` in `drizzle/meta/_journal.json` to match.

Then prove the **deploy** path, not only the incremental one, because the server applies every
migration to a database that has none:

```bash
docker exec mopse-test-postgres-1 psql -U mopse -d mopse_test -c "CREATE DATABASE mopse_migrate_check"
TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_migrate_check' node --experimental-strip-types \
  -e "import('./src/test/global-setup.ts').then(m => m.setup()).then(() => console.log('OK'))"
docker exec mopse-test-postgres-1 psql -U mopse -d mopse_migrate_check -c "\d cases"
docker exec mopse-test-postgres-1 psql -U mopse -d mopse_test -c "DROP DATABASE mopse_migrate_check"
```

**If you regenerate a migration that has already been applied locally, drop and rebuild
`mopse_test`.** Drizzle tracks migrations by hash, so a regenerated file is a new migration and its
`ADD COLUMN`s fail against a database that already has them. The test database has no volume, so
rebuilding it costs nothing:

```bash
docker exec mopse-test-postgres-1 psql -U mopse -d postgres -c "DROP DATABASE mopse_test"
docker exec mopse-test-postgres-1 psql -U mopse -d postgres -c "CREATE DATABASE mopse_test"
```

## 8. What to do next — Task 61 onward

**The plan is written and its build order is stated. Follow it top to bottom.** What remains is
Layer 3 (six commands), Layer 4 (three scheduled jobs), the optional layer checker, and the
documentation pass.

`61 · 62 · 63 · 64 · 65 · 66 · 67 · 68 · 69 · 70? · 71`

**Task 56 is not built** (the roll-up, declined) and its number is kept in place so that a reference
to a task number still means what it said.

### The four things not to get wrong, restated because they are what is left

**Retention is one release or it is a lie.** The job, the three settings, the rewritten notice, the
bumped version and the re-consent flow ship together. The first four are built; the gate (Task 65)
and the job (Task 67) are not. **Nothing may deploy until both are.**

**The crontab is UTC.** 07:00 Tashkent is `0 2 * * *`. Assert the arithmetic in a test rather than
in a comment.

**Only scheduled work calls `recordJobRun`.** Announcements are swept, never enqueued.

**Chasing chases the teacher.** The queries already do; the job must not re-derive who to message.

### Where the documentation stands

**`BOT-SPEC.md`, `RUNBOOK.md` and `CONCERNS-AND-IT-ACTIONS.md` are still correct as of Stage 4 and
must not be edited before Task 71.** They are corrected once, at the end, in one pass, as task 41
was — a document edited a little at a time as code lands describes a system half-way between two
states. **Anything Stage 5 makes wrong is a documentation item in the Stage 5 plan**, and Task 71's
checklist there is already written from the work done so far. `src/config/privacy.ts` is the one
exception, because it is code; it has already been rewritten and ships with the job.

### The dependency graph

```
npm run deps          → writes docs/dependency-tree.md
npm run deps:check    → silent, exits non-zero on a cycle, an unresolvable
                        import, or a file nothing uses
```

**Current state: 72 source files, 56 test files, no cycles, no unresolved imports, nothing unused.**
Run `npm run deps` after adding files and commit the regenerated document — **Task 71 step 4 does
this and it has not been done yet**, so `docs/dependency-tree.md` is currently stale at 64 source
files. `deps:check` passes regardless; it computes the graph rather than reading the document.

**Task 70 would give the layer rule a checker.** It is droppable and nothing depends on it.

### Two tools, both settled — do not spend time on either

**`dependency-cruiser` cannot work here yet.** It needs `typescript@7.1.0` and `latest` is `7.0.2`.
Installed on 29 July, it cruised **0 modules while printing a green tick** and was removed. Do not
install a nightly TypeScript to make a linter run, and do not downgrade it either.

```bash
npm view typescript version   # 7.1.0 or above → dependency-cruiser can work here
```

**`repowise` is rejected. The head of project's words were "ignore repowise forever".** This is a
closed decision: do not propose it, do not re-test it, do not mention it.

## 9. Open questions

**None.** Nine have been answered across the project — four original, two during Stage 4, three
during Stage 5 planning. If a new one arises, **ask; do not assume, and do not decide it yourself.**

Two things are still waiting on MoPSE, and neither is a decision about how the software behaves:
whether the privacy notice says the right things — **now urgent, because the rewritten notice is
already in the code and re-consent has not yet shipped, so reviewing it now still means one round
of re-consent instead of two** — and whether sign-in should be reconsidered before launch, which
expires at launch by itself. Both are in the artifact (§11) under "what we need from you".

**The launch gate is off engineering.** `RUNBOOK.md` §1.4 is the checklist and none of it is code.

## 10. How this project is run

- **The head of project is not an engineer.** Plain English, no jargon; recommend rather than
  survey; correct a wrong premise directly rather than working around it.
- **Do not commit per task.** Work through, offer once at a boundary; they say "commit" and that is
  the standing pattern. A fix to already-committed code gets its own `fix:` commit, separate from
  the feature that found it. When two tasks are committed together, split them properly — and
  **verify each commit stands on its own rather than only the tip**.
- **Verify before claiming done.** Tests, typecheck, build, with the numbers stated plainly. This
  project has repeatedly found faults in code that was written, reviewed and committed the day
  before, and every one was found by running something rather than by reading.
- **Their answers are decisions, not opening positions.** Raise a concern once, then build what was
  asked and record the cost.
- **Say what you did not do.** A gap named in this document is cheap; a gap discovered in November
  is not.

## 11. Ending a session — the three things that must be current

Do all three **before** saying the session is finished.

**1. This document, rewritten in place.** Not patched — rewritten. It has been amended five times in
a single session before, and the result contradicted itself in three places.

> **This is the only document rewritten in place, and that is the whole point of it.** Everything
> else is either a record of finished work — the stage plans — or a description of the running
> system. A stage's plan goes in **a new document**; the three specification documents are corrected
> **once, at the end of a stage, in one pass**. This file plus the current stage's plan is the whole
> briefing.

**2. The plan's "Where this stands" table**, at the top of
`docs/plans/2026-07-30-stage-5-scheduled-work.md`, plus the checkboxes on any task that was finished,
with its commit hash.

**3. The artifact — `https://claude.ai/code/artifact/64bce4b9-a63e-4dee-a883-9b0ecb457b53`.**

> **It is the head of project's document, not an input to this one.** Do not read it to get up to
> speed and do not copy anything out of it. It flows one way — from what was actually built, to them.

Update it **in place** by passing that URL as `url`. Never mint a new one; favicon 🤖, keep it.
**Currently v10, covering Stage 4 in full and Stage 5 through Layer 2.**

The mechanism, because getting it wrong costs a whole rewrite:

- `WebFetch` the URL. It saves the full HTML to a local file and prints the path.
- Strip the `<!doctype>`/`<head>` frame wrapper and the trailing `</body></html>`. What remains —
  starting at `<title>` — is what gets republished.
- **Edit the remainder; never rewrite it from scratch.** The design system and every section you are
  not touching survive intact that way.
- Bump the version in **four** places — the sidebar, the masthead eyebrow, the footer's "Version N",
  and the footer's prose — and update the six numbers in the metrics row. State only figures that
  were actually run.
- Republish with `url` set and the same favicon.

What belongs in it, in their words rather than the code's: what a person can now *do* that they
could not before; anything that changes what a teacher sees; every fault found, including the ones
in already-committed code; anything that cost more than the plan said it would; and what is still
waiting on MoPSE. What does not belong: file names, function names, task numbers as the *subject* of
a sentence, or any figure nobody ran.
