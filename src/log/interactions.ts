/**
 * Writes one row per interaction, redacting by conversation state.
 *
 * The redaction is inside this function, not a parameter, because a parameter is
 * a thing a caller forgets. When a teacher is in AwaitingIdentifier their
 * message IS their email address, and BOT-SPEC.md:255 records that logging it
 * verbatim was found and fixed once already — the webhook logged the raw value a
 * few lines before the verification code redacted it, which made the redaction
 * decorative.
 *
 * Never throws. The Apps Script version took a lock to append a log row and gave
 * up after three seconds, discarding entries exactly when the system was busiest
 * — which is when you most want to read them back.
 */
import { sql } from 'drizzle-orm';
import type { ConversationState } from '../conversation/state.js';
import type { Database } from '../db/index.js';
import { log } from '../log.js';

/** This column is an audit trail, not a transcript (BOT-SPEC.md:251). */
const MAX_DETAIL_LENGTH = 500;

/**
 * Deliberately loose. Its job is to catch anything a teacher might plausibly
 * type as an address so it can be masked, not to decide whether an address is
 * deliverable — a false positive costs a slightly mangled log line, a false
 * negative writes personal data into a table with no agreed retention period.
 */
const EMAIL_PATTERN = /[^\s@]+@[^\s@.]+\.[^\s@]+/g;

/** `nodira@school.uz` becomes `n***@school.uz`: enough to match a support call, not enough to reuse. */
function maskAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return '(address withheld)';
  return `${address.slice(0, 1)}***${address.slice(at)}`;
}

/**
 * Decide what may be written for one interaction.
 *
 * Pure, and exported, so every branch can be tested without a database. It is
 * still not optional: `logInteraction` calls it, and nothing else writes to this
 * table.
 */
export function redactDetail(detail: string, state: ConversationState | null): string {
  if (detail === '') return '';

  switch (state?.kind) {
    case 'AwaitingIdentifier': {
      const match = detail.match(EMAIL_PATTERN);
      const address = match?.[0];
      // Not an address, but typed into the one prompt whose whole purpose is
      // collecting personal data. It does not earn a free pass by failing to
      // look like an email.
      if (address === undefined) return `(identifier withheld — ${detail.length} characters)`;
      return maskAddress(address);
    }
    case 'AwaitingCaseDetail':
    case 'AwaitingUrgentDetail':
      return `(case detail withheld — ${detail.length} characters)`;
    case 'AwaitingUrgentCode':
      return '(urgent code withheld)';
    default:
      break;
  }

  /**
   * A command is logged as its name and first argument. The rest is dropped.
   *
   * Staff have no conversation state, so without this rule the default branch
   * below applies and `/note VISA-2026-00001 <the internal note>` and
   * `/reply VISA-2026-00001 <the message to the teacher>` would be written into
   * `messages` almost verbatim — internal case content copied into a table with
   * a different retention story from the one it belongs to.
   *
   * The rule is on the leading slash rather than on a list of staff commands,
   * because a list is a thing somebody forgets to extend. Stage 5 adds
   * `/announce ALL <message to 1,800 teachers>` and stage 6 adds document
   * commands; the prefix covers them the day they are written. `/start`,
   * `/privacy` and `/help` carry no arguments and so are logged exactly as they
   * are today.
   *
   * It sits after the switch deliberately. A teacher part-way through describing
   * a case can type something beginning with a slash — under the router's
   * fall-through that is still their case detail, and the stricter redaction
   * must win.
   *
   * The first argument is kept because it is what makes the row worth having: it
   * is the case reference, and "who touched which case, and when" is the
   * question this table gets asked. It is still scrubbed for addresses, since
   * nothing guarantees an argument is a reference.
   */
  const trimmed = detail.trim();
  if (trimmed.startsWith('/')) {
    const [word, firstArgument] = trimmed.split(/\s+/);
    const kept = firstArgument === undefined ? word! : `${word!} ${firstArgument}`;
    return kept.replace(EMAIL_PATTERN, maskAddress);
  }

  /**
   * No state, or a state that carries nothing sensitive.
   *
   * Addresses are still scrubbed. A teacher whose sign-in state expired and who
   * then types their address would otherwise be logged verbatim — the original
   * leak, arriving by a different route. Everything else is kept, because an
   * unanswered question is the most valuable content signal there is
   * (QAEngine.gs:262) and blanket redaction would destroy it.
   */
  const scrubbed = detail.replace(EMAIL_PATTERN, maskAddress);
  return scrubbed.length > MAX_DETAIL_LENGTH ? `${scrubbed.slice(0, MAX_DETAIL_LENGTH - 1)}…` : scrubbed;
}

/**
 * Record one interaction.
 *
 * Never throws, and never rolls anything back: this is called from inside the
 * handler's transaction, and a failure to write a log row must not undo a case
 * a teacher has just filed. The row is best-effort; the case is not.
 */
export async function logInteraction(
  db: Database,
  chatId: string,
  action: string,
  detail: string,
  state: ConversationState | null,
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO messages (chat_id, action, detail)
      VALUES (${chatId}, ${action}, ${redactDetail(detail, state)})
    `);
  } catch (err) {
    log.error({ err, chatId, action }, 'could not write an interaction log row');
  }
}
