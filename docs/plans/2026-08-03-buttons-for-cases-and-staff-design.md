# Buttons for cases, and adding staff: the design

**Date:** 3 August 2026 · **Status: ✅ BUILT — branch `feature/case-and-staff-buttons`, commits
`eee9e61`…`bd7a81b`.** Belongs to `2026-08-01-identity-and-urgent-design.md`, which stays the plan of
record. This document supersedes that plan's Part 5G §"What gets a button, and what cannot" and its
Part 5C — see §2.

```
1,319 tests across 71 files · 0 failed · 0 skipped · 259 seconds
typecheck clean · build clean · lint 0 warnings · deps zero cycles, zero layer violations
```

**Every number above was run on 3 August 2026 against the tree as committed.** The suite gained 155
tests; nothing was removed.

> **Designed first, built second.** The design below is as it was approved. Where building it
> changed something, the change is marked inline rather than written over the top — §7 carries the
> one change of substance the head of project made during the build, and §13 carries what building
> it found.

> Asked for by the head of project on 3 August 2026. Their words, because they set the whole scope:
> *"it is a big hassle to constantly keep typing the case number everytime"*, and — when asked
> whether the actions needing words should also be buttons — *"i have buttons instead of any slash
> command related to case or staff inputs remain manual from me like comments or notes."*
>
> **That sentence is the design.** A button replaces every command word and every case reference.
> The only thing a staff member types is the content they were always going to write themselves.

---

## 1. What is wrong today, and what is already right

Three things the head of project asked for **already exist**, and this was checked in the code
before anything was designed on top of them.

- **`/staff` is already entirely button-driven** — built 1 August 2026 as Part 5H.3. List of people
  as buttons → tap somebody → "Change rank / Change queue / Change regions / Remove from staff" →
  tap one → choose from a list of ranks. Exactly the shape asked for again on 3 August. Nothing in
  this document changes it.
- **Case lists already carry one button per case.** `/cases`, `/mycases`, `/urgent` and `/search`
  each hang a `📂 VISA-2026-00311` button under the list, and it opens the case. Part 5G, 1 August.
- **`"TEST DATA — "` appears nowhere in this repository.** It is in the FAQ Google Sheet. See §6.

What is wrong is what happens **after** the case opens. `/case` returns text and no keyboard at all,
so every one of the fourteen things a staff member can do to a case still begins with typing a
nineteen-character reference by hand — including `/reply`, which is the commonest action anybody
performs in this bot. The button that opens a case leads to a dead end.

The second gap is `/staff_add`. Every other staff command got buttons on 1 August; adding a person
did not, and it is the one place a rank and a queue still have to be spelled correctly from memory.

## 2. What this supersedes, and why

The plan of record, Part 5G, drew this line:

> **One tap, no typing - build these:** open a case, take it (assign to self), mark urgent, close,
> reopen.
>
> **Needs typing - leave as commands:** `/reply`, `/note`, `/due`, `/snooze`.
>
> The split is not arbitrary. Anything carrying free text needs the bot to remember *"this staff
> member is now writing a reply to case X"*, and **conversation state is a teacher-facing machine
> today** - there is no staff-facing multi-step flow anywhere in the codebase.

**The reasoning was right and the conclusion is now wrong**, because the estimate behind it was made
before Part 5H.3 existed. That part built the harder half: `staffMenuView` decides what a tap means
and returns `run('/staff_role 991001 Lead')`, which the dispatcher executes through the same
function that executes a typed command. Free text is that pattern plus one remembered row.

It was put to the head of project on 3 August that the split would leave the reference typed for the
commonest action of all. They chose the whole thing. **Part 5G's split and Part 5C's separate
interactive-`/staff_add` design are both replaced by this document.**

## 3. The decisions the head of project made

All four were taken on 3 August 2026 and all are binding.

