# Working on this project

MoPSE teacher support bot — a Telegram bot for teachers recruited by Uzbekistan's Ministry of
Preschool and School Education. TypeScript, PostgreSQL via Drizzle, Docker.

**This file is loaded automatically at the start of every session.** It carries the rules, the
patterns and the procedures. It does **not** carry project status — for that, read the plan of
record named in §7.

---

## 1. Who you are working with

**The head of project is not an engineer.** Write in plain English with no jargon. Explain what a
change means for a person using the bot, not what it means for a file.

- **Recommend, do not survey.** Give one answer and the reason for it. A list of options with no
  recommendation moves the work onto them.
- **Correct a wrong premise directly**, in a sentence, then get on with the request.
- **Do not over-compress.** Their words: *"sometimes you compact meanings too much."* Prefer a
  longer clear sentence to a dense one. This applies to prose, not to code.
- **Their answers are decisions, not opening positions.** Raise a concern once; if they repeat the
  instruction, build it and record what it cost.
- **Say what you did not do**, and say which choices you made without asking. A gap named early is
  cheap. A choice made silently is the expensive kind.
- **They will stop a session deliberately** rather than let it run out of context. Pause at a
  boundary, commit, and leave the tree clean — do not trail off mid-change.

## 2. The architecture rule — the one that is not a compile error

```
Layer 4  src/worker/ src/web/ src/scripts/   processes
Layer 3  src/telegram/                       router, commands, keyboards, handlers
Layer 2  cases teachers staff db sync forms  stores: database, no Telegram
Layer 1  send.ts callback-data.ts            pure leaves
```

**Nothing may import from a layer above it (D46).** The checker reports zero cycles and zero layer
violations today; that is a property to preserve, not to rediscover.

Four consequences bind almost every change:

1. **Stores must not send messages.** A layer-2 module *returns* what needs saying and layer 3
   sends it. `verifyIdentifier` returns `priorHolders`; `router.ts` sends the notices. This is the
   single easiest way to break the layering.
2. **Nothing in the router sends, either.** `route()` decides and returns; `deliver` in `bot.ts`
   commits the transaction first and speaks afterwards. A failed send after a good commit is
   recoverable — the case exists and Check My Case shows it. A failed commit after a confirmation
   message is not.
3. **`import type` may point upward** and is not a violation — it is erased at compile time. That is
   what keeps `cases/notify.ts` legal. Keep those imports type-only.
4. **Callback prefixes share a byte budget.** Telegram's ceiling is 64 bytes.
   `telegram/callback-data.ts` is layer 1 by explicit override in `scripts/dependency-tree.mjs`
   because it is a pure codec, and `sheets/parse.ts` rejects FORMS rows whose TYPE would overflow.
   Add prefixes freely; do not grow the budget. There is a test measuring the longest real
   payload — extend it rather than trusting arithmetic.

## 3. Coding patterns this codebase holds to

- **State a rule once, and route new callers through the function that holds it.** Sign-in is
  reachable from four places and every one of them must refuse a revoked chat, because `bindTeacher`
  clears `revoked_at`. They all go through `requireSignIn` → `menuAccessFor`. Four doors sharing one
  expression of a rule cannot drift apart; four copies eventually will, and the copy that drifts is
  the one nobody was looking at. **Do not write the second copy.**
- **Make the wrong thing impossible to write, not merely tested for.** `mainMenuKeyboard` takes its
  `access` parameter with **no default**, so every call site must answer "who is looking at this?".
  That is what found two menu render sites a careful design had missed.
- **Every mutation resolves the case through `findCase` first**, which applies the visibility scope.
  `updateCase`, `addNote`, `markImportance`, `setDue` and `setSnooze` do **not** check who is asking
  — the scoped lookup is the check.
- **Every button re-validates on tap**: active staff row, then the capability the *action* needs,
  then the subject resolved through its scoped lookup, then the subject's own state inside the
  conditional `UPDATE`. A message sits in a Telegram chat for ever, and the person tapping it may
  have been demoted, deactivated or revoked since.
- **`teacherHasAccess` is the gate**, never `verificationState === 'Verified'`. There are two ways
  to lose access and only one of them is `Revoked` — a deactivated roster row leaves the state
  `Verified`.
- **Reply and keyboard modules stay pure** — no database, no network, no clock. They are the one
  thing in the bot that cannot itself fail. Pass resolved values in.
- **Retention keys off `importance`.** Nothing may raise importance on a path a teacher controls.
- **Migrations are forward-only, with no down path.** Prefer purely additive changes, so a code
  rollback works against the newer schema.

### Raw SQL through `db.execute` — three traps that each cost a fault

1. **It does not parse types.** Drizzle installs its own pg parsers, so a `timestamptz` comes back
   as a **string**, not a `Date`. Typing the row as `{ x: Date }` compiles and throws at runtime.
   Format in SQL: `to_char(col AT TIME ZONE ${TIMEZONE}, 'YYYY-MM-DD HH24:MI')`.
2. **A parameter's type is inferred from its neighbours.** `make_interval(secs => int_col * ${1.5})`
   makes PostgreSQL decide the parameter is an integer and reject `1.5`. Cast explicitly.
3. **Never interpolate a JS array into raw SQL.** Use drizzle's `inArray`.

**`RETURNING` yields post-update values.** If a statement needs to know what the row looked like
*before* it wrote, read the old values through a sub-select in `FROM`. Written the obvious way,
"was this already true?" answers itself every time.

