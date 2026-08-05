# The Ministry case record: the bot writes cases to a spreadsheet — the design

**Date:** 5 August 2026 · **Status: designed, not built.** Belongs to
`2026-08-01-identity-and-urgent-design.md`, which stays the plan of record.

> Asked for by the head of project on 5 August 2026. Their words for what it is, because they settle
> the whole design:
>
> *"it is a record for the ministry that we can notify the workers on basically, so it is a
> spreedsheet, we can then grant edi permission later"*
>
> And on the audience, paraphrased: the Ministry staff who will read this are not comfortable with
> unfamiliar tools and will resist anything new — including the bot itself, at first. **A spreadsheet
> is not a compromise here. It is the requirement.** It is the one interface this audience already
> trusts, and the design should not try to talk them out of it.

---

## 1. What is true today

The bot reads the spreadsheet and never writes to it. That is not an accident of implementation; it
is stated in three places and enforced in one:

- `sheets/client.ts` requests the scope `spreadsheets.readonly`, so the token it holds is incapable
  of writing anywhere at all.
- The service account is meant to hold **Viewer** on the one spreadsheet, so even a token that could
  write would have nowhere to write to.
- `sync/sheets-sync.ts` says why: the spreadsheet owns the FAQ bank and the roster, the database owns
  everything else, and information flows one way so the two can never disagree about which copy is
  correct.

There is already a way to get cases out: `/export` builds a CSV of the cases visible to the asker and
sends it as a Telegram file (D43). **That is not what is being asked for.** A file that lands in one
person's chat is not a record the Ministry can be pointed at, and the point of this work is that
there is a place a Ministry worker can be sent to and told: it is all in there, it is current, and
nobody had to prepare it for you.

## 2. The decisions

### D48 — A second spreadsheet, not a second tab

**Decision:** the cases go in a **new spreadsheet of their own**. The service account gets **Editor**
on that one and **stays Viewer** on the FAQ/roster sheet.

**Why not a tab in the existing sheet**, which would be one link instead of two and therefore
friendlier to exactly the audience described above: because granting Editor on that file would put the
teacher roster inside the blast radius of every future bug in the writing code. The roster is what
decides whether a teacher can use the bot at all. A tab is a saving of one bookmark; the separation
is what makes a whole class of accident impossible rather than merely unlikely.

**This is the load-bearing decision of the design.** Everything below assumes the bot's write
permission reaches exactly one file that nothing else depends on.

### D49 — One service account, not two

**Decision:** reuse the existing service account. It requests the read/write `spreadsheets` scope for
the writing path and keeps `spreadsheets.readonly` for the reading path.

**The honest version of what that scope means:** OAuth scopes are per-token, not per-file. A
read/write token is not restricted to the case spreadsheet by anything Google is told at
authentication time. **The restriction is the Drive sharing**, and only that: the account is Editor
on the new file and Viewer on the old one, so a write aimed at the wrong spreadsheet id fails with a
permission error instead of damaging the roster.

**Why not a second service account**, which would make the separation absolute: because it is another
private key to store, rotate, and lose, and the sharing model already gives the property that
matters. Recorded here so that whoever later asks "why is one account allowed to write?" finds the
reasoning rather than an oversight.

### D50 — What a row contains, and the cost of it

**Decision:** eleven columns — **Reference, Teacher, Region, Category, Status, Importance, Owner,
Created, Updated, Due, Closed.**

That is `/export`'s column list (D43) **plus the teacher's name**, and the addition was asked for
directly after the cost was put in front of the head of project. **Still no teacher's words** — not
`detail`, not `public_update`. D43's reasoning holds unchanged and holds harder here: a Google
spreadsheet is more forwardable than a CSV, not less, and it has no retention job behind it at all.

**The cost, stated once and then built anyway, because it was asked for after being told:**

1. **Retention cannot reach it.** A finished case is deleted from the database after seven days, and
   an urgent or critical one after six months. Its row in the spreadsheet stays for ever. For a
   *record* that is the intended behaviour; it is written here so nobody discovers it and calls it a
   bug.
2. **`/forget` becomes a two-part job.** `forgetTeacher` clears the teacher's name from the database
   and cannot touch a Google Sheet. Erasing a teacher who asks to be erased now also requires a
   person to open the spreadsheet and delete their rows by hand. **This goes in the runbook**, next
   to D44's existing list of what `/forget` cannot remove — that section exists precisely because
   honest limits belong somewhere a person reads rather than somewhere they find out.

### D51 — One row per case, updated in place

**Decision:** one row per case, rewritten as the case changes. Not an append-only history.

