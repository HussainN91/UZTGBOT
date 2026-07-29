# Engineering Concerns and Actions Needed from IT

**Version:** 3.0 · **Date:** 2026-07-29 — updated after Stage 4 of the rebuild

> Items marked **✅ closed by the rebuild** were true of the Apps Script version
> and are not true of what runs now. They are kept rather than deleted, because
> the reason a concern existed is worth more than the concern.

Two parts. **Part A** is a concrete action list — things someone must do, with an
owner and a deadline. **Part B** is my honest assessment of where this system is
weak, so nobody is surprised later.

Nothing here blocks launch except where marked 🔴.

---

# PART A — Needs attention from IT

## 🔴 A1. The internal answer bank is sitting in the deployment folder

`Teacher_Contract_Accommodation_Answer_Bank_September_2026_UPDATED.md` is in the
same directory as the source code. Every page of it is stamped
`Confidential Internal Answer Bank`, and it contains the salary-cap rationale,
the benchmarking strategy, the Quick Reply Map, and staff instructions like
*"No net salary should be promised."*

**If this folder is handed to IT staff, a contractor, or a vendor, that document
goes with it.** The bot itself is clean — I verified zero internal content
reached `FAQ-import.csv` — but the source file's location is a disclosure risk
that has nothing to do with the bot.

**Action:** move both source markdown files out of the deployment folder into
wherever MoPSE keeps restricted HR material. Keep `FAQ-import.csv` (it is
teacher-facing by construction).
**Owner:** Head of project · **When:** before sharing this folder with anyone

## ✅ A2. Re-run `installTriggers()` — **closed by the rebuild**

There are no triggers to install. Scheduled work runs in the worker process from
a schedule held in code, so it cannot be half-installed, and there are no sheet
watchers at all — the two the old system needed existed to invalidate caches that
no longer exist.

The failure this action guarded against is closed twice over. Revoking a teacher
takes effect on their next message rather than up to thirty minutes later
(`BOT-SPEC.md` §5.1), and **a scheduled job that stops running now raises an
alarm within minutes** rather than being silently absent — `job_runs` records
every run and the heartbeat alerts on any job that misses its interval.

> **Corrected 2026-07-29.** The sentence above about revocation was written
> before it was true. Until Stage 4, deactivating a roster row did **nothing at
> all** to a teacher who had already signed in: the roster's active flag was read
> only when somebody signed in, and a teacher who has signed in never signs in
> again. It is true now — every gated action re-checks the roster live, and there
> is a `/revoke` command with `/restore` beside it. The claim is left in place
> with this note rather than quietly rewritten, because a document that has been
> wrong about something is worth knowing about.

**Nothing to do.** The equivalent deployment step is applying migrations before
serving, which is in the runbook and in `deploy/README.md`.

## ✅ A3. Delete or quarantine `bot_spec.md` — **DONE**

It documented `MessageHandler.gs`, `CallbackHandler.gs`, `FormGenerator.gs`,
`EmailParser.gs`, `CAND-0042` deep links and a 7-column flat sheet. **None of
this exists.** Anyone who read it while setting the system up would have been
actively misled. `BOT-SPEC.md` replaces it.

**Action:** ✅ **Done — 2026-07-27.** `bot_spec.md` was deleted rather than
renamed, and `proposal_gap_analysis.md` was deleted alongside it for the same
reason — it was a mid-build status table that was wrong in both directions.
Deletion is a stronger resolution than quarantine: a file that is gone cannot be
mistaken for authoritative. `BOT-SPEC.md`, `RUNBOOK.md`,
`CONCERNS-AND-IT-ACTIONS.md` and `UPGRADE-PLAN.md` are now the only
documentation, with no overlap between them.
**Owner:** IT · **When:** ✅ complete

## 🟠 A4. Add a second System member

**Built in Stage 4, and still needs you to do it.** The commands exist now and
they are the ones below, not the Apps Script names this item used to give:

- `/staff` — everyone, with their rank, queue and regions, and deactivated people
  listed separately rather than hidden.
