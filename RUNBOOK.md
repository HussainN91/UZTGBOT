# MoPSE Teacher Support Bot — Runbook

**Version:** 2.0 · **Date:** 2026-07-28 · Rewritten for the rebuilt system

This replaces the Apps Script runbook completely. Nothing in the previous version
still applies: there is no spreadsheet to set up, no script project, no triggers
to install, no deployment versions to publish. The bot runs on a rented server.

**Who each part is for**

| Part | For | Read it when |
|---|---|---|
| 1 | Head of project | Now. It is the only part with decisions in it |
| 2 | IT | Before the first deployment |
| 3 | IT, with the head of project watching | After every deployment |
| 4 | Support staff and IT | Day to day |
| 5 | IT | When something is wrong |
| 6 | Everyone | To know what is deliberately not built yet |

---

# PART 1 — For the head of project

## 1.1 What this is

A Telegram bot for teachers recruited by the Ministry. A teacher signs in with the
email address they were recruited with, reads approved answers to common
questions, and opens a support case when the answers do not cover it. A case gets
a reference number they can quote to anyone helping them.

It replaces a version built on Google Sheets. Same purpose, same answer bank, far
less that can go wrong without anyone noticing.

**It has never been launched.** No teacher has used it and it holds no real data.
There is nothing to migrate and no switch-over window.

## 1.2 It cannot go live yet, and this is why

The teacher's half is built and tested. **The staff half is not.**

A teacher can sign in, read answers, open a case and escalate an emergency with a
one-time code. Once they have, **nobody can reply to that case through the bot** —
the staff commands are the next stage of work. Launching now would collect
problems and answer none of them, which is worse than not launching at all.

So "can we go live?" has a technical answer today — *not yet, wait for the staff
commands* — and that is separate from everything below, which is about whether we
are **ready** when the code is. Most of what follows has a longer lead time than
the code does.

## 1.3 The five things only you can decide

Nothing on this list is waiting on engineering. Each has a real deadline, and two
have passed the point where waiting is free.

### 🔴 1. How long do we keep records? — the clock has started

Every message a teacher sends the bot is recorded, redacted where it is sensitive.
The table that holds them now exists and begins filling the moment the bot serves
its first teacher.

The privacy notice every teacher reads before signing in already promises their
data can be removed. It deliberately does **not** state a retention period,
because none has been chosen — and there is a test that fails if anybody writes a
number in before you have chosen one, so this cannot be quietly settled by a
developer picking something that sounds reasonable.

**Deciding before the first deployment is a decision about a design. Deciding
afterwards is a decision about data that already exists.**

*What we need:* a number of days, for case records and for message records. They
can differ — cases are operational history, messages are mostly an audit trail.

### 🔴 2. How is a removal request actually honoured?

The database refuses to delete a teacher who has ever opened a case. That is
deliberate: it is what guarantees no case can exist without a real teacher behind
it. It also means the removal promised in the privacy notice is currently blocked
by a safeguard we added on purpose.

Honouring it means anonymising rather than deleting — replace the name and the
address, keep the case. That is buildable, and it is a policy decision before it
is a piece of code.

*What we need:* agreement that anonymisation satisfies the promise, or a different
promise.

### 🟠 3. Does the privacy notice say the right things?

The wording is drafted and **has not been reviewed by anyone at MoPSE**. It states
what is held, who can see it, and how to ask for removal. Every teacher reads it
before they sign in, and the version each teacher accepted is recorded against
their record — so a later revision does not quietly erase the meaning of every
earlier consent.

*What we need:* someone who can speak for MoPSE to read `src/config/privacy.ts`
and either approve it or say what to change.

### 🟠 4. Should we reconsider how a teacher proves who they are?

A teacher signs in by typing the email address they were recruited with. Anyone
who has that address can sign in as them.

This is inherited from the original design, and it is **reported rather than
blocked**: if a second Telegram account presents an identity already in use, the
operations chat is alerted and the original account is sent a security notice.
Blocking it would be worse in both directions — it would lock out any teacher who
changes phone, with no way to release them, and it would let whoever got there
first lock the real teacher out permanently.

**This decision expires at launch.** Today it is a change to a sign-in flow nobody
has used. Afterwards it is a change to how every teacher already signed in, plus a
migration, plus explaining it to 1,800 people.

### 🟠 5. Do staff currently work cases in the spreadsheet?

If they do, that habit changes: replying, assigning and closing move to bot
commands. That is retraining rather than code, and it is much cheaper to know now
than to discover it during the staff stage.

## 1.4 The launch checklist

