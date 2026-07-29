# MoPSE Teacher Support Bot — Runbook

**Version:** 3.0 · **Date:** 2026-07-29 · Updated after the staff stage

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

## 1.2 What is now built, and what still stands between here and launch

**The staff half exists.** A teacher can sign in, read answers, open a case and
escalate an emergency; a staff member can now see that case, answer it, ask the
teacher for something, close it, reopen it, note it, assign it, judge how serious
it is, put a date on it, correct the teacher's region, end and return a teacher's
access, manage who is staff at all, pause new cases and issue an urgent code. A
new case now reaches the people who can work it, which it never did before.

So the sentence that used to be here — *"nobody can reply to that case through the
bot"* — is no longer true, and the launch gate has moved off engineering.

**What still stands between here and launch is on the checklist in 1.4, and none
of it is code.** The two heaviest are the ones with the longest lead times: a
proven backup restore, and the retention work below.

## 1.3 The decisions — all four answered

**Every decision this document has asked you for is now settled.** They are
recorded here as answers rather than questions, because the reason for a decision
is worth more than the decision.

### ✅ 1. How long records are kept — decided 29 July

| What | Kept |
|---|---|
| A case that is **not resolved** | **For ever** |
| A resolved case | **7 days** after it was closed |
| A resolved case marked **Urgent** or **Critical** | **180 days** after it was closed |
| The message log | **3 days** |
| The audit trail | **Never removed** |

Answered in time — before the bot has served anybody, which was the whole point of
the deadline.

The three periods are **settings**, so MoPSE changes them without a deployment.
That was your choice against the opposite recommendation, and it made the design
cleaner rather than harder: the privacy notice is generated from those settings,
so a number and the sentence teachers read about it cannot disagree. §4.11 is how
to change one, and it is worth reading before you do.

**Two consequences, both real.** A week after a case is closed its reference stops
working — a teacher telephoning about `VISA-2026-00123` gets "no such case", and
there is nothing to reopen. And a three-day message log kills the monthly content
review that used to run thirty-day queries over it; §4.7 has been deleted rather
than left to return empty results that look like good news. Getting that signal
back means a nightly count taken before the delete, which is Stage 5 work and your
call.

**Nothing built so far deletes anything.** The job, the settings and the rewritten
privacy notice ship together in the next stage, because a notice promising
deletion that nothing performs is false in the other direction. That release also
has to ask all 1,800 teachers to read the notice again — the current one promises
exactly that.

### ✅ 2. How a removal request is honoured — answered, and the question was wrong

This used to say the database refuses to delete a teacher who has opened a case,
and that this blocked the removal promised in the privacy notice.

**The first half is true and the conclusion was not.** The safeguard refuses to
delete a *teacher* who still has cases. It never obstructed deleting a **case**,
and the notes on a case are removed with it automatically. So the retention above
deletes cases outright, which is what "removed after seven days" means.

Anonymisation — replacing the name and the address, keeping the case — is what a
teacher's *own* removal request needs, and it is a smaller job than this question
implied. It ships with the retention work.

### 🟠 3. Does the privacy notice say the right things?

The wording is drafted and **has not been reviewed by anyone at MoPSE**. It states
what is held, who can see it, and how to ask for removal. Every teacher reads it
before they sign in, and the version each teacher accepted is recorded against
their record — so a later revision does not quietly erase the meaning of every
earlier consent.

*What we need:* someone who can speak for MoPSE to read `src/config/privacy.ts`
and either approve it or say what to change.

**This is now more urgent than it was**, because the notice has to be rewritten
anyway for the retention periods, and every teacher has to be asked to read it
again. Reviewing it before that rewrite means one round of re-consent instead of
two.

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

If they do, that habit changes: replying, assigning and closing are bot commands
now. That is retraining rather than code, and §4.6a and §4.6b are what to train
them on.

**The `ADMINS` tab in particular no longer does anything.** It used to grant
administrator rights to whoever was typed into it. Permissions now live on the
server, and the only way to give somebody staff access is `/staff_add`. If the old
spreadsheet is being reused, delete that tab — a tab that looks like it works and
does not is worse than no tab, and this is the one somebody will reach for.