| # | Decision |
|---|---|
| 1 | **Every case action is a button.** Actions needing words prompt for the words; the reference is never typed. |
| 2 | **`/staff_add` by button asks for rank, then queue.** Regions are not asked at add time — the new member covers every region, which is what happens today when regions are left off, and "Change regions" is one tap away on their row. |
| 3 | **The wording pass covers the sign-in prompt and the privacy notice, and nothing else.** |
| 4 | **Built in two shipping pieces** — §8. |

One thing was raised, answered, and is recorded because it cost a round: the head of project first
chose the smaller split, was told once that it would leave `/reply` typing the reference, and
reversed it. **The concern was raised once and is not raised again.**

---

## 4. The case menu

### What a staff member sees

Tapping a case open — or typing `/case VISA-2026-00311` — returns exactly the text it returns today,
with a keyboard under it:

```
[ 💬 Reply to teacher ]
[ 📥 Ask them for something ]
[ ✅ Close it ]
[ 📝 Add a note ]
[ 👤 Give it an owner ]
[ ❗ How serious is it ]
[ 📅 Promised by ]       [ 😴 Snooze ]
[ ⬅️ Back to my cases ]
```

On a **finished** case that shrinks to `Add a note`, `How serious is it`, `↩️ Reopen` and `Back` —
see the paragraph after next. `Close it` and `Reopen` are never drawn together, because they are the
two answers to one question.

`⬅️ Back to my cases` runs `/mycases`, which is the list a staff member arrives from most often and
the one that needs no argument.

### The keyboard is built from what the tapper holds

**A button shown and then refused is worse than no button**, and Part 5G wrote that down as a
constraint before anything was built. The floors differ across these actions and two of them are far
apart: `case.update` floors at Support, `case.mark` at Support, and `case.assign` at **Program**. So
a Support member must not be shown "Give it an owner".

The keyboard is therefore built by asking `can(member, capability)` — the same function that does
the refusing, called from the same `StaffRecord` the dispatcher already resolved. There is no second
table of who-sees-what, so the advertised keyboard and the enforced rule cannot drift apart. This is
the property `/whoami` and `/help` already hold and it is being extended, not invented.

Closed cases are a second filter on the same keyboard: `Reply`, `Ask them for something`, `Close`,
`Promised by` and `Snooze` are refused on a finished case by the commands themselves, so they are
not drawn on one. `Reopen` is drawn only on a finished case. `Add a note` and `How serious is it`
are drawn on both, deliberately — a note is a record rather than an action, and importance is the
one judgement that is worth making after a case is over, because retention reads it.

### What each button does

| Button | Capability | Behaviour |
|---|---|---|
| ↩️ Reopen | `case.update` | Acts on the tap |
| 👤 Give it an owner | `case.assign` | Shows the staff who cover this case's queue and region, as buttons |
| ❗ How serious is it | `case.mark` | Shows Normal / Urgent / Critical, ticking the current one |
| 😴 Snooze | `case.update` | Shows 7 / 14 / 30 days, and "stop snoozing" |
| ✅ Close it | `case.update` | Asks *resolved or not resolved?* then asks for the words |
| 💬 Reply to teacher | `case.update` | Asks for the words |
| 📥 Ask them for something | `case.update` | Asks for the words |
| 📝 Add a note | `case.update` | Asks for the words |
| 📅 Promised by | `case.update` | Asks for the date, typed |

**Every one of them ends by handing a typed command to `routeStaffCommand`.** `Reopen` runs
`/reopen VISA-2026-00311`. `How serious is it → Critical` runs `/mark VISA-2026-00311 Critical`. A
reply, once written, runs `/reply VISA-2026-00311 <what they wrote>`.

Nothing below decides anything, and that is the entire safety argument. `/close` remains the single
place that knows a finished case may not be closed twice; `/assign` remains the single place that
checks the new owner can actually see the case; `/snooze` remains the single place that holds
`MAX_SNOOZE_DAYS`; `noticeForTeacher` remains the single place that warns when a teacher can no
longer read what was sent to them. **A second copy of any of those is the thing this must not
create**, and it is avoided the same way Part 5H.3 avoided it.

