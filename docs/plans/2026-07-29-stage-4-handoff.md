# Stage 4 handoff — 29 July 2026

**This document is rewritten in place at the end of every session. There is one of it, and it is
current. If you are reading a copy of this content anywhere else, that copy is stale.**

Read this in full before touching anything, then read `docs/plans/2026-07-28-stage-4-staff.md`,
which opens with a "Where this stands" table naming every task and its state.

---

## 1. State, in one paragraph

Stage 3 (teachers) shipped as `d743d72`. Stage 4's layers 1 and 2 are complete. **Layer 3 is eight
tasks of nine done: 31, 32, 33, 34, 35, 45 and 46.** All four of the audit faults this stage set out
to close are closed, and **every question that was open is answered** — there is nothing waiting on
the head of project. The working tree is clean, and everything through task 46 is committed — run `git log --oneline -5` for where that is.

```
694 tests, 42 files, none skipped · typecheck clean · build clean · deps:check clean
```

Verify it yourself before trusting it — see §7.

## 2. Commits, most recent last

| Commit | What |
|---|---|
| `31567bb` | Tasks 31 and 32: the dispatcher, the deny path, `/whoami`, and new-case notification |
| `6764e98` | The last three answers, recorded as D26, D27, D28 |
| `5df3f92` | Task 33: the five reading commands, and the status vocabulary collapsed into one list |
| `8f2b84c` | **A fix, not a feature.** A reopened case kept its `closed_at`, and retention would have deleted it |
| `d0f08ba` | Task 34: `/reply` `/await` `/close` `/reopen` `/note` |
| `260f7c1` | Task 35: `/assign` |
| `340966f` | The dependency graph, built rather than installed — see §8 |
| `7514e56` | Docs: why `dependency-cruiser` is waiting on TypeScript, not behind |
| `48f5636` | Task 45: `/region` `/regions` `/mark` `/due` `/snooze` |
| `c9ce8dc` | Task 46: asking the teacher about their region, and **migration `0007`** |

## 3. The three answers given this session, because they change what gets built

All recorded in the plan as **D26**, **D27**, **D28**, with **R16–R18** tracing them.

- **`Action required` means the TEACHER must act.** This was D25's flagged weak joint and it was
  answered the second way. `/await <ref> <what is needed>` writes it, and the text goes to
  `public_update` so the teacher actually receives the request. A taxonomy of action types is
  coming later; until then it is free text, and the runbook has to say so (Task 41).
- **`Closed` therefore needed a writer**, because D28 keeps unresolved cases for ever and removed
  the one D25 had assumed. `/close <ref> unresolved <reason>` is it. **The head of project asked
  specifically for a hand-written reason rather than a list to pick from.** The reason goes to a
  case note, never to the teacher.
- **`/restore <chat_id>` exists**, at the same rank as `/revoke`. Not built yet — it is part of
  Task 36.
- **Retention:** unresolved cases kept indefinitely; resolved ones deleted after **7 days**, or
  **180 days** if `importance` is Urgent or Critical; `messages` after **3 days**; `audit_log`
  never. **The three periods are settings, not constants** — that was their explicit choice after I
  recommended the opposite. Nothing is built for this in Stage 4; it is all Stage 5.

**One correction worth carrying.** I proposed exempting the `ANSWER_HELPFUL`/`ANSWER_UNHELPFUL`
rows from the 3-day rule to save the monthly content review, and was told **"plan supersedes my
choices!"** Three days means three days for every row. The cost is recorded as a cost — Task 41
deletes `RUNBOOK.md` §4.7 rather than leaving an instruction that silently returns nothing — and
the roll-up that would recover the signal is offered as their choice, not written in. **Do not
improve their answers.**

## 4. What is built in layer 3, and the six things that will bite

| Task | Commands | File |
|---|---|---|
| 31 | the dispatcher, the deny path, `/whoami` | `src/telegram/commands/{index,context,staff}.ts` |
| 32 | new-case notification | `src/cases/notify.ts` |
| 33 | `/cases` `/mycases` `/urgent` `/case` `/search` | `src/telegram/commands/cases.ts` |
| 34 | `/reply` `/await` `/close` `/reopen` `/note` | same file |
| 35 | `/assign` | same file |
| 45 | `/mark` `/due` `/snooze` | same file |
| 45 | `/region` `/regions` | `src/telegram/commands/staff.ts` |
| 46 | the teacher's region prompt | `router.ts`, `keyboards.ts`, `handlers/menu.ts` |

**`updateCase` and `addNote` do not check who is asking.** They take a bare reference and write.
Every mutation command resolves through `findCase` first — which applies the scope — in the shared
`resolveCase` helper in `cases.ts`. **A new command that writes to a case and skips this lets a
staff member change a case in a queue they do not hold, and nothing anywhere will notice.** This is
the single most important property in layer 3.

