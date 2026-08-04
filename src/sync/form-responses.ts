/**
 * Reading back what teachers submitted through Google Forms — D24.
 *
 * This is the upward half of Stage 6, and it is unlike every other sync here.
 * The FAQ and the roster are *records*: upsert them on a natural key, deactivate
 * what the sheet no longer shows, and running twice changes nothing. A form
 * response is an *event*. Re-reading it must not re-fire it, and nothing else in
 * this system has needed that.
 *
 * `form_submissions` is what makes it true. A row is written for every response
 * the bot has looked at, whatever it decided, and the case and its marker are
 * written in ONE transaction — so a crash between them cannot leave a case
 * behind that the next sweep would file again.
 *
 * **The bot never accepts, holds or stores a file.** The documents stay in
 * Google; what arrives here is the fact that they were sent, and by whom.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { createCase } from '../cases/service.js';
import { CASE_CATEGORY } from '../config/constants.js';
import { withChatLock } from '../conversation/lock.js';
import type { Database } from '../db/index.js';
import {
  cases,
  formSubmissions,
  OPEN_CASE_STATUSES,
  rosterEntries,
  syncRuns,
  teachers,
} from '../db/schema.js';
import { addNote } from '../cases/notes.js';
import { formsWithResponses, type FormWithResponses } from '../forms/repository.js';
import { log } from '../log.js';
import type { SheetReader } from '../sheets/client.js';
import { EmailColumnError, parseResponsesTab, type Rejection } from '../sheets/parse.js';
import { loggingAlerter, neverThrows, type Alerter } from './alerts.js';
import type { SyncOutcome } from './sheets-sync.js';

/**
 * What the bot decided about one response row. Stored in `form_submissions.outcome`.
 *
 * Deliberately NOT exported. The integration tests assert the three strings as
 * literals instead, and that is the right way round: these values sit in a
 * database column, so a test reading them from this object would keep passing
 * while a renamed value quietly orphaned every row already stored.
 */
const SUBMISSION_OUTCOME = {
  /** Matched a signed-in teacher. A case exists. */
  FILED: 'Filed',
  /** On the roster, but no usable Telegram account — Q1. Nobody to file it under. */
  ROSTER_NO_CHAT: 'RosterNoChat',
  /** The address is on no roster row at all. */
  UNMATCHED: 'Unmatched',
} as const;

export interface ResponseSyncReport {
  readonly outcome: SyncOutcome;
  readonly formsRead: number;
  readonly rowsSeen: number;
  readonly filed: number;
  readonly alreadySeen: number;
  readonly rosterNoChat: number;
  readonly unmatched: number;
  readonly rejections: readonly Rejection[];
  readonly message: string;
}

export interface ResponseSyncOptions {
  readonly alerter?: Alerter;
}

interface FormProblem {
  readonly form: string;
  readonly reason: string;
}

interface Unfiled {
  readonly form: string;
  readonly row: number;
  readonly email: string;
  readonly name: string | null;
}

