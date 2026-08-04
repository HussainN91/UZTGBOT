# MoPSE Teacher Support Bot: Runbook

**Version:** 4.2 · **Date:** 2026-08-03 · Updated after the 2 August audit fixes

> **What changed in version 4.2**
>
> Two passages still described the old emergency route, in which a teacher had to
> telephone a Regional admin and be read a six-character code before the bot would
> let them describe their problem. That route was withdrawn on 1 August 2026, and
> §4.4 already said so, which meant the document contradicted itself in two
> places. Both passages now describe what actually happens, which is that the
> teacher writes to the bot straight away and a coordinator decides afterwards.
>
> Four sections gained behaviour that changed in the 2 August fixes. §4.4a covers
> priority requests whose case has since been closed. §4.1 records that the manual
> sync now covers document forms as well. §4.4 notes that confirming a priority
> request on a closed case reopens it and says so. And §5.0 gained an alarm it had
> been missing, `A message could not be handled`, which now has a section of its
> own at §5.7a.
>
> The rest of this revision is a readability pass. No procedure changed, no command
> changed, and no number changed. If you have used an earlier version, everything
> you learned still holds.
>
> **What changed in version 4.1**, which is still worth knowing about: §5.0 indexes
> every alarm the bot can send, quoted exactly as the words arrive in the
> operations chat. §4.18 explains how a document form gets published, step
> by step, and two of those steps fail silently if you get them wrong.

This document replaces the Apps Script runbook completely. Nothing in the previous
version still applies. There is no spreadsheet to set up, no script project, no
triggers to install, and no deployment versions to publish, because the bot now
runs on a rented server instead.

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

# PART 1: For the head of project

## 1.1 What this is

This is a Telegram bot for teachers recruited by the Ministry. A teacher signs in
using the email address they were recruited with, reads approved answers to common
questions, and opens a support case when those answers do not cover what they
need. Every case gets a reference number, which the teacher can quote to anybody
helping them.

It replaces an earlier version built on Google Sheets. The purpose is the same and
the answer bank is the same, but far less can now go wrong without anybody
noticing.

**The bot has never been launched.** No teacher has used it and it holds no real
data, so there is nothing to migrate and no switch-over window to plan around.

## 1.2 What is now built, and what still stands between here and launch

**The staff half of the system now exists.** A teacher can sign in, read answers,
open a case and ask for it to be treated as a priority. A staff member can then
see that case, answer it, ask the teacher for something, close it, reopen it, add
a note to it, assign it to somebody, judge how serious it is, put a date on it,
correct the teacher's region, end and restore a teacher's access, manage who
counts as staff at all, pause new cases, and decide whether a case is treated as
urgent. Filing a case now also notifies the people who can work on it, which is
something the earlier version never did.

An earlier version of this document said that *"nobody can reply to that case
through the bot"*. That is no longer true, and with it the thing holding up launch
stopped being engineering work.

**When two accounts claim to be the same teacher, that now reaches a person who
can settle it.** Previously the system raised an alarm in the operations chat and
did nothing further, so the two people the argument was actually about were never
asked anything at all. Now both accounts receive a message with a button on it,
the staff who cover that teacher's region are told as soon as either account uses
it, and a system administrator makes the final decision about which account
belongs to the teacher. The full procedure is in §4.4b.

**The system also does a number of things on its own, without anybody asking.**
Records that have passed their retention period are deleted at two in the morning.
Each staff member receives their own list of overdue work at seven. A teacher
whose case is waiting on them gets a reminder, up to three times and then never
again. MoPSE can reach every teacher at once with an announcement. A teacher who
asks to be removed from the system can be. And a teacher who does not know who to
talk to can ask which member of staff covers their region. §4.12 lists everything
that happens automatically, along with when it happens.

**What still stands between here and launch is listed on the checklist in §1.4,
and none of it is engineering work.** The two items with the longest lead times
are a proven backup restore and a review of the privacy notice, so those are worth
starting first. **Please also read §2.6**, which is the single list of everything
somebody has to type in by hand. Nothing on that list announces its own absence,
so an item that gets missed stays missed until it causes a problem.

## 1.3 The decisions, all four of them answered

**Every decision this document has asked you for is now settled.** They are
recorded below as answers rather than as open questions, and each one carries the
reasoning that produced it. The reasoning tends to be worth more later than the
decision itself, because it is what tells a future reader whether a change of
circumstances should reopen the question.

### ✅ 1. How long records are kept, decided 29 July

| What | Kept |
|---|---|
| A case that is **not resolved** | **For ever** |
| A resolved case | **7 days** after it was closed |
| A resolved case marked **Urgent** or **Critical** | **180 days** after it was closed |
| The message log | **3 days** |
| The audit trail | **Never removed** |

This was answered while the bot had still served nobody, which was the entire
point of setting a deadline for it.

The three periods are stored as **settings**, which means MoPSE can change them
without a deployment. That was your choice, made against the opposite
recommendation, and it turned out to make the design simpler. Because the privacy
notice is generated from those same settings, the number the system enforces and
the sentence teachers read about it are physically incapable of disagreeing.
§4.11 explains how to change a period, and it is worth reading before you change
one.

**Two consequences follow from these periods, and both are real.** The first is
that a week after a case is closed, its reference stops working. A teacher
telephoning about `VISA-2026-00123` will be told there is no such case, and there
will be nothing left to reopen. The second is that a three-day message log makes
the old monthly content review impossible, because that review ran queries across
thirty days of messages. §4.7 has therefore been deleted outright, since leaving
it in place would have meant it quietly returned empty results that looked like
good news. A replacement was offered on 30 July, in the form of a nightly count
taken just before the delete runs, and it was declined. §4.7 now records that
decision so the gap reads as a choice somebody made. The offer remains open if you
change your mind.

**✅ All of this is built, and it deploys as a single unit.** That covers the
nightly deletion job, the three settings, the privacy notice generated from them,
the new wording of that notice, and the gate that asks every teacher to read it
again. §4.11 covers changing a period afterwards.

**One thing has to happen at launch, or none of the rest of it does anything at
all.** The three periods have to be entered. Until somebody enters them, the
deletion job will run every night and delete nothing, and the privacy notice will
tell teachers, quite truthfully, that their records are kept until the Ministry
sets a period. §2.6 lists this alongside everything else somebody has to type in
by hand.

### ✅ 2. How a removal request is honoured, and why the original question was wrong

An earlier version of this document said that the database refuses to delete a
teacher who has opened a case, and concluded that this blocked the removal
promised in the privacy notice.

**The first half of that was accurate and the conclusion drawn from it was not.**
The safeguard refuses to delete a *teacher* who still has cases against their
name. It has never obstructed deleting a **case**, and any notes attached to a
case are removed along with it automatically. The retention periods above
therefore delete cases outright, which is exactly what "removed after seven days"
promises.

What a teacher's own removal request actually needs is anonymisation, meaning that
the name and the email address are replaced while the case itself stays. That
turned out to be a considerably smaller piece of work than the original question
implied.

**✅ This is built.** The `/forget` command does it, and it is restricted to a
System member because there is no way to undo it. §4.15 is the full procedure, and
it states plainly which things cannot be removed. Those are the Telegram chat id
and whatever the teacher wrote inside their own cases, both of which retention
clears on its own schedule. Whoever replies to the teacher needs to give them that
fuller sentence, because a bare "removed" would promise more than has happened.

### 🟠 3. Does the privacy notice say the right things?

The wording is drafted, and **nobody at MoPSE has reviewed it**. It sets out what
information is held, who is able to see it, and how a teacher goes about asking
for removal. Every teacher reads it before signing in, and the system records
which version of the notice each teacher accepted. That last detail matters
because it means a later revision cannot quietly erase the meaning of everybody's
earlier consent.

*What is needed here:* somebody who can speak for MoPSE should read
`src/config/privacy.ts` and either approve the wording or say what to change.

**This is the most urgent item on the list, and the window for doing it cheaply is
closing.** The rewritten notice and the gate that shows it to every teacher are
both built and already deployed. Every change to the wording asks every teacher
who has already signed in to read and accept it again. Doing the review now, while
one teacher has signed in, costs one round of that. Doing it after launch costs a
round from all 1,800.

### 🟠 4. Should we reconsider how a teacher proves who they are?

A teacher signs in by typing the email address they were recruited with, which
means anybody else who has that address can sign in as them.

This behaviour is inherited from the original design, and the system reports it
instead of preventing it. When a second Telegram account presents an identity that
is already in use, the operations chat receives an alarm, the original account is
sent a security notice, and both accounts are given a way to state their claim so
a system administrator can settle it. Preventing the second sign-in outright would
cause worse problems in both directions. It would lock out any teacher who changes
phone, with no way to release them, and it would hand anybody who reached a leaked
recruitment address first a way to lock the real teacher out permanently.

**This decision expires at launch.** While no teacher has signed in, changing it
is a change to a sign-in flow nobody has used. Once teachers are on the system, the
same change affects everybody who has already signed in, requires a migration, and
has to be explained to 1,800 people.

### 🟠 5. Do staff currently work cases in the spreadsheet?

If they do, that habit will have to change, because replying, assigning and
closing are all bot commands now. This is a retraining question rather than an
engineering one, and §4.6a and §4.6b together are the material to train people on.

**The `ADMINS` tab in particular no longer does anything at all.** It used to grant
administrator rights to whoever was typed into it. Permissions now live on the
server, and the only way to give somebody staff access is the `/staff_add`
command. If the old spreadsheet is being reused for anything, that tab should be
deleted. A tab that looks like it still works while doing nothing is more dangerous
than no tab, and this is precisely the one somebody will reach for when they want
to give a colleague access in a hurry.

## 1.4 The launch checklist

Every item here blocks launch, and none of it is engineering work. The column on
the right explains why each one blocks, because an item whose reason is understood
is far more likely to survive a busy week than one that reads as a bare
instruction.

