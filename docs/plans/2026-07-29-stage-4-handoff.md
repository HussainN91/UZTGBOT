# Handoff — 1 August 2026

**This document is rewritten in place at the end of every session. There is one of it, and it is
current. If you are reading a copy of this content anywhere else, that copy is stale.**

Read this in full, then read **`docs/plans/2026-08-01-identity-and-urgent-design.md`** — the
programme plan, which is the plan of record and carries the ordered list of what remains.

> **The filename still says stage 4.** Historical and deliberate: there is one handoff, it is this
> file, and it is rewritten in place whatever is current.

> ### ✅ The working tree is CLEAN. Everything is committed.
>
> No decision is waiting on anybody before code can be written. Four decisions are waiting on the
> head of project before *specific* things can be built — §9 lists them, and none of them blocks
> starting.

---

## 1. State, in one paragraph

**Two pieces of the post-rebuild programme are now built: Feature B, the urgent-priority gate, and
Part 5F, the login-gating hole.** The rebuild's six numbered stages were already complete before
either. Feature B replaced the one-time urgent code with a request-and-confirm gate and carried the
shared regional-recipient lookup that Feature A will need. Part 5F opened the front door: `/start`
now shows a menu to everybody instead of holding a stranger at a sign-in prompt.

```
1,164 tests across 65 files · 0 failed · 0 skipped · ~288 seconds
typecheck clean · build clean · lint 0 warnings · deps zero cycles, zero layer violations
80 source files · 65 test files
```

**Every number above was run on 1 August 2026 against the tree as committed.**

## 2. Commits, oldest first

| Hash | What |
|---|---|
| `cb1e0c2` | The state at the start of the day |
| `90827f8` | `feat: priority requests, decided by a person rather than a code` |
| `5111d91` | `docs: the handoff, the plan, and the two documents Feature B changed` |
| `7fcae07` | `docs: the approved design for the login-gating hole` |
| `c0d0b74` | `feat: the front door opens for everybody, not only for teachers we know` |
| *(the commit carrying this document)* | `docs: the handoff, the plan, and the three documents Part 5F changed` |

Everything before `cb1e0c2` is the six-stage rebuild and the deployment work.

## 3. Part 5F — the front door, built to its own design document

**`docs/plans/2026-08-01-login-gating-design.md` is the design, and it is worth reading before you
touch any of this.** It records why the answers are what they are.

### What changed for a teacher

`/start` used to reply with the privacy notice and *"reply with the email address you were recruited
with"*, and hold the chat in `AwaitingIdentifier`. The answer bank is deliberately open to
everybody — most of all to somebody who *cannot* sign in and needs an answer — and no new teacher
could reach it. **A door that is open and unreachable is closed.**

`/start` now opens the menu.

### The two decisions of the head of project, both binding

1. **The reduced menu, not the full one.** An unsigned chat sees the FAQ shortcuts, All FAQ topics,
   Who covers my region?, and a Sign in button. Check My Case, Submit Documents, Contact Support and
   Ask for Priority are **hidden until they sign in**. The alternative — the whole menu with a Sign
   in button added — was put to them and not chosen.
2. **The menu says what signing in unlocks.** *"You can read the answers below without signing in.
   Sign in to report a problem, ask for priority, send documents, or check a case you have already
   sent."* Their reasoning: a recruited teacher arrives expecting to be able to report a problem,
   and a short menu with no explanation makes the bot look like it only answers questions.

**That text is new and is a draft as far as MoPSE is concerned**, like Feature B's nine messages.

## 4. The parts of 5F most likely to be misread

### The menu has three forms, and the third one is load-bearing

**"Not signed in" is two different people.** Somebody brand new should be invited to sign in.
Somebody whose access a staff member has ended must **not** be, because `bindTeacher` clears
`revoked_at` — so the invitation is a route by which a revoked teacher undoes a staff decision by
typing an email address, silently. `menuAccessFor` in `router.ts` returns `signedIn`,
`signInOffered` or `accessEnded`, and it is the **one place** that rule lives.

**There are two ways to have lost access and only one of them is `Revoked`.** A teacher whose roster
row was deactivated keeps `verificationState = 'Verified'` and fails on the roster flag. A test for
`Revoked` alone hands that teacher the prompt.

### The Sign in button is a fourth door, and it is the same door

Sign-in is reachable from `/start`, from `requireSignIn`, from `verifyIdentifier`, and now from the
button. The button routes **through `requireSignIn` itself** rather than through a fourth copy of the
rule. Four doors sharing one expression of a rule cannot drift apart; four copies eventually will,
and the copy that drifts is the one nobody was looking at.

**The test taps the button rather than checking the button is absent** —
`revoke.integration.test.ts`, "does not let the Sign in button fake one either". A revoked teacher is
not shown it, and yesterday's menu is still in their scrollback with every button in it still live.

### Hiding a button is never the gate