Everything here blocks launch. None of it is engineering work.

| | What | Why it blocks |
|---|---|---|
| ☐ | **A real support contact** | The bot refuses to start without one, so it can no longer be forgotten. Every dead end in the bot names it |
| ☐ | **The teacher roster** in the spreadsheet | Without it nobody can sign in, and no case can be opened |
| ☐ | **At least two named administrators** | So one person leaving cannot lock everyone out |
| ☐ | **An operations group chat** for alarms | Use a group, not one person's private chat — one person on leave should not mean nobody is watching |
| ☐ | **A proven backup restore** | The scripts are written and have never been run against a real server. An untested backup is a belief, not a capability |
| ☐ | **A retention period** | Decision 1 above |
| ☐ | **A named owner for FAQ content**, and a review interval | 112 answers about salary, visas and contracts will drift, and nothing in the system flags a stale one |

## 1.5 What teachers can do on day one

- Read the privacy notice and sign in with their recruitment address
- Browse eleven topics of approved answers, or type a question and pick the topic
  it belongs to
- Say whether an answer helped — both ✅ and ❌
- Open a support case in one of five categories and get a reference number
- Check the status of their own cases
- Escalate an emergency with a one-time code from a Regional admin

**What they cannot do:** upload documents, or use the bot in Russian or Uzbek.
Both are absent deliberately rather than half-built — offering either would send a
teacher who had just signed in to a dead end.

## 1.6 Honest risk summary

**Genuinely better than the old system.** A case cannot be filed twice by a double
tap. A teacher's conversation survives a restart. An urgent code cannot be spent
twice, and is no longer lost by a teacher who takes their time. A scheduled job
that stops running raises an alarm instead of being silently absent. Revoking a
teacher takes effect on their next message rather than up to half an hour later.
All of it is covered by tests that run against a real database.

**Still true.** It runs on one server; losing it means restoring from backup, which
is exactly why proving the restore is a blocker. It depends on Telegram and on one
bot token. A teacher's recruitment email is still all it takes to sign in as them.

**Changed, and you should know.** An emergency code is now spent when the case is
filed rather than when the code is typed, so a teacher who gives up halfway keeps
it. The window to describe an emergency is 24 hours rather than 6 — the old six
was a platform limit, not a decision anyone made.

---

# PART 2 — Deployment

**The step-by-step mechanics are in `deploy/README.md`** — server preparation,
Docker, configuration, TLS, the webhook, backup tooling. That file lives beside
the scripts it describes so the two cannot drift apart. This part covers the
ordering rules and the things that are easy to get wrong.

## 2.1 The order is not negotiable

```bash
docker compose build web worker
```

```bash
docker compose stop web worker
```

```bash
docker compose run --rm --no-deps web node dist/db/migrate.js
```

```bash
docker compose up -d worker
```

```bash
docker compose up -d web
```

**Migrate before serving, always.** The schema must be at least as new as the
newest running process. New code against an old schema errors on every teacher
message — and because handler errors are caught so Telegram does not retry
forever, the teacher gets *silence* rather than an error. That is the worst
failure shape available.

**`run --rm --no-deps`, not `exec`.** A throwaway container, not the one serving
teachers. On a first install the difference is cosmetic; on an upgrade it is the
entire point.

**Worker first.** If the new code disagrees with the schema it will crash-loop,
and it is far better to discover that while nothing is serving teachers.

Migrations are safe to re-run: applied ones are recorded and skipped, and each
runs in a transaction, so a failure leaves the schema exactly as it was.

## 2.2 Rolling back is code-only

Migrations run forwards only — there are no down migrations. A rollback means
checking out the previous tag and rebuilding, **against the newer schema**. That
works only because every migration so far is additive, and it is worth proving on
deploy day before any teacher is served: boot the previous image against the new
schema and watch it come up. Free then, impossible later.

**Restoring a backup is not a rollback.** It would also destroy every case filed
since the dump.

## 2.3 Add the permanent smoke-test row

Add one row to the roster tab and leave it there forever:

| IDENTIFIER | NAME | REGION |
|---|---|---|
| `deploy-check@mopse.uz` | Deployment Check | Tashkent |

Permanent because removing it would not remove the bound teacher record anyway —
the sync deactivates rather than deletes, and the case foreign key refuses the
delete. Keeping it makes the smoke test repeatable on every future deploy with no
cleanup.

## 2.4 Settings that are not in the environment

Three values live in the `settings` table rather than in `.env`, because they must
be changeable in seconds during an incident without a deploy:

| Key | What it does | If unset |
|---|---|---|
| `MAINTENANCE_MODE` | Pauses new cases. The FAQ and Check My Case stay live | off |
| `RETENTION_DAYS` | How long records are kept | **unset — see Part 1** |
| `OVERDUE_DAYS` | When an open case is treated as overdue | used from the digest stage |

Until the staff commands exist, set them with SQL over an SSH tunnel:

```sql
INSERT INTO settings (key, value) VALUES ('MAINTENANCE_MODE', 'TRUE')
ON CONFLICT (key) DO UPDATE SET value = excluded.value;
```

Changes are picked up within a minute.

---

# PART 3 — Smoke test

Run this every time you deploy. It takes about ten minutes. Use a Telegram account
that is not an administrator's, and the `deploy-check@mopse.uz` roster row.

The last three steps matter most, because they were impossible to test at all
before this rebuild.

### 1. The bot is reachable

```bash
curl -sS https://$BOT_HOSTNAME/healthz
```

Expect `{"status":"ok"}`. `{"status":"degraded"}` means the web process is up but
the database is not reachable — it reports 503 in that state on purpose, because a
process answering 200 while it cannot serve anyone keeps traffic arriving at
something broken.

### 2. Sign-in

Send `/start`. Expect the privacy notice and the request for a recruitment address
in **one message** — replying is the acknowledgement, so the two are never
separated.

Send a wrong address. Expect a refusal that does not reveal whether the address
exists, and a count of remaining attempts.

Send `deploy-check@mopse.uz`. Expect "Signed in as Deployment Check" and the main
menu.

### 3. The FAQ answers

Type `how long does a visa take` with no topic chosen. Expect to be asked which
topic it is about — **not** an answer. Tap **Visa**. Expect the approved answer
with ✅ and ❌ beneath it.

This two-step is deliberate and staff will ask about it: matching is scoped to one
topic so a visa question can never be answered out of the accommodation bank. The
question is remembered, so the teacher only types it once.

Tap ✅. Then open a topic from the menu and page through it — the same page must
show the same answers every time.

### 4. A case is filed once

Tap **Contact Support** → **Visa** → type a description. Expect a reference like
`VISA-2026-00001`.

Now do it again and **tap confirm twice, fast**. Expect one case, not two, and a
message saying the existing case was reused rather than a second one opened.

```sql
SELECT reference, status FROM cases ORDER BY created_at DESC LIMIT 5;
```

### 5. Check My Case shows no private text

Tap **Check My Case**. Expect the reference, the category and the status — and not
one word of what you typed. A teacher never sees their own words read back; the
only case text they ever see is a public update written deliberately by staff.

### 6. Restart mid-conversation

Tap **Contact Support** → **Visa**. Before typing the description:

```bash
docker compose restart web
```

Now type the description. **The case must file correctly.** This is what proves
conversations no longer live in memory — under the old system this teacher was
simply lost, and there was no way to test it.

### 7. An urgent code is spent exactly once

Issue a code by hand (there is no command until the staff stage):

```sql
INSERT INTO urgent_codes (code, issued_by, expires_at)
VALUES ('TEST01', '0', now() + interval '48 hours');
```

Tap **🚨 Urgent Case** and type `WRONG1`. Expect a refusal that does not say why.

Type `TEST01`. Expect "Code accepted" — and confirm it has **not** been spent:

```sql
SELECT used_at FROM urgent_codes WHERE code = 'TEST01';   -- must be NULL
```

Now type the emergency description. Expect a case marked urgent, and:

```sql
SELECT used_at, used_by, case_reference FROM urgent_codes WHERE code = 'TEST01';
```

All three must be set. A spent code always names the case it bought.

### 8. A duplicate sign-in is reported

From a **second** Telegram account, sign in with `deploy-check@mopse.uz`.

Expect three things: the second account signs in successfully, the first account
receives a security notice, and **the operations chat receives an alert**.

**If the alert does not arrive, the deployment is not finished.** Every alarm this
system raises travels that path — a refused sync, a stopped job, a teacher who was
never told what happened. Check `OPS_ALERT_CHAT_ID`, and that the bot is a member
of the group.

### 9. Clean up

```sql
DELETE FROM cases WHERE teacher_chat_id = '<the test chat id>';
DELETE FROM urgent_codes WHERE code = 'TEST01';
```

Leave the roster row and the teacher record. They are harmless, and the next smoke
test reuses them.

---

# PART 4 — Routine operations

## 4.1 Editing or adding an answer

Edit the FAQ tab of the spreadsheet. **The change reaches teachers within ten
minutes**, not immediately.