| | What | Why it blocks |
|---|---|---|
| ☐ | **A real support contact** | The bot refuses to start without one, so this can no longer be forgotten by accident. Every dead end in the bot names this contact, so a placeholder would send teachers nowhere |
| ☐ | **The teacher roster** in the spreadsheet | Without it nobody can sign in, and no case can be opened by anybody |
| ☐ | **At least two named System members** | So that one person leaving cannot lock everybody out. The first is created with one line of SQL, described in §2.5, and the second is created with `/staff_add` from the first one's account. System is **also the only rank that can settle a disputed account**, covered in §4.4b, so if there are none, two people claiming to be one teacher have nobody who can decide between them |
| ☐ | **An operations group chat** for alarms | Use a group rather than one person's private chat, so that one person being on leave does not mean nobody is watching. **Set `OPS_ALERT_CHAT_ID` before adding the bot to the group.** If you add it first, it will leave the group, which is the correct behaviour and will look like a fault |
| ☐ | **A proven backup restore** | The scripts are written and have never been run against a real server. Until somebody has restored from a backup and seen it work, what you have is a belief about backups rather than a capability |
| ☐ | **The privacy notice reviewed** by somebody who can speak for MoPSE | Decision 3 above. **This is now urgent.** Every change to the wording asks every signed-in teacher to accept it again, so reviewing it while one teacher has signed in costs one round instead of 1,800 |
| ☐ | **The three retention periods entered** | Covered in §2.4. If they are left unentered, nothing is ever deleted, and the privacy notice tells teachers exactly that |
| ☐ | **Everything else in §2.6** | That section is the single list of what a person has to type in by hand. None of those items announces its own absence, so anything missed stays missed |
| ☐ | **A named owner for FAQ content**, and a review interval | There are 112 answers covering salary, visas and contracts. They will drift out of date, and nothing in the system can detect a stale one |
| ☐ | **Staff who know the four case words** | Covered in §4.6a. "Action required" in particular means that *the teacher* has to act. Somebody reading it the other way around will send work to the wrong person |

## 1.5 What teachers can do on day one

- Read the privacy notice and sign in with their recruitment address
- Browse eleven topics of approved answers, or type a question and pick the topic
  it belongs to
- Say whether an answer helped, using either ✅ or ❌
- Open a support case in one of five categories and get a reference number
- Check the status of their own cases
- **Ask for a case to be treated as a priority**, by describing the problem
  straight away with nothing standing in the way. A regional coordinator then
  decides whether to grant it. §4.4 covers how that decision works
- **Ask who covers their region**, and be given that person's name, along with a
  tappable Telegram link if that person has published one. This works without
  signing in, because somebody who cannot sign in and needs to reach a human being
  is exactly the person who asks
- **Be reminded** when a case is waiting on them, up to three times
- **Receive an announcement** from the Ministry

They will also be asked, once, to **read the privacy notice again** before using
Contact Support, Ask for Priority or Check My Case. Accepting takes one tap and
puts them straight back on whatever they were doing. The answer bank and the
`/privacy` command stay open throughout, which is deliberate, since a teacher
should always be able to read what is held about them.

Teachers can also **submit documents**, using Submit Documents on the menu. That
gives them a link to a Google Form, and the bot never receives the file itself.
What comes back into the system is a case recording that they submitted something,
so the submission can be tracked and so the teacher can see it in Check My Case.
§4.18 explains how a form gets published.

**What teachers cannot do** is send a file to the bot in chat, or use the bot in
Russian or Uzbek. Both of these are absent by decision. Offering either one in a
half-finished state would send a teacher who had just signed in to a dead end,
which is worse than not offering it. If a teacher does send a photo or a file in
chat, the bot refuses it with a message pointing them at Submit Documents.

## 1.6 Honest risk summary

**What is genuinely better than the old system.** A case can no longer be filed
twice by a double tap. A teacher's half-finished conversation survives the server
restarting. A teacher who needs their case looked at quickly can simply say so,
where previously they had to telephone somebody for a code before the bot would
let them speak at all. A scheduled job that stops running raises an alarm, where
before it was simply and silently absent. Revoking a teacher's access takes effect
on their very next message, where it used to take up to half an hour. A filed case
now reaches the staff who can work on it, and a case that nobody is able to see
raises an alarm instead of sitting unnoticed. Nobody can grant themselves staff
access by typing their name into a spreadsheet. All of this is covered by tests
that run against a real database rather than a simulated one.

**What remains true and unimproved.** The bot runs on a single server, so losing
that server means restoring from a backup, which is precisely why proving the
restore works is a launch blocker. The whole system depends on Telegram and on a
single bot token. And a teacher's recruitment email address is still all anybody
needs in order to sign in as them.

**What has changed since the earlier design, and is worth knowing.** The old
emergency route required a teacher to telephone a Regional admin, be read a
six-character code, and type it in before the bot would let them describe their
problem. That route was withdrawn on 1 August 2026 and replaced by one where the
teacher writes first and a regional coordinator decides afterwards. The practical
effect is that nothing now stands between a teacher and the ability to explain an
urgent problem, and the decision about priority happens where it belongs, which is
with a person who can weigh it. The window for describing the problem is 24 hours,
where the old design allowed 6. That six-hour figure was a limit of the old
platform and was never a decision anybody made deliberately.

---

# PART 2: Deployment

**The step-by-step mechanics live in `deploy/README.md`**, which covers server
preparation, Docker, configuration, TLS, the webhook and the backup tooling. That
file sits beside the scripts it describes, so that the two cannot drift apart from
each other. This part of the runbook covers something different: the rules about
ordering, and the handful of things that are easy to get wrong.

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

**Always migrate before serving.** The database schema has to be at least as new
as the newest process running against it. When new code meets an old schema, it
errors on every teacher message that arrives. Because handler errors are caught so
that Telegram does not retry them forever, what the teacher actually experiences
in that situation is *silence*, which is the worst possible shape for a failure to
take.

**Use `run --rm --no-deps` here, and not `exec`.** That gives you a throwaway
container to run the migration in, leaving the container that serves teachers
untouched. On a first installation the difference between the two is cosmetic. On
an upgrade it is the entire point of the step.

**Start the worker before the web process.** If the new code disagrees with the
schema, the worker will crash and restart in a loop, and it is far better to find
that out at a moment when nothing is serving teachers.

Migrations are safe to run again if you are unsure whether they completed.
Anything already applied is recorded and skipped, and each one runs inside a
transaction, so a migration that fails leaves the schema exactly as it was
beforehand.

**A deployment with no new migrations still runs the migrate step.** It will
report that migrations are up to date and finish immediately. Skipping the step
because you believe there is nothing to apply is how somebody eventually skips it
on the day there is.

## 2.2 Rolling back changes code only, never the database

Migrations in this system run forwards only, and there are no down migrations at
all. Rolling back therefore means checking out the previous tag and rebuilding it,
**leaving the newer schema in place underneath**. This works because every
migration written so far only ever adds things, so older code finds everything it
expects and simply ignores whatever is new.

That property is worth proving on deploy day, while no teacher is being served.
Boot the previous image against the new schema and watch it come up healthy. Doing
this costs nothing on the day and becomes impossible to arrange once teachers are
using the system.

**Restoring a backup is a different thing entirely, and it is not a rollback.**
Alongside undoing the deployment, it would destroy every case filed since the dump
was taken.

## 2.3 Add the permanent smoke-test row

Add a single row to the roster tab and then leave it there permanently:

| IDENTIFIER | NAME | REGION |
|---|---|---|
| `deploy-check@mopse.uz` | Deployment Check | Tashkent |

It stays permanently because removing it would not achieve much anyway. The sync
deactivates roster rows instead of deleting them, and the foreign key from the
cases table refuses to let the bound teacher record be deleted at all. Since the
row is going to persist regardless, keeping it deliberately turns it into
something useful: the smoke test in Part 3 becomes repeatable on every future
deployment, with no cleanup needed afterwards.

## 2.4 Settings that are not in the environment

These live in the `settings` table rather than in `.env`, because they must be
changeable without a deploy:

| Key | What it does | If unset |
|---|---|---|
| `MAINTENANCE_MODE` | Pauses new cases. The FAQ and Check My Case stay live | Off. Note that `/maintenance` is now how you change this, and SQL is no longer needed |
| `OVERDUE_DAYS` | Days before an untouched open case is called overdue | **The overdue half of `/urgent` states plainly that it is switched off**, instead of showing an empty list |
| `CASE_RETENTION_DAYS` | Days a resolved ordinary case is kept | **nothing is deleted** |
| `URGENT_CASE_RETENTION_DAYS` | Days a resolved Urgent or Critical case is kept | **nothing is deleted** |
| `MESSAGE_RETENTION_DAYS` | Days the message log is kept | **nothing is deleted** |

**The three retention keys are read every night, and seeding them is the one
insert that has to happen before the first teacher is served.** If they are left
unseeded, the nightly job still runs but deletes nothing, and the privacy notice
tells every teacher that their records are kept until the Ministry sets a period.
That statement is entirely true, and it is also not what anybody intends to be
promising after this release. The job will say so in the operations chat once a
night until somebody sets them. Seed them at launch like this:

```sql
INSERT INTO settings (key, value) VALUES
  ('OVERDUE_DAYS', '3'),
  ('CASE_RETENTION_DAYS', '7'),
  ('URGENT_CASE_RETENTION_DAYS', '180'),
  ('MESSAGE_RETENTION_DAYS', '3')
ON CONFLICT (key) DO UPDATE SET value = excluded.value;
```

**Leaving any of these unset means nothing is deleted, in every case.** This is the
safe direction and it was chosen deliberately. A job that invented a retention
period for itself would delete real records against a number nobody had agreed to,
and there is no way to undo that. The same design decision explains why an
unseeded system looks as though the retention feature has failed: it is working
exactly as built, and what it has been told to do is keep everything. §4.11 covers
changing a period afterwards, and it is worth reading before you do.

