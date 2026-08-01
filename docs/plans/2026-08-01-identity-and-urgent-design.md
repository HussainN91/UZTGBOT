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

## H. Staff management by button, and automatic ownership — **new, 1 August 2026**

**Asked for directly by the head of project.** Their words, in order, because two
of the three parts are decisions and the third rests on a premise that needs
correcting first.

### H.0 — Answers to the three things they asked

**"We don't have regional admins, or do we, idk."** **You do.** Every staff row
carries a `regions` list. Empty means every region. A staff member with
`['Tashkent']` sees Tashkent cases and no others. There is no separate rank for
it — region is an attribute of any staff member at any rank, which is why
`/region` exists as a command.

**"Confirm what the list has."** Two lists, and they are not the same list.

| Queues — what a staff member holds | Case categories — what a teacher files under |
|---|---|
| `Visa` | `Visa` |
| `Travel` | `Travel and Arrival` |
| `Contract` | `Contract Signing` |
| `Accommodation` | `Accommodation` |
| `All` — every queue | `Submit Documents` → routed to `All` |
| `None` — no case queue at all | `Contact Support` → routed to `All` |

**There is no `Medical`.** It was named as an example and it does not exist.
Adding one is three things, not one: a case category, a queue, and the mapping
between them — plus an FAQ topic if teachers are to read about it. `Recruitment`
and `Technical` were deliberately removed during the rebuild for exactly this
reason: a queue with no category that can reach it is a setting that looks
configured and does nothing.

**Ranks**, for completeness: `Observer` · `Support` · `Lead` · `Program` ·
`System`, in that order, each holding everything the one below it holds.

### H.1 — ⚠️ The routing described is already built

> *"if i give them role visa beside their names it means they handle ALL visa
> matters within their regions"*

**That is what the bot does today.** A staff member has a queue and a region
list, and `visibleToStaff` filters every read by both. Give a Lead `Visa` and
`Tashkent` and their `/cases` already shows exactly the Visa cases in Tashkent
and nothing else. `/staff_add` already takes both. Nothing needs building for
this.

**What does not exist is ownership.** `cases.owner` is set only by a manual
`/assign`, which is why `/mycases` is empty: `/cases` lists cases you *can see*
and `/mycases` lists cases *assigned to you*.

So the real question is narrower than it first looks: **is a name against each
case worth having, when the right person already sees it and nobody else does?**

**It probably is**, for two reasons that visibility cannot give: a case with an
owner has somebody accountable for it, and `/mycases` becomes the list a staff
member works from rather than a permanently empty command.

**And it raises the question that stopped this being built in Part 5D: who owns
it when two people hold the same queue and region?**

> ### ✅ ANSWERED 1 August 2026 — **the one with the fewest open cases.**
>
> **✅ BUILT the same day at `cb045b9`**, in `src/staff/assignment.ts`. About half a
> day rather than the day and a half estimated, because the head of project was
> right that most of it already existed: `staffCovering` has answered "who can
> work this case" since Feature B, and it is the inverse of the visibility
> predicate rather than a second copy of it. The only new query is a count.

**Open cases only.** The question is who has capacity now, not who has ever been
busy — counting finished work would push new cases away from whoever has been
clearing theirs, which is exactly backwards.

**Ties are broken by who has waited longest for work**, and then by id. Both
steps are deliberate. Without the first, the lowest id wins every tie and keeps
taking cases until it is no longer tied, which on a two-person queue is a queue
with one person on it. Without the second, the answer would depend on how
PostgreSQL happened to group the rows — and `createCase` can be retried, because
Telegram resends anything it thinks failed, so a picker that answered differently
on two runs would put one case in two people's names depending on which attempt
committed.

**Candidates must hold `case.update`**, which floors at Support — the capability
for *working* a case. Deliberately not `case.assign`, which H.2 raises to
Program: assigning is a senior action, being assigned is what every ordinary
staff member is for. **An Observer may read a case and may never own one.**

### ⚠️ The System bypass, and how it resolved Part 9.1.B

`staffCovering` returns every active System member **unconditionally**. That is
the bypass, it is correct, and it is why a case in a region nobody covers still
reaches somebody. **Reused unchanged for assignment it would have been quietly
wrong**: every case in the country would have been handed to a System
administrator, who is the person of last resort rather than the person who works
the queue.

So `staffWorking` is `staffCovering` minus anybody who is only in the set through
the bypass, and **the answer is allowed to be nobody**.

