/**
 * Stage 6 against a real PostgreSQL — the forms tab and the response sync.
 *
 * The property that matters most here cannot be tested any other way: **reading
 * the same submission twice must file exactly one case.** Every other sync in
 * this system is idempotent because it upserts on a natural key; this one is an
 * event, and the thing standing between it and a duplicate case every ten
 * minutes is a marker row written in the same transaction as the case. A mock
 * would confirm the code calls `transaction`, not that the two writes actually
 * land or roll back together.
 *
 * Skips itself when TEST_DATABASE_URL is unset. A skipped test is not a passing
 * test:
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   TEST_DATABASE_URL=postgres://mopse:mopse@localhost:5432/mopse_test npm test
 */
import { eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../db/index.js';
import * as schema from '../db/schema.js';
import { anonymiseFormSubmissions } from '../retention/purge.js';
import type { SheetReader } from '../sheets/client.js';
import type { Alert, Alerter } from './alerts.js';
import { syncFormResponses } from './form-responses.js';
import { syncForms } from './sheets-sync.js';

const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

const FORMS_HEADER = ['TYPE', 'BUTTON_TEXT', 'URL', 'RESPONSES_TAB', 'ACTIVE'];
const RESPONSES_HEADER = ['Timestamp', 'Your email address', 'Passport number'];
const FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQL/viewform';

const formRow = (type: string, tab: string | null = `${type}_RESPONSES`, active = 'TRUE'): string[] => [
  type,
  `Send your ${type.toLowerCase()}`,
  FORM_URL,
  tab ?? '',
  active,
];

const submission = (email: string, extra = 'AA1234567'): string[] => [
  '31/07/2026 14:02:11',
  email,
  extra,
];

function readerReturning(tabs: Record<string, string[][]>): SheetReader {
  return {
    readTab: async (tab: string) => {
      const found = tabs[tab];
      if (found === undefined) throw new Error(`no such tab: ${tab}`);
      return found;
    },
  };
}

function collectingAlerter(): Alerter & { alerts: Alert[] } {
  const alerts: Alert[] = [];
  return { alerts, send: async (alert: Alert) => void alerts.push(alert) };
}

describe.skipIf(!TEST_DATABASE_URL)('documents against a real database', () => {
  let pool: pg.Pool;
  let db: Database;

  /** A teacher who is on the roster AND has signed in — the only kind a case can be filed for. */
  async function signedInTeacher(chatId: string, email: string, name = 'A Teacher'): Promise<void> {
    await db.insert(schema.rosterEntries).values({ identifier: email, name, region: 'Tashkent' });
    await db.insert(schema.teachers).values({
      chatId,
      identifier: email,
      name,
      verificationState: 'Verified',
    });
  }

  /** On the roster, has never opened the bot. Q1's case, and there is no chat id to file against. */
  async function rosterOnly(email: string, name = 'Never Signed In'): Promise<void> {
    await db.insert(schema.rosterEntries).values({ identifier: email, name, region: 'Tashkent' });
  }

  beforeEach(async () => {
    pool ??= new pg.Pool({ connectionString: TEST_DATABASE_URL });
    db ??= drizzle(pool, { schema }) as NodePgDatabase<typeof schema> as Database;
    await db.execute(sql`
      TRUNCATE form_submissions, form_links, case_notes, cases, case_sequences,
               teachers, roster_entries, sync_runs RESTART IDENTITY CASCADE
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe('the FORMS tab', () => {
    it('publishes the forms staff put in the sheet', async () => {
      const report = await syncForms(db, readerReturning({ FORMS: [FORMS_HEADER, formRow('PASSPORT')] }));
      expect(report.outcome).toBe('applied');
      expect(report.rowsUpserted).toBe(1);

      const rows = await db.select().from(schema.formLinks);
      expect(rows[0]).toMatchObject({ type: 'PASSPORT', url: FORM_URL, active: true });
    });

    it('edits a link in place rather than duplicating it', async () => {
      await syncForms(db, readerReturning({ FORMS: [FORMS_HEADER, formRow('PASSPORT')] }));
      const changed = formRow('PASSPORT');
      changed[2] = 'https://docs.google.com/forms/d/e/CHANGED/viewform';
      await syncForms(db, readerReturning({ FORMS: [FORMS_HEADER, changed] }));

      const rows = await db.select().from(schema.formLinks);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.url).toMatch(/CHANGED/);
    });

    /**
     * The rule the whole sync design exists for: one unusable row must not stop
     * the others reaching teachers.
     */
    it('rejects a bad row by number and applies the rest', async () => {
      const alerter = collectingAlerter();
      const bad = formRow('VISA');
      bad[2] = 'ask Dilnoza for the link';

      const report = await syncForms(
        db,
        readerReturning({ FORMS: [FORMS_HEADER, formRow('PASSPORT'), bad, formRow('CONTRACT')] }),
        { alerter },
      );

      expect(report.outcome).toBe('applied');
      expect(report.rejections).toHaveLength(1);
      expect(report.rejections[0]?.row).toBe(3);
      expect(await db.select().from(schema.formLinks)).toHaveLength(2);
      expect(alerter.alerts.some((a) => a.body.includes('Row 3'))).toBe(true);
    });

    it('records the run so an operator can see what happened', async () => {
      await syncForms(db, readerReturning({ FORMS: [FORMS_HEADER, formRow('PASSPORT')] }));
      const runs = await db.select().from(schema.syncRuns).where(eq(schema.syncRuns.source, 'FORMS'));
      expect(runs).toHaveLength(1);
      expect(runs[0]?.outcome).toBe('applied');
    });
  });

  describe('reading submissions back', () => {
    async function publishForm(tab: string | null = 'PASSPORT_RESPONSES'): Promise<void> {
      await syncForms(db, readerReturning({ FORMS: [FORMS_HEADER, formRow('PASSPORT', tab)] }));
    }

    it('files a case for a teacher who has signed in', async () => {
      await publishForm();
      await signedInTeacher('950001', 'a@example.com');

      const report = await syncFormResponses(
        db,
        readerReturning({ PASSPORT_RESPONSES: [RESPONSES_HEADER, submission('a@example.com')] }),
      );

      expect(report.filed).toBe(1);
      const cases = await db.select().from(schema.cases);
      expect(cases).toHaveLength(1);
      expect(cases[0]?.category).toBe('Submit Documents');
      expect(cases[0]?.teacherChatId).toBe('950001');
    });

    /**
     * ⚠️ THE test. The responses tab keeps row 2 for ever and the sync reads the
     * whole tab every ten minutes. Without the marker this files a case a
     * hundred and forty-four times a day.
     */
    it('files exactly one case however many times the same tab is read', async () => {
      await publishForm();
      await signedInTeacher('950001', 'a@example.com');
      const reader = readerReturning({
        PASSPORT_RESPONSES: [RESPONSES_HEADER, submission('a@example.com')],
      });

      const first = await syncFormResponses(db, reader);
      const second = await syncFormResponses(db, reader);
      const third = await syncFormResponses(db, reader);

      expect(first.filed).toBe(1);
      expect(second.filed).toBe(0);
      expect(second.alreadySeen).toBe(1);
      expect(third.filed).toBe(0);
      expect(await db.select().from(schema.cases)).toHaveLength(1);
    });

    it('leaves a marker for every row it has looked at, whatever it decided', async () => {
      await publishForm();
      await signedInTeacher('950001', 'a@example.com');
      await rosterOnly('b@example.com');

      await syncFormResponses(
        db,
        readerReturning({
          PASSPORT_RESPONSES: [
            RESPONSES_HEADER,
            submission('a@example.com'),
            submission('b@example.com'),
            submission('nobody@example.com'),
          ],
        }),
      );

      const marks = await db.select().from(schema.formSubmissions);
      expect(marks).toHaveLength(3);
      expect(marks.map((m) => m.outcome).sort()).toEqual(['Filed', 'RosterNoChat', 'Unmatched']);
    });

    /**
     * Q1. On the roster, never opened the bot, so there is no chat id and
     * `cases.teacher_chat_id` cannot be satisfied. Alert a person; file nothing.
     */
    it('files nothing and names the teacher when they have never signed in', async () => {
      await publishForm();
      await rosterOnly('b@example.com', 'Bobur Aliev');
      const alerter = collectingAlerter();

      const report = await syncFormResponses(
        db,
        readerReturning({ PASSPORT_RESPONSES: [RESPONSES_HEADER, submission('b@example.com')] }),
        { alerter },
      );

      expect(report.filed).toBe(0);
      expect(report.rosterNoChat).toBe(1);
      expect(await db.select().from(schema.cases)).toHaveLength(0);

      const alert = alerter.alerts.find((a) => a.title.includes('not signed in'));
      expect(alert?.body).toContain('Bobur Aliev');
      expect(alert?.body).toContain('b@example.com');
    });

    it('does not tell staff we do not know an address we do know', async () => {
      await publishForm();
      await rosterOnly('b@example.com', 'Bobur Aliev');
      const alerter = collectingAlerter();

      await syncFormResponses(
        db,
        readerReturning({ PASSPORT_RESPONSES: [RESPONSES_HEADER, submission('b@example.com')] }),
        { alerter },
      );

      expect(alerter.alerts.some((a) => a.title.includes('matched no teacher'))).toBe(false);
    });

    it('reports an address that is on no roster row', async () => {
      await publishForm();
      const alerter = collectingAlerter();

      const report = await syncFormResponses(
        db,
        readerReturning({ PASSPORT_RESPONSES: [RESPONSES_HEADER, submission('ghost@example.com')] }),
        { alerter },
      );

      expect(report.unmatched).toBe(1);
      expect(alerter.alerts.some((a) => a.title.includes('matched no teacher'))).toBe(true);
    });

    it('matches regardless of how the teacher capitalised their address', async () => {
      await publishForm();
      await signedInTeacher('950001', 'a.karimov@example.com');

      const report = await syncFormResponses(
        db,
        readerReturning({
          PASSPORT_RESPONSES: [RESPONSES_HEADER, submission(' A.Karimov@Example.com ')],
        }),
      );
      expect(report.filed).toBe(1);
    });

    /**
     * `createCase` returns the open case in the same category within 24 hours
     * rather than opening a second, which is right — three forms in a morning is
     * one piece of work. The note is what stops the later submissions being
     * invisible to whoever picks the case up.
     */
    it('notes a second submission on the case rather than losing it', async () => {
      await publishForm();
      await signedInTeacher('950001', 'a@example.com');

      await syncFormResponses(
        db,
        readerReturning({
          PASSPORT_RESPONSES: [
            RESPONSES_HEADER,
            submission('a@example.com', 'first'),
            submission('a@example.com', 'corrected'),
          ],
        }),
      );

      expect(await db.select().from(schema.cases)).toHaveLength(1);
      const notes = await db.select().from(schema.caseNotes);
      expect(notes).toHaveLength(2);
      expect(notes[0]?.body).toContain('Send your passport');
    });

    it('ignores a form whose responses nobody has linked yet', async () => {
      await publishForm(null);
      await signedInTeacher('950001', 'a@example.com');

      const report = await syncFormResponses(db, readerReturning({}));
      expect(report.formsRead).toBe(0);
      expect(report.filed).toBe(0);
    });

    /**
     * D41. One misconfigured form must not hold back everybody else's documents.
     */
    it('keeps filing the other forms when one tab cannot be read', async () => {
      await syncForms(
        db,
        readerReturning({
          FORMS: [FORMS_HEADER, formRow('PASSPORT'), formRow('VISA', 'MISSPELLED_TAB')],
        }),
      );
      await signedInTeacher('950001', 'a@example.com');
      const alerter = collectingAlerter();

      const report = await syncFormResponses(
        db,
        readerReturning({ PASSPORT_RESPONSES: [RESPONSES_HEADER, submission('a@example.com')] }),
        { alerter },
      );

      expect(report.filed).toBe(1);
      expect(alerter.alerts.some((a) => a.title.includes('could not be read'))).toBe(true);
    });

    it('refuses a whole tab whose email column is ambiguous, and says so', async () => {
      await publishForm();
      await signedInTeacher('950001', 'a@example.com');
      const alerter = collectingAlerter();

      const report = await syncFormResponses(
        db,
        readerReturning({
          PASSPORT_RESPONSES: [
            ['Timestamp', 'Your email', "Supervisor's email"],
            ['t', 'a@example.com', 'boss@example.com'],
          ],
        }),
        { alerter },
      );

      expect(report.filed).toBe(0);
      expect(await db.select().from(schema.cases)).toHaveLength(0);
      expect(alerter.alerts.some((a) => a.body.includes("Supervisor's email"))).toBe(true);
    });

    it('still reads a form that staff have switched off', async () => {
      // Its submissions from last night are still somebody's documents.
      await syncForms(
        db,
        readerReturning({ FORMS: [FORMS_HEADER, formRow('PASSPORT', 'PASSPORT_RESPONSES', 'FALSE')] }),
      );
      await signedInTeacher('950001', 'a@example.com');

      const report = await syncFormResponses(
        db,
        readerReturning({ PASSPORT_RESPONSES: [RESPONSES_HEADER, submission('a@example.com')] }),
      );
      expect(report.filed).toBe(1);
    });
  });

  describe('retention anonymises the marker and never deletes it — D44', () => {
    async function oneFiledSubmission(): Promise<void> {
      await syncForms(db, readerReturning({ FORMS: [FORMS_HEADER, formRow('PASSPORT')] }));
      await db.insert(schema.rosterEntries).values({ identifier: 'a@example.com', name: 'A' });
      await db.insert(schema.teachers).values({
        chatId: '950001',
        identifier: 'a@example.com',
        name: 'A',
        verificationState: 'Verified',
      });
      await syncFormResponses(
        db,
        readerReturning({ PASSPORT_RESPONSES: [RESPONSES_HEADER, submission('a@example.com')] }),
      );
    }

    /**
     * The whole point. If the marker went with the case, the responses row —
     * which Google keeps for ever — would look new on the very next sync.
     */
    it('keeps the marker after its case is deleted, so the row is never re-filed', async () => {
      await oneFiledSubmission();
      await db.delete(schema.cases);

      const marks = await db.select().from(schema.formSubmissions);
      expect(marks).toHaveLength(1);
      expect(marks[0]?.caseReference).toBeNull();

      // And the sync agrees: nothing new to do.
      const again = await syncFormResponses(
        db,
        readerReturning({ PASSPORT_RESPONSES: [RESPONSES_HEADER, submission('a@example.com')] }),
      );
      expect(again.filed).toBe(0);
      expect(await db.select().from(schema.cases)).toHaveLength(0);
    });

    it('takes the address off once the case is gone', async () => {
      await oneFiledSubmission();
      await db.delete(schema.cases);

      const removed = await anonymiseFormSubmissions(db, 7);
      expect(removed).toBe(1);

      const marks = await db.select().from(schema.formSubmissions);
      expect(marks[0]?.submitterEmail).toBeNull();
      expect(marks[0]?.formType).toBe('PASSPORT');
      expect(marks[0]?.outcome).toBe('Filed');
    });

    it('leaves the address alone while the case still exists', async () => {
      await oneFiledSubmission();
      expect(await anonymiseFormSubmissions(db, 7)).toBe(0);
      const marks = await db.select().from(schema.formSubmissions);
      expect(marks[0]?.submitterEmail).toBe('a@example.com');
    });

    it('does nothing at all when no period is set — D30', async () => {
      await oneFiledSubmission();
      await db.delete(schema.cases);
      expect(await anonymiseFormSubmissions(db, null)).toBe(0);
      const marks = await db.select().from(schema.formSubmissions);
      expect(marks[0]?.submitterEmail).toBe('a@example.com');
    });

    /**
     * An unmatched submission never becomes a case, so nothing else would ever
     * clear its address. It must not sit there indefinitely.
     */
    it('clears an unmatched submission once it is older than the case period', async () => {
      await syncForms(db, readerReturning({ FORMS: [FORMS_HEADER, formRow('PASSPORT')] }));
      await syncFormResponses(
        db,
        readerReturning({ PASSPORT_RESPONSES: [RESPONSES_HEADER, submission('ghost@example.com')] }),
      );

      expect(await anonymiseFormSubmissions(db, 7)).toBe(0);

      await db.execute(sql`UPDATE form_submissions SET seen_at = now() - interval '30 days'`);
      expect(await anonymiseFormSubmissions(db, 7)).toBe(1);

      const marks = await db.select().from(schema.formSubmissions);
      expect(marks[0]?.submitterEmail).toBeNull();
      expect(marks[0]?.outcome).toBe('Unmatched');
    });
  });
});