`OVERDUE_DAYS` follows the same rule for the same underlying reason. Left unset,
the overdue half of `/urgent` states plainly that nothing is being measured,
instead of showing an empty list. The distinction matters because "nothing is
overdue" and "nobody has said what overdue means" produce an identical empty list
while leading a reader to opposite conclusions.

Any change to these settings is picked up within a minute.

## 2.5 The first System member, which is one line of SQL on purpose

**There is no command for this, and there is not meant to be one.** Every staff
command in the bot requires System rank to run, so the very first System row
cannot possibly come from inside the bot itself.

Run this over the SSH tunnel, before anything else:

```sql
INSERT INTO staff (telegram_id, name, role, queue, added_by)
VALUES ('<their telegram id>', '<their name>', 'System', 'All', '0')
ON CONFLICT (telegram_id) DO NOTHING;
```

The telegram id is the numeric chat id, and it is not the `@name`. The simplest
way to obtain it is to have that person send the bot `/start` and then read the id
out of the `teachers` table. Any of the "what is my id" bots on Telegram will also
tell them.

**Then add the second System member from the first one's account:**

```
/staff_add <their telegram id> System All
```

**Why this step is a hand edit instead of a setup command.** Every automated
alternative amounts to a permanent back door. An environment variable that grants
System access hands the entire permission model to whoever is able to edit a file,
which is exactly the weakness that moving permissions off the spreadsheet was
meant to close. A rule along the lines of "the first caller becomes System" is a
race against the public internet, and you would be relying on winning it. The old
system's equivalent was a hand edit to a spreadsheet tab that anybody holding the
link could open. This version's hand edit requires access to the server itself,
and that difference is the whole improvement.

**Create two System members, not one.** The bot refuses to remove or demote the
last remaining active System member, so the rank cannot be emptied by accident.
That protects you from one failure but not from the other: if the single account
itself is lost, through a lost phone or somebody leaving the Ministry, recovery
means another trip to the database with SQL.

## 2.6 Everything that has to be set by hand, in one list

**Read this before launch, and then read it again afterwards.** Every item below
is something a person has to enter, and none of it arrives by itself. The reason
this list exists as its own section is that **not one of these things announces
its own absence by breaking.** The bot runs perfectly happily with every one of
them missing. It simply answers less, or answers nothing at all, while looking
entirely healthy from the outside. That silent, healthy-looking uselessness is the
exact failure this whole rebuild set out to remove, so this is where it gets
caught by a person instead.

| What | How | If it is never done |
|---|---|---|
| **The three retention periods** | The insert in §2.4, or the `/retention` command | Nothing is ever deleted. The privacy notice tells teachers their records are kept until the Ministry sets a period, which by then is perfectly true |
| **The regions each staff member covers** | `/staff_add` at the time they are added, or **`/staff_region <chat id> <regions>`** at any point afterwards | This is the one that gives a wrong-looking answer instead of no answer. It is explained immediately below |
| **The two System members** | §2.5 | Nobody can add staff, set a retention period, remove a teacher, or take an export |
| **The operations chat** | `.env`, before the first deployment | Every alarm described in this document goes nowhere at all |
| **The support contact address** | `.env` | Teachers are shown a blank space where an address should be |
| **Each staff member's Telegram handle** | The `/username` command, run by that person for themselves | Teachers asking who covers their region are shown a name and the support address, with nothing to tap through to. This is a reduced service and not a fault |
| **The FAQ answers and the teacher roster** | The spreadsheet, synced every ten minutes | The bot can answer nothing, and nobody can sign in |
| **The `FORMS` tab** | The spreadsheet, synced every ten minutes | Submit Documents tells every teacher that there are no document forms available at the moment. The button itself still appears |
| **Each form's responses linked into the same spreadsheet** | §4.18, which is a procedure in its own right | Teachers can still submit. **Nothing is ever read back**, so no case is filed, nobody is chased, and no alarm sounds, because from the bot's point of view nothing has happened |
| **The word "email" in each form's email question, and in no other question** | At the point the form is built. §4.18 | That form's responses are refused as a whole, and an alarm names it. **This is the one item here that does complain** |

> **One group is deliberately absent from this list, and you still have to set it.**
> `BACKUP_PASSPHRASE`, `BACKUP_REMOTE` and `BACKUP_DATABASE_URL` are documented in
> `.env.example` and `deploy/README.md`. They are left out of the table because
> they fail **loudly**: `backup.sh` refuses to run at all and names whichever one
> is missing, which is the opposite of how everything else here behaves. An unset
> backup is still an unset backup, though, and `CONCERNS-AND-IT-ACTIONS.md` item
> A5 treats proving the restore as a launch blocker. See §4.9.

### The regions in particular, which are being left until later on purpose

**Region details are added by hand, after launch.** This was a decision rather
than an oversight, and it produces one consequence that is worth understanding in
advance, so that nobody reports it as a bug.

A staff member with **no regions set covers every region.** An empty list means
everywhere, and it means that deliberately, because it is what allows a small team
to work the whole country without anybody having to fill in a form first. The
effect is that until the regions are entered, every staff member covers all of
Uzbekistan, and the question *"who covers my region?"* gets answered by **rank
alone**. A teacher is shown the most junior person able to act on cases, wherever
in the country that person actually sits.

That answer is reasonable, and it is still the wrong one. Once the regions are
entered, anybody who explicitly names the teacher's region is preferred over
anybody covering all of them, and rank is used only to break whatever tie remains.

**Entering them is `/staff_region`, one person at a time:**

```
/staff_region 991001 Tashkent, Samarkand
/staff_region 991001 clear
```

Region names are checked against the regions teachers are actually recorded as
being in, so a typo is refused and the real list is shown back to you. Without
that check, a mistyped name would quietly place somebody in a region that does not
exist. The word `clear` returns a staff member to covering everywhere, and it has
to be typed out in full instead of being implied by an empty line. Covering the
whole country is a legitimate configuration, but it should be something a person
chooses on purpose and never something they arrive at by pressing enter.

> **This command did not exist until 31 July 2026, and this page claimed that it
> did.** Regions could be set once, at `/staff_add`, and never changed afterwards,
> which meant the plan described above of adding staff now and setting regions
> later was impossible to carry out. It is recorded here because the failure had
> no symptom at all. Nobody would have received an error, and everybody would
> simply have carried on seeing the whole country.

Two smaller consequences follow from the same rule, and both are worth knowing
while the regions are still blank:

- **`/announce region:Bukhara` still works correctly**, because an announcement's
  audience is drawn from the *teachers'* regions on the roster and has nothing to
  do with staff regions.
- **Case visibility is effectively unrestricted** while every staff member covers
  everywhere. Nobody is seeing anything they should not, and the rule is doing
  exactly what it has been told to do. The region half of that rule is simply
  never exercised, which means a mistake hiding in it would not become visible
  until the day somebody enters the regions.

**Uzbekistan has both regions and districts, and this bot is concerned with
regions only.** It has no concept of a district and there are no plans to add one.
Any wording anywhere in the system that says "district" is wrong and should be
corrected to say "region".

---

# PART 3: Smoke test

Run this every time you deploy. It takes about ten minutes. Use a Telegram account
that does not belong to an administrator, together with the `deploy-check@mopse.uz`
roster row.

The last three steps are the ones that matter most, because they cover behaviour
that was impossible to test at all before this rebuild.

### 1. The bot is reachable

```bash
curl -sS https://$BOT_HOSTNAME/healthz
```

Expect `{"status":"ok"}`. A reply of `{"status":"degraded"}` means the web process
is running but cannot reach the database. In that state it deliberately reports
503, because a process that answers 200 while unable to serve anybody keeps
traffic arriving at something broken.

### 2. Sign-in

Send `/start`. Expect to receive the **main menu** rather than a question. It
should show the FAQ shortcuts, All FAQ topics, Who covers my region?, and **🔐 Sign
in**, underneath a line explaining that the answers can be read without signing in.
At this stage there should be **no** Contact Support, Ask for Priority, Check My
Case or Submit Documents button.

> **This changed on 1 August 2026, in Part 5F.** `/start` used to reply with the
> sign-in prompt and hold the chat there, which made the entire answer bank
> unreachable to anybody who had not signed in. If you see a request for an
> address here instead of a menu, you are running a build older than that change.

Tap an FAQ topic and read an answer. It should work with no sign-in at all.

Tap **🔐 Sign in**. Now expect the privacy notice and the request for a
recruitment address to arrive together in **one message**. Replying to it is what
constitutes the acknowledgement, so the two halves are never shown separately.

Send a wrong address. Expect a refusal that gives away nothing about whether the
address exists in the system, along with a count of how many attempts remain.

Send `deploy-check@mopse.uz`. Expect "Signed in as Deployment Check" and the main
menu.

### 3. The FAQ answers

Type `how long does a visa take` without choosing a topic first. Expect the bot to
ask which topic the question belongs to, and expect it to withhold the answer
until you say. Tap **Visa**, and the approved answer should appear with ✅ and ❌
beneath it.

Staff will ask why this takes two steps, so it is worth being able to explain.
Matching is scoped to a single topic, which is what makes it impossible for a
visa question to be answered out of the accommodation bank. The question itself is
remembered across the two steps, so the teacher only ever types it once.

Tap ✅. Then open a topic from the menu and page through it, checking that the same
page shows the same answers every time you return to it.

### 4. A case is filed once

Tap **Contact Support** → **Visa** → type a description. Expect a reference like
`VISA-2026-00001`.

Now do it again and **tap confirm twice, fast**. Expect one case, not two, and a
message saying the existing case was reused rather than a second one opened.

```sql
SELECT reference, status FROM cases ORDER BY created_at DESC LIMIT 5;
```

### 5. Check My Case shows no private text

Tap **Check My Case**. Expect to see the reference, the category and the status,
and not one word of what you typed. A teacher never has their own words read back
to them. The only case text a teacher ever sees is a public update that a staff
member wrote deliberately for them to read.

