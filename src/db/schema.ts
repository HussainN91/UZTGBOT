/**
 * The database structure.
 *
 * This file is the setup script. Column names live in the program, so renaming
 * one is a compile error across every query that touches it — in the Apps
 * Script version renaming a spreadsheet column silently disabled whichever
 * feature read it, with no error anywhere, and that failure mode is on the
 * concerns list.
 *
 * The ownership rule, applied without exception:
 *
 *   The spreadsheet owns what the bot only READS  — the FAQ bank and the roster.
 *   The database owns what the bot WRITES         — everything else.
 *
 * Information flows one way, so there is never a question about which copy is
 * correct. The two tables fed by the sync are marked below; nothing in the
 * application writes to them.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * A Telegram chat id. Stored as text, not a number.
 *
 * Telegram ids already exceed 2^32 and will eventually exceed what a JavaScript
 * number can hold exactly, so they are never parsed into one. The check
 * constraint keeps them digits, which is what makes the foreign keys below
 * meaningful rather than decorative.
 */
const chatId = (name: string) => text(name);
const CHAT_ID_IS_DIGITS = (column: string) => sql.raw(`${column} ~ '^[0-9]+$'`);

/** Timestamps are always stored with their zone. See constants.ts on Tashkent. */
const tsz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/**
 * The eight case statuses from the original proposal. Carried over unchanged —
 * they reflect how MoPSE actually works a case, not a spreadsheet limitation.
 *
 * The array is the source and the enum is derived from it, rather than the two
 * being written out separately. They were, and `CaseStatus` in `service.ts` was
 * a third hand-written copy of the same eight strings — three lists that had to
 * agree with nothing enforcing it. `/cases <status>` needs to validate what a
 * staff member typed against *the* list, and there has to be exactly one.
 */
export const CASE_STATUS_ORDER = [
  'New',
  'Received',
  'Under review',
  'Action required',
  'Escalated',
  'Completed',
  'Closed',
  'Duplicate',
] as const;

export type CaseStatus = (typeof CASE_STATUS_ORDER)[number];

export const caseStatusEnum = pgEnum('case_status', CASE_STATUS_ORDER);

/**
 * How serious a case is, as a person judged it — not as its status says.
 *
 * Separate from `status` because status moves. An escalated case that gets
 * resolved becomes `Completed`, and with it goes every trace of its having been
 * an emergency. Stage 5 keeps urgent and critical cases for six months, so a
 * retention job reading `status` would delete exactly the cases most worth
 * keeping (plan D22).
 *
 * `Urgent` is what a teacher's one-time code buys and is set by the flow.
 * `Critical` is a judgement a person makes after reading the case. Collapsing
 * the two would mean either every code-holder's case is critical, or no staff
 * member can mark one.
 */
export const caseImportanceEnum = pgEnum('case_importance', ['Normal', 'Urgent', 'Critical']);

export const CASE_IMPORTANCE_ORDER = ['Normal', 'Urgent', 'Critical'] as const;
export type CaseImportance = (typeof CASE_IMPORTANCE_ORDER)[number];

/**
 * Statuses that count as still open, for the 24-hour duplicate window and for
 * every staff-facing list.
 *
 * `satisfies` is what stops this drifting from `CASE_STATUS_ORDER`: renaming a
 * status above without renaming it here is a compile error rather than a filter
 * that silently matches nothing.
 */
export const OPEN_CASE_STATUSES = [
  'New',
  'Received',
  'Under review',
  'Action required',
  'Escalated',
] as const satisfies readonly CaseStatus[];

