# MoPSE bot — programme plan

**Date:** 1 August 2026 · **Status: THE PLAN OF RECORD.** This is the one
document that says where the project stands, what is next, and what is
undecided. Supersedes the "what's next" list in
`2026-07-31-vps-deployment-handoff.md`, which is stale.

> **Read `CLAUDE.md` for how to work here** — the layer rule, the coding
> patterns, the ripple and dependency-tree procedures, how to run the tests, and
> what verification has to pass before anything is called done. It loads
> automatically, so it is already in front of you.
>
> **The rolling handoff was retired on 1 August 2026** and is in
> `docs/plans/archive/`. Its two surviving open decisions are items 0 and 5 of
> Open questions below. Do not go looking for a handoff; there is not one.

> **Revised 1 August 2026, after building Feature B.** Three changes, all made by
> the head of project and all binding:
>
> 1. **"Urgent" means high priority, not emergency.** Open question 2 below is
>    answered **no** — the acknowledgement names no emergency contact, because
>    the bot is not a crisis line. Every message on that path was rewritten and
>    the menu button now reads **⏫ Ask for Priority**.
> 2. **The one-time code route was withdrawn entirely**, rather than surviving
>    "for the phone route" as Part 3 assumed.
> 3. **Two items were added to the order** — the login-gating hole (Part 5F) and
>    case-list buttons (Part 5G). Both came out of building B and neither was in
>    the original document.

---

# PART 0 — Build rules that constrain every feature below

The dependency checker reports **zero cycles and zero layer violations**. That is
a property to preserve, not rediscover.

```
Layer 4  src/worker/ src/web/ src/scripts/   processes
Layer 3  src/telegram/                       router, commands, keyboards
Layer 2  cases teachers staff db sync …      stores: database, no Telegram
Layer 1  send.ts callback-data.ts            pure leaves
```

**Nothing may import from a layer above it (D46).** Three consequences bind the
work below:

1. **Stores must not send messages.** `verifyIdentifier` (layer 2) *returns*
   `priorHolders`; `router.ts` (layer 3) sends. Every new store module follows
   this shape — return what needs sending, never send. This is the single
   easiest way to break the layering.
2. **New callback prefixes are safe but share a budget.** `callback-data.ts` is
   layer 1 and is imported by `sheets/parse.ts`, which rejects FORMS rows whose
   TYPE would overflow Telegram's 64-byte payload. Add prefixes freely; do not
   grow the budget.
3. **`cases/notify.ts` type-only imports `router.ts`.** The notification shape
   lives in layer 3 while sending logic sits in layer 2. Legal only because the
   import is type-only and erased at compile time. Keep it that way.

**Migrations are forward-only, with no down path.** Everything below is purely
additive — one new table, four new nullable columns — so a code rollback works
against the newer schema.

---

# PART 1 — Done

## Deployment (31 July, complete)

Server `46.8.195.231` · Ubuntu 24.04 · Docker · `bot.fteacherssupport.uz` with
Let's Encrypt certificate · private repo `HussainN91/UZTGBOT` with read-only
deploy key · four containers healthy · migrations applied · webhook registered,
no errors · `@Mopse_test_bot` · sheet synced with service account Viewer only.

**Data:** 8 roster rows, 20 FAQ (19 active), 3 form links, 2 System staff.

## Test run — complete, no blocking defects

## Defects logged, not fixed

| | Severity |
|---|---|
| `scripts/sync-sheets.ts` never syncs FORMS; the scheduled worker does, so forms arrive within ten minutes — but the manual first-load command the deploy guide points at skips them | Low, task raised |
| `.env.example` omits `POSTGRES_PASSWORD` and `BOT_HOSTNAME`, both required by compose | Low |
| `pg` deprecation: a query issued on a connection already executing one | Low, breaks on next major |

## Launch blockers, operational

- **Revoke the test bot token** — it has been in chat and shell history
- **Confirm the sheet is no longer publicly editable**
- **`OPS_ALERT_CHAT_ID` is one private chat.** Must be a group — the
  duplicate-binding alarm is the only impersonation control and it currently
  reaches one sleeping phone
