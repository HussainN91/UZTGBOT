# MoPSE's live forms: three spreadsheets, and a column nobody can name — the design

**Date:** 6 August 2026 · **Status: DESIGNED, NOT BUILT.** Belongs to
`2026-08-01-identity-and-urgent-design.md`, which stays the plan of record. Continues
`2026-08-03-form-areas-design.md`, which is built and deployed.

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

## 5. The three rows

| TYPE | BUTTON_TEXT | RESPONSES_SHEET_ID | RESPONSES_TAB | EMAIL_COLUMN | CATEGORY | Asks? |
|---|---|---|---|---|---|---|
| `ACCOM` | 🏠 Accommodation | `11qaIcRF…` | `Form Responses 1` | `D` | `Accommodation` | yes |
| `REIMBURSE` | 💵 Travel and Visa Reimbursement | `17_GGERVy…` | `Form Responses 1` | `D` | `Travel and Arrival` | yes |
| `MEDICAL` | 🏥 Medical Leave | `15f3w5ZQ…` | `Form Responses 1` | `D` | *(blank)* | no |

`D` is used on all three, including Medical Leave where a heading would work. One rule across every
form is easier to explain than two, and a heading match would break the day somebody edits the
question's capitalisation.

**All three response sheets are empty**, checked on 6 August. So there is no backfill: the first
sync files nothing, and the marker table starts clean.

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
| `drizzle/0014_form_responses_sheet.sql` | — | The migration |
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