/**
 * One role system, replacing three.
 *
 * The Apps Script version carried a yes/no "system admin" flag, a TIER
 * category, and a ROLE column, plus a fallback that tried all three in order.
 * That fallback existed purely to keep older spreadsheet rows working, and
 * there are no rows. Roles are ordered here, so "at least Lead" is a
 * comparison rather than the exact-match check that made Program-tier staff
 * mysteriously unable to do Lead-tier things.
 *
 * Two changes in stage 4, both made while the table was still empty and both
 * permanent afterwards (plan D7):
 *
 * `Observer` was added at the bottom — sight of cases with no power to change
 * one. It is not Apps Script's `ReadOnly`, which was the bucket an unrecognised
 * spreadsheet row fell into; this is a rank somebody is deliberately given, for
 * senior ministry staff, auditors, and new hires in their first week.
 *
 * `Regional` was renamed `Lead`, because it had nothing to do with regions.
 * A region is a separate column on this same table, and a MoPSE "regional
 * admin" is usually `Support` rank with a region set — so the old name meant
 * one thing in the ladder and a different thing in the org chart. Confusing
 * those two axes is how the Apps Script version ended up making everybody a
 * full administrator. The teacher-facing phrase "Regional admin" is a job
 * title, not this enum, and is deliberately left alone.
 */
export const staffRoleEnum = pgEnum('staff_role', [
  'Observer',
  'Support',
  'Lead',
  'Program',
  'System',
]);

/** Ascending authority. Index in this array is the rank. */
export const STAFF_ROLE_ORDER = ['Observer', 'Support', 'Lead', 'Program', 'System'] as const;
export type StaffRole = (typeof STAFF_ROLE_ORDER)[number];

/** How far a teacher has got through identifying themselves. */
export const verificationStateEnum = pgEnum('verification_state', [
  'Unverified',
  'AwaitingIdentifier',
  'Verified',
  'Revoked',
]);

export const announcementStatusEnum = pgEnum('announcement_status', [
  'Draft',
  'Queued',
  'Sending',
  'Sent',
  'Failed',
  'Cancelled',
]);

export const deliveryStateEnum = pgEnum('delivery_state', ['Pending', 'Sent', 'Failed', 'Skipped']);

// ---------------------------------------------------------------------------
// Owned by the spreadsheet. Written ONLY by the sync.
// ---------------------------------------------------------------------------

/**
 * The approved answer bank.
 *
 * Staff edit this in the spreadsheet exactly as they do today; the sync copies
 * it here every ten minutes, so an edit reaches teachers within ten minutes
 * instead of up to six hours.
 */
export const faqEntries = pgTable(
  'faq_entries',
  {
    /** The sheet's CODE column, e.g. SAL-001. Stable across edits. */
    code: text('code').primaryKey(),
    /**
     * The topic's short code, resolved from the sheet's CATEGORY label.
     *
     * The sheet holds a display label; this holds the code that travels in
     * button payloads. A row whose label matches no known topic is rejected and
     * reported by the sync rather than stored — which is what turns yesterday's
     * silent failure (one typo makes an answer permanently unreachable, with no
     * error anywhere) into a message someone can act on.
     */
    topicCode: text('topic_code').notNull(),
    /**
     * The row this answer occupies in the spreadsheet, used only for ordering.
     *
     * The sheet had an implicit order that pagination relied on. SQL without an
     * ORDER BY returns rows arbitrarily, so paging through a topic could repeat
     * and skip answers between taps — and because the sync refreshes every ten
     * minutes, the underlying rows can change mid-page too. Ordering by code
     * instead would reorder the bank against the content owner's intent; they
     * arrange the sheet deliberately, and the order teachers see should be the
     * order staff chose.
     */
    sheetRow: integer('sheet_row').notNull().default(0),
    buttonText: text('button_text').notNull(),
    /** The sheet's comma-separated KEYWORDS, split once here rather than on every query. */
    keywords: text('keywords').array().notNull().default(sql`ARRAY[]::text[]`),
    officialAnswer: text('official_answer').notNull(),
    language: text('language').notNull().default('EN'),
    active: boolean('active').notNull().default(true),
    lastApprovedBy: text('last_approved_by'),
    lastApprovedDate: text('last_approved_date'),
    /** When the sync last saw this row in the sheet. */
    syncedAt: tsz('synced_at').notNull().defaultNow(),
  },
  (t) => [
    // Ordered by sheet row so the per-topic listing is served straight from the
    // index, in the order the content owner arranged, with no sort step.
    index('faq_entries_topic_idx').on(t.topicCode, t.active, t.sheetRow),
    index('faq_entries_active_idx').on(t.active),
  ],
);

/**
 * The teacher roster — who is entitled to use the bot at all.
 *
 * Owned by the spreadsheet: recruitment pastes rows in as they do today.
 * `active` is how the sync records a row disappearing from the sheet; rows are
 * never deleted, because a teacher who has already signed in has case history
 * that must stay readable.
 */
