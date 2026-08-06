# MoPSE's live forms: three spreadsheets, and a column nobody can name — the design

**Date:** 6 August 2026 · **Status: ✅ BUILT AND DEPLOYED on 6 August 2026 — commits `56d62cc`…`e6b11c7`
on `main`.** GitHub and the live server are both at `e6b11c7`. Belongs to
`2026-08-01-identity-and-urgent-design.md`, which stays the plan of record. Continues
`2026-08-03-form-areas-design.md`, which is built and deployed.

```
1,418 tests across 73 files · 0 failed · 0 skipped · 366 seconds
typecheck clean · build clean · lint 0 warnings · deps zero cycles, zero layer violations
```

**Every number above was run on 6 August 2026 against the tree as committed**, and the six commits
are:

| Commit | What it is |
|---|---|
| `56d62cc` | `EMAIL_COLUMN` can name a column by its letter |
| `6c9676b` | A tab can be read from a spreadsheet other than the configured one |
| `6af83ee` | A form's answers can live in their own spreadsheet — migration `0015_form_responses_sheet` |
| `1514212` | A form's category decides whether it asks the teacher to write |
| `a355f93` | The runbook |
| `e6b11c7` | The dependency tree |

> **Designed first, built second.** The design below is as it was approved. Where building it changed
> something, the change is struck through with the correction against it rather than written over the
> top — §10 carries everything building it found, and §11 carries what is still outstanding.

> ### ⚠️ Nothing here has reached a teacher yet
>
> **The FORMS tab is still empty**, so the two rows this work exists to make readable are not in the
> spreadsheet, and the forced sync has deliberately **not** been run. Both are in §11, and the second
> must not be done before the first.
>
> **Only two of the three forms are going live.** Medical Leave is deferred by the head of project's
> instruction on 6 August. It stays designed, and unbuilt in the sheet.

> Asked for by the head of project on 5–6 August 2026, while getting the real forms live. The
> constraint that shapes everything below is theirs and it is not technical:
>
> *"i dont wanna bother my superior anymore and we're launching tomorrow … i can't burden her with
> another task."*
>
> Every option requiring somebody else to click something in Google was therefore rejected, and the
> design below needs nothing from anyone outside this project.

---

## 1. What is wrong today

Form areas shipped on 4 August and cannot read a single one of MoPSE's real forms. Two reasons, both
found by testing against the live sheets rather than by reading code.

### ⚠️ A. Each form's answers live in its own spreadsheet

`GOOGLE_SHEET_ID` is one spreadsheet, and `RESPONSES_TAB` names a tab **inside it**. The three live
forms each write to a spreadsheet of their own:

| Form | Spreadsheet | Tab |
|---|---|---|
| Accommodation | `11qaIcRFkRqGYS_eM_Sxhe9ULD1A7cFw-DnRmiyTYFNU` | `Form Responses 1` |
| Reimbursement | `17_GGERVyIH0qu7quWZJG7vwWgKiUcRUU27lq_vqDHwA` | `Form Responses 1` |
| Medical Leave | `15f3w5ZQqD7EIfxs_wOUZcvANYCz6BAxemRSKl8qJodI` | `Form Responses 1` |

**This is Google's default, not a mistake anybody made.** Linking a form to Sheets creates a new
spreadsheet unless somebody remembers to override it, so the runbook's "use the same spreadsheet, not
a new one" rule fights the tool and loses. It already lost once: the `DiplomaResponses` tab that
alarmed every ten minutes for weeks was the same class of error.

The bot must therefore read where the answers actually are.

### ⚠️ B. Two forms have two columns with the identical heading `Email Address`

`EMAIL_COLUMN` shipped on 4 August so a form could say which of its email columns identifies the
teacher. It matches the heading exactly after trimming. That is enough for Medical Leave, whose two
differ by one capital letter — and useless for the other two, whose headings are the same string:

| Form | Column B | Column D | Distinguishable by name? |
|---|---|---|---|
| Medical Leave | `Email Address` | `Email address` | yes |
| Accommodation | `Email Address` | `Email Address` | **no** |
| Reimbursement | `Email Address` | `Email Address` | **no** |

Column B is added by Google's **Collect email addresses** setting and holds whatever account the
teacher was signed into. Column D is the form's own question — what they typed.

**Decision 2 of the form-areas design says match on what the teacher typed.** Its reasoning holds:
the collected address is frequently a personal Gmail on no roster row. So on two of the three live
forms the bot would currently match against the wrong column and file nothing for most people —
silently, because an unmatched submission is a warning rather than an alarm.

### ⚠️ C. `PREPARE` quietly decides what a teacher is asked to do

As built, a form is a "complaint area" — one that shows preparation notes, then asks the teacher to
describe their problem — when `PREPARE` is not empty. So one cell decides two unrelated things:
what a teacher is told to gather, and whether they are asked to write.

Medical Leave is where that breaks. It should tell teachers what to have ready and should **not**
ask them to type their medical situation into a chat message. As built, that combination cannot be
expressed.

## 2. The decisions the head of project made

All taken on 6 August 2026 and all binding.

| # | Decision |
|---|---|
| 1 | **`EMAIL_COLUMN` accepts a column letter**, e.g. `D`. Heading first; a letter only if no heading matches |
| 2 | **Accommodation and Reimbursement ask the teacher to write.** Medical Leave is a link only |
| 3 | **`PREPARE` and "ask for a message" are separated.** `CATEGORY` decides whether the bot asks |
| 4 | **No Holiday Leave form.** It exists, and it is out of scope |
| 5 | **The existing service account reads everything.** The second key is removed |

> **Decision 2 was narrowed later the same day.** ~~Medical Leave is a link only~~ — **Medical Leave
> is not going live at all for now.** The head of project's instruction on 6 August was
> *"accomodation, and travel and visa reimbursements these are what we need atm"*. The rule decision 3
> creates is still built and still correct; what changed is that no live form uses the quiet path
> today, so the tests are the only thing holding it. See §10.

**Decision 5 is the one that saved a day.** The head of project has Editor rights on the ministry
spreadsheets and shared them with the account already running, which was tested and works against
all four spreadsheets. The second service account their manager created — whose project has the
Sheets API switched off, and which nobody in this project can enable — is therefore unnecessary and
its key comes off the server rather than sitting there unused.

## 3. What changes in the spreadsheet

**One new column, and one change of meaning.** Everything stays in the FORMS tab, so MoPSE changes
any of it without a deployment — the rule this whole feature is built on.

| Column | Status | What it is |
|---|---|---|
| `RESPONSES_SHEET_ID` | **new**, optional | Which spreadsheet the answers are in. Blank means the main one |
| `EMAIL_COLUMN` | changed | Now also accepts a column letter such as `D` |
| `CATEGORY` | changed | **Now decides whether the bot asks the teacher to write.** Blank means it does not |
| `PREPARE` | changed | Purely what to gather. Shown whenever set, prompt or no prompt |

### Why `CATEGORY` is the switch rather than a new column

A form with a category has somewhere to file a complaint; a form without one does not. So "is this a
place to complain?" and "where does the complaint go?" are the same question, and answering it twice
would let the two answers disagree. The alternative — an `ASKS_FOR_MESSAGE` column beside `CATEGORY`
— permits the contradiction "ask for a message, file it nowhere", and a column that can be set to a
meaningless combination will eventually be set to one.

**This drops the old rule that an empty `CATEGORY` meant `Contact Support`.** That default existed
only to give Holiday and Medical Leave somewhere to go, and decisions 2 and 4 removed both. A form
that wants `Contact Support` now says so.

### Why a column letter rather than renaming the question

Renaming the duplicate question in Google Forms would fix it at the source and costs nothing in
code. It is rejected because it needs the head of project's superior, which decision-making above
has ruled out — and because Google will produce identically named columns again the moment somebody
turns on **Collect email addresses** for a form that also asks for an address, which is exactly what
happened three times out of three here.

