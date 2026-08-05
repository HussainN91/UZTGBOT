/**
 * Building and reading the hidden payload attached to an inline button.
 *
 * Telegram caps this at 64 *bytes*, not characters, and truncation is silent —
 * an over-long payload comes back mangled and routes the tap somewhere else, or
 * nowhere. Everything that builds callback data goes through here so there is
 * one place that measures it, and one place the suite has to test.
 *
 * The Apps Script version embedded the topic's display label ("Living in
 * Uzbekistan"). That tied the payload's size to human-readable text, so the
 * Russian and Uzbek translations already promised in the menu would have grown
 * every button by an unpredictable amount — in Cyrillic, at two bytes a
 * character. Codes are short, fixed-width and language independent, so
 * translating the interface is now a display change with no effect on routing.
 */
import { CALLBACK_DATA_MAX_BYTES } from '../config/constants.js';

const SEPARATOR = ':';

/** Every callback payload the bot emits, keyed by its wire prefix. */
export const CALLBACK = {
  /** A top-level menu action, e.g. MENU:FAQ */
  MENU: 'MENU',
  /** Open one FAQ topic, e.g. CAT:LIVING */
  TOPIC: 'CAT',
  /** Page through one topic's questions, e.g. PG:LIVING:2 */
  TOPIC_PAGE: 'PG',
  /** Send one approved answer, e.g. ANS:LIV-004 */
  ANSWER: 'ANS',
  /** "That did not answer my question", e.g. BAD:LIV-004 */
  ANSWER_UNHELPFUL: 'BAD',
  /**
   * "That answered it", e.g. OK:LIV-004.
   *
   * BOT-SPEC.md:589 requires the ✅/❌ pair as the content feedback loop. Only
   * the ❌ half existed, which meant the answer bank could only ever learn what
   * was failing, never what was working — so a badly-worded answer and a
   * well-used one looked identical in the record.
   */
  ANSWER_HELPFUL: 'OK',
  /** Choose the topic a new case is filed under, e.g. CASE:VISA */
  CASE_TOPIC: 'CASE',
  /** Choose which document is being uploaded, e.g. DOC:PASSPORT */
  DOC_TYPE: 'DOC',
  /**
   * Ask a free-text question against one topic, e.g. QT:VISA.
   *
   * BOT-SPEC.md:588. The recovery path for a teacher who types a question
   * without picking a topic first — which is the most natural thing they can do,
   * and previously had nowhere to go.
   */
  QUERY_TOPIC: 'QT',
  /**
   * "The region you hold for me is still right", e.g. ROK.
   *
   * No parts: the only thing it says is yes, and who said it is the chat the tap
   * arrived from. D21 &mdash; the teacher confirms, and only staff change.
   */
  REGION_CONFIRMED: 'ROK',
  /**
   * "I have moved", e.g. RMV.
   *
   * Also carries nothing, and that is the decision rather than an omission. A
   * payload naming the new region would make this a picker, and a menu of
   * regions is a menu of whose problem this becomes — one wrong tap routes an
   * emergency to the wrong region. It raises a flag; a manager decides.
   */
  REGION_MOVED: 'RMV',
  /**
   * "I have read the privacy notice", e.g. `PRIV:2026-07-30.1:7-180-3`.
   *
   * It carries the wording version **and the three periods the teacher was
   * shown**, because both can move between the notice being sent and the button
   * being tapped — a period is a settings row somebody can change while a
   * teacher is reading (R20). A payload that carried only the version would let
   * an acceptance be recorded for numbers the teacher never saw, which is the
   * one thing this record exists to prevent.
   *
   * The periods travel as one hyphen-joined field because `:` is the separator.
   * `PRIV:2026-07-30.1:7-180-3` is 26 bytes against a 64-byte limit; a test
   * measures it with real values rather than trusting the arithmetic here.
   */
  PRIVACY_ACCEPTED: 'PRIV',
  /**
   * "Yes, treat this case as urgent", e.g. `UC:SUPPORT-2026-00482`.
   *
   * **The first callback in this system that a staff member taps rather than a
   * teacher**, and the first whose payload names a case. Both are worth stating.
   *
   * The reference is carried rather than looked up because the button lives in a
   * coordinator's scrollback indefinitely and the message it sits under is not
   * re-read. It is not a permission: `routeCallback` resolves it through the
   * ordinary staff gate and `confirmUrgentRequest` re-validates the case's state
   * on every tap, so a payload replayed by somebody who was demoted last week
   * buys nothing.
   *
   * `UC:SUPPORT-2026-00482` is 25 bytes against the 64-byte limit. The longest
   * reference this system can build is `CONTRACT-2026-99999`, giving 22 — a test
   * measures it with real values rather than trusting the arithmetic here.
   */
  URGENT_CONFIRM: 'UC',
  /**
   * "That should not have been made urgent", e.g. `UN:VISA-2026-00311` — D8.
   *
   * The counterpart to `UC`, and it sits on the oversight message rather than on
   * the coordinator's. Support grants urgency and Program takes it back, which
   * mirrors `/assign`: overriding somebody else's decision about a case is
   * already a Program act in this system, so this reuses `case.assign` rather
   * than inventing a capability for one button.
   *
   * Re-validated on tap like everything else here, and it has one refusal the
   * others do not: a closed case is left alone, because lowering `importance`
   * changes how long a finished case is kept and the nightly retention pass could
   * then delete it.
   *
   * `UN:CONTRACT-2026-99999` is 22 bytes against the 64-byte limit, and that is
   * the longest reference this system can build. A test measures it with a real
   * value rather than trusting the arithmetic here.
   */
  URGENT_UNMARK: 'UN',
  /**
   * "Open this case", e.g. `CO:VISA-2026-00311` — Part 5G.
   *
   * Every list command printed plain text and no buttons, so reading a case
   * meant retyping a nineteen-character reference by hand out of a list. This is
   * the button under each row.
   *
   * **It is routed by synthesising `/case <reference>` and handing it to
   * `routeStaffCommand`**, rather than by a handler of its own. The button is
   * therefore not merely *as* authorized as the command — it **is** the command,
   * and it cannot acquire a different answer to "may this person see this case"
   * because there is no second place for that answer to be computed. The scope
   * check, the refusal wording, the silence for a chat with no staff row and the
   * `messages` row recording who read which case all come free and stay in step.
   *
   * `CO:CONTRACT-2026-99999` is 22 bytes against the 64-byte limit, and that is
   * the longest reference this system can build. A test measures it with a real
   * value rather than trusting the arithmetic here.
   */
  CASE_OPEN: 'CO',
  /**
   * One action on one case — `CA:<reference>[:<action>[:<value>]]`.
   *
   * The same three depths as `STAFF_MENU`, for the same reasons and by
   * deliberate copy:
   *
   * ```
   * CA:VISA-2026-00311           → the case, with its keyboard
   * CA:VISA-2026-00311:M         → which level of importance?
   * CA:VISA-2026-00311:M:Urgent  → do it
   * ```
   *
   * **The reference travels in the payload rather than in conversation state.**
   * A menu sits in a chat for ever, and one holding "whichever case we were
   * looking at" would act on a case chosen an hour ago. A self-contained payload
   * cannot.
   *
   * It is not a permission and carries none. Every acting tap is executed by
   * handing the equivalent typed command to the same dispatcher a typed command
   * goes through, so a payload replayed by somebody demoted last week buys
   * exactly nothing.
   *
   * `CA:CONTRACT-2026-99999:OWN:99999999999` is 38 bytes against the 64-byte
   * limit, and `CONTRACT-2026-99999` is the longest reference this system can
   * build. Tests measure all three shapes with real values.
   */
  CASE_ACTION: 'CA',
  /**
   * Staff management by button — Part 5H.3. `SM:<chat id>[:<action>[:<value>]]`.
   *
   * Three depths in one prefix, because they are one journey:
   *
   * ```
   * SM:991001              → what would you like to do with this person?
   * SM:991001:ROLE         → which rank?
   * SM:991001:ROLE:Lead    → do it
   * ```
   *
   * **The subject travels in the payload rather than in conversation state, and
   * that is the design decision of this part.** Conversation state is a
   * teacher-facing machine here — `AwaitingIdentifier`, `AwaitingCaseDetail` —
   * and there has never been a staff-facing one. Building it to hold "which
   * person are we talking about between two taps" would be the harder thing
   * solving the easier problem, and it would introduce something that can go
   * stale: a menu left for an hour would act on whoever was chosen an hour ago.
   * A self-contained payload cannot.
   *
   * It is not a permission and carries none. Every tap is re-authorised from the
   * database, and the acting taps are executed by handing the equivalent typed
   * command to the same dispatcher, so a payload replayed by somebody demoted
   * last week buys exactly nothing.
   *
   * `SM:991001:R:Qashqadaryo` is 24 bytes against the 64-byte limit. Region
   * names come from the spreadsheet rather than from this code, so unlike every
   * other payload here their length is not ours to guarantee — the region
   * keyboard skips any button that will not fit, the way the FAQ listing does.
   */
  STAFF_MENU: 'SM',
  /**
   * Adding a staff member — `SA[:<chat id>[:<rank>[:<queue>]]]`.
   *
   * The one flow in this system whose first step cannot be a button, because
   * the chat id is the single thing only the person adding knows. So the id is
   * typed once, into `AwaitingStaffId`, and travels in the payload from then on
   * — the rank and the queue are chosen, and each choice carries everything
   * decided before it. A menu left for an hour therefore cannot add whoever was
   * chosen an hour ago.
   *
   * Regions are deliberately not part of it. The row is created covering every
   * region, which is exactly what `/staff_add 991001 Support Visa` does today
   * with no regions given, and "Change regions" is on their row immediately
   * afterwards.
   *
   * Ranks and queues are constants in this repository, so unlike a region their
   * length is ours to guarantee. A test measures the longest with real values.
   */
  STAFF_ADD: 'SA',
  /**
   * A party's answer on an identity dispute, e.g. `DC:42:NotMine` — Feature A.
   *
   * **The claim travels; the party does not.** Who is answering is the chat the
   * tap arrived from, which cannot be forged — the same reasoning as `ROK` and
   * `RMV`, and here it is load-bearing rather than tidy: a payload that named its
   * own party would let either account answer on behalf of the other, in a
   * feature whose entire subject is two accounts disagreeing about who somebody
   * is.
   *
   * **It decides nothing.** Both parties may tap, both are recorded, and a System
   * administrator settles it afterwards. `recordClaim` refuses any chat that is
   * not on the dispute, which is the whole authorisation — there is no staff row
   * involved, because the people tapping this are teachers.
   *
   * `DC:42:NotMine` is 13 bytes against the 64-byte limit. A test measures the
   * worst case with a `bigserial` at `Number.MAX_SAFE_INTEGER` rather than
   * trusting the arithmetic here.
   */
  DISPUTE_CLAIM: 'DC',
  /**
   * "Send to system admin", e.g. `DE:42` — the reviewer's one button.
   *
   * A regional reviewer holds `dispute.review` and can do exactly two things with
   * a dispute: read it, and pass it on. There is deliberately no button here that
   * settles anything, because settling is `dispute.resolve` and floors at System.
   */
  DISPUTE_ESCALATE: 'DE',
  /**
   * "This chat is the teacher", e.g. `DR:42:991001` — System only.
   *
   * **It names the chat that KEEPS the identity, never one that loses it.** The
   * losing chats are derived from the party list at the moment of resolution, so
   * a dispute that has since acquired a third party cannot be half-settled by a
   * button built when there were two — and a button sitting in a scrollback for a
   * week is exactly how that would happen.
   */
  DISPUTE_RESOLVE: 'DR',
} as const;