export const rosterEntries = pgTable(
  'roster_entries',
  {
    /**
     * The teacher's recruitment email, lowercased and trimmed.
     *
     * Normalised on the way in so that "A.Karimov@Example.com " and
     * "a.karimov@example.com" are the same person. The Apps Script version
     * compared raw cell values, so trailing whitespace in a pasted cell meant a
     * teacher simply could not sign in, with nothing to show why.
     */
    identifier: text('identifier').primaryKey(),
    name: text('name').notNull(),
    region: text('region'),
    active: boolean('active').notNull().default(true),
    syncedAt: tsz('synced_at').notNull().defaultNow(),
  },
  (t) => [index('roster_entries_active_idx').on(t.active)],
);

// ---------------------------------------------------------------------------
// Owned by the database.
// ---------------------------------------------------------------------------

/**
 * Teachers who have identified themselves.
 *
 * In the Apps Script version this lived in a USERS tab, and removing someone's
 * access meant deleting their row — which destroyed the mapping that made every
 * historical log entry readable. Here access is revoked by state, so it is
 * reversible and the history survives.
 */
export const teachers = pgTable(
  'teachers',
  {
    chatId: chatId('chat_id').primaryKey(),
    verificationState: verificationStateEnum('verification_state').notNull().default('Unverified'),
    /** Matches roster_entries.identifier once verified. Null until then. */
    identifier: text('identifier').references(() => rosterEntries.identifier, {
      onDelete: 'restrict',
    }),
    name: text('name'),
    /**
     * The roster's region, copied at sign-in.
     *
     * Kept, but it is no longer read directly: `regionFor` resolves it against
     * the override below and against the live roster row. Reading this column
     * on its own is the bug described at `regionOverride` — it is a snapshot
     * taken once, and a teacher who has signed in never signs in again.
     */
    region: text('region'),
    /**
     * A region set by a named person, which beats the roster.
     *
     * The roster is recruitment's copy and it goes stale — teachers are moved.
     * The bot cannot write back to the spreadsheet (it holds Viewer access to
     * one document, and edit access would reach the confidential answer bank),
     * so a correction is recorded here and `regionFor` resolves the precedence
     * in one place. Clearing it returns the teacher to whatever the roster says,
     * which is also how a mistyped region is undone.
     *
     * NOT written by `bindTeacher`. A teacher who signs in again — a new phone,
     * the commonest legitimate reason — would otherwise have a manager's
     * correction silently reverted by the roster's value.
     */
    regionOverride: text('region_override'),
    regionSetBy: chatId('region_set_by'),
    regionSetAt: tsz('region_set_at'),
    /**
     * Raised when a teacher says the region we hold is wrong. Cleared when staff act.
     *
     * A flag, not a value: the teacher is the best source of the signal and the
     * worst source of the record, because region decides who receives their
     * emergency. A menu of regions is a menu of whose problem this becomes.
     */
    regionFlaggedAt: tsz('region_flagged_at'),
    /**
     * When the teacher was last *asked* whether the region we hold is right.
     *
     * Stamped when the question is shown, not when it is answered, and that is
     * the whole design. Stamped on answer, a teacher who ignores the question is
     * asked again every time they open the menu — which for 1,800 people is a
     * question tapped through unread, filling the field that routes emergencies
     * with noise. Stamped on show, everybody is asked at most once every
     * `REGION_CONFIRM_AFTER_DAYS`, whether they answer or not, and an ignored
     * question comes back later rather than never.
     *
     * Distinct from `regionFlaggedAt`, which means "reported wrong and not yet
     * dealt with". This one means "we have put the question to them recently",
     * and both answers set it because both mean we should stop asking for now.
     */
    regionAskedAt: tsz('region_asked_at'),
    language: text('language').notNull().default('EN'),
    firstSeen: tsz('first_seen').notNull().defaultNow(),
    lastSeen: tsz('last_seen').notNull().defaultNow(),
    /** Set when a staff member revokes access. Null means active. */
    revokedAt: tsz('revoked_at'),
    revokedBy: chatId('revoked_by'),
    privacyNoticeAcceptedAt: tsz('privacy_notice_accepted_at'),
    /**
     * Which wording they accepted, e.g. '2026-07-28.1'.
     *
     * A timestamp alone cannot answer "agreed to what". The notice will be
     * revised — the retention paragraph is already written on the assumption
     * that it changes once a period is set — and after a revision a bare
     * acceptance date proves only that somebody agreed to something.
     *
     * Nullable because teachers bound before this column existed genuinely have
     * no recorded version, and inventing one for them would be worse than
     * admitting it.
     */
    privacyNoticeVersion: text('privacy_notice_version'),
  },
  (t) => [
    check('teachers_chat_id_digits', CHAT_ID_IS_DIGITS('chat_id')),
    /**
     * Deliberately NOT unique.
     *
     * BOT-SPEC.md: "Duplicate identity bindings are detected, not blocked."
     * Identity here is a recruitment email that colleagues routinely know, so a
     * second binding is a signal for a human to judge, not something to refuse —
     * a teacher switching phones produces exactly this signal, and the original
     * design chose detection knowing that.
     *
     * A unique index would lock that teacher out permanently, with no command to
     * release the identifier until staff management exists. Worse, it would let
     * anyone holding a leaked recruitment email sign in first and lock the real
     * teacher out for good — turning an impersonation risk into a denial of
     * service. It also collides with revocation: a revoked teacher still holds
     * the identifier, so revoking someone would burn that roster identity unless
     * revocation also cleared the column, destroying the history link this table
     * exists to preserve.
     *
     * The index serves the duplicate-holder lookup that raises the alarm.
     */
    index('teachers_identifier_idx').on(t.identifier),
    index('teachers_state_idx').on(t.verificationState),
  ],
);