**Heading first, letter second, and never the reverse.** A heading that genuinely reads `D` wins, so
naming a real column can never be overridden by a coincidence of spelling. The cost is that a form
with a heading of `D` cannot use `D` to mean the fourth column; it would use the heading instead,
which is what it meant anyway.

## 4. What changes in the bot

- **`SheetReader.readTab` takes an optional spreadsheet id.** Absent means the configured one, so
  every existing caller — FAQ, roster, forms list — is unchanged and untouched.
- **`findEmailColumn` resolves in two steps**: exact heading after trimming, then, only if nothing
  matched, the value as a column letter.
- **A form is a complaint area when `category` is not null**, in `chooseDocForm` and nowhere else.

**Read-only stays read-only.** The scope requested is `spreadsheets.readonly` and this design does
not touch it. Nothing here writes to a spreadsheet.

## 5. ~~The three rows~~ The two rows, and the one that is waiting

| TYPE | BUTTON_TEXT | RESPONSES_SHEET_ID | RESPONSES_TAB | EMAIL_COLUMN | CATEGORY | Asks? |
|---|---|---|---|---|---|---|
| `ACCOM` | 🏠 Accommodation | `11qaIcRF…` | `Form Responses 1` | `D` | `Accommodation` | yes |
| `REIMBURSE` | 💵 Travel and Visa Reimbursement | `17_GGERVy…` | `Form Responses 1` | `D` | `Travel and Arrival` | yes |
| ~~`MEDICAL`~~ | ~~🏥 Medical Leave~~ | ~~`15f3w5ZQ…`~~ | ~~`Form Responses 1`~~ | ~~`D`~~ | ~~*(blank)*~~ | ~~no~~ |

**The Medical Leave row is deferred and is not written to the sheet.** The head of project decided on
6 August that Accommodation and Travel and Visa Reimbursement are what is wanted now. The row above
is kept, struck through rather than deleted, because it is exactly what to write the day that form is
wanted — and because it is the only row in this design that would have used the quiet, no-category
path.

`D` is used on ~~all three~~ both, and would have been used on Medical Leave too, where a heading
would work. One rule across every form is easier to explain than two, and a heading match would break
the day somebody edits the question's capitalisation.

**All three response sheets are empty**, checked on 6 August. So there is no backfill: the first
sync files nothing, and the marker table starts clean.

> ⚠️ **Neither row is in the sheet yet.** The FORMS tab was still empty when this work was deployed,
> and filling it in is the head of project's own action. §11 says what that means in the meantime,
> and why the forced sync must wait for it.

## 6. What this costs, written down rather than discovered

- **A wrong `RESPONSES_SHEET_ID` fails exactly like a wrong `RESPONSES_TAB`** — that form alone stops
  being read and raises a critical alert naming it. That is the existing behaviour and it is right,
  but there is now one more cell that can be wrong in the same way.
- **`CATEGORY` changing meaning is a silent behaviour change for any existing row that has one.**
  There are none in production today, so nothing changes for anybody — but a sheet written between
  4 and 6 August against the old rule would start asking teachers for a message. Checked: no such
  sheet exists.
- **Nothing verifies that `EMAIL_COLUMN` names the teacher's own address rather than the school's.**
  A letter is easier to mistype than a heading, and `P` instead of `D` on the Medical form would
  match submissions against a school contact email. The existing "submissions that matched no
  teacher" warning is what catches it, late.

## 7. What changes