- `/staff_add <chat id> <rank> <queue> [regions]` — adds somebody. It refuses to
  guess the rank or the queue, because guessing gives a person more than you
  asked for and nothing in what you typed would show it.
- `/staff_role <chat id> <rank>` — changes a rank, and is also how somebody who
  was removed is put back.
- `/staff_remove <chat id>` — deactivates. The row always stays, so notes and
  audit entries can still name the person.

**The first System member cannot be created by any of them**, deliberately: they
all require System rank, so the first row is a hand-written line of SQL over the
server connection, written out in `RUNBOOK.md` §2.5. Every automated alternative
is a permanent back door — an environment variable granting System access to
whoever can edit a file, or a "first caller wins" rule that is a race with the
public internet.

**Which is exactly why a second person matters.** `/staff_remove` refuses to
deactivate the last active System member, and `/staff_role` refuses to demote
them, so the bot will not let you paint yourself into that corner by accident.
But if the one account is lost — a phone, a person leaving — the recovery is
another trip to the database.

**Action:** seed the first System member with the SQL in `RUNBOOK.md` §2.5, then
add the second from that account with `/staff_add`. Two different people.
**Owner:** Head of project · **When:** at deployment

## 🔴 A5. Prove the backup and the restore, and own the spreadsheet properly

Two halves, and the second one is now the sharper of the two.

**The server.** Case history, teacher records and the interaction log live in
PostgreSQL on one rented machine. `deploy/backup.sh` takes an encrypted nightly
dump and pushes it off the server; `deploy/restore-drill.sh` restores it into a
throwaway database and checks the result actually contains tables. Both are
written and neither has been run against the real server, because there is no
real server yet. **An untested backup is a belief, not a capability** — running
the drill is a launch blocker, not a nicety.

Record `BACKUP_PASSPHRASE` somewhere that is not the server. An encrypted backup
whose passphrase died with the machine is not a backup.

**The spreadsheet** still holds the roster and the answer bank, and the bot only
ever reads it — so losing it no longer loses case history, but it does stop
anybody signing in. Own it with a **MoPSE organisational account**, not a
personal one, add a second owner, and record it in the IT asset register.

**Owner:** IT · **When:** restore drill before launch, then quarterly

## 🟠 A6. Decide the FAQ content review cadence

112 answers describing salary, visa rules and contract terms will drift. Nothing
in the system flags a stale answer — `LAST_APPROVED_DATE` exists but is never
read by code.

**Action:** name an owner and a review interval (quarterly is typical), and
populate `LAST_APPROVED_BY` / `LAST_APPROVED_DATE` at import so the clock starts.
**Owner:** Head of project · **When:** first month

## 🟠 A7. Give the alerts somewhere to arrive — mostly built

The concern was that errors went to a log nobody opened, so a broken feature
stayed broken until a teacher complained. That is now built rather than
recommended:

- Operational alarms are **sent to a Telegram chat**, not only logged — a refused
  sync, a duplicate sign-in, an urgent code spent for nothing, a teacher who was
  never told what happened.
- **Silence is audible.** Every scheduled job records its runs, and one that
  stops being scheduled raises an alarm within minutes. A job that stops produces
  no error of its own, which is exactly why something has to look for its
  absence.

- **Alarms now also reach every System member individually**, added to the
  operations chat and never instead of it. That ordering is the point: the
  environment variable is what still works when the staff table is empty, wrong,
  or unreachable — and "the staff table is wrong" is a state whose alarm must not
  depend on the staff table.

**What is left for you:** create the operations group, add the bot to it, and put
its chat id in `OPS_ALERT_CHAT_ID`. Use a **group**, not one person's private
chat — one person on leave should not mean nobody is watching. Group ids are
negative; the setting accepts them.

**The operations chat is the one group the bot will stay in.** As of Stage 4 it
refuses to work in group chats and leaves any it is added to — a control the
specification has always described and which did not exist until now. That group
is exempt by chat id, so putting the id in `OPS_ALERT_CHAT_ID` is what keeps the
bot in it. **Add the bot to the group after the id is configured**, or it will
leave, correctly, and you will have to add it again.

