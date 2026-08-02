# Fixing what the 2 August audit found

**Date:** 2 August 2026 · ~~**Status: a plan, nothing is built.**~~
**Status: built, 2 August 2026.** Every stage below shipped, in the order given,
across eleven commits. Stage 0's baseline was 1,248 tests passing; the finished
tree is **1,275 tests across 67 files, 0 failed, 0 skipped**, with typecheck,
build, lint and `deps:check` all clean.

**Four things went differently from this plan**, and each is recorded against its
stage below:

1. **The Trap 2 decision was taken as recommended** — the markers were stripped.
2. **The audit's claim that no test asserts on an asterisk was wrong.** Two did,
   both in `/announce`, asserting `*2* teachers` directly. They were right to
   fail and were corrected. See Stage 2a.
3. **Stage 2c was three messages, not two.** The third was in the usage text
   `/cases` prints when somebody types a status that does not exist.
4. **Stage 5 could not correct the region question in `BOT-SPEC.md`**, because
   the region question is not documented there at all. That gap is left standing
   rather than filled in passing — see the note at Part 7.

This is the fix plan for the sixteen findings of the full-source audit of 2 August
2026. It exists to answer one question the head of project asked directly: **in
what order should these be built so that nothing has to be built twice?**

Two of the findings were proved by running them against a real PostgreSQL rather
than by reading. Those two are marked **PROVEN** below and their evidence is
quoted.

> **Read `CLAUDE.md` first** — the layer rule, the ripple procedure, and the five
> checks that have to pass before anything is called done. It loads
> automatically.

---

# PART 0 — The five sequencing traps

**This part is the plan.** Everything after it is detail. If only one section of
this document is read, it should be this one, because every item below is a place
where building in the wrong order means building it twice.

### ⚠️ Trap 1 — The privacy notice may be touched exactly ONCE

Three separate findings all want to change the privacy notice: the asterisks that
teachers see as literal punctuation (finding 3), the sentence that claims the bot
holds a Telegram name it has never held (finding 4), and — if it is ever built —
capturing Telegram display names (open question 8 of the programme plan).

**Any change to that text bumps `PRIVACY_NOTICE_VERSION`, and every bump asks
every signed-in teacher to read and accept the notice again.** Two commits to that
file is two rounds of re-consent.

So: **one commit, one bump, both corrections together.** That is Stage 2 below,
and it is the reason Stage 2 is a single indivisible unit rather than two tidy
ones.

**And it has to happen now rather than after launch.** There is one signed-in
teacher today. After launch there are 1,800. The same change costs one
acknowledgement now and 1,800 later, and the notice is wrong either way until it
is done.

### ⚠️ Trap 2 — The direction of the asterisk fix decides whether it is two hours or two days

There are two ways to fix finding 3, and they are not the same size of job.

**Strip the markers.** Delete about thirty `*` characters across ten files. No
logic changes, no new function, nothing to test beyond "the notice contains no
asterisk". Two hours.

**Turn Telegram's formatting on instead.** Then every message that has somebody's
free text dropped into it has to have that text escaped first — a teacher's own
words in `/case`, staff notes, the public update a teacher reads, a staff
member's name, a region name typed into the spreadsheet, a published Telegram
handle, and the whole body of every announcement. **One unescaped character makes
Telegram refuse the entire message**, so the failure is not a stray asterisk — it
is a teacher receiving nothing at all. That needs an escaping function, a rule
about which messages use it, and a test per call site. Two days, and it adds a
rule that has to be remembered at every future call site — which is the exact
shape of failure `CLAUDE.md` forbids.

**Recommendation: strip the markers.** It is one rule with no exceptions and
nothing to forget.

**This must be decided before Stage 2 starts.** Deciding afterwards means Stage 2
is written twice.

### ⚠️ Trap 3 — The urgent-confirm defect and `/urgent_pending` are one problem

Finding 2 is that confirming priority on a closed case reopens it while leaving
its end date on, so the nightly clean-up deletes it.

Auditing the fix turned up its sibling: **`/urgent_pending` lists a request on a
closed case for ever.** That query asks only "was priority requested, and has
nobody decided" — it never looks at whether the case is still open. A case closed
with an undecided request sits at the top of the supervision list permanently,
and nothing clears it.