**Every staff answer goes through `reply()` or `replyAndTell()` in `context.ts`, which clamp.**
Telegram rejects a message over 4096 characters; `send` throws, `deliver` catches it and alerts, so
the staff member gets silence and an operator gets woken. `/case` and `/reply` both carry text of
unbounded length. A new command that builds its own `RouterOutcome` loses the guarantee.

**A new command must be registered in `STAFF_COMMANDS`** (`commands/index.ts`) or it is not
recognised at all — and, by D9, an unrecognised word falls through to ordinary teacher handling
rather than erroring. That is deliberate, and it means a forgotten registration fails *silently*.
`STAFF_COMMANDS` is now `[...PEOPLE_COMMANDS, ...CASE_COMMANDS]`, so a command is registered in the
file it lives in and `index.ts` does not have to be edited twice.

**`/whoami` and `/help` still advertise commands that do not exist yet** — `/staff*`, `/revoke`,
`/restore`, `/maintenance`, `/generate_urgent_code`. They render from `CAPABILITY_INTERFACE` in
`context.ts`, which is D7's table and is total over `Capability` on purpose. Tasks 36 and 37 close
what is left. **Do not "fix" this by trimming the table.**

**`teacherHasAccess` answers two questions, not one.** It is the sign-in gate *and* the "can this
teacher still receive what we send" check that `/reply` warns on. A teacher loses the bot two ways —
`/revoke`, and their roster row being deactivated or removed — and only the first is a `Revoked`
state. Never compare against `verificationState` directly.

**The chat lock is the *sender's*.** Two staff acting on one case hold two different locks, so any
read-modify-write on a case races. Every write in layer 3 is a single statement. `resolveCase`'s
read is for permission, not for a value being modified, which is why it is safe.

## 5. Deliberate departures from the plan — twenty-four

Each is explained in a comment at the site. **Do not revert them.** 1–6 are from the first session,
7–12 from tasks 31–32, 13–15 from tasks 33–34, 16–20 from task 45, 21–24 from task 46.

1. `OutgoingMessage.purpose` built early, not at Task 39. Every non-first message must set it.
2. All five case queries return `{ cases, total }`.
3. `staleCases` reads `OVERDUE_DAYS` itself rather than taking it as an argument.
4. `findCase` lives in `queries.ts`, not `service.ts` — it needs the visibility scope.
5. The migration's enum statements are hand-written. If `drizzle-kit generate` re-emits a
   `DROP TYPE`, hand-fix it again; the snapshot in `drizzle/meta/` is correct.
6. `requireSignIn` refuses a revoked teacher rather than prompting — prompting let them undo their
   own revocation, because `bindTeacher` clears `revoked_at`.
7. `routeStaffCommand` takes the conversation state. The denial is logged with it, so a teacher
   mid-case-detail has their words redacted as case detail rather than written to `messages`.
8. `src/telegram/commands/context.ts` exists and is not in the plan's file list — shared vocabulary,
   so command files never value-import the dispatcher that imports them.
9. `helpReply(supportContact, staffSection)` rather than `helpReply(db, chatId, deps)`.
10. `routeStaffCommand` has an optional `commands` registry parameter, so the rank-too-low branch
    could be tested the day it was written.
11. `markCaseReceived` is its own function in `service.ts`, not `updateCase` — it needs
    `AND status = 'New'`, which is what stops an urgent case being demoted out of `Escalated`.
12. New-case notification does **not** fire on the ordinary dedup path and **does** on the urgent
    one. Urgent-plus-deduplicated is the common path, not an edge case.
13. `src/cases/status.ts` exists. The status vocabulary was written out three times and
    `OPEN_CASE_STATUSES` was defined in two files that different code imported.
    `CASE_STATUS_ORDER` in the schema is now the source.
14. `/case` budgets its own output because `send.ts` does not split messages.
15. `updateCase` now **clears** `closed_at` when a case leaves a terminal status. See §6.
16. `/region` refuses **both ends** of a move, not only the destination. Refusing only the
    destination still lets a Samarkand lead pull a teacher *out* of Bukhara, which is the same act
    from the other side. A `null` region is covered by everybody, because D10 already says an
    unknown region hides a case from nobody. Consequence, stated in the refusal text: a
    cross-region move needs somebody covering both.
17. `knownRegions` in `teachers/region.ts` — `/region` refuses a region the system has never seen
    and canonicalises the spelling. A typo would otherwise put a teacher in a province nobody
    covers, routed nowhere, wrong in a way nothing reports.
18. `listRegionFlags` takes a region scope. It is scoped by the region **we currently hold**,
    because where the teacher actually is, is the thing nobody has been told yet.