The bot will not answer anything typed in that group. It is there to speak, not
to listen.

Without it, alarms fall back to the log and to System members' private chats —
and before the first System row exists, only to the log, which is the concern
above exactly as true as it ever was.
**Owner:** IT · **When:** at deployment

## 🟠 A8. Restrict spreadsheet access — narrowed, not closed

**The severe half is closed.** Case details never reach the spreadsheet: they are
written to the database and the bot only ever *reads* Sheets. Nobody can grant
themselves staff access by typing a Telegram id into a tab, because permissions
live in a table on the server. The Google service account holds **Viewer on one
spreadsheet** and nothing else.

**What is left is the answer bank.** `FAQ-import.csv` and the FAQ tab hold the
112 approved answers on salary, tax, visas and contracts. That is confidential
ministry content, and read access to the spreadsheet is read access to all of it.

**Action:** share with named staff only — never "anyone with the link" — and
review the access list quarterly. Edit access should be narrower still: an
accidental clear of the roster tab is caught by the sync's damage limit, but a
plausible-looking bad edit is not.
**Owner:** IT · **When:** before launch — **still open**

## ✅ A9. The webhook secret in the URL — **closed by the rebuild**

It travels in the `X-Telegram-Bot-Api-Secret-Token` header now, compared on every
request. Apps Script could not read request headers reliably for `doPost`, which
is the only reason it was ever in the query string — where it leaked into every
proxy log, access log and `getWebhookInfo` output in the path.

`getWebhookInfo` output is no longer sensitive, so the awareness this item asked
for is no longer needed.

## ✅ A10. How long records are kept — **decided 2026-07-29**

Answered, in time: before the bot has served a single teacher.

| What | Kept |
|---|---|
| A case that is **not resolved** | **For ever** |
| A resolved case | **7 days** after it was closed |
| A resolved case marked **Urgent** or **Critical** | **180 days** after it was closed |
| The message log | **3 days** |
| The audit trail | **Never removed** |

The three periods are **settings**, not numbers written into the program, so
MoPSE can change them without a deployment. That was your explicit choice against
the opposite recommendation, and it turned out to make one thing cleaner rather
than harder: the privacy notice is generated *from* those settings, so a period
and the sentence teachers read about it cannot disagree.

**Nothing built in Stage 4 deletes anything.** The job, the settings and the new
privacy notice ship together in Stage 5, because a notice promising deletion that
nothing performs is false in the same way the revocation claim above was.

Two consequences, both real, and neither obvious:

**The monthly content review does not survive a three-day log.** `RUNBOOK.md`
§4.7 ran two thirty-day queries over the message table to find out what teachers
were asking that the answer bank could not cover, and which confident answers
they were rejecting — described in that document as the strongest signal
available. At three days both return nothing, and **an empty result from a review
reads exactly like a system with no problems.** The section has been deleted
rather than left to quietly stop working. If you want the signal back, it comes
from a nightly count taken *before* the delete — no teacher's words kept, just
"this answer was rejected fourteen times in October". That is a Stage 5 task and
it is your call, not a reason to lengthen the period.

**Publishing these periods requires asking 1,800 teachers to read the notice
again.** The current notice tells every teacher who has signed in that no period
is set and that *"when one is set, this notice will be updated and you will be
asked to read it again"*. That is a commitment already made. Stage 5 ships the
new wording, the version bump and the re-consent flow in the same release as the
job.

**One rule worth knowing before you ever change a period:** *lengthening* one —
keeping data longer than teachers were told — asks everybody to re-consent.
*Shortening* one does not, because deleting sooner than promised breaks no
commitment to anybody, and putting 1,800 people through a re-consent to be told
their data goes sooner is a cost with no beneficiary.

## ✅ A11. How a removal request is honoured — **closed, and this item was wrong**

Closed by A10, and the correction matters more than the closure.

**This item said the constraint blocks deleting a case. It does not.**
`ON DELETE restrict` on `cases.teacher_chat_id` refuses the deletion of a
**teacher** who still has cases. Deleting the *case* was never obstructed, and
the notes attached to it are removed with it automatically. The two were blurred
here, and the blur is what made retention look like it needed anonymisation.

