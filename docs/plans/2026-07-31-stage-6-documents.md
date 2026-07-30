# Stage 6 — Documents

**Date:** 31 July 2026 · **Status:** plan, not started · **Base commit:** `286c778`

The last stage of the rebuild. D24 keeps documents in Google Forms and cancels the planned
Telegram upload, so this stage adds the half that is missing — a third spreadsheet tab that
carries the form links, and a sync that reads what people submitted and files it under the right
teacher — and it adds no file handling anywhere.

**The bot never accepts, holds or stores a file. That is the whole shape of this stage.**

---

## 0. Corrections to the handoff, found before planning

The handoff's §8 lists four things as "already in place, so the stage adds the missing half rather
than a new model". **Two of the four are wrong, and both make Stage 6 bigger than it looks.**
Checked against the tree at `286c778`.

| Handoff says | The tree says | Verdict |
|---|---|---|
| `CASE_CATEGORY.SUBMIT_DOCS` exists, `queueForCategory` total over it | `constants.ts:35`, `queues.ts:61` → `QUEUE.ALL` | ✅ **True** |
| `sendDocument` exists and is the only half of document handling | Stage 5, for `/export` | ✅ **True** |
| **"The menu button … already exist[s]"** | `keyboards.ts:78`: *"Submit Documents is absent until Stage 6"*. `mainMenuKeyboard()` builds seven rows and none of them is Submit Documents | ❌ **False. The button does not exist and is Stage 6's to build** |
| **"`MAINTENANCE_MODE` pauses Submit Documents alongside Contact Support and Urgent Case"** | `isMaintenanceMode()` exists and the router checks it when a case is started and when a topic is chosen. There is no Submit Documents path, so nothing about it is gated | ⚠️ **Half true.** The mechanism exists; the wiring cannot exist yet and is Stage 6's |

**Two things the handoff did not claim, which are true and which shrink the stage:**

- **`CALLBACK.DOC_TYPE = 'DOC'` already exists** at `callback-data.ts:44`, unused. The callback
  prefix Stage 6 needs is reserved and tested.
- **`sync_runs.source` is a plain `text` column**, not a Postgres enum (`schema.ts:894`). Adding
  `FORMS` as a sync source needs **no migration at all**. Only the two new tables do.

**Nothing else in §8 was found wrong.** The two prohibitions — no `UNRESOLVED:` sentinel, no
`FORM_URLS` and no prefill — are correct and are honoured below.

---

## 1. The pipeline, downward: spreadsheet → teacher

What has to exist for a teacher to see a working form button, in the order the data moves.

| # | Stage | Exists? | Stage 6 work |
|---|---|---|---|
| 1 | A `FORMS` tab in the spreadsheet MoPSE already owns | ❌ | **MoPSE action**, not code. §6 |
| 2 | `SHEET_TABS` names it | ❌ `client.ts:18` has FAQ and ROSTER only | One line |
| 3 | `parseFormsTab` — reject a bad row with its number, keep the rest | ❌ | New, modelled exactly on `parseRosterTab` |
| 4 | A table to hold them (`form_links`) | ❌ | Migration `0009` |
| 5 | `syncForms` — transactional, damage-limited, records a `sync_runs` row | ❌ | New, modelled exactly on `syncRoster` |
| 6 | The scheduled sync runs it beside the other two | ❌ `sync-sheets.ts:40` settles two promises | Third promise |
| 7 | A repository read: the active forms, in sheet order | ❌ | New |
| 8 | A menu button | ❌ **`keyboards.ts:78` says absent** | New |
| 9 | A callback route listing the forms as buttons | ❌ | New. `CALLBACK.DOC_TYPE` is already reserved |
| 10 | The maintenance gate covering it | ⚠️ mechanism only | Wire it |

## 2. The pipeline, upward: teacher → form → case

This is the half that does not resemble anything already built, and it is where the risk is.