19. `clearSnooze` in `service.ts`, so `/snooze <ref> clear` exists. `setSnooze` takes a number of
    days and no number means "never mind"; somebody who types `90` meaning `9` otherwise has no
    recovery short of a database session. Same argument D27 made for `/restore`.
20. `parseDueDate` lives in `commands/parse.ts` and imports `TIMEZONE`. `/due` refuses a slashed
    date rather than guessing, and lands on the **end** of the day in Tashkent. `/mark` is at
    `case.mark`, not `case.update` as the plan text said — D7's table is the source.
21. **A second migration in the stage** — `drizzle/0007_region_asked_at.sql`. Task 42 said one
    migration for the whole stage and it could not hold: nothing in the schema could answer "when
    did we last ask", and without that the plan's own test (*does not ask again the next day*) is
    unimplementable. `regionFlaggedAt` does not serve — it means "reported wrong, not yet dealt
    with" and staff clear it. One `ADD COLUMN`, generated by `drizzle-kit`, verified against an
    empty database as well as the incremental path, renamed to match the file convention.
22. **`region_asked_at` is stamped when the question is SHOWN, not answered.** Stamped on answer, a
    teacher who ignores it is asked again on every visit to the menu, which is the nagging D21
    rules out. Both answers therefore need no write of their own for the cadence to work.
23. **The prompt is on `/start` and `MENU:MAIN` only, not on `mainMenuReply()`.** That function is
    reached from a dozen recovery branches and is documented as the one thing that cannot itself
    fail; it is unchanged. `startReply` now returns `{ signedIn, reply }` so the teacher lookup
    happens once and somebody being asked to sign in is not asked anything else on top.
24. **"Still right" clears an outstanding mismatch flag** (`confirmRegion`). A teacher who reported
    a move nobody acted on, and now says the record is correct, has withdrawn the report; leaving
    it raised keeps it on `/regions` as work its author no longer wants done.

## 6. Two faults found by building, both in already-committed code

**A reopened case kept its `closed_at`** (`8f2b84c`). `updateCase` stamped the column on the way
into a terminal status and never on the way out, so a reopened case stayed open carrying an end date
from its previous life. Harmless when written; **not** harmless after D28, because Stage 5's
retention measures its seven days from exactly that column — a reopened case somebody was actively
working would have been deleted a week later, silently. The plan's own test sketch for Task 34 said
"clears nothing when it is reopened", which was right before retention was decided and wrong after.

**The status vocabulary existed three times** (`5df3f92`), with two definitions of
`OPEN_CASE_STATUSES` reached by different importers, agreeing only by luck.

Both are the same lesson the earlier sessions kept learning: **these are found by running things and
by needing to use them, never by reading.**

## 7. Running anything

The test database is a container **with no volume**. It does not survive a `down` or a Docker
restart.

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

**A run reporting ~183 skipped tests means the database is down**, not that the tests are fine. A
skipped test is not a passing test.

**New this session, and it cost a detour: Docker Desktop can be *paused*.** A run then hangs with no
output at all. Check with `docker desktop status` — if it says `paused`, **`docker desktop start`
does NOT unpause it** (it reports "already running"). Only the tray icon or the Dashboard does, and
`docker desktop restart` would tear down the test database with everything else. Ask the head of
project to click Resume.

`docker` **is** on the PATH. Do not call it through `wsl`; that distro refuses.

**Use the git that is already installed.** The Bash tool in this environment *is* their Git Bash —
`which git` gives `/mingw64/bin/git`. Never install another, and never suggest a GUI step for
something the CLI does.

## 8. What to do next

**Task 36 — staff management: `/staff` `/staff_add` `/staff_role` `/staff_remove` `/revoke`
`/restore`.** The last task in layer 3.

Build order from here, unchanged from the plan:

```
36 · 37 · 38 · 39(partly done) · 41
```

Things already argued, so do not re-derive them:

- **Task 36** — `/restore` is D27, and its trap is R16: a teacher locked out because their *roster
  row* went is not `Revoked`, so `/restore` cannot help them and must say which of the two it found.
  `/restore` on a teacher who was never revoked must say so and write **no** audit row — an audit
  trail with invented entries is worse than a short one. `/staff_remove` must refuse to deactivate
  the last active System member (D13), and must report rather than silently unassign when the
  person owns open cases (R3 second order). `/staff_add` needs region names — `knownRegions` in
  `teachers/region.ts` already produces them, and `/region` shows the shape of the refusal.
- **Task 38** — the group gate. Its trap is R8: a naive "leave every group" makes the bot leave
  `OPS_ALERT_CHAT_ID` and kills every alarm in the system.
- **Task 41** — larger than it looks. §4.7 of the runbook is deleted, "archive" becomes "delete",
  and `Action required` has to be defined in the runbook in D26's words.

### A loose end that is not a task: the layer rule has no mechanical enforcement