## 1.4 The launch checklist

Everything here blocks launch. None of it is engineering work.

| | What | Why it blocks |
|---|---|---|
| ☐ | **A real support contact** | The bot refuses to start without one, so it can no longer be forgotten. Every dead end in the bot names it |
| ☐ | **The teacher roster** in the spreadsheet | Without it nobody can sign in, and no case can be opened |
| ☐ | **At least two named System members** | So one person leaving cannot lock everyone out. The first is one line of SQL (§2.5); the second is `/staff_add` from the first one's account |
| ☐ | **An operations group chat** for alarms | Use a group, not one person's private chat — one person on leave should not mean nobody is watching. **Set `OPS_ALERT_CHAT_ID` before adding the bot to the group**, or it will leave, correctly |
| ☐ | **A proven backup restore** | The scripts are written and have never been run against a real server. An untested backup is a belief, not a capability |
| ☐ | **The privacy notice reviewed** by somebody who can speak for MoPSE | Decision 3 above, and it has to be rewritten for the retention periods anyway |
| ☐ | **A named owner for FAQ content**, and a review interval | 112 answers about salary, visas and contracts will drift, and nothing in the system flags a stale one |
| ☐ | **Staff who know the four case words** | §4.6a. "Action required" in particular means *the teacher* must act, and reading it the other way sends work to the wrong person |

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
A filed case reaches the staff who can work it, and a case nobody can see raises
an alarm instead of sitting unnoticed. Nobody can grant themselves staff access by
typing into a spreadsheet. All of it is covered by tests that run against a real
database.

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

These live in the `settings` table rather than in `.env`, because they must be
changeable without a deploy:

| Key | What it does | If unset |
|---|---|---|
| `MAINTENANCE_MODE` | Pauses new cases. The FAQ and Check My Case stay live | off — and `/maintenance` is how to change it now, not SQL |
| `OVERDUE_DAYS` | Days before an untouched open case is called overdue | **the overdue half of `/urgent` says it is switched off**, rather than showing an empty list |
| `CASE_RETENTION_DAYS` | Days a resolved ordinary case is kept | **nothing is deleted** |
| `URGENT_CASE_RETENTION_DAYS` | Days a resolved Urgent or Critical case is kept | **nothing is deleted** |
| `MESSAGE_RETENTION_DAYS` | Days the message log is kept | **nothing is deleted** |

The three retention keys **are read by nothing yet** — the job that reads them
ships in the next stage with the rewritten privacy notice. Seed them at launch:

```sql
INSERT INTO settings (key, value) VALUES
  ('OVERDUE_DAYS', '3'),
  ('CASE_RETENTION_DAYS', '7'),
  ('URGENT_CASE_RETENTION_DAYS', '180'),
  ('MESSAGE_RETENTION_DAYS', '3')
ON CONFLICT (key) DO UPDATE SET value = excluded.value;
```

**Unset means delete nothing, in every case.** That is the safe direction and it
is deliberate — a job that invents a retention period deletes real records against
a number nobody chose, and there is no undo. It is also why an unseeded system
will look like the retention feature is not working: it is working, and it has
been told to keep everything. §4.11 is how to change one afterwards, and it is
worth reading first.

`OVERDUE_DAYS` follows the same rule for the same reason: unset, the overdue half
of `/urgent` says plainly that nothing is being measured rather than showing an
empty list. "Nothing is overdue" and "nobody has said what overdue means" are the
same empty list and opposite conclusions.

Changes are picked up within a minute.

## 2.5 The first System member — one line of SQL, on purpose

**There is no command for this and there is not meant to be.** Every staff command
requires System rank, so the first row cannot come from inside the bot.

Run it over the SSH tunnel, before anything else:

```sql
INSERT INTO staff (telegram_id, name, role, queue, added_by)
VALUES ('<their telegram id>', '<their name>', 'System', 'All', '0')
ON CONFLICT (telegram_id) DO NOTHING;
```

The telegram id is the numeric chat id, not the `@name`. The simplest way to get
it is to have that person send the bot `/start` first and read it out of the
`teachers` table, or use any of the "what is my id" bots.

**Then add the second System member from the first one's account:**

```
/staff_add <their telegram id> System All
```