Fix the confirm button on its own and you either leave that row stranded, or you
come back and touch the same feature a second time. **Both go in one commit.**

### ⚠️ Trap 4 — Do not "harden" the deletion job. Fix the writer.

The tempting fix for finding 2 is to make the nightly deletion pass also check the
status, so it cannot delete an open case whatever its end date says.

**That would be wrong, and it would contradict a decision this project has already
argued out.** `retention/purge.ts` says in its own header that it reads
`closed_at` and `importance` and **never** `status` — because a `Critical` case
that gets resolved becomes `Completed`, and nothing about `Completed` remembers it
was ever an emergency. A job reading status would delete exactly the cases most
worth keeping.

The invariant that broke is *"a case carries an end date if and only if it has
ended"*, and it broke because a second function learned to write the status
without learning to keep the invariant. **Fix that function. Leave the deletion
pass alone**, and add a test that asserts the invariant directly, so the next
writer is caught rather than the next reader.

### ⚠️ Trap 5 — Three stages add an import edge, and the dependency document must move with them

`npm run deps` regenerates `docs/dependency-tree.md`, and the document is
committed with the code. Three changes below introduce an import that does not
exist today:

| Stage | New edge | Layer |
|---|---|---|
| 3c | `announcements/store.ts` → `config/constants.ts` | 2 → leaf, downward, legal |
| 4a | `sync/form-responses.ts` → `conversation/lock.ts` | 2 → 2, sideways, legal |
| 4b | none — the change is inside files that already import each other | |

**No new source file is created anywhere in this plan**, deliberately, so no
module moves between layers and no cycle can appear. `npm run deps:check` is a
gate on every stage regardless; `npm run deps` and a committed tree document are
only needed on 3c and 4a.

### ✅ And one thing that is NOT a trap, which is worth knowing before starting

**No stage in this plan needs a database migration.** Every column these fixes
touch already exists. That means:

- the deploy is pull, build, restart — **no migrate step**, unlike 2 August's;
- a code rollback works against the live database with no schema question at all;
- the stages can ship in any order without a deploy-ordering constraint between
  them. The ordering below is about *rework*, not about deployment safety.

---

# PART 1 — What the audit found, and where each finding goes

| # | Finding | Stage | Severity |
|---|---|---|---|
| 1 | Region question shows the wrong teacher's region, asks everybody **(PROVEN)** | 1a | live defect |
| 2 | Closed case confirmed urgent is reopened, then deleted **(PROVEN)** | 1b | destroys data |
| 2b | `/urgent_pending` lists closed cases for ever | 1b | ripple of 2 |
| 3 | No message ever sends with formatting on; asterisks are shown literally | 2 | teacher-visible |
| 4 | Notice claims a Telegram name the bot has never held | 2 | legal statement |
| 5 | Settling a dispute closes at most 20 of the losing account's cases | 3a | silent partial |
| 6 | A message that fails to process is dropped, and nobody is told | 3b | silent loss |
| 7 | `/cases unassigned` and `/mycases` still describe pre-5H behaviour | 2c | wording |
| 8 | An announcement never finishes if one recipient keeps failing | 3c | stuck for ever |
| 9 | `createCase` runs without the chat lock in the form sync | 4a | invariant |
| 10 | Priority prompt has no retry limit; the counter is never incremented | 4b | small |
| 11 | Dispute System fan-out is the only uncapped one | 4c | small |
| 12 | `updateCase` does not normalise its reference; every sibling does | 4c | small |
| 13 | `npm run lint` exits 0 on warnings, so it cannot fail a gate | 4d | tooling |
| 14 | `/urgent` asks for the overdue threshold twice; digest re-reads disputes per member | 4e | cost |
| 15 | `regionManagerFor` selects a column it never uses | 4e | dead |
| 16 | `scripts/sync-sheets.ts` still never syncs FORMS | 4f | known, logged |

---

# PART 2 — Stage 0: a green baseline, before anything is edited

**No code. About five minutes, and it is not optional.**

Two of the fixes change behaviour that existing tests exercise. Without a run
recorded *before* the first edit, a failure afterwards cannot be told apart from a
failure that was already there — and `CLAUDE.md` is explicit that "the test is
wrong" is the wrong first thought.

