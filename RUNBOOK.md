# MoPSE Teacher Support Bot — Runbook

**Version:** 4.1 · **Date:** 2026-07-31 · Updated after the documents stage

> **What changed in 4.1, and two of them are new sections you should know exist.**
>
> **§5.0 indexes every alarm the bot can send** — all eighteen, quoted exactly as
> they arrive in the operations chat, with what each means and what to do. Before
> this, only four could be found in this document by the words you would actually
> be holding.
>
> **§4.18 is how a document form gets published**, step by step, and two of its
> steps fail silently if you get them wrong.
>
> Also: §2.6 gains three things somebody has to set by hand, §1.5 says teachers
> can now submit documents, and the launch checks gain numbers 13 and 14.

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
access, manage who is staff at all, pause new cases and decide whether a case is
treated as urgent. A new case now reaches the people who can work it, which it
never did before.

So the sentence that used to be here — *"nobody can reply to that case through the
bot"* — is no longer true, and the launch gate has moved off engineering.

**The system now also acts without being asked.** Records past their retention
period are deleted at two in the morning; each staff member gets their own list of
what is late at seven; a teacher whose case is waiting on them is reminded, three
times and then no more; MoPSE can reach every teacher at once with an
announcement; a teacher who asks to be removed can be; and a teacher who does not
know who to talk to can ask who covers their region. §4.12 lists what happens on
its own and when.

**What still stands between here and launch is on the checklist in 1.4, and none
of it is code.** The two heaviest are the ones with the longest lead times: a
proven backup restore, and a review of the privacy notice. **Read §2.6 as well** —
it is the single list of everything a person has to type in, none of which
announces its own absence.

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
than left to return empty results that look like good news. **The replacement — a
nightly count taken before the delete — was offered on 30 July and declined**, and
§4.7 now records that so the gap reads as a decision. It remains available.

**✅ Built, and all of it deploys together.** The nightly deletion job, the three
settings, the notice generated from them, the new wording, and the gate that asks
every teacher to read it again. §4.11 is how to change a period afterwards.

**One thing must happen at launch or none of it does anything:** the three periods
have to be entered. Until they are, the job runs every night and deletes nothing,
and the notice truthfully tells teachers their records are kept until the Ministry
sets a period. §2.6 lists this alongside everything else somebody has to type in.

### ✅ 2. How a removal request is honoured — answered, and the question was wrong

This used to say the database refuses to delete a teacher who has opened a case,
and that this blocked the removal promised in the privacy notice.

**The first half is true and the conclusion was not.** The safeguard refuses to
delete a *teacher* who still has cases. It never obstructed deleting a **case**,
and the notes on a case are removed with it automatically. So the retention above
deletes cases outright, which is what "removed after seven days" means.

Anonymisation — replacing the name and the address, keeping the case — is what a
teacher's *own* removal request needs, and it is a smaller job than this question
implied.

**✅ Built.** `/forget` does it, restricted to a System member because it has no
undo. §4.15 is the procedure, and it states plainly what cannot be removed — the
chat id, and what the teacher wrote inside their cases, which retention clears on
its own. Whoever replies to the teacher needs that sentence, not "removed".

### 🟠 3. Does the privacy notice say the right things?

The wording is drafted and **has not been reviewed by anyone at MoPSE**. It states
what is held, who can see it, and how to ask for removal. Every teacher reads it
before they sign in, and the version each teacher accepted is recorded against
their record — so a later revision does not quietly erase the meaning of every
earlier consent.

*What we need:* someone who can speak for MoPSE to read `src/config/privacy.ts`
and either approve it or say what to change.

**This is now the most urgent thing on the list, and the window is closing.** The
rewritten notice and the gate that shows it to every teacher are both built and
waiting to deploy. **Reviewing it before that deploy means one round of re-consent.
Reviewing it afterwards means two** — 1,800 people asked to read it, and then
asked again.

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
| ☐ | **The privacy notice reviewed** by somebody who can speak for MoPSE | Decision 3 above. **Now urgent:** the rewritten notice and the gate that shows it are both built, so reviewing it before this deploy means one round of re-consent instead of two |
| ☐ | **The three retention periods entered** | §2.4. Unentered, nothing is ever deleted and the notice tells teachers exactly that |
| ☐ | **Everything else in §2.6** | The one list of what a person has to type in. None of it announces its own absence |
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
- **Ask who covers their region**, and be given that person's name — and a
  tappable Telegram link if they have published one. Available without signing in,
  because somebody who cannot sign in and needs a person is exactly who asks
- **Be reminded** when a case is waiting on them, up to three times
- **Receive an announcement** from the Ministry

They will also, once, **be asked to read the privacy notice again** before Contact
Support, Ask for Priority or Check My Case. One tap, and it puts them back on what
they were doing. The answer bank and `/privacy` are left open deliberately.

They can **submit documents**, through Submit Documents on the menu. It gives them
a link to a Google Form; the bot never receives the file itself. What comes back
is a case saying they submitted, so it can be tracked and so they can see it in
Check My Case. §4.18 is how a form is published.

**What they cannot do:** send a file to the bot in chat, or use it in Russian or
Uzbek. Both are absent deliberately rather than half-built — offering either would
send a teacher who had just signed in to a dead end. A photo or file sent in chat
is refused with a message pointing at Submit Documents.

## 1.6 Honest risk summary

**Genuinely better than the old system.** A case cannot be filed twice by a double
tap. A teacher's conversation survives a restart. A teacher who needs their case
looked at quickly no longer has to telephone for a code before they may speak. A
scheduled job
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