### 6. Restart mid-conversation

Tap **Contact Support** → **Visa**. Before typing the description:

```bash
docker compose restart web
```

Now type the description. **The case must file correctly.** This step is what
proves that conversations no longer live in the server's memory. Under the old
system a teacher in this position was simply lost, and there was no way to test
for it.

### 7. A priority request is granted by a person, and only by a person

Tap **⏫ Ask for Priority** from the test account. **You should be asked to
describe the problem immediately.** There is no code to type any more, so if you
are asked for one, the deployment is running old code.

Type a description. Expect a reply naming a case reference and saying that a
regional coordinator will decide. Then confirm that the request has **not** granted
itself:

```sql
SELECT importance, status, urgent_requested_at IS NOT NULL AS asked,
       urgent_confirmed_at
FROM cases ORDER BY created_at DESC LIMIT 1;
```

`importance` must be **`Normal`**, `asked` must be true, and `urgent_confirmed_at`
must be NULL. This is the single most important check on this page, and the reason
is worth understanding. Importance is what buys a case 180 days of retention
instead of seven, so if a request were able to mark itself urgent, any teacher
could grant themselves six months of retention with one tap of a button.

Now switch to a **System or Support** account. You should have received a message
naming the teacher, their identifier and their region, with a **⏫ Confirm
urgent** button. Tap it. Expect:

```sql
SELECT importance, status, urgent_confirmed_by FROM cases ORDER BY created_at DESC LIMIT 1;
```

That should return `Urgent`, `Escalated`, and your own chat id. The teacher should
have been told about it in a separate message.

Now tap the same button a second time. It must tell you that the case is already
urgent and name whoever confirmed it, and **the teacher must not be told a second
time**. Check that too:

```sql
SELECT count(*) FROM audit_log WHERE action = 'URGENT_CONFIRMED';  -- must be 1
```

Finally, run `/urgent_pending` from the same account, and it should now report that
nothing is waiting.

### 7a. A staff member can actually answer the case

This is the step that could not exist at all before the staff stage was built.
Working from the staff account:

```
/cases
/case <the reference from step 4>
/reply <the reference> your visa is with the embassy and should be ready Friday
```

Expect three separate things to happen: the case appears in `/cases`, the `/case`
command shows what the teacher wrote, and **the teacher's chat receives the
reply**. Then tap **Check My Case** from the teacher account, where you should see
the same words again.

```
/close <the reference> issued and collected
```

Expect the teacher to be told, and the case to leave `/cases`.

### 7b. The bot refuses to work in a group

Add the bot to any group **other than the operations chat**. Expect it to leave
immediately and say nothing.

Then type anything at all in the **operations chat**. Expect no reply, and expect
the bot to still be sitting in the group. Both halves of this matter. The bot has
to stay in the one place the alarms are delivered, and it must never try to hold a
conversation there.

### 8. A duplicate sign-in is reported

From a **second** Telegram account, sign in with `deploy-check@mopse.uz`.

Expect four things: the second account signs in successfully, the first account
receives a security notice, **the operations chat receives an alert**, and **every
System member receives the same alert in their own chat**.

**If the alert does not arrive in the operations chat, the deployment is not
finished.** Every alarm this system raises travels along that same path, including
a refused sync, a job that has stopped running, and a teacher who was never told
what happened to their case. Check the value of `OPS_ALERT_CHAT_ID`, and check
that the bot is actually a member of the group.

If the alert arrives in the group but not in a particular System member's own
chat, the explanation is almost always that the person has never opened a chat
with the bot. Ask them to send it `/start` once. The group copy is the one that
blocks the deployment, and the personal copies are an addition on top of it rather
than a substitute for it.

### 9. A teacher is asked to accept the privacy notice again

**Only on the deploy that carries the retention release, and it reaches all 1,800
teachers, so it is worth proving on one.**

From the already-signed-in test account, tap **Contact Support**. The privacy
notice must arrive with the actual retention periods written into it, so you
should see "7 days", "180 days" and "3 days" in the text. Accepting it with one
tap must return the teacher to the topic picker they were heading for, and not to
the main menu.

Tap Contact Support a second time. **The notice must not appear again.**

The FAQ must be entirely unaffected by any of this. Tap it before accepting the
notice and the answer bank should open normally, because it is deliberately left
outside the gate.

### 10. An announcement reaches one person before it reaches 1,800

**Do this before anybody addresses the whole country.** Address a region holding
only the test teacher:

```
/announce region:<the test teacher's region> This is a test, please ignore.
/announce_send <id>
```

Within about a minute the test account should receive it, and the sender should
receive a report saying one was delivered. If that report never arrives, the
sweeper is not running, so check the operations chat for an alarm about a stopped
job.

### 11. An export contains no teacher's words

```
/export
```

Open the file. It must contain the cases you can see, and it **must not contain a
column holding what the teacher wrote.** If such a column is present, stop and
read §4.16 before going any further. That is not a column anybody should be
adding.

### 12. A teacher is shown the right person, by the right handle

Set a handle on a staff account covering the test teacher's region with
`/username @handle`, then ask **"Who covers my region?"** from the test teacher's
main menu. The name must be right, and tapping the handle must open a chat with
that same person.

### 13. A document form reaches a teacher, and comes back as a case

**Run this only if the `FORMS` tab has been filled in.** If it has not, tap **📄
Submit Documents** anyway and check what comes back. The correct response at that
point is the message *"there are no document forms available at the moment"*.
Anything else, whether an error or an empty menu, is a fault.

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

Send a photo or a PDF straight to the bot while signed in as the test teacher. It
must refuse politely and point the teacher at Submit Documents. **The bot never
accepts, holds or stores a file at any point**, and this check is what demonstrates
that.

### The four checks that need a night or a morning to pass

These four cannot be squeezed into ten minutes. Run them on the first deployment
of the retention release, and write down somewhere that you did.

1. **A closed case disappears on schedule.** Close a test case, set
   `/retention case 1`, wait until after 02:00, and confirm that both the case and
   its notes have gone and that the reference no longer resolves.
2. **A case marked Critical survives.** Do the same again, but run
   `/mark <ref> Critical` first. This one must still be there afterwards. The check
   proves that deletion reads a case's importance and never its status, which is
   the difference between keeping a genuine emergency for six months and treating
   every case in the system identically.
3. **A promised date is chased.** Use `/due` to set a case's date to yesterday,
   then confirm its owner is told about it at 07:00.
4. **A teacher at `Action required` is reminded.** Run `/await` on a test case,
   wait three days, and confirm that the reminder reaches **the teacher** rather
   than the staff member, carrying the text that was typed into the command.

### 15. Clean up

```sql
DELETE FROM cases WHERE teacher_chat_id = '<the test chat id>';
DELETE FROM announcement_recipients WHERE chat_id = '<the test chat id>';
DELETE FROM form_submissions WHERE submitter_email = '<the test teacher's email>';
```

Leave the roster row and the teacher record in place. They are harmless, and the
next smoke test will reuse them.

> **Why `form_submissions` appears on that list, and why it is the one line to get
> exactly right.** Those rows are how the bot remembers which form submissions it
> has already dealt with. If you leave them behind, check 13 **cannot be run a
> second time**, because your test submission is still marked as handled. No case
> will appear, and it will look like a fault when nothing is actually wrong.
>
> **Delete them only for the test teacher, matched by their email address, exactly
> as written above.** Emptying the whole table would cause the bot to re-file every
> real submission still sitting in a responses sheet, producing one new case per
> teacher per form.

---

# PART 4: Routine operations

## 4.1 Editing or adding an answer

Edit the FAQ tab of the spreadsheet. **The change reaches teachers within ten
minutes**, so it will not appear the moment you save.

> **This is the single most likely thing to be reported as a bug in the first
> week.** The old system cleared its cache whenever you edited the sheet, so edits
> appeared at once. The same behaviour also meant that an answer nobody had edited
> could be up to six hours out of date. Ten minutes is now the promise in both
> directions, which is worse in one and much better in the other.

To publish immediately:

```bash
docker compose exec worker node dist/scripts/sync-sheets.js
```

Given no flags, this now syncs **all three tabs**, meaning `FAQ`, `ROSTER` and
`FORMS`. Until 2 August 2026 it silently skipped `FORMS`, and the moment that
mattered most was the very first load. The scheduled worker picked the forms up
within ten minutes regardless, but anybody who ran this command by hand and then
opened Submit Documents was told there were no forms, and reasonably concluded the
feature did not work. You can still sync a single tab by naming it, using
`-- --faq`, `-- --roster` or `-- --forms`.

A new answer needs a unique `CODE` and a `CATEGORY` that matches one of the eleven
topics **exactly**. A category that does not match causes that one row to be
rejected and reported with its row number, while the rest of the sync applies as
normal. This behaviour is deliberate, because under the old system a typo here
made an answer permanently unreachable and produced no error anywhere.

Keep `CODE` short. It travels inside the button a teacher taps, and Telegram caps
the whole payload at 64 bytes. A code that is too long hides that one button and
raises an alarm naming it, which is a far smaller failure than taking down the
entire listing.

To retire an answer, set `ACTIVE` to anything other than `TRUE`. It becomes
unreachable at the next sync, and that includes reaching it from old buttons still
sitting in teachers' scrollback.

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

`/revoke` records who did it and when, which is something a spreadsheet edit can
never do. It also tells you how many open cases that teacher has, which is worth
knowing, because a staff member can still send a reply to somebody who can no
longer open the bot to read it. `/restore` sits at the same rank deliberately, so
that whoever is able to make the mistake is also able to undo it without asking
somebody more senior. A recovery that needs a second person is a recovery that
waits until Monday.

Neither command messages the teacher. The bot tells them their access has ended,
along with the support contact, the next time they try to use it. If somebody was
revoked by mistake and has already been told, you will need to tell them their
access is back.