/**
 * Staff, their role, and what they can see.
 *
 * Managed only through bot commands. In the Apps Script version this was a
 * spreadsheet tab, which meant anyone who could edit the spreadsheet could make
 * themselves a full administrator — a real hole, closed by moving it here.
 */
export const staff = pgTable(
  'staff',
  {
    telegramId: chatId('telegram_id').primaryKey(),
    name: text('name'),
    role: staffRoleEnum('role').notNull().default('Support'),
    /** Case category this person works, or 'All'. */
    queue: text('queue').notNull().default('All'),
    /** Empty array means every region — so adding this column cannot narrow existing access. */
    regions: text('regions').array().notNull().default(sql`ARRAY[]::text[]`),
    active: boolean('active').notNull().default(true),
    addedBy: chatId('added_by'),
    addedAt: tsz('added_at').notNull().defaultNow(),
  },
  (t) => [
    check('staff_telegram_id_digits', CHAT_ID_IS_DIGITS('telegram_id')),
    index('staff_active_idx').on(t.active, t.role),
  ],
);

/**
 * Support cases.
 *
 * The foreign key is the point: in the Apps Script version a case could be
 * filed against a sentinel string like `UNRESOLVED:abc123` when a Google Form
 * could not identify its submitter. With documents moving into Telegram, the
 * submitter is always known, so the database can guarantee what the old code
 * had to enforce by hand — no case exists without a verified teacher.
 */