| # | Stage | Exists? | Stage 6 work |
|---|---|---|---|
| 1 | The teacher opens the link and submits Google's form | n/a | Nothing. **The bot is not involved and must not be** |
| 2 | Google writes a row into a responses tab | n/a | **MoPSE action** — every form's responses must land in the spreadsheet the bot already reads. §6, and this is a blocker |
| 3 | The bot reads that tab | ❌ | New |
| 4 | The row's email is matched to `roster_entries.identifier` | ❌ | New. **This is D24's identity mechanism and it replaces the prefill entirely** |
| 5 | The roster identifier resolves to a `teachers.chat_id` | ⚠️ | `teachers.identifier` → `teachers.chatId` (`schema.ts:295`). **The join exists. The teacher may not.** See Q1 |
| 6 | A case is filed under that teacher | ⚠️ | `createCase` exists and takes a `chatId`. See Q3 |
| 7 | The same row never files a second case | ❌ | New. **The single hardest requirement in the stage.** §4 |
| 8 | A row that matched nobody reaches a person | ❌ | The `Alerter` exists (`sync/alerts.ts`) and is the right vehicle |

**Why step 7 is the hard one.** Every other sync in this system is idempotent by construction: it
upserts on a natural key and deactivates what it did not see. A response row is not a record to be
kept up to date — it is an **event**, and re-reading it must not re-fire it. Nothing in this
codebase does that yet. The announcement sweeper is the nearest thing and it claims rows in the
database it already owns.

---

## 3. Decisions, with their costs

**D38 — `form_links` is a spreadsheet-owned table, exactly like `faq_entries` and
`roster_entries`.** Primary key is the form's type code. Carries `sheetRow` so listings keep the
order the content owner arranged, the way `faq_entries` does.
*Cost:* a fourth table under the damage limit, and a fourth thing a bad sheet edit can switch off.
*Why:* it obeys the ownership rule the whole system is built on — the spreadsheet owns what the bot
reads and says. A form link is content. It is also precisely why the Apps Script version failed:
seven links sat in code as `PLACEHOLDER_VISA` until the feature was abandoned, because changing one
needed a developer.

**D39 — the FORMS tab names its own responses tab, in a column.** One extra column,
`RESPONSES_TAB`.
*Cost:* a row is only half-usable if that cell is wrong, and the failure is invisible until somebody
submits.
*Why:* the alternative is a naming convention the bot derives, and a convention nobody can see is
the `FORM_URLS` mistake wearing a different hat. Naming it makes it correctable in ten minutes by
the person who owns the sheet. **A row whose `RESPONSES_TAB` is blank still renders its button** —
teachers can submit; the bot simply will not read the answers back. That is a deliberate split, and
it is what lets MoPSE publish a form before the plumbing is finished rather than after.

**D40 — submissions are recorded in their own table, and that table is the idempotency key.**
`form_submissions`, unique on `(form_type, sheet_row)`.
*Cost:* one table that only grows, and a hard dependency on response rows never being deleted or
reordered — which is true of a Google Forms responses tab that nobody edits by hand, and false the
moment somebody does. This goes in the runbook as a "do not do this" with the consequence spelled
out: **deleting a row shifts every row below it up by one, and the bot will re-file all of them.**
*Why:* the row number is the only stable identifier Google gives us. A content hash would survive
deletion but would collide legitimately — two teachers submitting the same form on the same day
with the same answers is normal.

**D41 — an unreadable responses tab is a warning, not a failure.** If `RESPONSES_TAB` names a tab
that does not exist, that one form is reported and the others still sync.
*Cost:* a permanently misconfigured form alerts every ten minutes.
*Why:* it is the same rule as row rejection, one level up, and the alternative is one typo stopping
every form's submissions from being read.

**D42 — the response sync is a separate `sync_runs` source from the link sync.** `FORMS` for the
tab, `FORM_RESPONSES` for the answers.
*Cost:* two rows per cycle instead of one.
*Why:* they fail for completely different reasons and one must not mask the other, which is the
same reasoning that keeps FAQ and ROSTER apart at `sync-sheets.ts:40`. No migration is needed for
either — the column is text.

**D43 — the menu button is added and the comment at `keyboards.ts:78` is corrected in the same
change.** That comment is load-bearing documentation and it will be wrong the moment the button
appears.

---

## 4. What must not be built

Restated from the handoff because each has a specific trap.

- **No `UNRESOLVED:` sentinel.** `cases.teacher_chat_id` is a non-null FK with a digits check, so
  it cannot be stored. Under D24 nothing produces one, because identity comes from the roster
  email. Do not write a branch for a state that is both forbidden and unreachable.
- **No `FORM_URLS` and no prefill.** Google Forms has no hidden fields; the Apps Script prefill was
  a visible editable box that could never be trusted as identity.
