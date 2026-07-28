/**
 * Reading the answer bank.
 *
 * Every function here filters `active` and orders explicitly. Both were implicit
 * in the spreadsheet version and both broke in the move to a table:
 *
 *   The sheet read filtered `ACTIVE = TRUE` before anything saw a row, so no
 *   caller had to remember. `faq_entries` keeps deactivated rows — the sync
 *   deactivates rather than deletes — so a lookup without the filter serves an
 *   answer that content owners deliberately withdrew.
 *
 *   The sheet had an implicit running order that paging relied on. SQL without
 *   an ORDER BY returns rows arbitrarily, so paging could repeat and skip
 *   answers between taps.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { faqEntries } from '../db/schema.js';

export interface FaqAnswer {
  readonly code: string;
  readonly topicCode: string;
  readonly sheetRow: number;
  readonly buttonText: string;
  readonly officialAnswer: string;
  readonly keywords: readonly string[];
}

const COLUMNS = {
  code: faqEntries.code,
  topicCode: faqEntries.topicCode,
  sheetRow: faqEntries.sheetRow,
  buttonText: faqEntries.buttonText,
  officialAnswer: faqEntries.officialAnswer,
  keywords: faqEntries.keywords,
} as const;

/**
 * Ordered the way the content owner arranged the sheet, with `code` breaking
 * ties.
 *
 * The tiebreak matters more than it looks: `sheet_row` defaults to 0, so a bank
 * imported before that column existed has every row tied. Without a second key
 * the order would be arbitrary *and* unstable between two taps of the same
 * button.
 */
export async function listTopicAnswers(
  db: Database,
  topicCode: string,
): Promise<readonly FaqAnswer[]> {
  return db
    .select(COLUMNS)
    .from(faqEntries)
    .where(and(eq(faqEntries.topicCode, topicCode), eq(faqEntries.active, true)))
    .orderBy(asc(faqEntries.sheetRow), asc(faqEntries.code));
}

/**
 * One answer by code, or null.
 *
 * `active` is filtered here too, and that is the whole point of this function
 * existing rather than a bare select. A teacher scrolling back to yesterday's
 * message still has the old buttons; tapping one must not deliver an answer that
 * has since been withdrawn.
 */
export async function findAnswer(db: Database, code: string): Promise<FaqAnswer | null> {
  const rows = await db
    .select(COLUMNS)
    .from(faqEntries)
    .where(and(eq(faqEntries.code, code), eq(faqEntries.active, true)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Every active answer in one topic, for scoring a typed question against it.
 *
 * One topic, never the whole bank. `BOT-SPEC.md:9.0` states this first because
 * it is the most surprising thing in the system, and the reason is precision
 * over recall: a visa question must never be answered out of the accommodation
 * bank. A teacher who types a question without choosing a topic is asked which
 * topic it belongs to and their question is remembered — that is what the router
 * does with `AwaitingQuestionTopic` — rather than scored against everything.
 */
export async function answersForScoring(
  db: Database,
  topicCode: string,
): Promise<readonly FaqAnswer[]> {
  return listTopicAnswers(db, topicCode);
}