**By the spreadsheet:** set their roster row inactive, or delete it. Both work,
because the sync deactivates rows instead of deleting them, and either takes
effect on the teacher's next message. Restoring the row restores their access
within ten minutes, and it happens silently. The only trace is in the sync
history, so if you revoke somebody this way on purpose, write down somewhere that
you did.

> ### The one thing `/restore` cannot fix
>
> **A teacher whose roster row was deactivated or removed has not been "revoked",
> and `/restore` will not help them.** Their record still says they are verified.
> What stops them is the gate, because the bot re-checks the recruitment
> spreadsheet on every single action. The fix is for recruitment to put the row
> back.
>
> `/restore` understands this distinction and tells you which of the two it found.
> You will see either "restored, and they can use the bot again" or "restored, but
> their roster row is inactive". If you get the second one, stop looking at the
> bot and go to the spreadsheet.
>
> Running `/restore` on somebody who was never revoked in the first place says so
> plainly and changes nothing.

## 4.4 Deciding whether a case is urgent

> **This section replaced `/generate_urgent_code` on 1 August 2026.** Under the old
> route a teacher had to telephone a Regional admin, be read a six-character code,
> and type it in correctly *before the bot would let them describe their problem at
> all*. The codes themselves, the command that issued them, the limit on wrong
> guesses and the alarm about stranded codes have all been removed. If you came
> here looking for `/generate_urgent_code`, this section is what it became.
>
> The whole change fits in one sentence. **The rationing moved from before the
> teacher may speak to before priority is granted.**

### What the teacher does

The teacher taps **⏫ Ask for Priority** and describes the problem, with nothing
standing in their way. Their case is filed at **normal importance**, or their
existing open case is added to, and it is stamped as having been asked about.

They are told plainly that a regional coordinator will decide, and that in the
meantime the case is being worked in the ordinary way. Nothing in that message
promises them anything.

**"Urgent" here means high priority, and it does not mean emergency.** The bot is
not a crisis line and never presents itself as one.

### What you do

You receive a message naming the teacher, their roster identifier and their
region, carrying a single button marked **⏫ Confirm urgent**. Check with them
however you normally would, whether by telephone, through the school, or by
whatever process you already use. None of this part is automated, and nothing will
chase you for an answer.

Tap the button only if the case genuinely should come ahead of the other open
cases. When you do, all of the following happens:

- Its importance becomes **Urgent** and its status **Escalated**, so it appears
  in `/urgent`
- **The teacher is told**
- Its owner, if it has one, is told
- Program rank and above are told, because this is the only granting act in the
  system with no second signature
- An audit row is written naming you

**Tapping it twice does nothing.** The second tap tells you who decided and
notifies nobody. This is deliberate, because the button lives in your Telegram
history permanently and will eventually be tapped again by accident.

**If the case had already been closed, confirming reopens it, and the bot tells
you so.** That is worth reading carefully when it happens, because it means your
tap has undone somebody else's decision to close the case. If it was not what you
intended, put the status back with `/status`.

**There is no decline button.** If a request should not be granted, simply do not
tap. The request stays visible in `/urgent_pending` until somebody grants it, and
§4.4a explains how to read that list.

### Who may decide

Support rank and above may decide, and the reason is the same one the old command
had. The person a teacher actually reaches is whoever is on the support desk, and
a decision that has to wait for a manager is a decision that arrives after the
thing it was about has already happened.

## 4.4a Requests nobody has decided

```
/urgent_pending
```

This lists every priority request that has no decision against it, oldest first,
showing how long each one has been waiting. It gives you references, statuses and
times, and it **never shows the teacher's words**. Those stay behind `/case`,
which records who read them.

**Nothing escalates these on its own, and that is by design.** Automatic
escalation would push every frivolous request up to Program anyway, which would
defeat the purpose of having a gate at all. Visibility was chosen instead, and
visibility only works if somebody actually looks, so this command is worth running
once a day.

It is deliberately **not** filtered to your own queue and region. A supervisor who
could only see their own region would have no way of noticing that a different
region has stopped answering.

**Every row shows the case's status, and some of them will say the case is
closed.** A case can be closed while a priority request on it is still undecided,
because closing the case does not answer the teacher who asked. Those rows stay on
the list on purpose, since silently dropping a teacher's unanswered request would
be worse than showing it, and the status is there so you can tell at a glance
which requests are still live work. To clear one of these, either confirm it,
which reopens the case, or mark the case urgent some other way, or tell the
teacher why the answer is no.

## 4.4b Two accounts claiming to be the same teacher

```
/disputes                                   everything waiting, oldest first
/dispute_resolve <id> <chat id> <why>       System only
```

**This procedure opens by itself.** When a second Telegram account signs in using
a teacher's recruitment address, the bot records the argument and messages **both**
accounts, each with a single button. The account that was already signed in gets
*"This wasn't me"*, and the new one gets *"This is me, I changed phone"*.

**Neither button decides anything, and neither account is locked out.** The second
account signs in and carries on working while the argument runs. That is
deliberate. Blocking it would lock out every teacher who changes phone, and it
would hand anybody who learns a colleague's recruitment address a way to lock the
real teacher out permanently.

**What happens, in order:**

1. Both accounts are messaged, and the operations chat receives the alarm it has
   always received. That alarm is what fires when *neither* account taps anything,
   which is exactly what a quiet impersonation looks like from the outside.
2. Either account taps its button. Staff covering **the region on the teacher's
   roster row** are then told. The region either account claims is deliberately
   ignored, because an impostor who had corrected their region could otherwise
   choose who judges them.
3. A reviewer checks however they normally would, whether by telephoning the
   school or by calling the teacher on a number already held, and then taps **Send
   to system admin**.
4. A system administrator chooses which account belongs to the teacher.

**Choosing is not a small action.** Every other account is signed out, and its open
cases are closed with a reason the teacher can read. `/restore <chat id>` will put
a wrongly signed-out account back, but **the closed cases stay closed**. That
asymmetry between what can and cannot be undone is why only System rank may do it.

Give a real reason, because it is required and because it is what somebody
reviewing the decision months later will actually read:

```
/dispute_resolve 42 995101 telephoned the school, Nodira confirmed the new number
```

The chat id you give is the account that **keeps** the identity, and not the one
that loses it. Running `/disputes` shows you which accounts are involved in each
argument.

**Nothing here expires on its own.** An argument nobody answers stays in
`/disputes` and keeps appearing in the morning message. The alternative would be a
dispute quietly ageing out while somebody who is not the teacher carries on
holding the account.

## 4.5 Pausing new cases

```
/maintenance on
/maintenance off
/maintenance          says which it currently is, and changes nothing
```

System rank only. It takes effect on the next message rather than within a minute.

This stops **new cases only**. The FAQ and Check My Case stay live deliberately,
because a teacher looking up an answer creates work for nobody, and turning the
whole bot off would tell them nothing about why. Teachers who try to open a case
are told that it is paused and given the support contact.

> **Cases will keep arriving for a while afterwards, and that is correct
> behaviour.** A teacher who is already part-way through writing one is
> deliberately not interrupted, because stopping them at that point would throw
> away everything they had typed. The confirmation message says so at the time.
> Please do not report the trickle as a fault.

## 4.6 Watching that it is working

```bash
docker compose ps
docker compose logs -f web worker
```

**Most of the watching is done for you.** The operations chat receives an alarm
whenever a scheduled job stops succeeding, a sync is refused by its damage limit,
a teacher's identity is claimed by a second chat, a priority request reaches a
region nobody covers, or a teacher was not told the outcome of something that had
actually succeeded.

An alarm arriving is ordinary and does not by itself mean a crisis. What is worth
checking is an alarm channel that has stayed silent for a week when you expected
some traffic, because a broken alerter looks exactly the same as nothing being
wrong.

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
> It does not mean that we must act. It is a **request to the teacher, and never a
> note to ourselves.**
>
> The phrase reads both ways to anybody meeting it for the first time, and the
> wrong reading sends work to the wrong person. A case sitting in "Action
> required" is waiting on the teacher, so chasing the staff member about it means
> chasing somebody who is correctly doing nothing at all.
>
> Whatever you type after `/await` **goes to the teacher**, so write it as though
> you are addressing them. Say *"please send a photograph of the passport page
> with your visa on it"* instead of *"waiting on passport"*.
>
> **A list of action types is planned**, covering things like sending a document,
> attending an appointment, or confirming an address. Until that exists this is
> free text, and nothing in the bot pretends otherwise. Whoever eventually builds
> that list should find this decision recorded here instead of inventing a second
> one from scratch.

**Why there are two ways to close a case.** The difference between *we fixed it*
and *we gave up* is the single most useful thing a later reader can learn from a
case, and that difference disappears entirely if both outcomes write the same
word. Use `unresolved` for a teacher who has left the country, stopped replying,
or withdrawn the request. The reason is required, it is your own words instead of
a list to pick from, and it becomes a note on the case. The teacher is told that
their case is closed and how to raise it again, without being told why. That
restraint is deliberate, because sending a blunt internal judgement to a teacher
would either be unkind to them or would quickly teach staff to write nothing
useful.

**There are four other statuses, and nobody types any of them.** *New* is written
when the case is first filed. *Received* is written when it actually reaches a
staff member. *Escalated* is written when a coordinator confirms a priority
request, as described in §4.4. *Duplicate* is written by the rule that stops a
teacher opening the same case twice within a day.

## 4.6b The rest of the staff commands

Type `/whoami` to see everything your own rank allows, and `/help` for the same
list in context. Both are generated from the permission rules themselves, so they
cannot describe access you do not have.

**Reading cases**

| | |
|---|---|
| `/cases` | Open cases in your queue and region |
| `/cases unassigned` | Open cases no staff member covers. This is a staffing gap rather than a queue of unclaimed work |
| `/mycases` | Open cases assigned to you |
| `/urgent` | Escalated cases, and separately from those, cases nobody has touched |
| `/case <ref>` | One case in full, including what the teacher wrote |
| `/search <text>` | Reference or the teacher's own words, including closed cases |