export async function syncFormResponses(
  db: Database,
  reader: SheetReader,
  options: ResponseSyncOptions = {},
): Promise<ResponseSyncReport> {
  const alerter = neverThrows(options.alerter ?? loggingAlerter);
  const startedAt = new Date();

  let rowsSeen = 0;
  let filed = 0;
  let alreadySeen = 0;
  const rejections: Rejection[] = [];
  const problems: FormProblem[] = [];
  const noChat: Unfiled[] = [];
  const unmatched: Unfiled[] = [];

  let forms: FormWithResponses[];
  try {
    forms = await formsWithResponses(db);
  } catch (err) {
    const message = `Could not read the form list: ${err instanceof Error ? err.message : String(err)}`;
    await record(db, 'failed', startedAt, 0, 0, rejections, message);
    await alerter.send({ severity: 'critical', title: 'Form responses sync failed', body: message });
    return {
      outcome: 'failed', formsRead: 0, rowsSeen: 0, filed: 0, alreadySeen: 0,
      rosterNoChat: 0, unmatched: 0, rejections, message,
    };
  }

  for (const form of forms) {
    /**
     * One form's failure must never stop the others — D41. A tab named wrongly,
     * or a form whose email question was reworded this morning, takes that form
     * out and leaves every other form's submissions arriving normally. The
     * alternative is one typo silently holding back everybody's documents.
     */
    try {
      const raw = await reader.readTab(form.responsesTab);
      const parsed = parseResponsesTab(form.responsesTab, raw, form.emailColumn);
      rowsSeen += Math.max(raw.length - 1, 0);
      for (const r of parsed.rejections) {
        rejections.push({ ...r, reason: `${form.buttonText}: ${r.reason}` });
      }

      const seen = await processedRows(db, form.type);

      for (const row of parsed.rows) {
        if (seen.has(row.sheetRow)) {
          alreadySeen += 1;
          continue;
        }

        const match = await matchTeacher(db, row.email);

        if (match.kind === 'unmatched') {
          await mark(db, form.type, row, SUBMISSION_OUTCOME.UNMATCHED, null);
          unmatched.push({ form: form.buttonText, row: row.sheetRow, email: row.email, name: null });
          continue;
        }

        if (match.kind === 'noChat') {
          await mark(db, form.type, row, SUBMISSION_OUTCOME.ROSTER_NO_CHAT, null);
          noChat.push({ form: form.buttonText, row: row.sheetRow, email: row.email, name: match.name });
          continue;
        }

        /**
         * The case and its marker, together or not at all.
         *
         * If these were two writes, a crash between them would leave a case with
         * no marker — and the next sweep, ten minutes later, would file it
         * again. And again.
         *
         * The marker insert is deliberately NOT `onConflictDoNothing`, unlike
         * `mark` below, and that makes the primary key a second line of defence
         * behind `alreadyProcessed`. If that check were ever removed or broken,
         * the duplicate marker would violate `(form_type, sheet_row)` and take
         * the case down with it in the rollback. Proven on 31 July 2026 by
         * breaking `alreadyProcessed` on purpose: exactly one test failed, and
         * no duplicate case reached the database by either route.
         *
         * **Under the chat lock, which it was not before.** `cases/service.ts`
         * states in its own header that `createCase` is a read-then-write — it
         * looks for an open case in the same category within 24 hours and then
         * either appends to it or inserts — and that it must run inside
         * `withChatLock`. This ran in a plain transaction with no lock.
         *
         * It was safe by accident rather than by design: the worker runs one job
         * at a time, and a form case files under `Submit Documents` while a
         * teacher's own case files under whatever they chose, so the two could
         * not collide on the dedup read. Both of those are true today and
         * neither is a property this file controls. The day the worker gains a
         * second slot, or the day anything else files under `Submit Documents`,
         * two writers race on the read and the teacher gets two cases for one
         * piece of work.
         *
         * **This replaces the transaction rather than nesting inside one.**
         * `withChatLock` opens its own, so wrapping the existing
         * `db.transaction` would make the inner one a savepoint pretending to be
         * a commit — the failure `verifyIdentifier` and `forgetTeacher` both
         * carry notes about. The lock is transaction-scoped, so it releases
         * however this ends, including on the rollback that the marker's primary
         * key is there to cause.
         */
        await withChatLock(db, match.chatId, async (tx) => {
          const t = tx;

          /**
           * The complaint this package belongs to, if the teacher wrote one.
           *
           * **Matched on the area as well as the teacher.** A teacher may have an
           * open accommodation complaint and an open reimbursement complaint at
           * once, and putting the reimbursement package on the accommodation case
           * is the kind of wrong that looks right on every screen.
           *
           * Newest first, because a teacher who raised the same complaint twice
           * means the later one.
           */
          const open = await t
            .select({ reference: cases.reference })
            .from(cases)
            .where(
              and(
                eq(cases.teacherChatId, match.chatId),
                eq(cases.formType, form.type),
                inArray(cases.status, [...OPEN_CASE_STATUSES]),
              ),
            )
            .orderBy(desc(cases.createdAt))
            .limit(1);

          const joined = open[0];
          let reference: string;

          if (joined === undefined) {
            /**
             * Nobody wrote anything — the teacher went straight to the form. This
             * is the original path and it is unchanged: a case of its own, under
             * `Submit Documents`.
             */
            const created = await createCase(t, {
              chatId: match.chatId,
              category: CASE_CATEGORY.SUBMIT_DOCS,
              detail: `Submitted “${form.buttonText}” through the online form.`,
            });
            reference = created.reference;

            /**
             * A note on every submission, including one that joined an existing
             * case. `createCase` returns the open case in the same category within
             * 24 hours rather than opening a second — which is right, since three
             * forms in a morning is one piece of work — but without this note the
             * second and third submissions would be invisible to whoever picks it
             * up. The teacher is the author because the teacher is who did it.
             */
            await addNote(
              t,
              reference,
              `Submitted “${form.buttonText}”` +
                (row.submittedAt === null ? '' : ` on ${row.submittedAt}`) +
                `. The documents are in the form's responses, not in this system.`,
              match.chatId,
            );
          } else {
            reference = joined.reference;

            /**
             * The paperwork caught up with the complaint. The note carries the
             * sheet row because that is the only handle anybody has on the actual
             * documents — they are in Google and this system never holds them.
             */
            await addNote(
              t,
              reference,
              `The “${form.buttonText}” submission has arrived` +
                (row.submittedAt === null ? '' : ` on ${row.submittedAt}`) +
                `. It is row ${row.sheetRow} of the form's responses; the documents are in the ` +
                `form, not in this system.`,
              match.chatId,
            );

            /**
             * Cleared in the same transaction as the marker, so the case can never
             * say "still waiting" about a submission that has been filed. The
             * marker's primary key is what rolls both back together.
             */
            await t
              .update(cases)
              .set({ awaitingForm: false })
              .where(eq(cases.reference, reference));
          }

          await t.insert(formSubmissions).values({
            formType: form.type,
            sheetRow: row.sheetRow,
            outcome: SUBMISSION_OUTCOME.FILED,
            caseReference: reference,
            submitterEmail: row.email,
            submittedAt: parseTimestamp(row.submittedAt),
          });
        });
        filed += 1;
      }
    } catch (err) {
      const reason =
        err instanceof EmailColumnError
          ? err.message
          : `Could not read the responses tab “${form.responsesTab}”: ` +
            `${err instanceof Error ? err.message : String(err)}`;
      problems.push({ form: form.buttonText, reason });
      log.error({ err, form: form.type }, 'form responses could not be read');
    }
  }

  const message =
    `${forms.length} form(s) read, ${filed} filed, ${alreadySeen} already seen` +
    (noChat.length > 0 ? `, ${noChat.length} with no Telegram account` : '') +
    (unmatched.length > 0 ? `, ${unmatched.length} unmatched` : '') +
    (problems.length > 0 ? `, ${problems.length} form(s) unreadable` : '');

  /**
   * `applied` even when some rows could not be filed. A submission the bot
   * cannot match is reported to a person and recorded, which is the system
   * working. Only a total inability to read anything is a failure.
   */
  const outcome: SyncOutcome = problems.length === forms.length && forms.length > 0 ? 'failed' : 'applied';
  await record(db, outcome, startedAt, rowsSeen, filed, rejections, message);
  log.info({ formsRead: forms.length, filed, alreadySeen, unmatched: unmatched.length }, 'form responses synced');

  if (noChat.length > 0) await reportNoChat(alerter, noChat);
  if (unmatched.length > 0) await reportUnmatched(alerter, unmatched);
  if (rejections.length > 0) await reportRejections(alerter, rejections);
  for (const p of problems) {
    await alerter.send({ severity: 'critical', title: `Form “${p.form}” could not be read`, body: p.reason });
  }

  return {
    outcome,
    formsRead: forms.length,
    rowsSeen,
    filed,
    alreadySeen,
    rosterNoChat: noChat.length,
    unmatched: unmatched.length,
    rejections,
    message,
  };
}