### After an action, the case comes back

The staff menu answers a tap with the command's own reply followed by the list again. The case menu
answers with the command's own reply followed by **the case again, with its keyboard**. That is the
difference that makes it a workspace rather than a one-shot: reply to the teacher, then note
something, then set a date, without retyping anything or going back through `/cases`.

The command's reply goes first in both, because it is the message that says what changed — or
refuses, with the reasons only the command knows.

### The owner list

`staffCovering(db, { category, region })` already exists in layer 2 and already answers "who covers
this queue and this region". The buttons need names as well as ids, which is one extra read of the
staff rows. **No new query, and no second expression of who covers what.**

If the list is empty the menu says so in the words `/case` already uses for it — *no active staff
member covers this queue and region* — rather than showing an empty keyboard.

### Re-validation on every tap

Unchanged from the rule Part 5G and 5H.3 both hold, restated because it is the reason any of this is
safe: **a message sits in a Telegram chat for ever.** Each tap re-reads the active staff row, checks
the capability *the action* needs, resolves the case through `findCase` so the visibility scope
applies, and then the command re-checks the case's own state inside its conditional `UPDATE`. The
person tapping today may have been demoted, deactivated or moved regions since the keyboard was
drawn, and none of that changes the payload sitting in their chat.

## 5. Remembering what somebody is writing

This is the one genuinely new mechanism, and the only part of this work with no precedent.

### Where it is kept

In `conversation_states`, the table that already holds where a teacher is. It is one row per chat,
its expiry is a stored deadline enforced on every read, and `conversation_states.state` is free text
in the database on purpose **so that adding a state needs no migration**. Two staff states join the
union in `src/conversation/state.ts`:

```
AwaitingCaseText   { action: 'reply' | 'await' | 'note' | 'due' | 'close' | 'close-unresolved',
                     reference: string }
AwaitingStaffId    { }
```

Two alternatives were considered and rejected. **A separate table for staff** buys nothing the
existing one does not already give — expiry, one-place-at-a-time, a rollback story for a payload a
newer build wrote — and costs a migration and a second module. **Telegram's own `force_reply`**,
which would carry the reference in the quoted message and need no state at all, cannot be used:
`force_reply` and an inline keyboard are mutually exclusive on one message, so the Cancel button
would have to go, and the reference would have to be parsed back out of our own prose.

### The rule that has to be stated

**While a staff member is in `AwaitingCaseText`, their next text message is the content — even if it
begins with a slash.**

Without this, `/close the window in her flat is broken` is matched as `/close`, fails with *"I need
a case reference first"*, and the staff member's words are gone. With it, that sentence reaches the
teacher as written.

The cost is that no command works while the bot is waiting, which is why there are three ways out
and all three are cheap: a **Cancel** button on the prompt, the word `/cancel` typed, and a
**30-minute expiry** that needs nobody to remember it. `CONVERSATION_TTL_MINUTES` is already 30 and
is not changed.

The check therefore sits in `route()` **before** `routeStaffCommand`, which is the one place in the
router where a staff path is allowed to run ahead of the command dispatcher, and it is guarded: it
runs only for a chat that has an active staff row **and** a staff state. A teacher can never enter
one of these states, so the teacher state machine is untouched and its order is unchanged.

### A staff member who is also a teacher

One row per chat means a staff member who is also a signed-in teacher can hold only one state. That
is correct rather than a limitation — a person is in one place at a time — and the observable cost
is that tapping "Reply" while half-way through describing their own case abandons the half. Recorded
here rather than discovered later.

## 6. Adding staff by button

The staff list gains one button at the bottom:

```
[ ➕ Add somebody ]
```

Tap → *"Send me their Telegram chat id."* → they type the number → **rank** as buttons → **queue** as
buttons → `/staff_add <id> <rank> <queue>` is run, and the new member is told they have access.

