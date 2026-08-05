# A quieter bot

**Status: designed, not built. 5 August 2026.**

Two phases. Phase one changes who the bot talks to and how much it says to staff.
Phase two rewrites what teachers read. One design, because the same complaint
caused both, and the tone rules in §7 have to be the same rules in both halves or
they will drift.

---

## 1. Why

A MoPSE employee using the bot said it felt **overwhelming and threatening**, and
that there was **too much writing**. That is the whole brief. It is worth more
than any metric this project has collected, because it is the only report so far
from somebody who has to use the thing rather than build it.

Read the current staff messages with that sentence in mind and it is easy to see.
This is what the bot says when nobody covers a region:

> ⚠️ You are being asked because NO active staff member covers this region.
> That is a staffing gap, not a routing quirk — somebody needs the region.

Written for an engineer diagnosing a system. Read by a ministry employee, it is an
accusation about a problem she did not cause and cannot fix.

## 2. What is actually happening, measured on the live server

Not inferred. Read from the database on 5 August 2026.

```
telegram_id   name           role      queue          regions      owns
8725712348    (unnamed)      Support   All            {}           2
8856441118    (unnamed)      Support   Accommodation  {Tashkent}   1
6319731501    MoPSE Tester   Program   All            {}           2
5150659708    Husain Nasar   System    All            {}           2
```

Three findings, and the third is the one that matters.

**An empty region list means every region.** Three of the four staff rows are set
to every category, everywhere. The visibility rule works. There is nothing for it
to filter on.

**Region filtering would change nothing today.** All nine cases are Tashkent, and
eight of the nine belong to one test account. Narrowing by region is the right
long-term shape and it is not the lever that quietens anything now. The two levers
that work today are the *type* of case and *who gets told*.

**One setting is doing two jobs.** `queue` decides both what a person may look at
and what they may be handed. `MoPSE Tester` has `All`, so she sees everything,
which is correct, and she is also in the pool that new cases are handed to, which
is why her phone keeps going off. She owns two cases. Separating those two
meanings is the centre of this design.

A fourth finding, corrected in passing: **two cases have no owner, not three.**
`VISA-2026-00002` and `DOCS-2026-00001`, both filed on 1 August, before automatic
assignment was built. Every case filed since 3 August has an owner. The rule "a
case cannot be received without an owner" is already true. Those two are leftovers
and get assigned by hand.

## 3. The decisions

Each one is the head of project's, taken during the design conversation on
5 August 2026. The reasoning is recorded so a later reader can tell a decision
from an accident.

**D1. Only the person a case is given to is told about it.** One case, one
message, one name against it. Everybody else finds it in `/cases`.

**D2. The Program admin and the System member see everything and are told
almost nothing.** Oversight is something she pulls, not something pushed at her.
In the head of project's words, the Program admin is *"the MoPSE employee that
doesn't wanna be bothered with IT stuff"*.

**D3. Both of them leave the automatic rotation, and both keep the ability to own
a case.** They are never handed one. They can still be given one with `/assign`,
which they both already hold, and it appears in `/mycases` and behaves normally.

**D4. Every case has an owner. Always.** Already true since 1 August. The
assignment rule below cannot break it.

**D5. There is always somebody covering every region.** Stated flatly by the head
of project: *"there is always someone covering a region! ALWAYS"*. The data agrees:
while any staff row has an empty region list, every region is covered.
Consequence: **no message a person reads mentions region coverage again.**

**D6. A case with no category goes to Accommodation.** Today an uncategorised case
routes to `All`, meaning everybody sees it. Accommodation is a narrowing, and it
reduces noise rather than adding any.

**D7. A case marked urgent is still announced to Program and System.** This
reverses a proposal to delete that message. One regional admin can raise a case
above every other case in the country, alone and with no second signature.
Somebody has to be able to see it happened. Volume is low.

**D8. There is a button to mark a case not urgent, and the teacher is not told.**
New. §6.

**D9. One full test suite run, at the end of both phases.** The head of project's
call. Recorded with its cost in §9.

## 4. Phase one: who is told, and who owns

### 4.1 The assignment rule

> A new case is offered to **Support and Lead** staff first, whoever has the
> fewest open. Only if there is nobody at those ranks does it fall to Program,
> then to System.

A rank rule rather than a per-person switch, for two reasons. Nobody has to
configure anything, so nobody can forget to. And it makes D4 absolute: the chain
cannot run out while any staff member exists.

**In practice the fallback never fires.** There is a Support member covering every
category in every region, so Support always wins. Program and System stay out of
the rotation permanently, which is D3.

The cost, and it is small: if a second Program admin is hired who *does* work
cases, the rank rule is wrong for them and we would swap it for a per-person
"takes new cases" switch on the staff row. That is a bigger change and there is no
reason to build it now.