**Why this is a hand edit rather than a setup command.** Every automated
alternative is a permanent back door. An environment variable granting System
access hands the whole permission model to whoever can edit a file — which is
precisely what moving permissions off the spreadsheet was for. A "first caller
becomes System" rule is a race with the public internet. The old system's answer
was a hand edit of a spreadsheet tab anybody with the link could open; this
version's hand edit needs server access, and that is the improvement.

**Two people, not one.** The bot refuses to remove or demote the last active
System member, so you cannot empty the rank by accident. But if that single
account is lost — a phone, somebody leaving — the recovery is another trip to the
database.

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

From a **System or Support** account, type:

```
/generate_urgent_code
```

Expect a six-character code and an expiry. Write it down — it is shown once and
nothing can display it again.

Tap **🚨 Urgent Case** from the test account and type `WRONG1`. Expect a refusal
that does not say why.

Type the code you were given. Expect "Code accepted" — and confirm it has **not**
been spent:

```sql
SELECT used_at FROM urgent_codes ORDER BY issued_at DESC LIMIT 1;   -- must be NULL
```

Now type the emergency description. Expect a case marked urgent, and:

```sql
SELECT used_at, used_by, case_reference, issued_by
FROM urgent_codes ORDER BY issued_at DESC LIMIT 1;
```

All four must be set, and `issued_by` must be the staff member's chat id rather
than `0`. A spent code always names the case it bought and the person who issued
it.

### 7a. A staff member can actually answer the case

The step that could not exist before the staff stage. From the staff account:

```
/cases
/case <the reference from step 4>
/reply <the reference> your visa is with the embassy and should be ready Friday
```

Expect three things: the case appears in `/cases`, `/case` shows what the teacher
wrote, and **the teacher's chat receives the reply**. Then tap **Check My Case**
from the teacher account and expect the same words there.

```
/close <the reference> issued and collected
```

Expect the teacher to be told, and the case to leave `/cases`.

### 7b. The bot refuses to work in a group

Add the bot to any group **other than the operations chat**. Expect it to leave
immediately and say nothing.

Then type anything in the **operations chat**. Expect no reply at all, and the bot
to still be there. Both halves matter: it must stay where the alarms go, and it
must not try to hold a conversation there.

### 8. A duplicate sign-in is reported

From a **second** Telegram account, sign in with `deploy-check@mopse.uz`.

Expect four things: the second account signs in successfully, the first account
receives a security notice, **the operations chat receives an alert**, and **every
System member receives the same alert in their own chat**.

**If the alert does not arrive in the operations chat, the deployment is not
finished.** Every alarm this system raises travels that path — a refused sync, a
stopped job, a teacher who was never told what happened. Check
`OPS_ALERT_CHAT_ID`, and that the bot is a member of the group.

If it arrives in the group but not in a System member's own chat, that person has
never opened a chat with the bot. Have them send it `/start` once. The group is
the one that blocks the deployment; the personal copies are an addition to it, not
a replacement.

### 9. Clean up