- **The id is typed because it is the one thing only the person adding knows.** Everything else is
  chosen.
- **Queue is asked, never guessed.** `/staff_add` refuses to default it today, and the recorded
  reason is that defaulting "would give somebody more than you asked for, and nothing in what you
  typed would show it". A menu defaults nothing — it makes answering a tap. The refusal stands and
  is now reachable in two taps.
- **Regions are not asked**, per decision 2. The row is created covering every region, which is
  exactly what `/staff_add 991001 Support Visa` does today with no regions given, so this introduces
  no visibility a typed command did not already grant. "Change regions" is on their row immediately
  afterwards.
- **Once the id is known it travels in the payload, not in state** — `SA:991001:Support` — for
  `CALLBACK.STAFF_MENU`'s reason: a menu left for an hour must not act on whoever was chosen an hour
  ago. Only the id-typing step needs a state, and it is the one step with nothing to carry.
- `StaffAlreadyExistsError` is already handled by `/staff_add` and its answer is already the right
  one. It is reached unchanged.

## 7. The wording

### The sign-in prompt

Today, in `signInPromptReply`:

> To continue, please reply with the email address you were recruited with. Replying means you have
> read the notice above.

Two faults. *"Reply with"* reads as a Telegram reply to a specific message, which is not what is
wanted and is a real thing a teacher can do wrongly. And the instruction sits **after** the entire
privacy notice, which is the longest message this bot sends.

The instruction moves to the top and says what it means:

> **Enter your email address** — the one you were recruited with.
>
> Sending it means you have read the privacy notice below.
>
> — — —
>
> 🔒 Privacy notice
> …

The notice is still in the same message, so it still cannot be separated from the act that
acknowledges it — the property the current ordering was chosen for is kept, not traded away.

### The notice itself

Rewritten with the `humanizer` skill. ~~**The content is not being changed**~~ — the head of
project's words were *"the core of the message is fine i just don't like the way it is written"*.
What is held, what it is used for, who can see it, how long it is kept, the dispute sentence and the
access route all say the same things afterwards.

> ### ⚠️ CORRECTED, 3 August 2026 — one thing in the content did change
>
> The rewrite was shown to the head of project before it landed, as promised above. They asked for
> the access-and-removal route to be changed: *"instead, tell them to contact their regional admin …
> the one who is responsible for the region the user is in."*
>
> It was first put to them that removing the route altogether would leave the notice describing what
> is collected with no way for anybody to ask about it or get out. They did not remove it — they
> **replaced the contact with the regional admin**, which is a better first answer than the one that
> was there: a regional admin is a person a teacher can actually reach, and they are already
> handling that teacher's cases, so the request lands with somebody who can act on it.
>
> **The support number was kept underneath it, and that choice was made without asking.** This
> system has a real state in which a teacher has no recorded region — `/case` prints "region not
> recorded" against it, and it is *why* every staff member can see that teacher's case. For them
> "your regional admin" names nobody. The same is true of a teacher whose access has ended, which is
> exactly when somebody asks to be forgotten. `supportContact` is validated at start-up and cannot
> be a placeholder, so the second line is always a route that exists.
>
> So the notice now reads:
>
> ```
> Asking what we hold, or asking us to delete it
> Contact your regional admin: the staff member responsible for the region you work in.
> If you do not know who that is, contact +998 71 000 0000.
> ```
>
> A test asserts **both** lines, for the two different teachers each one is for.

Three other things changed in how it reads, beyond word choice, and all three were approved before
they landed:

- **The dashes went.** Three sentences hung a clause off a dash, and each dash was carrying the part
  a teacher was most likely to have assumed wrongly — that the bot does *not* hold a Telegram
  display name, and that the permanent access record excludes their messages. Each is its own
  sentence now, and a test keeps it that way.
- **The headings name a subject.** "What is held" and "It is not shared" describe a filing cabinet
  with nobody standing at it. A teacher asking who has their email address is owed an answer, so it
  says what **we** keep and what **we** do.
