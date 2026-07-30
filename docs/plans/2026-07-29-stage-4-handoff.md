# Handoff — 30 July 2026

**This document is rewritten in place at the end of every session. There is one of it, and it is
current. If you are reading a copy of this content anywhere else, that copy is stale.**

Read this in full before touching anything, then read `docs/plans/2026-07-30-stage-5-scheduled-work.md`,
which opens with a "Where this stands" table naming every task and its state.

> **The filename still says stage 4.** That is historical and deliberate: there is one handoff, it
> is this file, and it is rewritten in place whatever stage is current. Rename it if you like, but
> do it as its own change and update the references in `docs/plans/2026-07-28-stage-4-staff.md`.

---

## 1. State, in one paragraph

**Stage 5 is complete. Every task from 47 to 71 is built, including the optional one, and none of it
is committed.** The system now acts without being asked: records are deleted at two in the morning,
each staff member gets their own list at seven, a teacher whose case is waiting on them is chased
three times and then their owner is told, MoPSE can reach 1,800 teachers with a report at the end, a
teacher who asks to be removed can be, and a teacher who does not know who to talk to can ask who
covers their region.

```
1,071 tests across 62 files · 0 failed · 0 skipped · 277 seconds
typecheck clean · build clean · deps:check clean · 76 source files · 62 test files
```

**That figure was run in full on 30 July and is not inherited.** The previous two revisions of this
document declined to state a number because no full run had finished; §7 explains why, and the reason
turned out to be an environment fault rather than a slow suite.

**Next: there is no next task in this stage.** The work is Stage 6, and §8 says what is known about
it. What this session did *not* do is commit — see the warning below.

> ⚠️ **The working tree is dirty and nothing since `787333c` is committed.** That is the standing
> pattern — work through, offer at a boundary — but it now covers **eleven tasks**, three documents
> and a rename across the whole of `src/`. A `git checkout` loses all of it. The head of project says
> "commit" and that is when it happens. **Offer early.**

## 2. Commits, oldest first

Stage 4 ran `d743d72..807284c` and is not re-listed; `git log --oneline d743d72..807284c` has it.

| Commit | What |
|---|---|
| `807284c` | End of Stage 4 — task 41, every document the stage made wrong |
| `b3112b0` `d38c639` | Documentation only: the Stage 4 handoff and its pointer at Stage 5 |
| `1f9f5ca` | **The Stage 5 plan.** Three questions answered, five faults found before any code |
| `cb791f2` | **Stage 5 Layers 0, 1 and 2** — tasks 47–55 and 57–60 |
| `787333c` | Documentation: this handoff, rewritten for Stage 5 |
| *(uncommitted)* | **Tasks 61–71.** Every command, both teacher-visible changes, all three jobs, the layer checker, and the whole documentation pass |

**When this is split into commits, the natural boundaries are:** the commands (61–64), the two
teacher-visible changes (65–66), the three jobs (67–69), the layer checker (70), the
province→region rename, and the documentation (71). The rename touches sixteen source files and is
text only — keeping it apart from the features is what makes both diffs readable.

## 3. The answers that decide what got built

**Six from Stage 4** are recorded in that plan as D7, D25, D26, D27, D28, with R16–R18 tracing the
last three. They are settled. **Do not reopen them and do not improve them.** In short: `Observer`
is the look-but-do-not-touch rank and `Regional` is now `Lead`; the eight case statuses stay and
staff type four of them; `Action required` means the **teacher** must act; `/close … unresolved`
exists with a hand-written reason; `/restore` exists; and retention is 7 days / 180 for urgent and
critical / 3 for the interaction log / never for the audit log, **as three settings rather than
constants**.

**Three more were answered on 30 July** while the Stage 5 plan was being written, and all three are
recorded at the top of that plan with their costs: the nightly content roll-up was **declined**; the
bot **does** name a teacher's regional manager, by name and Telegram username, with the handle
**verified rather than trusted**; and the re-consent gate **stands in front of cases and leaves the
answer bank open**.

**Two more were answered on 30 July, in the last session, and they are the ones a new reader will
not know.**

