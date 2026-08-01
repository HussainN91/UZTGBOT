# Handoff — 1 August 2026

**This document is rewritten in place at the end of every session. There is one of it, and it is
current. If you are reading a copy of this content anywhere else, that copy is stale.**

Read this in full, then read **`docs/plans/2026-08-01-identity-and-urgent-design.md`** — the
programme plan, which is the plan of record and carries the ordered list of what remains.

> **The filename still says stage 4.** Historical and deliberate: there is one handoff, it is this
> file, and it is rewritten in place whatever is current.

> ### ✅ The working tree is CLEAN. Everything is committed.
>
> No parallel session's work is sitting in the tree and no decision is waiting on anybody before
> code can be written. Four decisions are waiting on the head of project before *specific* things
> can be built — §9 lists them, and none of them blocks starting.

---

## 1. State, in one paragraph

**Feature B — the urgent-priority gate — is built and committed.** The rebuild's six numbered stages
were already complete; this was the first feature from the post-rebuild programme plan. It replaced
the one-time urgent code with a request-and-confirm gate: a teacher asks for priority with nothing in
their way, and a regional coordinator decides afterwards. It also carried the shared
regional-recipient lookup that Feature A will need.

```
1,147 tests across 65 files · 0 failed · 0 skipped · ~220 seconds
typecheck clean · build clean · deps:check clean · lint 0 warnings
80 source files · 66 test files
```

**Every number above was run on 1 August 2026 against the tree as committed.**

**Two of the head of project's decisions reshaped the feature mid-build**, and both reached further
than they first appear — §3.

### The session of 1 August, second half: Part 5F designed, not built

**No code was written and no test was run in that session.** It was stopped at the design boundary
on purpose, before implementation, because the context budget was running out and the head of
project asked for a clean pause rather than an abrupt one.

What it produced is **`docs/plans/2026-08-01-login-gating-design.md`** — the approved design for
Part 5F, the login-gating hole. **Read it before writing a line of that part.** Two decisions of the
head of project are recorded in it and both are binding: an unsigned chat sees only the buttons that
work without an account, and the menu says in words what signing in unlocks.

The design also found something the plan of record gets wrong. The plan says *"the only change is
what `/start` returns for an unsigned chat."* That is not enough — the Home button renders the menu
through a different path, so building only `/start` would show the reduced menu once and the full
menu ever after. §4 of the design has the seven places that render it.

> **This handoff was edited rather than rewritten**, against the rule in §11, for the same budget
> reason. Everything in it is current; it simply was not retyped.

## 2. Commits, oldest first

| Hash | What |
|---|---|
| `cb1e0c2` | The state at the start of this session |
| `90827f8` | `feat: priority requests, decided by a person rather than a code` |
| `5111d91` | `docs: the handoff, the plan, and the two documents Feature B changed` |
| *(the commit carrying this document)* | `docs: the approved design for the login-gating hole` |

Everything before `cb1e0c2` is the six-stage rebuild and the deployment work; the previous version
of this handoff listed those and they have not changed.

## 3. The two decisions that reshaped this feature

Both came from the head of project mid-build. Both are binding. Both cost more than they look.

### "Urgent case doesn't mean emergency, urgent case means highly prioritized"

This answered open question 2 of the plan **in the negative** — the acknowledgement names no
emergency contact, because the bot is not a crisis line.

**It did not stop at one message.** The entire feature had been written in a crisis-line voice:
*"describe the emergency"*, *"if your situation gets worse before anyone reaches you"*, and a 🚨
siren on the menu button. All of it was rewritten. **The menu button now reads ⏫ Ask for Priority.**

The reasoning worth preserving: a siren invites a teacher to decide whether their situation is an
emergency, which is both the wrong question and one this system cannot answer.

### "Drop the code route entirely"

