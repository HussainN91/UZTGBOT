# Stage 4 planning — research state, paused mid-session

**Paused:** 28 July 2026, before the plan document was written. Nothing in the
repo was changed by this session except this file and the Stage 3 commit
(`d743d72`). Resume by reading this, then writing
`docs/plans/2026-07-28-stage-4-staff.md`.

## What was asked for

A Stage 4 plan in the established style: the four review lenses applied
(**dependency watcher**, **ripple watcher**, **conceptual deployer**), down to
the last file, and — new for this stage — an explicit **backward and forward
pipeline audit**: every pipeline complete, with its endpoints in the right
place, across everything that was (Apps Script), is (Stages 1–3), and will be
(Stages 5–7).

Match `docs/plans/2026-07-28-stage-3-teachers.md`: Decisions recorded (D1…),
re-staging table, file-structure tables, TDD tasks with real code in every step,
deploy-day checklist, open items deliberately not closed.

## Reading completed

| Source | Status |
|---|---|
| `docs/plans/2026-07-28-stage-3-teachers.md` (738 lines) | read in full — the style template |
| `BOT-SPEC.md` (795) | read in full — §6 is the staff model, §6.5 the 19 commands, §7.1.1 notification, §7.1.2 digest |
| `src/db/schema.ts` (603) | read in full |
| `src/telegram/router.ts` (686), `bot.ts` (184) | read in full |
| `src/cases/service.ts`, `src/log/audit.ts`, `src/sync/alerts.ts` | read in full |
| `src/config/constants.ts`, `settings.ts`, `env.ts` | read in full |
| `src/telegram/callback-data.ts`, `send.ts` | read in full |
| `src/teachers/repository.ts`, `src/worker/main.ts`, `job-run.ts` | read in full |
| `RUNBOOK.md`, `CONCERNS-AND-IT-ACTIONS.md` | read in full |
| Artifact v4 status board | fetched; stage definitions below |

**Not yet read — do this first on resume:**

- `reference/apps-script/AdminCommands.gs` (1,289 lines) — **the** source for all
  19 commands, `can_`/`CAPABILITIES_`, `adminCanSeeCase_`, `queueForCategory_`,
  `notifyAdminsOfNewCase_`, `consumeUrgentCode_`
- `reference/DEPENDENCY_TREE.md` (900) — cited throughout Stage 3's plan
- `reference/apps-script/Triggers.gs` (335) — `runDailyDigest`, edit alerts
- `reference/apps-script/CaseManager.gs` (266) — `updateCaseFields_`, actor stamping
- `src/telegram/keyboards.ts`, `handlers/*.ts`, `src/cases/urgent.ts`,
  `src/teachers/verify.ts`, `src/conversation/state.ts`, `src/web/main.ts`