- **The word is *region*, not *province*.** Uzbekistan has regions and districts. **This bot is
  concerned with regions only and has no concept of a district.** About thirty user-visible strings
  said "province" while every command a person types says `region:`; that is now corrected across
  `src/` and the three documents. Do not reintroduce it.
- **The regions each staff member covers are entered by hand, later.** That is a decision, and it
  has a consequence worth understanding before somebody reports it as a fault: **an empty `regions`
  array means *every* region**, deliberately. So until they are entered, every staff member covers
  the whole country, and "who covers my region?" is answered by **rank alone** — the most junior
  person who can act on cases, wherever they sit. `RUNBOOK.md` §2.6 says so in the operator's words.

**One correction worth carrying, from Stage 4.** I proposed exempting the answer-feedback rows from
the 3-day rule and was told **"plan supersedes my choices!"** Three days means three days for every
row.

## 4. What is built, and the things that will bite

Tasks 47–60 are committed at `cb791f2`. Tasks 61–71 are in the working tree.

| Task | What a person can now do | Where |
|---|---|---|
| 61 | `/retention` — read the three periods, change one, be warned before lengthening | `commands/ops.ts` |
| 62 | `/announce` `/announce_send` `/announce_cancel` `/announcements` | `commands/announce.ts` |
| 63 | `/export` — a scoped CSV with no teacher's words | same file |
| 64 | `/forget <id> FORGET` — anonymise on request, System only | `commands/staff.ts` |
| 65 | **The re-consent gate.** Reaches all 1,800 teachers | `router.ts`, `handlers/menu.ts` |
| 66 | "Who covers my region?", and `/username` for staff | `staff/repository.ts`, `router.ts` |
| 67 | The nightly deletion job, 02:00 Tashkent | `worker/tasks/retention.ts` |
| 68 | The 07:00 digest, the teacher chase, the daily handle re-check | `worker/tasks/digest.ts` |
| 69 | **The announcement sweeper.** Every minute, 200 a batch | `worker/tasks/announcements.ts` |
| 70 | The layer rule, enforced by `npm run deps:check` | `scripts/dependency-tree.mjs` |
| 71 | All three documents corrected, and the tree regenerated | `BOT-SPEC` `RUNBOOK` `CONCERNS` |

**`privacyNotice` takes the periods and renders them. Never type a number of days into
`privacy.ts`.** A test reads that module's own source and fails if you do. `/retention` prints
`retentionParagraph()` — the notice's own text — rather than describing the periods in its own
words, for the same reason.

**`requiresReconsent` is asymmetric on purpose. Do not replace it with a hash.** Lengthening a
period asks 1,800 teachers to read the notice again; shortening one must not. Any digest of the
notice text changes in both directions. `null` means indefinite and is the longest period there is.

**Every purge function returns 0 and touches nothing when its period is `null`.** That is the rule
(D30), not defensive coding. The retention job's own first test asserts nothing is deleted, and the
job **says so out loud once a night** — because at launch a working job that deletes nothing looks
exactly like a broken one.

**The purge reads `importance` and never `status`.** A `Critical` case that was resolved is
`Completed`, and nothing about `Completed` remembers it was an emergency. There is a test.

**The chase counters reset inside `updateCase`, beside `closed_at`.** Not in `/await`. Leaving
`Action required` and re-entering it both restart the clock.

**The digest and the chase are one job and the chase runs second.** The chase writes to `cases`, and
doing the reads first is what stops the digest reporting a case as chased before it was.

**A failed chase does not advance the counter.** Three reminders means three delivered reminders, not
three attempts. There is a test.

**`/announce` refuses an over-long message rather than shortening it.** The guard was wrong the first
time and the failure was invisible — see §6.

### The sweeper, which is the newest thing and the least forgiving

**It takes one batch of 200 and returns.** No pacing loop and no sleeping. The worker is
`concurrency: 1`, and a long run starves the ten-minute sync and the five-minute heartbeat — the
first symptom being a *false* alarm that the sheet sync has stopped, raised late by the heartbeat
that was itself starved.

**There is no job to enqueue, and there must never be one.** A scheduled sweeper is the only sender.
That is what makes a restart mid-broadcast resume rather than repeat, and what keeps announcements
out of `job_runs` where an on-demand row would raise a critical alarm every hour nobody sent one.