/**
 * Every row of this form the bot has already dealt with, in one query.
 *
 * Read once per form rather than once per row, and the difference is not a
 * micro-optimisation. A responses tab is append-only and never shrinks, so in
 * steady state **every row in it has already been handled** — a per-row check
 * would issue one `SELECT` for each, which at 1,800 submissions is 1,800 queries
 * every ten minutes, per form, inside a worker that runs `concurrency: 1`.
 *
 * That is precisely the starvation the sweeper's own notes warn about: a long
 * sync run delays the five-minute heartbeat, and the first symptom is a *false*
 * alarm that the sheet sync has stopped, raised late by the heartbeat that was
 * itself starved. The set is small — one integer per submission — and the cost
 * does not grow with how often the sync runs.
 */
async function processedRows(db: Database, formType: string): Promise<Set<number>> {
  const rows = await db
    .select({ row: formSubmissions.sheetRow })
    .from(formSubmissions)
    .where(eq(formSubmissions.formType, formType));
  return new Set(rows.map((r) => r.row));
}

type Match =
  | { readonly kind: 'filed'; readonly chatId: string }
  | { readonly kind: 'noChat'; readonly name: string }
  | { readonly kind: 'unmatched' };

/**
 * The roster identifier is the identity — D24, and it replaces the prefill
 * entirely.
 *
 * Three outcomes rather than two, and the middle one is the whole of Q1. A
 * teacher can be perfectly legitimate, on the roster, holding documents we asked
 * for, and still have no `teachers` row because they have never opened the bot.
 * `cases.teacher_chat_id` is a non-null foreign key, so there is nothing to file
 * their case against. Telling somebody is the answer; inventing a placeholder
 * teacher is not, and the `UNRESOLVED:` sentinel this replaces is exactly that
 * mistake.
 */