| File | Layer | Change |
|---|---|---|
| `src/sheets/client.ts` | 2 | `readTab` takes an optional spreadsheet id |
| `src/sheets/parse.ts` | 2 | `FormRow` gains `responsesSheetId`; `findEmailColumn` resolves a column letter |
| `src/db/schema.ts` | 2 | `form_links` gains `responses_sheet_id`. Purely additive |
| ~~`drizzle/0014_form_responses_sheet.sql`~~ `drizzle/0015_form_responses_sheet.sql` | — | The migration. **`0014` was already taken** — see §10 |
| `src/forms/repository.ts` | 2 | `FormLink` carries `responsesSheetId` |
| `src/sync/sheets-sync.ts` | 2 | `syncForms` writes it |
| `src/sync/form-responses.ts` | 2 | Passes the spreadsheet id to the reader |
| `src/telegram/router.ts` | 3 | `chooseDocForm` keys the prompt off `category`, not `prepare` |
| `RUNBOOK.md` | — | §4.18: the new column, the letter form, and the changed `CATEGORY` rule |

**No new callback prefix, no new conversation state, no change to the two gates.**

## 8. What proves it works

- **A form reads from another spreadsheet**, and a form with no id still reads from the main one.
- **`EMAIL_COLUMN = D` picks the fourth column** on a header whose B and D are the identical string,
  which is fault B held by the data that caused it.
- **A heading beats a letter**: a tab with a column genuinely headed `D` resolves to that column.
- **A form with a category asks for a message; a form without one does not** — and the second still
  shows its `PREPARE` notes, which is fault C.
- **A wrong spreadsheet id takes out that form only**, and the others still file.
- **The same submission twice still files once**, through the new read path.

## 9. What is not being done

- **No Holiday Leave.** Decision 4.
- **No second service account.** Decision 5, and its key is removed from the server.
- **No writing to Sheets.** The scope stays `spreadsheets.readonly`.
- **No backfill of old submissions**, because there are none.
- **`PREPARE` text is not written here.** It is spreadsheet content, drafted from each form's own
  questions and owned by MoPSE.

---

## 10. What building it found — 6 August 2026

### What changed while building, and why

| # | Change |
|---|---|
| 1 | **The migration is `0015_form_responses_sheet`, not the `0014` this design named.** `0014_pre_urgent_status` already existed and was already applied on the live server. Reusing the number would either have been skipped as already-run or collided in the journal, and either way the new column would silently never have been added. Caught before generating, not after. |
| 2 | **Only two forms go live.** Medical Leave is deferred by the head of project's instruction on 6 August. The switch decision 3 asks for is still built, because it is the right rule whether or not a live form uses it — but **no production row exercises the no-category branch**, so its two integration tests are the only thing holding that behaviour today. Said here rather than assumed, because "the sheet will show it if it breaks" is not true while the sheet has no such row. |
| 3 | **An empty spreadsheet id would have read a spreadsheet called `""`.** The URL builder used `override ?? configuredId`, and `??` only falls back on null. A `RESPONSES_SHEET_ID` cell containing a space, or a stray empty string arriving from the sheet, is not null — so it would have built a perfectly valid-looking address for a spreadsheet named nothing, and that form would have failed with a message about Google rather than about the cell. A small `namedSpreadsheet()` helper now turns blank and whitespace into null at the boundary, and an integration test asserts the reader is handed `null` and not `''`. **This is a fault the design did not see and the plan did not name.** |
| 4 | **A second existing test had to change, which the plan did not predict.** The plan named one test to delete — `files under Contact Support when the area names no category`, which asserted the rule this work reverses. A second, `leaves a form with no paperwork message exactly as it was`, also depended on the old rule. It was **kept and its meaning corrected** rather than deleted, and the four combinations of `CATEGORY` × `PREPARE` are now each held by exactly one test, so no combination is left unproved. |
| 5 | **The plan's replacement text would have silently reverted a deliberate change.** It quoted an older, more alarming wording of the email warning — the one beginning with a warning sign and *"that is how we know the documents are yours"* — which commit `7523482`, "the bot stops talking at teachers", had removed on purpose two days earlier. Pasting the plan's snippet in would have undone that without anybody noticing. **The current gentler wording was kept.** A plan written against a tree is only correct against that tree. |
| 6 | **`handleFormComplaint`'s fallback comment was wrong, not its code.** The plan said a null category *"cannot arrive here at all"*, because `chooseDocForm` only saves the state for a form that has one. It can. The form is **re-read when the teacher's message arrives**, so a sheet sync landing between the tap and the message can blank the category underneath them. The fallback to the general queue is therefore load-bearing rather than defensive, and the comment now says so. |