**The three retention keys are now read every night, and this is the one insert
that must happen before the first teacher is served.** Unseeded, the nightly job
runs and deletes nothing, and the privacy notice correctly tells every teacher
that their records are kept until the Ministry sets a period — which is true, and
is not what anybody intends after this release. The job says so in the operations
chat once a night until they are set. Seed them at launch:

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

## 2.6 Everything that has to be set by hand — the one list

**Read this before launch and again after it.** Everything below is something a
person has to enter; nothing here arrives by itself, and **not one of these
announces its absence by breaking.** The bot runs perfectly with every one of them
missing. It simply answers less, or answers nothing, and looks entirely healthy
doing it — which is the exact failure this whole rebuild exists to remove.

| What | How | If it is never done |
|---|---|---|
| **The three retention periods** | §2.4's insert, or `/retention` | Nothing is ever deleted. The notice tells teachers their records are kept until the Ministry sets a period, which is then true |
| **The regions each staff member covers** | `/staff_add` at the time, or **`/staff_region <chat id> <regions>`** at any point afterwards | **See below — this is the one with a wrong-looking answer rather than no answer** |
| **The two System members** | §2.5 | Nobody can add staff, set a period, remove a teacher, or take an export |
| **The operations chat** | `.env`, before the first deploy | Every alarm in this document goes nowhere |
| **The support contact address** | `.env` | Teachers are given a blank where an address should be |
| **Each staff member's Telegram handle** | `/username`, by that person, for themselves | Teachers asking who covers their region are shown a name and the support address, and cannot tap through. This is a degradation, not a fault |
| **The FAQ answers and the teacher roster** | The spreadsheet, synced every ten minutes | The bot can answer nothing and nobody can sign in |
| **The `FORMS` tab** | The spreadsheet, synced every ten minutes | Submit Documents says "there are no document forms available at the moment" to every teacher. The button still appears |
| **Each form's responses linked into the same spreadsheet** | §4.18 — and this is the one with a procedure of its own | Teachers can still submit. **Nothing is read back**, so no case is filed, nobody is chased, and no alarm sounds — because from the bot's side nothing has happened |
| **The word "email" in each form's email question, and in no other question** | When the form is built. §4.18 | That form's responses are refused whole, with an alarm naming it. **This one does complain** |

> **One set is deliberately not on this list, and you still have to set it.**
> `BACKUP_PASSPHRASE`, `BACKUP_REMOTE` and `BACKUP_DATABASE_URL` live in
> `.env.example` and `deploy/README.md`. They are absent above because they fail
> **loudly** — `backup.sh` refuses to run and names the one that is missing, which
> is the opposite of everything in this table. But an unset backup is still an
> unset backup, and `CONCERNS-AND-IT-ACTIONS.md` **A5 calls proving the restore a
> launch blocker.** §4.9.

### The regions, specifically — this one is being done later, on purpose

**Region details are added manually, after launch.** That is a decision, not an
omission, and it has one consequence worth understanding before somebody reports
it as a bug.

A staff member with **no regions set covers every region.** An empty list means
everywhere, deliberately — it is what lets a small team work the whole country
without anybody filling in a form. So until the regions are entered, every staff
member covers all of Uzbekistan, and the question *"who covers my region?"* is
answered by **rank alone**: a teacher is shown the most junior person who can act
on cases, wherever that person actually sits.

That is a reasonable answer and it is not the right one. Once the regions are
entered, whoever explicitly names the teacher's region is preferred over anybody
covering all of them, and rank only breaks the remaining tie.

**Entering them is `/staff_region`, one person at a time:**

```
/staff_region 991001 Tashkent, Samarkand
/staff_region 991001 clear
```

Region names are checked against the ones teachers are actually in, so a typo is
refused with the real list rather than quietly putting somebody in a region that
does not exist. `clear` puts them back to covering everywhere, and is spelled out
rather than implied by an empty line — "everybody sees everything" is a real
configuration, but not one to arrive at by pressing enter.

> **This command did not exist until 31 July 2026, and this page said it did.**
> Regions could be set at `/staff_add` and never changed, which meant the plan
> above — add staff now, set regions later — could not actually be carried out.
> Recorded because the failure had no symptom: nobody would have got an error,
> everybody would simply have kept seeing the whole country.

Two smaller things follow from the same rule, and both are worth knowing while
the regions are still blank:

- **`/announce region:Bukhara` still works**, because an announcement's audience
  comes from the *teachers'* regions on the roster, not from staff regions.
- **Case visibility is unrestricted** while every staff member covers everywhere.
  Nobody is seeing anything they should not — the rule is doing exactly what it
  was told — but the region half of it is not being exercised, so a mistake in it
  would not show up until the day the regions are entered.

**Uzbekistan has regions and districts. This bot is concerned with regions only**
— it has no concept of a district and no plans for one, and any wording anywhere
saying "region" is wrong and should be corrected to "region".

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

### 7. A priority request is granted by a person, and only by a person

Tap **⏫ Ask for Priority** from the test account. **You should be asked to
describe the problem immediately** — there is no code to type, and if you are
asked for one, the deploy is running old code.

Type a description. Expect a reply that names a case reference and says a
regional coordinator will decide. Then confirm the request has **not** granted
itself:

```sql
SELECT importance, status, urgent_requested_at IS NOT NULL AS asked,
       urgent_confirmed_at
FROM cases ORDER BY created_at DESC LIMIT 1;
```

