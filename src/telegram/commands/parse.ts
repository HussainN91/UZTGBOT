/**
 * Reading a staff command out of a line of text.
 *
 * No database, no Telegram, and no knowledge of who is allowed to do what. This
 * file answers "what did they type", and nothing else — the dispatcher decides
 * whether the sender may do it, and D9 requires that an unrecognised sender
 * falls through to ordinary text handling rather than being told the command
 * exists.
 */
import { TIMEZONE } from '../../config/constants.js';

/**
 * The one rule that is easy to get wrong: the remainder is a phrase.
 *
 * `/cases Under review` filters by a status containing a space. Apps Script split
 * arguments on whitespace and then compared the first word, which made that
 * filter silently unmatchable (`AdminCommands.gs:501`) — the command worked,
 * returned nothing, and looked like an empty queue.
 */
export interface ParsedCommand {
  /** Lower-cased, with the leading slash and any `@BotName` removed. */
  readonly name: string;
  /** Everything after the command word, trimmed at the ends only. */
  readonly rest: string;
}

/**
 * A command word is letters, digits and underscores — what Telegram permits.
 *
 * Anchored at the start of the string so that "contract w/ school" is not read
 * as a command. That matters more here than it looks: under D9 a teacher
 * mid-case-detail whose text is mistaken for a command loses what they wrote.
 */
const COMMAND = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/;

export const parseCommand = (text: string): ParsedCommand | null => {
  const match = COMMAND.exec(text.trim());
  if (match === null) return null;

  return {
    // Lower-cased so /CASE and /case are one command; the arguments are left
    // exactly as typed, because a case reference is upper-case and a teacher's
    // name is not ours to alter.
    name: `/${match[1]!.toLowerCase()}`,
    rest: (match[2] ?? '').trim(),
  };
};

/**
 * The shape `allocateReference` produces: PREFIX-YEAR-NNNNN.
 *
 * Validated by shape rather than against the list of prefixes in
 * `CASE_REFERENCE_PREFIX`, because that list grows — stage 6 adds document
 * cases — and a parser that rejects a reference the allocator can produce is a
 * staff member unable to answer a case that exists. The database is what
 * decides whether a reference is real; this only decides whether the sender
 * typed a reference at all.
 */
const CASE_REFERENCE = /^[A-Z]+-\d{4}-\d{5}$/;

export const isCaseReference = (value: string): boolean => CASE_REFERENCE.test(value.toUpperCase());

export interface ReferenceAndRest {
  readonly reference: string;
  readonly rest: string;
}

/**
 * Split `VISA-2026-00001 the rest of the message` into its two parts.
 *
 * Returns `null` rather than guessing when the first word is not a reference.
 * `/reply` with a missing reference must fail loudly: the recoverable outcome is
 * a staff member being told to include one, and the unrecoverable outcome is a
 * teacher receiving an answer meant for somebody else.
 *
 * Internal spacing in the remainder is preserved. Staff paste text with
 * deliberate line breaks and alignment into `/reply`, and re-flowing somebody's
 * message on the way to a teacher is not this function's business.
 */
export const splitReference = (rest: string): ReferenceAndRest | null => {
  const trimmed = rest.trim();
  if (trimmed === '') return null;

  const boundary = trimmed.search(/\s/);
  const head = boundary === -1 ? trimmed : trimmed.slice(0, boundary);
  if (!isCaseReference(head)) return null;

  return {
    reference: head.toUpperCase(),
    rest: boundary === -1 ? '' : trimmed.slice(boundary).trim(),
  };
};

export interface ChatIdAndRest {
  readonly chatId: string;
  readonly rest: string;
}

/**
 * Split `995101 Samarkand` into a chat id and everything after it.
 *
 * Digits only, which is what Telegram issues and what the `chat_id ~ '^[0-9]+$'`
 * check on `conversation_states` enforces. Returns `null` rather than guessing,
 * for the same reason `splitReference` does: the recoverable outcome is a staff
 * member being told to include an id, and the unrecoverable one is a correction
 * landing on somebody else's account.
 */
export const splitChatId = (rest: string): ChatIdAndRest | null => {
  const trimmed = rest.trim();
  if (trimmed === '') return null;

  const boundary = trimmed.search(/\s/);
  const head = boundary === -1 ? trimmed : trimmed.slice(0, boundary);
  if (!/^\d+$/.test(head)) return null;

  return { chatId: head, rest: boundary === -1 ? '' : trimmed.slice(boundary).trim() };
};

// ---------------------------------------------------------------------------
// A promised date — `/due` (D23)
// ---------------------------------------------------------------------------

export type ParsedDate =
  | { readonly ok: true; readonly at: Date }
  /** The month could be either of two, so nothing is guessed. `15/08/2026`. */
  | { readonly ok: false; readonly why: 'ambiguous' }
  /** No date in it at all. */
  | { readonly ok: false; readonly why: 'unreadable' }
  /** Read cleanly and names a day that does not exist. `2026-02-31`. */
  | { readonly ok: false; readonly why: 'no-such-day' };

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const SPELT = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/;

/**
 * How far ahead of UTC the display zone is at a given instant.
 *
 * Computed rather than written down as `+5`. Uzbekistan has kept a fixed offset
 * since 1995 and there is no reason to expect that to change, but a hard-coded
 * number is a fact about the world stored in a file nobody would think to check,
 * and this costs one `Intl` call on a command nobody types twice a minute.
 */
function zoneOffsetMs(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(at);

  const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // en-GB renders midnight as hour 24 rather than 0, which would otherwise put
  // the offset a day out exactly once per day.
  const asUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour') % 24, part('minute'), part('second'));
  return asUtc - at.getTime();
}

/**
 * Read a date somebody typed, as the last moment of that day in Tashkent.
 *
 * **The end of the day, not the start.** "By the 15th" means the teacher has
 * been promised something by the time the 15th is over, and a date parsed as
 * midnight would put every promise five hours into the previous day for
 * everybody who reads it — and would make a case promised for today look
 * already broken.
 *
 * **Two forms, both of which name the month unambiguously**: `2026-08-15`, and
 * `15 Aug 2026` (or `15 August 2026`). `15/08/2026` is *refused*, not guessed.
 * Day-first and month-first are both in ordinary use, they disagree for every
 * day of the month up to the twelfth, and a date read the wrong way round is not
 * visibly wrong — it is simply a promise to a teacher on the wrong day. Refusing
 * costs one retype; guessing costs somebody an appointment.
 */
export function parseDueDate(value: string): ParsedDate {
  const text = value.trim();

  if (text.includes('/') || text.includes('.')) return { ok: false, why: 'ambiguous' };

  const iso = ISO.exec(text);
  const spelt = SPELT.exec(text);

  let year: number;
  let month: number;
  let day: number;

  if (iso !== null) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (spelt !== null) {
    const index = MONTHS.indexOf(spelt[2]!.slice(0, 3).toLowerCase());
    if (index === -1) return { ok: false, why: 'unreadable' };
    year = Number(spelt[3]);
    month = index + 1;
    day = Number(spelt[1]);
  } else {
    return { ok: false, why: 'unreadable' };
  }

  // `Date.UTC` rolls 31 February forward into March rather than refusing it, so
  // the only way to know the day exists is to build it and read it back.
  const wall = Date.UTC(year, month - 1, day, 23, 59, 59);
  const built = new Date(wall);
  if (built.getUTCFullYear() !== year || built.getUTCMonth() !== month - 1 || built.getUTCDate() !== day) {
    return { ok: false, why: 'no-such-day' };
  }

  return { ok: true, at: new Date(wall - zoneOffsetMs(built)) };
}