**Why:** the audience is the argument. A sheet where the same case appears five times is one where
counting anything requires knowing to ignore four of them, and the readers of this file are the last
people who should be asked to do that. The current state of every case, one line each, is a thing
anybody can read.

**What is lost:** the trail. You cannot see from this sheet that a case sat untouched for two days
before somebody picked it up. That history is in the database and in `/case`, and if the Ministry
ever asks for response-time reporting, a second tab is the answer — not a redesign of this one.

### D52 — The row is found by its reference, never by a remembered row number

**Decision:** each cycle reads column A of the `CASES` tab, builds reference → row number, and writes
against that. **No row number is stored in the database.**

**Why this is not the obvious optimisation it looks like:** a stored row number is correct until
somebody sorts the sheet, inserts a row above, or deletes one — all of which are ordinary things to
do to a spreadsheet, all of which are invisible to the bot, and any of which would make the next
write land on **the wrong case**. Writing a resolved status onto somebody else's case is the worst
outcome this feature has available to it, and one extra read per cycle is the entire price of making
it impossible.

### D53 — It rides on the existing ten-minute sync

**Decision:** the write runs inside `SYNC_SHEETS_TASK`, after the reads, on the same `*/10` schedule.
A case appears in the record within ten minutes.

**Why not on every change:** every case change would become a call to Google inside the request path,
which puts a Google outage in front of a teacher raising a case. The record is downstream of the bot
and must stay there.

**Why not nightly:** the head of project's phrase was *"notify the workers on"* — the sheet is meant
to be something people look at during the day, not a morning-after report.

**One caution carried forward from `sync-sheets.ts`:** the worker is `concurrency: 1`, and that file
already warns that the form-response sync is the part whose cost grows and can starve the five-minute
heartbeat. This adds two more round trips to Google on the same schedule. Two is small; it is not
zero, and this is the second entry on that list.

### D54 — Only changed cases, tracked by a column

**Decision:** `cases` gains **`exported_at`** (`timestamptz`, nullable). A case needs writing when
`exported_at` is null, or older than `updated_at`. It is stamped after Google confirms the write.

**Why a column rather than a high-water mark** on `sync_runs`: a watermark of "last exported up to
time T" loses any case whose `updated_at` falls in the same instant as the cut, and quietly — the row
is simply never written and nothing reports it. A per-case column has no such edge, and it answers
"has this one been written?" directly instead of by inference.

**Why it is stamped after the write and not before:** a failed write leaves `exported_at` untouched,
so the next cycle retries it on its own. Nothing needs to remember that something went wrong.

**A cap of 1,000 rows per cycle**, so the first run — which writes every case that already exists —
is spread over a few cycles rather than becoming one enormous request. The backfill finishes by
itself and needs nobody to start it.

### D55 — A failed write never fails the sync

**Decision:** a failure of the case-record write is logged, alerted through the existing `Alerter`,
and recorded as its own `sync_runs` row with source `CASE_RECORD`. **It does not throw**, so it does
not mark `sync_sheets` failed and does not cause the FAQ and roster syncs to be retried.

**Why:** the FAQ reaching teachers within ten minutes is a promise made to staff. The Ministry record
being ten minutes late is not a promise made to anyone. They must not be able to break each other,
and this is the same reasoning that already keeps FAQ, ROSTER and FORMS apart with
`Promise.allSettled`.

`sync_runs.source` is a plain text column, so the new source needs no migration.

### D56 — Values are written RAW, and that is a safety decision

**Decision:** every write uses `valueInputOption=RAW`.

**Why:** `USER_ENTERED` makes Google parse each cell the way it would if a person had typed it — so a
teacher whose name begins `=` becomes a live formula in a spreadsheet the Ministry is reading.
`export/csv.ts` already carries a whole paragraph about this class of fault for the CSV path;
`RAW` is the equivalent for this one, and it is a single parameter rather than an escaping rule
somebody has to remember to apply.

Dates are written as **text**, formatted `YYYY-MM-DD HH:MM` in **Asia/Tashkent** — the same rendering
every other timestamp in this project gets, for the same reason: a reader in Tashkent should not be
doing arithmetic, and a date left to Google is a date re-interpreted by whatever locale opens it.

## 3. What a person sees

A spreadsheet with three tabs. It is built and handed over **before** any code is written, so the
Ministry contact can be set up while the work happens.

**`CASES`** — the eleven columns of D50, header row frozen, filters on, and drop-downs on Category,
Status and Importance listing exactly the values the bot uses. The bot writes here and nothing else
does.