> **This is the single most likely thing to be reported as a bug in the first
> week.** The old system cleared its cache when you edited the sheet, so edits
> appeared at once — and it also meant an *unedited* answer could be up to six
> hours stale. Ten minutes is now the promise in both directions.

To publish immediately:

```bash
docker compose exec worker node dist/scripts/sync-sheets.js
```

A new answer needs a unique `CODE` and a `CATEGORY` that **exactly** matches one
of the eleven topics. A category that does not match is rejected — that one row
only, reported with its row number, and the rest of the sync applies normally.
That is deliberate: under the old system a typo made an answer permanently
unreachable with no error anywhere.

Keep `CODE` short. It travels inside the button a teacher taps, and Telegram caps
that at 64 bytes. An over-long code hides that one button and raises an alarm
naming it, rather than taking down the whole listing.

To retire an answer, set `ACTIVE` to anything other than `TRUE`. It becomes
unreachable immediately at the next sync, including from old buttons still sitting
in teachers' scrollback.

## 4.2 Adding a teacher

Add a row to the roster tab. They can sign in within ten minutes.

## 4.3 Revoking a teacher

Set their roster row inactive, or delete it. Either works — the sync deactivates
rather than deletes — and **it takes effect on their next message**, not up to
thirty minutes later.

Restoring the row restores access, also within ten minutes, and silently. That is
correct behaviour, but it is only visible in the sync history, so if you revoke
somebody deliberately, write down that you did.

## 4.4 Issuing an urgent code — by hand until the staff stage

```sql
INSERT INTO urgent_codes (code, issued_by, expires_at)
VALUES ('AB12CD', '<your telegram chat id>', now() + interval '48 hours');
```

Six characters, letters and digits. Give it to the teacher **by phone or in
person**, never through the bot — sending it through the bot defeats the point.

What the teacher gets for it: their case is filed as escalated, or — if they
already have an open case — that case is escalated and their new words are added
to it rather than a second case being opened.

**The code is spent when their case is filed, not when they type it.** A teacher
who starts and gives up keeps their code. They have 24 hours to describe the
problem.

Five wrong codes from one chat within an hour pauses that chat for an hour. It
clears itself; nobody has to release it.

## 4.5 Pausing new cases

```sql
UPDATE settings SET value = 'TRUE' WHERE key = 'MAINTENANCE_MODE';
```

Insert the row if it does not exist (2.4). It takes effect within a minute.

This stops **new cases only**. The FAQ and Check My Case stay live on purpose: a
teacher looking up an answer is not creating work for anyone, and turning the
whole bot off would tell them nothing at all. Teachers who try to open a case are
told it is paused and given the support contact.

## 4.6 Watching that it is working

```bash
docker compose ps
docker compose logs -f web worker
```

**Most of the watching is done for you.** The operations chat receives an alarm
when a scheduled job stops succeeding, a sync is refused by its damage limit, a
teacher identity is claimed by a second chat, an urgent code is spent without
producing a case, or a teacher was not told the outcome of something that
succeeded.

An alarm arriving is not a crisis. An alarm channel that has been silent for a
week when you expected traffic **is** worth checking, because a broken alerter
looks exactly like nothing being wrong.

To see what teachers are asking that the answer bank does not cover:

```sql
SELECT detail, count(*) FROM messages
WHERE action = 'AWAITING_QUESTION_TOPIC' AND at > now() - interval '30 days'
GROUP BY detail ORDER BY count DESC LIMIT 30;
```

## 4.7 Monthly content review

1. Run the query above, and the ❌ query below
2. Take the top handful to whoever owns the answer content
3. Fix wording in the sheet; write answers for repeated misses
4. Update `LAST_APPROVED_BY` and `LAST_APPROVED_DATE` so the clock restarts

```sql
SELECT detail AS answer_code, count(*) FROM messages
WHERE action = 'ANSWER_UNHELPFUL' AND at > now() - interval '30 days'
GROUP BY detail ORDER BY count DESC;
```

A ❌ against an answer the bot returned *confidently* is the strongest signal
available: it was sure, and it was still wrong. The logs do nothing unless
somebody reads them.

## 4.8 Deploying an update

See 2.1. Always in that order, always migrate first.

## 4.9 Backups

Nightly at 02:30 Tashkent, encrypted, pushed off the server. The script refuses to
report success unless the dump is non-trivial, decrypts correctly, and is listable
on the remote afterwards.

**Run the restore drill quarterly:**

```bash
./deploy/restore-drill.sh
```

It restores into a throwaway database, asserts the result actually contains
tables, prints the row counts and drops the scratch database. It never touches
live data. The half that gets skipped is the half that matters.