`importance` must be **`Normal`**, `asked` must be true, and `urgent_confirmed_at`
must be NULL. This is the check that matters most on this page: importance is
what buys a case 180 days of retention instead of seven, so a request that marked
itself urgent would hand every teacher six months of retention for one tap.

Now switch to a **System or Support** account. You should have received a message
naming the teacher, their identifier and their region, with a **⏫ Confirm
urgent** button. Tap it. Expect:

```sql
SELECT importance, status, urgent_confirmed_by FROM cases ORDER BY created_at DESC LIMIT 1;
```

`Urgent`, `Escalated`, and your own chat id. The teacher should have been told
separately.

Tap the same button again. It must say the case is already urgent and name who
confirmed it — **the teacher must not be told twice**, and:

```sql
SELECT count(*) FROM audit_log WHERE action = 'URGENT_CONFIRMED';  -- must be 1
```

Finally, `/urgent_pending` from the same account must now report nothing waiting.

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

### 9. A teacher is asked to accept the privacy notice again

**Only on the deploy that carries the retention release, and it reaches all 1,800
teachers, so it is worth proving on one.**

From the already-signed-in test account, tap **Contact Support**. The privacy
notice must arrive with the actual retention periods written into it — "7 days",
"180 days", "3 days" — and one tap must return the teacher to the topic picker
rather than to the main menu.

Tap Contact Support a second time. **The notice must not appear again.**

The FAQ must be untouched by this: tap it before accepting and the answer bank
must open normally. It is deliberately left open.

### 10. An announcement reaches one person before it reaches 1,800

**Do this before anybody addresses the whole country.** Address a region holding
only the test teacher:

```
/announce region:<the test teacher's region> This is a test, please ignore.
/announce_send <id>
```

Within about a minute the test account receives it. The sender receives a report
naming one delivered. If the report does not arrive, the sweeper is not running —
check the operations chat for a stopped-job alarm.

### 11. An export contains no teacher's words

```
/export
```

Open the file. It must contain your visible cases and **must not contain a column
holding what the teacher wrote.** If it does, stop and read §4.16 — that is not a
column somebody adds.

### 12. A teacher is shown the right person, by the right handle

Set a handle on a staff account covering the test teacher's region with
`/username @handle`, then ask **"Who covers my region?"** from the test teacher's
main menu. The name must be right, and tapping the handle must open a chat with
that same person.

### 13. A document form reaches a teacher, and comes back as a case

**Only if the `FORMS` tab has been filled in.** If it has not, tap **📄 Submit
Documents** anyway: the correct answer at that point is *"there are no document
forms available at the moment"*, not an error and not an empty menu.

With at least one form published (§4.18):

1. From the test teacher's main menu, tap **📄 Submit Documents**. The forms you
   put in the sheet must be listed, in the order the sheet lists them.
2. Tap one. You must get its link, with a warning to use the same email address
   they signed in with.
3. Open that link and submit the form, **using the test teacher's recruitment
   email**.
4. Wait ten minutes, then run `/cases` as a staff member. A **Submit Documents**
   case must exist for that teacher, carrying a note naming the form.
5. Check the teacher's side: **Check My Case** must show it.

**Then submit the same form a second time** and wait another ten minutes. You
must still have **one** case, now with **two** notes. A second case means the
duplicate protection is not working and must be investigated before launch.

> **Also confirm nothing is filed twice on its own.** Leave it an hour and check
> the case count for that teacher has not grown. The bot re-reads the whole
> responses sheet every ten minutes, so a fault here shows as a case every ten
> minutes rather than as an error.

### 14. The bot refuses a file sent in chat

Send a photo or a PDF straight to the bot as the test teacher. It must refuse
politely and point at Submit Documents. **The bot never accepts, holds or stores
a file**, and this is the check that says so.

### The four that need a night or a morning to pass

These cannot be run in ten minutes. Run them on the first deploy of the retention
release and write down that you did.

1. **A closed case disappears on schedule.** Close a test case, set
   `/retention case 1`, wait for 02:00, and confirm the case and its notes have
   gone and the reference no longer resolves.
2. **A case marked Critical does not.** The same, with `/mark <ref> Critical`
   first. It must survive — this is the check that proves the deletion reads
   importance and not status, which is the difference between keeping an
   emergency for six months and treating every case alike.
3. **A promised date is chased.** `/due` a case to yesterday and confirm its owner
   is told at 07:00.
4. **A teacher at `Action required` is reminded.** `/await` a test case, wait
   three days, and confirm the **teacher** receives the reminder carrying the text
   that was typed — not the staff member.

### 15. Clean up

```sql
DELETE FROM cases WHERE teacher_chat_id = '<the test chat id>';
DELETE FROM announcement_recipients WHERE chat_id = '<the test chat id>';
DELETE FROM form_submissions WHERE submitter_email = '<the test teacher's email>';
```

Leave the roster row and the teacher record. They are harmless, and the next smoke
test reuses them.

> **Why `form_submissions` is on that list, and why it is the one line to get
> right.** Those rows are how the bot remembers which submissions it has already
> dealt with. Leaving them means check 13 **cannot be run a second time** — your
> test submission is still marked as handled, so no case appears and it looks
> like a fault when it is not.
>
> **Delete them only for the test teacher, by their email, exactly as above.**
> Emptying the whole table would make the bot re-file every real submission still
> sitting in a responses sheet — one new case per teacher, per form.

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

