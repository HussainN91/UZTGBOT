/**
 * Reading the document forms the spreadsheet publishes.
 *
 * D24: documents stay in Google Forms and the bot never accepts, holds or stores
 * a file. This module is the whole of the bot's side of that — it hands out
 * links, and nothing here writes anything. `form_links` is owned by the sync,
 * exactly as `faq_entries` and `roster_entries` are.
 */
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { formLinks } from '../db/schema.js';

export interface FormLink {
  readonly type: string;
  readonly buttonText: string;
  readonly url: string;
}

/**
 * A form whose responses can actually be read back.
 *
 * Separate from `FormLink` because the two are used by opposite halves of the
 * stage and only one of them requires the tab. A form with no `responsesTab` is
 * perfectly usable by a teacher (D39) and simply invisible to the response sync.
 */
export interface FormWithResponses extends FormLink {
  readonly responsesTab: string;
}

/**
 * The forms a teacher may be shown, in the order the sheet arranges them.
 *
 * Ordered by `sheetRow` for the same reason the FAQ is: staff arrange the sheet
 * deliberately, and SQL without an ORDER BY returns rows arbitrarily. `type` is
 * the tie-break so the order is total — two rows can briefly share a sheet row
 * while a sync is mid-flight, and a list that reorders itself between taps is
 * the paging fault `faq_entries` already documents.
 */
export async function activeForms(db: Database): Promise<FormLink[]> {
  const rows = await db
    .select({ type: formLinks.type, buttonText: formLinks.buttonText, url: formLinks.url })
    .from(formLinks)
    .where(eq(formLinks.active, true))
    .orderBy(asc(formLinks.sheetRow), asc(formLinks.type));
  return rows;
}

/**
 * One form, by the code a button payload carries.
 *
 * Re-read at the moment of the tap rather than trusted from the payload, and it
 * checks `active` again. A teacher can tap a button in scrollback long after the
 * form was withdrawn, and "the message is still on their screen" is not a reason
 * to send them to a form staff have switched off.
 */
export async function activeFormByType(db: Database, type: string): Promise<FormLink | null> {
  const rows = await db
    .select({ type: formLinks.type, buttonText: formLinks.buttonText, url: formLinks.url })
    .from(formLinks)
    .where(and(eq(formLinks.type, type), eq(formLinks.active, true)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The forms whose responses the bot can read.
 *
 * Inactive forms are included deliberately, and this is the one place the active
 * flag is ignored. A form switched off this morning may still have submissions
 * from last night that nobody has filed yet, and dropping them would lose a
 * teacher's documents silently — which is the failure this whole stage exists to
 * prevent.
 */
export async function formsWithResponses(db: Database): Promise<FormWithResponses[]> {
  const rows = await db
    .select({
      type: formLinks.type,
      buttonText: formLinks.buttonText,
      url: formLinks.url,
      responsesTab: formLinks.responsesTab,
    })
    .from(formLinks)
    .where(isNotNull(formLinks.responsesTab))
    .orderBy(asc(formLinks.sheetRow), asc(formLinks.type));
  return rows.filter((r): r is FormWithResponses => r.responsesTab !== null);
}