export const cases = pgTable(
  'cases',
  {
    /** e.g. VISA-2026-00482. Generated per category and year. */
    reference: text('reference').primaryKey(),
    category: text('category').notNull(),
    teacherChatId: chatId('teacher_chat_id')
      .notNull()
      .references(() => teachers.chatId, { onDelete: 'restrict' }),
    status: caseStatusEnum('status').notNull().default('New'),
    /** Staff member who owns it, if assigned. */
    owner: chatId('owner').references(() => staff.telegramId, { onDelete: 'set null' }),
    /**
     * The teacher's own words. Never echoed back through Check My Case and never
     * written to a log line — it is read only through commands that check
     * permissions first.
     */
    detail: text('detail').notNull().default(''),
    /** The only case text a teacher ever sees back. Written by staff, deliberately. */
    publicUpdate: text('public_update').notNull().default(''),
    /**
     * How serious this case is. See `caseImportanceEnum` for why it is not the
     * status. Set by `/mark`, and by the urgent-code path at creation.
     */
    importance: caseImportanceEnum('importance').notNull().default('Normal'),
    /** When whoever holds this case said it would be done. */
    dueAt: tsz('due_at'),
    /** Suppresses chasing until this passes. Never suppresses the case itself. */
    snoozedUntil: tsz('snoozed_until'),
    lastActor: chatId('last_actor'),
    createdAt: tsz('created_at').notNull().defaultNow(),
    updatedAt: tsz('updated_at').notNull().defaultNow(),
    closedAt: tsz('closed_at'),
  },
  (t) => [
    check('cases_teacher_chat_id_digits', CHAT_ID_IS_DIGITS('teacher_chat_id')),
    /** Serves the 24-hour duplicate check, which is the hottest query on this table. */
    index('cases_dedup_idx').on(t.teacherChatId, t.category, t.status, t.createdAt),
    index('cases_status_idx').on(t.status, t.createdAt),
    index('cases_owner_idx').on(t.owner),
    /**
     * Serves stage 5's chasing query, which is written against these three
     * columns together: open, past its promised date, not snoozed.
     */
    index('cases_chasing_idx').on(t.status, t.dueAt, t.snoozedUntil),
  ],
);

/**
 * Staff writing about a case, kept apart from the teacher's own words.
 *
 * The Apps Script version appended notes into `cases.detail` itself
 * (`AdminCommands.gs:788`), which is why `handleCaseDetail_` carries a comment
 * about the message outgrowing Telegram's 4096-character limit: an internal
 * thread was accumulating inside a field that also holds a teacher's original
 * description, with the author and the time encoded as text somebody would
 * eventually have to parse.
 *
 * Three things a table gives that a text append does not — the author is a
 * column, so "who said this" survives; the time is a column, in the database's
 * clock rather than a formatted string; and `/case` can show the last few and
 * say how many more there are, instead of growing until it must be split.
 *
 * `ON DELETE CASCADE` is what lets stage 5's retention pass reach these rows.
 * They hold staff writing about teachers and must not outlive the case.
 */
export const caseNotes = pgTable(
  'case_notes',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    caseReference: text('case_reference')
      .notNull()
      .references(() => cases.reference, { onDelete: 'cascade' }),
    /**
     * Who wrote it. Not a foreign key to `staff`: a note is a historical record
     * and must stay readable after its author's row is deactivated or, in some
     * later stage, removed. The same argument `teachers` makes about keeping a
     * log entry readable.
     */
    authorChatId: chatId('author_chat_id').notNull(),
    body: text('body').notNull(),
    createdAt: tsz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('case_notes_author_chat_id_digits', CHAT_ID_IS_DIGITS('author_chat_id')),
    /** `/case` reads the most recent few for one case. */
    index('case_notes_case_idx').on(t.caseReference, t.createdAt),
  ],
);

/**
 * Per-category, per-year case reference counters.
 *
 * A row per prefix and year, incremented under the row's own lock. The Apps
 * Script version derived the next number by scanning the sheet for the current
 * maximum, which under-counted the moment the archive job moved rows out — and
 * could therefore reissue a reference that was already in use.
 */
export const caseSequences = pgTable(
  'case_sequences',
  {
    prefix: text('prefix').notNull(),
    year: integer('year').notNull(),
    lastValue: integer('last_value').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.prefix, t.year] })],
);

/**
 * Where each teacher is in a conversation.
 *
 * The Apps Script version held this in temporary memory, so a restart lost every
 * in-progress conversation — including a teacher part-way through an urgent case
 * whose one-time code had already been consumed. Persisting it is what makes
 * that survivable.
 */
export const conversationStates = pgTable(
  'conversation_states',
  {
    chatId: chatId('chat_id').primaryKey(),
    state: text('state').notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    updatedAt: tsz('updated_at').notNull().defaultNow(),
    /** Abandoned conversations expire rather than pinning a teacher in a menu forever. */
    expiresAt: tsz('expires_at'),
  },
  (t) => [
    check('conversation_states_chat_id_digits', CHAT_ID_IS_DIGITS('chat_id')),
    index('conversation_states_expiry_idx').on(t.expiresAt),
  ],
);