## 4.4 Deciding whether a case is urgent

> **This replaced `/generate_urgent_code` on 1 August 2026.** The old route made
> a teacher telephone a Regional admin, be read a six-character code, and type it
> correctly *before the bot would let them describe their problem at all*. The
> codes, the command that issued them, the guess limit and the stranded-code
> alarm are all gone. If you are looking for `/generate_urgent_code`, this
> section is what it became.
>
> The change is one sentence: **the rationing moved from before the teacher may
> speak to before priority is granted.**

### What the teacher does

They tap **⏫ Ask for Priority** and describe the problem. Nothing is in their
way. Their case is filed — or their existing open case is added to — at **normal
importance**, and it is stamped as having been asked about.

They are told plainly that a regional coordinator will decide, and that until
then it is being worked in the ordinary way. Nothing promises them anything.

**"Urgent" here means high priority, not emergency.** The bot is not a crisis
line and does not present itself as one.

### What you do

You receive a message naming the teacher, their roster identifier and their
region, with one button: **⏫ Confirm urgent**. Check with them however you
normally would — telephone, the school, whatever you already do. Nothing about
this is automated and nothing chases you.

Tap the button only if the case should genuinely come ahead of the other open
cases. Then:

- Its importance becomes **Urgent** and its status **Escalated**, so it appears
  in `/urgent`
- **The teacher is told**
- Its owner, if it has one, is told
- Program rank and above are told, because this is the only granting act in the
  system with no second signature
- An audit row is written naming you

**Tapping it twice does nothing.** The second tap says who decided and tells
nobody anything. That is deliberate: the button lives in your Telegram history
for ever and will be tapped again by accident.

**There is no decline button.** If a request should not be granted, simply do not
tap. The request stays visible in `/urgent_pending` until somebody grants it —
see the note in §4.4a.

### Who may decide

Support rank and above, deliberately, and for the same reason the old command
was: the person a teacher reaches is whoever is on the support desk, and a
decision that needs a manager is one that arrives after the thing it was about.

## 4.4a Requests nobody has decided

```
/urgent_pending
```

Lists every priority request with no decision against it, oldest first, with how
long each has been waiting. It shows references and times and **never the
teacher's words** — those stay behind `/case`, which records who read them.

**Nothing escalates these on its own, by design.** Auto-escalation would push
every frivolous request up to Program anyway, which defeats the gate. Visibility
was chosen instead, which only works if somebody looks — so this command is worth
running once a day.

It is deliberately **not** filtered to your own queue and region: a supervisor
who can only see their own region cannot notice that another region has stopped
answering.

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
> stopping them there would throw away everything they had typed. The
> confirmation says so. Do not report the trickle as a
> fault.

## 4.6 Watching that it is working

```bash
docker compose ps
docker compose logs -f web worker
```

**Most of the watching is done for you.** The operations chat receives an alarm
when a scheduled job stops succeeding, a sync is refused by its damage limit, a
teacher identity is claimed by a second chat, a priority request reaches a region
nobody covers, or a teacher was not told the outcome of something that succeeded.

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

**Reaching teachers, and taking data out**

| | |
|---|---|
| `/announce <all\|region:Name> <text>` | Write a broadcast. **Sends nothing** — §4.14 |
| `/announce_send <id>` | Actually send it. Only the person who wrote it |
| `/announce_cancel <id>` | Stop it. Anybody who can announce |
| `/announcements` | Recent ones, and how far each got |
| `/export` | A spreadsheet of the cases you can see. **No teacher's words** — §4.16 |

**Yourself, and the periods**

| | |
|---|---|
| `/username @handle` \| `/username clear` | Publish your Telegram handle to teachers in your region — §4.17 |
| `/retention` | Read the three retention periods. With a name and a number, change one — §4.11. **System only** |
| `/forget <chat id> FORGET` | Honour a removal request. **System only, no undo** — §4.15 |

**People**

| | |
|---|---|
| `/region <chat id> <region>` | Correct a teacher's region — §4.10 |
| `/regions` | Teachers who have told us their region is wrong |
| `/revoke` `/restore` | §4.3 |
| `/staff` `/staff_add` `/staff_role` `/staff_remove` | Who is staff — System only |
| `/staff_region <chat id> <regions>` | Which regions somebody covers. `clear` means **every** region — §2.6. System only |
| `/maintenance` | §4.5 — System only |
| `/urgent_pending` | Priority requests nobody has decided — §4.4a |

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

**Nothing replaces it, and that is a real loss rather than a tidy-up.** Two
questions are now unanswerable beyond three days: what teachers are asking that
the answer bank cannot cover, and which confident answers they are rejecting.

**A replacement was designed, offered on 30 July 2026, and not wanted.** It was a
nightly count taken *before* the delete — no teacher's words kept, just "this
answer was rejected fourteen times in October". It was considered properly and
declined, and this paragraph exists so that the deletion above reads as a
decision rather than as an oversight. **A section that looks like an oversight is
one somebody restores by accident** — and a restored §4.7 would run its two
queries, return nothing, and look like good news.

**It remains available whenever it is wanted.** Nothing forecloses it: it is one
small table and one extra step in a nightly job that now exists. Ask for it and
it is a small piece of work, not a redesign.

**What it does not mean is a longer retention period.** Lengthening one asks
about 1,800 teachers to read the privacy notice again (§4.11), and it would be
paying that price for a signal a count would give for nothing.

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