- **The hand-wrapped lines went.** The text was wrapped by hand at about seventy characters. Telegram
  wraps for itself, so on a phone every paragraph wrapped twice and came out ragged. One blank line
  had to be added where the hand wrapping had been doing the work of a paragraph break.

Two constraints the rewrite must not break, both already protected by tests in `src/config/`:

- **No number of days is typed into the file.** The three retention periods are settings MoPSE can
  change without a deploy, and a test reads this file's own source to assert it.
- **No asterisks.** Nothing in this bot has ever turned Telegram formatting on, so an asterisk is
  punctuation a teacher reads.

**`PRIVACY_NOTICE_VERSION` is bumped to `2026-08-03.1` in the same commit**, and the cost of that is
the reason the pass was kept narrow: every teacher who has already signed in is asked to read and
accept it again. **That is eight people today and 1,800 after launch.** Doing it now is the cheap
moment; doing it twice is not.

## 8. The FAQ prefix — checked, and deliberately not built

`"TEST DATA — "` is in the FAQ Google Sheet, not in this repository. A search of every `.ts`, `.md`,
`.sql` and `.csv` file outside `node_modules` returns nothing.

**The bot cannot remove it.** `src/sheets/client.ts` requests `spreadsheets.readonly` and the
service account holds Viewer, deliberately and at every level.

Put to the head of project on 3 August with three options — clean the sheet, strip the phrase during
the sync, or both. **They chose to clean the sheet.** So there is no code change here at all: they
find-and-replace it in Google Sheets, the next roster sync carries the clean answers through, and no
workaround about one temporary phrase is left in the parser for somebody to find in a year.

This section exists so that the next person to ask "why doesn't the code handle that" has the
answer.

## 9. What changes

New files are marked. Layers are the four in `CLAUDE.md` §2; **nothing below imports from a layer
above it**, and the two upward-pointing needs are both satisfied without one.

| File | Layer | Change | Piece |
|---|---|---|---|
| `src/telegram/callback-data.ts` | 1 | `CASE_ACTION: 'CA'` and `STAFF_ADD: 'SA'`, each documented as the others are | 1, 2 |
| **`src/telegram/commands/case-menu.ts`** | 3 | **New.** The keyboards, `caseMenuView` returning show-or-run, and the command a captured message becomes | 1, 2 |
| `src/telegram/commands/cases.ts` | 3 | `oneCase` hangs `caseActionKeyboard` under `renderCase`. Nothing else in the file moves | 1 |
| `src/telegram/commands/index.ts` | 3 | `routeCaseMenu` and `routeStaffWriting`, both shaped exactly like `routeStaffMenu` | 1, 2 |
| `src/telegram/router.ts` | 3 | `case CALLBACK.CASE_ACTION`, `case CALLBACK.STAFF_ADD`, and the writing-state branch before `routeStaffCommand` | 1, 2 |
| `src/conversation/state.ts` | 2 | Two staff states join the discriminated union. **No migration** | 2 |
| `src/telegram/commands/staff.ts` | 3 | The `➕ Add somebody` button and the `SA` flow, beside the 5H.3 menu it copies | 2 |
| `src/telegram/handlers/menu.ts` | 3 | `signInPromptReply` reordered and reworded | 2 |
| `src/config/privacy.ts` | 1 | The notice rewritten; `PRIVACY_NOTICE_VERSION` → `2026-08-03.1` | 2 |
| `docs/dependency-tree.md` | — | Regenerated by `npm run deps`, committed with the code | 1 |

**The one import that would have been a cycle, and how it is avoided.** `case-menu.ts` cannot call
`routeStaffCommand`, because `index.ts` already imports the commands. So `case-menu.ts` decides
*what* should happen and returns it; `index.ts` carries it out. This is the split Part 5H.3 found
and it is copied rather than re-derived — and it is what makes an acting tap run through the same
function a typed command runs through, rather than through something that resembles it.

