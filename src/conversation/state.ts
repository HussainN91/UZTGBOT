/**
 * Where a teacher is in a conversation.
 *
 * A discriminated union with a typed payload per state, exported from one place.
 * `conversation_states.state` is free text in the database on purpose — so
 * adding a state needs no migration — but an untyped string here would let a
 * later stage invent a sixth value that this router silently falls through to
 * "I didn't understand that".
 *
 * Nothing sweeps this table (D4). Expiry is a stored deadline enforced on every
 * read, never by a background job: if it were swept, stage 3 would be quietly
 * broken until stage 5 shipped, and an abandoned conversation from two days ago
 * would capture a teacher's next FAQ question as a support case.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  CASE_CATEGORY,
  CONVERSATION_TTL_MINUTES,
  type CaseCategory,
  URGENT_DETAIL_TTL_HOURS,
} from '../config/constants.js';
import type { Database } from '../db/index.js';

const CASE_CATEGORY_VALUES = Object.values(CASE_CATEGORY) as [CaseCategory, ...CaseCategory[]];

const attempts = z.number().int().min(0);

/**
 * Parsed rather than cast. The row may have been written by a newer build, or by
 * an older one whose payload shape differed — both are ordinary consequences of
 * forward-only migrations and code rollbacks, and neither may throw.
 */
const conversationStateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('AwaitingIdentifier'),
    attempts,
    /** What the teacher was trying to do before being asked to sign in. */
    resumeAction: z.string().optional(),
  }),
  /**
   * Shown the privacy notice again, and not yet accepted — D32.
   *
   * It exists only to carry `resumeAction`, which is why it reuses that field
   * name and is resumed by the same `resumeAfterSignIn` the sign-in gate uses. A
   * second resume mechanism beside the first is how the two drift.
   *
   * Nothing reads this state in the router's text branch: a teacher who types
   * instead of tapping falls through to ordinary handling, which is correct.
   * They are gated again the moment they tap one of the three actions, so the
   * state going stale costs nothing.
   */
  z.object({
    kind: z.literal('AwaitingPrivacyAcceptance'),
    resumeAction: z.string().optional(),
  }),
  z.object({ kind: z.literal('AwaitingCaseTopic') }),
  /**
   * A question typed before any topic was chosen.
   *
   * The question is held here so that tapping a topic answers it without the
   * teacher retyping. `BOT-SPEC.md:9.0` requires the scoping — a visa question
   * must never be answered from the accommodation bank — and this is what stops
   * the scoping being a dead end, which is what it was before the question was
   * remembered.
   */
  z.object({ kind: z.literal('AwaitingQuestionTopic'), query: z.string() }),
  z.object({
    kind: z.literal('AwaitingCaseDetail'),
    category: z.enum(CASE_CATEGORY_VALUES),
    attempts,
  }),
  z.object({ kind: z.literal('AwaitingUrgentCode'), attempts }),
  z.object({
    kind: z.literal('AwaitingUrgentDetail'),
    /** The code already spent. Recorded so a restart mid-flow can still file the case. */
    codeAccepted: z.string(),
    attempts,
  }),
]);

export type ConversationState = z.infer<typeof conversationStateSchema>;
export type ConversationStateKind = ConversationState['kind'];

/**
 * How long this state may sit unanswered.
 *
 * Chosen by the state rather than passed in, because the one state that needs a
 * different answer is the one where getting it wrong costs a teacher their
 * single-use code — and a parameter is a thing a caller forgets.
 */
function ttlMinutesFor(state: ConversationState): number {
  return state.kind === 'AwaitingUrgentDetail'
    ? URGENT_DETAIL_TTL_HOURS * 60
    : CONVERSATION_TTL_MINUTES;
}

/**
 * Read the teacher's current state, or null if there isn't one.
 *
 * "Isn't one" covers four cases deliberately: no row, an expired row, a state
 * this build does not know, and a payload that no longer matches its state. All
 * four mean the same thing to the router — start again from the main menu —
 * and none of them may throw, because throwing here breaks every subsequent
 * message rather than just this one.
 */
export async function loadState(db: Database, chatId: string): Promise<ConversationState | null> {
  const result = await db.execute<{ state: string; payload: unknown }>(sql`
    SELECT state, payload
    FROM conversation_states
    WHERE chat_id = ${chatId}
      AND (expires_at IS NULL OR expires_at > now())
  `);

  const row = result.rows[0];
  if (row === undefined) return null;

  const payload = typeof row.payload === 'object' && row.payload !== null ? row.payload : {};
  const parsed = conversationStateSchema.safeParse({ ...payload, kind: row.state });
  return parsed.success ? parsed.data : null;
}

/**
 * Write the teacher's state, replacing whatever was there.
 *
 * One row per chat, so a teacher can only ever be in one place. The expiry is
 * computed here from the state itself and is never the caller's business.
 */
export async function saveState(
  db: Database,
  chatId: string,
  state: ConversationState,
): Promise<void> {
  const { kind, ...payload } = state;
  await db.execute(sql`
    INSERT INTO conversation_states (chat_id, state, payload, updated_at, expires_at)
    VALUES (
      ${chatId},
      ${kind},
      ${JSON.stringify(payload)}::jsonb,
      now(),
      now() + make_interval(mins => ${ttlMinutesFor(state)})
    )
    ON CONFLICT (chat_id) DO UPDATE SET
      state = excluded.state,
      payload = excluded.payload,
      updated_at = excluded.updated_at,
      expires_at = excluded.expires_at
  `);
}

/** Forget where the teacher was — after filing a case, or on returning to the menu. */
export async function clearState(db: Database, chatId: string): Promise<void> {
  await db.execute(sql`DELETE FROM conversation_states WHERE chat_id = ${chatId}`);
}