- **No backups.** `BACKUP_PASSPHRASE` / `BACKUP_REMOTE` empty, restore drill
  never run
- **Uzbekistan hosting unconfirmed.** `apt` used Russia's mirror

---

# PART 2 — Feature A: identity dispute escalation

**~3.5 days.**

## Behaviour

On a duplicate binding, a dispute record opens and **both** chats receive a
message with one button.

| Party | Button |
|---|---|
| Prior holder | ⚠️ **This wasn't me** |
| New chat | ✅ **This is me — I changed phone** |

Both record who tapped which and escalate. **Neither decides anything** — both
parties can tap, and no wording lets a party self-certify.

The second chat **still signs in**. The dispute runs alongside; it does not gate
access. Blocking would lock out any teacher who changes number and would let
anyone with a leaked email lock the real teacher out permanently.

## Which regional manager

**The roster region for the disputed identifier** — never `regionFor(chatId)`.
The two chats can carry different `regionOverride` values, so a per-chat lookup
would let an imposter with an override choose their own adjudicator.

If **no staff member covers that region**, escalate straight to System. A region
nobody covers must not become a dispute nobody sees.

## What the manager receives

The disputed roster identity (**name and email**), and for each chat its
**Telegram ID, display name, and which button was pressed**.

**Telegram never gives bots phone numbers.** Only a native "share contact"
button the user taps would. Optional later, ~0.5 day.

Their message carries one button: **Send to system admin**.

## Resolution — System only

Floored at System, not Program, because it is hard to undo — matching
`teacher.forget`.

Resolving names the chat that keeps the identity. For the **losing** chat:

- It is **Revoked** — reversible via `/restore`, reusing existing machinery
- Its identifier is cleared
- **Its cases are closed with a stated reason, not deleted**

### Why closed rather than deleted

Deletion was requested and is not being built, for three reasons:

1. **It contradicts the reversible revoke chosen alongside it.** If the
   adjudication is uncertain enough to want `/restore`, the cases must not be
   destroyed in the same action.
2. **If the losing chat was the imposter, its cases are the evidence** of what
   they did and saw — exactly what an investigation needs.
3. **The audit trail is deliberately never pruned here**, and `/forget`
   anonymises rather than deletes.

Retention removes them on its normal schedule. Hard deletion, if ever wanted,
should be a separate System action after the dispute is settled — never
automatic. `cases.teacher_chat_id` is `onDelete: restrict`, so deletion would
require destroying cases first regardless.

Resolution writes an audit row **in the same transaction** as the change.

## Dispute lifecycle

```
Open → Claimed → Escalated → WithSystem → Resolved
```

- **A third chat signing in joins the existing dispute** — keyed on identifier,
  never a second record
- **No auto-expiry.** Unresolved disputes surface in the ops digest so they
  cannot be silently forgotten — visibility over automation, as elsewhere
- **Every button re-validates on tap** against this state. Tapping a resolved
  dispute says so rather than re-firing

## New table

Dedicated, not a new `CASE_CATEGORY` — that would ripple into
`QUEUE_FOR_CATEGORY`, `CASE_REFERENCE_PREFIX` and retention. A dispute is not a
teacher's support request.

```
identity_disputes
  id, identifier, state, prior_chat_id, new_chat_id,
  prior_claimed_at, new_claimed_at,
  escalated_to, escalated_at, system_notified_at,
  resolved_by, resolved_at, outcome, opened_at
```

## Ripple map

| File | Layer | Change |
|---|---|---|
| `src/db/schema.ts` + `drizzle/` | 2 | New table, additive |
| `src/teachers/disputes.ts` **new** | 2 | Open, claim, escalate, resolve. **Returns messages, never sends** |
| `src/telegram/router.ts:530-558` | 3 | Open dispute, attach buttons, send |
| `src/telegram/callback-data.ts` | 1 | 3 prefixes |
| `src/telegram/keyboards.ts` | 3 | Dispute keyboards |
| `src/telegram/commands/staff.ts` | 3 | Resolution command + audit |
| `src/staff/roles.ts` | 2 | Reuses `staff.manage` floor (System) |
| `src/log/interactions.ts` | 2 | Redaction for dispute taps |
| `RUNBOOK.md`, `BOT-SPEC.md` | — | The new route |