The plan had assumed codes would survive "for the phone route". They did not. Removed: the code
generator, `issueUrgentCode`, `checkUrgentCode`, `consumeUrgentCode`, `checkStrandedUrgentCodes`,
`/generate_urgent_code`, the `AwaitingUrgentCode` state, six constants, the heartbeat's stranded-code
check, and the redaction rule for a typed code.

**Two removals matter more than the rest, and both were quietly dangerous:**

- **`createCase` lost its `escalate` flag.** It filed a case at `Escalated`/`Urgent` in the opening
  insert. Nothing can now open a case above `Normal`.
- **`appendUrgentFollowUp` is gone.** It appended a teacher's later words to a case **and escalated
  it in the same statement**. That was correct when a spent code had bought the escalation. It is
  now precisely the thing that must not happen — an appending write that raised importance would
  grant the very thing it is asking a coordinator to decide. `urgent.ts` has a non-escalating
  `appendUrgentRequest` instead.

## 4. What is built, and the things that will bite

### The one property everything turns on

**A pending request is `Normal`, never `Urgent`.** Retention keys off `importance` — 180 days for
urgent and critical, 7 for ordinary — so a request that stamped the marker on the way in would let
anybody grant themselves six months of retention by tapping a button, **and the symptom would be
invisible for six months.** `importance` is raised in exactly one place, `confirmUrgentRequest`.

If you change anything on this path, the assertion to keep green is in
`src/cases/urgent.integration.test.ts`, "files a new case at Normal and stamps the request".

### The parts most likely to be misread

- **`RETURNING` yields post-update values.** `requestUrgentCase` needs to know what the row looked
  like *before* it wrote, so it reads the old values through a sub-select in `FROM`. Written the
  obvious way, "was a request already pending" answers itself every time, because the statement had
  just made it true. `clearUsername` in `staff/repository.ts` records the same trap from Stage 4.
- **`staffCovering` already returns every active System member, unconditionally.** This is the
  System bypass and it is correct. It also means "the query found nobody" can never mean "nobody
  covers this region" — see §6, where that assumption produced a dead branch.
- **`cases/notify.ts` builds an inline keyboard**, which looks like a layer violation and is not.
  `telegram/callback-data.ts` is layer 1 by explicit override in `scripts/dependency-tree.mjs`,
  because it is a pure codec. The keyboard *type* arrives structurally; nothing is imported upward
  at run time. `deps:check` passes.
- **`notifyUrgentRequestOnCase` deduplicates its own two audiences.** A new case has to reach its
  queue (`notifyNewCase`, filtered by category) *and* the region's coordinators (filtered by
  capability, no queue). On a small team those sets overlap almost completely, so the new-case
  notice is dropped for anybody getting the request message — which carries strictly more, including
  the button.
- **The confirm button re-validates on every tap.** Active staff row, then `urgent.issue`, then the
  case resolved through `findCase` so the visibility scope applies, then the case's own state inside
  a single conditional `UPDATE`. A Telegram message sits in a chat for ever and the person tapping
  may have been demoted since.

### Still true from earlier stages

- **`updateCase`, `addNote`, `markImportance`, `setDue`, `setSnooze` do not check who is asking.**
  Every mutation resolves through `findCase` first. `confirmUrgent` in `router.ts` follows the same
  rule and is the template for Part 5G's buttons.
- **`teacherHasAccess` is the gate**, never `verificationState === 'Verified'`.
- **Nothing may let a revoked teacher back in by signing in again.** `bindTeacher` clears
  `revoked_at`. Three places refuse a revoked chat. **Part 5F adds a fourth door — read the warning
  in the plan before touching `/start`.**
- **`visibleToStaff` only works with both joins** — INNER `teachers`, LEFT `roster_entries`.

## 5. Deliberate departures from the plan

1. **The code route was removed entirely**, against Part 3's "codes stay". Head of project's
   decision. §3.
2. **No emergency contact in the acknowledgement**, reversing the plan's own open question 2. Head
   of project's decision. §3.