### The flaky run, recorded because it will happen again

An earlier full-suite run reported **4 failures**, all in `router.integration.test.ts`'s "the front
door" tests. They are not a fault in the product and were not caused by this work:

- The same file passes alone: **65 of 65.**
- A clean full run passes: **1,418 of 1,418, 0 skipped.**
- The bad run took **570 seconds against 366**, and that one file took **180 seconds against 24**,
  with database-lifecycle noise through the log.

It is load-related flakiness in the test harness — the machine was doing other things. **The lesson is
narrow and worth keeping: a red full run on a loaded machine is re-run before it is believed**, and
the file that failed is run on its own to tell the two apart.

### On the deployment

Deployed on 6 August 2026 in `RUNBOOK.md` §2.1's order. **A `pg_dump` was taken first** —
`~/pre-deploy-backups/pre-live-forms-20260806.sql`, 771,553 bytes, checked to be a complete dump
rather than a truncated one before anything was stopped.

- **Migrations 15 → 16 applied.** `form_links.responses_sheet_id` exists and is null on all three
  existing rows, which is the additive change behaving as designed.
- **Four containers healthy**, `/healthz` returning 200 checked four ways.
- **The webhook has 0 pending updates**, with a `last_error` dated a day earlier — that is, nothing
  failed during or after the deployment.
- **Every data count is unchanged**: 8 roster rows, 4 teachers, 9 cases, 4 staff, 3 forms,
  1 submission.
- **The new code was proved by running it, not by reading the build.** `findEmailColumn` was executed
  inside both the web and worker containers against MoPSE's real duplicate-heading header, and
  returned column 3 for `'D'` in each. Grepping `dist/` would have proved the file was copied;
  this proves the behaviour is there.

---

## 11. What is still outstanding — as of 6 August 2026

**The code is live and no teacher can see any of it yet**, because everything below turns on one
thing that has not been done.

### ⚠️ The FORMS tab is still empty

The two rows in §5 are not in the spreadsheet. **That is the head of project's own action** and
nothing in the bot can do it for them. Until it is done, Submit Documents still offers the three old
test forms and nothing else.

### The FORMS sync has been refusing itself every ten minutes since 4 August

Because the tab is empty, every sync sees a sheet that would remove every form there is, and the
damage limit stops it: *"would deactivate 3 of 3 active rows (100%)"*. **Nothing is being harmed.**
`rows_deactivated` is 0 on every one of those runs and the three old test rows are untouched — the
limit is doing exactly the job it exists for, which is refusing to act on a sheet that looks wiped.
**It stops the moment the two rows are written.**

### The forced sync has NOT been run, and must not be run yet

`sync-sheets --forms --force` would deactivate all three current rows with nothing to replace them,
which would take Submit Documents away from teachers entirely. It is run **once**, **after** the two
rows exist, and it will need `--force` because removing three rows and adding two is still a 100%
deactivation of what is there now.

> ~~The removal is 2 of 3~~ — **it is 3 of 3.** The plan's arithmetic assumed the `MEDICAL` row would
> be rewritten and would therefore upsert rather than deactivate. With Medical Leave deferred it is
> not written at all, so all three existing rows go at once. The `--force` override is still the
> answer, and it is still recorded on the sync run, which is the point of it.

### Two things that were already wrong and still are

- **The `DIPLOMA` alert is unchanged** — `Unable to parse range: DiplomaResponses`. It pre-dates this
  work, it is a sheet to be corrected rather than code to be written, and none of these six commits
  touched it.
- **`settings` is still 0 rows on the live server**, so no retention period is set and **nothing is
  ever deleted**. Also pre-existing, and it is on `RUNBOOK.md` §1.4's launch checklist.