- **No receive path on `sendDocument`.** It exists for `/export` and stays one-directional.
- **No file storage, no `documents` table, no Drive export.** Design doc §11.
- **`queueForCategory` stays total.** Do not let the digest or the export enumerate categories.

---

## 5. The four questions, answered 31 July 2026

All four were put to the head of project before any code was written, and all four are settled.
**These are decisions, not opening positions. Do not improve them.**

**Q1 — a teacher submits a form, their email IS on the roster, but they have never opened the bot.**
There is no `teachers` row and therefore no chat id, and `cases.teacher_chat_id` is a non-null
foreign key, so no case can exist for them. The design doc did not anticipate this: §13 treats
"unmatched" as *"email not on the roster"*, and this is a second, distinct case.

> **Answered: alert staff, file nothing.** The alert carries the name, the email and which form it
> was, so a person can chase them.
>
> *Cost, stated plainly:* a submission from a teacher who never signs in is never converted, and it
> lives only in the alert and in the responses tab. Nothing is lost — the document is in Google
> Forms either way — but nobody can answer "did you get my documents?" for that teacher, because
> they have no way to ask.
>
> **This must be its own message, not the generic unmatched one.** "We do not know this email" is
> false here, and a wrong message is worse than a terse one.

**Q2 — where the responses live. Answered: MoPSE will link every form's responses into the
spreadsheet the bot already reads.** The upward pipeline in §2 is therefore buildable as designed.

> ⚠️ **Explicitly asked for, and it is a requirement on task 82, not a nicety:**
> *"just make sure that after this is all done i know where exactly to put them."*
>
> `RUNBOOK.md` must carry a step-by-step procedure a non-engineer can follow without asking anybody:
> which menu in Google Forms, which option, which spreadsheet to pick, what the tab will be called
> when it appears, and **what to then type into the `RESPONSES_TAB` cell of the `FORMS` row** — with
> the warning that these two must match exactly. It must also say how to check it worked without
> waiting for a real submission. **A procedure that assumes the reader already knows where the
> setting is does not satisfy this.**

**Q3 — does a submission create a case? Answered: yes, create a case**, as design doc §13 agreed.

> *Cost, accepted:* `SUBMIT_DOCS` cases appear in `/cases`, in the morning digest, in `/export` and
> under the retention rules like any other. At 1,800 teachers across several forms that is a large
> number of cases, many needing nothing beyond being read once. In exchange the teacher can see
> their submission in Check My Case, which is one of the complaints this bot exists to fix.

**Q4 — how long the marker rows live. Answered: purge them with the case they created.**

> ### ⚠️ The option I offered was faulty. Found while writing the table, before any of it ran.
>
> I justified it as *"safe because by the time a case is purged its response row is far too old to
> be re-read."* **That is wrong, and it is wrong in the direction that hurts.** The response sync
> reads the *whole* responses tab every ten minutes, for ever. Google's sheet never forgets row 42.
> So deleting the marker does not retire an old submission — it makes row 42 look new again:
>
> ```
> day 0   submission at row 42 → case filed, marker written
> day 7   case purged by retention → marker purged with it
> day 7   next sync, ten minutes later → row 42 has no marker → FILE IT AGAIN
> …and again, every ten minutes, for the life of the system
> ```
>
> **D44 — the marker is anonymised, not deleted.** The decision behind the answer is honoured
> exactly; only the mechanism changes.
>
> - `case_reference` is `ON DELETE SET NULL`, **not** `CASCADE`. Purging a case must never
>   resurrect the submission that created it.
> - `submitter_email` is **nulled** when the case goes. That column is the entire personal content
>   of the row.
> - What survives is `("PASSPORT", 42, Filed)` — *"row 42 of the passport form has been dealt
>   with"*. It identifies nobody, and it is the only thing standing between this design and an
>   infinite duplicate-case loop.
>
> So the retention job still gains a step, and the step is an `UPDATE`, not a `DELETE`. **No teacher
> data is kept longer than the case**, which is what the answer actually asked for.

---

## 6. Actions for MoPSE, not code

These are invisible when missing — the software runs perfectly and does less — which is why they
belong on `RUNBOOK.md` §2.6 with the rest.