The architecture rests on one rule — **nothing may import from a layer above it** — and today that
rule is enforced by whoever is reading carefully. Everything else load-bearing in this project is a
compile error when it breaks; this is not.

**`dependency-cruiser` was tried on 29 July and cannot work here yet.** It installs, initialises,
then cruises **0 modules while printing a green tick** — the exact "looks configured and does
nothing" failure this rebuild exists to remove, so it was uninstalled rather than left in place.

**Nobody is behind, and there is a precise trigger for retrying.** `dependency-cruiser@18.1.0` — the
latest, and the version that was installed — already supports TypeScript 7. Its release note says
the first usable version is **`typescript@7.1.0`**, because 7.0.x exposes no public API for tools to
hook into. As of 29 July 2026 `typescript@latest` is **7.0.2** and 7.1.0 exists only as nightly
builds (`7.1.0-dev.20260728.1`). So this project is on the newest stable TypeScript there is, and
the tool is waiting on a release that has not shipped.

```bash
npm view typescript version   # when this reads 7.1.0 or above, dependency-cruiser can work here
```

**Do not install a nightly TypeScript to make a linting tool run, and do not downgrade TypeScript
either.** The compiler the whole build depends on does not move to suit a linter.

**The graph itself now exists, built rather than installed** (`340966f`):

```
npm run deps          → writes docs/dependency-tree.md
npm run deps:check    → silent, exits non-zero on a cycle, an unresolvable
                        import, or a file nothing uses
```

`scripts/dependency-tree.mjs` — plain Node, no dependencies, no build step, and
nothing a compiler upgrade can break. It already knows the three things the
off-the-shelf tool had to be taught: entry points and test files are imported by
nothing and that is correct; a `.js` on a relative import means a `.ts` file; and
a type-only import may point upward and is not a cycle. **Current state: 62 source
files, 42 test files, no cycles, no unresolved imports, nothing unused.** Run
`npm run deps` after adding files and commit the regenerated document.

**`repowise` was tried on 29 July, reported honestly, and rejected by the head of
project — "ignore repowise forever".** It is uninstalled and the `.repowise/`,
`.mcp.json` and `.vscode/` it wrote were removed from the repo the same evening.
**This is a closed decision. Do not propose it, and do not re-test it.** It is
recorded only so that nobody spends the effort again: it indexed fine and free,
but its search returned its own generated pages rather than source, and its MCP
tools needed a restart to appear — so it was unavailable during the very task it
was installed for. `Grep` answered everything it answered, in one call, with the
code attached.

**What is still missing is the rule, not the graph.** The layers map cleanly onto directories —
`src/staff/roles.ts` and `src/cases/status.ts` are pure leaves, `src/cases/queries.ts` and the
repositories are stores, `src/telegram/commands/` is layer 3. A script of roughly thirty lines can
read the import lines of every file and fail on one that points upward. No dependency, no coupling
to a TypeScript version, and it does the single job actually wanted. Three things it should know
about, all met already in this codebase:

- Entry points (`src/web/main.ts`, `src/worker/main.ts`, `src/scripts/*`) and `*.test.ts` files are
  imported by nothing, and that is correct — they are not orphans.
- Nothing in `src/` may import a `*.test.ts` file.
- **A type-only import may point upward and is not a violation.** `import type { OutgoingMessage }
  from '../telegram/router.js'` in `src/cases/notify.ts` and in the command files is deliberate:
  type imports are erased at compile time, which is what lets a lower layer borrow a shape without
  depending on it at run time, and it is how the dispatcher and the router avoid a real cycle.

## 9. Open questions

**None.** All four original questions and both follow-ups are answered — see §3. If a new one
arises, ask; do not assume.

## 10. How this project is run

- **The head of project is not an engineer.** Plain English, no jargon; recommend rather than
  survey; correct a wrong premise directly rather than working around it.
- **Do not commit per task.** They say "commit" and that is the standing pattern. A fix to
  already-committed code gets its own `fix:` commit, separate from the feature that found it.
- **Verify before claiming done.** Tests, typecheck, build, with the numbers stated plainly. This
  project has repeatedly found faults in code that was written, reviewed and committed the day
  before, and every one was found by running something rather than by reading.
- **Their answers are decisions, not opening positions.** Raise a concern once, then build what was
  asked and record the cost. See §3.
- **The artifact** at `https://claude.ai/code/artifact/64bce4b9-a63e-4dee-a883-9b0ecb457b53` is
  their document, in plain English. Update it **in place** by passing that URL as `url`. Never mint
  a new one. **Brought current on 29 July as v7** — through task 45, all six answers, all four audit
  faults closed. The way to update it is `WebFetch` on that URL (which saves the full HTML), strip
  the `<!doctype>`/`<head>` wrapper, edit, and republish with `url`.