```bash
docker desktop start && docker compose -f docker-compose.test.yml up -d && docker inspect --format "{{.State.Health.Status}}" mopse-test-postgres-1
```

Then, in PowerShell:

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run
```

**Record the numbers.** A run reporting hundreds of skips proves nothing; a real
run reports **0 skipped**.

Already done as part of the audit and worth not repeating: `npm run typecheck`
passes with 0 errors, `npm run lint` reports 0 problems and was made to fail on
purpose first, and `npm run deps:check` reports no cycles, no unresolved imports,
nothing unused and nothing importing upward.

---

# PART 3 — Stage 1: the two defects that lose data

**Nothing else in this plan touches these files. It can start immediately and in
parallel with the decision Trap 2 needs.**

## 1a — The region question

### What is wrong

`regionCheckDue` asks "is this teacher signed in, and were they last asked more
than 180 days ago?". Because of how the three conditions are combined, PostgreSQL
reads it as "**is this teacher signed in and never asked — or else is *anybody at
all* overdue?**".

The generated SQL, taken from the query builder:

```
where ("teachers"."chat_id" = $1 and "teachers"."verification_state" = $2
       and "teachers"."region_asked_at" IS NULL
       OR "teachers"."region_asked_at" < now() - make_interval(days => $3))
```

`AND` binds tighter than `OR`, so the last line stands alone and matches any row.

### PROVEN

Two teachers: Alice in Samarkand, asked yesterday; Bob in Bukhara, asked a year
ago.

```
regionCheckDue(Alice, asked yesterday)  => "Bukhara"   expected: null
regionCheckDue(999999, no teacher row)  => "Bukhara"   expected: null
```

Alice is asked when she should not be, and is shown **Bob's** region.

### What it looks like in service

The moment any one teacher's last-asked date passes 180 days, every other
signed-in teacher is asked the region question on **every** tap of Main Menu or
`/start`, showing that one stale teacher's region. It stops only when the stale
teacher opens the menu themselves. Nothing is written wrongly — a teacher tapping
"still right" only clears their own flag — but the ministry's bot is asking 1,800
people about a place they do not live, repeatedly.

It has not fired because it needs a second teacher and 180 days. On today's pilot
that is around the end of January 2027; after launch, 180 days after the first
sign-ins, and then all at once.

### The change

Brackets around the two-part condition in `src/teachers/region.ts:155`. Two
characters.

### Ripple map

| File | Layer | Change |
|---|---|---|
| `src/teachers/region.ts` | 2 | the brackets |
| `src/telegram/region-check.integration.test.ts` | — | a third teacher in the fixture, and the failing assertion |

### Ripple of ripples — the files that import this, and why none of them move

`regionFor`, `markRegionAsked`, `confirmRegion`, `flagRegionMismatch`,
`knownRegions` and `listRegionFlags` are untouched, so the eight modules importing
`teachers/region.ts` are unaffected: `cases/notify.ts`, `cases/service.ts`,
`telegram/router.ts`, `telegram/commands/staff.ts` and
`telegram/commands/announce.ts` all call other functions in the file.

**`regionCheckDue` has exactly one caller** — `menuWithRegionCheck` in
`router.ts` — and it is already guarded by `access !== 'signedIn'`.

**The fix can only remove a message, never add one.** That matters because several
integration tests count how many messages an update produces
(`region-check`, `router`, `reconsent`, `manager`). Every one of their fixtures
starts with a teacher who has never been asked, so the wrong branch never fires
for them today and the corrected query returns the same answer. **No test that
counts messages can newly fail.** That was checked, not assumed.

### The test that has to be written

`region-check.integration.test.ts` currently inserts two teachers, one with no
region — which cannot trigger the fault, because the leaked value is `null`. It
needs a **third** teacher with a region and a stale `region_asked_at`, and then
the assertion that the first teacher is not asked at all.

**Write the test first and watch it fail**, or the two brackets prove nothing.

## 1b — Urgent confirmation on a closed case, and its sibling

### What is wrong

An ordinary sequence: a teacher asks for priority; before a coordinator decides, a
staff member closes the case; the coordinator then taps the ⏫ Confirm urgent
button still sitting in their chat, because Telegram keeps buttons for ever.

The case reopens to `Escalated`, becomes `Urgent`, appears in `/urgent`, and the
teacher is told it has been marked urgent — **while still carrying the end date it
was given when it was closed.** The nightly deletion pass reads that date and
deletes it.

### PROVEN

```
confirm outcome : confirmed
after confirm   : { status: 'Escalated', importance: 'Urgent', closed_at: '2026-08-02 10:46:24+00' }
retention deleted: 1  cases remaining: 0
```

### Why it happened, which is the interesting part

`updateCase` carries a long comment explaining that it clears the end date and
resets the teacher's reminder clock whenever the status moves, and that putting
that logic in the individual commands instead "is exactly how a reopened case kept
a stale `closed_at` for three stages".

`confirmUrgentRequest` writes the status with its own hand-written statement,
because it needs a conditional write that `updateCase` cannot express. In gaining
that, it lost the invariant. **The comment was right and the second writer did not
read it.**

### The sibling, found while planning the fix

`pendingUrgentRequests` — behind `/urgent_pending` — selects on
`urgent_requested_at IS NOT NULL AND urgent_confirmed_at IS NULL` and never looks
at the status. **A request on a case that was closed and never decided sits in
that supervision list permanently.** See Trap 3.

### The change

Three parts, one commit.

1. `confirmUrgentRequest` also writes `closed_at = NULL`, `teacher_chased_at =
   NULL` and `teacher_chase_count = 0` — the same three things `updateCase` writes
   on any status move.
2. The coordinator's confirmation says so when it applies: *"this case had been
   closed and is open again"*. A case reopening without the person who closed it
   being able to tell is the kind of quiet change this project does not make.
3. `pendingUrgentRequests` returns the status, and `/urgent_pending` prints it, so
   a request on a finished case is visible and obviously not waiting on a
   decision. **Not filtered out** — silently dropping a teacher's unanswered
   request is worse than showing it with a label.

### The alternative that was considered and rejected

Refusing to confirm a closed case at all. It is defensible — reopening somebody's
deliberate close by a button tap is a real question — but it is a **behaviour**
change rather than a correctness fix, it needs the head of project's decision, and
it strands the pending request in `/urgent_pending` for ever unless that is fixed
too. Recommendation: make the existing behaviour honest now, and raise "should a
closed case be reopenable by this button at all?" separately.

### Ripple map

| File | Layer | Change |
|---|---|---|
| `src/cases/urgent.ts` | 2 | three fields in the confirm statement; status added to the pending query |
| `src/telegram/commands/ops.ts` | 3 | `/urgent_pending` prints the status |
| `src/telegram/router.ts` | 3 | one line added to the coordinator's confirmation |
| `src/cases/urgent.integration.test.ts` | — | the close-then-confirm case |
| `src/telegram/commands/ops.integration.test.ts` | — | the status on the pending row |

### Ripple of ripples

`cases/urgent.ts` is imported by exactly three non-test modules —
`telegram/router.ts`, `telegram/commands/ops.ts`, and its own tests. The
`UrgentConfirmation` type gains no new shape, so `confirmUrgent` in the router
needs no new branch. `PendingUrgentRequest` gains a field, which is additive and
breaks no reader.

**`retention/purge.ts` is deliberately not in this map.** See Trap 4.

**The fixture warning.** `urgent.integration.test.ts` has been bitten once before
by a leaked `staff` row, because automatic assignment made the staff table
load-bearing inside `createCase`. Any new test in that file has to control what is
in `staff`, or the case under test acquires an owner from another file's leftovers.

### The test that outlives the fix

Beyond the close-then-confirm case, add one integration test asserting the
invariant itself: **no case in the database has an end date while its status is
open.** That is what catches the next function that learns to write a status, and
it is cheap — one query.

---

# PART 4 — Stage 2: everything a teacher reads, in one pass

**Blocked on the Trap 2 decision. Do not start until it is made.**

**Stage 2a and 2b are one commit** — see Trap 1. **2c is separate**, because it
touches different files and must not be entangled with a notice version bump.

## 2a — Strip the formatting markers

`send.ts` has supported Telegram formatting since it was written, and **nothing
anywhere has ever turned it on.** So every `*bold*` marker in the bot is delivered
as punctuation.

| File | Layer | What a person sees today |
|---|---|---|
| `src/config/privacy.ts` | leaf | the notice's five section headings, at sign-in |
| `src/digest/format.ts` | 2 | `📣 *A message from the Ministry*` on every broadcast; four digest headings |
| `src/teachers/dispute-notify.ts` | 2 | `**You are not locked out**` and `**revokes every other one**` |
| `src/telegram/handlers/menu.ts` | 3 | `**Please use Contact Support…**`, `👤 *Region*`, `📞 *Getting help*` |
| `src/telegram/router.ts` | 3 | `*Submit Documents*` |
| `src/telegram/commands/staff.ts` | 3 | `**every region**` |
| `src/telegram/commands/ops.ts` | 3 | `🗄 *Retention periods*` |
| `src/telegram/commands/announce.ts` | 3 | `📝 *Draft …*`, `📣 *Recent announcements*`, backticked ids |

### The ripple that turned out not to exist, and the one that follows from it

**No existing test asserts on an asterisk.** Every test that touches this text
matches on the words inside the markers — `toContain('Privacy notice')`,
`toContain('A message from the Ministry')`, `toContain('Past the date you
promised')`, and a `/Draft ([0-9a-f-]{36})/` regular expression that still matches
without them. That was checked across the whole suite, not assumed.

**Which means nothing protects this today, and nothing would protect it
afterwards.** So the pass adds two assertions to files that already exist:
`config/privacy.test.ts` and `digest/format.test.ts` each assert their output
contains no `*`. Those are the two messages where it matters most — the legal
notice, and the one message sent to every teacher at once.

## 2b — The sentence that has never been true

The notice tells every teacher the bot holds *"your Telegram chat id, and your
name as Telegram supplies it"*. **It has never captured a Telegram name.** The
name it holds is copied from the recruitment spreadsheet.

Correct the sentence to say what is actually held. Bump `PRIVACY_NOTICE_VERSION`
to `2026-08-02.1` in the same commit, with a note in the file recording what
changed and why — matching the notes already there for `2026-07-30.1` and
`2026-08-01.1`.

**The cost, stated plainly:** every signed-in teacher is asked to read the notice
again on their next gated action. That is one teacher today. It is the same round
the asterisk fix needs anyway, which is the whole argument of Trap 1.

**One thing to know before deciding.** If open question 8 is later answered "yes,
capture Telegram display names", the sentence becomes true again and the notice
changes a third time. Correcting it now is still right — a legal statement that is
wrong is not something to leave standing while a decision is pending — but the
head of project should know the sequence, because answering question 8 *first*
would save a round.

### Ripple map for 2a + 2b together

| File | Layer | Change |
|---|---|---|
| the eight files listed in 2a | leaf/2/3 | markers removed |
| `src/config/privacy.ts` | leaf | markers, the corrected sentence, the version bump |
| `src/config/privacy.test.ts` | — | no-asterisk assertion |
| `src/digest/format.test.ts` | — | no-asterisk assertion |

### Ripple of ripples

`PRIVACY_NOTICE_VERSION` is read by `teachers/verify.ts`, `telegram/router.ts`,
`telegram/commands/ops.ts` and six test files. **Every one of them reads the
constant rather than the literal string**, so the bump changes no code and breaks
no test. Checked.

`privacyNotice` is called from `handlers/menu.ts` (three ways) and
`commands/ops.ts` (`/retention` shows the paragraph before and after a change).
`retentionParagraph` is shared between the two so they cannot disagree — stripping
markers from one strips them from both, which is correct and is the reason that
function exists.

## 2c — Two messages that describe a world that ended on 1 August

Part 5H changed what an unowned case means: cases now arrive with an owner, and
only Program and System may move one, so nothing is "waiting to be taken". `/case`
and the morning digest were corrected at the time. Two were missed:

- `/cases unassigned`, when empty: *"Nothing is waiting to be picked up."*
- `/mycases`, when empty: *"/cases unassigned shows what nobody has taken."*

Both tell a staff member to go and take work that they may not take.

| File | Layer | Change |
|---|---|---|
| `src/telegram/commands/cases.ts` | 3 | two empty-list messages |

No ripple. Pure text, in a file nothing imports for its strings.

---

# PART 5 — Stage 3: silent loss

## 3a — A dispute settlement closes at most twenty cases

`resolveDispute` fetches the losing account's open cases with `listCases`, which
stops at `STAFF_CASE_LIST_CAP` (20) and reports the true total in a field the
caller ignores. An account with twenty-five open cases has twenty closed and five
left open, belonging to an account the ministry has just judged is not the
teacher's, with nothing anywhere reporting the gap.

**The fix is not to raise the cap.** It is to loop until the list is empty, or to
read the references with a query that has no cap. The second is cleaner but adds a
function to `cases/queries.ts`; the first adds nothing and is bounded by the loop
emptying. **Recommendation: loop**, and have `ResolveOutcome.closedCases` carry
the true total, which `settleAndAnnounce` already prints.

| File | Layer | Change |
|---|---|---|
| `src/teachers/disputes.ts` | 2 | loop until nothing is left open |
| `src/teachers/disputes.integration.test.ts` | — | a losing account with more than 20 open cases |

**Ripple of ripples.** `resolveDispute` has exactly two callers, and both go
through `telegram/dispute-actions.ts` — the typed command and the button share one
implementation deliberately, so there is one place to change and no chance of the
two diverging. `ResolveOutcome` gains no field; `closedCases` simply gets longer.

## 3b — A message that fails is dropped, and nobody is told

The bot marks an update as handled **before** doing the work, and that mark is
saved on its own rather than as part of the work. If the work then fails, the work
is rolled back and the mark stands, so Telegram's redelivery is discarded. The
teacher's message is gone, and the only trace is a line in a log file — `bot.catch`
writes to the log and raises no alarm.

For a project whose founding concern is *"nobody notices when something breaks"*,
and where every other failure raises an alarm somebody receives, this is the gap.

### The change, and where it goes — which is the whole ripple argument

The obvious place is `processUpdate`, but that function is exported so the suite
can drive it with no Telegram at all, and it has no alerter. Passing one in
changes its signature and ripples into every integration test that calls it.

**Put it in `run()` inside `createBot` instead.** That function already holds the
alerter, already has the update id, and is not called by any test. **Signature
unchanged, zero test ripple.** It catches the throw, releases the claim so
Telegram's retry is allowed through, raises the alarm, and returns.

**One residual risk, stated rather than hidden:** if the failure happens during the
commit itself, the commit may or may not have landed, and releasing the claim
could let the retry do the work twice. The 24-hour duplicate window in
`createCase` absorbs the commonest version of that. A lost message is the worse
failure and is the one that happens; this is the trade being made deliberately.

| File | Layer | Change |
|---|---|---|
| `src/telegram/dedup.ts` | 2 | a `releaseUpdate` beside `claimUpdate` |
| `src/telegram/bot.ts` | 3 | try/catch in `run()`; release, alert, return |
| `src/telegram/dedup.integration.test.ts` | — | release then re-claim succeeds |

**Ripple of ripples.** `telegram/dedup.ts` is imported by `bot.ts` and by
`worker/tasks/retention.ts` (for the pruner). Adding an export touches neither.
No import edge is created — `bot.ts` already imports both `dedup` and `alerter`.

## 3c — An announcement that can never finish

A recipient whose send fails in a retryable way — a rate limit, a Telegram outage
— is handed back as Pending. `attempts` is incremented on every claim and **is
never read**. There is no cap. If one recipient keeps failing, the sweeper
re-claims it every minute for ever, the announcement sits at `Sending`
indefinitely, the sender is never told it finished, and nothing raises an alarm.

**The fix is one statement, not a loop counter.** `returnForRetry` already knows
the recipient; make it write `Failed` instead of `Pending` once `attempts` has
reached the cap, as a single conditional update. Then `finishIfDone` fires as it
should and the sender's report counts them under "Failed", which already has
wording for exactly this.

| File | Layer | Change |
|---|---|---|
| `src/config/constants.ts` | leaf | `ANNOUNCEMENT_MAX_ATTEMPTS`, with its reasoning |
| `src/announcements/store.ts` | 2 | `returnForRetry` becomes conditional |
| `src/announcements/store.integration.test.ts` | — | a recipient that exhausts its attempts |

### ⚠️ Ripple: this stage moves the dependency document

`announcements/store.ts` does not import `config/constants.ts` today. Adding the
constant creates that edge. It is downward and legal, but **`npm run deps` must be
run and `docs/dependency-tree.md` committed with the code.** See Trap 5.

**Ripple of ripples.** `announcements/store.ts` is imported by
`telegram/commands/announce.ts` and `worker/tasks/announcements.ts`. Neither calls
`returnForRetry` other than through the sweeper, and its signature does not change.

**Sequencing note.** 3c and 2a both have `worker/tasks/announcements.integration.test.ts`
in their blast radius — 2a through `digest/format.ts`, 3c through `store.ts`.
Keeping them in separate commits means a failure in that file points at one change
rather than two.

---

# PART 6 — Stage 4: the invariants and the small things

These are independent of each other and of everything above. They can be done in
any order, or dropped, without affecting anything else.

## 4a — `createCase` without the chat lock

`cases/service.ts` states in its own header that `createCase` is a read-then-write
and **must** run inside `withChatLock`. The form-response sync calls it inside a
plain transaction with no lock.

It is safe today by accident: the worker runs one job at a time, and a form case
is filed under `Submit Documents` while a teacher's own case is filed under
whatever they chose. It is unsafe on the day either of those stops being true, and
it is the one rule that file says must hold.

| File | Layer | Change |
|---|---|---|
| `src/sync/form-responses.ts` | 2 | wrap the per-response work in `withChatLock` |

**⚠️ New import edge** — `sync/form-responses.ts` → `conversation/lock.ts`,
sideways within layer 2 and legal. `npm run deps` and a committed tree document.

**Ripple of ripples.** `withChatLock` opens its own transaction, and
`form-responses.ts` currently opens one per response — so this replaces a
transaction rather than nesting one. Getting that wrong would be a savepoint
pretending to be a commit, which is the failure `verifyIdentifier` and
`forgetTeacher` both carry notes about. **The existing `db.transaction` call goes;
it does not gain a wrapper.**

## 4b — The priority prompt has no retry limit

`AwaitingUrgentDetail` stores an `attempts` count that is **never incremented**. A
teacher sending photographs instead of text is kept at that prompt for 24 hours,
where the ordinary case prompt gives up after three tries and says so.

| File | Layer | Change |
|---|---|---|
| `src/telegram/router.ts` | 3 | increment and cap, on `retryCaseDetail`'s pattern |

No schema change — the count lives in the state's JSON payload, which is already
typed for it.

## 4c — Two small consistencies

- `notifyDisputeWithSystem` is the only fan-out in the bot not capped at
  `NEW_CASE_NOTIFY_CAP`. One `.slice`. (`teachers/dispute-notify.ts`, layer 2.)
- `updateCase` is the only case-writing function that does not tidy the reference
  it is given; `markImportance`, `setDue`, `setSnooze`, `clearSnooze` and
  `findCase` all do. Harmless today because every caller resolves through
  `findCase` first — but it is the one function whose own comment warns callers to
  be careful. (`cases/service.ts`, layer 2.)

## 4d — The lint gate cannot fail

`npm run lint` exits 0 even when oxlint reports problems. Confirmed by planting
three deliberate errors: they were printed, and the exit code was 0. It is one of
the five checks `CLAUDE.md` requires before anything is called done, and as
configured it cannot stop anything.

Add `--deny-warnings` (or the equivalent) in `package.json`. **Then make it fail on
purpose again**, because a gate nobody has seen fail is a gate nobody should
trust.

**⚠️ Do this last of the four.** It will start failing the whole suite on any
warning the other stages introduce, and a gate that turns red for the first time
in the middle of an unrelated change is a gate people switch off.

## 4e — Cost and dead code

- `/urgent` asks for the overdue threshold, then calls `staleCases`, which asks
  again. One query.
- The morning digest re-reads the whole open-dispute list once per staff member.
  Read it once, above the loop.
- `regionManagerFor` selects an `explicit` column it never reads.

## 4f — `npm run sync` still never syncs FORMS

Already on the defect list from the July test run and still true. The scheduled
worker does sync them, so forms arrive within ten minutes — but the manual
first-load command the deploy guide points at skips them, which is exactly the
moment somebody is watching and concluding the feature does not work.

| File | Layer | Change |
|---|---|---|
| `src/scripts/sync-sheets.ts` | 4 | a `--forms` flag, and include it in the default run |

---

# PART 7 — Stage 5: the documents, last and separately

**Code first, documents second, as separate commits.**

| Document | What changes |
|---|---|
| `BOT-SPEC.md` | ~~the region question's real interval behaviour;~~ `/urgent_pending` showing a status; the priority prompt's retry cap; a request on a closed case |

> **The region question is not in `BOT-SPEC.md` at all.** This row assumed it was
> and it is not — there is no section describing it, so there was nothing to
> correct. A teacher-visible behaviour missing from the specification of what the
> bot does is a real gap, but filling it is writing a new section rather than
> fixing a fixed defect, so it is **named here and left undone** rather than
> written in passing at the end of a fix pass.
| `RUNBOOK.md` | §1.4 unchanged — none of this touches the operational launch blockers; note that `npm run sync` now covers FORMS |
| `docs/plans/2026-08-01-identity-and-urgent-design.md` | open question 8 gains the note that the notice sentence was corrected on 2 August, struck through against the original rather than written over |
| `docs/dependency-tree.md` | regenerated, if 3c or 4a shipped |
| the artifact | **ask first.** It is at v9 and badly stale, and updating it in place is a session's work on its own |

---

# PART 8 — What is deliberately not being changed

- **The nightly deletion pass.** Trap 4. It reads `closed_at` and `importance` and
  never `status`, by an argument this project has already had. The writer is at
  fault, not the reader.
- **Where the update claim is taken.** Moving it inside the transaction would make
  claim and work commit together, which is tidier — but it changes a documented
  concurrency property for a failure that a release-on-error already covers. Not
  worth the risk in a fix pass.
- **Whether a closed case should be reopenable by the confirm button.** A real
  question, and the head of project's rather than engineering's. Raised, not
  answered.
- **Turning Telegram formatting on.** Trap 2.
- **Capturing Telegram display names.** Open question 8 of the programme plan,
  untouched by this. Only the sentence claiming it already happens is corrected.

---

# PART 9 — What proves it works

Per stage, and each commit verified on its own:

```bash
npx vitest run          # 0 skipped, and the number of passes stated plainly
npm run typecheck
npm run build
npm run lint
npm run deps:check
```

And per finding:

- **1a** — a teacher asked yesterday is not asked again, with a stale third
  teacher in the database. The test fails before the brackets and passes after.
- **1b** — a closed case confirmed urgent has no end date; the nightly pass leaves
  it alone; **and no case anywhere has an end date while its status is open.**
- **2a** — the privacy notice and the announcement contain no `*`.
- **2b** — the notice does not claim a Telegram name.
- **3a** — a losing account with twenty-five open cases has twenty-five closed.
- **3b** — a released claim can be re-claimed; a thrown handler raises an alarm.
- **3c** — a recipient that keeps failing is written off, and the announcement
  reaches `Sent`.
- **4d** — the lint gate fails on purpose, in front of somebody.

---

# Order, in one list

1. **Stage 0** — the green baseline. Five minutes, no code.
2. **The Trap 2 decision** — strip the markers, or turn formatting on. Blocks
   Stage 2 and nothing else, so Stage 1 runs alongside it.
3. **Stage 1a** — the region question. Two characters and a test.
4. **Stage 1b** — urgent confirmation on a closed case, `/urgent_pending`, and the
   invariant test.
5. **Stage 2** — every message a teacher reads, one commit for the notice, one for
   the staff wording. **One version bump, now, while there is one teacher.**
6. **Stage 3** — dispute settlement, the lost message, the stuck announcement.
   `npm run deps` on 3c.
7. **Stage 4** — invariants and small things, with the lint gate last.
8. **Stage 5** — documents.

**Rough cost:** Stage 1 half a day including tests. Stage 2 half a day if the
markers are stripped, two days if formatting is turned on. Stage 3 a day. Stage 4
half a day. Under three days in total on the recommended path, and none of it
touches the operational launch blockers in `RUNBOOK.md` §1.4, which still gate
everything.