1. Create the `FORMS` tab with the agreed columns.
2. **Link every live form's responses into the same spreadsheet the bot reads**, and put the tab's
   exact name into that form's `RESPONSES_TAB` cell. Confirmed possible on 31 July. **Task 82 owes a
   step-by-step procedure for this that assumes no prior knowledge** — see Q2.
3. Add the recruitment-email question to every form, and **make it required**. A response with no
   email can never be matched to anybody, and the bot cannot tell that from a teacher who mistyped.
4. **Do not delete or reorder rows in a responses tab.** §3, D40. Deleting one shifts every row
   below it up by one and the bot re-files all of them.
5. Design doc §14 still stands: the six inert tabs, `ADMINS` especially, should go.

**Every item here is invisible when it is missing** — the software runs perfectly and answers less.
That is why they are gathered in one place rather than left inside the procedures that need them.

---

## 7. Build order

Bottom up, so nothing is written before the thing it needs. Layers are enforced mechanically by
`npm run deps:check`, so this order is not merely tidy.

| # | Task | Depends on |
|---|---|---|
| 72 | Migration `0009` — `form_links`, `form_submissions` | — |
| 73 | `SHEET_TABS.FORMS`, `parseFormsTab` + tests | — |
| 74 | `syncForms`, `SyncSource` gains `FORMS`, damage limit covers `form_links` | 72, 73 |
| 75 | The forms repository — active links in sheet order | 72 |
| 76 | Menu button, the forms list route, `keyboards.ts:78` corrected | 75 |
| 77 | The maintenance gate over the new route | 76 |
| 78 | `parseResponsesTab` + tests | — |
| 79 | The response sync: match, file, mark, alert — **three outcomes, not two** (filed / on the roster but never signed in / not on the roster) | 72, 78 |
| 80 | The scheduled job runs all three syncs | 74, 79 |
| 81 | Retention for `form_submissions`, purged with its case | 79 |
| 82 | Documents, in one pass — `BOT-SPEC.md` §10 and `RUNBOOK.md` Part 6, **both of which still describe the cancelled Telegram upload**, RUNBOOK §2.6, **the Q2 step-by-step procedure**, and `npm run deps` regenerated | all |

**Nothing is blocked.** All four questions were answered before the build started, which is why 78–81
carry no open dependency. Task 79's three outcomes are Q1's answer made concrete: the middle one is
its own message and its own alert, because the generic "we do not know this email" is false for a
teacher who is on the roster.

---

## 8. Ripples

- `SyncSource` is a union in `sheets-sync.ts:23`; `countActive`/`countWhere` take a **literal table
  union** at `sheets-sync.ts:309-318` that must gain `form_links`. Both are compile-time checked,
  so both will fail loudly.
- `sync-sheets.ts` settles exactly two promises and names them positionally at line 45. Adding a
  third without changing `describe` is a silent mislabel.
- The heartbeat watches `SYNC_SHEETS_INTERVAL_SECONDS`. A third sync makes the job longer; the
  worker is `concurrency: 1`, and §4 of the handoff is explicit that a long run starves the other
  scheduled work. **Measure it.**
- `docs/dependency-tree.md` is current at 76 source files and will be wrong.
- The privacy notice may need a sentence about documents going to Google. **If it changes, D31's
  re-consent gate fires at 1,800 teachers** — this is the single most expensive ripple in the stage
  and it must be checked before the notice is touched, not after.

---

## 9. Verification

The standing rule: prove it by running it, and make every new checker fail on purpose before
believing it.

- The full suite, with **0 skipped**. Baseline `1,071 tests across 62 files`.
- `npm run typecheck`, `npm run build`, `npm run deps:check`, `npm run lint`.
- `npm run knip` and `npm run knip:prod` — the second is the one that catches a helper written for
  this stage that only its own test ever calls.
- A deliberately broken `FORMS` row, to watch the rejection name its row number.
- A deliberately duplicated response row, to watch the second run file nothing.
- `npx drizzle-kit generate`, then **read the SQL before accepting it** — it has emitted a
  destructive `DROP TYPE` in this repository once already.

---

## Where this stands

**Stage 6 is complete and committed.** Tasks 72–82 all landed in `ed16807`.