**Working a case:** the four words in §4.6a, plus

| | |
|---|---|
| `/note <ref> <text>` | Internal only. **No teacher ever sees these** |
| `/reopen <ref>` | Back to Under review. The teacher is not messaged |
| `/assign <ref> <chat id>` | Give it an owner. Refuses somebody who cannot see it |
| `/mark <ref> Normal\|Urgent\|Critical` | How serious it is. **This is what keeps a case for six months instead of seven days** |
| `/due <ref> <date>` | When you said it would be done. `2026-08-15` or `15 Aug 2026` |
| `/snooze <ref> <days>` | Stop chasing it for a while. It stays open and stays yours |

**Reaching teachers, and taking data out**

| | |
|---|---|
| `/announce <all\|region:Name> <text>` | Write a broadcast. It **sends nothing** by itself. See §4.14 |
| `/announce_send <id>` | Actually send it. Only the person who wrote it |
| `/announce_cancel <id>` | Stop it. Anybody who can announce |
| `/announcements` | Recent ones, and how far each got |
| `/export` | A spreadsheet of the cases you can see. It contains **no teacher's words**. See §4.16 |

**Yourself, and the periods**

| | |
|---|---|
| `/username @handle` \| `/username clear` | Publish your Telegram handle to teachers in your region. See §4.17 |
| `/retention` | Read the three retention periods. Given a name and a number, it changes one. See §4.11. **System only** |
| `/forget <chat id> FORGET` | Honour a removal request. **System only, and there is no undo.** See §4.15 |

**People**

| | |
|---|---|
| `/region <chat id> <region>` | Correct a teacher's region. See §4.10 |
| `/regions` | Teachers who have told us their region is wrong |
| `/revoke` `/restore` | §4.3 |
| `/staff` `/staff_add` `/staff_role` `/staff_remove` | Who is staff. System only |
| `/staff_region <chat id> <regions>` | Which regions somebody covers. `clear` means **every** region. See §2.6. System only |
| `/maintenance` | See §4.5. System only |
| `/urgent_pending` | Priority requests nobody has decided. See §4.4a |
| `/disputes` | Accounts arguing over who a teacher is. See §4.4b |
| `/dispute_resolve <id> <chat id> <why>` | Decide which account is the teacher's. **System only.** It revokes the others and closes their cases. See §4.4b |

**A case reference is always the first thing after the command.** `/reply` with no
reference is refused rather than guessed at, because the recoverable outcome is
being asked for one and the unrecoverable one is a teacher receiving an answer
meant for somebody else.

**You can only act on cases you can see.** Every command that changes a case
checks that first, so a queue or region you do not hold is not reachable by typing
a reference into it.

## 4.7 The monthly content review, which was removed rather than replaced

There used to be a monthly review here. It ran two thirty-day queries over the
message log to find out what teachers were asking that the answer bank could not
cover, and which confident answers they were rejecting. This document used to
describe that as the strongest signal available, on the grounds that an answer the
bot was *sure* about and still got wrong is the one most worth fixing.

**The message log now keeps three days.** Both of those queries would therefore
return nothing, every month, permanently. An empty result from a review reads
exactly like a system with no problems in it, which is precisely the failure this
whole rebuild set out to remove. The instructions have been deleted outright, so
that nobody is left running a review that quietly stopped working.

**Nothing replaces it, and that is a real loss rather than a tidy-up.** Two
questions are now unanswerable beyond three days: what teachers are asking that
the answer bank cannot cover, and which confident answers they are rejecting.

**A replacement was designed, offered on 30 July 2026, and not wanted.** It would
have been a nightly count taken just *before* the delete ran, keeping no teacher's
words at all and recording only figures like "this answer was rejected fourteen
times in October". It was considered properly and declined. This paragraph exists
so that the deletion above reads as a decision somebody made. **A section that
looks like an oversight is one somebody eventually restores by accident**, and a
restored §4.7 would run its two queries, return nothing, and look like good news.

**It remains available whenever it is wanted.** Nothing about the current design
forecloses it. It amounts to one small table and one extra step in a nightly job
that already exists, so asking for it later is a small piece of work and not a
redesign.

**None of this is an argument for a longer retention period.** Lengthening one
asks roughly 1,800 teachers to read the privacy notice again, as §4.11 explains,
and that is a high price to pay for a signal the nightly count would provide for
nothing.

Reviewing the *content* on a regular cadence still matters, and `CONCERNS` item A6
covers it. What has gone is the evidence this document used to tell you how to
gather.

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

It restores into a throwaway database, checks that the result actually contains
tables, prints the row counts, and then drops the scratch database. It never
touches live data at any point. Running it is the half of backup work that usually
gets skipped, and it is also the half that determines whether the backups are
worth anything.

---

## 4.10 Correcting a teacher's region

A teacher's region decides **which staff can see that teacher's case**, which
makes it a permission setting and not merely a piece of contact detail.

```
/region <chat id> <region>       sets it
/region <chat id> clear          back to whatever the spreadsheet says
/regions                         teachers who say theirs is wrong
```

The chat id is on `/case`, next to the teacher's name.

**Correcting the spreadsheet now works, where it never used to.** A region was
previously read once, at the moment the teacher signed in, and a teacher who has
signed in never signs in again. The effect was that corrections made by
recruitment reached nobody who was already using the bot. The spreadsheet is now
read live, so a correction arrives on the next sync.

**`/region` is for the situation where the spreadsheet is not the right answer.**
The usual case is a teacher who has genuinely moved, while recruitment's record
stays correct for recruitment's own purposes. The command writes a decision on our
side of the system and **never touches the spreadsheet**. Using `clear` removes
that decision and hands the teacher back to whatever recruitment says, which is
also how you undo a typo.

Three things it refuses, each for a reason:

- **A region nobody has heard of.** A typo here would place the teacher in a region
  that no staff member covers. Their cases would then be visible only to
  all-region staff, routed nowhere in particular, and wrong in a way that nothing
  in the system reports. Instead of accepting it, the command lists the real names
  back to you.
- **Moving a teacher across a boundary you do not hold.** This includes moving one
  *out* of a region you do not hold, which is the same act viewed from the other
  side. Ask somebody who covers both regions, and remember that Program and System
  rank cover all of them.
- **Nothing at all, if the teacher already has that region.** The command tells you
  so instead of writing a change that changes nothing.

**The bot asks each verified teacher whether the region it holds is still right,
at most once every 180 days.** It deliberately does not ask on every visit. There
is no session to attach the question to, so asking more often would produce a
prompt that 1,800 people tap through without reading. What working correctly looks
like here is a slow trickle of flags arriving over time. A sudden burst of them is
worth asking about.

**`/regions` shows you teachers' reports, and a report is not a change.** When the
bot asks a teacher whether the region it holds is still right and the teacher says
no, it raises a flag and writes nothing else. The teacher is deliberately **not**
asked where they are now, because a menu of regions is really a menu of whose
emergency this teacher becomes, and one wrong tap would send it to the wrong
region entirely. Ask the teacher yourself, then use `/region`. The report leaves
the list as soon as somebody acts on it.

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
number, or anything that is not a whole number is refused, and the current value
is restated back to you. `0` deserves particular care, because it would mean
*delete every resolved case immediately* and it sits one keystroke away from a
plausible typo.

**Lengthening a period tells you what it will cost before it writes anything**,
and then goes ahead and writes it. The cost is that roughly 1,800 teachers will be
asked to read the privacy notice again the next time they use the bot. Nobody
should have to discover that from a sudden jump in the outbound message count.

The SQL below still works, and it is here for the case where the database cannot
be reached from Telegram. Prefer the command wherever you can, because it
validates the value, warns you about the cost, and leaves a record of who changed
what.

```sql
INSERT INTO settings (key, value) VALUES ('CASE_RETENTION_DAYS', '14')
ON CONFLICT (key) DO UPDATE SET value = excluded.value;
```

**Two rules, and the second is the expensive one.**

**Leaving a key unset means nothing is deleted.** Removing a key does not restore
anything that has already been deleted, and only stops further deletion from
happening. Once a record has gone, there is no way back to it.

**Lengthening a period requires every teacher to read the privacy notice again.**
Keeping data longer than people were told is a change to what they agreed to.
Shortening a period carries no such requirement. Deleting sooner than promised
breaks no commitment that was made to anybody, and putting 1,800 people through a
re-consent purely to be told their data will go sooner is a cost that benefits
nobody.

The notice teachers read is **generated from these values**, so it always states
what the system will actually do. That is the entire reason these live as settings
instead of as numbers written into the program. A settings row and a hand-typed
sentence can drift apart from each other, whereas a generated sentence cannot.

Every change is recorded against whoever made it. "Who shortened this to one day,
and when" is an audit question.

**The consequence you will meet first, probably in week two,** is that a week
after a case is closed its reference stops working. A teacher telephoning about
`VISA-2026-00123` will be told there is no such case, and `/reopen` will have
nothing left to reopen.

## 4.12 What happens on its own, and when

Five things now happen without anybody asking. All times are Tashkent time.

| When | What |
|---|---|
| **02:00, nightly** | Records past their retention period are deleted (§4.11) |
| **07:00, daily** | Each staff member gets their own morning list; teachers who owe a reply are reminded; published Telegram handles are re-checked |
| **Every minute** | Any confirmed announcement sends its next two hundred people (§4.14) |
| **Every ten minutes** | The spreadsheet is copied in, covering **answers, the roster and the document form links**, and then **every form's submissions are read back and filed** (§4.18) |
| **Every five minutes** | The other four are checked for having stopped. This is the one that raises the alarm below |

**That ten-minute line is the one to remember when somebody asks why a submitted
document has not appeared yet.** It is the same ten minutes §4.18 tells you to
wait before checking that a test submission became a case.