export type CallbackPrefix = (typeof CALLBACK)[keyof typeof CALLBACK];

export class CallbackDataTooLongError extends Error {
  constructor(
    readonly data: string,
    readonly bytes: number,
  ) {
    super(
      `Callback data is ${bytes} bytes, over Telegram's ${CALLBACK_DATA_MAX_BYTES}-byte limit: ${JSON.stringify(data)}. ` +
        `Shorten the code rather than the limit — Telegram truncates silently and the button would route to the wrong place.`,
    );
    this.name = 'CallbackDataTooLongError';
  }
}

/** Byte length as Telegram counts it, not JavaScript's UTF-16 character count. */
export function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Build a payload from a prefix and its parts.
 *
 * Throws rather than truncating. An oversized payload is a programming error
 * that a test must catch, not something to paper over at runtime — the Apps
 * Script version got this right and the behaviour is deliberately preserved.
 */
export function encodeCallback(prefix: CallbackPrefix, ...parts: readonly string[]): string {
  for (const part of parts) {
    if (part.includes(SEPARATOR)) {
      throw new Error(
        `Callback part ${JSON.stringify(part)} contains "${SEPARATOR}", which is the field separator. ` +
          `Codes must not contain it or decoding splits in the wrong place.`,
      );
    }
  }
  const data = [prefix, ...parts].join(SEPARATOR);
  const bytes = byteLength(data);
  if (bytes > CALLBACK_DATA_MAX_BYTES) throw new CallbackDataTooLongError(data, bytes);
  return data;
}