**Unchanged:** `verifyIdentifier`, roster sync, the binding rule.

## Cost

Buttons on both messages 0.5 · dispute record + escalation 1 · manager forward
button 0.5 · resolution command, case closing, audit 0.5 · revalidation and
tests 1.

---

# PART 3 — Feature B: the urgent-case gate

**✅ BUILT — 1 August 2026, commit `90827f8`.** Took roughly the estimate. `RUNBOOK.md` §4.4 and
§4.4a and `BOT-SPEC.md` §6.6 are rewritten to match, and the handoff records what
changed. **What is written below is the design as agreed; where the build
departed from it, the departure is marked inline.** Read those marks — two of
them are the difference between the feature working and the feature quietly
granting itself the thing it is supposed to ration.

**~3.5 days.**

## Behaviour

1. Teacher taps **Urgent Case**, describes the problem, submits
2. Filed immediately at importance `Normal`, stamped `urgent_requested_at`
3. Regional admin notified at once with the teacher's roster name and email
4. Admin verifies however they normally would
5. Admin taps **Confirm urgent** → importance `Urgent`, **the case's owner is
   notified and its state updates automatically**, Program admins notified

No code changes hands in this path.

## Deduplication — the common path, not an edge case

Urgent cases file under Contact Support, and so does every ordinary Contact
Support case, so an urgent request landing on an existing open case is normal.

**Decision: append to the existing case, never create a second one.**

- The teacher's new words are appended to the open case
- `urgent_requested_at` is stamped on **that** case
- The regional admin is notified, referencing it
- On confirm: importance → `Urgent`, owner notified, state updated
- **If already `Urgent`:** append, tell the teacher it is already escalated, do
  not re-notify

This preserves the existing reasoning — *"what the code buys is attention on the
teacher's problem, and the existing case gets it."* Splitting would fragment one
problem across two references and give staff two things to work.

## Why importance, not status

`caseImportanceEnum` is already separate from `status`, and **retention keys off
importance**. A pending request sits at `Normal` and only becomes `Urgent` on
confirmation — correct, since an unconfirmed request must not earn six-month
retention. No enum changes; `CASE_STATUS_ORDER` and `OPEN_CASE_STATUSES`
untouched.

```
cases + urgent_requested_at, urgent_confirmed_by, urgent_confirmed_at
```

## What the teacher sees while pending

The acknowledgement must:

- Confirm receipt and give the case reference
- Say a regional coordinator will review it
- ~~**Name a real-world emergency contact** for anything life-threatening~~

> **REVERSED.** Open question 2 is answered **in the negative**. In the head of
> project's words: *"urgent case doesn't mean emergency, urgent case means highly
> prioritized."* The bot is not a crisis line and must not present itself as one,
> so it names no emergency service. The existing `SUPPORT_CONTACT` still appears
> on every message on this path, as the route that works when the bot is the
> problem.
>
> This correction reached further than one message. The whole feature had been
> built in a crisis-line voice - "describe the emergency", a siren on the menu
> button - and all of it was rewritten.

## ~~Codes stay, for the phone route~~ - **REVERSED**

> **The head of project chose to drop the code route entirely.** This section is
> void. `AwaitingUrgentCode`, `/generate_urgent_code`, the code generator, the
> alphabet, the 48-hour expiry, the five-guess cap and the stranded-code alarm
> are all removed. `/generate_urgent_code` did not gain a button; it became
> **`/urgent_pending`**, which lists requests nobody has decided.
>
> The `urgent_codes` and `urgent_code_attempts` tables are **still in the
> database**, declared in `schema.ts`, read and written by nothing. Dropping a
> table is the one migration this project cannot walk back, and the rows record
> who issued what to whom. **A decision is outstanding on whether to drop
> them.**

## Ripple map