**`isRetryable` is the only thing that decides retry versus write-off**, and **a teacher who lost
access between the draft and the send is `Skipped`, never `Failed`.** The two mean different things
to whoever reads the report.

**`resetStalledRecipients` is called only when the sweep claimed nothing**, with a **60-minute**
window. Read the comment before shortening it: the function measures staleness from the
*announcement's* start rather than from the claim — there is no per-recipient claim timestamp — so a
shorter window would eventually return recipients a slow-but-living run is still working through,
and message those teachers twice. **A duplicate to 1,800 people is the one failure a broadcast must
not have; a late resume is merely late.**

**A queued announcement with nobody in its audience still finishes.** `claimBatch` moves it to
`Sending` whether or not it claimed anybody and `finishIfDone` then closes it. There is a test,
because a broadcast stuck at `Queued` for ever is invisible rather than loud.

## 5. Deliberate departures from the Stage 5 plan

Each is explained at the site. **Do not revert them.** The first four are from the first session,
5–18 from the second, and 19–25 from the third.

1. **Task 54 was pulled forward** — Task 49 changes `privacyNotice`'s signature and its callers
   cannot compile without the settings reader.
2. **`SETTING` spreads `RETENTION_SETTING`** rather than declaring the three keys twice.
3. **`forgetTeacher` reports three outcomes, not two.** `alreadyForgotten` is kept apart from
   `notFound`.
4. **The chase tests are a new file**, `src/cases/chase.integration.test.ts`.
5. **`retentionParagraph` is exported from `privacy.ts`** so `/retention` quotes the notice's own
   text rather than describing the periods in its own words.
6. **`announcementMessage` and `announcementOverBy` were added to `digest/format.ts`.**
   `announcementOverBy` exists because of the fault in §6.
7. **`OutgoingMessage` gained an optional `document`**, sent by `deliver` after the commit, so an
   export that rolled back cannot already be in somebody's chat.
8. **`casesForExport` was added to `queries.ts`** rather than `/export` querying for itself.
9. **`RouterDeps.telegram` is a new optional field**, narrowed to `getChat` only. When it is absent
   `/username` writes nothing and says so.
10. **A new conversation state, `AwaitingPrivacyAcceptance`**, reusing `resumeAfterSignIn` rather
    than building a second resume mechanism.
11. **`tashkentCron(hour)` in `worker/main.ts`** instead of literal crontab strings, with the
    arithmetic asserted in a test.
12. **The re-consent gate also runs at `chooseCaseTopic`**, because a topic button in scrollback is a
    live route into filing a case that never passes through the menu.
13. **`/announce_cancel` may be run by anybody holding `announce`**, unlike `/announce_send`.
14. **"Who covers my region?" is behind neither gate.**
15. **`regionManagerFor` takes a region, not a chat id.**
16. **`ANNOUNCEMENT_RECIPIENT_RETENTION_DAYS` is a constant**, not a settings key.
17. **`main.ts` only starts a worker when it is the entry point.** See §6.
18. **`/username` is listed in `staffHelpSection` directly.** It has `capability: null`.

From this session:

19. **`AnnouncementSender` returns a `SendResult`, not a boolean** — unlike `DigestSender` one row
    along. The sweeper has to branch on `isRetryable`, and a boolean would force it to re-derive the
    failure kind or, worse, to guess.
20. **The sweeper stops the batch on a rate limit and hands the remainder back unspent.** Not in the
    plan. Telegram has just said we are going too fast; sending the other 199 earns a longer limit
    and delivers none of them. The next sweep is a minute away.
21. **`resetStalledRecipients` runs only when nothing was claimable**, at 60 minutes. §4 has the
    reasoning; it is the difference between a late broadcast and a duplicated one.
22. **Task 70 was built rather than dropped.** It was the one droppable task and there was room. It
    is proven both ways: it passes on the tree as it stands, and an upward import added on purpose
    made it fail. A checker nobody has watched fail is the `dependency-cruiser` failure again.
23. **"Province" became "region" across sixteen source files and all three documents.** Answered
    directly by the head of project; §3 has the rule.