**Why `case-menu.ts` is a new file rather than more of `cases.ts`.** `cases.ts` is 1,240 lines and
holds fourteen commands. The menu is about 250 more, and it has a different job: `cases.ts` answers
"what does this command do", the menu answers "what does this tap mean". `staff.ts` kept its menu
inline and is now 1,937 lines, which is the outcome being avoided rather than repeated. The
boundary is clean in one direction — `cases.ts` imports the keyboard, `case-menu.ts` imports nothing
from `cases.ts` — so there is no cycle to manage.

### The byte budget

`callback-data.ts` is layer 1 by explicit override because it is a pure codec, and Telegram's
ceiling is 64 bytes. The longest payloads these prefixes can build:

| Payload | Bytes |
|---|---|
| `CA:CONTRACT-2026-99999:M:Critical` | 33 |
| `CA:CONTRACT-2026-99999:OWN:9999999999` | 38 |
| `SA:9999999999:Accommodation` | 27 |

`CONTRACT-2026-99999` is the longest reference this system can build. **A test measures each with a
real value** rather than trusting the arithmetic here — extending the existing measurement test, as
`CLAUDE.md` §2 requires.

## 10. What proves it works

Integration tests against a real PostgreSQL, written in the same commit as the code they cover.

- **Every button is tapped by somebody who may not use it, and the refusal is asserted.** Not the
  absence of the button — the tap. A Support member taps "Give it an owner" on a payload they were
  never shown; a demoted member taps a payload drawn when they were Program; a member who has moved
  regions taps a case they can no longer see. **"Assert the refusal, not the absence"** is the
  project's own rule and it is the reason these tests exist at all.
- **Every acting tap is shown to produce the same outcome as the typed command**, including the
  refusals only the command knows — closing a closed case, assigning to somebody who cannot see it,
  snoozing past `MAX_SNOOZE_DAYS`.
- **The writing state is tested for the slash case**: a reply whose first word is `/close` reaches
  the teacher intact.
- **Cancel, `/cancel` and expiry** each leave the chat with no state and no case changed.
- **The keyboard is asserted per rank**, so a floor changing in `roles.ts` and not here fails a test.
- **`callback-data.test.ts` measures the three payloads above** with real values.
- **`privacy.test.ts`** keeps its two existing guards — no typed day counts, no asterisks — through
  the rewrite.

Then, once **all** of it is built and not before — the head of project asked for this explicitly:

```
npx vitest run     # 0 skipped, or the run proved nothing
npm run typecheck
npm run build
npm run lint
npm run deps:check
```

Every number stated plainly.

## 11. The two pieces

Chosen by the head of project on 3 August so the case menu can be tried on the live bot before nine
more buttons are built on top of a layout that might be wrong.

**Piece 1 — the case menu, no typing.** Reopen, Give it an owner, How serious is it, and Snooze —
the four actions that need no words at all. Plus the capability-filtered keyboard, the case coming
back after each action, the callback prefix and its measurement test, and `routeCaseMenu`. **Usable
and committed on its own**, and it is the piece that proves the layout before the rest is built on
it.

**Close is not in piece 1.** Both halves of it need words — the resolved half is the message the
teacher receives, and the unresolved half is the reason recorded on the case. There is no half of
`/close` that a tap alone can complete, and inventing one would be the bot writing words nobody
chose to send.

**Piece 2 — the writing states, `/staff_add`, and the wording.** Reply, Ask them for something, Add
a note, Promised by, and both halves of Close; the `➕ Add somebody` flow; the sign-in prompt and the
privacy notice.

Each piece is verified on its own before it is committed, per `CLAUDE.md` §5. The full five-check
run happens once, after piece 2.

## 12. What is not being done

- **The `/staff` menu itself.** It already does what was asked for. Untouched.
- **The typed commands.** All fourteen still work, unchanged. Nothing is removed, and `/help` and
  `/whoami` still list them.