- **A region nobody has heard of.** A typo would put the teacher in a region no
  staff member covers — their cases visible only to all-region staff, routed
  nowhere, and wrong in a way nothing reports. It lists the real names instead.
- **Moving a teacher across a boundary you do not hold** — including moving one
  *out* of a region you do not hold, which is the same act seen from the other
  side. Ask somebody who covers both; Program and System cover all of them.
- Nothing at all, if the teacher already has that region. It says so.

**The bot asks each verified teacher whether their region is still right at most
once every 180 days.** Not on every visit — there is no session to hang it on, so
in practice that would be a question 1,800 people tap through without reading. A
slow trickle of flags is therefore what working looks like; a sudden burst is
worth asking about.

**`/regions` is a teacher's report, not a change.** When the bot asks a teacher
whether the region it holds is still right and they say no, it raises a flag and
writes nothing. They are deliberately **not** asked where they are now: a menu of
regions is a menu of whose emergency this becomes, and a wrong tap sends it to the
wrong region. Ask them, then use `/region`. The report leaves the list the
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

**Use the command, not SQL.** A System member types:

```
/retention
```

With nothing after it, that reports all three periods, quotes the exact paragraph
teachers read about them, and changes nothing. It is the safe thing to type and
the one to start with. To change one:

```
/retention case 14
```

The three names are `case`, `urgent` and `message`. A value of `0`, a negative
number or anything that is not a whole number is refused and the current value is
restated — `0` in particular would mean *delete every resolved case immediately*
and is one keystroke away from a typo.

**Lengthening a period tells you what it will cost before it writes**, and then
writes it: about 1,800 teachers will be asked to read the privacy notice again
the next time they use the bot. Nobody should discover that from the outbound
message count.

The SQL below still works and is here for a database that cannot be reached from
Telegram. Prefer the command: it validates the value, warns about the cost and
leaves a record of who changed what.

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

## 4.12 What happens on its own, and when

Five things now happen without anybody asking. All times are Tashkent time.

| When | What |
|---|---|
| **02:00, nightly** | Records past their retention period are deleted (§4.11) |
| **07:00, daily** | Each staff member gets their own morning list; teachers who owe a reply are reminded; published Telegram handles are re-checked |
| **Every minute** | Any confirmed announcement sends its next two hundred people (§4.14) |
| **Every ten minutes** | The spreadsheet is copied in — **answers, roster and document form links** — and then **every form's submissions are read back and filed** (§4.18) |
| **Every five minutes** | The other four are checked for having stopped. This is the one that raises the alarm below |

**That ten-minute line is the one to remember when somebody asks why a submitted
document has not appeared yet.** It is the same ten minutes §4.18 tells you to
wait before checking that a test submission became a case.

**If one of these stops running, an alarm arrives in the operations chat** naming
the job and when it last succeeded. That alarm exists because a job that stops
being scheduled produces no error at all — it is silent, and silence is what it
detects. §5.5 is what to do about it.

## 4.13 The morning message, and chasing a teacher

**At 07:00 each staff member who can act on cases gets one message containing
their own three lists:** the cases they own that are past the date they promised,
the cases in their queue and region that nobody has touched, and the ones in it
that nobody owns.

**Somebody with nothing due gets nothing.** That is deliberate. A daily message
saying "nothing to do" is a daily message people filter, and then they filter the
one that matters. **Observers never get one at all** — being paged about work you
are not permitted to do teaches you to ignore the page.

If somebody says they are not receiving it: check they are active, check their
rank is above Observer, and check they have opened a chat with the bot at all. A
staff member who has never sent the bot `/start` cannot be messaged by it, and
that failure is counted in the logs rather than alarmed, because it is an
onboarding problem rather than a fault.

### The teacher chase

**A case left at `Action required` is waiting on the teacher, not on staff.** So
after three days the *teacher* is reminded — never the staff member holding it,
who is correctly doing nothing.

The reminder names the case and repeats, word for word, whatever was typed into
`/await`. **That text is the only thing the teacher sees**, so it is worth
writing it as a sentence a teacher can act on rather than a note to yourself.

**Three reminders and no more.** After the third, the case's owner is told the
teacher has stopped responding, and nothing chases again. That is the situation
`/close <ref> unresolved <reason>` exists for: a teacher who has left, changed
number or given up.

Two details that will otherwise be reported as faults. **A reminder that could
not be delivered does not count** — three reminders means three that arrived, and
the case simply comes back tomorrow. And **the clock restarts whenever the status
changes**, so a case that leaves `Action required` and returns to it starts again
from zero.

## 4.14 Sending an announcement

Reaches every teacher who can use the bot, or every teacher in one region. It
takes two commands on purpose: **1,800 messages is the least undoable thing in
this system.**

**1. Write it.**

```
/announce all Passport collection moves to Tuesday 5 August.
/announce region:Bukhara The Bukhara office is closed on Friday.
```

Nothing is sent. The bot replies with the message **exactly as teachers will read
it** and the exact number of people who will receive it, and gives you an id.

**2. Read it back.** This is the step that is worth the minute. Read the text as
a teacher will, not as you typed it.

**3. Send it.**

```
/announce_send <id>
```

**Only the person who wrote a draft can confirm it.** Not a permission rule — a
colleague confirming your words is sending words they did not write, to 1,800
people, under their own name.