So the retention job deletes cases outright, which is what "removed after seven
days" means. **Anonymisation is what a teacher's own removal request needs** —
their name and identifier replaced, the case history kept — and that is a
different, smaller job than this item implied. It stays a Stage 5 item alongside
the retention work.

**The consequence you will meet in week two**, stated here so nobody reports it
as a fault: a week after a case is closed, its reference stops working. A teacher
telephoning about `VISA-2026-00123` gets "no such case", and there is nothing
left to reopen.

---

# PART B — Engineering concerns

Ranked by how likely they are to bite you.

## ✅ B1. The global lock is the throughput ceiling — **closed by the rebuild**

The lock is per chat, so two teachers can never block each other, and it is
transaction-scoped — a handler that throws or a process that is killed cannot
strand it. The log no longer takes a lock at all, so it no longer discards rows
under load, which it did exactly when they were most worth reading.

## ✅ B2. Sheets is not a database — **closed by the rebuild**

It is a database. Case operations are indexed lookups rather than full reads, and
nothing degrades as the table grows — which also deletes the entire archive
system, whose only purpose was keeping the live sheet small.

**The retention half of this item did not go away with it; it got sharper, and it
has moved to Part A as A10.** Retention was previously half a performance
argument and half a privacy one, and the performance half was doing the
persuading. With the performance half gone, what is left is purely a promise made
to teachers in the privacy notice, with no technical excuse attached to it.

## B3. `/announce` still runs inside the webhook — 🟡 Not yet rebuilt

Announcements are Stage 5 and do not exist yet. The architecture that fixes this
does: the worker process runs slow work so it can never delay a teacher waiting
for a reply, and the audience is frozen into a table the moment the sender
confirms, so a paced send is resumable rather than restartable.

Nothing here is a risk today, because the feature is absent rather than broken.
Re-read this item when Stage 5 is planned — which is now the next stage, and it
carries the retention job and the privacy re-consent with it.

Stage 4 left the permission for announcements in place with no command behind it,
so Stage 5 adds a command rather than a permission model.

## B4. The tests now run, and finding out cost four faults — 🟡 Low

Not closed, rewritten. There is a suite — 778 tests as of Stage 4, of which the
ones that matter run against a real PostgreSQL, on a schema built by the
migrations themselves, so the migrations are proven too.

The honest form of this concern is now **"code that no test has ever executed is
not known to work"**, and Stage 3 produced the evidence. Four faults surfaced
within minutes of the tests being pointed at a database, every one of them
invisible to reading:

- `checkHeartbeats` threw on **every** call — a parameter inferred as an integer
  could not hold `1.5`. The job that exists to make silence audible had never once
  completed, and nothing was watching it, because it is the thing that watches.
- The same function's "do not repeat this alarm" update also threw, so a job that
  stayed down would have re-alerted every five minutes.
- Timestamps read through `db.execute` come back as strings, not `Date` objects.
  The heartbeat alarm called `.toISOString()` on one — on the branch where a job
  had succeeded once and then stopped, which is the commonest real failure.
- Two test files truncated tables the other was using, and each passed alone.

The first three were in code committed a day earlier and reviewed. The lesson is
not "write more tests" but **"run the thing against the real dependency"** — all
four are shaped so that no amount of reading finds them.

**Stage 4 produced three more of exactly the same shape, and the worst of them is
worth reading in full**, because it is the clearest example this project has
produced of why a test that has never run proves nothing:

- **A revoked teacher could give themselves their access back.** Somebody whose
  access a staff member had deliberately ended could type `/start`, then their
  recruitment email, and be fully signed in again — because signing in clears the
  "access ended" mark as a side effect, which is correct for a teacher who bought
  a new phone and catastrophic for one who was revoked on purpose. The gate had
  been closed on the route through the menu buttons and not on the route through
  `/start`. Nothing anywhere reported it, and it survived three tasks of review.
  Found the moment a test was written for it.