| File | Layer | Change |
|---|---|---|
| `src/db/schema.ts` + `drizzle/` | 2 | 3 nullable columns |
| `src/cases/urgent.ts` | 2 | Request path; confirmation sets importance |
| `src/cases/service.ts` | 2 | Dedup interaction with a pending request |
| `src/cases/notify.ts` | 2 | Regional admin on request; owner + Program on confirm |
| `src/telegram/router.ts` | 3 | Describe-first flow, no code gate |
| `src/telegram/keyboards.ts` | 3 | Confirm-urgent, generate-code buttons |
| `src/telegram/callback-data.ts` | 1 | 2 prefixes |
| `src/telegram/commands/ops.ts` | 3 | Button wrapper for code generation |
| `src/staff/roles.ts` | 2 | Confirmation reuses `urgent.issue` (Support) |

## Accepted risks, recorded

- **A pending request waits on one regional admin.** Accepted on the stated
  basis that one is always present. **No auto-escalation** — it would push every
  frivolous request to Program anyway, defeating the gate
- **Anyone can request urgency.** That is the point: rationing moves from
  "before the teacher may speak" to "before priority is granted"

## Cost

Request path + columns 0.5 · notification routing 1 · confirm and generate
buttons 0.5 · dedup handling 0.5 · tests 1.

---

# PART 4 — Shared work

A and B are **not independent**. Both resolve a regional recipient and both add
notification routing. Build the shared lookup once, in `src/staff/`, and have
both use it. **Whichever feature is built first should carry that cost** — it is
roughly half a day either way, not additional.

---

# PART 5 — Raised, not designed

## C. Interactive `/staff_add` (~1.5 days)

Type `/staff_add <chatID>`, then choose rank from a menu, then region.

**The real cost is not the menus.** Conversation states are currently a
*teacher-facing* machine — `AwaitingIdentifier`, `AwaitingCaseDetail` and so on.
There is no staff-facing multi-step flow anywhere. This needs that machine
extended to staff, or a parallel one.

Safe to build: today's refusal to guess rank or queue exists because defaulting
"would give somebody more than you asked for, and nothing in what you typed
would show it." A menu defaults nothing — it just makes choosing a tap.

## D. Region-based case routing — **already built, recommend no work**

`visibleToStaff()` already filters by queue **and** region. System bypasses both
axes; an empty regions list means every region; a teacher with **no** region is
visible to everybody so nobody falls through. `/cases` for a Samarkand-scoped
member already shows only Samarkand cases.

The gap is **ownership**, not visibility: `/assign` is manual and Lead-only,
which is why `/mycases` is empty — it lists cases *assigned to you*, while
`/cases` lists cases *you can see*.

**Recommendation: do not build auto-assignment.** It raises "who owns it when
two staff cover one region" and "does it override a manual `/assign`" for
unclear gain, when `/cases` already delivers the routing described. ~2 days if
overruled.

## E. Menu restructure (~2–3 days, needs its own spec)

Life-area categories on the first screen, each opening to FAQ / report a problem
/ submit documents, with staff-facing actions gated behind sign-in.

**The trap:** three axes are deliberately separate — FAQ topics (11), case
categories (6, welded to staff queues by typed total maps), and case topic
choices (5). Merging FAQ and case categories is described in the code as the
original design flaw of the Apps Script version.

**The safe version changes navigation only:** one mapping table holds *area →
FAQ topics* and *area → case category*. FAQ sheet, staff queues and reference
prefixes all unchanged.

## F. The login-gating hole - **~0.5 day, and it is a live defect**

**Added 1 August 2026.** Not in the original document, and not a preference.

> ### ✅ BUILT — 1 August 2026, commit `c0d0b74`
>
> Designed first (`docs/plans/2026-08-01-login-gating-design.md`), built second, roughly to the
> half-day estimate. Two binding decisions of the head of project shaped it: an unsigned chat sees
> **only** the buttons that work without an account, and the menu says in words what signing in
> unlocks.
>
> **`RUNBOOK.md` §5.2 and `BOT-SPEC.md` §5 and §8.2 are rewritten to match.** What follows here is
> the statement of the problem, which stands, and one claim that did not — struck through below.

**What happens today:** a brand-new chat types `/start` and receives the privacy
notice followed by *"reply with the email address you were recruited with."* No
menu, no buttons. They are held in `AwaitingIdentifier`, and anything else they
type is read as a failed email attempt.