**4. Wait for the report.** About two hundred people a minute, so roughly nine
minutes for everybody. When the last person is resolved the sender gets one
message: how many were delivered, how many were **skipped** because they no
longer have access to the bot, and how many **could not be reached**. Those three
are counted separately because they need different things done about them —
skipped is correct behaviour, and could-not-be-reached is usually somebody who
blocked the bot or never started a chat with it.

### Stopping one

```
/announce_cancel <id>
```

**Anybody who can send announcements can cancel one**, not only the author — a
bad message going out while the one person who could stop it is asleep is the
worse failure.

**A cancel after sending has begun stops the remainder and tells you how many had
already gone.** It cannot recall what is already in somebody's chat, and it does
not pretend to.

### Three things worth knowing

**The list of recipients is frozen when you write the draft**, not when you
confirm. That is what makes the number in the confirmation the number that
receives it.

**Anybody who lost access between the draft and the send is skipped**, and is
reported as skipped rather than as a failure.

**A restart in the middle of a broadcast resumes where it stopped.** Nobody is
messaged twice, and there is nothing to re-run by hand.

**`/announcements`** lists the recent ones and how far each got.

## 4.15 A removal request from a teacher

A teacher asking for their data to be removed. **System rank only**, and there is
no undo whatsoever.

```
/forget <their chat id> FORGET
```

Without the word `FORGET` the command explains what would happen and changes
nothing. The word is typed rather than tapped for the same reason a database
deletion should be awkward.

**What goes:** their name, their recruitment identifier, both regions, their
record of accepting the privacy notice, their message log, and any half-finished
conversation. Their access ends.

**What stays, and this is what you will have to say to the teacher:**

- **Their Telegram chat id.** Every one of their cases points at it, and that link
  is the guarantee that no case exists without a real person behind it.
- **What they wrote inside their cases.** Their case history is kept on purpose.
  Retention removes the words on its own — seven days after each case is closed,
  or 180 days for one marked Urgent or Critical.

**Say that plainly rather than "your data has been removed."** Somebody hearing
the shorter sentence understands something stronger than what happened.

**A Support member who takes the request cannot action it.** It goes to one of the
two System members. For a request with no undo that is correct handling rather
than an obstacle.

The command reports how many open cases that teacher still has, and the removal
does not close them. Somebody should look at them.

## 4.16 Taking an export

```
/export
```

Program rank and above. Sends back a spreadsheet file of the cases **you can
see** — a Lead gets their own region, and cannot export another.

**It contains no teacher's words.** Reference, category, status, importance,
region, owner, and the dates. Not what the teacher wrote, not the update they
were sent, not their name.

**That is a deliberate limit and it must not be relaxed by adding a column.** A
file behaves differently from a screen: it lands in a Telegram chat, syncs to
that person's devices, is forwardable to anybody, and **outlives the retention
job built to delete the very text inside it.** A report taken today still holds
cases the system deleted a week later. Reading one case through `/case` checks
permission first and leaves a record of who read it; a file has none of those
properties.

The filename carries the date and the scope, so a stale one looks stale. Every
export is recorded against whoever took it and how many rows it held.

If a report of the teachers' own words is genuinely needed, that is a
conversation about where the file is allowed to go — not a column somebody adds.

## 4.17 Publishing a manager's Telegram handle

Teachers can ask **"who covers my region?"** from the main menu, without signing
in — somebody who cannot sign in and needs a person to talk to is exactly who
asks it.

They are shown the name of the most junior staff member who covers their region
and can act on cases, and, **if that person has published a Telegram handle**, a
tappable link to them. Otherwise they get the name and the support address.

**Each staff member publishes their own, and nobody publishes anybody else's:**

```
/username @theirhandle
/username clear
```

**The bot checks the handle against Telegram before it writes anything**, and
tells you which of three things happened: it is yours and is now published, it
belongs to somebody else and nothing was written, or Telegram does not know it.

### When the daily check clears somebody's handle

**This will happen, and the person who meets it first is whoever is named in the
alarm.** The 07:00 job re-checks every published handle. If one no longer resolves
to its owner it is cleared immediately, and both that staff member and the
operations chat are told.

**What to do:** ask that person to set their new handle with `/username`. Nothing
else is wrong. Teachers in their region are meanwhile shown their name and the
support address, which is what they had before the handle was published.

**Why the bot is this strict about it.** A Telegram username is not an identifier,
it is a label its owner can release — and once released, **anybody can claim it.**
A handle left stale would not degrade to "nobody answers". It would degrade to
1,800 teachers being pointed at a stranger, by the Ministry's own bot, silently,
for months. Every other stale value in this system fails towards nothing
happening; this one fails towards the wrong thing happening confidently.

### The cost of this feature, recorded on purpose

**A teacher who can message a manager directly will sometimes do that instead of
opening a case.** That work then has no reference, no queue, no owner, no promised
date, no retention rule, and nothing for the next person to read. The wording
sends anything needing a record back to Contact Support, and wording is the only
control there is.

This was accepted knowingly, against the alternative of teachers not knowing who
covers their region at all. **If case volume falls after this ships, read it as
work moving rather than as work disappearing.**

## 4.18 Publishing a document form — the whole procedure

**Do all six steps. Steps 3 and 4 are the ones that go wrong**, and when they do
the bot looks perfectly healthy while quietly reading nothing.

The bot never receives a file. Teachers fill in a Google Form; the documents stay
in Google; what the bot reads back is the fact that somebody submitted, and who.

### 1. Build the form in Google Forms

Whatever questions you need. One rule, and it is the only one:

> **Exactly one question must have the word "email" in its title, and it must be
> the one asking for the teacher's recruitment email.**

"Your email address", "Recruitment email", "E-mail" all work — the bot ignores
capitals, spaces and hyphens. What breaks it is a **second** question mentioning
email, such as "Your supervisor's email": the bot then cannot tell which address
identifies the teacher, and it refuses that form's responses rather than guess.
Filing somebody's documents under their supervisor is worse than not filing them.

**Make the email question required.** A submission with no address can never be
matched to anybody.

### 2. Send the responses to the right spreadsheet

**This is the step that decides whether anything works.** In the form:

1. Open the **Responses** tab at the top of the form editor.
2. Click **Link to Sheets** (a green spreadsheet icon). If the form is already
   linked to the wrong place, use the ⋮ menu → **Unlink form** first.
3. Choose **Select existing spreadsheet**.
4. Pick **the same spreadsheet that holds `FAQ`, `ROSTER` and `FORMS`.** Not a
   new one, not a copy. The bot can read one spreadsheet and only one.
5. Google adds a new tab to that spreadsheet. **Write down its exact name** — it
   is usually "Form Responses 1", or the form's title.

### 3. Note the tab's exact name

Open the spreadsheet and look at the new tab along the bottom. Copy its name
character for character, including spaces and capitals. `Form Responses 1` is not
the same as `Form responses 1`.

Renaming the tab to something meaningful — `PASSPORT_RESPONSES` — is a good idea,
and easier to get right later. Do it now, before step 4, not after.

### 4. Add the row to the `FORMS` tab

| Column | What goes in it |
|---|---|
| `TYPE` | A short code, capitals, no spaces or punctuation — `PASSPORT`, `VISA`. This travels inside the button, so it must be short and plain |
| `BUTTON_TEXT` | What the teacher sees on the button. An emoji is fine — `🛂 Passport copy` |
| `URL` | The form's link, from **Send → 🔗** in Google Forms. Must start with `https://` |
| `RESPONSES_TAB` | **The exact tab name from step 3.** These two must match perfectly |
| `ACTIVE` | `TRUE` to show it, `FALSE` to hide it |

Leave `RESPONSES_TAB` blank if the form is not linked yet. The button still
appears and teachers can still submit — the bot just will not read anything back
until you fill it in.

### 5. Wait ten minutes

The sync runs every ten minutes. Then open the bot as a teacher would and tap
**Submit Documents**. The new button should be there.

**If the row was wrong**, the operations chat gets a message naming the row
number and what to fix. Fix the sheet; the next sync recovers on its own.

### 6. Check it reads back — do not wait for a real teacher

Submit the form yourself, using **the recruitment email of a teacher who has
already signed in to the bot** (your own, if you are on the roster). Within ten
minutes:

- A `Submit Documents` case should exist for that teacher — check with `/cases`.
- The case should carry a note naming the form.

**If nothing appears**, it is almost always step 2 or step 4: the responses went
to a different spreadsheet, or `RESPONSES_TAB` does not match the tab name.
Compare the two, character for character.

> ### ⚠️ Never delete or reorder rows in a responses tab
>
> The bot remembers which submissions it has dealt with **by row number** —
> that is the only stable identifier Google gives it. Deleting a row shifts every
> row below it up by one, and the bot will file all of them again as new
> submissions.
>
> If a submission is wrong, leave the row alone and close the case instead.

### What staff see when a submission cannot be filed

Two different alarms, and they mean different things:

**"Submissions from teachers who have not signed in"** — the address is on the
roster, so we know exactly who they are, but they have never opened the bot.
There is nothing to file the case against. **Their documents are safely
submitted**; ask them to open the bot and sign in, and the next thing they send
will file normally.

**"Submissions that matched no teacher"** — the address is on no active roster
row. Either the teacher used a different address from their recruitment one, or
the roster is missing them. The documents are still in the form's responses.

# PART 5 — When something is wrong

## 5.0 Every alarm the bot can send, and what to do — the index

**Search this table for the words in the message you received.** The titles below
are exactly what arrives in the operations chat, character for character, so you
can match them without knowing anything about how the bot works.

**These are the only messages the bot ever sends to the operations chat.** If you
receive something not on this list, it did not come from the bot.

🔴 = act now · 🟠 = act today · 🔵 = for information, no action

### The sheet syncs

| Alarm | 🚦 | What it means | What to do |
|---|---|---|---|
| `FAQ sync failed` · `ROSTER sync failed` · `FORMS sync failed` | 🔴 | That tab could not be read at all. Usually a renamed or deleted column. **Nothing was changed** — the previous good data is still live | The message names the missing column. Restore its name in the sheet. The next sync recovers on its own, within ten minutes. §5.4 |
| `FAQ sync refused` · `ROSTER sync refused` · `FORMS sync refused` | 🔴 | The sheet would have switched off more rows than the safety limit allows — usually a filter left on, or rows deleted by accident. **Nothing was changed** | Look at the tab. If rows were removed by mistake, paste them back. If the removal is genuine, §5.4 has the override |
| `FAQ rows rejected` · `ROSTER rows rejected` · `FORMS rows rejected` | 🟠 | Some rows could not be used. **Everything else synced normally** | The message names each row number and the reason. Fix those rows. §4.1 for answers, §4.18 for forms |

### Documents

