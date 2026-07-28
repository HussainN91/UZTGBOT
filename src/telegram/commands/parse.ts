/**
 * Reading a staff command out of a line of text.
 *
 * No database, no Telegram, and no knowledge of who is allowed to do what. This
 * file answers "what did they type", and nothing else — the dispatcher decides
 * whether the sender may do it, and D9 requires that an unrecognised sender
 * falls through to ordinary text handling rather than being told the command
 * exists.
 */

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