**Why that is a defect and not a design.** The FAQ is deliberately open to
everybody - the code says so in four places, and the reason is that somebody who
*cannot* sign in and needs an answer is exactly who needs it most. But no new
teacher can reach it, because the front door hands them a sign-in prompt with no
way past. A door that is open and unreachable is closed.

**What to build:** `/start` from a chat that has not signed in shows **the main
menu**, with a sign-in control on it. FAQ and "Who covers my region?" work
immediately. The three gated actions - Contact Support, Ask for Priority, Check
My Case - and Submit Documents stay exactly as gated as they are now.

**Almost all of this already exists.** `requireSignIn` shows the notice, asks for
the address, and - this is the part worth knowing - records what the teacher was
trying to do and **puts them back on it afterwards**. That is built and tested.
~~The only change is what `/start` returns for an unsigned chat.~~

> **WRONG, and found while designing on 1 August.** The 🏠 Main Menu button
> renders the menu through `MENU_ACTION.MAIN`, not through `/start`. Change only
> `/start` and a new teacher sees the reduced menu once and the full menu from
> their first Home tap onwards.
>
> **Nine places render the main menu** — the design document said seven, and
> building it found the other two, both in `handlers/faq.ts`: a stale topic
> button and a withdrawn answer. §4 and §9 of that document carry the list and
> what made the gap visible.

> ### The trap, and it has been fallen into once already
>
> **A revoked chat must never be offered the sign-in prompt.** `bindTeacher`
> clears `revoked_at`, so a revoked teacher who reaches sign-in undoes their own
> revocation by typing an email address, silently. That exact hole existed on
> `/start` and was closed at `a37fef8`; `startReply`, `requireSignIn` and
> `verifyIdentifier` each refuse a revoked chat today.
>
> **Adding a sign-in button to the menu adds a fourth door.** It has to refuse a
> revoked chat too, and the test for it must assert the refusal rather than the
> button's absence - a button a revoked teacher never sees is still reachable
> from their scrollback.

**Also unchanged:** the privacy notice is still shown at the moment of sign-in,
and replying with an address is still the acknowledgement. Moving the notice off
the first screen must not move it off the *acceptance*.

## G. Buttons on case lists - **~1.5 days**

**Added 1 August 2026**, at the head of project's request, and the reason is
worth stating: every list command prints plain text and no buttons, so reading a
case means retyping a nineteen-character reference by hand out of a list.

**This is newly possible.** Until Feature B there had never been a staff-facing
button anywhere in this system - every inline button was a teacher's. The
confirm-urgent button built the machinery: a callback prefix, a staff
authorization path in `routeCallback`, and a scope check through `findCase`.
**Copy that function, do not invent a second pattern.**

### The list row the head of project asked for

~~```
VISA-2026-00311
Nodira Karimova - Tashkent - submitted 12 Jul 2026
Under review - promised by 20 Jul
```~~

> ### ✅ SETTLED, 1 August 2026. The row is this:
>
> ```
> VISA-2026-00311
> Tashkent - submitted 12 Jul 2026
> Under review - promised by 20 Jul
> ```
>
> **Case reference, region, submitted date. No teacher name, and no age.**

Then one button per case, opening it in full.

Two questions were raised, put to the head of project on 1 August, and **both are
now answered**:

- ~~**The teacher's name now appears in lists**~~ — **No.** It stays where it is
  today, in `/case`, and a staff member who needs to know who a case belongs to
  opens it. The draft row above had the name on it and the head of project's
  answer left it off; asked directly, they confirmed that was deliberate.

  The reasoning against was the one that decided it: the row still tells a staff
  member everything they need in order to choose what to open next, and putting
  the name on it would park every teacher's name permanently in the chat history
  of everybody who runs `/cases`. **Recognising a case without opening it is not
  worth that**, and the bot treats personal data this way everywhere else.

- ~~**The date replaces the age**~~ — **The date.** "submitted 12 Jul 2026", not
  "12 days". Not both. The row is already three lines and a fourth number on it
  earns less than it costs in width.

  Worth knowing when building: **the age is what makes somebody act**, and it is
  being given up deliberately. If staff later report that old cases stop standing
  out, that is this decision showing, and the fix is a marker on the row rather
  than reopening the question.

