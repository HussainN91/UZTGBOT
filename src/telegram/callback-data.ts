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
  /** Choose the topic a new case is filed under, e.g. CASE:VISA */
  CASE_TOPIC: 'CASE',
  /** Choose which document is being uploaded, e.g. DOC:PASSPORT */
  DOC_TYPE: 'DOC',
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
