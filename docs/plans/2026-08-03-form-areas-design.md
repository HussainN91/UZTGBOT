# Form areas: a complaint and its paperwork, together — the design

**Date:** 3 August 2026 · **Status: ✅ BUILT on 4 August 2026 — commits `80f1a50`…`3fa4342` on
`main`.** Belongs to `2026-08-01-identity-and-urgent-design.md`, which stays the plan of record.

```
1,346 tests across 71 files · 0 failed · 0 skipped · 259 seconds
typecheck clean · build clean · lint 0 warnings · deps zero cycles, zero layer violations
```

**Every number above was run on 4 August 2026 against the tree as committed.** The suite gained 27
tests; nothing was removed. The dependency graph is byte-identical to before — no new modules and no
new edges between them.

> **Designed first, built second.** The design below is as it was approved. Where building it changed
> something, the change is struck through with the correction against it rather than written over the
> top — §11 carries everything building it found, including the one part of §6 that is **not built**.

> ### ⚠️ One thing in §6 was not built
>
> "Tell the case's owner, if it has one" when a submission attaches to a complaint. See §11.

> Asked for by the head of project on 3 August 2026, in three pieces over one conversation. Their
> words for the shape of it, because they settle the whole design:
>
> *"it is not exactly an faq, it is a pure complaint … the teacher sees the link for the form along
> with writing his message, the bot should be aware that a successful submission has been made, if
> not the staff is notified that teacher filed a formless complaint."*
>
> And on how the new areas should exist: *"well they get their own categories but they ride on areas
> that exist on everything else, so just the button with the name on it but everything else in the
> background is on another categories."*

---

## 1. What is wrong today

Three separate faults, found in one sitting, and they compound.

### ⚠️ A. Every one of the four real forms would file nothing

MoPSE has four live Google Forms — Accommodation, Reimbursement, Holiday Leave, Medical Leave. Their
response sheets were read on 3 August 2026 and **not one of them can be read by this bot.**

`findEmailColumn` requires **exactly one** column heading containing the letters `email`, and throws
`EmailColumnError` otherwise — which takes the whole tab out. The counts are:

| Form | Columns matching "email" | Which |
|---|---|---|
| Holiday Leave | **4** | `Email Address`, `Email address`, `Emergency email / phone number while on leave`, `School contact email or telephone number` |
| Medical Leave | **3** | `Email Address`, `Email address`, `School contact email or telephone number` |
| Accommodation | **2** | `Email Address`, `Email Address` |
| Reimbursement | **2** | `Email Address`, `Email Address` |

Two causes, and both are normal. Google's **Collect email addresses** setting adds an `Email Address`
column, and each form *also* asks for the address as a question — so every form has a duplicate
before anything else is counted. Then Holiday and Medical ask for a school contact email and an
emergency contact email, which are the right questions to ask and happen to contain the word.

**The rule is not wrong so much as untested against reality.** It was written when the only form in
existence was a test one with a single email question. `EmailColumnError` refusing to guess is
correct behaviour and stays; what changes is that it no longer has to guess.

### ⚠️ B. A retired form alarms for ever

`formsWithResponses` ignores `active` on purpose, and the reason is sound:

> A form switched off this morning may still have submissions from last night that nobody has filed
> yet, and dropping them would lose a teacher's documents silently.

**But the rule has no end.** Removing a row from the FORMS tab only sets `active = false`; the row
stays. So a test form retired weeks ago is still read on every response sync, its tab no longer
exists, and each failure raises a **critical** alert — for ever. That is the notification noise the
head of project reported, and it would do the same to any real form MoPSE ever retires.

### ⚠️ C. Two of the four areas do not exist in this bot

The areas a teacher can file under are Visa, Travel and Arrival, Contract Signing, Accommodation, and
Something else. **Holiday Leave and Medical Leave are neither.** See §3, which is how that is
resolved without adding a category.

## 2. The decisions the head of project made

All taken on 3 August 2026 and all binding.

| # | Decision |
|---|---|
| 1 | **A retired form stops being read the moment it leaves the sheet.** Not after a grace period. |
| 2 | **Submissions match on the email the teacher typed**, not the one Google collected. |
| 3 | **Holiday Leave and Medical Leave get their own buttons but no new category.** "Just the button with the name on it but everything else in the background is on another category." |
| 4 | **Staff are told straight away**, and the case is updated if the form arrives later. |

