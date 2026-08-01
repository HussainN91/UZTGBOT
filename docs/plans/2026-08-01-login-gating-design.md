# Part 5F — the login-gating hole: the design

**Date:** 1 August 2026 · **Status:** designed and approved, **not built** · Belongs to
`2026-08-01-identity-and-urgent-design.md` Part 5F, which stays the plan of record.

> **No code was written for this.** The session that produced this document was stopped at the
> design boundary, deliberately, before implementation. The working tree is clean.

---

## 1. What is wrong today

A brand-new chat types `/start`. It receives the privacy notice and *"reply with the email address
you were recruited with."* No menu, no buttons. The chat is held in `AwaitingIdentifier`, and
anything else typed at it is read as a failed email attempt.

The FAQ is deliberately open to everybody — the code says so in four places, and the reason is that
somebody who *cannot* sign in and needs an answer is exactly who needs it most. But no new teacher
can reach it, because the front door hands them a sign-in prompt with no way past.

**A door that is open and unreachable is closed.** This is a live defect, not an improvement.

## 2. The two decisions the head of project made

Both were taken on 1 August 2026, and both are binding.

### Decision 1 — the unsigned menu shows only what works without an account

Two options were put. The one **not** chosen was showing the whole menu with a Sign in button added,
leaving the four gated buttons visible and letting a tap route through the existing sign-in gate.

**What was chosen:** an unsigned chat sees the FAQ shortcuts, All FAQ topics, Who covers my region?,
and a Sign in button. **Check My Case, Submit Documents, Contact Support and Ask for Priority are
not shown until the chat has signed in.**

Nothing is offered that would stop and ask for an email address. The four gated actions remain
exactly as gated as they are now — hiding a button is *in addition to* the gate behind it, never
instead of it, because a button lives in a teacher's scrollback for ever.

### Decision 2 — the menu says what signing in unlocks

The message an unsigned chat gets:

```
What would you like to do?

You can read the answers below without signing in. Sign in to report a
problem, ask for priority, send documents, or check a case you have
already sent.
```

The reasoning, in the head of project's terms: a recruited teacher arrives expecting to be able to
report a problem. A short menu with no explanation makes the bot look like it only answers
questions, and they may leave rather than sign in.

**This is new teacher-facing text and it is a draft as far as MoPSE is concerned**, like the nine
messages Feature B added. It joins open question 1 of the plan of record.

## 3. Three menus, not two

The reduced menu forces a distinction the bot has never had to make, because "not signed in" turns
out to be two different people.

| Who | Menu | Sign in button | Explanation line |
|---|---|---|---|
| **Signed in** — `teacherHasAccess` is true | Full, exactly as today | No | No |
| **Never signed in** — no teacher row, or one that never verified | Reduced | **Yes** | **Yes** |
| **Access ended** — Revoked, or Verified with the roster row gone | Reduced | **No** | **No** |

### Why the third row exists, and why it is not optional

**A revoked chat must never be offered the sign-in prompt.** `bindTeacher` clears `revoked_at`, so a
revoked teacher who reaches sign-in undoes their own revocation by typing an email address,
silently. That exact hole existed on `/start` and was closed at `a37fef8`.

A two-way split — signed in or not — would put a Sign in button in front of every revoked teacher
and reopen it. So the test is `teacherHasAccess` for the first row and, for the difference between
the second and third, the same `hadAccess` condition `requireSignIn` already uses: a teacher row
exists and its state is `Revoked` or `Verified`.

The explanation line is dropped for the third row for a plainer reason. "Sign in to report a
problem" is an invitation to do something they cannot do, and it would read as the bot taunting
somebody whose access a member of staff has just ended.

### The fourth door is the same door

The plan's warning is that a Sign in button on the menu adds a **fourth** route into sign-in, on top
of `startReply`, `requireSignIn` and `verifyIdentifier`, and that it has to refuse a revoked chat
like the other three.

**It should not be a fourth implementation of the rule.** The Sign in button routes through
`requireSignIn` itself:

```
SIGN_IN  →  requireSignIn(db, chatId, MENU_ACTION.MAIN, deps)  ??  the menu
```

`requireSignIn` already returns `accessEndedReply` for a chat that had access, the prompt for one
that never did, and `null` for one that is already signed in — which lands on the menu, the right
answer for a stale button tapped after signing in. The rule is not restated, so it cannot drift.

**The test must assert the refusal, not the button's absence.** A button a revoked teacher never
sees is still reachable from their scrollback.

## 4. The menu has to be consistent everywhere, not only on `/start`