**That is what saves `/cases unassigned`**, which Part 9.1.B flagged as being
emptied by construction. The list does not die — it gets sharper. It used to mean
*nobody has picked this up*; it now means **no active staff member holds this
queue in this region**, which is a staffing gap somebody has to close. A System
member still sees the case, through the bypass, exactly as before.

### What remains of Part 5H

**H.1 and H.2 are built — `cb045b9` and `f67914d`. H.3 is not**, and it is the
largest remaining piece of this part at roughly two days: `/staff` as a list of
buttons, a menu of actions per person, and a submenu per action. It subsumes
Feature C.

Its design question is settled in H.3 below and should be read before starting:
**carry the subject in the callback payload rather than building staff-facing
conversation state.** The second is the harder thing and is not needed for
menus — it is needed for the free-text staff actions (`/reply`, `/note`, `/due`,
`/snooze`), and that is its own piece of work.

### Two faults, found by running it

**1. `max(created_at)` typed as a `Date` compiles perfectly and throws at run
time** — drizzle installs its own pg type parsers, so a `timestamptz` selected
through raw SQL arrives as a string. It is the first of the three traps written
down in `CLAUDE.md`, and it was walked into while writing the comment warning
about its sibling two fields below. The conversion is now done in PostgreSQL
(`extract(epoch …)::float8`), where there is no second place to forget it.

**2. `urgent.integration.test.ts` never truncated `staff`**, and a row left
behind by `queries.integration.test.ts` leaked into it. Harmless for as long as
nothing on that path read the staff table — and the moment automatic assignment
made staff rows load-bearing inside `createCase`, the leaked row was chosen as
the owner of a case that file believed nobody covered. A test asserting "no
owner" failed against a person it had never heard of.

**Worth generalising: a feature that starts reading a table can break every test
file that does not clean it.** The other integration files truncate `staff`
already; this one predated any need to.

### H.2 — ✅ Decided: nobody "takes" a case except Program and System

> *"staff cannot TAKE OVER a case, no one can do that except system and program
> admin"*

**So there is no "take it" button**, and `case.assign` moves from its current
floor of `Lead` up to `Program`.

> **✅ BUILT 1 August 2026 at `f67914d`**, immediately after H.1 and for the
> reason below.
>
> **Sequencing, and this was the one caution.** Raising the floor on its own
> would have made the present state worse, not better: manual `/assign` was the
> *only* way a case got an owner, so restricting it to two ranks before H.1
> existed would have left almost every case unowned and `/mycases` emptier than
> it already was. The floor moved the moment the system started assigning, and
> not before.

### Two messages had to change with it

Both told a staff member to type a command most of them would now be refused
for — the failure `handleWhoAmI_` was written to avoid, where somebody is offered
a command and then refused by the bot that suggested it.

- **`/case` said `Owner: nobody — /assign to take it`.** It now says *no active
  staff member covers this queue and region*, which is what an empty owner
  actually means once assignment is automatic.
- **The morning digest's third list was headed "Waiting to be taken".** True when
  people took cases; it now reads *Nobody covers these — no owner could be
  found*. Nothing in that list is waiting for its reader to act, and a heading
  implying otherwise asks somebody to fix a staffing gap they did not cause and
  cannot reach.

### One test changed by itself, and was kept for that reason

A test asserted that `/whoami` lists `/assign` for a Lead. It failed on the run
after the one-line floor change, **without `/whoami` being touched** — because
that message is generated from the same table the gates read. It now asserts the
opposite, with the demonstration recorded next to it: a permission cannot move in
one place and stay put in the other. The Apps Script version drifted precisely
because "what am I allowed to do" and "may I do this" were two lists.

### H.3 — Staff management, entirely by button

> *"i do /staff, i see a list of staff listed as buttons, i choose the staff,
> then bot prompts me, what to do with them … add role, revoke, promote or
> whatever … i need it button based PLEASE"*

```
/staff  →  [ Nodira K. — Lead · Visa · Tashkent ]
           [ Bekzod T. — Support · Accommodation · Samarkand ]
           …
    ↓ tap a person
        What would you like to do with Bekzod T.?
           [ 🎖 Change rank ]  [ 📁 Change queue ]
           [ 📍 Change regions ]  [ 🚫 Deactivate ]
    ↓ tap an action
        Which queue should Bekzod T. hold?
           [ Visa ]  [ Travel ]  [ Contract ]
           [ Accommodation ]  [ All ]  [ None ]
```

**This subsumes Feature C** (interactive `/staff_add`), which was the same idea
for one command. Build them together.