### What gets a button, and what cannot

**One tap, no typing - build these:** open a case, take it (assign to self),
mark urgent, close, reopen.

**Needs typing - leave as commands:** `/reply`, `/note`, `/due`, `/snooze`.

The split is not arbitrary. Anything carrying free text needs the bot to remember
*"this staff member is now writing a reply to case X"*, and **conversation state
is a teacher-facing machine today** - there is no staff-facing multi-step flow
anywhere in the codebase. That is the same missing piece Feature C needs, and it
should be built once, deliberately, and not smuggled in behind a button.

### Constraints

- **Cap the buttons at eight**, below `STAFF_CASE_LIST_CAP` of 20. Twenty rows of
  buttons is a wall, and the text list is still there to scan.
- **Every tap re-validates**, exactly as confirm-urgent does: active staff row,
  the capability the *action* needs, and the case resolved through `findCase` so
  the scope applies. A button sits in a chat for ever and the person tapping it
  may have been demoted since.
- **`callback-data.ts` has a byte budget.** A reference is ~19 bytes and the
  limit is 64. There is a test measuring the longest reference this bot can
  build; extend it rather than trusting arithmetic.
- **Taking a case is `case.assign`, which floors at Lead.** A "take it" button
  shown to Support and refused on tap is worse than no button. Either show it
  only to those who hold it, or lower the floor deliberately and record why.

---

# PART 6 - Out of scope, with reasons

- **One-time enrolment tokens for first sign-in.** Still the only thing closing
  the onboarding land-grab: an attacker binding a leaked roster email *before*
  the real teacher signs in wins silently, and **Feature A does not change
  that** — it protects teachers already signed in. A decision for MoPSE
- **Session timeouts / re-login on `/start`** — taxes every teacher, defends
  against nothing; the attacker retypes the same email
- **Locking both accounts on a duplicate** — hands anyone with a leaked email a
  button that disables a teacher on demand, repeatedly
- **Auto-escalating unconfirmed urgent cases to Program** — defeats the gate
- **Hard-deleting a losing chat's cases** — see Part 2

---

# PART 7 — What proves it works

**Feature A**
- Two chats sign in with one email → both get a message, each with its own button
- Each button escalates to the manager for the **roster** region
- A dispute in a region no staff cover goes straight to System
- Resolution revokes the loser, closes their cases, writes an audit row
- `/restore` puts back a wrongly-revoked chat
- A button tapped after resolution reports the dispute is closed
- A third chat joins the existing dispute rather than opening a second

**Feature B**
- Urgent request with no open case → new case, `Normal`, admin notified
- Urgent request **with** an open case → appended, no second reference
- Confirm → `Urgent`, owner notified, Program notified
- Confirm on an already-`Urgent` case → no duplicate notification
- Code route still works end to end
- The teacher's acknowledgement names an emergency contact

**Both:** `npm run deps` still reports zero cycles and zero layer violations.

---

# Open questions

**All of these are waiting on the head of project. None of them blocks starting
work.** Ordered by how much they cost to leave.

0. **The privacy notice, reviewed before the deploy — the sharpest item on this
   list.** Reviewing it before launch costs **one** round of re-consent.
   Reviewing it afterwards costs **two**, because every teacher who accepted the
   old wording has to be asked again. Nothing technical is waiting on it and that
   is exactly why it keeps slipping.

   Feature B added the ⏫ Ask for Priority path and Part 5F changed what a chat
   sees before it accepts anything, so the notice has moved further from the text
   it describes than it was in July.

   Moved here on 1 August 2026 from the rolling handoff, which was retired that
   day. It was the handoff's §9.1 and it must not be lost with it.

1. **Wording of seven messages** — two dispute notices, manager escalation,
   System forward, urgent acknowledgement, confirmation, owner notification.
   Needs MoPSE review.
   **Update 1 August:** Feature B's five teacher messages and four staff messages
   are written and were shown to the head of project, who approved them
   "generally". They are still drafts as far as MoPSE is concerned. Feature A's
   are unwritten.
2. **Dispute retention** — not covered by the three periods teachers are told
   about. Check whether the privacy notice needs a line