All of these are invisible to review and to typecheck. **Write the integration test in the same
commit** — not for coverage, but because they fail at the database and nothing above it can tell you.

## 4. Procedures

### Before claiming anything is done

Run all five and state the numbers plainly. **Every fault this project has found was found by
running something.**

```bash
npx vitest run          # needs the database — see below
npm run typecheck
npm run build
npm run lint            # oxlint --type-aware src
npm run deps:check      # silent; non-zero on a cycle, an unresolvable import, or a dead file
```

**Make every checker fail on purpose before believing it.** A green tick over an empty scan is worse
than no tool, because somebody eventually trusts it.

### Running the tests

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

- **Never pipe `vitest` through `head`** — it closes the pipe, the shell returns, and the run keeps
  going invisibly. Filtering with `Select-String` is safe.
- **Never start a second run while one is going.** Check for strays:
  `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*vitest*' }`
- Docker Desktop is often **stopped** on this machine, and can also be **paused** — in which case a
  run hangs with no output at all.

### The dependency graph and the ripple procedure

`dependency-cruiser` cannot read this project (it needs `typescript@>=7.1.0`; check with
`npm view typescript version` before trying again, and **never downgrade TypeScript to suit a
linting tool**). `scripts/dependency-tree.mjs` replaces it — plain Node, zero dependencies. It was
measured against dependency-cruiser on 30 July 2026 and won; it is no longer a suspect.

```bash
npm run deps        # regenerates docs/dependency-tree.md — commit the result
npm run deps:check  # the gate
```

**Run `npm run deps` after adding or moving files, and commit the regenerated document with the
code.**

**Before writing a change, write its ripple map** — every file it touches, with the layer of each.
The plans in `docs/plans/` all carry one and it is the format to match. It is what catches "this
also has to change" before the compiler does, and it is how the layer rule gets checked by a person
rather than only by a script.

### If you touch the schema

```bash
npx drizzle-kit generate
```

**Read the generated SQL before accepting it** — it has emitted a destructive `DROP TYPE` here once.
Rename the file to the existing convention and change the `tag` in `drizzle/meta/_journal.json`.

### knip

`npm run knip:prod` crashes with `RangeError: Array buffer allocation failed` while Docker Desktop is
running. oxc-parser allocates one large **ArrayBuffer** — external memory, not V8 heap — so
`--max-old-space-size` does not fix it. `docker desktop stop`, run knip, `docker desktop start`.

`npm audit` reports 4 moderate **dev-only** advisories inside `drizzle-kit`. `npm audit --omit=dev`
reports 0 and nothing reaches the running bot. **Do not run `npm audit fix --force`** — it would
move `drizzle-kit` across a major version for no benefit.

## 5. Committing

- **Do not commit per task.** Work through, then offer once at a boundary.
- **Code first, documents second**, as separate commits.
- **A fix to already-committed code gets its own `fix:` commit.**
- **Each commit is verified on its own.**
- Commit messages here are prose that explains *why*, not a changelog. Match the existing style —
  read `git log` before writing one.
- `docker` and `git` are both already installed and on the PATH. The Bash tool **is** their Git Bash;
  never install another.

## 6. Testing discipline

Test-first. The interesting tests here are integration tests against a real PostgreSQL — the state
lived in memory before the rebuild, so "the teacher taps twice", "the bot restarts" and "a command
arrives mid-conversation" could only be reasoned about.

**When a test fails after a change, the test is usually right.** Four failed on Feature B and every
one of them was correct to fail. "The test is wrong" is the wrong first thought.

**Assert the refusal, not the absence.** A button a user is never shown is still sitting in their
scrollback and is still live. Tests for a hidden control must tap it.

## 7. Where things are written down

| Document | What it is |
|---|---|
| **`docs/plans/2026-08-01-identity-and-urgent-design.md`** | **The plan of record.** Status, what is built, what is next, and every design decision with its reasoning. **Start here.** |
| `docs/plans/2026-08-01-login-gating-design.md` | Part 5F's design, and the shape a per-feature design document should take |
| `BOT-SPEC.md` | What the bot does — the running system |
| `RUNBOOK.md` | How to operate and deploy it; §1.4 is the launch checklist |
| `docs/dependency-tree.md` | Generated; do not hand-edit |
| `docs/plans/archive/` | Superseded documents, kept for history. Do not read to get up to speed |

**A new piece of work goes in a new document.** The specification documents are corrected once, at
the end, in one pass. Corrections to a plan are **struck through with the correction against them**,
never written over the top — so a later reader sees what was originally decided and why it changed.

### There is no summary artifact, and there is not going to be one

A published summary document was kept until **6 August 2026** and has been **retired and deleted**.
**Do not look for it, do not recreate it, and do not offer to.**

It was the second thing to die of the same cause as the rolling handoff, retired on 1 August: it held
nothing that was not already in the repository. Everything in it flowed one way — out of the code and
the plans, into a restatement — so it could only ever be a copy, and a copy that is expensive to
maintain is a copy that goes stale. It reached v9 and was three weeks behind the running system.

In the head of project's own words: *"we have a runbook, we have git, we have github."* That is the
whole argument. `RUNBOOK.md` is how to operate it, `BOT-SPEC.md` is what it does, the design documents
are why, and git is what changed and when. A tenth restatement of those four helps nobody.

**When a session ends, write the summary into the conversation and into the plan's own document.**
Do not create a new status document, a new handoff, or a new artifact to hold it. See
[[prefers-one-source-of-truth]].
