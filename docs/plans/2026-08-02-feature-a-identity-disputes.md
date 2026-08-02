# Feature A — identity disputes: design and build plan

**Date:** 2 August 2026 · **Status: ✅ BUILT, 2 August 2026, commit `d2c8e36`.**

> **Everything below was built, in the order it is written.** The four departures
> from Part 2 in §1 are the design as it now stands; the tasks in §4 are kept as
> the record of how it was done and what each step was guarding against.
>
> **Two things the build found that the plan did not predict**, both worth
> reading before touching this again:
>
> 1. **The bot has never captured a Telegram display name.** §5 of Part 2 assumed
>    the reviewer would be shown one for each account. Nothing anywhere reads
>    `from.first_name`, and `teachers.name` is the **roster** name copied at
>    sign-in — identical for every party by construction, so it distinguishes
>    nobody. The reviewer is shown each account's chat id, when it first appeared
>    and when it was last active instead. Those are held, and for telling two
>    accounts apart they are more decisive than a name anyone can change.
>    **Capturing display names is still open**: it is a schema change, a change to
>    the update path, and more personal data held, so it was written up rather
>    than smuggled in. See §7.
> 2. **`settleAndAnnounce` could not live in `router.ts`.** `commands/index.ts`
>    imports every staff command and `router.ts` imports the dispatcher, so
>    `/dispute_resolve` reaching into the router closes a cycle — the same one
>    Part 5H.3 hit. It lives in `src/telegram/dispute-actions.ts`, which both call.
>    The cycle was telling the truth again.
>
> ```
> 1,248 tests across 67 files · 0 failed · 0 skipped · 219s
> typecheck, build, lint, deps all clean
> ```

> **For agentic workers:** the steps below use checkbox (`- [ ]`) syntax. Build them in order.
> `CLAUDE.md` carries the rules this plan assumes — the layer rule, the raw-SQL traps, the
> verification set, and how the head of project wants to be worked with.

**Goal:** when two Telegram accounts sign in as the same teacher, open a record that both accounts
and the Ministry's staff can act on, and let a System administrator decide which account is the
teacher's — without the decision ever being taken by either account, and without the second
account being locked out while it is pending.

**Architecture:** one layer-2 store (`teachers/disputes.ts`) that opens, claims, escalates and
resolves; one layer-2 notifier (`teachers/dispute-notify.ts`) that decides who is told and writes
the words, mirroring `cases/service.ts` + `cases/notify.ts` exactly. Neither sends. The router
(layer 3) sends, after the transaction commits. Two new tables, three new callback prefixes, two
new capabilities.

**What Part 2 of the programme plan settled, and this does not reopen:** the second chat still
signs in; the adjudicating region is the roster's, never the chat's; the losing chat is *revoked*
and its cases are *closed with a reason*, never deleted; resolution is System only.

---

## 1. Four departures from Part 2, with reasons

Part 2 of `2026-08-01-identity-and-urgent-design.md` is the agreed design. Four things in it do not
survive contact with the code, and each is changed deliberately here rather than quietly.

### 1.1 — Two tables, not one. **A third chat could not join the record as drawn.**

Part 2 lists one table with `prior_chat_id` and `new_chat_id`, and separately requires that **"a
third chat signing in joins the existing dispute — keyed on identifier, never a second record"**.
Those two sentences cannot both be true: a two-column record has nowhere to put a third party, and
the third chat would either overwrite the second or get no button at all.

So the parties are their own table. `identity_disputes` holds the dispute; `identity_dispute_parties`
holds one row per chat, each with its own claim and its own timestamp. A fourth chat costs a row.

### 1.2 — Four states, not five. **`Escalated` could never be observed.**

Part 2 gives `Open → Claimed → Escalated → WithSystem → Resolved`. But a party's tap records the
claim **and** notifies the regional reviewers, in one transaction — so `Claimed` and `Escalated`
are the same instant, and whichever of the two is written first is a value no query can ever return.

This codebase already has one recorded fault of exactly that shape: the unreachable System fallback
in `staff/recipients.ts`, found by a test asserting a branch that could not fire. A state nothing
can observe is the same defect with a nicer name.

**The states are `Open → Claimed → WithSystem → Resolved`,** and `claimed_at` and `escalated_at` are
both kept as columns — they answer "when did somebody first respond" and "when were staff told",
which really are two different questions even when they share a transaction.

### 1.3 — No `escalated_to` column. **A frozen recipient list goes stale.**

Part 2 lists `escalated_to`. Storing the chat ids the dispute was sent to would mean the record
disagrees with reality the moment somebody changes region, is deactivated, or is promoted — and the
"send to system admin" button would then be offered against a list nobody maintains.

Reviewers are recomputed from `regionalRecipients` on every escalation, which is the same lookup
`notifyUrgentRequest` uses and the one `staff/recipients.ts` was written in anticipation of. Its own
header names this feature as its third caller. `escalated_at` records *that* it happened; the
`audit_log` row records the region it went to.

### 1.4 — No foreign key from `identifier` to `roster_entries`.