3. **Whether to drop `urgent_codes` and `urgent_code_attempts`** — added
   1 August. Nothing reads or writes them. Left in place because dropping a table
   cannot be walked back
4. ~~**Whether staff lists may show teacher names**~~ — ✅ **answered 1 August:
   no.** Nor the age; the row carries the reference, the region and the submitted
   date. See Part 5G, where both answers and their reasoning are recorded
5. **Whether the Contact Support button under FAQ answers should be hidden from
   chats that have not signed in**, as the main menu's four gated buttons now are
   after Part 5F.

   **This one was decided by the builder rather than asked, so it is flagged
   rather than buried.** It was left visible: the menu is a list of what you can
   do, but that button is an escape hatch at the moment somebody has failed to
   find an answer, and it leads somewhere — `requireSignIn` records what they
   wanted and puts them back on it. Removing it would leave a teacher who has
   just failed to find an answer with nowhere to go, which is the same shape of
   defect Part 5F existed to fix.

   §5 of `2026-08-01-login-gating-design.md` has the full reasoning. **Roughly two
   hours to change if the head of project disagrees.** Also moved here on
   1 August from the retired handoff.

6. **Part 5G: whether the "take it" button is shown only to Leads, or the
   `case.assign` floor is lowered.** Taking a case floors at Lead today. A button
   shown to a Support member and refused on tap is worse than no button, so
   either it is drawn only for those who hold the capability, or the floor comes
   down deliberately and the reason is written next to it. **Part 5G cannot be
   finished without this**, though it can be started.

# Order

1. **Operational launch blockers** — hours, and they gate everything. **Still
   untouched as of 1 August.** None of it is code: revoke the test bot token,
   confirm the sheet is no longer publicly editable, move `OPS_ALERT_CHAT_ID` to
   a group, set `BACKUP_PASSPHRASE`/`BACKUP_REMOTE` and run the restore drill,
   confirm Uzbekistan hosting
2. ~~**Feature B**~~ — ✅ **built 1 August at `90827f8`**, and it carried the shared
   regional-recipient lookup as intended
3. ~~**Part 5F, the login-gating hole**~~ — ✅ **built 1 August at `c0d0b74`**, to
   its own design document. The defect is closed: a teacher who has never signed
   in reaches the answer bank from the front door
4. **Part 5G, buttons on case lists** — a day and a half. Directly requested,
   and now cheap because Feature B built the staff-callback machinery
5. **Feature A** — identity disputes
6. **Feature C** — interactive `/staff_add`. Note it needs the staff-facing
   conversation state that Part 5G deliberately avoids
7. **Feature E** — largest, and benefits most from having lived with the bot.
   Needs its own spec first

---

# PART 8 — Which skills to use

**Added 1 August 2026, at the head of project's request.** Nothing needs
downloading — everything named here is already installed on this machine. What
follows is which of them are worth invoking for *this* work, and when.

| Skill | When | Why here specifically |
|---|---|---|
| `superpowers:brainstorming` | Before Part 5F and 5G | Both have unsettled design questions — where the sign-in control lives, whether lists show names. This is the skill that forces those out before code |
| `superpowers:writing-plans` | Before Feature A | A is 3.5 days across nine files and a new table. The Stage 3 and 4 plans are the shape to match |
| `superpowers:test-driven-development` | Throughout | This codebase's whole discipline. **Every fault this project has found was found by running something** — including one this session, where a test caught a fallback branch that could never fire |
| `superpowers:systematic-debugging` | On any failure | Rather than guessing at a fix |
| `superpowers:verification-before-completion` | Before claiming anything is done | §10 of the handoff says the same in the project's own words: state the numbers plainly |
| `superpowers:requesting-code-review` | At each feature boundary, before committing | |
| `claude-mem:mem-search` | When something looks like it has been solved before | This project has seven months of sessions behind it |
| `anthropic-skills:consolidate-memory` | End of session | The memory directory has ten files and some are drifting |

**Two that look relevant and are not.** `frontend-design` — there is no
front end; every interface in this system is a Telegram message.
`claude-mem:learn-codebase` — it reads every source file in full, which for 80
source and 66 test files of unusually dense commentary is an expensive way to
learn less than the handoff already tells you.