3. **`/generate_urgent_code` became `/urgent_pending`** rather than gaining a button. The
   capability `urgent.issue` was kept and repointed — it now means "may decide a case jumps the
   queue" rather than "may issue a credential". Renaming the key would have meant migrating every
   audit row for nothing.
4. **The plan's "2 callback prefixes" became one.** The second was for the generate-code button,
   which no longer exists.
5. **`urgent_codes` and `urgent_code_attempts` were left in the database.** Declared in
   `schema.ts`, read and written by nothing. **This is an open decision** — §9.
6. **A `cases_urgent_pending_idx` was added**, not in the plan. It serves the "what has nobody
   decided" query, which is the only thing standing between a forgotten request and silence, given
   the plan's deliberate refusal to auto-escalate.

## 6. Faults found by building

### ⚠️ A System fallback that could never fire

`regionalRecipients` was written as "if nobody covers this region, go and fetch the System members".
**That branch was unreachable.** `staffCovering` already returns every active System member
unconditionally, so an empty result meant there were no System members either — and the fallback
would have fetched nothing. The reported flag was structurally always `false`.

**A test written for the fallback is what found it**, before it ever ran in production. The fix
changes the question from "did we have to fall back" to "is System the *only* reason anybody is
being told", which is what a coordinator actually needs to read: it means nobody covers their region.

The lesson is the project's existing one — **make every checker fail on purpose before believing
it** — applied to a code path rather than a tool.

### Four stale assertions, each of which was the test being right

Four tests failed on the first full run and every one of them was correct to fail: they asserted the
old wording, the old maintenance note, and `Normal/New` where the case is legitimately
`Normal/Received` because notification had reached its queue. Recorded because "the test is wrong"
is the wrong first thought.

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
takes about four minutes.

### ⚠️ Docker Desktop was not running at the start of this session

`docker desktop status` failed outright; `docker desktop start` fixed it and took about 25 seconds,
then the compose file brought the database up healthy in another 12. Budget a minute before the
first test run. Docker Desktop can also be **paused**, in which case a run hangs with no output at
all and only the tray icon or Dashboard resumes it.