`chooseOwner` currently asks `staffWorking` for chat ids. It will need the rank
alongside each id. That is the one structural change in this section.

### 4.2 Who receives what

| Event | Told today | Told after |
|---|---|---|
| New case | everyone whose queue and region covers it, up to 20 | the owner, and nobody else |
| Priority requested | everyone in the region who can grant it | the owner |
| Case marked urgent | the owner, plus every Program and System member | unchanged (D7) |
| Nothing covers this case | a critical alert, and a warning paragraph inside people's messages | a line in the operations chat, silent to everybody else |

### 4.3 The new-case message

Today:

```
🆕 New case — VISA-2026-00003

Category: Visa
Region: Tashkent
Filed: 05 Aug 2026, 08:15 (Tashkent)

/case VISA-2026-00003 — read it, including what the teacher wrote
/assign VISA-2026-00003 <telegram id> — give it an owner
```

After:

```
🆕 New case for you

Visa · Tashkent
Today at 08:15

[ 📂 Open case VISA-2026-00003 ]
```

Three lines and a button. Everything cut is behind the button, which opens the
case exactly as tapping it in `/cases` does today.

**"For you" is deliberate.** Now that only the owner is written to, the message can
say whose it is. **The reference sits on the button** rather than in the body, so
it is there when needed and takes no line.

### 4.4 The priority request

Today it runs to about twelve lines and carries the teacher's name, their roster
identifier, an explanation of what priority means, and sometimes the warning block
quoted in §1. After:

```
⏫ Priority asked for

Nodira Karimova
Visa · Tashkent · today at 08:16

[ 📂 Open case ]   [ ⏫ Make it a priority ]
```

The teacher's name goes on its own line, above the case. A person asked for help.
The category is how we file it.

The identifier moves behind the button. The original argument for putting it in
the message was that checking meant typing a command first, so a coordinator would
approve without looking. Opening is one tap now. That argument has expired.

**A teacher who files a case and asks for priority in the same breath produces one
message, not two.** Both notices now go to the same person, the owner, so without
care this design would put two messages about one case in one chat a second apart.
That is the exact failure it exists to remove. `notifyUrgentRequestOnCase` already
strips the overlap and keeps the priority message, because it carries the decision
and the new-case notice carries strictly less. **Preserve that behaviour.** It was
written when the two audiences merely overlapped. Under D1 they are identical, so
it stops being an optimisation and becomes the thing holding the promise.

## 5. Phase two: what teachers read

Not designed. Deliberately.

The teacher-facing text is about 1,700 lines across nine modules: the menu, sign
in, the FAQ answers, the privacy notice, case confirmations, the chase messages,
and the identity-dispute notices. Designing that pass means reading every message a
teacher can receive with the MoPSE report in hand, and bringing the worst of them
back with rewrites beside them. That is its own conversation.

It is a separate phase because it is a different kind of change. Phase one moves
behaviour and needs a migration. Phase two moves words, and the modules holding
those words are the pure ones, the reply and keyboard modules that have no
database, no network and no clock. It is the lowest-risk change available in this
codebase, and tying it to a migration would be the only way to make it risky.

## 6. The "not urgent" button

It sits on the message that goes to Program and System when a case is marked
urgent:

```
⏫ Marked urgent by Dilnoza R.

VISA-2026-00003
Visa · Tashkent · today at 09:40

[ 📂 Open case ]   [ ↩️ Not urgent ]
```

**Program and System may press it.** Support grants urgency, Program takes it
back. That mirrors `/assign`, where overriding somebody else's decision is already
a Program act.

**The teacher is told nothing.** Asked for directly. The consequence, named rather
than discovered later: the teacher *was* told their case had been prioritised when
it was marked, so after this they still believe it is. Telling a worried teacher
their problem has been downgraded is worse.

### 6.1 The retention trap, and why the button only works on an open case

Marking a case urgent does not only change a label. Retention keys off
`importance`, and a closed case at `Urgent` is kept for
`URGENT_CASE_RETENTION_DAYS` rather than `CASE_RETENTION_DAYS`.

So un-marking a case that is **already closed** could drop it below the retention
line, and the nightly pass would delete it. Not eventually. That night.

The `settings` table on the live server is empty today, so no period is set and
nothing is ever deleted. The trap is dormant and arrives the day somebody sets a
retention period, which is a launch checklist item.

**The fix costs nothing: the button only works while the case is open.** Retention
only ever touches cases with a `closed_at`, so an open case cannot be reached by
it. Anybody wanting to un-mark a closed case reopens it first, which is a tap they
already have.

### 6.2 What un-marking undoes

