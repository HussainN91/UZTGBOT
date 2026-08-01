# The handoff prompt

**Paste the block below into a fresh context window.** It is written for Claude Opus 5 and assumes
nothing about what the previous session did or said. Everything it needs is on disk.

Delete this header before pasting; the block starts at the horizontal rule.

---

You are picking up the MoPSE teacher-support bot at `D:\Telegram Bot server`. A previous session
finished a feature and committed everything. The working tree is clean.

## Read these three, in this order, before doing anything else

1. **`docs/plans/2026-07-29-stage-4-handoff.md`** — the rolling handoff. The filename says stage 4
   for historical reasons; it is current and it is rewritten in place at the end of every session.
   Read it in full, including the parts about how this project is run.
2. **`docs/plans/2026-08-01-identity-and-urgent-design.md`** — the plan of record. It carries the
   ordered list of remaining work, and Part 8 says which skills to invoke.
3. **`CLAUDE.md`** if one exists, and the memory directory index.

Do not read the artifact URL mentioned in the handoff. It flows one way — from what was built, to
the head of project — and reading it to get up to speed makes it a second, drifting copy.

## What this project is

A Telegram bot for teachers recruited to Uzbekistan by the Ministry of Preschool and School
Education. It answers questions from a curated FAQ, files support cases, runs them through a staff
workflow, and hands out document forms. It is a rebuild of an Apps Script system whose failures are
documented throughout the code — most comments in this codebase explain *why* something is the way
it is, and several of them are the only record of a fault that took a week to find. **Read the
comment before changing the line.**

Roughly 80 source files and 66 test files, TypeScript, PostgreSQL via Drizzle, grammY, deployed in
Docker on a VPS. About 1,150 tests, none skipped.

## Who you are working for

**The head of project is not an engineer.** They are intelligent and they make the decisions; they
do not want jargon, surveys of options, or dense compression. They said this explicitly: *"yes i am
smart, but sometimes you compact meanings too much."* Prefer a longer clear sentence to a short
dense one. Recommend rather than list. If they state a wrong premise, correct it directly and
plainly.

Their answers are decisions, not opening positions. Raise a concern once, then build what was asked
and record what it cost.

## The work, in order

The plan's order is authoritative. As of 1 August 2026:

1. **Operational launch blockers** — hours, not code, and they gate the launch. Revoke the test bot
   token, confirm the sheet is not publicly editable, move `OPS_ALERT_CHAT_ID` from a private chat
   to a group, set `BACKUP_PASSPHRASE`/`BACKUP_REMOTE` and actually run the restore drill, confirm
   Uzbekistan hosting. **Nobody has touched these.** They need the head of project, not you.
2. **Part 5F — the login-gating hole.** About half a day. This is a live defect, not an improvement:
   a brand-new teacher cannot reach the FAQ, which is deliberately open to everybody, because
   `/start` hands them a sign-in prompt with no way past it. **There is a warning in the plan about
   revoked chats — read it before touching `/start`.** It describes a hole that has already been
   fallen into once.
3. **Part 5G — buttons on case lists.** About a day and a half, directly requested by the head of
   project. Reading a case currently means retyping a nineteen-character reference by hand out of a
   plain-text list. Two design questions in the plan are unsettled — **ask before building**.
4. **Feature A — identity dispute escalation.** About 3.5 days. Fully designed in Part 2 of the
   plan. The shared regional-recipient lookup it needs already exists at `src/staff/recipients.ts`.
5. **Feature C**, then **Feature E**, which needs its own spec written first.

Ask which of these to start with. Do not assume.

## The rules that are not negotiable here

- **Nothing may import from a layer above it.** Layer 4 is the processes, 3 is Telegram, 2 is the
  stores, 1 is pure leaves. `npm run deps:check` enforces it and must stay clean. Stores return what
  needs sending; they never send.
- **Migrations are forward-only, with no down path.** Additive changes only, so a code rollback
  works against the newer schema. Generate with `npx drizzle-kit generate`, then **read the SQL
  before accepting it** — it has emitted a destructive `DROP TYPE` here once.
- **Verify before claiming anything is done.** Run the tests, the typecheck, the build, the linter
  and the dependency check, and state the numbers. A test run reporting skips proved nothing.
- **Do not commit per task.** Work through, then offer once at a boundary. A fix to already-committed
  code gets its own `fix:` commit.

## Running the tests

The test database is a container with no volume, so assume it is not running.

```
docker desktop start
docker compose -f "D:\Telegram Bot server\docker-compose.test.yml" up -d
docker inspect --format "{{.State.Health.Status}}" mopse-test-postgres-1
```

Then in PowerShell:

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run
```

**Never pipe vitest through `head`** — it closes the pipe, the shell returns, and the run keeps going
in the background. Filter with `Select-String` instead. Never start a second run while one is going.

§7 of the handoff has the rest, including why `knip` needs Docker stopped.

## Skills

Part 8 of the plan says which to invoke and when. Nothing needs downloading. In short:
`superpowers:brainstorming` before the two interface features, because both have unsettled design
questions; `superpowers:writing-plans` before Feature A; `superpowers:test-driven-development`
throughout, because that is this codebase's discipline and it has caught real faults;
`superpowers:verification-before-completion` before claiming anything works.

## Start by

Reading the three documents, then telling the head of project — in plain English, briefly — what you
understand the state to be and which piece of work you propose to start, and asking them to confirm.
Do not start writing code before they answer.