async function matchTeacher(db: Database, email: string): Promise<Match> {
  const roster = await db
    .select({ name: rosterEntries.name })
    .from(rosterEntries)
    .where(and(eq(rosterEntries.identifier, email), eq(rosterEntries.active, true)))
    .limit(1);
  const entry = roster[0];
  if (entry === undefined) return { kind: 'unmatched' };

  const found = await db
    .select({ chatId: teachers.chatId })
    .from(teachers)
    .where(and(eq(teachers.identifier, email), eq(teachers.verificationState, 'Verified')))
    .limit(1);
  const teacher = found[0];
  if (teacher === undefined) return { kind: 'noChat', name: entry.name };

  return { kind: 'filed', chatId: teacher.chatId };
}

/** A marker with no case behind it. Its own write, because there is no case to bind it to. */
async function mark(
  db: Database,
  formType: string,
  row: { sheetRow: number; email: string; submittedAt: string | null },
  outcome: string,
  caseReference: string | null,
): Promise<void> {
  await db
    .insert(formSubmissions)
    .values({
      formType,
      sheetRow: row.sheetRow,
      outcome,
      caseReference,
      submitterEmail: row.email,
      submittedAt: parseTimestamp(row.submittedAt),
    })
    .onConflictDoNothing();
}

/**
 * Google's timestamp is whatever text the sheet displayed, and its format
 * follows the spreadsheet's locale rather than any standard. An unreadable one
 * becomes null rather than throwing: the timestamp is for a human reading the
 * case, and losing it must never cost the submission itself.
 */
function parseTimestamp(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Q1's answer, and deliberately NOT the same message as an unmatched address.
 *
 * "We do not know this email" is false here — we know exactly who they are, they
 * are on the roster, and that is precisely why a person can act on this. Saying
 * the wrong thing would send whoever reads it looking in the wrong place.
 */
async function reportNoChat(alerter: Alerter, rows: readonly Unfiled[]): Promise<void> {
  const shown = rows.slice(0, 10);
  const body = [
    `${rows.length} submission(s) came from teachers who are on the roster but have never signed in ` +
      `to the bot, so there is no case to file them against. Their documents ARE submitted and safe ` +
      `in the form's responses — but nobody can track them here until the teacher signs in.`,
    '',
    'Ask each of these teachers to open the bot and sign in:',
    '',
    ...shown.map((r) => `• ${r.name ?? 'Unknown'} — ${r.email} (${r.form}, row ${r.row})`),
    ...(rows.length > shown.length ? [`…and ${rows.length - shown.length} more.`] : []),
  ].join('\n');
  await alerter.send({ severity: 'warning', title: 'Submissions from teachers who have not signed in', body });
}

async function reportUnmatched(alerter: Alerter, rows: readonly Unfiled[]): Promise<void> {
  const shown = rows.slice(0, 10);
  const body = [
    `${rows.length} submission(s) used an email address that is on no active roster row, so they ` +
      `could not be matched to anybody. The documents are still in the form's responses.`,
    '',
    'Either the teacher typed a different address from their recruitment one, or the roster is ' +
      'missing them:',
    '',
    ...shown.map((r) => `• ${r.email} (${r.form}, row ${r.row})`),
    ...(rows.length > shown.length ? [`…and ${rows.length - shown.length} more.`] : []),
  ].join('\n');
  await alerter.send({ severity: 'warning', title: 'Submissions that matched no teacher', body });
}

async function reportRejections(alerter: Alerter, rejections: readonly Rejection[]): Promise<void> {
  const shown = rejections.slice(0, 10);
  const body = [
    `${rejections.length} submission(s) could not be read at all. Everything else was filed normally.`,
    '',
    ...shown.map((r) => `Row ${r.row}: ${r.reason}`),
    ...(rejections.length > shown.length ? [`…and ${rejections.length - shown.length} more.`] : []),
  ].join('\n');
  await alerter.send({ severity: 'warning', title: 'Form submissions rejected', body });
}

async function record(
  db: Database,
  outcome: SyncOutcome,
  startedAt: Date,
  rowsSeen: number,
  filed: number,
  rejections: readonly Rejection[],
  message: string,
): Promise<void> {
  try {
    await db.insert(syncRuns).values({
      source: 'FORM_RESPONSES',
      startedAt,
      finishedAt: new Date(),
      outcome,
      rowsSeen,
      /** Filed cases. There is nothing to deactivate here — a submission is an event. */
      rowsUpserted: filed,
      rowsDeactivated: 0,
      rowsRejected: rejections.length,
      rejections: sql`${JSON.stringify(rejections)}::jsonb`,
      message,
    });
  } catch (err) {
    // Recording the run must never be the reason a good sync reports failure.
    log.error({ err }, 'could not record the form responses run');
  }
}