All four gated actions are still refused on tap by `requireSignIn`. The hiding is on top of the gate,
not instead of it, for the same reason.

### Nine places draw the main menu

`mainMenuReply` and `mainMenuKeyboard` stay pure and keep the property that the menu is the one thing
in the bot that cannot itself fail. **The parameter is required, with no default.** That is what
found the design's one real error — see §6.

### Still true from earlier stages

- **`updateCase`, `addNote`, `markImportance`, `setDue`, `setSnooze` do not check who is asking.**
  Every mutation resolves through `findCase` first. `confirmUrgent` in `router.ts` is the template
  for Part 5G's buttons.
- **`teacherHasAccess` is the gate**, never `verificationState === 'Verified'`.
- **`visibleToStaff` only works with both joins** — INNER `teachers`, LEFT `roster_entries`.
- **A pending priority request is `Normal`, never `Urgent`.** Retention keys off `importance` — 180
  days against 7 — so a request that stamped the marker on the way in would let anybody grant
  themselves six months of retention by tapping a button, **and the symptom would be invisible for
  six months.** `confirmUrgentRequest` is the only place importance is raised. The assertion to keep
  green is in `src/cases/urgent.integration.test.ts`, "files a new case at Normal and stamps the
  request".
- **`RETURNING` yields post-update values.** `requestUrgentCase` reads the old row through a
  sub-select in `FROM`, because written the obvious way "was a request already pending" answers
  itself every time. `clearUsername` in `staff/repository.ts` records the same trap.
- **`staffCovering` already returns every active System member, unconditionally.** So "the query
  found nobody" can never mean "nobody covers this region" — that assumption produced a dead branch
  once already.
- **`cases/notify.ts` builds an inline keyboard**, which looks like a layer violation and is not.
  `telegram/callback-data.ts` is layer 1 by explicit override in `scripts/dependency-tree.mjs`.

## 5. Deliberate departures from the plan

### Part 5F

1. **The plan said the only change was what `/start` returns. It was wrong** — nine places draw the
   menu. Struck through in the plan with the correction against it, not deleted.
2. **`handlers/faq.ts` carries the access answer too**, which the design did not anticipate. Three
   exported functions gained a parameter.
3. **The Contact Support button under FAQ answers was left where it is**, visible to unsigned chats.
   Decided by the builder, not asked — reasoning in §5 of the design document, and **the head of
   project may still overturn it.** It is roughly two hours to hide it.

### Feature B, unchanged from before

4. The code route was removed entirely, against the plan's "codes stay". Head of project's decision.
5. No emergency contact in the acknowledgement, reversing the plan's own open question 2. Head of
   project's decision. **"Urgent" means high priority, not emergency. The bot is not a crisis line.**
6. `/generate_urgent_code` became `/urgent_pending`. The capability `urgent.issue` was kept and
   repointed rather than renamed, because renaming would have meant migrating every audit row.
7. `urgent_codes` and `urgent_code_attempts` were left in the database, read and written by nothing.
   **Open decision** — §9.
8. A `cases_urgent_pending_idx` was added, not in the plan.

## 6. Faults found by building

### ⚠️ The reduced menu would have lasted exactly one tap

The design listed seven places that draw the main menu, all in `router.ts`. **There are nine**, and
the two it missed are in `handlers/faq.ts`: a topic button whose topic no longer exists, and an
answer withdrawn since its button was drawn. Both are ordinary rather than exceptional, and both are
reached by chats that have never signed in, because browsing is open to everybody. A new teacher who
tapped a stale FAQ button would have been handed the full menu.

**What found it was the compiler, because the parameter has no default.** "Where else is this drawn?"
stopped being a question somebody had to remember to ask and became one the build could not proceed
without answering. That is the project's existing lesson — *make every checker fail on purpose before
believing it* — arriving from the other direction: make the wrong thing impossible to write, and it
reports itself.

### Four test files changed where one was expected

`/start` no longer signs anybody in, so every test that reached a signed-in teacher through it needed
the Sign in tap inserted. Not a fault — it is the change being real.

### From Feature B, still worth knowing

**A System fallback that could never fire.** `regionalRecipients` was written as "if nobody covers
this region, fetch the System members". That branch was unreachable, because `staffCovering` already
returns every active System member. **A test written for the fallback is what found it**, before it
ever ran in production.

## 7. Running anything

The test database is a container **with no volume**. It does not survive a `down` or a Docker
restart, so assume it is not running.

```bash
docker desktop start && docker compose -f docker-compose.test.yml up -d && docker inspect --format "{{.State.Health.Status}}" mopse-test-postgres-1
```

Then, in PowerShell:

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run
```

**A run reporting hundreds of skips proved nothing.** A real run reports **0 skipped**. The suite
takes about five minutes.

### ⚠️ Docker Desktop was stopped at the start of this session, again

`docker desktop status` reported `stopped`; `docker desktop start` fixed it, and the compose file
brought the database up healthy about twelve seconds later. Budget a minute before the first run.
Docker Desktop can also be **paused**, in which case a run hangs with no output at all.

### ⚠️ Kill stray `vitest` processes before you trust anything

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*vitest*' }
```