**`SUMMARY`** — counts that maintain themselves: total, still open, finished, and breakdowns by
status, by importance and by category. Ordinary `COUNTIF` over the `CASES` tab, so it keeps working
as rows arrive. It looks across the first 5,000 rows; past that the ranges have to be widened, and
the tab says so on its own face.

**`GUIDE`** — what the file is, what each column means, one example row so the shape is obvious, and
the request not to type into `CASES`.

**Two things about the handover that will break it silently if missed**, and both belong in the
runbook:

1. **It must be converted to a real Google Sheet.** An `.xlsx` sitting in Drive is a different kind of
   object and the Sheets API cannot write to it at all.
2. **The tab must stay named `CASES` and the headers must stay on row 1.** That is how the writer
   finds its place. Everything else about the file is the Ministry's to change.

## 4. What changes

Layers per `CLAUDE.md` §2. Nothing here goes near `telegram/`, so the layer rule is not under
pressure — the whole feature lives in layer 2 with one layer-4 caller.

| File | Layer | Responsibility |
|---|---|---|
| `src/sheets/writer.ts` | 2 | **Create.** `SheetWriter` — authenticate with the read/write scope, read a column, append rows, update rows. `RAW` (D56). Knows nothing about cases |
| `src/sync/case-record.ts` | 2 | **Create.** Chooses the cases needing a write, builds their rows, calls the writer, stamps `exported_at`, records the `sync_runs` row, alerts on failure (D55) |
| `src/db/schema.ts` | 2 | **Modify.** `cases.exported_at` plus an index supporting the "needs writing" predicate |
| `drizzle/00NN_case_record_export.sql` | — | **Create** via `drizzle-kit generate`. Additive only. Read the generated SQL before accepting it |
| `src/cases/queries.ts` | 2 | **Modify.** A query for cases needing export. **Deliberately unscoped** — see below |
| `src/config/env.ts` | 1 | **Modify.** `GOOGLE_CASE_SHEET_ID`, optional. Absent means the feature is simply off |
| `src/worker/tasks/sync-sheets.ts` | 4 | **Modify.** Run the record write after the reads, sequentially, swallowing its failure (D55) |
| `docs/dependency-tree.md` | — | **Regenerate** with `npm run deps` and commit alongside |
| `RUNBOOK.md` | — | Setup steps, the two silent-failure traps of §3, and the `/forget` manual step of D50 |
| `BOT-SPEC.md` | — | What the bot now does |

**The unscoped query, named because it is a departure.** Every staff-facing read applies
`visibleToStaff`. This one cannot: a scheduled job is not a person and has no region. The precedent
is the retention job, which reads cases the same way for the same reason. It is called only from the
worker, it returns rows that go to one fixed spreadsheet, and it must never acquire a second caller —
which is the thing to watch for in review, because an unscoped case query is exactly the shape of a
future permission fault.

## 5. What proves it works

Integration tests against real PostgreSQL with a fake `SheetWriter`, because every interesting
property here is about state surviving a cycle:

- The first run writes every existing case. The second writes nothing.
- A case that changes is rewritten; its row number does not move.
- A new case is appended.
- **Rows reordered in the sheet between cycles** — the update still lands on the right case (D52).
  This is the test the whole design of D52 exists for.
- A write that fails leaves `exported_at` untouched, and the next cycle retries it.
- A failed write does not throw out of the sync task, and the FAQ sync beside it still applies (D55).
- The 1,000-row cap holds, and a backfill of more than that finishes across cycles.
- A teacher named `=cmd()` arrives in the sheet as text (D56).
- No path deletes a row.

Unit tests on `writer.ts` with a fake `fetch`: the request carries `RAW`, chunking is correct, and a
non-2xx response from Google raises an error naming the spreadsheet and the likely cause, the way
`client.ts` already does.

## 6. What is not being done

**The bot does not read anything back.** Nobody edits a case in the spreadsheet and has the bot
notice.

**And when that is asked for — it is a separate piece of work, not an extension of this one.** The
moment both sides can change a case, something has to decide who wins when they disagree, and the
answer cannot be "whoever wrote last": a Ministry worker who sorts a column, pastes over a cell, or
leaves a stray keystroke would silently reopen a closed case or move it to another region. Every
existing rule in this project — the scoped lookup, the capability check, the conditional `UPDATE` —
exists because a change to a case has to come from a person who was allowed to make it, and a
spreadsheet edit carries no evidence of who made it or whether they could. That is the work, and it
is worth doing deliberately if MoPSE asks.

**No response-time or workload reporting.** The SUMMARY tab counts; it does not measure. See D51.

**No per-region or per-month files.** One spreadsheet, growing. Creating files would need Drive
permission on top of Sheets, which is a wider grant than this feature needs.