| Task | What | Commit |
|---|---|---|
| 72 | Migration `0009` — `form_links`, `form_submissions`. **SQL read before accepting** | `ed16807` |
| 73 | `SHEET_TABS.FORMS`, `parseFormsTab` — 22 unit tests | `ed16807` |
| 74 | `syncForms` | `ed16807` |
| 75 | The forms repository | `ed16807` |
| 76 | Menu button and the forms list | `ed16807` |
| 77 | The maintenance gate, on **both** the list and the tap | `ed16807` |
| 78 | `parseResponsesTab` — 13 unit tests | `ed16807` |
| 79 | The response sync, three outcomes — 21 integration tests | `ed16807` |
| 80 | All three syncs scheduled, responses **after** the links | `ed16807` |
| 81 | Retention for the markers — anonymises, never deletes | `ed16807` |
| 82 | Every document, in one pass | `ed16807` |

**Two `fix:` commits came out of this stage and are deliberately separate from it**, because they
correct code that was already committed:

| Commit | What |
|---|---|
| `fd15e14` | **A duplicate check that could never fire**, in `addStaff` and the urgent-code retry |
| `5315f08` | The three cosmetic lint findings |

**Verified on the tree as committed, 31 July 2026:**

```
1,134 tests across 64 files · 0 failed · 0 skipped · 220 seconds
typecheck clean · build clean · deps:check clean · lint 0 warnings
79 source files · 64 test files
```

**Both `fix:` commits were checked out into a scratch worktree and typechecked and `deps:check`ed on
their own**, rather than only the tip being verified.

### Task 82, completed properly — the third document

`CONCERNS-AND-IT-ACTIONS.md` was checked last and **Stage 6 had made two things in it wrong.** It is
now at 4.1.

- *"The bot reads **two tabs**"* — it is three, plus one responses tab per form.
- **A8 is materially wider.** The spreadsheet now holds every teacher's submitted documents beside
  the confidential answer bank. **Before this stage that document was confidential; it is now
  confidential AND personal**, and those need different handling. The bot's database was deliberately
  made the only place holding teachers' words, with one set of controls and a retention rule — **the
  responses tabs sit outside all of it.** Nothing deletes them, retention does not reach them, and a
  teacher who asks to be removed is removed from the database while their submission stays in Google.

**That is a consequence of D24, not a fault in it** — keeping documents in Google is exactly what
avoids the bot storing files. But it is the one thing this stage changed about the risk picture, and
whoever sets the spreadsheet's access list needs to know that the people who may read the answer bank
are not automatically the people who may read 1,800 passport numbers.

### Deviations from the plan so far

1. **D44 — the marker is anonymised, not deleted.** The Q4 option as I put it was faulty and would
   have re-filed every purged submission for ever. §5 has the reasoning.
2. **`telegram/callback-data.ts` is now a layer-1 leaf**, added to `LAYER_OVERRIDES` beside
   `telegram/send.ts`. It is a pure codec importing only `config/constants.ts`. The parser needs it
   so a FORMS row whose TYPE cannot travel in a button is rejected by row number rather than
   throwing when the list renders.
3. **`callbackPartProblem` was added to `callback-data.ts`** — the same two rules `encodeCallback`
   enforces, asked as a question instead of thrown. One source of truth, two callers.
4. **`parseFormsTab` validates the URL**, which the plan did not ask for. The forms list is one
   message carrying every button, and Telegram refuses a message containing a malformed button URL —
   so one bad cell would take the whole list away from every teacher rather than just its own row.
   `https` only; the host is deliberately unrestricted.
5. **`src/forms/` is a new layer-2 directory** in the dependency map.
6. **The forms list uses callback buttons, not `url` buttons.** One extra tap buys a re-read of the
   active flag at the moment of tapping, so a form withdrawn this morning is not still reachable
   from a menu sitting in scrollback.
7. **An empty forms list is its own message.** Before the FORMS tab is filled in, that is what every
   teacher sees, and a keyboard with one Home button is a puzzle where a sentence is an answer.
8. **Exactly one responses column may contain "email"** — asked for directly by the head of project,
   and it is better than the plan's "first match wins". A form asking both "Your email" and "Your
   supervisor's email" would otherwise be read by position, and filing a teacher's documents under
   their supervisor is a silent, plausible, wrong answer. Letters are compared without punctuation,
   so "E-mail" matches; **that was caught by a test I wrote and my first implementation failed.**
9. **A note is added on every filed submission.** Not in the plan. `createCase` returns an existing
   open case in the same category within 24 hours rather than opening a second — right, since three
   forms in a morning is one piece of work — but without the note the second and third submissions
   would be invisible to whoever picks the case up.