/**
 * Why `part` could not travel in a payload under `prefix`, or null if it can.
 *
 * The same two rules `encodeCallback` enforces, asked as a question instead of
 * thrown as an error — and it exists for exactly one reason.
 *
 * `encodeCallback` throwing is right when the value comes from our own code: an
 * oversized payload is a programming error and a test should catch it. It is
 * quite wrong when the value comes from **the spreadsheet**. A FORMS row whose
 * TYPE holds a colon, or is long enough to overflow the 64-byte limit, would
 * throw while the forms list was being built — and one bad cell typed by one
 * person would take the whole list away from every teacher, with the failure
 * appearing nowhere near the sheet that caused it.
 *
 * So the parser asks first and rejects that row with its number, the way every
 * other bad cell in this system is handled. Both callers read the rules from
 * here rather than keeping a second copy of the limit.
 */
export function callbackPartProblem(prefix: CallbackPrefix, part: string): string | null {
  if (part.includes(SEPARATOR)) {
    return `it contains "${SEPARATOR}", which separates the fields of a button's payload`;
  }
  const bytes = byteLength([prefix, part].join(SEPARATOR));
  if (bytes > CALLBACK_DATA_MAX_BYTES) {
    return `it is too long — a button can carry ${CALLBACK_DATA_MAX_BYTES} bytes and this needs ${bytes}`;
  }
  return null;
}

export interface DecodedCallback {
  readonly prefix: string;
  readonly parts: readonly string[];
}

/**
 * Read an incoming payload.
 *
 * Anyone can hand-craft this — it arrives from the network, not from our own
 * keyboard — so nothing here trusts its shape. Callers match on `prefix` and
 * validate every part against a known list before acting on it.
 */
export function decodeCallback(data: string): DecodedCallback | null {
  if (typeof data !== 'string' || data.length === 0) return null;
  const [prefix, ...parts] = data.split(SEPARATOR);
  if (!prefix) return null;
  return { prefix, parts };
}

/** True when `data` is that action exactly, with no extra fields. */
export function isCallback(data: string, prefix: CallbackPrefix, ...parts: readonly string[]): boolean {
  const decoded = decodeCallback(data);
  if (!decoded || decoded.prefix !== prefix) return false;
  if (decoded.parts.length !== parts.length) return false;
  return parts.every((p, i) => decoded.parts[i] === p);
}