**Never pipe `vitest` through `head`** — it closes the pipe, the shell returns, and the run keeps
going. **Never start a second run while one is going.** Filtering with `Select-String` is safe.

### ⚠️ knip needs Docker Desktop STOPPED on this machine

```
RangeError: Array buffer allocation failed
```

oxc-parser allocates one large **ArrayBuffer** — external memory, not V8 heap — so
`--max-old-space-size` does not fix it. `docker desktop stop`, run knip, `docker desktop start`.

`docker` **is** on the PATH. **Use the git that is already installed** — the Bash tool *is* their
Git Bash.

### If you touch the schema

`npx drizzle-kit generate`, then **read the SQL before accepting it** — it has emitted a destructive
`DROP TYPE` here once. Rename the file to the convention and change the `tag` in
`drizzle/meta/_journal.json`. The most recent is **`0010_urgent_request_gate.sql`**. **Part 5F needed
no migration at all.**

## 8. What to do next

**`docs/plans/2026-08-01-identity-and-urgent-design.md` carries the ordered list.** In short:

1. **The operational launch blockers.** Hours, not code, and they gate everything: revoke the test
   bot token, confirm the sheet is not publicly editable, move `OPS_ALERT_CHAT_ID` to a group, set
   up and *drill* backups, confirm Uzbekistan hosting. **Untouched.**
2. **Part 5G — buttons on case lists.** A day and a half, directly requested, and cheap because
   Feature B built the staff-callback machinery. **Copy `confirmUrgent` in `router.ts`.** Two of its
   design questions are in §9 below and should be asked before building. The plan says to run
   `superpowers:brainstorming` first, as Part 5F did, and that worked well.
3. **Feature A — identity disputes.** 3.5 days. Uses `staffCovering`/`regionalRecipients` unchanged.
4. **Feature C**, then **Feature E**, which needs its own spec.

## 9. Open questions

**None about how the software behaves.** Five are waiting on the head of project, and none blocks
starting work:

1. **The privacy notice** — the sharpest item. Reviewing it before the deploy means one round of
   re-consent; afterwards, two.
2. **Whether staff case lists may show teacher names.** Part 5G needs this.
3. **Whether a case-list row shows the submitted date, the age, or both.** A date says when; an age
   is what makes somebody act.
4. **Whether to drop `urgent_codes` and `urgent_code_attempts`.** Nothing reads or writes them.
5. **Whether the Contact Support button under FAQ answers should be hidden from unsigned chats**,
   as the menu's four gated buttons now are. **This one was decided by the builder rather than
   asked** — §5 of the login-gating design has the reasoning. Roughly two hours to change.

**The launch gate is off engineering.** `RUNBOOK.md` §1.4 is the checklist and nothing on it
announces its own absence.

## 10. How this project is run

- **The head of project is not an engineer.** Plain English, no jargon; recommend rather than survey;
  correct a wrong premise directly. **They asked for less compression, not more** — "sometimes you
  compact meanings too much". Prefer a longer clear sentence to a dense one.
- **They will stop a session deliberately rather than let it run out.** That happened on 1 August,
  between designing 5F and building it, and it worked: the design was committed, the tree was left
  clean, and the next sitting started from disk. **Pause at a boundary and commit; do not trail off.**
- **Do not commit per task.** Work through, offer once at a boundary. **A fix to already-committed
  code gets its own `fix:` commit**, and **each commit is verified on its own**.
- **Verify before claiming done.** Tests, typecheck, build, lint, deps, with the numbers stated
  plainly. Every fault this project has found was found by *running* something — or, in 5F's case,
  by making the wrong thing impossible to write.
- **Their answers are decisions, not opening positions.** Raise a concern once, then build what was
  asked and record the cost.
- **Say what you did not do**, and say which choices you made without asking. §5 and §9.5 are this
  session's instance.
- **Which skills to invoke** is written down — Part 8 of the plan. Nothing needs downloading.

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
> **It is at v9 and covers Stage 4. It is now badly stale** — stages 5 and 6, the deployment,
> Feature B and Part 5F are all missing from it. Ask before spending a session's remaining budget
> on it.

Update it **in place** by passing that URL as `url`. Never mint a new one; favicon 🤖, keep it.
`WebFetch` it, strip the frame wrapper, **edit the remainder rather than rewriting it**, bump the
version in four places (sidebar, masthead eyebrow, footer "Version N", footer prose), update the
metrics row, and republish with `url` set.

What belongs in it, in their words: what a person can now *do*; anything that changes what a teacher
sees; every fault found, including in already-committed code; anything that cost more than the plan
said; and what is still waiting on MoPSE. What does not: file names, function names, task numbers as
the subject of a sentence, or any figure nobody ran.
