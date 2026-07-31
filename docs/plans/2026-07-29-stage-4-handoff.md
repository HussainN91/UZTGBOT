# Handoff — 31 July 2026

**This document is rewritten in place at the end of every session. There is one of it, and it is
current. If you are reading a copy of this content anywhere else, that copy is stale.**

Read this in full, then read **`docs/plans/2026-07-31-stage-6-documents.md`**, which is the stage
just finished and the most useful record of how this codebase actually behaves.

> **The filename still says stage 4.** Historical and deliberate: there is one handoff, it is this
> file, and it is rewritten in place whatever stage is current. Rename it if you like, but do it as
> its own change and update the references in `docs/plans/2026-07-28-stage-4-staff.md`.

> ### ✅ The working tree is CLEAN. Everything is committed.
>
> That has not been true at the start of a session for some time. There is no parallel session's
> work sitting in the tree, and no decision waiting on anybody.

---

## 1. State, in one paragraph

**Stage 6 is complete and committed. The rebuild has no remaining planned feature.** The bot answers
questions, files cases, runs them through a staff workflow, chases the people holding them, deletes
what it promised to delete, reaches 1,800 teachers with an announcement, tells a teacher who covers
their region, and — as of this session — hands out document forms and reads the submissions back.

```
1,140 tests across 64 files · 0 failed · 0 skipped · 219 seconds
typecheck clean · build clean · deps:check clean · lint 0 warnings
79 source files · 64 test files
```

**Every number above was run on 31 July 2026 against the tree as committed.** `npm run lint`
reporting nothing is a first for this project.

**Then the runbook was audited against the code, in both directions**, and that found six things —
one of which was a missing command rather than a missing paragraph. `docs/plans/2026-07-31-runbook-code-audit.md`
is the record. §6 has the one worth carrying.

**What is left is not engineering.** §9 has it: two questions for MoPSE, a launch checklist that is
all people rather than code, and a list of things somebody has to type in.

## 2. Commits, oldest first

Stages 3 to 5 are not re-listed; `git log --oneline d743d72..6ff0ac0` has them.

| Commit | What |
|---|---|
| `6ff0ac0` | End of Stage 5 — every document that stage made wrong |
| `d45b0ae` `7e7c90b` | Documentation: the review-phase plan, and this handoff corrected |
| `286c778` | **The review phase**, committed with the four decisions it was waiting on |
| `fd15e14` | **`fix:` a duplicate check that could never fire**, in two places. §6 |
| `5315f08` | `fix:` the three cosmetic lint findings |
| `ed16807` | **Stage 6 — documents.** Tasks 72–82 |
| `600ed48` `c105f6d` `333646a` | Documentation: this handoff, the third specification document, and two stale version headers |
| `13c6d6f` | **`/staff_region`** — a command the runbook promised and nobody had built. §6 |
| `a836167` | **The runbook↔code audit** and the five documentation faults it found |

**Each of the two `fix:` commits was checked out into a scratch worktree and typechecked and
`deps:check`ed on its own**, rather than only the tip being verified. That is what §10 asks for.

## 3. The answers that decide what got built

Everything from Stages 4 and 5 is settled and recorded in those plans. **Do not reopen them and do
not improve them.** In short: `Observer` is the look-but-do-not-touch rank and `Regional` is `Lead`;
eight case statuses, four of which staff type; `Action required` means the **teacher** must act;
retention is three *settings*, not constants; the word is **region**, never province, and there is no
concept of a district; an empty `regions` array means **every** region, deliberately.

**Four more were answered on 31 July, before any Stage 6 code was written.** All four are in that
stage's plan with their costs:

- **Every form's responses are linked into the one spreadsheet the bot already reads.** The bot holds
  Viewer on exactly one document and that is not widening.
- **A teacher on the roster who has never opened the bot gets staff told, by name, and no case.**
  `cases.teacher_chat_id` is a non-null foreign key; there is nothing to file against. **This is its
  own message, deliberately not the one that says the address is unknown — we know exactly who they
  are, which is why a person can act.**
- **A submission creates a case.** Accepted cost: `Submit Documents` cases appear in `/cases`, the
  digest, `/export` and the retention rules like any other.
- **The submission markers are purged with their case** — and the mechanism I first proposed for that
  was wrong. §5 has it.