The plan says *"the only change is what `/start` returns for an unsigned chat."* **That is not
enough, and building only that would produce something incoherent.**

A new teacher types `/start`, gets the reduced menu, taps **All FAQ topics**, reads an answer, and
taps **🏠 Main Menu** — which is `MENU_ACTION.MAIN`, a different code path. If only `/start` changed
they would land on the full menu with Contact Support on it. The reduced menu would appear once and
never again.

So every place the main menu is rendered resolves which of the three it is. In `router.ts` that is:
`/start`; the Home button; the "I can only read text messages" reply; the undecodable-payload
fallback; the unknown-prefix fallback; the unknown-menu-action fallback; and the privacy-acceptance
path for a chat with no teacher row.

### Keeping the property that the menu cannot fail

`mainMenuReply()` is documented as *"the one thing that cannot itself fail"* — it is pure, with no
database, because it is where a teacher lands when anything goes wrong anywhere else.

**That property is kept.** `mainMenuReply` and `mainMenuKeyboard` stay pure and gain a parameter
saying which of the three menus to build. A small async helper in `router.ts` does the one teacher
lookup and chooses. The lookup is `findTeacher`, which every gated path already makes, and it runs
inside the transaction the router is already in.

Two call sites pass the answer directly instead of looking it up, because they already know it:
`startReply` when the teacher is verified, and `resumeAfterSignIn`, which runs in the same
transaction as a successful `verifyIdentifier`.

### The region question is asked only of a signed-in teacher

`menuWithRegionCheck` puts *"is the region we hold for you still right?"* beside the menu when one is
due. `regionCheckDue` filters on `verificationState = 'Verified'`, so an unsigned chat is already
safe — but a **revoked** chat can hold a `Verified` row with a stale `region_asked_at`, and would be
asked to confirm a region for a bot it can no longer use. The check runs only for the first row of
the table in §3.

## 5. One thing I decided, which is worth your eye

**The Contact Support button under FAQ answers stays where it is.** It appears on the topic listing,
on the answer picker, and under a question the answer bank could not match — not on the menu.

My reasoning: the menu is a list of what you can do, and Decision 1 says an unsigned teacher's list
should not include things that stop and ask for an email. The button under a failed answer is a
different object — it is an escape hatch at the moment of failure, and it leads somewhere, because
`requireSignIn` records what they were trying to do and puts them back on it after they sign in.
Removing it would leave a teacher who has just failed to find an answer with nowhere to go, which is
the same shape of defect as the one this part exists to fix.

**If you would rather it were hidden from unsigned chats too, say so** — it is three more keyboards
and roughly two more hours, and it is your call, not mine.

## 6. What changes

| File | Layer | Change |
|---|---|---|
| `src/telegram/keyboards.ts` | 3 | `MENU_ACTION.SIGN_IN`; `mainMenuKeyboard` takes which menu to build |
| `src/telegram/handlers/menu.ts` | 3 | `mainMenuReply` takes the same, and carries the explanation line |
| `src/telegram/router.ts` | 3 | `startReply` returns the menu instead of the prompt; the `SIGN_IN` case; one helper resolving which menu; the seven render sites |

**No database change, no migration, no new table, no new column.** `callback-data.ts` gains one
menu action, not a prefix, so the 64-byte budget is untouched. `deps:check` should be unaffected —
nothing new is imported across a layer.

**Cost: about half a day**, as the plan of record says.

## 7. What proves it works

- A brand-new chat types `/start` → the reduced menu, with the Sign in button and the explanation
  line, and **no** `AwaitingIdentifier` state saved
- That chat taps an FAQ topic and reads an answer without signing in
- That chat taps 🏠 Main Menu → the **reduced** menu again, not the full one
- That chat taps Sign in → the privacy notice and the email prompt, exactly as today
- Replying with a roster address signs them in and lands them on the **full** menu
- A signed-in teacher types `/start` → the full menu, unchanged, with the region question beside it
  when one is due
- **A revoked chat types `/start` → access ended, and is not prompted**
- **A revoked chat taps a Sign in button from its scrollback → access ended, and `revoked_at` is
  still set afterwards.** This is the assertion that matters most in the whole part
- A revoked chat's menu has no Sign in button on it
- A Verified teacher whose roster row was deactivated is treated as access ended, not as new
- An unsigned chat taps a Contact Support button from an FAQ answer → the sign-in prompt, and after
  signing in it is put back on opening a case
- `npm run deps` still reports zero cycles and zero layer violations

## 8. What was not settled

Nothing in this part. The four decisions in §9 of the handoff are unrelated to it and none of them
blocks building this.