```sql
DELETE FROM cases WHERE teacher_chat_id = '<the test chat id>';
DELETE FROM urgent_codes WHERE used_at IS NULL AND case_reference IS NULL;
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

## 4.3 Ending and returning a teacher's access

**There are two ways a teacher loses the bot, they look identical from the
teacher's side, and only one of them has an undo in the bot.** Getting this
backwards is how an operator loses an afternoon, so it is worth reading both.

**By command:**

```
/revoke <their chat id>
/restore <their chat id>
```

`/revoke` records who did it and when, which a spreadsheet edit cannot. It tells
you how many open cases they have — worth knowing, because a staff member can
still send a reply to somebody who can no longer open the bot to read it.
`/restore` is at the same rank on purpose: whoever can make the mistake can undo
it without asking somebody more senior, because a recovery that needs a second
person is a recovery that waits until Monday.

Neither messages the teacher. The bot tells them their access has ended, with the
support contact, the next time they use it. If somebody was revoked by mistake and
told about it, tell them it is back.

**By the spreadsheet:** set their roster row inactive, or delete it. Either works
— the sync deactivates rather than deletes — and it takes effect on their next
message. Restoring the row restores access within ten minutes, silently. It is
only visible in the sync history, so if you revoke somebody this way deliberately,
write down that you did.

> ### The one thing `/restore` cannot fix
>
> **A teacher whose roster row was deactivated or removed is not "revoked", and
> `/restore` will not help them.** Their record still says they are verified; they
> fail at the gate because the bot re-checks the recruitment spreadsheet on every
> action. The fix is recruitment putting the row back.
>
> `/restore` knows this and says which of the two it found — "restored, and they
> can use the bot again" against "restored, but their roster row is inactive". If
> you see the second one, stop looking at the bot and go to the spreadsheet.
>
> `/restore` on somebody who was never revoked at all says so and changes nothing.

## 4.4 Issuing an urgent code

```
/generate_urgent_code
```

Available from Support rank upward, deliberately: the person a teacher telephones
in an emergency is whoever is on the support desk, and a code that needs a manager
to authorise is a code that arrives after the emergency.

Give it to the teacher **by phone or in person**, never through the bot — sending
it through the bot defeats the point.

**It is shown once and nothing can display it again.** Issue another if it is
lost; the first simply expires unused. There is no command to list codes, and
that is on purpose — one would turn every staff account into a way of reading all
of them.

The code is recorded against your name, which matters more than it sounds: if a
code is ever spent without producing a case, the alarm names whoever issued it so
somebody can telephone that teacher.

What the teacher gets for it: their case is filed as escalated, or — if they
already have an open case — that case is escalated and their new words are added
to it rather than a second case being opened.

**The code is spent when their case is filed, not when they type it.** A teacher
who starts and gives up keeps their code. It lasts 48 hours.

Five wrong codes from one chat within an hour pauses that chat for an hour. It
clears itself; nobody has to release it.

## 4.5 Pausing new cases

```
/maintenance on
/maintenance off
/maintenance          — says which it currently is, and changes nothing
```

System rank only. It takes effect on the next message rather than within a minute.

This stops **new cases only**. The FAQ and Check My Case stay live on purpose: a
teacher looking up an answer is not creating work for anyone, and turning the
whole bot off would tell them nothing at all. Teachers who try to open a case are
told it is paused and given the support contact.

> **Cases will keep arriving for a while afterwards, and that is correct.** A
> teacher already part-way through writing one is deliberately not interrupted —
> stopping them there would throw away what they had typed and an urgent code they
> had already spent. The confirmation says so. Do not report the trickle as a
> fault.

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

## 4.6a The four words staff type, and what each one means

Staff type four words. The system writes the rest of a case's history itself.

| Type this | The case becomes | Means |
|---|---|---|
| `/reply <ref> <message>` | **Under review** | We have it and we are working on it. The teacher receives your message |
| `/await <ref> <what you need>` | **Action required** | **The teacher must do something** before this can move. They receive your request |
| `/close <ref> <message>` | **Completed** | Their problem is solved. They receive your message |
| `/close <ref> unresolved <reason>` | **Closed** | Shut without being solved. Your reason goes on the case, **not** to the teacher |

> ### "Action required" means the teacher must act
>
> Not us. It is a **request to the teacher, never a note to ourselves.**
>
> The phrase reads both ways to anybody meeting it cold, and the wrong reading
> sends work to the wrong person: a case sitting in "Action required" is waiting
> on the teacher, so chasing the staff member about it chases somebody who is
> correctly doing nothing.
>
> Whatever you type after `/await` **goes to the teacher**, so write it to them:
> *"please send a photograph of the passport page with your visa on it"*, not
> *"waiting on passport"*.
>
> **A list of action types is coming** — send a document, attend an appointment,
> confirm an address. Until then this is free text and nothing pretends otherwise.
> Whoever builds that list should find this decision here rather than inventing a
> second one.

**Why two ways to close.** The difference between *we fixed it* and *we gave up*
is the single most useful thing a later reader can know, and it disappears if both
write the same word. Use `unresolved` for a teacher who has left the country,
stopped replying, or withdrawn the request. The reason is required, it is your own
words rather than a list to pick from, and it goes to a note on the case — the
teacher is told their case is closed and how to raise it again, not why. That is
deliberate: sending a blunt internal judgement to a teacher would either be unkind
or teach staff to write nothing useful.

**The other four statuses nobody types.** *New* is written when the case is filed.
*Received* when it actually reaches a staff member. *Escalated* by the urgent-code
path. *Duplicate* by the rule that stops a teacher opening the same case twice in
a day.

## 4.6b The rest of the staff commands

Type `/whoami` to see everything your own rank allows, and `/help` for the same
list in context. Both are generated from the permission rules themselves, so they
cannot describe access you do not have.

**Reading cases**

| | |
|---|---|
| `/cases` | Open cases in your queue and region |
| `/cases unassigned` | The ones nobody has picked up — the standing backlog |
| `/mycases` | Open cases assigned to you |
| `/urgent` | Escalated cases, and separately, cases nobody has touched |
| `/case <ref>` | One case in full, including what the teacher wrote |
| `/search <text>` | Reference or the teacher's own words, including closed cases |

**Working a case:** the four words in §4.6a, plus

| | |
|---|---|
| `/note <ref> <text>` | Internal. **No teacher ever sees these** |
| `/reopen <ref>` | Back to Under review. The teacher is not messaged |
| `/assign <ref> <chat id>` | Give it an owner. Refuses somebody who cannot see it |
| `/mark <ref> Normal\|Urgent\|Critical` | How serious it is. **This is what keeps a case for six months instead of seven days** |
| `/due <ref> <date>` | When you said it would be done. `2026-08-15` or `15 Aug 2026` |
| `/snooze <ref> <days>` | Stop chasing it for a while. It stays open and stays yours |

**People**

| | |
|---|---|
| `/region <chat id> <region>` | Correct a teacher's region — §4.10 |
| `/regions` | Teachers who have told us their region is wrong |
| `/revoke` `/restore` | §4.3 |
| `/staff` `/staff_add` `/staff_role` `/staff_remove` | Who is staff — System only |
| `/maintenance` | §4.5 — System only |
| `/generate_urgent_code` | §4.4 |

**A case reference is always the first thing after the command.** `/reply` with no
reference is refused rather than guessed at, because the recoverable outcome is
being asked for one and the unrecoverable one is a teacher receiving an answer
meant for somebody else.

**You can only act on cases you can see.** Every command that changes a case
checks that first, so a queue or region you do not hold is not reachable by typing
a reference into it.

## 4.7 The monthly content review — **removed, and this is what replaced it**

There used to be a monthly review here. It ran two thirty-day queries over the
message log to find out what teachers were asking that the answer bank could not
cover, and which confident answers they were rejecting — described in this
document as the strongest signal available, because an answer the bot was *sure*
about and got wrong is the one most worth fixing.

**The message log now keeps three days.** Both queries would return nothing, every
month, for ever — and an empty result from a review reads exactly like a system
with no problems. That is the failure this whole rebuild exists to remove, so the
instructions are deleted rather than left to quietly stop working.

**Nothing replaces it yet, and that is a real loss rather than a tidy-up.** Two
questions are now unanswerable beyond three days: what teachers are asking that
the answer bank cannot cover, and which confident answers they are rejecting.

**Getting it back does not mean a longer retention period.** It means a nightly
count taken *before* the delete — no teacher's words kept, just "this answer was
rejected fourteen times in October". That is next-stage work and it is the head of
project's to ask for. It is written down here so nobody discovers the gap by
running a query in November and reading the empty result as good news.

Reviewing the *content* on a cadence still matters (`CONCERNS` A6). What is gone
is the evidence this document used to tell you to gather.

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

## 4.10 Correcting a teacher's region

Region decides **which staff see that teacher's case**, so it is a permission
setting rather than a detail.

```
/region <chat id> <region>       sets it
/region <chat id> clear          back to whatever the spreadsheet says
/regions                         teachers who say theirs is wrong
```

The chat id is on `/case`, next to the teacher's name.

**Correcting the spreadsheet now works, and it never did before.** A region was
read once, when the teacher signed in, and a teacher who has signed in never signs
in again — so recruitment's corrections reached nobody who was already using the
bot. That is fixed: the spreadsheet is read live, and a correction arrives on the
next sync.

**`/region` is for when the spreadsheet is not the right answer** — a teacher who
has actually moved, where recruitment's record is correct for recruitment's
purposes. It writes a decision on our side and **never touches the spreadsheet**;
`clear` removes it and hands the teacher back to whatever recruitment says, which
is also how you undo a typo.

Three things it refuses, each for a reason:

- **A region nobody has heard of.** A typo would put the teacher in a province no
  staff member covers — their cases visible only to all-region staff, routed
  nowhere, and wrong in a way nothing reports. It lists the real names instead.
- **Moving a teacher across a boundary you do not hold** — including moving one
  *out* of a region you do not hold, which is the same act seen from the other
  side. Ask somebody who covers both; Program and System cover all of them.
- Nothing at all, if the teacher already has that region. It says so.

**`/regions` is a teacher's report, not a change.** When the bot asks a teacher
whether the region it holds is still right and they say no, it raises a flag and
writes nothing. They are deliberately **not** asked where they are now: a menu of
regions is a menu of whose emergency this becomes, and a wrong tap sends it to the
wrong province. Ask them, then use `/region`. The report leaves the list the
moment somebody acts.

## 4.11 Changing a retention period

**These are not ordinary settings. They govern deletion and there is no undo.**
Read this before typing one.

| Key | Governs | Launch value |
|---|---|---|
| `CASE_RETENTION_DAYS` | A resolved ordinary case, from the day it was closed | 7 |
| `URGENT_CASE_RETENTION_DAYS` | A resolved case marked Urgent or Critical | 180 |
| `MESSAGE_RETENTION_DAYS` | The message log | 3 |

A case that is **not** resolved is kept for ever and none of these touch it. The
audit trail is never pruned at all.

```sql
INSERT INTO settings (key, value) VALUES ('CASE_RETENTION_DAYS', '14')
ON CONFLICT (key) DO UPDATE SET value = excluded.value;
```

**Two rules, and the second is the expensive one.**

**Unset means delete nothing.** Removing a key does not restore anything already
deleted — it only stops further deletion. There is no way back for a record that
has gone.

**Lengthening a period requires every teacher to read the privacy notice again.**
Keeping data longer than people were told is a change to what they agreed to.
Shortening one does not: deleting sooner than promised breaks no commitment, and
putting 1,800 people through a re-consent to be told their data goes sooner is a
cost with nobody benefiting.

The notice teachers read is **generated from these values**, so it always states
what the system will actually do. That is the whole reason these are settings
rather than numbers in the program — a settings row and a typed sentence can
disagree, and a generated one cannot.

Every change is recorded against whoever made it. "Who shortened this to one day,
and when" is an audit question.

**The consequence you will meet first**, in week two: a week after a case is
closed its reference stops working. A teacher telephoning about `VISA-2026-00123`
gets "no such case", and `/reopen` has nothing to reopen.

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
| **Announcements to teachers in bulk** | The next stage. The permission already exists, so that stage adds a command rather than a permission model |
| **Exporting case records** | The next stage, for the same reason. It also needs the bot to be able to send a file at all, which it cannot do today |
| **The daily overdue digest, and chasing a missed date** | The next stage. Both queries exist and are tested; what is missing is the schedule. `/urgent`, `/due` and `/snooze` are the same information asked for by hand |
| **The retention clean-up job** | The next stage, together with the rewritten privacy notice and asking every teacher to accept it again. All three ship in one release or the notice is false in one direction or the other |
| **Anonymising a teacher who asks to be removed** | The next stage, with the retention work |
| **Reading the audit trail from a command** | Deliberately never. It is read by somebody with database access during an investigation, and a command to read it would need its own permission model to avoid becoming the thing it audits |
| **A list of "action required" types** | Later. Until then `/await` carries free text — §4.6a |
| **Document submission** | Later, and **through the existing Google Forms rather than the bot.** An earlier version of this document called Telegram upload "the only genuinely new feature in the rebuild"; that direction was reversed. The bot will never accept or store a file. What arrives is a third spreadsheet tab holding the form links, with submissions matched to teachers by their recruitment email — the same identity check as signing in, and stronger than the old system's editable hidden field |
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