**The real cost is not the menus.** Conversation state is a *teacher-facing*
machine today — `AwaitingIdentifier`, `AwaitingCaseDetail`, `AwaitingCaseTopic`.
**There is no staff-facing multi-step flow anywhere in this codebase.** Part 5G
avoided needing one by making every button a single tap that carries everything
it needs in its payload. A three-level menu cannot: "which staff member are we
talking about" has to survive between taps.

Two ways to do it, and the choice should be deliberate:

1. **Carry the subject in the payload** — `SM:<chatId>:RANK:Lead`. No state at
   all, every tap self-contained, and it inherits Part 5G's whole safety
   argument. Constrained by the 64-byte ceiling, which a chat id plus an action
   plus a value fits inside comfortably.
2. **Extend conversation state to staff.** More general, and needed eventually
   for `/reply` and `/note` by button — the free-text actions Part 5G left as
   commands precisely because they need it.

**Recommendation: (1) for this, and (2) as its own separate piece of work when
free-text staff actions are wanted.** Doing (2) here would mean building the
harder thing to solve the easier problem, and the payload approach is strictly
safer — there is no state to go stale between taps.

### Non-negotiables for whichever is built

- **Every tap re-validates**, exactly as `confirmUrgent` and the case-list
  buttons do. `staff.manage` floors at `System`, and a button sits in a
  scrollback for ever.
- **A staff member must not be able to change their own rank**, and the existing
  `/staff_add` rules on this must be read before the buttons are written.
- **Buttons are capped**, as the case lists are. A ministry with forty staff must
  not produce a forty-button wall.
- **Every change writes an audit row in the same transaction as the change.**

### Cost

H.1 automatic ownership 1.5 days, once the two-people-one-queue question is
answered · H.2 folded into H.1 · H.3 staff management by button 2 days,
including the `/staff` list, three submenus and revalidation on every tap.
**Roughly 3.5 days together.**

---

## D. Region-based case routing — ~~**already built, recommend no work**~~

> **Superseded 1 August 2026 by Part 5H.** The recommendation below — that
> `/cases` already delivers the routing, and auto-assignment is not worth its
> questions — was accepted at the time and has now been overruled by the head of
> project, who asked for cases to be assigned automatically by type and region.
> **The reasoning below is still the accurate description of what exists**, and
> H.1 turns on it. What changed is the decision, not the facts.

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

6. ~~**Part 5G: whether the "take it" button is shown only to Leads, or the
   `case.assign` floor is lowered**~~ — ✅ **answered 1 August: neither.** Nobody
   takes a case. Assignment is restricted to Program and System, and the system
   assigns automatically. See Part 5H.2.
7. ~~**Part 5H.1: who owns a case when two staff hold the same queue and
   region?**~~ — ✅ **answered 1 August: the one with the fewest open cases**, and
   built the same day. See Part 5H.1.

# PART 9 — Execution order, and what breaks if it is ignored

**Written 1 August 2026, at the head of project's request**, after Part 5H was
added: *"we don't want the concepts we are trying to code to overlap,
contradict, or ruin anything, in code or in the following steps of the plan that
aren't coded yet."*

**The order below changed as a result.** Part 5H moves ahead of Feature A, and
the reason is in §9.2.

## 9.1 — The five places two unbuilt parts touch the same thing

### ⚠️ A. "Who is responsible for this region?" is asked by both 5H and Feature A

`src/staff/recipients.ts` holds the one answer today — `staffCovering` and
`regionalRecipients`, built with Feature B. **Two unbuilt parts each need a
version of that question and they are not the same question:**

- **5H.1** asks *"who should own a `Visa` case in Tashkent?"* — one person, out
  of everyone holding that queue and region.
- **Feature A** asks *"who adjudicates a dispute about a teacher in Tashkent?"* —
  a person with authority, regardless of queue.

**Built in the wrong order they will disagree.** If Feature A goes first it must
invent its own notion of a regional authority; when 5H then introduces a named
owner per queue-and-region, the bot holds two answers to "who is responsible
here" and nothing makes them agree. **5H first**, and Feature A then escalates to
the person 5H already established, or to System where 5H established nobody.

### ⚠️ B. Automatic ownership changes what `/cases unassigned` means

`/cases unassigned` is the intake backlog, and its whole reason is R4: a case
filed into a queue nobody holds, sitting unseen. **Once 5H assigns
automatically, that list is empty by construction** — and an empty list will read
as "nothing is waiting" when the real failure has simply changed shape, from
*nobody owns it* to *its owner is inactive, on leave, or holds forty others*.

**5H must replace the question, not delete the command.** The digest's third
section — `📥 Waiting to be taken` — has the same problem and must move with it.
Leaving either as-is is the "looks configured and does nothing" failure the
rebuild exists to remove.