- **A reopened case kept the date it was closed**, so a case somebody was actively
  working carried an end date from its previous life. Harmless when it was
  written, and not harmless once the retention decision above was made: the job
  measures its seven days from exactly that column, so a reopened case would have
  been deleted a week later, silently.
- **The vocabulary of case statuses existed in three places**, two of which
  defined the same list separately and were reached by different code. They
  agreed by luck.

Every one was found by running something or by needing to use it. None would have
been found by reading.

**What is still uncovered:** delivery to Telegram itself, and the deploy path.
Both are covered by the smoke test in the runbook rather than by the suite.

## B5. Single points of failure — 🟠 Medium, changed shape

The dependency on one Google account is largely gone: losing it now costs sign-in
and FAQ updates until it is restored, not every case ever filed.

What replaces it is **one rented server**. Lose the machine and the bot is down
until it is rebuilt — which is a recovery procedure rather than a catastrophe,
but only if the backup and the restore have actually been proven (A5). One bot
token remains a single point of failure and always will.

This is the right trade at one intake cohort. It is a deliberate, recorded choice
rather than an oversight: redundancy would mean a second machine, a replicated
database and a load balancer, for a bot serving 1,800 people in one time zone.

## B6. Header names are silent contracts — 🟡 Low, and no longer silent

Almost closed. Column names inside the system live in the program, so renaming
one is a compile error across every query that touches it rather than a feature
that quietly stops working.

**Two spreadsheet tabs still have header contracts** — the roster and the FAQ —
because they are the two things the spreadsheet still owns. The difference is
that a renamed column now **stops the sync and reports it** instead of silently
returning nothing: the sync refuses the run, changes nothing, and raises an
alarm naming the column. A single bad *cell* rejects that one row and reports it
with the row number, rather than failing the whole run.

**Mitigation:** still protect the header row on both tabs. It is now the
difference between an alarm and no interruption at all, rather than between
working and silently broken.

## B7. Verification is only as strong as the roster — 🟠 Accepted, detected, and **expiring**

Unchanged in substance: identity is "types a string that appears on the roster".
Anyone holding a teacher's recruitment email can sign in as them. The alternative
— one-time codes issued per person — is materially more work for recruitment.

**It is reported, not blocked, and that direction is deliberate.** A second chat
presenting an already-bound identity is allowed; the operations chat is alerted
and the previous holder is sent a security notice. Blocking looks safer and is
worse in both directions: it locks out any teacher who changes phone, with no
command to release them, and it hands anyone holding a leaked email the power to
sign in first and lock the real teacher out permanently.

**What has changed is the deadline.** This is the cheapest it will ever be to
reconsider. Before launch it is a change to a sign-in flow nobody has used; after
launch it is a change to how every teacher already signed in, plus a migration,
plus telling them. **The decision expires at launch** — not because it becomes
wrong, but because it stops being cheap.

## ✅ B8. Urgent codes can still be lost — **closed by the rebuild**

This item said the full fix "requires validating the code without consuming it
and consuming it at case creation, **which opens a double-use race**".

That blocker was true of Script Properties and is not true of PostgreSQL. One
conditional statement —
`UPDATE … WHERE code = … AND used_at IS NULL AND expires_at > now()` — can
succeed exactly once, whoever runs it and however many run at the same instant.
So the code is checked when the teacher types it and spent when their case is
filed, the window is 24 hours rather than 6, and a teacher who gives up halfway
keeps their code.

**This was a capability that became available and nobody noticed.** It is worth
recording as a category: some entries on a concerns list are not "we could not
afford to fix this" but "this could not be fixed *then*", and nothing re-examines
them when the constraint disappears.

**It did not come free.** Apps Script destroyed a code whether the guess was
right or wrong, so a wrong guess burned the thing it was guessing at. Leaving a
wrong code untouched made guessing free against a six-character space, which
needed a guess cap that no document had ever called for — five per chat per
rolling hour. Making one thing safer made something adjacent unsafe, and only
tracing the change outward found it.

## B9. `DOC-001` speaks in the third person — 🟢 Cosmetic