## 4. What is built, and the things that will bite

### The parts most likely to be misread

**A form response is an EVENT, and it is the only one in this system.** Every other sync is a
*record*: upsert on a natural key, deactivate what the sheet no longer shows, run twice and nothing
changes. Google keeps row 42 of a responses tab for ever and the bot rereads the whole tab every ten
minutes. **`form_submissions` is the only thing between that and a case every ten minutes, for ever.**

**The marker is anonymised, never deleted (D44).** Purging it would make the response row look new on
the next sync. `case_reference` is `ON DELETE SET NULL`, the nightly job clears the email, and what
survives — `("PASSPORT", 42, Filed)` — identifies nobody.

**The row number is the identity.** Deleting a row from a responses tab shifts every row below it up
by one and the bot refiles all of them. `RUNBOOK.md` §4.18 says so in a box.

**`processedRows` reads one query per form, not one per row.** A responses tab only grows, so in
steady state every row in it is already handled; a per-row check would be 1,800 queries every ten
minutes per form inside a `concurrency: 1` worker. That is the starvation that shows up as a *false*
heartbeat alarm saying the sync has stopped.

**Three spreadsheet values are refused rather than guessed at**, each reported with its row or tab:
a `TYPE` holding a colon or overflowing the 64-byte payload; a `URL` that is not `https` or is not a
web address; and a responses tab with anything other than **exactly one** column mentioning "email".
**All three would otherwise fail far from their cause** — and the URL one is the worst, because the
forms list is *one message carrying every button*, so Telegram refusing it takes the list from every
teacher rather than from one row.

**`telegram/callback-data.ts` is a layer-1 leaf**, like `telegram/send.ts`. The sheet parser imports
it so a bad `TYPE` is rejected at parse time instead of throwing at render time.

### Still true from earlier stages

**`privacyNotice` renders the periods. Never type a number of days into `privacy.ts`** — a test reads
that module's source and fails if you do. **`requiresReconsent` is asymmetric on purpose; do not
replace it with a hash.** **Every purge returns 0 when its period is `null`** (D30). **The purge reads
`importance`, never `status`.** **The chase counters reset inside `updateCase`.** **The digest and the
chase are one job and the chase runs second.** **A failed chase does not advance the counter.**
**The sweeper takes one batch of 200 and returns** — no pacing loop; a long run starves the sync and
the heartbeat. **`resetStalledRecipients` runs only when nothing was claimable, at 60 minutes** — a
duplicate to 1,800 people is the one failure a broadcast must not have.

## 5. Deliberate departures from the Stage 6 plan

Twelve, each explained at the site, plus the correction below. **Do not revert them.** The stage's own
plan lists all of them; the ones a reader will trip over:

1. **D44 — the marker is anonymised, not deleted.** The option as I put it to the head of project was
   faulty: purging markers with their case would have made Google's row look new on the very next
   sync and refiled it for ever. The decision was honoured; only the mechanism changed.
2. **Exactly one responses column may contain "email"** — asked for directly, and better than the
   plan's "first match wins". Two columns would mean guessing between a teacher's address and their
   supervisor's, and filing documents under the wrong person is a silent, plausible, wrong answer.
   Letters are compared without punctuation, so "E-mail" matches.
3. **A note is added on every filed submission.** `createCase` returns an existing open case in the
   same category within 24 hours rather than opening a second — right, since three forms in a morning
   is one piece of work — but without the note the later submissions would be invisible.
4. **The response sync runs sequentially, after the link sync.** It reads `form_links` to learn which
   tabs to open.
5. **An inactive form's responses are still read.** The one place the active flag is ignored: a form
   switched off this morning may still have last night's submissions.
6. **The forms list uses callback buttons, not `url` buttons.** One extra tap buys a re-read of the
   active flag at the moment of tapping.

## 6. Faults found by building — and one found by the suite failing

**Three in Stage 6's own code, before anything ran:** the faulty Q4 option above; a `TYPE` cell that
would crash the forms list for every teacher; and a `URL` cell that would do the same, worse. **One
found in my own new code before committing:** `alreadyProcessed` issuing one query per response row.

### ⚠️ The "known intermittent" test was a real bug. Two of them.