- `reference/UPGRADE-PLAN.md` §§ Phase 1.3, 3.2, 4.1–4.3, 5.1–5.4 (the Apps
  Script versions of exactly this stage's work)

## Stage map (from the artifact, v4)

| Stage | Scope | State |
|---|---|---|
| 0–2.5 | baseline, foundations, data+sync, operational floor | proven |
| 3 | teachers — sign-in, FAQ, cases, urgent codes | proven, committed `d743d72` |
| **4** | **staff — every command, on one simplified permission system** | **next, unplanned — the gate on launching** |
| 5 | scheduled work — announcements, digests, clean-up, alerting | not started |
| 6 | documents — uploads through Telegram | not started |
| 7 | launch readiness — MoPSE items, not code | not started |

## Findings so far — carry these into the plan

### Pipelines that dead-end today (the backward/forward audit)

1. **Case pipeline stops after filing.** `createCase` writes the row; nothing
   reads it but `getCasesForChatId` (teacher-facing, `detail` stripped).
   `updateCase` and `appendUrgentFollowUp` exist and have **no caller outside
   the urgent flow** — built in Stage 3 for Stage 4 to use.
2. **`cases.owner`** is a real FK to `staff.telegram_id`; nothing ever writes it.
   `cases_owner_idx` exists for a query nobody makes.
3. **`staff` table is empty and unreferenced** — no reader, no writer, no
   bootstrap. First System row cannot be created by any command (Apps Script had
   the same hole, §6.3, solved by a hand edit; here it needs SQL or a seed).
4. **`teachers.revoked_at` / `revoked_by`** — columns written by nothing.
   `findTeacher` selects `revokedAt` and no caller reads it.
5. **`audit_log` + `recordAudit`** — written, tested, **zero callers**. It exists
   for exactly this stage's privileged actions.
6. **`setSetting`** exists with no caller; `/maintenance` is its intended one.
7. **Alert pipeline endpoint is provisional.** `src/sync/alerts.ts:10` says
   "Stage 4 supplies an alerter that messages System-role staff"; today
   everything goes to `OPS_ALERT_CHAT_ID`. Decide: keep env-based (simple,
   already proven by the smoke test) or fan out to System staff. **Recommend
   keeping `OPS_ALERT_CHAT_ID` as the floor and adding staff fan-out on top** —
   the env var is what works before any staff row exists, which is also the
   recovery path when the staff table is wrong.
8. **Urgent codes have no issuing endpoint.** `urgent_codes` is consumed by
   `src/cases/urgent.ts`; rows are inserted by hand (RUNBOOK 4.4).
   `/generate_urgent_code` is Stage 4's. `issued_by` is `notNull` — a command
   supplies it naturally; the hand-issued rows use `'0'`.
9. **New-case notification is the deferred seam (Stage 3 D2).** Today a created
   case emits nothing at all — not even through the alerter. **Check this on
   resume**: D2 promised "emits a case-created event through the existing
   Alerter", but `createCase` returns without alerting and `router.ts` raises no
   alert on the filed path. If so, D2 was not implemented and Stage 4 inherits
   the whole of it.
10. **Region axis is populated but unused.** `bindTeacher` copies
    `roster.region` → `teachers.region` (deliberately, for this stage).
    `staff.regions` defaults `[]` = all. Nothing joins them yet.
11. **Queue axis does not exist in TypeScript.** `staff.queue` defaults `'All'`;
    there is no `queueForCategory` and no queue vocabulary anywhere in `src/`.
    Apps Script's `queueForCategory_` maps the seven newer FAQ topics onto the
    four real queues — port that decision, do not re-derive it.
12. **`OVERDUE_DAYS`** is in `SETTING` and read by nothing. Digest is Stage 5,
    but `/urgent`'s overdue half is Stage 4 and reads the same key.
13. **Announcements tables** (`announcements`, `announcement_recipients`) —
    Stage 5. Leave alone; do not let `/announce` creep into Stage 4.
14. **`DOC:` callback prefix** is defined in `callback-data.ts` and emitted by
    nothing — Stage 6. Correct as-is.

### Structural facts the plan must respect

- **The router is teacher-shaped.** `route()` takes `{chatId, kind, text}` and
  every path assumes a teacher. Staff commands arrive as ordinary text messages
  in a private chat, so they must be recognised **inside** the pipeline (same
  argument as `/privacy` and `/help` in `bot.ts:177-187`) — not as
  `bot.command` handlers, or they skip the update claim, the chat lock and the
  interaction log.
- **A staff member may also be a teacher.** The two gates are separate by
  design (`BOT-SPEC.md` §6 opening). `staff.telegram_id` and `teachers.chat_id`
  are different tables with no FK between them, and must stay that way.
- **Recognition is by command name, not by sender** (`BOT-SPEC.md` §6.5): match
  the word first, then reject a non-admin with a clear message, and log
  `ADMIN_DENIED` with the caller's permission shape. A typo like `/foo` falls
  through to ordinary text handling.
- **Roles are already simplified in the schema**: `staff_role` enum is
  `Support < Regional < Program < System` with `STAFF_ROLE_ORDER` for ranking —
  *not* Apps Script's `ReadOnly/Agent/Manager/SystemAdmin` plus a Tier fallback.
  The capability table in `BOT-SPEC.md` §6.1 uses the **old** names and must be
  re-expressed against the new enum. This is a documentation correction task.
- **`updateCase` cannot write `detail`** — by design. `/note` appends to
  internal detail in Apps Script; here that needs either an append-only route
  (like `appendUrgentFollowUp`) or a separate `case_notes` table. **Open
  decision — resolve in the plan.**
- **Commit before you speak** holds for staff replies too: `/reply` must commit
  the case update before messaging the teacher.
- Telegram send: use `send` (throws) for anything reporting success to a human;
  `trySend` only for bulk.

### Deploy/conceptual-deployer notes

- Migrations forward-only and additive so far; keep that property.
- `docker compose run --rm --no-deps web node dist/db/migrate.js` before serving.
- Bootstrapping the first System staff row needs a documented path — SQL over
  the SSH tunnel, mirroring RUNBOOK 2.4's settings pattern. Two named System
  staff is already a launch-checklist item (RUNBOOK 1.4, A4).
- The smoke test (RUNBOOK Part 3) will need staff steps: issue a code by
  command, reply to a case, confirm the teacher receives it.

## Test/verification commands

```bash
docker compose -f docker-compose.test.yml up -d
```

```bash
TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
```

Baseline to beat: **332 tests, 24 files, typecheck and build clean.**