### ⚠️ Kill stray `vitest` processes before you trust anything

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*vitest*' }
```

**Never pipe `vitest` through `head`** — it closes the pipe, the shell returns, and the run keeps
going. **Never start a second run while one is going.** Filtering output with `Select-String` is
safe; `head` is not.

### ⚠️ knip needs Docker Desktop STOPPED on this machine

```
RangeError: Array buffer allocation failed
```

Confirmed again this session: `knip:prod` crashed with exactly this while the test container was up.
oxc-parser allocates one large **ArrayBuffer** — external memory, not V8 heap — so
`--max-old-space-size` does not fix it. `docker desktop stop`, run knip, `docker desktop start`.

`docker` **is** on the PATH. **Use the git that is already installed** — the Bash tool *is* their
Git Bash.

### If you touch the schema

`npx drizzle-kit generate`, then **read the SQL before accepting it** — it has emitted a destructive
`DROP TYPE` here once. Rename the file to the convention and change the `tag` in
`drizzle/meta/_journal.json`. This session produced **`0010_urgent_request_gate.sql`**: three
nullable columns on `cases` and one index. Purely additive, so a code rollback works against it.

## 8. What to do next

**`docs/plans/2026-08-01-identity-and-urgent-design.md` carries the ordered list** and it is the plan
of record. In short:

1. **The operational launch blockers.** Hours, not code, and they gate everything: revoke the test
   bot token, confirm the sheet is not publicly editable, move `OPS_ALERT_CHAT_ID` to a group, set
   up and *drill* backups, confirm Uzbekistan hosting. **Untouched.**
2. **Part 5F — the login-gating hole. ✅ Designed, ⬜ not built.** Half a day of building, and it is
   a live defect: a brand-new teacher cannot reach the FAQ, which is deliberately open to everybody,
   because `/start` hands them a sign-in prompt with no way past. **The design is settled and
   approved — `docs/plans/2026-08-01-login-gating-design.md`. Start there; do not redesign it.**
   Its §7 is the list of what has to be proved, and §5 is the one thing in it I decided rather than
   asked, which the head of project may still want to overturn.
3. **Part 5G — buttons on case lists.** A day and a half, directly requested, and newly cheap
   because Feature B built the staff-callback machinery. Copy `confirmUrgent` in `router.ts`.
4. **Feature A — identity disputes.** 3.5 days. Uses `staffCovering`/`regionalRecipients` unchanged.
5. **Feature C**, then **Feature E**, which needs its own spec.

## 9. Open questions

**None about how the software behaves.** Four are waiting on the head of project, and none blocks
starting work:

1. **Whether to drop `urgent_codes` and `urgent_code_attempts`.** Nothing reads or writes them.
2. **Whether staff case lists may show teacher names.** Part 5G needs this. Their name is not their
   words and it is the reader's own queue, but it puts personal data into more scrollbacks.
3. **Whether the case list shows the submitted date, the age, or both.** A date says when; an age is
   what makes somebody act.
4. **The privacy notice** — still the sharpest item, and unchanged by this session. Reviewing it
   before the deploy means one round of re-consent; afterwards, two.

**The launch gate is off engineering.** `RUNBOOK.md` §1.4 is the checklist and nothing on it
announces its own absence.

## 10. How this project is run

- **The head of project is not an engineer.** Plain English, no jargon; recommend rather than survey;
  correct a wrong premise directly. **They asked this session for less compression, not more** —
  "sometimes you compact meanings too much". Prefer a longer clear sentence to a dense one.
- **Do not commit per task.** Work through, offer once at a boundary. **A fix to already-committed
  code gets its own `fix:` commit**, and **each commit is verified on its own**.
- **Verify before claiming done.** Tests, typecheck, build, lint, deps, with the numbers stated
  plainly. Every fault this project has found was found by *running* something.
- **Make every checker fail on purpose before believing it.** §6 is this session's instance.
- **Their answers are decisions, not opening positions.** Raise a concern once, then build what was
  asked and record the cost.
- **Say what you did not do.** This session built one of the plan's two features and did not say so
  until asked. A gap named early is cheap.
- **Which skills to invoke** is now written down — Part 8 of the plan. Nothing needs downloading.

## 11. Ending a session — the three things that must be current

**1. This document, rewritten in place.** Not patched — rewritten.

> **It is the only document rewritten in place.** Everything else is a record of finished work or a
> description of the running system. A new piece of work goes in **a new document**; the
> specification documents are corrected **once, at the end, in one pass**.

**2. The current plan's status block**, with a commit hash against anything finished.

**3. The artifact — `https://claude.ai/code/artifact/64bce4b9-a63e-4dee-a883-9b0ecb457b53`.**

> **It is the head of project's document, not an input to this one.** Do not read it to get up to
> speed. It flows one way — from what was built, to them.
>
> **It is at v9 and covers Stage 4. It is now badly stale** — stages 5 and 6, the deployment, and
> this session are all missing from it. Ask before spending a session's remaining budget on it.

Update it **in place** by passing that URL as `url`. Never mint a new one; favicon 🤖, keep it.
`WebFetch` it, strip the frame wrapper, **edit the remainder rather than rewriting it**, bump the
version in four places (sidebar, masthead eyebrow, footer "Version N", footer prose), update the
metrics row, and republish with `url` set.

What belongs in it, in their words: what a person can now *do*; anything that changes what a teacher
sees; every fault found, including in already-committed code; anything that cost more than the plan
said; and what is still waiting on MoPSE. What does not: file names, function names, task numbers as
the subject of a sentence, or any figure nobody ran.