**Decision 1 was raised once and chosen anyway.** It was put to them that a teacher who submits at
11pm, on a form retired at 9am before the next response sync, has their documents silently never
filed — nobody told, not them and not staff. That is the exact failure this feature exists to
prevent. They chose it knowingly over a grace period. §7 carries the habit that mitigates it, and
that habit is a process rather than a guarantee.

**Decision 2 has a named cost too.** A teacher who mistypes their address is not matched, and the
existing "submissions that matched no teacher" warning is what catches it. The alternative —
Google's collected address — cannot be mistyped but is whatever account they happened to be signed
into, which for many people is a personal Gmail that matches no roster row however carefully the form
was filled in.

## 3. The form area

**The one new idea, and it is deliberately not a new case category.**

A form area is a button with a name of its own that files under an area the bot already has. Six
things describe one, and **all six live in the FORMS tab**, so MoPSE can change any of them without a
deployment. That is the same rule the FAQ and the roster already follow, and the forms code states
the reasoning: a convention the bot derives is the `FORM_URLS` mistake wearing a different hat,
"because a convention nobody can see cannot be corrected by the person who owns the sheet".

| Column | Required | What it is |
|---|---|---|
| `TYPE` | yes | Short code. Travels in the button payload; never seen by a teacher |
| `BUTTON_TEXT` | yes | What the teacher taps — `Holiday Leave` |
| `URL` | yes | The `forms.gle` link |
| `CATEGORY` | **new**, optional | The existing case category it files under. Empty means `Contact Support` |
| `PREPARE` | **new**, optional | What to gather, shown above the link. Empty means no such message |
| `RESPONSES_TAB` | optional | Unchanged |
| `EMAIL_COLUMN` | **new**, optional | The exact heading of the teacher's own email column |

`ACTIVE` is unchanged.

### Why a category rather than a queue

`CATEGORY` names a value of `CASE_CATEGORY`, which the queue map already turns into a queue. Naming
the queue directly would put a second answer to "who works this" beside `QUEUE_FOR_CATEGORY`, and the
two would drift. **A row naming a category this build does not have is rejected with its row number**
and the list of real ones, exactly as a FAQ row with a misspelled topic is — the failure that rule
exists to prevent is an area silently unreachable for ever.

The mapping recommended to MoPSE, and theirs to overrule in the sheet:

| Area | Files under |
|---|---|
| Accommodation | Accommodation |
| Reimbursement | Travel and Arrival |
| Holiday Leave | Contact Support |
| Medical Leave | Contact Support |

With two active staff both covering every queue this changes nothing today. It matters the day the
work is split, which is the point of it being a cell rather than a constant.

### `EMAIL_COLUMN`, and what happens when it is empty

Empty keeps today's behaviour exactly: find the one column containing "email", and refuse the tab if
there is not exactly one. **So no existing sheet changes meaning**, and the four real forms name
their column.

Named, it is matched against the heading **exactly after trimming**, and nothing is inferred. A named
column that is not in the tab is an error naming the column and listing the headings that are there,
which is the difference between a fixable message and a silent nothing.

## 4. What a teacher does

Tapping **Reimbursement** produces one message:

```
Reimbursement

Before you start, have these ready as one PDF, in this order:
1. A cover page with your full name, school number, region, email and phone
2. Visa payment receipt, if applicable
3. House registration receipt, if applicable
4. Flight ticket or e-ticket showing route, passenger name and price
5. Boarding pass, if you have it

Name the file:
REIMBURSEMENT-YOUR NAME-SCHOOL NO_YYMMDD_HHMMSS.pdf

Photos must be readable. Do not include documents belonging to another teacher.

[ 📄 Open the form ]

Now tell us what you need, and we will open a case for you.
```

They type their message. A case opens under **Travel and Arrival**, tagged `REIMBURSE`, with their
message as the detail — through `createCase`, so the 24-hour de-duplication, the access re-check and
the new-case alert all apply unchanged.

**The `PREPARE` text is one cell.** The reimbursement instructions MoPSE supplied run to roughly
2,500 characters of cover-page tables, sample fees and paste-here boxes. What reaches a teacher on a
phone is the five documents in order, the filename, and the one prohibition. The sample fees and the
`ctrl+v` boxes belong in the Google Doc they are about to open, not in a chat message, and
`clampToTelegram` is the backstop if somebody pastes the lot into the cell anyway.

## 5. What staff are told, and when

**Immediately, and the notice says the form has not arrived.** Decision 4, and the reasoning is that
a complaint invisible to staff while the teacher believes it is being handled is worse than a notice
that turns out to be premature.

The new-case alert already exists and already reaches the staff who cover that queue and region. It
gains one line: whether the paperwork is in.

