# Runbook ↔ code audit

**Date:** 31 July 2026 · **Base commit:** `333646a` · **Status:** complete, all six findings fixed

**One finding was a missing feature, not a missing paragraph.** F1 — `/staff_region` —
is now built, tested and documented. The other five were documentation drift, all
corrected. **The most useful result is the one that is not a finding:** every SQL
statement in the runbook was executed against a real PostgreSQL and every one
worked, which is a stronger claim than any amount of reading.

Both directions, because only one of them is usually checked:

1. **Does the code keep every promise the runbook makes?** A procedure that names a
   command nobody built is worse than no procedure — it is read under pressure, by
   somebody who then believes the system is broken.
2. **Does the runbook describe everything the code does?** A behaviour nobody wrote
   down is a behaviour nobody can operate, and at 3am it is indistinguishable from
   a fault.

Nothing here is inherited. Every finding was produced by reading the code at
`333646a` and the runbook beside it.

---

## Findings

### 🔴 F1. `/staff_region` does not exist, and the regions plan depends on it

**`RUNBOOK.md` §2.6, line 410** tells the operator to set which regions a staff
member covers with *"`/staff_add`, or `/staff_region` afterwards"*.

**There is no `/staff_region` command.** `grep -rn "staff_region" src/` returns
nothing at all.

**And there is no other way to do it either.** `staff.regions` is written in
exactly one place — `addStaff` — and nothing updates it afterwards:

| Command | Touches `regions`? |
|---|---|
| `/staff_add` | ✅ writes them, once, at creation |
| `/staff_role` | ❌ `setStaffRole` sets `role` and `active` only |
| `/staff_remove` | ❌ deactivates; the row and its regions stay |
| `/region` | ❌ that is a **teacher's** region |
| `/regions` | ❌ that lists teacher-raised region flags |

`/staff_remove` then `/staff_add` does not work as a way round: `addStaff` throws
`StaffAlreadyExistsError` when a row exists **active or not**.

**So a staff member's regions can be set at creation, or by hand in SQL, and by no
other route.**

**Why this is severe rather than untidy.** §2.6's own note says regions are being
entered **after launch, on purpose**, and the handoff records the consequence: an
empty `regions` array means *every* region, so until they are entered every staff
member covers the whole country. **The documented plan — add staff now, set their
regions later — cannot be carried out with the commands that exist.**

It also fails silently in the direction that looks fine: nobody gets an error,
everybody just sees every region's cases, which looks like working software.

**Fix:** build `/staff_region`, at the rank that already governs staff changes. It
is a small command — one repository function and one parser, and `parseRegions`
already exists in `commands/staff.ts` and is already used by `/staff_add`.

---

### 🟠 F2. §4.12's ten-minute line is what Stage 6 made wrong

*"Every ten minutes — The spreadsheet is copied in — **answers and roster**."*

That is now incomplete in a way that matters. The same job also syncs the `FORMS`
tab **and reads every form's submissions back**. An operator following §4.18 is
told to "wait ten minutes" and check for a case — and §4.12, which is the page
that explains what happens on its own, does not say submissions are on that
schedule at all.

**Also:** §4.12 says "four things" and the crontab has **five** entries. The fifth
is the five-minute heartbeat. That one is defensible — §4.12 describes it as the
thing that raises the alarm rather than as a scheduled job — but the count is
wrong on its face.

### 🟠 F3. The crontab's own comment is stale the same way

`src/worker/main.ts` heads the ten-minute entry *"Copy the FAQ bank and the teacher
roster out of the spreadsheet."* Stage 6 added two more things to that job and did
not update the comment above it. The next person reading the crontab to find out
what runs will get the pre-Stage-6 answer.

### 🔵 F4. Teachers are asked to confirm their region, and nothing says how often

`REGION_CONFIRM_AFTER_DAYS = 180`. A verified teacher is asked whether the region
we hold is still right, at most every 180 days.

**The number appears in neither `RUNBOOK.md` nor `BOT-SPEC.md`.** §4.10 explains
what a `/regions` flag *is* and where it comes from, which is the important half —
but an operator watching flags arrive cannot tell whether the trickle is expected
or a fault without knowing the cadence. §1.5, the list of what teachers see, does
not mention the prompt at all.

### 🔵 F5. §4.11 does not say `/retention` is System-only

`/retention` holds `MAINTENANCE`, which floors at **System**. §4.6b's table does
not mark it, and §4.11 — the section devoted to it — does not either. Low severity
only because the refusal names the rank that is missing.

### 🔵 F6. §2.6 calls itself "the one list" and omits the backup variables