---

# PART 5 — When something is wrong

## 5.1 Stop the bot immediately

```bash
docker compose stop web
```

Telegram queues updates while it is down and delivers them when it returns, so
nothing is lost. The worker keeps running; stop it too if the problem is a
scheduled job.

## 5.2 The bot is silent

In order:

```bash
curl -sS https://$BOT_HOSTNAME/healthz
```

- `{"status":"degraded"}` — the database is unreachable. Check `docker compose ps`
  and the `postgres` logs.
- No response at all — the web process or Caddy is down. `docker compose logs web`
  and `docker compose logs caddy`.
- `{"status":"ok"}` but no replies — Telegram is not reaching us:

```bash
docker compose exec web node dist/scripts/set-webhook.js --show
```

Read `last_error_message` and `pending_update_count`. A rising pending count with
an error message names the problem directly. "Wrong response from the webhook"
almost always means the certificate is not valid yet.

**Silence with a healthy process and a clean webhook is the dangerous case**, and
it usually means new code running against an old schema — handler errors are
swallowed so Telegram does not retry forever, which turns an error into nothing at
all. Confirm the migration ran:

```bash
docker compose logs --tail 100 web | grep -i error
```

## 5.3 A teacher says a button does nothing

Almost always a stale button from their scrollback. Old buttons live forever in
Telegram, and an answer withdrawn since, or a topic that no longer exists, lands
them on the main menu rather than doing nothing. Ask them to tap Main Menu and
start again.

If it is reproducible from a *fresh* menu, capture exactly what they tapped and
check the logs for that chat.

## 5.4 The sync refused to run

That is the damage limit working. A sync that would deactivate more than a fifth
of the active rows stops and changes nothing, because somebody clearing the roster
tab by accident must not mean 1,800 teachers cannot sign in.

Look at the sheet first. A filter left applied and a half-finished paste both look
exactly like this. Once it is right, the next sync recovers on its own.

If the removal really is genuine:

```bash
docker compose exec worker node dist/scripts/sync-sheets.js --force
```

The override is recorded against the sync run, so it cannot pass unnoticed.

## 5.5 An alarm says a job has stopped

```bash
docker compose logs --tail 100 worker
docker compose restart worker
```

The alarm fires on last **success**, not last failure, and repeats no more than
hourly while a job stays down. A job that fails is noisy and will be noticed; a
job that stopped being scheduled at all is silent, which is exactly what this
alarm exists to catch.

## 5.6 An alarm says an urgent code was spent with no case

**Telephone that teacher.** Their emergency has not reached anyone.

Under the current design this cannot happen — the code and the case are written in
one transaction — so if it has, something has written to `urgent_codes` outside
the normal path. The alarm names the code and the chat.

## 5.7 An alarm says a teacher was not told what happened

Whatever they did **succeeded** — the database committed — but the reply did not
reach them, so from their side the bot ignored them. The alarm carries the chat id
and the message that failed.

If it was a case, it exists and Check My Case will show it. Tell them so.

## 5.8 Restore from backup

Last resort, and it loses everything since the dump.

```bash
./deploy/restore-drill.sh
```

Prove the backup is good **first**, then restore for real following
`deploy/README.md`. Restoring is not a rollback for a bad deploy — for that, check
out the previous tag and rebuild (2.2).

---

# PART 6 — Not built yet

Listed so nobody goes looking for them.

| | Arrives with |
|---|---|
| **Staff case commands** — view, reply, assign, note, close, reopen, search | The next stage. Until then a case can be filed and only read directly from the database |
| **Staff management and permissions** | The next stage |
| **Issuing urgent codes by command** | The next stage. By hand until then (4.4) |
| **Notifying the right staff member of a new case** | The next stage — choosing who to tell needs the permission model |
| **Announcements, and the daily overdue digest** | The stage after |
| **The retention clean-up job** | The stage after — and it needs a retention period first (Part 1) |
| **Document upload** | Later. The only genuinely new feature in the rebuild |
| **Russian and Uzbek** | Not scheduled. The interface is built so that translating it is a display change, with no effect on how buttons route |

---

## Where everything else is

| | |
|---|---|
| `deploy/README.md` | Server setup, step by step |
| `BOT-SPEC.md` | What the system does, and why each decision was made |
| `CONCERNS-AND-IT-ACTIONS.md` | Accepted risks, and what still needs a person |
| `src/config/privacy.ts` | The privacy notice teachers are shown |
| `FAQ-import.csv` | The approved answer bank — **confidential** |