## 6. When the form arrives

The response sync already matches a submission to a teacher by email. **What changes is what it does
next.**

Today it always calls `createCase`, which files a fresh case under `Submit Documents`. It will first
look for that teacher's **open case in the same form area**, and if there is one:

- add a note recording that the submission arrived, with its sheet row
- clear the "no form yet" flag on the case
- ~~tell the case's owner, if it has one~~ — **not built. See §11.**

and only create a case when there is no open one — which is the path a teacher who submits without
ever writing a message still takes, unchanged.

**The submission is matched to the area, not merely to the teacher.** A teacher with an open
Accommodation complaint and an open Reimbursement complaint must not have their reimbursement
package attached to the accommodation case. `form_submissions` already records `form_type`, so the
area is known without anything new being stored.

**Nothing is deleted and no marker changes shape.** `form_submissions` keeps its
`(form_type, sheet_row)` primary key, which is the second line of defence that stops one submission
filing twice.

## 7. What this costs, written down rather than discovered

- **A submission arriving after a form is retired is lost silently.** Decision 1. The habit that
  mitigates it: leave a retired form's row on the sheet, with its `RESPONSES_TAB` intact, for a day
  after you stop telling teachers about it. **This goes in `RUNBOOK.md`**, because a habit that lives
  only in a chat log is not a control.
- **A mistyped email is not matched.** Decision 2. Caught by the existing "submissions that matched
  no teacher" warning, which is a warning rather than a critical alert and will be read late.
- **Holiday Leave and Medical Leave cases are indistinguishable from any other Contact Support case
  by category alone.** They carry the area tag, so they are findable — but `/cases` filters on
  status, not on area. If MoPSE later wants "show me every medical leave case", that is a real
  category and the work §1C describes.

## 8. What changes

| File | Layer | Change |
|---|---|---|
| `src/sheets/parse.ts` | 2 | `FormRow` gains `category`, `prepare`, `emailColumn`; `parseFormsTab` reads and validates them; `findEmailColumn` takes an optional named heading |
| `src/db/schema.ts` | 2 | `form_links` gains three nullable text columns. **Purely additive** |
| `drizzle/00NN_form_areas.sql` | — | The migration. Additive only; read the generated SQL before accepting it |
| `src/forms/repository.ts` | 2 | `FormLink` carries the three; `formsWithResponses` filters on `active` |
| `src/sync/sheets-sync.ts` | 2 | `syncForms` writes the three |
| `src/sync/form-responses.ts` | 2 | Attach to an open case in the area before creating one; pass `EMAIL_COLUMN` to the parser |
| `src/telegram/router.ts` | 3 | `chooseDocForm` shows `PREPARE` and asks for the message; a new conversation state captures it |
| `src/conversation/state.ts` | 2 | `AwaitingFormComplaint { type }` joins the union. No migration |
| `src/cases/notify.ts` | 2 | The new-case notice says whether the form has arrived |
| `RUNBOOK.md` | — | §4.18: the six columns, the mapping, and the retirement habit |

**No new callback prefix.** `DOC_TYPE` already carries the area and is already behind both gates.

## 9. What proves it works

- **The four real headings**, verbatim from MoPSE's sheets, are a test fixture. Each of the four
  refuses to parse with `EMAIL_COLUMN` empty and parses with it named. That is the whole of fault A,
  held by the data that caused it.
- **A retired form is not read**, and the test that currently asserts the opposite is inverted with
  its reasoning rewritten rather than deleted.
- **A submission attaches to the open case in its own area** and not to the teacher's other open
  case in a different one.
- **A teacher who submits without writing** still gets a case created, unchanged.
- **A category the build does not have is rejected with its row number**, and the other rows still
  sync.
- **The same submission twice files once**, which the primary key already guarantees and which must
  keep being true through the attach path.

## 10. What is not being done

- **No new case category.** Decision 3.
- **No change to `EmailColumnError`'s refusal to guess** when `EMAIL_COLUMN` is empty.
- **Nothing deleted from `form_links`.** The retired test rows stay as history and simply go quiet.
- **No change to how a teacher reaches Submit Documents**, or to the two gates in front of it.

---

## 11. What building it found — 4 August 2026

### ⚠️ The one thing that is not built

**§6's "tell the case's owner, if it has one" when a submission attaches.** The implementation plan
never carried it — its task 5 lists the note, the flag and the marker and stops there, and neither
the plan's tests nor §9's list of what proves it works mentions the owner. So it was designed,
dropped in planning, and the gap survived into the build.