/**
 * One-time codes for urgent cases.
 *
 * Single use is enforced by the database, not by application timing: consuming a
 * code is a conditional update that can only succeed once. The Apps Script
 * version protected this with a global lock and its own notes listed the
 * possibility of a code being used twice as an accepted risk.
 */
export const urgentCodes = pgTable(
  'urgent_codes',
  {
    code: text('code').primaryKey(),
    issuedBy: chatId('issued_by').notNull(),
    issuedAt: tsz('issued_at').notNull().defaultNow(),
    expiresAt: tsz('expires_at').notNull(),
    usedAt: tsz('used_at'),
    usedBy: chatId('used_by'),
    /**
     * The case the code bought.
     *
     * Written in the same statement as `used_at`, in the same transaction as the
     * case insert, so a spent code always names what it was spent on. That makes
     * "spent for nothing" a queryable condition rather than an invisible one —
     * which is what the heartbeat check reads.
     *
     * Deliberately not a foreign key to `cases.reference`: this table outlives
     * the retention window of an individual case, and a constraint here would
     * make deleting an old case fail rather than making a spent code
     * self-describing.
     */
    caseReference: text('case_reference'),
  },
  (t) => [
    index('urgent_codes_expiry_idx').on(t.expiresAt, t.usedAt),
    index('urgent_codes_stranded_idx').on(t.usedAt, t.caseReference),
  ],
);

/**
 * Failed urgent-code guesses, counted over a rolling window.
 *
 * A row here is a wrong code, never a right one. It exists because making the
 * code genuinely single-use also made guessing free: Apps Script destroyed a
 * code whether the guess was right or wrong, so a wrong guess burned the thing
 * it was guessing at. A conditional `UPDATE … WHERE used_at IS NULL` leaves a
 * wrong code untouched, and six characters is a small space to search at
 * leisure.
 *
 * Its own table rather than a column on `teachers`, for D3's reason: a durable
 * counter needs a command to clear it and no such command exists yet. Rows age
 * out of the window on their own, so the cap heals without anyone acting.
 */
export const urgentCodeAttempts = pgTable(
  'urgent_code_attempts',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    chatId: chatId('chat_id').notNull(),
    at: tsz('at').notNull().defaultNow(),
  },
  (t) => [
    check('urgent_code_attempts_chat_id_digits', CHAT_ID_IS_DIGITS('chat_id')),
    index('urgent_code_attempts_chat_idx').on(t.chatId, t.at),
  ],
);

/**
 * Interaction history.
 *
 * The Apps Script version took a lock to append a row and gave up after three
 * seconds, so it discarded entries exactly when the system was busiest — which
 * is precisely when you would want to read them back.
 */
export const messages = pgTable(
  'messages',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    at: tsz('at').notNull().defaultNow(),
    /** 'SYSTEM' for bot-initiated events, so a case reference never sits in this column. */
    chatId: text('chat_id').notNull(),
    action: text('action').notNull(),
    detail: text('detail').notNull().default(''),
  },
  (t) => [
    index('messages_at_idx').on(t.at),
    index('messages_chat_idx').on(t.chatId, t.at),
    index('messages_action_idx').on(t.action, t.at),
  ],
);

/**
 * Permanent record of privileged actions.
 *
 * Separate from `messages` on purpose. Interaction history is operational and is
 * pruned on the retention schedule; this is the answer to "who granted that
 * person access, and when", and is not pruned with it.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    at: tsz('at').notNull().defaultNow(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    subject: text('subject'),
    detail: jsonb('detail').notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [index('audit_log_at_idx').on(t.at), index('audit_log_action_idx').on(t.action, t.at)],
);

/** Operational settings, set through bot commands rather than a spreadsheet tab. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  notes: text('notes'),
  updatedAt: tsz('updated_at').notNull().defaultNow(),
  updatedBy: chatId('updated_by'),
});

/**
 * Announcements.
 *
 * The audience is frozen into `announcement_recipients` the moment the sender
 * confirms — see that table.
 */