**If one of these stops running, an alarm arrives in the operations chat**, naming
the job and saying when it last succeeded. That alarm exists because a job that
stops being scheduled produces no error of its own. It simply goes quiet, and
silence is exactly what this alarm is built to detect. §5.5 covers what to do
about it.

## 4.13 The morning message, and chasing a teacher

**At 07:00 each staff member who can act on cases gets one message containing
their own three lists:** the cases they own that are past the date they promised,
the cases in their queue and region that nobody has touched, and the ones in it
that nobody owns.

**Somebody with nothing due receives nothing at all,** and that is deliberate. A
daily message saying "nothing to do" is a daily message people set a filter for,
and once the filter exists it catches the one that mattered too. **Observers never
receive one under any circumstances**, because being paged about work you are not
permitted to do is the fastest way to learn to ignore the page.

If somebody reports that they are not receiving it, there are three things to
check. Confirm that they are active, that their rank is above Observer, and that
they have opened a chat with the bot at all. A staff member who has never sent the
bot `/start` cannot be messaged by it. That failure is counted in the logs instead
of raising an alarm, because it is an onboarding problem and not a fault in the
system.

### The teacher chase

**A case left at `Action required` is waiting on the teacher and not on staff.**
After three days it is therefore the *teacher* who gets reminded. The staff member
holding the case is never chased for it, because they are correctly doing
nothing.

The reminder names the case and repeats, word for word, whatever was typed into
`/await`. **That text is the only thing the teacher ever sees**, which is why it
is worth writing as a sentence the teacher can act on instead of as a note to
yourself.

**There are three reminders and no more than three.** After the third, the case's
owner is told that the teacher has stopped responding, and nothing chases anybody
again. This is the exact situation `/close <ref> unresolved <reason>` exists for,
covering a teacher who has left the country, changed their number, or simply given
up.

Two details here will otherwise get reported as faults. The first is that **a
reminder which could not be delivered does not count towards the three.** Three
reminders means three that actually arrived, and a case whose reminder failed
simply comes back around tomorrow. The second is that **the clock restarts
whenever the status changes,** so a case that leaves `Action required` and later
returns to it begins again from zero.

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

**Only the person who wrote a draft can confirm it.** This is not a permission
rule but a
colleague confirming your words is sending words they did not write, to 1,800
people, under their own name.

**4. Wait for the report.** About two hundred people a minute, so roughly nine
minutes for everybody. When the last person is resolved the sender gets one
message: how many were delivered, how many were **skipped** because they no
longer have access to the bot, and how many **could not be reached**. Those three
are counted separately because they need different things done about them, and
skipped is correct behaviour, and could-not-be-reached is usually somebody who
blocked the bot or never started a chat with it.

### Stopping one

```
/announce_cancel <id>
```

**Anybody who can send announcements can cancel one**, and not only the author. A
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
  Retention removes the words on its own, seven days after each case is closed,
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
see**, so a Lead gets their own region and cannot export another.

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
conversation about where the file is allowed to go, and it is not a column
somebody quietly adds.

## 4.17 Publishing a manager's Telegram handle

Teachers can ask **"who covers my region?"** from the main menu, without signing
in, because somebody who cannot sign in and needs a person to talk to is exactly who
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
it is a label its owner can release, and once released **anybody can claim it.**
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

## 4.18 Publishing a document form, the whole procedure

**Do all six steps. Steps 3 and 4 are the ones that go wrong**, and when they do
the bot looks perfectly healthy while quietly reading nothing. Step 7 is not part
of publishing a form — it is how to retire one without losing anybody's documents.

The bot never receives a file. Teachers fill in a Google Form; the documents stay
in Google; what the bot reads back is the fact that somebody submitted, and who.

### 1. Build the form in Google Forms

Whatever questions you need. There is one rule about the email question, and it
has two ways of being satisfied:

> **Either exactly one question has the word "email" in its title — or you tell
> the bot which question is the right one, in the `EMAIL_COLUMN` column of the
> `FORMS` tab.**

If only one question mentions email, you need do nothing: "Your email address",
"Recruitment email" and "E-mail" all work, because the bot ignores capitals,
spaces and hyphens.

**More than one question mentioning email is normal and is not a mistake.** Every
one of our four real forms has several, for two entirely ordinary reasons. Google's
own **Collect email addresses** setting adds a hidden `Email Address` column, and
the form usually asks for the address as a question as well — so there are two
before you have done anything. Then a form that sensibly asks for a school contact
email, or an emergency contact email while somebody is on leave, has three or four.

Those are the right questions to ask. **Do not reword them.** Fill in
`EMAIL_COLUMN` instead — step 4 — and the bot will stop guessing and use the
question you named.

If several questions mention email and you have *not* named one, the bot refuses
that form's responses entirely and the operations chat says so, listing the
headings it found. It refuses rather than guessing because filing somebody's
documents under their supervisor is worse than not filing them.

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
5. Google adds a new tab to that spreadsheet. **Write down its exact name**, because it
   is usually "Form Responses 1", or the form's title.

### 3. Note the tab's exact name

Open the spreadsheet and look at the new tab along the bottom. Copy its name
character for character, including spaces and capitals. `Form Responses 1` is not
the same as `Form responses 1`.

Renaming the tab to something meaningful, such as `PASSPORT_RESPONSES`, is a good idea,
and easier to get right later. Do it now, before step 4, not after.

### 4. Add the row to the `FORMS` tab

| Column | Needed? | What goes in it |
|---|---|---|
| `TYPE` | yes | A short code in capitals with no spaces or punctuation, such as `PASSPORT` or `VISA`. This travels inside the button, so it must be short and plain |
| `BUTTON_TEXT` | yes | What the teacher sees on the button. An emoji is fine, for example `🛂 Passport copy` |
| `URL` | yes | The form's link, from **Send → 🔗** in Google Forms. Must start with `https://` |
| `RESPONSES_TAB` | no | **The exact tab name from step 3.** These two must match perfectly |
| `ACTIVE` | no | `TRUE` to show it, `FALSE` to hide it. Blank means shown |
| `CATEGORY` | no | Which area a complaint raised here is filed under. Blank means `Contact Support`. See below |
| `PREPARE` | no | What the teacher should gather, shown above the link. **Filling this in turns the form into an area** — see below |
| `EMAIL_COLUMN` | no | The exact heading of the question holding the teacher's own email address |

Leave `RESPONSES_TAB` blank if the form is not linked yet. The button still
appears and teachers can still submit, but the bot will not read anything back
until you fill it in.

**Finding the right `EMAIL_COLUMN`.** Open the responses spreadsheet, look along
the top row, and copy the heading of the question that asks the teacher for *their
own* address — not the school's, not an emergency contact's. Copy it character for
character. **Including a trailing space if there is one**, which there often is,
because Google keeps whatever was typed when the form was built. If you get it
wrong the operations chat tells you the heading it looked for and lists every
heading that is actually there, so it is a one-minute fix rather than a mystery.

Leave `EMAIL_COLUMN` blank when only one question mentions email. Nothing changes.

### 4a. Form areas — a complaint and its paperwork together

**Fill in `PREPARE` and the form stops being just a link.** The teacher is shown
what to gather, then the link, then asked to say what they need — and what they
type opens a case with the paperwork attached to it when it arrives. Before this,
a teacher with a problem could either submit documents or describe the problem,
and nothing joined the two.

`CATEGORY` decides who works it. It must be one of the areas the bot already has:

`Visa` · `Travel and Arrival` · `Contract Signing` · `Accommodation` ·
`Submit Documents` · `Contact Support`

**A category the bot does not have is rejected with its row number** and the other
rows still sync, so a typo costs you one form rather than all of them.

This is the mapping we recommend, and it is yours to change in the sheet at any
time — no developer needed:

| The button says | Filed under |
|---|---|
| Accommodation | `Accommodation` |
| Reimbursement | `Travel and Arrival` |
| Holiday Leave | `Contact Support` |
| Medical Leave | `Contact Support` |

Holiday Leave and Medical Leave get a button with their own name but no area of
their own, which is deliberate: a new area needs its own queue, its own staff and
its own reference numbers, and two of those do not exist yet. The button is what
the teacher sees, and the filing happens quietly behind it.

**Keep `PREPARE` short.** It is read on a phone, in a chat, before the teacher
leaves for the form. The list of documents, the filename to use, and one warning
is about right. Sample fees, tables and paste-here boxes belong in the Google Doc
the teacher is about to open, not in a chat message.

### 5. Wait ten minutes

The sync runs every ten minutes. Then open the bot as a teacher would and tap
**Submit Documents**. The new button should be there.

**If the row was wrong**, the operations chat gets a message naming the row
number and what to fix. Fix the sheet; the next sync recovers on its own.

### 6. Check that it reads back, rather than waiting for a real teacher

Submit the form yourself, using **the recruitment email of a teacher who has
already signed in to the bot** (your own, if you are on the roster). Within ten
minutes:

- A `Submit Documents` case should exist for that teacher, which you check with `/cases`.
- The case should carry a note naming the form.

**If nothing appears**, it is almost always step 2 or step 4: the responses went
to a different spreadsheet, or `RESPONSES_TAB` does not match the tab name.
Compare the two, character for character.

### 7. Retiring a form — leave the row on the sheet for a day

> **The bot stops reading a form the moment it leaves the sheet.** A submission
> that arrives after you remove the row is never filed, and nobody is told — not
> the teacher and not the staff.
>
> **So when you stop telling teachers about a form, leave its row on the `FORMS`
> tab for a day**, with `RESPONSES_TAB` still filled in. Set `ACTIVE` to `FALSE`
> if you want the button gone immediately; that hides it from teachers while the
> bot goes on reading. Then delete the row the next day, once anything already
> submitted has been swept up.

This changed on 3 August 2026 and it was a deliberate trade. The bot used to keep
reading a form for ever after it was switched off, exactly so that last night's
submissions were never lost. But nothing ever ended that: a test form retired
weeks earlier was still being read every ten minutes, its response tab no longer
existed, and every single attempt raised a critical alert. That was the
notification noise, and it had no way of stopping short of editing the database by
hand.