The answer reads *"The candidate should avoid submitting multiple duplicate
entries… The team will advise…"* — correct in substance, but odd coming from a
bot talking **to** that candidate. Left as-is per your approval. One-line fix
whenever you want it.

## ✅ B11. A teacher's region was never correctable — **new, and closed by Stage 4**

Recorded because the lesson is B4's, arriving from a different direction.

Region decides which staff see a teacher's case. It was read once, when the
teacher signed in, and copied into their record — and **a teacher who has signed
in never signs in again**. So when recruitment corrected a region on the
spreadsheet, that correction reached nobody who was already using the bot, for
ever. There was also no command to correct one, so a teacher who moved province
had no route at all: their emergencies kept routing to their old region's staff.

Everything about it looked like a working feature. The column existed, it was
populated, the spreadsheet was authoritative, and edits to it were applied
nightly. Nothing failed. Nothing was logged. The only symptom was staff in one
province occasionally seeing a case from another, which reads as somebody having
moved rather than as a fault.

Closed three ways in Stage 4: the roster is now read live rather than from the
sign-in copy, so a spreadsheet correction reaches everybody on the next sync;
`/region` lets a manager set one directly, with the spreadsheet left alone; and
the bot asks a teacher, rarely, whether the region it holds is still right —
their "no" raises a flag a manager sees on `/regions`, and never changes the
record itself, because a menu of regions is a menu of whose emergency this
becomes and a wrong tap sends it to the wrong province.

**The lesson, which is B4's:** a column with a writer and no reader looks exactly
like a working feature, and so does a column read in one place that nothing ever
updates.

## B10. No per-chat rate limiting — 🟢 Low

Beyond the 5-attempt verification cap, a single chat can send unlimited messages,
each triggering a sheet read and a lock acquisition. There is no abuse path to
data, but one determined user could degrade throughput for everyone. Telegram's
own flood limits provide some protection.

---

# Summary for the head of project

**The rebuild has closed most of Part B outright**, because most of Part B was a
list of things Google Sheets could not do. B1, B2 and B8 are gone; B6 is nearly
gone; B4 has been rewritten into something more useful than it was.

**Two of the three sharp items are now answered.** How long records are kept
(A10) was decided on 29 July, in time — before the bot has served anybody — and
answering it also closed how a removal request is honoured (A11), which turned
out to rest on a misreading of our own database rather than on a real
obstruction.

**One is still open, and it expires by itself:**

- **Whether to reconsider sign-in (B7).** Unchanged in substance. Identity is
  still "types a string that appears on the roster", so anyone holding a
  teacher's recruitment email can sign in as them. It is detected and reported
  rather than blocked, deliberately. This is the cheapest it will ever be to
  change, and **it expires at launch** — not because it becomes wrong, but
  because after launch it is a change to how every teacher has already signed in,
  plus a migration, plus telling all of them.

**Two things follow from the retention decision and neither is optional**, both
in Stage 5: the monthly content review is gone and needs replacing if you want
that signal (A10), and every teacher has to be asked to read the privacy notice
again before any period is published.

**Still needed, unchanged from the last version:** a real support contact — the
bot now *refuses to start* without one, so it can no longer be forgotten — the
teacher roster, and at least two named System members so one person leaving
cannot lock everyone out (**A1**, **A4**). The commands to manage staff exist as
of Stage 4; the very first System member is still one line of SQL, on purpose,
and `RUNBOOK.md` §2.5 has it.

**One thing for whoever owns the spreadsheet.** The bot reads **two tabs** — the
roster and the FAQ — and nothing else. If the original document is being reused,
the other tabs are inert. **Delete `ADMINS` in particular:** it used to grant
administrator rights to whoever was typed into it, and it now does nothing at
all. A tab that looks like it works and does not is worse than no tab, and this
one looks like the place you would go to give somebody access.

**And one that is only a launch blocker because it has never been done:** prove
the backup restores (**A5**). The scripts are written and have never been run
against a real server. An untested backup is a belief.

**Everything remaining in Part B is a known trade-off**, not a mistake. At the
scale of one intake cohort they are the right trade-offs. If this system is still
running in three years, B5 — one server — is the first to revisit.