Confirming urgency does five things in one statement: raises `importance`, sets
`status` to `Escalated`, clears `closed_at`, resets the teacher chase counters, and
records `urgent_confirmed_by` and `urgent_confirmed_at`.

Un-marking undoes three of them. `importance` back to `Normal`. `status` off
`Escalated`, so the case leaves `/urgent`. The confirmation cleared, so a case can
be marked urgent again later if it turns out it really was.

**The status has to go back to something, and `Received` is not good enough.** A
case that was `Under review` before somebody escalated it should return to `Under
review`, not lose its progress. So `confirmUrgentRequest` records the status it
replaced, in one new nullable column, and un-marking restores it. `Received` is the
fallback when the column is null, which covers every case escalated before this
column existed.

**Read the old status through a sub-select in `FROM`.** `RETURNING` yields
post-update values, and this statement writes the very column it needs to read.
That trap has already cost this project one fault, in this exact file.

## 7. Tone rules, and they apply to both phases

Every message rewritten under this design goes through the humanizer pass. Asked
for by the head of project on 5 August 2026.

- **No em dashes.** The humanizer bans them outright, and they are most of what
  makes the current staff messages read like a machine explaining itself to
  another machine.
- **No warning blocks, and nothing in capitals.** A warning belongs in the
  operations chat, where the people who can act on it are.
- **None of these words in anything a person reads**: failure, gap, unworkable,
  refused, invalid, must, cannot. Say what happened and what to do.
- **No instructions to type something** where a button exists.
- **Ordinary sentences.** "Nobody covers Samarkand for visas" rather than "No
  active staff member holds this queue and region at all."
- **Short.** If it does not change what the reader does next, it belongs behind a
  button.

## 8. Ripple map

Layers are `CLAUDE.md` §2. Nothing here imports upward.

| File | Layer | Change |
|---|---|---|
| `src/staff/queues.ts` | 2 | `Contact Support` and `Submit Documents` route to `Accommodation` rather than `All` (D6) |
| `src/staff/recipients.ts` | 2 | `staffWorking` returns the rank beside each id, so the assigner can prefer Support and Lead |
| `src/staff/assignment.ts` | 2 | `chooseOwner` prefers Support and Lead, falls back to Program then System (§4.1) |
| `src/cases/notify.ts` | 2 | New-case notice to the owner alone; priority request to the owner; all three message bodies rewritten; the coverage warning moves to an alert |
| `src/cases/urgent.ts` | 2 | `confirmUrgentRequest` records the replaced status; new `unmarkUrgent`, refusing a closed case |
| `src/db/schema.ts` | 2 | One nullable column on `cases` for the pre-escalation status |
| `drizzle/` | n/a | One additive migration. Read the generated SQL before accepting it |
| `src/telegram/callback-data.ts` | 1 | One new prefix for the not-urgent tap. Do not grow the byte budget; extend the payload-length test |
| `src/telegram/router.ts` | 3 | Route the tap, re-validating rank and case state on arrival |
| `src/telegram/urgent-actions.ts` | 3 | New. Where the not-urgent tap's action lives, beside `dispute-actions.ts` and for its reason: `staff.ts` reaching into `router.ts` closes a cycle, which Part 5H.3 and Feature A both hit |

Run `npm run deps` after adding the file in the last row and commit the
regenerated tree.

## 9. Testing, and what it is being traded for

The interesting tests are integration tests against real PostgreSQL, as ever. The
ones this design needs:

- A case is offered to a Support member while a Program member with `All` sits
  idle beside them.
- The fallback fires when the only Support member is deactivated.
- Exactly one message leaves the bot when a case is filed.
- The not-urgent button is tapped by a Support member and refused, tapped on a
  closed case and refused, and tapped by a Program member and obeyed.
- Un-marking restores `Under review` rather than `Received`.
- A case escalated before the new column exists un-marks to `Received` without
  throwing.

**D9's cost.** One full suite run at the end of both phases, rather than one per
phase, means a regression introduced in phase one can sit undetected while phase
two is written on top of it. Phase two touches words in pure modules, so the odds
are low. The cost when it happens is that the bisect covers two phases instead of
one.

## 10. What this design does not do

- **It does not narrow anybody's regions.** Region filtering changes nothing while
  every case is in Tashkent. It becomes worth doing when teachers exist in several
  regions and staff rows are narrowed to match.
- **It does not add a per-person "takes new cases" switch.** §4.1 says when that
  becomes the right answer.
- **It does not tell the case owner when paperwork arrives.** Still designed and
  unbuilt, from the form-areas work of 3 August. Unrelated to noise, and it needs
  its own decision about how a layer-2 store reaches a person.
- **It does not touch the operations alerts.** The two sheet problems reported on
  4 August are still sheet fixes, not code, and the alert firing every ten minutes
  stops when the `DIPLOMA` tab name is corrected.