`BACKUP_PASSPHRASE`, `BACKUP_REMOTE` and `BACKUP_DATABASE_URL` are required before
backups work at all, and A5 of `CONCERNS` calls the untested backup a launch
blocker. They are in `.env.example` and in `deploy/README.md`, and `backup.sh`
refuses to run without them **with a message naming each** — so this is not a
silent failure, which is exactly what §2.6 is a list of. Defensible as it stands;
a one-line cross-reference would close it.

---

## Checked and correct

Recorded so the next audit does not redo them.

- **Every staff command named in the runbook exists in the code with that exact
  name**, except F1. Cross-checked both directions by extracting `/…` tokens from
  the runbook and `name: '/…'` from `src/telegram/commands/`.
- **`/pretend`** appears in the code but is a **test fixture** in
  `dispatch.integration.test.ts`, not a command. Not a gap.
- **`/config`, `/deploy`, `/healthz`, `/migrate`, `/scripts`, `/set`, `/sync`** read
  as commands to a naive grep but are paths, endpoints and npm scripts. Not gaps.
- **All 18 alarm titles** the code can emit are now indexed in `RUNBOOK.md` §5.0 by
  their exact text. Verified by extracting every `title:` from `src/`.
- **Every SQL snippet in the runbook was executed against a real PostgreSQL** —
  all nineteen lines, every `INSERT`, `SELECT` and `DELETE`, with the placeholders
  filled in and the effects reversed afterwards. **Zero errors.** Reading the
  schema would not have proved this; running it did.
- **All five setting keys** (`CASE_RETENTION_DAYS`, `URGENT_CASE_RETENTION_DAYS`,
  `MESSAGE_RETENTION_DAYS`, `MAINTENANCE_MODE`, `OVERDUE_DAYS`) exist in the code
  and are named in the runbook.
- **All eleven environment variables** are in `.env.example`, and
  `deploy/README.md` says to copy it. The runbook naming only one is correct
  delegation, not a gap.
- **Every rank claim in §4.6b is right.** `/forget`, `/staff*` and `/maintenance`
  are genuinely System; checked against `FLOOR` in `staff/roles.ts`.
- **`/announce_send` really does refuse anybody but the author** —
  `row.createdBy !== ctx.member.telegramId` at `commands/announce.ts:261`. The
  runbook's "Only the person who wrote it" is exact.
- **`deploy/backup.sh` and `deploy/restore-drill.sh` both exist**, and
  `deploy/README.md` schedules the first at 02:30 by system cron, matching §4.9.
- **`/pretend`** is a test fixture, not a command.

### ⚠️ One thing that looks like a finding and must NOT be "fixed"

**"Regional admin" in §1.5 is correct and deliberate.** The rank called `Regional`
was renamed `Lead` in Stage 5, so the phrase reads like a leftover. It is not:
`BOT-SPEC.md` §6 says in terms that **"Regional admin" is MoPSE's job title for a
person and is left exactly as it is** — it was never the rank name, and separating
the two is the entire point of the rename. *"Do not 'correct' it."*

Recorded here because I nearly did, and the next audit will nearly do the same.

---

## What was done about each

| # | Finding | Fix |
|---|---|---|
| **F1** | `/staff_region` promised, never built | **Built.** `setStaffRegions` in `staff/repository.ts`, the command in `commands/staff.ts`, **6 integration tests**, and entries in RUNBOOK §2.6 and §4.6b and BOT-SPEC §6.4 and its two capability tables |
| **F2** | §4.12 said "answers and roster", and "four things" | Now five, and the ten-minute line names the form links **and** the submissions being read back, with a pointer to §4.18 |
| **F3** | Stale crontab comment | `worker/main.ts` now says what that job actually does |
| **F4** | Region prompt cadence undocumented | §4.10 now says **at most once every 180 days**, and that a trickle of flags is what working looks like |
| **F5** | `/retention`'s rank unstated | §4.6b now says System only |
| **F6** | Backup variables off "the one list" | §2.6 now carries a note saying why they are absent and where they live |

### On F1, because it is the one worth remembering

**It had no symptom.** An empty `regions` array means *every* region, deliberately.
So a system where nobody could set regions did not produce an error, a warning or
a wrong-looking screen — it produced staff who all saw the whole country, which is
exactly what the system does on purpose before regions are entered.

The only reason it surfaced is that the runbook named a command and the command
list did not have it. **A documentation audit found a code defect**, which is the
argument for doing this in both directions rather than one.

### Verified after the fixes

```
1,140 tests across 64 files · 0 failed · 0 skipped
typecheck clean · build clean · deps:check clean · lint 0 warnings
```

**One thing worth recording about the run itself.** The first attempt at the new
tests reported **23 skipped** because I forgot `TEST_DATABASE_URL` — the exact
no-database shape §7 of the handoff warns about. A skipped test is not a passing
test, and it took a second look to notice.