### ⚠️ C. Feature E rewrites the menu that Part 5F just made access-aware

Part 5F built three menus — signed in, sign-in offered, access ended — and
hiding the gated buttons from a stranger is now a property of
`mainMenuKeyboard(access)`. **Feature E replaces the first screen entirely.**

Built without that in view, Feature E reopens the login-gating hole it will not
know exists. **Its spec must start from `mainMenuKeyboard(access)` and keep all
three forms**, and its own success criteria must include a chat that has never
signed in reaching the answer bank.

### ⚠️ D. Adding a case category ripples further than it looks

Raised by the `Medical` example in 5H.0. A category is not one setting:
`CASE_CATEGORY`, `QUEUE_FOR_CATEGORY` (typed total, so it is a compile error to
miss), `CASE_REFERENCE_PREFIX`, retention, the FAQ topic list if teachers are to
read about it, and — once Feature E exists — its area-to-category mapping.

**So: add any new category before Feature E, never after.** Afterwards it is the
same work plus a mapping table built against a list that has since moved.

### ⚠️ E. Feature A creates personal data teachers have not been told about

A dispute record holds an identifier and two chat ids, and **dispute retention is
not covered by the three periods the privacy notice states** — that is open
question 2, and it has been open since July.

**This is the sharpest sequencing item in the whole plan.** Reviewing the notice
before launch costs one round of re-consent. Building Feature A first and
reviewing afterwards costs two, because every teacher who accepted the old
wording is asked again. **Settle the notice before Feature A starts**, not before
it ships.

## 9.2 — What the order therefore is

1. **Operational launch blockers.** Unchanged, untouched, and they gate
   everything — 5H and Feature A both add function to a bot that cannot yet
   safely launch.
2. **Part 5H**, staff management by button and automatic ownership. **Moved
   ahead of Feature A** by §9.1.A. It is also the only remaining part that is
   entirely staff-facing: no teacher sees anything different, so it carries no
   privacy or re-consent ripple at all, which makes it the safest thing to build
   while the notice is still being settled.
3. **The privacy notice**, settled — in parallel, by the head of project, not by
   engineering. It gates step 4.
4. **Feature A**, identity disputes.
5. **Feature E**, which needs its own spec, and that spec must start from
   §9.1.C.

## 9.3 — What is safe to do at any time

Adding buttons to existing commands, on Part 5G's pattern: a single tap carrying
everything it needs in its payload, re-validated on arrival. It touches no
concept any later part depends on. **The exception is anything needing free
text** — `/reply`, `/note`, `/due`, `/snooze` — which needs staff-facing
conversation state and belongs with 5H.3, not before it.

---

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
4. **Part 5G, buttons on case lists** — ✅ **the open-case button is built at
   `cfb3e55`**, with the row in the agreed shape. The four *action* buttons the
   plan proposed are **not** built and mostly will not be: "take it" was ruled
   out by the head of project (Part 5H.2), and close, reopen and mark-urgent are
   worth revisiting only alongside 5H's menus rather than as a separate pass
5. **Part 5H — staff management by button, and automatic ownership.** Moved ahead
   of Feature A on 1 August by Part 9.1.A. **H.1 ✅ built at `cb045b9`, H.2 ✅
   built at `f67914d`.** What remains is **H.3 — staff management by button**,
   ~2 days and the largest remaining piece. Subsumes Feature C. **Nothing blocks
   it**; its one design question is answered in Part 5H.3
6. **The privacy notice, settled** — the head of project's, not engineering's,
   and it gates Feature A. Part 9.1.E. Runs in parallel with step 5; it needs no
   engineering time at all
7. **Feature A** — identity disputes. Uses whatever step 5 established as "who
   is responsible for this region", and must not invent a second answer
8. ~~**Feature C** — interactive `/staff_add`~~ — **subsumed by Part 5H.3**,
   which is the same idea for every staff command rather than one command. It is
   not a separate step
9. **Feature E** — largest, and benefits most from having lived with the bot.
   **Needs its own spec, and that spec starts from Part 9.1.C** — it replaces the
   first screen, which Part 5F just made access-aware, and it must keep all three
   forms of the menu or it silently reopens the login-gating hole

> **Buttons wherever they fit, from here on.** Asked for on 1 August: *"add
> buttons whenever you can."* Part 5G is the template — a single tap carrying
> everything it needs in its payload, re-validated on arrival. The one thing a
> button cannot yet do is take free text (`/reply`, `/note`, `/due`, `/snooze`),
> because that needs staff-facing conversation state, which does not exist. See
> Part 5H.3.

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
