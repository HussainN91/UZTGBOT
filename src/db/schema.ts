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
 */
export const caseStatusEnum = pgEnum('case_status', [
  'New',
  'Received',
  'Under review',
  'Action required',
  'Escalated',
  'Completed',
  'Closed',
  'Duplicate',
]);

/** Statuses that count as still open, for the 24-hour duplicate window. */
export const OPEN_CASE_STATUSES = [
  'New',
  'Received',
  'Under review',
  'Action required',
  'Escalated',
] as const;

/**
 * One role system, replacing three.
 *
 * The Apps Script version carried a yes/no "system admin" flag, a TIER
 * category, and a ROLE column, plus a fallback that tried all three in order.
 * That fallback existed purely to keep older spreadsheet rows working, and
 * there are no rows. Roles are ordered here, so "at least Regional" is a
 * comparison rather than the exact-match check that made Program-tier staff
 * mysteriously unable to do Regional-tier things.
 */
export const staffRoleEnum = pgEnum('staff_role', ['Support', 'Regional', 'Program', 'System']);

/** Ascending authority. Index in this array is the rank. */
export const STAFF_ROLE_ORDER = ['Support', 'Regional', 'Program', 'System'] as const;
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
    region: text('region'),
    language: text('language').notNull().default('EN'),
    firstSeen: tsz('first_seen').notNull().defaultNow(),
    lastSeen: tsz('last_seen').notNull().defaultNow(),
    /** Set when a staff member revokes access. Null means active. */
    revokedAt: tsz('revoked_at'),
    revokedBy: chatId('revoked_by'),
    privacyNoticeAcceptedAt: tsz('privacy_notice_accepted_at'),
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
  },
  (t) => [index('urgent_codes_expiry_idx').on(t.expiresAt, t.usedAt)],
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