10. **The response sync runs sequentially, after the link sync**, rather than as a fourth settled
    promise. It reads `form_links` to learn which tabs to open, so running it in the same batch
    would work from the previous cycle's list — and on a fresh deployment, from no list at all.
11. **An inactive form's responses are still read.** The one place the active flag is ignored. A form
    switched off this morning may still have last night's submissions, and dropping them would lose
    a teacher's documents silently.
12. **`form_submissions` has no `onConflictDoNothing` on the filed path**, unlike the unfiled one.
    That makes the primary key a second line of defence: if `alreadyProcessed` were ever broken, the
    duplicate marker violates `(form_type, sheet_row)` and takes the case down with it in the
    rollback.

## Faults found in ALREADY-COMMITTED code, by the suite failing

Both are fixed in their own `fix:` commit, separate from the stage, and neither is Stage 6's doing.

### `isUniqueViolation` — a check that could never fire, in two places

The full suite failed on `staff/repository.integration.test.ts → reports a duplicate as a duplicate
when two callers race`. **§7 of the handoff calls that a known intermittent, seen once on 30 July,
and it is not intermittent — it is a real bug.** Measured against the live database:

```
depth 0: DrizzleQueryError   code = undefined   ← what the code read
depth 1: DatabaseError       code = 23505       ← where it actually is
```

Drizzle wraps the driver's error, so `(err as { code?: string }).code === '23505'` reads `undefined`
**every time**. It has never once fired.

**Why it looked intermittent, which is the part worth keeping.** `addStaff` pre-checks for an
existing row before inserting. When the race timing lets that pre-check see the winner's committed
row, the duplicate is caught there and the test passes. Only when the *insert* loses the race — the
exact path the conversion exists for — did the raw error escape. **The test was green while the code
it guards had never worked.**

**The same pattern was in `cases/urgent.ts:134`**, on the urgent-code collision retry, where the
comment already said a collision *"would reach `bot.catch`, and `bot.catch` acknowledges the update
and says nothing at all, so the staff member would see silence and tell the teacher a code was
coming."* That retry could not retry. At 32^6 nothing has ever exercised it.

**Fixed as one shared `src/db/errors.ts`**, walking the `cause` chain rather than reading it once,
because how many layers drizzle adds is not something a caller should have to know — and it changed
once already without anybody noticing.

**Proved by restoring the broken logic**: three of the seven new tests failed, including one showing
the old version **threw on `null`** rather than returning false. The tests are deterministic
precisely because the race test let this through twice.

### One I introduced, and caught before committing

**`alreadyProcessed` issued one `SELECT` per response row, on every sync.** A responses tab is
append-only and never shrinks, so in steady state *every* row in it has already been handled — at
1,800 submissions that is **1,800 queries every ten minutes, per form**, inside a worker that runs
`concurrency: 1`.

That is exactly the starvation §8 flagged and told me to measure. It would not have shown up in
testing, where a tab holds three rows; it would have shown up in November as a false heartbeat alarm
saying the sheet sync had stopped — raised late by the heartbeat that was itself starved.

Replaced with one query per form into a `Set`. The cost is now one integer per submission and does
not grow with how often the sync runs.

### The lint findings, cleared

`npm run lint` now reports **zero warnings**, the first time in this project.

- **`no-base-to-string` at `sheets/client.ts`** — the one the review phase recorded and did not fix.
  `String(cell)` over `unknown[][]` turns any object into `[object Object]`: a cell that looks
  filled in, matches nothing, and explains nothing. Not reachable with `UNFORMATTED_VALUE`, **with
  one real exception — a formula-error cell arrives as an object** — and Stage 6 made that likelier,
  because a responses tab is a live sheet people put formulas in. Now serialised, so the reason
  reaches the rejection message.
- Two `no-useless-spread` and one `no-misused-spread`, all cosmetic.

### What was proved by breaking it on purpose

**`alreadyProcessed` was made to return false**, and the suite was run. **Exactly one test failed** —
*"files exactly one case however many times the same tab is read"* — and no duplicate case reached
the database by either route. The break was then reverted and the file re-verified.

That is the standing rule of this project applied to a test rather than a tool, and it is worth
doing here specifically: 21 integration tests passed on their first run, which is unusual enough in
this codebase to be suspicious rather than reassuring.