**Delete the belief that `staff/repository.integration.test.ts → reports a duplicate as a duplicate
when two callers race` is flaky.** Previous revisions of this document said so. It is not.

```
depth 0: DrizzleQueryError   code = undefined   ← what the code read
depth 1: DatabaseError       code = 23505       ← where it actually is
```

Drizzle wraps the driver's error, so `(err as { code?: string }).code === '23505'` read `undefined`
**every time and had never once fired.** It looked intermittent because `addStaff` pre-checks for an
existing row: when the race timing let that check see the winner's committed row the test passed.
Only when the *insert* lost the race — the path the conversion exists for — did the raw error escape,
into `bot.catch`, which acknowledges the update and says nothing.

**The same pattern was in `cases/urgent.ts`'s collision retry**, where the comment already spelled out
the cost. That retry could not retry.

Both now use `src/db/errors.ts`, which walks the `cause` chain. **The new tests are deterministic on
purpose** — the race test let this through twice and was written off both times.

> **The lesson, and it generalises.** A test that passes *most* runs is not flaky until proven
> otherwise; it is evidence that the path it covers is only sometimes reached. Ask which path, and
> whether it has ever worked.

### ⚠️ A documentation audit found a code defect. Do the audit in both directions.

`/staff_region` was named by `RUNBOOK.md` §2.6 and **had never been built.** `staff.regions` was
written by `addStaff` and by nothing else, so a staff member's coverage could be set once, at
creation, and never changed — while the same section says regions are entered **after launch, on
purpose.** The documented plan could not be carried out.

**It had no symptom, and that is the part to remember.** An empty `regions` array means *every*
region, deliberately. So "regions can never be set" and "regions have not been set yet" look
identical from the outside — no error, no warning, just staff seeing the whole country, which is
what the runbook tells you to expect at that stage.

Built at `13c6d6f` with six integration tests. **The only reason it surfaced is that the audit ran
in both directions**: the runbook named a command, and the command list did not have it.

**Five documentation faults came out of the same pass** and are at `a836167` — the worst being
§4.12, the page whose whole job is saying what happens on its own, still describing the ten-minute
sync as "answers and roster" after Stage 6 added form links and submission reading to it.

## 7. Running anything

The test database is a container **with no volume**. It does not survive a `down` or a Docker
restart, so assume it is not running.

```bash
docker compose -f "D:\Telegram Bot server\docker-compose.test.yml" up -d
docker inspect --format "{{.State.Health.Status}}" mopse-test-postgres-1
```

Then, in PowerShell:

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run
```

**A run reporting hundreds of skips proved nothing.** A real run reports **0 skipped**. The suite
takes about four minutes — run it in the background, redirected to a file.

### ⚠️ Kill stray `vitest` processes before you trust anything

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*vitest*' }
```

This cost a session an hour once. **Never pipe `vitest` through `head`** — it closes the pipe, the
shell returns, and the run keeps going. **Never start a second run while one is going.**

**Docker Desktop can be *paused*.** A run then hangs with no output. `docker desktop status`; only
the tray icon or Dashboard resumes it.

`docker` **is** on the PATH. **Use the git that is already installed** — the Bash tool *is* their Git
Bash.

### ⚠️ knip needs Docker Desktop STOPPED on this machine

```
RangeError: Array buffer allocation failed
```

oxc-parser allocates one large **ArrayBuffer** — external memory, not V8 heap — so the
`--max-old-space-size` flag in the npm scripts **does not fix this**, and an earlier note in
`knip.jsonc` crediting it was wrong. Stopping the test *container* is not enough either; measured
twice. `docker desktop stop`, run knip, `docker desktop start`.

### If you touch the schema

`npx drizzle-kit generate`, then **read the SQL before accepting it** — it has emitted a destructive
`DROP TYPE` here once. Rename the file to the convention and change the `tag` in
`drizzle/meta/_journal.json`. **Stage 6 needed only `0009`**, which adds `form_links` and
`form_submissions` and nothing else.

## 8. What to do next

**There is no next feature, and the runbook has been audited against the code.** What remains is in
rough order of value:

**A first real deploy, and `RUNBOOK.md` Part 3.** This is the recommendation. **Nothing in this
system has ever talked to a real Telegram or a real Google Sheet** — all 1,140 tests use fakes for
both. Every fault this project has found was found by running something, and the one thing never run
is the whole system. Part 3 is fifteen numbered checks. It needs a server, the bot token, the
spreadsheet and the service account, none of which are engineering.

**Prove the backup restores** (`CONCERNS` A5). `deploy/backup.sh` and `deploy/restore-drill.sh`
exist and have never been run against a real server. An untested backup is a belief.

**The resignation route** (decision 9 of `docs/plans/2026-07-29-staff-and-lifecycle-design.md`) is the
one agreed thing never built. `forgetTeacher` is a callable function with its own tests; the
three-month timer is unwritten.

**The `/await` taxonomy** (D26) is unbuilt. The teacher's chase message renders `public_update`
verbatim and **must not parse it**, so a taxonomy changes the chase's *input*, not the chase.

**The content roll-up** was offered and declined. `RUNBOOK.md` §4.7 records it so nobody restores it
by accident.

**Six exports have tests and no production caller**, found by `npm run knip:prod` and recorded in
`docs/plans/2026-07-30-review-phase-findings.md`. **None is a live bug** — checked by hand, and
`isRetained`'s rule and the purge's SQL agree exactly today. **Do not delete them without reading what
their tests cover**; `visibleCaseReferences` has twenty tests exercising the visibility rules that the
production path reaches by another route.

## 9. Open questions

**None about how the software behaves.** Fifteen have been answered across the project.

**Whether the privacy notice says the right things — still the sharpest item.** Reviewing it before
the deploy means one round of re-consent; afterwards, two. **Stage 6 did not change the notice**, but
if anybody decides it should mention documents going to Google, that fires the gate at 1,800 people.
Decide before editing, not after.

**Whether sign-in should be reconsidered before launch.** Expires at launch.

**The launch gate is off engineering.** `RUNBOOK.md` §1.4 is the checklist, §2.6 is everything a
person has to type in — **and nothing on that list announces its own absence.** Stage 6 added three
entries to it: the `FORMS` tab, each form's responses being linked, and the word "email" appearing in
exactly one question per form.

## 10. How this project is run

- **The head of project is not an engineer.** Plain English, no jargon; recommend rather than survey;
  correct a wrong premise directly.
- **Do not commit per task.** Work through, offer once at a boundary. **A fix to already-committed
  code gets its own `fix:` commit**, separate from the feature that found it, and **each commit is
  verified on its own** rather than only the tip.
- **Verify before claiming done.** Tests, typecheck, build, lint, with the numbers stated plainly.
  Every fault this project has found was found by *running* something.
- **Make every checker fail on purpose before believing it.** This now applies to tests as much as
  tools: Stage 6's idempotency test was proved by breaking the code it guards.
- **Their answers are decisions, not opening positions.** Raise a concern once, then build what was
  asked and record the cost. **If your own proposal turns out to be faulty, say so plainly and fix
  the mechanism rather than the decision.**
- **Say what you did not do.** A gap named here is cheap; one discovered in November is not.

## 11. Ending a session — the three things that must be current

**1. This document, rewritten in place.** Not patched — rewritten.

> **It is the only document rewritten in place.** Everything else is a record of finished work or a
> description of the running system. A stage's plan goes in **a new document**; the three
> specification documents are corrected **once, at the end of a stage, in one pass**.

**2. The current plan's status block**, with a commit hash against anything finished.

**3. The artifact — `https://claude.ai/code/artifact/64bce4b9-a63e-4dee-a883-9b0ecb457b53`.**

> **It is the head of project's document, not an input to this one.** Do not read it to get up to
> speed. It flows one way — from what was built, to them.

Update it **in place** by passing that URL as `url`. Never mint a new one; favicon 🤖, keep it.
`WebFetch` it, strip the frame wrapper, **edit the remainder rather than rewriting it**, bump the
version in four places (sidebar, masthead eyebrow, footer "Version N", footer prose), update the
metrics row, and republish with `url` set.

What belongs in it, in their words: what a person can now *do*; anything that changes what a teacher
sees; every fault found, including in already-committed code; anything that cost more than the plan
said; and what is still waiting on MoPSE. What does not: file names, function names, task numbers as
the subject of a sentence, or any figure nobody ran.