`teachers.identifier` has one, with `restrict`. A dispute record is deliberately different: the
privacy notice now promises it is **kept permanently** ("a record of decisions our staff make about
access — including any dispute over who an account belongs to"), and a permanent record must
outlive a roster row that recruitment deletes. A teacher *binding* is meaningless without its roster
row; a record of who was judged to own an account is not.

---

## 2. Ripple map

| File | Layer | Change |
|---|---|---|
| `src/db/schema.ts` | 2 | Two new tables, two new enums. Purely additive |
| `drizzle/0011_identity_disputes.sql` | — | Generated, then read before accepting |
| `src/staff/roles.ts` | 2 | Two capabilities: `dispute.review` (Support), `dispute.resolve` (System) |
| `src/teachers/disputes.ts` **new** | 2 | Open, claim, escalate, resolve, list. **Returns; never sends** |
| `src/teachers/dispute-notify.ts` **new** | 2 | Who is told, and the words. Mirrors `cases/notify.ts` |
| `src/telegram/callback-data.ts` | 1 | Three prefixes: `DC`, `DE`, `DR` |
| `src/telegram/router.ts` | 3 | Open on duplicate binding; route the three taps |
| `src/telegram/commands/staff.ts` | 3 | `/disputes`, `/dispute_resolve`; add both to `PEOPLE_COMMANDS` |
| `src/digest/format.ts` | 2 | A fourth section: disputes waiting |
| `src/worker/tasks/digest.ts` | 4 | Fill it |
| `docs/dependency-tree.md` | — | Regenerate with `npm run deps`, commit with the code |
| `RUNBOOK.md`, `BOT-SPEC.md` | — | The new route, at the end, in one pass |

**Unchanged, deliberately:** `verifyIdentifier`, `findOtherHolders`, `bindTeacher`, the roster sync,
the binding rule, and the existing duplicate-binding alert. Feature A is added *alongside* D1's
detection, not in place of it — the operations alert is the thing that fires when nobody taps
anything, and removing it would make a silent impersonation silent again.

**Layer check:** every new import points down or sideways. `teachers/dispute-notify.ts` (2) imports
`staff/recipients.ts` (2), `telegram/callback-data.ts` (1), and takes `OutgoingMessage` from
`telegram/router.ts` (3) **as `import type` only** — the same erased-at-compile-time exception that
keeps `cases/notify.ts` legal. Keep it type-only.

---

## 3. The two capabilities, and why `dispute.review` is floored at Support

`schema.ts` records that **"a MoPSE 'regional admin' is usually `Support` rank with a region set"**.
That is the whole argument. Floor the review at `Program` — the rank that holds `teacher.revoke` —
and no actual regional admin holds it, every dispute falls through to the System fallback, and the
regional routing this feature is built on is dead on arrival while looking configured.

So `dispute.review` sits at `Support`, alongside `urgent.issue`, and for the identical stated
reason: *the person a teacher reaches is whoever is on the desk*. A reviewer can look and forward.
They cannot decide.

`dispute.resolve` sits at `System`, matching `teacher.forget`, because resolution revokes a chat and
closes its cases and Part 2 floors it there explicitly.

---

## 4. Tasks

### Task 1: The schema

**Files:** Modify `src/db/schema.ts` · Create `drizzle/0011_identity_disputes.sql` (generated)

- [ ] **Step 1: Add the enums and tables to `src/db/schema.ts`**, after `conversationStates`.

```ts
export const IDENTITY_DISPUTE_STATES = ['Open', 'Claimed', 'WithSystem', 'Resolved'] as const;
export type IdentityDisputeState = (typeof IDENTITY_DISPUTE_STATES)[number];
export const identityDisputeStateEnum = pgEnum('identity_dispute_state', IDENTITY_DISPUTE_STATES);

export const IDENTITY_DISPUTE_CLAIMS = ['Mine', 'NotMine'] as const;
export type IdentityDisputeClaim = (typeof IDENTITY_DISPUTE_CLAIMS)[number];
export const identityDisputeClaimEnum = pgEnum('identity_dispute_claim', IDENTITY_DISPUTE_CLAIMS);

/**
 * One argument about who a roster identity belongs to — Feature A.
 *
 * Deliberately not a `CASE_CATEGORY`. A dispute is not a teacher's support
 * request, and making it one would ripple into `QUEUE_FOR_CATEGORY`,
 * `CASE_REFERENCE_PREFIX` and retention for no gain.
 *
 * No foreign key on `identifier`, unlike `teachers.identifier`. The privacy
 * notice promises this record is kept permanently, and a permanent record of who
 * was judged to own an account must outlive a roster row recruitment deletes.
 */
export const identityDisputes = pgTable(
  'identity_disputes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    identifier: text('identifier').notNull(),
    state: identityDisputeStateEnum('state').notNull().default('Open'),
    openedAt: tsz('opened_at').notNull().defaultNow(),
    /** When any party first responded. Null while nobody has. */
    claimedAt: tsz('claimed_at'),
    /** When regional reviewers were told. Same transaction as the first claim. */
    escalatedAt: tsz('escalated_at'),
    systemNotifiedAt: tsz('system_notified_at'),
    resolvedBy: chatId('resolved_by'),
    resolvedAt: tsz('resolved_at'),
    /** The chat judged to be the teacher's. Null until resolved. */
    keptChatId: chatId('kept_chat_id'),
    /** What the resolver said, in their words. Shown to nobody but staff. */
    outcome: text('outcome'),
  },
  (t) => [
    /**
     * One OPEN dispute per identity, enforced by the database rather than by a
     * read-then-write.
     *
     * Two chats binding the same identifier at the same moment take two
     * different chat locks — `withChatLock` is the sender's — so nothing in
     * JavaScript can make "is there already one open" safe. This index is what
     * makes the third chat join rather than open a second record.
     */
    uniqueIndex('identity_disputes_one_open_idx')
      .on(t.identifier)
      .where(sql`resolved_at IS NULL`),
    index('identity_disputes_state_idx').on(t.state),
  ],
);

/**
 * The chats arguing, one row each.
 *
 * A separate table because a third chat signing in joins the existing dispute
 * rather than opening a second one, and a record with `prior` and `new` columns
 * has nowhere to put a third party.
 */
export const identityDisputeParties = pgTable(
  'identity_dispute_parties',
  {
    disputeId: bigint('dispute_id', { mode: 'number' })
      .notNull()
      .references(() => identityDisputes.id, { onDelete: 'cascade' }),
    chatId: chatId('chat_id').notNull(),
    joinedAt: tsz('joined_at').notNull().defaultNow(),
    /**
     * Which button they tapped, or null if they have not.
     *
     * It records what they said, and decides nothing. Both parties may tap and
     * no wording lets either self-certify — Part 2.
     */
    claim: identityDisputeClaimEnum('claim'),
    claimedAt: tsz('claimed_at'),
  },
  (t) => [
    primaryKey({ columns: [t.disputeId, t.chatId] }),
    check('identity_dispute_parties_chat_id_digits', CHAT_ID_IS_DIGITS('chat_id')),
  ],
);
```

Add `bigserial`, `bigint`, `primaryKey` and `uniqueIndex` to the `drizzle-orm/pg-core` import at the
top of the file if they are not already there.

- [ ] **Step 2: Generate the migration**

```bash
npx drizzle-kit generate
```

- [ ] **Step 3: Read the generated SQL before accepting it.**

It has emitted a destructive `DROP TYPE` in this project once. Open `drizzle/` and confirm the new
file contains only `CREATE TYPE`, `CREATE TABLE`, `CREATE UNIQUE INDEX`, `CREATE INDEX` and
`ALTER TABLE … ADD CONSTRAINT`. If it contains a `DROP` of anything, stop and fix the schema.

- [ ] **Step 4: Rename it to the convention and fix the journal**

Rename the generated file to `drizzle/0011_identity_disputes.sql` and change its `tag` in
`drizzle/meta/_journal.json` to `0011_identity_disputes`.

- [ ] **Step 5: Verify**

```bash
npm run typecheck
```

Expected: clean.

---

### Task 2: The two capabilities

**Files:** Modify `src/staff/roles.ts` · Test: `src/staff/roles.test.ts`

- [ ] **Step 1: Write the failing test** in `src/staff/roles.test.ts`

```ts
it('lets a regional admin review a dispute but never resolve one', () => {
  const support = { role: 'Support' as const, active: true };
  expect(can(support, CAPABILITY.DISPUTE_REVIEW)).toBe(true);
  expect(can(support, CAPABILITY.DISPUTE_RESOLVE)).toBe(false);
});

it('floors resolving a dispute at System, like forgetting a teacher', () => {
  expect(floorFor(CAPABILITY.DISPUTE_RESOLVE)).toBe('System');
  expect(can({ role: 'Program', active: true }, CAPABILITY.DISPUTE_RESOLVE)).toBe(false);
  expect(can({ role: 'System', active: true }, CAPABILITY.DISPUTE_RESOLVE)).toBe(true);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/staff/roles.test.ts
```

Expected: FAIL — `CAPABILITY.DISPUTE_REVIEW` is undefined.

- [ ] **Step 3: Add both to `CAPABILITY` and to `FLOOR`** in `src/staff/roles.ts`

```ts
  /**
   * Looking at an identity dispute and passing it to a System admin.
   *
   * Floored at `Support`, with `urgent.issue`, and the floor is the decision.
   * A MoPSE "regional admin" is usually Support rank with a region set — the
   * note on `staffRoleEnum` says so — so flooring this at Program would mean no
   * regional admin holds it, every dispute falls through to the System fallback,
   * and the regional routing this feature is built on would be dead while
   * looking configured.
   *
   * They can look and forward. Deciding is the capability below.
   */
  DISPUTE_REVIEW: 'dispute.review',
  /**
   * Deciding which chat keeps a teacher's identity.
   *
   * System, matching `teacher.forget`, because it revokes a chat and closes its
   * cases. `/restore` makes the revocation reversible; the closed cases stay
   * closed, which is why the rank is what it is.
   */
  DISPUTE_RESOLVE: 'dispute.resolve',
```

```ts
  'dispute.review': 'Support',
  'dispute.resolve': 'System',
```

- [ ] **Step 4: Run the test**

```bash
npx vitest run src/staff/roles.test.ts
```

Expected: PASS. `/whoami` picks both up with no further change — it derives from `FLOOR`.

---

### Task 3: The store — `teachers/disputes.ts`

**Files:** Create `src/teachers/disputes.ts` · Test: `src/teachers/disputes.integration.test.ts`

This is layer 2. It returns what happened. **It never sends and never builds a message.**

- [ ] **Step 1: Write the failing integration test.** Model it on
  `src/teachers/revocation.integration.test.ts` — same pool/drizzle setup, same
  `describe.skipIf(!TEST_DATABASE_URL)`, and **truncate `identity_disputes`, `identity_dispute_parties`,
  `teachers`, `staff`, `cases` and `roster_entries` in `beforeEach`.** A feature that starts reading
  a table can break every test file that does not clean it — that is the fault Part 5H.1 recorded,
  and this one adds two tables.

```ts
it('opens one dispute and puts both chats on it', async () => {
  const first = await openDispute(db, { identifier: IDENT, chatId: CHAT_A, otherChatIds: [] });
  const second = await openDispute(db, { identifier: IDENT, chatId: CHAT_B, otherChatIds: [CHAT_A] });

  expect(second.disputeId).toBe(first.disputeId);
  expect(second.isNew).toBe(false);
  expect((await partiesOf(db, first.disputeId)).sort()).toEqual([CHAT_A, CHAT_B]);
});

it('joins a third chat to the same dispute rather than opening a second', async () => {
  const one = await openDispute(db, { identifier: IDENT, chatId: CHAT_A, otherChatIds: [] });
  await openDispute(db, { identifier: IDENT, chatId: CHAT_B, otherChatIds: [CHAT_A] });
  const three = await openDispute(db, { identifier: IDENT, chatId: CHAT_C, otherChatIds: [CHAT_A, CHAT_B] });

  expect(three.disputeId).toBe(one.disputeId);
  expect((await partiesOf(db, one.disputeId)).length).toBe(3);
});

it('records a claim and moves the dispute to Claimed', async () => {
  const { disputeId } = await openDispute(db, { identifier: IDENT, chatId: CHAT_A, otherChatIds: [] });
  await openDispute(db, { identifier: IDENT, chatId: CHAT_B, otherChatIds: [CHAT_A] });

  const claimed = await recordClaim(db, disputeId, CHAT_A, 'NotMine');
  expect(claimed.kind).toBe('recorded');
  expect((await disputeById(db, disputeId))?.state).toBe('Claimed');
});

it('lets the second party claim too, and does not re-escalate', async () => {
  const { disputeId } = await openDispute(db, { identifier: IDENT, chatId: CHAT_A, otherChatIds: [] });
  await openDispute(db, { identifier: IDENT, chatId: CHAT_B, otherChatIds: [CHAT_A] });

  const first = await recordClaim(db, disputeId, CHAT_A, 'NotMine');
  const second = await recordClaim(db, disputeId, CHAT_B, 'Mine');

  expect(first.kind === 'recorded' && first.isFirstClaim).toBe(true);
  expect(second.kind === 'recorded' && second.isFirstClaim).toBe(false);
});

it('refuses a claim from a chat that is not a party', async () => {
  const { disputeId } = await openDispute(db, { identifier: IDENT, chatId: CHAT_A, otherChatIds: [] });
  expect((await recordClaim(db, disputeId, '999777', 'Mine')).kind).toBe('notAParty');
});

it('reports a claim on a resolved dispute rather than recording it', async () => {
  const { disputeId } = await openDispute(db, { identifier: IDENT, chatId: CHAT_A, otherChatIds: [] });
  await openDispute(db, { identifier: IDENT, chatId: CHAT_B, otherChatIds: [CHAT_A] });
  await resolveDispute(db, { disputeId, keptChatId: CHAT_A, actor: SYSTEM_STAFF, outcome: 'checked', closingNote: NOTE });

  expect((await recordClaim(db, disputeId, CHAT_B, 'Mine')).kind).toBe('alreadyResolved');
});

it('opens a new dispute once the old one is resolved', async () => {
  const first = await openDispute(db, { identifier: IDENT, chatId: CHAT_A, otherChatIds: [] });
  await resolveDispute(db, { disputeId: first.disputeId, keptChatId: CHAT_A, actor: SYSTEM_STAFF, outcome: 'checked', closingNote: NOTE });

  const second = await openDispute(db, { identifier: IDENT, chatId: CHAT_B, otherChatIds: [CHAT_A] });
  expect(second.disputeId).not.toBe(first.disputeId);
  expect(second.isNew).toBe(true);
});

it('resolving revokes every losing chat and closes their cases, keeping the winner untouched', async () => {
  // CHAT_A and CHAT_B both signed in; CHAT_B has an open case.
  const { disputeId } = await openDispute(db, { identifier: IDENT, chatId: CHAT_A, otherChatIds: [] });
  await openDispute(db, { identifier: IDENT, chatId: CHAT_B, otherChatIds: [CHAT_A] });

  const outcome = await resolveDispute(db, {
    disputeId, keptChatId: CHAT_A, actor: SYSTEM_STAFF, outcome: 'telephoned the school', closingNote: NOTE,
  });

  expect(outcome.kind).toBe('resolved');
  expect(outcome.kind === 'resolved' && outcome.revoked).toEqual([CHAT_B]);
  expect((await findTeacher(db, CHAT_B))?.verificationState).toBe('Revoked');
  expect((await findTeacher(db, CHAT_A))?.verificationState).toBe('Verified');

  const closed = await db.execute<{ status: string }>(
    sql`SELECT status FROM cases WHERE teacher_chat_id = ${CHAT_B}`,
  );
  expect(closed.rows.every((r) => r.status === 'Closed')).toBe(true);
});

it('refuses to resolve in favour of a chat that is not a party', async () => {
  const { disputeId } = await openDispute(db, { identifier: IDENT, chatId: CHAT_A, otherChatIds: [] });
  expect(
    (await resolveDispute(db, { disputeId, keptChatId: '999777', actor: SYSTEM_STAFF, outcome: 'x', closingNote: NOTE })).kind,
  ).toBe('notAParty');
});

it('makes a second resolution a no-op rather than a second revocation', async () => {
  const { disputeId } = await openDispute(db, { identifier: IDENT, chatId: CHAT_A, otherChatIds: [] });
  await openDispute(db, { identifier: IDENT, chatId: CHAT_B, otherChatIds: [CHAT_A] });
  await resolveDispute(db, { disputeId, keptChatId: CHAT_A, actor: SYSTEM_STAFF, outcome: 'first', closingNote: NOTE });

  const again = await resolveDispute(db, { disputeId, keptChatId: CHAT_B, actor: SYSTEM_STAFF, outcome: 'second', closingNote: NOTE });
  expect(again.kind).toBe('alreadyResolved');
  expect((await findTeacher(db, CHAT_A))?.verificationState).toBe('Verified');
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/teachers/disputes.integration.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/teachers/disputes.ts`.**

Required shape:

```ts
export interface OpenDisputeRequest {
  readonly identifier: string;
  /** The chat that has just signed in. */
  readonly chatId: string;
  /** Every other chat already holding this identity — `priorHolders` from `verifyIdentifier`. */
  readonly otherChatIds: readonly string[];
}

export interface OpenDisputeResult {
  readonly disputeId: number;
  /** False when this joined a dispute that was already open. */
  readonly isNew: boolean;
  readonly parties: readonly string[];
}

export async function openDispute(db: Database, request: OpenDisputeRequest): Promise<OpenDisputeResult>;

export type ClaimOutcome =
  | { readonly kind: 'recorded'; readonly identifier: string; readonly isFirstClaim: boolean; readonly parties: readonly string[] }
  | { readonly kind: 'notAParty' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'alreadyResolved'; readonly keptChatId: string | null };

export async function recordClaim(
  db: Database, disputeId: number, chatId: string, claim: IdentityDisputeClaim,
): Promise<ClaimOutcome>;

export type ForwardOutcome =
  | { readonly kind: 'forwarded'; readonly identifier: string; readonly parties: readonly string[] }
  | { readonly kind: 'alreadyWithSystem' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'alreadyResolved'; readonly keptChatId: string | null };

export async function forwardToSystem(db: Database, disputeId: number, actor: string): Promise<ForwardOutcome>;

export type ResolveOutcome =
  | { readonly kind: 'resolved'; readonly identifier: string; readonly keptChatId: string; readonly revoked: readonly string[]; readonly closedCases: readonly string[] }
  | { readonly kind: 'notAParty' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'alreadyResolved'; readonly keptChatId: string | null };

export async function resolveDispute(
  db: Database,
  request: {
    readonly disputeId: number;
    readonly keptChatId: string;
    readonly actor: string;
    /** What the resolver said, in their words. Staff-facing only. */
    readonly outcome: string;
    /**
     * The `public_update` written on each closed case — teacher-facing.
     *
     * A parameter rather than a constant here because it has to name the support
     * contact, and layer 2 has no route to it. It must not accuse anybody.
     */
    readonly closingNote: string;
  },
): Promise<ResolveOutcome>;

/** Open disputes, newest first, for `/disputes` and the digest. */
export async function openDisputes(db: Database, limit: number): Promise<DisputeSummary[]>;

export interface DisputeSummary {
  readonly id: number;
  readonly identifier: string;
  readonly state: IdentityDisputeState;
  /** Formatted in SQL, in Tashkent. Never typed as a `Date`. */
  readonly openedAt: string;
  readonly parties: readonly string[];
}

/** One dispute with its parties and their claims, for the staff view. */
export async function disputeDetail(db: Database, disputeId: number): Promise<DisputeDetail | null>;
```

Rules this file must hold to, each of which is a fault somewhere else in this repository:

**The insert is `ON CONFLICT`, not a read then a write.** Two chats binding the same identifier hold
two different chat locks, so nothing in JavaScript can serialise them.

```ts
const inserted = await db.execute<{ id: number }>(sql`
  INSERT INTO identity_disputes (identifier, state)
  VALUES (${request.identifier}, 'Open')
  ON CONFLICT (identifier) WHERE resolved_at IS NULL DO NOTHING
  RETURNING id
`);
```

When that returns no row a dispute was already open; select it by
`identifier = … AND resolved_at IS NULL`. `isNew` is whether the insert returned a row.

**Every party insert is `ON CONFLICT (dispute_id, chat_id) DO NOTHING`,** so a chat that signs in
three times joins once.

**`recordClaim` is one conditional `UPDATE` with a `before` sub-select**, exactly as
`requestUrgentCase` is, and for the recorded reason: `RETURNING` yields post-update values, so
"was this the first claim?" asked against the updated row answers itself every time.

```sql
UPDATE identity_dispute_parties AS p
SET claim = ${claim}, claimed_at = now()
FROM (SELECT claimed_at AS was_claimed_at FROM identity_dispute_parties
      WHERE dispute_id = ${disputeId} AND chat_id = ${chatId}) AS before,
     (SELECT claimed_at AS dispute_claimed_at, resolved_at FROM identity_disputes
      WHERE id = ${disputeId}) AS d
WHERE p.dispute_id = ${disputeId} AND p.chat_id = ${chatId} AND d.resolved_at IS NULL
RETURNING (d.dispute_claimed_at IS NULL) AS is_first_claim
```

Then, only when `is_first_claim`, advance the dispute in a second statement guarded on its own
state — `SET state = 'Claimed', claimed_at = now(), escalated_at = now() WHERE id = … AND claimed_at IS NULL`.

**Timestamps are formatted in SQL, never typed as a `Date`.** `db.execute` returns a `timestamptz`
as a **string** because drizzle installs its own pg parsers. Use
`to_char(opened_at AT TIME ZONE ${TIMEZONE}, 'DD Mon YYYY, HH24:MI')`.

**`resolveDispute` reuses `revokeTeacher` and `updateCase`.** It does not write
`verification_state` itself. `revokeTeacher` already writes the `TEACHER_REVOKED` audit row, and a
second copy of the revocation rule is the thing `CLAUDE.md` says not to write.

Closing the losing chats' cases uses `updateCase(db, reference, { status: 'Closed', publicUpdate: … }, actor)`
for each open case, so `closed_at` and the chase reset stay correct — retention measures from
`closed_at`, and a hand-written `UPDATE` here would strand it.

The `publicUpdate` is teacher-visible and must not accuse anybody:

> `Closed because the Ministry confirmed this account is not the one registered to this teacher. If you believe this is wrong, contact <support>.`

Since `publicUpdate` cannot reach the support contact from layer 2, take the closing note as a
parameter on the request rather than hard-coding it.

**One audit row, in the same transaction**, action `IDENTITY_DISPUTE_RESOLVED`, subject the
identifier, detail `{ disputeId, keptChatId, revoked, closedCases }`.

**A resolution guarded in SQL.** `WHERE id = … AND resolved_at IS NULL` in the `UPDATE` that sets
`resolved_at`, so two System members tapping a minute apart produce one resolution, one audit row and
one set of revocations. Do the revocations **only** if that statement returned a row.

- [ ] **Step 4: Run the tests**

```bash
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run src/teachers/disputes.integration.test.ts
```

Expected: PASS, 0 skipped.

---

### Task 4: The callback prefixes

**Files:** Modify `src/telegram/callback-data.ts` · Test: `src/telegram/callback-data.test.ts`

- [ ] **Step 1: Write the failing test** — measure the real longest payload, do not trust arithmetic.

```ts
it('keeps the longest dispute payloads inside the byte budget', () => {
  // A bigserial id and a 15-digit Telegram chat id are both worst cases.
  const resolve = encodeCallback(CALLBACK.DISPUTE_RESOLVE, '9007199254740991', '999999999999999');
  expect(byteLength(resolve)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);

  const claim = encodeCallback(CALLBACK.DISPUTE_CLAIM, '9007199254740991', 'NotMine');
  expect(byteLength(claim)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/telegram/callback-data.test.ts
```

Expected: FAIL — `CALLBACK.DISPUTE_RESOLVE` is undefined.

- [ ] **Step 3: Add the three prefixes** to `CALLBACK` in `src/telegram/callback-data.ts`

```ts
  /**
   * A party's answer on an identity dispute, e.g. `DC:42:NotMine` — Feature A.
   *
   * The claim travels; the party does not. Who is answering is the chat the tap
   * arrived from, which cannot be forged — the same reasoning as `ROK` and `RMV`.
   * A payload naming its own party would let either account answer for the other.
   *
   * **It decides nothing.** Both parties may tap, both are recorded, and the
   * dispute is settled by a System administrator afterwards. `DC:42:NotMine` is
   * 11 bytes against the 64-byte limit; a test measures the worst case.
   */
  DISPUTE_CLAIM: 'DC',
  /** "Send to system admin", e.g. `DE:42` — the reviewer's one button. */
  DISPUTE_ESCALATE: 'DE',
  /**
   * "This chat is the teacher", e.g. `DR:42:991001` — System only.
   *
   * It names the chat that KEEPS the identity, never the one that loses it. The
   * losing chats are derived from the party list, so a dispute with three parties
   * cannot be half-resolved by a button that only knows about two.
   */
  DISPUTE_RESOLVE: 'DR',
```

- [ ] **Step 4: Run the test.** Expected: PASS.

---

### Task 5: The notifier — `teachers/dispute-notify.ts`

**Files:** Create `src/teachers/dispute-notify.ts` · Test: `src/teachers/dispute-notify.integration.test.ts`

Layer 2. Computes recipients and writes the words. Returns `NotificationOutcome`. Sends nothing.

- [ ] **Step 1: Write the failing test**

```ts
it('escalates to the roster region of the identifier, not the region of either chat', async () => {
  // Roster says Samarkand. CHAT_B carries a region_override of Tashkent.
  // A Samarkand reviewer must be told; a Tashkent one must not.
  const outcome = await notifyDisputeEscalated(db, { disputeId, identifier: IDENT, parties: [CHAT_A, CHAT_B] });
  expect(outcome.messages.map((m) => m.chatId)).toEqual([SAMARKAND_REVIEWER]);
});

it('goes straight to System when nobody covers the region, and says so', async () => {
  const outcome = await notifyDisputeEscalated(db, { disputeId, identifier: IDENT, parties: [CHAT_A, CHAT_B] });
  expect(outcome.messages.map((m) => m.chatId)).toEqual([SYSTEM_STAFF]);
  expect(outcome.messages[0]!.text).toContain('NO active staff member covers this region');
});

it('shows the reviewer each chat’s id, display name and what they tapped', async () => {
  const outcome = await notifyDisputeEscalated(db, { disputeId, identifier: IDENT, parties: [CHAT_A, CHAT_B] });
  expect(outcome.messages[0]!.text).toContain(CHAT_A);
  expect(outcome.messages[0]!.text).toContain('This wasn’t me');
});
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Write the module.** Required exports:

```ts
/** The two messages the parties get when a dispute opens. One button each. */
export async function disputeOpenedMessages(
  db: Database,
  notice: { disputeId: number; identifier: string; newChatId: string; priorChatIds: readonly string[]; supportContact: string },
): Promise<NotificationOutcome>;

/** Told to the region's reviewers when a party first responds. */
export async function notifyDisputeEscalated(
  db: Database,
  notice: { disputeId: number; identifier: string; parties: readonly string[] },
): Promise<NotificationOutcome>;

/** Told to System when a reviewer forwards it. */
export async function notifyDisputeWithSystem(
  db: Database,
  notice: { disputeId: number; identifier: string; parties: readonly string[]; forwardedBy: string },
): Promise<NotificationOutcome>;

/** Told to the parties after a decision. */
export async function disputeResolvedMessages(
  notice: { keptChatId: string; revoked: readonly string[]; supportContact: string },
): NotificationOutcome;
```

The region lookup is **the roster's, resolved from the identifier**:

```ts
const roster = await findRosterEntry(db, notice.identifier);
const recipients = await regionalRecipients(db, {
  capability: CAPABILITY.DISPUTE_REVIEW,
  region: roster?.region ?? null,
});
```

**`regionFor(chatId)` must not appear in this file.** Part 2: the two chats can carry different
`regionOverride` values, so a per-chat lookup lets an imposter with an override pick their own
adjudicator. **`category` is deliberately omitted** from the query — a dispute is not filed under a
category, and `recipients.ts` documents that filtering by a queue would silently exclude everybody
whose queue is not `All`.

The two party messages, per Part 2:

| Party | Button | Callback |
|---|---|---|
| Prior holder | ⚠️ This wasn’t me | `DC:<id>:NotMine` |
| New chat | ✅ This is me — I changed phone | `DC:<id>:Mine` |

Both messages must say plainly that **signing in still works** and that a person will decide, so
nobody reads the notice as a lock-out. Neither may accuse the other chat of anything.

The reviewer's message carries: the disputed identity's **roster name and identifier**, and for each
party its **Telegram id, display name, and which button it pressed**. Telegram never gives bots
phone numbers, so none is offered. It carries one button, **📤 Send to system admin**, `DE:<id>`.

Cap the fan-out at `NEW_CASE_NOTIFY_CAP`, as `notifyUrgentRequest` does, and log the fan-out the same
way.

- [ ] **Step 4: Run the tests.** Expected: PASS.

---

### Task 6: The router — open on duplicate binding, and the three taps

**Files:** Modify `src/telegram/router.ts` · Test: `src/telegram/router.integration.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('opens a dispute and messages both chats when a second account signs in', async () => {
  await signIn(CHAT_A, IDENT);
  const outcome = await route(db, inbound(CHAT_B, IDENT), null, deps);

  expect(outcome.messages.map((m) => m.chatId)).toContain(CHAT_A);
  expect(outcome.messages.find((m) => m.chatId === CHAT_A)!.keyboard).toBeDefined();
  // The existing D1 alert still fires — the dispute is added beside it, not instead of it.
  expect(outcome.alerts.length).toBeGreaterThan(0);
});

it('signs the second chat in anyway — a dispute does not gate access', async () => {
  await signIn(CHAT_A, IDENT);
  await route(db, inbound(CHAT_B, IDENT), null, deps);
  expect(teacherHasAccess(await findTeacher(db, CHAT_B))).toBe(true);
});

it('answers a dispute button from a chat that is not a party with the main menu', async () => {
  // Not silence about the dispute, and not an error naming it: a stranger who
  // guesses `DC:1:Mine` must not learn that dispute 1 exists.
  const outcome = await route(db, callback(STRANGER, `DC:${id}:Mine`), null, deps);
  expect(outcome.messages[0]!.text).toContain('What would you like to do');
});

it('refuses a resolve tap from a Program member and says what rank it needs', async () => {
  const outcome = await route(db, callback(PROGRAM_STAFF, `DR:${id}:${CHAT_A}`), null, deps);
  expect(outcome.messages[0]!.text).toContain('System');
});

it('tells the second tapper the dispute is already settled', async () => {
  await route(db, callback(SYSTEM_STAFF, `DR:${id}:${CHAT_A}`), null, deps);
  const again = await route(db, callback(SYSTEM_STAFF, `DR:${id}:${CHAT_B}`), null, deps);
  expect(again.messages[0]!.text).toContain('already');
  expect((await findTeacher(db, CHAT_A))?.verificationState).toBe('Verified');
});
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Open the dispute in `handleIdentifier`.**

In `src/telegram/router.ts`, inside the existing `if (outcome.priorHolders.length > 0)` region —
**keep the existing alert exactly as it is** and add the dispute beside it:

```ts
  if (outcome.priorHolders.length > 0) {
    /**
     * Feature A. The dispute is opened here, in the same transaction as the
     * binding, and its messages are returned rather than sent — `deliver` commits
     * first and speaks afterwards. Announcing a dispute over a binding that can
     * still roll back would be worse than announcing it a moment later.
     *
     * **It does not gate the sign-in above.** Blocking would lock out any teacher
     * who changes phone, and would hand anyone holding a leaked recruitment
     * address a way to lock the real teacher out permanently. Part 2, and the
     * same reasoning as D1.
     */
    const dispute = await openDispute(db, {
      identifier: outcome.identifier,
      chatId,
      otherChatIds: outcome.priorHolders,
    });

    const opened = await disputeOpenedMessages(db, {
      disputeId: dispute.disputeId,
      identifier: outcome.identifier,
      newChatId: chatId,
      priorChatIds: outcome.priorHolders,
      supportContact: deps.supportContact,
    });
    messages.push(...opened.messages);
    alerts.push(...opened.alerts);

    alerts.push({ /* the existing warning, unchanged */ });
  }
```

**Delete the plain `for (const holder of outcome.priorHolders)` loop above it** — the security notice
it sent is replaced by `disputeOpenedMessages`, which says the same thing and carries the button.
Leaving both would put two near-identical messages in the prior holder's chat a second apart.

- [ ] **Step 4: Route the three taps** in `routeCallback`, beside `CALLBACK.STAFF_MENU`:

```ts
    /**
     * The parties' answers — Feature A, and the only staff-shaped button in this
     * system a *teacher* taps. It is authorised by party membership rather than
     * by a staff row: `recordClaim` refuses any chat that is not on the dispute,
     * which is the whole check, and a stranger guessing an id gets the ordinary
     * menu rather than confirmation that the dispute exists.
     */
    case CALLBACK.DISPUTE_CLAIM:
      return claimDispute(db, update.chatId, first, second, deps);

    case CALLBACK.DISPUTE_ESCALATE:
      return (
        (await forwardDispute(db, update.chatId, first, state, deps))
        ?? only(update.chatId, await menuReplyFor(db, update.chatId))
      );

    case CALLBACK.DISPUTE_RESOLVE:
      return (
        (await resolveDisputeTap(db, update.chatId, first, second, state, deps))
        ?? only(update.chatId, await menuReplyFor(db, update.chatId))
      );
```

- [ ] **Step 5: Write the three handlers**, each modelled on `confirmUrgent`.

`claimDispute` — no staff gate. `recordClaim` refuses a non-party. On `kind: 'recorded'` **and**
`isFirstClaim`, append `notifyDisputeEscalated`'s messages. On `notAParty` or `unknown`, return the
main menu — never a sentence that confirms the dispute is real.

`forwardDispute` and `resolveDisputeTap` — the four-check shape `confirmUrgent` uses, in order:

1. `findStaff` → `null` means no active staff row → log `STAFF_DENIED`, return the main menu.
   A reply saying "you are not staff" tells a stranger the button they guessed at is real.
2. `can(member, CAPABILITY.DISPUTE_REVIEW)` / `DISPUTE_RESOLVE` → refuse plainly, naming the floor
   from `floorFor`. They can see the button, so silence leaves them tapping it.
3. The dispute, through `disputeDetail`. There is no queue or region scope on a dispute — the
   capability *is* the scope — but a missing dispute is answered the same way a missing case is.
4. The dispute's own state, inside the store's conditional `UPDATE`. That is what makes a second
   tap a no-op rather than a second resolution.

`resolveDisputeTap` must pass the closing note through, built from `deps.supportContact`.

- [ ] **Step 6: Run the tests.** Expected: PASS.

---

### Task 7: `/disputes` and `/dispute_resolve`

**Files:** Modify `src/telegram/commands/staff.ts` · Test: `src/telegram/commands/staff.integration.test.ts`

A button is not a route to a dispute nobody was messaged about. Both commands exist so a dispute is
reachable after the message scrolls away.

- [ ] **Step 1: Write the failing tests**

```ts
it('lists open disputes with a button each for a reviewer', async () => { … });
it('refuses /dispute_resolve below System', async () => { … });
it('refuses /dispute_resolve in favour of a chat that is not a party', async () => { … });
it('is not a command-existence oracle for a non-staff chat', async () => {
  expect(await routeStaffCommand(db, TEACHER, '/disputes', null, deps)).toBeNull();
});
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Add both commands**, following the `revoke` shape exactly:

```ts
export const disputes: StaffCommand = {
  name: '/disputes',
  capability: CAPABILITY.DISPUTE_REVIEW,
  handle: async (ctx) => { /* openDisputes → one line each, a button each */ },
};

export const disputeResolve: StaffCommand = {
  name: '/dispute_resolve',
  capability: CAPABILITY.DISPUTE_RESOLVE,
  handle: async (ctx) => { /* /dispute_resolve <id> <chat id> <why> */ },
};
```

Usage line, matching the house style:
`/dispute_resolve 42 995101 telephoned the school and confirmed — the chat id is the one that KEEPS the account.`

- [ ] **Step 4: Add both to `PEOPLE_COMMANDS`** at the bottom of the file.

- [ ] **Step 5: Run the tests.** Expected: PASS.

---

### Task 8: The digest

**Files:** Modify `src/digest/format.ts`, `src/worker/tasks/digest.ts` · Test: `src/digest/format.test.ts`

Part 2: *"No auto-expiry. Unresolved disputes surface in the ops digest so they cannot be silently
forgotten — visibility over automation, as elsewhere."*

- [ ] **Step 1: Write the failing test**

```ts
it('shows unresolved disputes, and still returns null when there is nothing at all', () => {
  expect(staffDigest({ pastDue: empty, stale: empty, unassigned: empty, disputes: [] })).toBeNull();
  const withOne = staffDigest({ pastDue: empty, stale: empty, unassigned: empty, disputes: ['#42 — opened 2 Aug'] })!;
  expect(withOne).toContain('#42');
});
```

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Add `disputes: readonly string[]` to `DigestLists`** and a fourth section to
  `staffDigest`. Disputes are not cases, so they arrive as pre-rendered lines rather than as a
  `StaffCaseList` — a `section()` built for `StaffCaseRow` cannot render one without pretending a
  dispute has a status, a queue and an importance.

```ts
    ...(lists.disputes.length > 0
      ? ['⚖️ *Somebody is disputing who an account belongs to*', ...lists.disputes.map((d) => `• ${d}`), '']
      : []),
```

Adding it to `body` keeps the `null`-when-empty rule intact for free.

- [ ] **Step 4: Fill it in `src/worker/tasks/digest.ts`** — `openDisputes` for members holding
  `DISPUTE_REVIEW`, and an empty array for everybody else. A digest that told an Observer about a
  dispute they cannot act on is R14's mistake one table along.

- [ ] **Step 5: Run the tests.** Expected: PASS.

---

### Task 9: Verify everything, then commit

- [ ] **Step 1: Regenerate the dependency graph**

```bash
npm run deps
```

Commit `docs/dependency-tree.md` with the code.

- [ ] **Step 2: Run the gate**

```bash
npm run deps:check
```

Expected: silent, exit 0. Zero cycles, zero layer violations. If it reports a violation into
`telegram/router.ts` from `teachers/dispute-notify.ts`, the `OutgoingMessage` import is not
`import type` — that is the one this feature is most likely to trip.

- [ ] **Step 3: Run the full suite** — the container first, since it has no volume and does not
  survive a restart.

```bash
docker desktop start && docker compose -f docker-compose.test.yml up -d && docker inspect --format "{{.State.Health.Status}}" mopse-test-postgres-1
```

```
$env:TEST_DATABASE_URL='postgres://mopse:mopse@localhost:5432/mopse_test'; npx vitest run
```

**A run reporting hundreds of skips proved nothing.** Expected: 0 failed, **0 skipped**, ~5 minutes.

- [ ] **Step 4: The rest of the set**

```bash
npm run typecheck
npm run build
npm run lint
```

- [ ] **Step 5: Commit the code**, then the documents, as separate commits. Message is prose that
  explains *why*, matching `git log`. State the five numbers plainly in it.

---

## 5. What proves it works — Part 7's list, unchanged

- [ ] Two chats sign in with one email → both get a message, each with its own button
- [ ] Each button escalates to the reviewers for the **roster** region, not either chat's
- [ ] A dispute in a region no staff cover goes straight to System, and the message says so
- [ ] Resolution revokes every losing chat, closes their cases with a stated reason, and writes one
      audit row
- [ ] `/restore` puts back a wrongly-revoked chat
- [ ] A button tapped after resolution reports the dispute is closed and changes nothing
- [ ] A third chat joins the existing dispute rather than opening a second
- [ ] The second chat **still signs in** while the dispute is open
- [ ] `npm run deps` still reports zero cycles and zero layer violations

---

## 6. Deliberately not built

- **Asking a party for their phone number.** Telegram never gives bots phone numbers; only a native
  "share contact" button the user taps would. Part 2 prices it at half a day, later.
- **Auto-expiry of an unresolved dispute.** Visibility instead — the digest and `/disputes`.
- **Locking either account.** Part 6 of the programme plan: it hands anyone with a leaked address a
  button that disables a teacher on demand, repeatedly.
- **Hard-deleting the losing chat's cases.** Part 2 gives three reasons and they still hold: it
  contradicts the reversible revoke chosen alongside it; if the losing chat was the imposter its
  cases are the evidence; and `cases.teacher_chat_id` is `onDelete: restrict` regardless.
- **A dispute retention period.** The privacy notice, as amended on 1 August, promises this record is
  kept permanently. Nothing in `retention.ts` changes.

---

## 7. Left open, for whoever picks this up next

**Capturing each account's Telegram display name.** Found while building, and the one thing Part 2
asked for that is not here. It is three changes rather than one: a column on `teachers`, a capture in
the inbound-update path (which today reads a chat id and the message text and nothing else), and a
line in the privacy notice — the notice already claims under *What is held* that we hold "your name
as Telegram supplies it", **which is not true today and was not true before this feature either**.
That inaccuracy is worth correcting whichever way the decision goes.

Worth roughly half a day. It is genuinely useful to a reviewer, and it is more personal data held
about people who are already in an argument they did not choose, so it is the head of project's call
rather than the builder's.

**`npm run lint` exits 0 even when oxlint reports warnings.** Noticed while proving the linter still
works: a canary file with three deliberate defects printed three warnings and still exited 0, so the
lint step cannot fail the gate on its own. Pre-existing and unrelated to this feature, but the
verification set in `CLAUDE.md` treats it as a gate, and today it is only a report.