- **The case list rows.** The three-line format settled on 1 August stays, and no teacher name joins
  it.
- **Teacher-facing wording beyond the sign-in prompt**, per decision 3.
- **Any database migration**, any change to who can see what, and any change to a capability floor.
- **`CASE_LIST_BUTTON_CAP`**, which stays at 8.

---

## 13. What building it cost, and the three faults it found

Built on 3 August 2026 across five sittings, each one a fresh worker holding only the tasks in front
of it. The estimate was three days including tests. **Every fault below was found by running
something**, and two of them were found only because a step that was supposed to go red went green.

### ⚠️ Fault 1 — three new tests were green over a prefix that did not exist

The byte-budget tests written with `CALLBACK.CASE_ACTION` asserted only that the payload **fitted**
inside 64 bytes. `vitest` transpiles rather than type-checks, so a `CALLBACK` member that does not
exist is `undefined` at runtime; `encodeCallback` stringifies it, and
`"undefined:CONTRACT-2026-99999:M:Critical"` is 39 bytes against a limit of 64.

**All three passed before the prefix was written.** Nobody would have noticed, because they went on
passing afterwards too. It surfaced only because the red step of the cycle did not go red and that
was reported rather than shrugged at.

They now assert the payload they built. Proved by setting the prefix to `XX` and watching exactly
those three go red before restoring it — `CLAUDE.md`'s rule that a checker must be made to fail on
purpose before it is believed, applied to a checker this project had just written. Commit `417f821`.

**The other prefixes in `callback-data.test.ts` are measured the same length-only way.** None is
green over nothing today, because each was written against a member that already existed — but the
shape is the same and the next one added would inherit it. Left alone rather than widened into an
unrelated change, and written down here instead.

### ⚠️ Fault 2 — a refusal test that could never have passed

The scope test compared the refusal for a case in another queue against the refusal for a case that
does not exist, asserting they are identical — which is the property that stops the bot confirming a
teacher filed something. But each refusal **echoes its own reference**, so the two strings could
never be equal no matter how correct the code was.

The sibling test in `cases.integration.test.ts` had solved this years of commits earlier by
normalising both sides first. That was copied. Commit `7082acb`.

### ⚠️ Fault 3 — a fixture using a case status that does not exist

The `/cancel` test set up a case at `Submitted`. `case_status` is a PostgreSQL enum and its values
are `New, Received, Under review, Action required, Escalated, Completed, Closed, Duplicate`. The
insert threw. Caught immediately, and it is in this list only because a plan that names a value
without checking the schema will name a wrong one again.

### The ordering decision, proved rather than asserted

The one genuinely new mechanism here is that a staff member writing a reply has their next message
treated as **content, even when it begins with a slash** — so `/close the window in her flat is
broken` reaches the teacher as written instead of being half-matched as a command and thrown away.
That rests entirely on `routeStaffWriting` running **ahead of** the command dispatcher in
`routeText`, which is a two-line ordering that a later refactor could reverse without anything
looking wrong.

It was checked by moving the branch after the dispatcher and running the suite. **Exactly one test
went red, and it was the right one.** The ordering is held by a test rather than by the comment
explaining it.

### What was cheaper than the estimate, and what was not

The buttons themselves were as cheap as the head of project said they would be — *"it is only just
taking a preexisting function and making it into a button"* — and that was the correct reading. Nine
buttons is a keyboard function and a `switch`, because Part 5H.3 had already built the pattern.

The cost was where the estimate said: the writing states, which had no precedent anywhere in this
system, and the tests, which are most of every change here. The suite gained **155 tests** against
roughly 900 lines of source.

### What the head of project has not seen yet

**None of it has been run against the live bot.** Piece 1 was built to be tried early and the branch
was carried straight through to the end instead, so the first person to tap `💬 Reply to teacher` on
a real case will be them. The button layout in §4 is the thing most worth their eye: it was approved
as a description and has never been looked at as a screen.