export const announcements = pgTable(
  'announcements',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    content: text('content').notNull(),
    audience: text('audience').notNull().default('all'),
    status: announcementStatusEnum('status').notNull().default('Draft'),
    createdBy: chatId('created_by').notNull(),
    createdAt: tsz('created_at').notNull().defaultNow(),
    startedAt: tsz('started_at'),
    finishedAt: tsz('finished_at'),
  },
  (t) => [index('announcements_status_idx').on(t.status, t.createdAt)],
);

/**
 * One row per recipient, written when the announcement is confirmed.
 *
 * This fixes a flaw nobody had spotted: the Apps Script version counted the
 * audience once to show the sender a preview, then looked it up again when
 * sending. A teacher who verified between the two meant the number approved was
 * not the number that received it.
 *
 * It is also what makes a restart safe. If the server stops at teacher 900 of
 * 1,800, delivery resumes at 901 and the first 900 cannot be messaged twice —
 * where the old behaviour reported "900 not attempted, re-run for the
 * remainder" and re-running risked messaging them all again.
 */
export const announcementRecipients = pgTable(
  'announcement_recipients',
  {
    announcementId: text('announcement_id')
      .notNull()
      .references(() => announcements.id, { onDelete: 'cascade' }),
    chatId: chatId('chat_id').notNull(),
    state: deliveryStateEnum('state').notNull().default('Pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    sentAt: tsz('sent_at'),
  },
  (t) => [
    primaryKey({ columns: [t.announcementId, t.chatId] }),
    /** Drives "give me the next unsent recipient" without scanning the sent ones. */
    index('announcement_recipients_pending_idx').on(t.announcementId, t.state),
  ],
);

/**
 * Updates already handled.
 *
 * Telegram resends any update it does not receive a 2xx for, backing off but
 * never giving up. The web process is configured to return 200 on timeout while
 * the handler keeps running, so a redelivery can overlap an original that is
 * still executing — and a crash between writing a case and replying gets the
 * update redelivered too.
 *
 * The two things a replay corrupts are exactly the teacher-facing ones: a case
 * filed twice, and a one-time urgent code consumed twice. The Apps Script
 * version had this control and the rebuild lost it; the specification still
 * lists it as shipped.
 *
 * Pruned on the retention schedule — a day is far longer than Telegram will
 * retry for.
 */
export const processedUpdates = pgTable(
  'processed_updates',
  {
    updateId: text('update_id').primaryKey(),
    at: tsz('at').notNull().defaultNow(),
  },
  (t) => [index('processed_updates_at_idx').on(t.at)],
);

/**
 * Proof that a scheduled job ran.
 *
 * "Nobody notices when something breaks" is on the concerns list because errors
 * went to a log nobody opened. Every scheduled job records its outcome here, and
 * a job that misses its slot raises an alert — so silence becomes an alarm
 * instead of an assumption.
 */
export const jobRuns = pgTable(
  'job_runs',
  {
    jobName: text('job_name').primaryKey(),
    lastStartedAt: tsz('last_started_at'),
    lastSuccessAt: tsz('last_success_at'),
    lastFailureAt: tsz('last_failure_at'),
    lastError: text('last_error'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    /** How long may pass before absence is treated as failure. */
    expectedIntervalSeconds: integer('expected_interval_seconds').notNull(),
    alertedAt: tsz('alerted_at'),
  },
  (t) => [index('job_runs_success_idx').on(t.lastSuccessAt)],
);

/**
 * The outcome of every sync, including the ones that refused to run.
 *
 * A sync that aborts on the damage limit is the system working correctly, but it
 * is invisible unless it is written down and someone is told.
 */
export const syncRuns = pgTable(
  'sync_runs',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    source: text('source').notNull(),
    startedAt: tsz('started_at').notNull().defaultNow(),
    finishedAt: tsz('finished_at'),
    outcome: text('outcome').notNull(),
    rowsSeen: integer('rows_seen').notNull().default(0),
    rowsUpserted: integer('rows_upserted').notNull().default(0),
    rowsDeactivated: integer('rows_deactivated').notNull().default(0),
    rowsRejected: integer('rows_rejected').notNull().default(0),
    /** Every rejected row with the reason, so content owners get told what to fix. */
    rejections: jsonb('rejections').notNull().default(sql`'[]'::jsonb`),
    message: text('message'),
  },
  (t) => [index('sync_runs_source_idx').on(t.source, t.startedAt)],
);