The cost of the fix is the paragraph above, and one day of patience is what pays
it.

> ### ⚠️ Never delete or reorder rows in a responses tab
>
> The bot remembers which submissions it has dealt with **by row number**, and
> that is the only stable identifier Google gives it. Deleting a row shifts every
> row below it up by one, and the bot will file all of them again as new
> submissions.
>
> If a submission is wrong, leave the row alone and close the case instead.

### What staff see when a submission cannot be filed

Two different alarms, and they mean different things:

**"Submissions from teachers who have not signed in"** means the address is on the
roster, so we know exactly who they are, but they have never opened the bot.
There is nothing to file the case against. **Their documents are safely
submitted**; ask them to open the bot and sign in, and the next thing they send
will file normally.

**"Submissions that matched no teacher"** means the address is on no active roster
row. Either the teacher used a different address from their recruitment one, or
the roster is missing them. The documents are still in the form's responses.

# PART 5: When something is wrong

## 5.0 Every alarm the bot can send, and what to do about each one

**Search this table for the words in the message you received.** The titles below
are exactly what arrives in the operations chat, character for character, so you
can match them without knowing anything about how the bot works.

**These are the only messages the bot ever sends to the operations chat.** If you
receive something not on this list, it did not come from the bot.

🔴 = act now · 🟠 = act today · 🔵 = for information, no action

### The sheet syncs

| Alarm | 🚦 | What it means | What to do |
|---|---|---|---|
| `FAQ sync failed` · `ROSTER sync failed` · `FORMS sync failed` | 🔴 | That tab could not be read at all. Usually a renamed or deleted column. **Nothing was changed**, so the previous good data is still live | The message names the missing column. Restore its name in the sheet. The next sync recovers on its own, within ten minutes. §5.4 |
| `FAQ sync refused` · `ROSTER sync refused` · `FORMS sync refused` | 🔴 | The sheet would have switched off more rows than the safety limit allows, usually because of a filter left on or rows deleted by accident. **Nothing was changed** | Look at the tab. If rows were removed by mistake, paste them back. If the removal is genuine, §5.4 has the override |
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
| `Nothing is being deleted, because no retention period is set` | 🟠 | Repeats **every night** until somebody sets a period. The bot is working correctly; it has simply been told to keep everything, and the privacy notice is telling teachers exactly that | Set the three periods, using §2.4 or `/retention`. See §4.11 |
| `The nightly deletion pass did not finish` | 🟠 | One or more tables were not cleaned. The others were. Nothing is lost, and deletion is simply late | Read which table failed. If it repeats two nights running, it needs a person with database access |

### Cases and teachers

| Alarm | 🚦 | What it means | What to do |
|---|---|---|---|
| `Scheduled job "…" has stopped` | 🔴 | A job has not succeeded for longer than it should have. **This is the alarm that tells you the bot has gone quiet** | §5.5 |
| `A teacher was not told what happened` | 🔴 | Staff replied, or closed a case, and the message did not reach the teacher. **The work happened; the teacher does not know** | §5.7 |
| `Somebody was not told about something that happened` | 🟠 | As above, for a message that was not the first one | §5.7 |
| `A message could not be handled` | 🔴 | Somebody sent the bot a message and processing it failed outright. **This is the opposite of the two above**: there, the work succeeded and the telling failed, whereas here the work itself did not happen | Read the alarm carefully. It says which of three situations you are in, and they need different responses. §5.7a |
| `A teacher asked for priority and nobody can decide it` | 🔴 | A priority request arrived and no active staff member holds `urgent.issue`, neither in that region nor at System | §5.6 |
| `A teacher identity is now held by more than one chat` | 🟠 | Two Telegram accounts signed in with the same recruitment email. Both can see that teacher's cases. **A dispute has already been opened and both accounts have been given a button** | Usually a new phone, and usually one of them will tap. If neither does, this alarm is the only sign you will get, so settle it with `/disputes`. See §4.4b |
| `An identity dispute has nobody to review it` | 🔴 | Two accounts claim one teacher and **no active staff member at all**, not even a System administrator, can be found to look at it | Somebody has to be given a staff row before this can be settled. §2.5 makes the first System member; §4.4b settles it afterwards |
| `An identity dispute reached System and there is no System member` | 🔴 | A reviewer passed a dispute on and nobody holds the rank to settle it | The launch checklist requires two named System members for exactly this. §2.5 |
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

- `{"status":"degraded"}` means the database is unreachable. Check `docker compose ps`
  and the `postgres` logs.
- No response at all means the web process or Caddy is down. Check `docker compose logs web`
  and `docker compose logs caddy`.
- `{"status":"ok"}` with no replies means Telegram is not reaching us:

```bash
docker compose exec web node dist/scripts/set-webhook.js --show
```

Read `last_error_message` and `pending_update_count`. A rising pending count with
an error message names the problem directly. "Wrong response from the webhook"
almost always means the certificate is not valid yet.

**Silence with a healthy process and a clean webhook is the dangerous case**, and
it usually means new code is running against an old schema. Handler errors are
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

The teacher's case **is filed** and they have their reference, so nothing has been
lost. What has not happened is the decision: the case is sitting at normal
importance and will stay there.

The alarm fires only when there is no active staff member holding `urgent.issue`
at all, neither covering that region nor at System, which is the
fallback. So it is a staffing answer rather than a technical one:

1. `/staff` to see who is active. If the list is short, somebody has been removed
2. Add a Support member, or raise an Observer with `/staff_role`
3. If people exist but cover the wrong regions, use `/staff_region`. See §2.6
4. Then `/urgent_pending` and grant anything that should be granted

**A System row being inactive is the most likely cause**, because System is what
this falls back to. Two named System members exist by launch-checklist
requirement precisely so this cannot happen from one person leaving.

## 5.7 An alarm says a teacher was not told what happened

Whatever they did **succeeded**, and the database committed it, but the reply did not
reach them, so from their side the bot ignored them. The alarm carries the chat id
and the message that failed.

If it was a case, the case exists and Check My Case will show it to them. Tell
them so.

## 5.7a An alarm says a message could not be handled

This one is the opposite of §5.7. There, the work succeeded and only the telling
failed. Here the work itself did not happen at all, so somebody sent the bot a
message and nothing came of it.

**The alarm tells you which of three situations you are in, and the three need
different responses.** Read that line before doing anything else, because acting
on the wrong one either wastes an afternoon or misses a lost message.

- **"The claim on this update was released."** Telegram will retry the message on
  its own, and it may well succeed the second time. No action is needed unless the
  same update id keeps appearing, which means it will never succeed and somebody
  has to look at what that person was trying to do.
- **"Nothing had claimed this update yet."** No message has been lost. Telegram's
  retry will be accepted normally. This wording almost always means the failure
  happened before any work started, and the usual cause is the database being
  unreachable, so check `docker compose ps` and the logs.
- **"Whether this update is still claimed could not be determined."** This is the
  only one of the three that needs somebody to chase a person. Giving the claim
  back failed as well, so if the update is still claimed, Telegram's retry will be
  discarded and that message is gone. Find out from the chat id who was writing,
  and ask them to send it again.

**A burst of these all at once is a database problem rather than a message
problem.** When the database is unreachable every arriving message produces one of
these, and they will almost all carry the second wording. Fix the database and the
messages arrive by themselves.

## 5.8 Restore from backup

Last resort, and it loses everything since the dump.

```bash
./deploy/restore-drill.sh
```

Prove the backup is good **first**, then restore for real following
`deploy/README.md`. Restoring is not a rollback for a bad deploy. For that, check
out the previous tag and rebuild (2.2).

---

# PART 6: Not built yet

Listed so nobody goes looking for them.

| | Arrives with |
|---|---|
| **Reading the audit trail from a command** | Deliberately never. It is read by somebody with database access during an investigation, and a command to read it would need its own permission model to avoid becoming the thing it audits |
| **A teacher resigning through the bot** | Later. A Program member would unlock it per teacher, and the record would be anonymised three months afterwards. The anonymising half is built and is what `/forget` uses |
| **Scheduling an announcement for later** | Not built and nobody has asked. `/announce_send` sends now |
| **Telling a teacher before their case is deleted** | Deliberately not. 1,800 people receiving "your case record has been removed" is noise, and the notice states the period. The first person to meet it will be a staff member on the telephone, which is why §4.11 says it in the words they will need |
| **Turning the morning digest off** | Deliberately not. No per-person opt-out and no frequency setting: a digest people can switch off is a digest that stops arriving for the people who most need it. If it is wrong for somebody, that is a conversation |
| **Anything about districts** | Never. Uzbekistan has regions and districts and this bot is concerned with regions only |
| **A list of "action required" types** | Planned for later. Until then `/await` carries free text. See §4.6a |
| **Document submission** | ✅ **Built in Stage 6**, and **through the existing Google Forms rather than the bot.** An earlier version of this document called Telegram upload "the only genuinely new feature in the rebuild"; that direction was reversed. The bot never accepts or stores a file. It publishes form links from a third spreadsheet tab, and matches submissions to teachers by their recruitment email, which is the same identity check as signing in and stronger than the old system's editable hidden field. **§4.18 is the procedure for publishing a form**, and it is not optional reading: two of its steps fail silently |
| **Russian and Uzbek** | Not scheduled. The interface is built so that translating it is a display change, with no effect on how buttons route |

---

## Where everything else is

| | |
|---|---|
| `deploy/README.md` | Server setup, step by step |
| `BOT-SPEC.md` | What the system does, and why each decision was made |
| `CONCERNS-AND-IT-ACTIONS.md` | Accepted risks, and what still needs a person |
| `src/config/privacy.ts` | The privacy notice teachers are shown |
| `FAQ-import.csv` | The approved answer bank. **Confidential** |