| Alarm | 🚦 | What it means | What to do |
|---|---|---|---|
| `Submissions from teachers who have not signed in` | 🟠 | Their email IS on the roster, but they have never opened the bot, so there is no case to file against. **Their documents are safely submitted** | Ask each named teacher to open the bot and sign in. Nothing is lost. §4.18 |
| `Submissions that matched no teacher` | 🟠 | The address is on no active roster row. Either they used a different address, or the roster is missing them | Check the roster for that person. If they belong there, add them; the next thing they submit will file normally. §4.18 |
| `Form “…” could not be read` | 🔴 | One form's responses tab could not be opened, or its email question is wrong. **That form's submissions are not reaching anybody.** Every other form is unaffected | Almost always `RESPONSES_TAB` not matching the real tab name, or two questions mentioning "email". §4.18, steps 3 and 4 |
| `Form submissions rejected` | 🟠 | Individual submissions had no email address in them | Nothing to fix in the bot. If it keeps happening, make the email question **required** in that form. §4.18 |
| `Form responses sync failed` | 🔴 | The whole document read-back failed, not one form | §5.4, then check the operations chat for a sync alarm alongside it |

### Retention and deletion

| Alarm | 🚦 | What it means | What to do |
|---|---|---|---|
| `Nothing is being deleted, because no retention period is set` | 🟠 | Repeats **every night** until somebody sets a period. The bot is working correctly; it has simply been told to keep everything, and the privacy notice is telling teachers exactly that | Set the three periods — §2.4 or `/retention`. §4.11 |
| `The nightly deletion pass did not finish` | 🟠 | One or more tables were not cleaned. The others were. Nothing is lost — deletion is simply late | Read which table failed. If it repeats two nights running, it needs a person with database access |

### Cases and teachers

| Alarm | 🚦 | What it means | What to do |
|---|---|---|---|
| `Scheduled job "…" has stopped` | 🔴 | A job has not succeeded for longer than it should have. **This is the alarm that tells you the bot has gone quiet** | §5.5 |
| `A teacher was not told what happened` | 🔴 | Staff replied, or closed a case, and the message did not reach the teacher. **The work happened; the teacher does not know** | §5.7 |
| `Somebody was not told about something that happened` | 🟠 | As above, for a message that was not the first one | §5.7 |
| `A teacher asked for priority and nobody can decide it` | 🔴 | A priority request arrived and no active staff member holds `urgent.issue` — not in that region and not at System either | §5.6 |
| `A teacher identity is now held by more than one chat` | 🟠 | Two Telegram accounts signed in with the same recruitment email. Both can see that teacher's cases | Find out which is genuine — usually a new phone. Revoke the other with `/revoke`. §4.3 |
| `A published Telegram handle stopped matching its owner` | 🔵 | A staff member changed or removed their Telegram username. The bot has **already cleared it** so no teacher is sent to the wrong person | Ask that person to run `/username` again. Until they do, teachers are shown their name and the support address. §4.17 |
| `An FAQ answer could not be shown as a button` | 🟠 | An answer's button text is too long for Telegram, so that answer is unreachable for teachers | Shorten `BUTTON_TEXT` for the named row. §4.1 |

> **If an alarm repeats every ten minutes, it is a sync**; every night, retention;
> every hour, a job. That alone usually tells you which table above to read.

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

## 5.6 An alarm says nobody can decide a priority request

The teacher's case **is filed** and they have their reference — nothing has been
lost. What has not happened is the decision: the case is sitting at normal
importance and will stay there.

The alarm fires only when there is no active staff member holding `urgent.issue`
at all — not covering that region, and not at System either, which is the
fallback. So it is a staffing answer rather than a technical one:

1. `/staff` to see who is active. If the list is short, somebody has been removed
2. Add a Support member, or raise an Observer with `/staff_role`
3. If people exist but cover the wrong regions, `/staff_region` — §2.6
4. Then `/urgent_pending` and grant anything that should be granted

**A System row being inactive is the most likely cause**, because System is what
this falls back to. Two named System members exist by launch-checklist
requirement precisely so this cannot happen from one person leaving.

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
| **Reading the audit trail from a command** | Deliberately never. It is read by somebody with database access during an investigation, and a command to read it would need its own permission model to avoid becoming the thing it audits |
| **A teacher resigning through the bot** | Later. A Program member would unlock it per teacher, and the record would be anonymised three months afterwards. The anonymising half is built and is what `/forget` uses |
| **Scheduling an announcement for later** | Not built and nobody has asked. `/announce_send` sends now |
| **Telling a teacher before their case is deleted** | Deliberately not. 1,800 people receiving "your case record has been removed" is noise, and the notice states the period. The first person to meet it will be a staff member on the telephone, which is why §4.11 says it in the words they will need |
| **Turning the morning digest off** | Deliberately not. No per-person opt-out and no frequency setting: a digest people can switch off is a digest that stops arriving for the people who most need it. If it is wrong for somebody, that is a conversation |
| **Anything about districts** | Never. Uzbekistan has regions and districts and this bot is concerned with regions only |
| **A list of "action required" types** | Later. Until then `/await` carries free text — §4.6a |
| **Document submission** | ✅ **Built in Stage 6**, and **through the existing Google Forms rather than the bot.** An earlier version of this document called Telegram upload "the only genuinely new feature in the rebuild"; that direction was reversed. The bot never accepts or stores a file. It publishes form links from a third spreadsheet tab, and matches submissions to teachers by their recruitment email — the same identity check as signing in, and stronger than the old system's editable hidden field. **§4.18 is the procedure for publishing a form**, and it is not optional reading: two of its steps fail silently |
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