It is not a line of code away. `sync/form-responses.ts` is a layer-2 store, and **stores must not
send**. Its only outbound path is the staff `Alerter`, which writes to the operations channel rather
than to one person's chat — telling a named owner needs the message to be *returned* to something in
layer 3, and nothing above this sync is listening. The sync is driven by the worker, not by a
teacher's message, so there is no reply to attach it to.

**This needs a decision rather than an afternoon**, and the case is not silent meanwhile: the note is
on the case, `awaiting_form` is cleared, and anybody opening it sees the paperwork arrived.

### What changed while building, and why

| # | Change |
|---|---|
| 1 | **`findEmailColumn`'s third parameter is required, not defaulted.** Every one of the six existing call sites now has to answer "is a column named here?", which is the `mainMenuKeyboard` rule — make the wrong thing impossible to write rather than merely tested for. |
| 2 | **There was no test asserting the word "Reword".** The plan said to search for one and update it. It does not exist; the two tests guarding that message assert the headings and the reason, and both survive the rewording untouched. So an assertion was **added** instead — the message must name the tab, both headings, and `EMAIL_COLUMN`, and must *not* contain "Reword". The advice that would damage a correct question cannot come back unnoticed. |
| 3 | **`AwaitingFormComplaint` carries `attempts` as well as `formType`.** The plan's snippet omitted it. The shared retry helper counts attempts, and without the field a teacher sending photographs would be held at the prompt for the whole life of the state — the exact fault `handleUrgentDetail` already records having had. |
| 4 | **`chooseDocForm` gained a `chatId` parameter.** It has to write the conversation state, and it had no way to say whose. |
| 5 | **`handleCaseDetail` was split rather than reused.** The plan says "route it through the same helper `AwaitingCaseDetail` uses"; there was no such helper — the filing path *was* `handleCaseDetail`. It is now `fileTypedCase`, taking the resolved category and optional area, with `handleCaseDetail` and `handleFormComplaint` as its two thin callers. One expression of the D11 announce rule, the attempt counter and the revoked-mid-conversation recovery, not two. |
| 6 | **The router test went in `router.integration.test.ts`**, which drives `route` end to end, rather than the FAQ handler file the plan offered. `form_links` was added to that file's `TRUNCATE` and to `notify.integration.test.ts`'s — the fault that file's own comment records: a feature that starts reading a table breaks every test file that does not clean it. |
| 7 | **Two migrations, `0012_form_areas` and `0013_case_form_area`.** Both read before accepting; three `ADD COLUMN` and two `ADD COLUMN` respectively, and nothing else. |

### Tests added beyond the plan

Six, each guarding something the plan's own reasoning depends on but did not check:

- **The three columns update on a second sync, not only insert on the first.** Set-on-insert-only is
  the classic `onConflictDoUpdate` omission, and it would leave MoPSE editing a cell that silently
  never took effect.
- **The same two-email-column tab is refused when nothing is named**, which is what proves the named
  column is doing the work rather than luck.
- **An attach is as idempotent as a create** — re-reading the tab must not add a note to the
  complaint every ten minutes. The marker's primary key is the guarantee and the new path had to be
  shown to keep it.
- **The notice says the form is in** once `awaiting_form` is cleared, not merely that it is missing.
- **A case whose area has left the sheet still notifies**, naming the raw code. That is the whole
  reason `form_type` is not a foreign key, and nothing else asserted it.
- **A form with no `PREPARE` is unchanged**, including that it captures nothing the teacher types
  next — which is what keeps this feature from altering Submit Documents for everybody.

### On the verification, honestly

**The tests were written before their code, but not run before it.** The head of project asked
mid-session for one run at the end rather than a run per task, which was built as asked. The cost is
that no new test was watched failing for the right reason at the moment it was written.

That was paid back afterwards rather than waived: the two load-bearing behaviours — the retired-form
rule and the named email column — were **broken on purpose** and the suite re-run. Exactly five tests
failed and each mapped to the behaviour broken; "reads a form that is still on the sheet" correctly
went on passing. Then both were restored and the suite went green again. A test that has never been
seen to fail is not yet a test, and these have now been seen to fail.

### On the commits

**Task 1 ships alone, as intended**, and was reconstructed and verified in isolation — typecheck
clean and 35 tests green with nothing else from this work in the tree — before being committed. The
remaining tasks collapsed into one commit: building everything before committing anything meant the
test files carried several tasks at once, and separating them further would have needed the same
surgery for changes that ship together anyway.