24. **`RUNBOOK.md` gained §2.6, "Everything that has to be set by hand"**, which the plan did not
    list. Asked for directly. **Every item on it is invisible when it is missing** — the software
    runs perfectly and answers less — which is why they are gathered in one place rather than left in
    the procedures that need them.
25. **`BOT-SPEC.md` gained §5.3 and §11.0**, and its §11 was split into 11.0 (the rebuild's schedule)
    and 11.1 (the historical Apps Script triggers). The plan said "§11 or wherever scheduled work is
    described"; §11 described only the old system, so describing the new one inside it would have
    read as a correction of the old rather than as a separate thing.

## 6. Faults found by building

**Two in Stage 5's first session**, both by running things: the audience freeze did not run at all
(aliased tables against fully-qualified drizzle column references), and `delivery_state` had no
`Sending` value.

**Six in the second session**, and each one is worth a sentence because the class recurs. **The
over-long announcement guard could never fire** — `announcementMessage` clamps to Telegram's limit,
so the check compared against a number already capped, and an oversized announcement would have been
silently truncated and delivered to 1,800 teachers ending in "… cut short". **`clearUsername` always
reported that nothing was published**, reading the handle back from `RETURNING` on the `UPDATE` that
had just nulled it. **Importing anything from `worker/main.ts` started a second worker**, because
`main()` ran at module scope. **`ORDER BY id` on `audit_log` is meaningless** — the key is a random
uuid; order by `at`. **Five existing tests were building teachers the real system cannot produce**,
`Verified` with no recorded privacy acceptance, and the gate correctly stopped all five. **Two of the
plan's own test sketches were impossible as written.**

**One in the third session, and it was in the environment rather than the code.** It is in §7,
because that is where somebody will look for it.

**Worth stating plainly: the sweeper had no faults.** It was green on its second run, and the first
run's failures were entirely the environment fault below. That is unusual for this project and is
recorded honestly rather than as a claim about the code — the property that has held every session is
that faults are found by *running*, not by reading, and running is what happened here too.

## 7. Running anything

The test database is a container **with no volume**. It does not survive a `down` or a Docker
restart, so assume it is not running.

```bash
docker compose -f "D:\Telegram Bot server\docker-compose.test.yml" up -d
```

Wait for health before running the suite — the global setup connects immediately:

```bash
docker inspect --format "{{.State.Health.Status}}" mopse-test-postgres-1
```

Then, in PowerShell:

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run
```

**A run reporting hundreds of skips proved nothing** — that is the exact shape of a no-database run.
A real run reports **0 skipped**. The full suite takes **about four and a half minutes**, so run it
in the background and read the summary.

### ⚠️ Kill stray `vitest` processes before you trust anything

**This cost the first hour of the third session and had silently cost the previous two their full
suite runs.**

Two `vitest run` processes from an **earlier session** were still alive. They had been frozen while
Docker Desktop was paused, and the moment it was resumed they woke up and began truncating tables
underneath the run in progress. The symptoms were bizarre and pointed everywhere except the cause: a
duplicate primary key immediately after a `TRUNCATE`, a foreign key violation against a row inserted
two statements earlier, and a fixture count of five where one row had been written.

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*vitest*' }
```

**Check that before running anything, and check it again if a run fails in a way that makes no
sense.** The handoff has always said "run one at a time"; what it did not say is that a run you did
not start can still be running.

**Never pipe `vitest` through `head`.** `head` closes the pipe and the shell command returns, but
**the run keeps going** — which is how one of these was created. Redirect to a file and `tail` it.

**Docker Desktop can be *paused*.** A run then hangs with no output at all. Check with
`docker desktop status` — if it says `paused`, **`docker desktop start` does NOT unpause it**. Only
the tray icon or the Dashboard does, and `docker desktop restart` would tear down the test database.
Ask the head of project to click Resume. `starting` is different and resolves itself.

`docker` **is** on the PATH. Do not call it through `wsl`; that distro refuses.

**Use the git that is already installed.** The Bash tool in this environment *is* their Git Bash.
Never install another.

### One intermittent failure, observed once and not reproduced

**`src/staff/repository.integration.test.ts` → `reports a duplicate as a duplicate when two callers
race` failed once**, on 30 July, and has passed in every full run since — including the two complete
runs in the third session. The likeliest cause is the loser getting an error code other than `23505`,
which `addStaff` rethrows rather than converting. **If it recurs, widen the `catch` to name whatever
code actually arrived** rather than loosening the assertion.

**One test carries an explicit 30-second timeout**, in `announcements.integration.test.ts`: two
hundred recipients is two hundred access re-checks and two hundred marks, sequentially, which is a
few seconds of round trips. That is not slowness to fix — it is the measurement that says why the
batch is 200 and not 2,000.

### If you touch the schema

`npx drizzle-kit generate` and then **read the SQL it emitted before accepting it.** It has emitted a
destructive `DROP TYPE`/recreate in this repository once already. Rename the file from its generated
nonsense to match the convention, and change the `tag` in `drizzle/meta/_journal.json` to match.
Then prove the **deploy** path against an empty database as well as the incremental one.

**Stage 5 needed no migration beyond `0008`**, which carries everything including
`staff.telegram_username` and the `Sending` delivery state.

## 8. What to do next

**Stage 5 is finished. There is no remaining task in it.** Two things come before any new code.

**1. Commit.** Eleven tasks, three documents and a rename are sitting uncommitted. §2 has the
suggested boundaries. **Offer this first, before anything else.**

**2. The artifact.** §11. It is the head of project's document and it is the furthest behind
anything in the project.

### Then Stage 6, and what is already known about it

**Documents.** D24 keeps Google Forms; the `FORMS` tab and the response sync are Stage 6.
`sendDocument` landed in Stage 5 for `/export` and is deliberately **the only half of document
handling that exists** — the bot still never accepts or stores a file, and `CASE_CATEGORY.SUBMIT_DOCS`
is waiting with the queue map already total over it.

**The resignation route** (decision 9 of `2026-07-29-staff-and-lifecycle-design.md`) is later, and
Stage 5 left it exactly one thing: `forgetTeacher` is a callable function with its own tests rather
than logic buried inside `/forget`. The three-month timer is unwritten.

**The `/await` taxonomy** (D26) is unbuilt. The teacher's chase message renders `public_update`
verbatim and **must not parse it**, so a taxonomy changes the chase's *input* rather than the chase.

**The content roll-up** was offered and declined (Q1). It stays available and is one table and one
step in a job that now exists. `RUNBOOK.md` §4.7 records the decision so nobody restores the section
by accident.

### The four things not to get wrong, restated

**Retention is one release or it is a lie.** All five parts are built — the job, the three settings,
the generated notice, the bumped wording version and the re-consent gate. **They must deploy
together.**

**The crontab is UTC.** Use `tashkentCron()`; there is a test for the arithmetic.

**Only scheduled work calls `recordJobRun`.** Announcements are swept, never enqueued.

**Chasing chases the teacher.** The queries decide who; the job does not re-derive it.

### Where the documentation stands

**All three specification documents are now correct as of Stage 5** — `BOT-SPEC.md` at 1.4,
`RUNBOOK.md` at 4.0, `CONCERNS-AND-IT-ACTIONS.md` at 4.0. **The rule for Stage 6 is the rule that has
held for two stages: do not edit them mid-stage.** Collect what a stage makes wrong and correct them
once, at the end, in one pass. A document edited a little at a time as code lands describes a system
half-way between two states.

`docs/dependency-tree.md` is regenerated and current at **76 source files, 62 test files**.

### The dependency graph, and the layer rule

```
npm run deps          → writes docs/dependency-tree.md
npm run deps:check    → silent, exits non-zero on a cycle, an unresolvable
                        import, a file nothing uses, or an import that points
                        UP the layers
```

**The layer rule is now mechanical** (Task 70). The layers are written down in
`scripts/dependency-tree.mjs`, directory by directory, with two deliberate overrides:
`config/settings.ts` is a **store** despite living among the pure modules, and `telegram/send.ts` is
a **leaf** despite living in the command layer. **A type-only import may point upward and is not a
violation** — it is erased at compile time, and this codebase relies on it.

### Two tools, both settled — do not spend time on either

**`dependency-cruiser` cannot work here yet.** It needs `typescript@7.1.0` and `latest` is `7.0.2`.
Installed on 29 July, it cruised **0 modules while printing a green tick** and was removed. That
failure is why Task 70's checker was proven against a deliberate violation before being trusted.

**`repowise` is rejected. The head of project's words were "ignore repowise forever".** Do not
propose it, do not re-test it, do not mention it.

## 9. Open questions

**None about how the software behaves.** Eleven have been answered across the project, and the last
two were answered in this session (§3).

Two things are still waiting on MoPSE, and neither is an engineering decision:

**Whether the privacy notice says the right things — and this is now the sharpest item on the
project.** The rewritten notice and the gate that shows it are both in the tree. **Reviewing it
before that deploy means one round of re-consent. Reviewing it afterwards means two** — 1,800 people
asked to read it, and then asked again.

**Whether sign-in should be reconsidered before launch.** That decision expires at launch: today it
is a change to a flow nobody has used.

**The launch gate is off engineering.** `RUNBOOK.md` §1.4 is the checklist and none of it is code —
and §2.6 is the new list of everything a person has to type in, none of which announces its own
absence.

## 10. How this project is run

- **The head of project is not an engineer.** Plain English, no jargon; recommend rather than
  survey; correct a wrong premise directly rather than working around it.
- **Do not commit per task.** Work through, offer once at a boundary; they say "commit" and that is
  the standing pattern. A fix to already-committed code gets its own `fix:` commit, separate from
  the feature that found it. When two tasks are committed together, split them properly — and
  **verify each commit stands on its own rather than only the tip**.
- **Verify before claiming done.** Tests, typecheck, build, with the numbers stated plainly. This
  project has repeatedly found faults in code that was written, reviewed and committed the day
  before, and every one was found by running something rather than by reading.
- **Their answers are decisions, not opening positions.** Raise a concern once, then build what was
  asked and record the cost.
- **Say what you did not do.** A gap named in this document is cheap; a gap discovered in November
  is not.

## 11. Ending a session — the three things that must be current

Do all three **before** saying the session is finished.

**1. This document, rewritten in place.** Not patched — rewritten. It has been amended five times in
a single session before, and the result contradicted itself in three places.

> **This is the only document rewritten in place, and that is the whole point of it.** Everything
> else is either a record of finished work — the stage plans — or a description of the running
> system. A stage's plan goes in **a new document**; the three specification documents are corrected
> **once, at the end of a stage, in one pass**. This file plus the current stage's plan is the whole
> briefing.

**2. The plan's "Where this stands" table**, at the top of
`docs/plans/2026-07-30-stage-5-scheduled-work.md`, plus the checkboxes on any task that was finished,
with its commit hash.

**3. The artifact — `https://claude.ai/code/artifact/64bce4b9-a63e-4dee-a883-9b0ecb457b53`.**

> **It is the head of project's document, not an input to this one.** Do not read it to get up to
> speed and do not copy anything out of it. It flows one way — from what was actually built, to them.

Update it **in place** by passing that URL as `url`. Never mint a new one; favicon 🤖, keep it.

The mechanism, because getting it wrong costs a whole rewrite:

- `WebFetch` the URL. It saves the full HTML to a local file and prints the path.
- Strip the `<!doctype>`/`<head>` frame wrapper and the trailing `</body></html>`. What remains —
  starting at `<title>` — is what gets republished.
- **Edit the remainder; never rewrite it from scratch.** The design system and every section you are
  not touching survive intact that way.
- Bump the version in **four** places — the sidebar, the masthead eyebrow, the footer's "Version N",
  and the footer's prose — and update the six numbers in the metrics row. State only figures that
  were actually run.
- Republish with `url` set and the same favicon.

What belongs in it, in their words rather than the code's: what a person can now *do* that they
could not before; anything that changes what a teacher sees; every fault found, including the ones
in already-committed code; anything that cost more than the plan said it would; and what is still
waiting on MoPSE. What does not belong: file names, function names, task numbers as the *subject* of
a sentence, or any figure nobody ran.
