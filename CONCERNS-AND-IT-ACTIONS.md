# Engineering Concerns and Actions Needed from IT

**Version:** 2.0 · **Date:** 2026-07-28 — updated after Stage 3 of the rebuild

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

## 🟠 A4. Add a second System Administrator

`/add_admin` requires an existing System Admin. If the single seeded row is
deleted or that person leaves, **no one can administer the bot** and the only
recovery is editing the ADMINS sheet by hand.

The lifecycle around this improved with the upgrade plan: `/admins` lists
everyone with provenance, `/remove_admin` deactivates safely (it **refuses to
deactivate the last active System Admin**), `/set_role` restores, and
`/add_admin` can no longer accidentally strip an existing System Admin's flag.
None of that changes the underlying need for a second person.

**Action:** seed at least two System Admins in different people's names.
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

**What is left for you:** create the operations group, add the bot to it, and put
its chat id in `OPS_ALERT_CHAT_ID`. Use a **group**, not one person's private
chat — one person on leave should not mean nobody is watching. Group ids are
negative; the setting accepts them.

Without it, alarms fall back to the log and the concern above is exactly as true
as it ever was.
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

## 🔴 A10. Decide how long records are kept — **new, and now dated**

`RETENTION_DAYS` is unset, and Stage 3 is what starts filling `messages`: every
inbound message writes a row. The privacy notice shown to every teacher before
they sign in already promises their data can be removed.

There is a test that fails if anybody writes a number in before you have chosen
one, so this cannot be closed by a developer picking something reasonable.

**Answering before the first deployment is a decision about a design. Answering
after is a decision about data that already exists.**
**Owner:** Head of project · **When:** before the bot serves a single teacher

## 🔴 A11. Decide how a removal request is honoured — **new**

`cases.teacher_chat_id` is `ON DELETE RESTRICT`, deliberately: it guarantees no
case can exist without a real teacher behind it. It also means a teacher who has
ever opened a case **cannot be deleted**, and the privacy notice promises removal
on request.

The promise is now blocked by a constraint we added on purpose, not merely
unimplemented. Honouring it needs a deliberate anonymisation route — replace the
identifying columns, keep the case — which is Stage 4 or later work but is a
policy decision first.
**Owner:** Head of project · **When:** before launch

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
Re-read this item when Stage 5 is planned.

## B4. The tests now run, and finding out cost four faults — 🟡 Low

Not closed, rewritten. There is a suite — 332 tests, of which the ones that
matter run against a real PostgreSQL, on a schema built by the migrations
themselves, so the migrations are proven too.

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

**What it did not close, it made sharper.** Three items are now *more* pressing
than before, and all three are yours rather than IT's:

1. **How long records are kept (A10).** Previously half a performance argument.
   The performance half is gone, so what remains is a promise made to every
   teacher in the privacy notice, with nothing technical left to hide behind.
   Stage 3 is what starts filling the table.
2. **How a removal request is honoured (A11).** The database now actively refuses
   to delete a teacher who has ever opened a case. That is a guarantee we added
   deliberately, and it blocks a promise we also made deliberately.
3. **Whether to reconsider sign-in (B7).** Unchanged in substance, but this is
   the cheapest it will ever be to change. It expires at launch.

**Still needed, unchanged from the last version:** a real support contact — the
bot now *refuses to start* without one, so it can no longer be forgotten — the
teacher roster, and at least two named administrators so one person leaving
cannot lock everyone out (**A1**, **A4**).

**And one that is only a launch blocker because it has never been done:** prove
the backup restores (**A5**). The scripts are written and have never been run
against a real server. An untested backup is a belief.

**Everything remaining in Part B is a known trade-off**, not a mistake. At the
scale of one intake cohort they are the right trade-offs. If this system is still
running in three years, B5 — one server — is the first to revisit.
