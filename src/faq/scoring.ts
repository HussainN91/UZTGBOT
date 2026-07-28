/**
 * Deciding whether a teacher gets an answer or a choice.
 *
 * Ported from `QAEngine.gs:194-292`. The rules are unchanged; only what sits
 * underneath them is, because the rows now come from a table rather than a
 * cached copy of a spreadsheet.
 *
 * Pure. No database, no network, no clock — which is why the judgement in here
 * can be tested exhaustively and cheaply, and why it is the first thing built.
 */
import {
  FAQ_CONFIDENT_SCORE,
  FAQ_MATCH_MIN_SCORE,
  FAQ_MAX_PICKER_BUTTONS,
} from '../config/constants.js';
import { normaliseText, tokenize } from './normalise.js';

/**
 * The minimum a row must carry to be scored and offered.
 *
 * Structural rather than the full `FaqRow`, so both the parsed sheet row and the
 * database row satisfy it without either importing the other.
 */
export interface ScorableFaqRow {
  readonly code: string;
  /** Orders ties, so the same question offers the same buttons every time. */
  readonly sheetRow: number;
  /** Already normalised — see `src/sheets/parse.ts:197`. Never normalised again here. */
  readonly keywords: readonly string[];
}

/**
 * A union rather than a nullable row, so a caller cannot accidentally treat a
 * low-confidence guess as an answer. Reading `.row` is only possible after
 * narrowing to `answer`.
 */
export type FaqMatch<T extends ScorableFaqRow = ScorableFaqRow> =
  | { readonly kind: 'answer'; readonly row: T }
  | { readonly kind: 'picker'; readonly rows: readonly T[]; readonly lowConfidence: boolean }
  | { readonly kind: 'none' };

/** A multi-word keyword found intact in the query. */
const PHRASE_SCORE = 2;
/** A single-word keyword equal to one of the query's words. */
const EXACT_SCORE = 2;
/** A query word that is a near-miss for the keyword. Evidence, but only just. */
const FUZZY_SCORE = 1;

/**
 * Typo tolerance scales with word length. Short words are excluded entirely:
 * at four characters an edit distance of one makes almost everything match
 * almost everything ("visa"/"visit"), which is the false confidence this whole
 * module exists to avoid.
 */
export function allowedTypos(word: string): number {
  if (word.length >= 8) return 2;
  if (word.length >= 5) return 1;
  return 0;
}

/**
 * Bounded Levenshtein: true when `a` and `b` are within `max` edits.
 *
 * Bails out on a length difference, and again on any row whose best cell already
 * exceeds the budget, so the full matrix only runs for genuine near-misses. This
 * is called for every keyword against every query word on every message.
 *
 * Every index below is provably within `0..b.length`, and both rows are exactly
 * that long, so the `?? OUT_OF_RANGE` arms are unreachable — they exist because
 * `noUncheckedIndexedAccess` cannot see the invariant. The sentinel is enormous
 * rather than zero deliberately: if the invariant ever did break, the distance
 * comes out too large and the pair is reported as *not* matching. A zero would
 * fail the other way and invent a confident match out of a bug.
 */
const OUT_OF_RANGE = Number.MAX_SAFE_INTEGER;

export function withinEditDistance(a: string, b: string, max: number): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > max) return false;

  let prev = new Int32Array(b.length + 1);
  let cur = new Int32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const deletion = (cur[j - 1] ?? OUT_OF_RANGE) + 1;
      const insertion = (prev[j] ?? OUT_OF_RANGE) + 1;
      const substitution = (prev[j - 1] ?? OUT_OF_RANGE) + cost;
      const best = Math.min(deletion, insertion, substitution);
      cur[j] = best;
      if (best < rowMin) rowMin = best;
    }
    // No cell in this row can still lead to a win.
    if (rowMin > max) return false;
    [prev, cur] = [cur, prev];
  }
  return (prev[b.length] ?? OUT_OF_RANGE) <= max;
}

/**
 * Score one row against a query.
 *
 * A row scoring only 1 has nothing but typo evidence behind it, and the
 * confidence floor is 2 — so it can be offered as a button but never sent as
 * the answer.
 */
export function scoreRow(
  row: ScorableFaqRow,
  queryNormalised: string,
  queryTokens: readonly string[],
): number {
  // Padded so a phrase only matches on word boundaries: without this, the
  // keyword "e visa" matches inside "revisawork".
  const paddedQuery = ` ${queryNormalised} `;

  let score = 0;
  for (const keyword of row.keywords) {
    if (keyword === '') continue;

    if (keyword.includes(' ')) {
      if (paddedQuery.includes(` ${keyword} `)) score += PHRASE_SCORE;
      continue;
    }

    let best = 0;
    for (const token of queryTokens) {
      if (token === keyword) {
        best = EXACT_SCORE;
        break;
      }
      // The tighter of the two budgets: a long keyword must not license sloppy
      // matching of a short query word, or the reverse.
      const tolerance = Math.min(allowedTypos(keyword), allowedTypos(token));
      if (tolerance > 0 && withinEditDistance(token, keyword, tolerance)) {
        best = Math.max(best, FUZZY_SCORE);
      }
    }
    score += best;
  }
  return score;
}

/** Ties keep the order the content owner arranged them in. */
function bySheetRowThenCode(a: ScorableFaqRow, b: ScorableFaqRow): number {
  return a.sheetRow - b.sheetRow || a.code.localeCompare(b.code);
}

/**
 * Choose what to do with a teacher's question.
 *
 * Returns `none` rather than the least-bad row. The caller decides what a miss
 * looks like — `QAEngine.gs:267` answered it by handing the picker every row in
 * the category, which is a decision about presentation, not about matching.
 */
export function selectAnswer<T extends ScorableFaqRow>(
  query: string,
  rows: readonly T[],
): FaqMatch<T> {
  const queryNormalised = normaliseText(query);
  if (queryNormalised === '') return { kind: 'none' };
  const queryTokens = tokenize(query);

  const scored = rows
    .map((row) => ({ row, score: scoreRow(row, queryNormalised, queryTokens) }))
    .filter((s) => s.score >= FAQ_MATCH_MIN_SCORE);

  if (scored.length === 0) return { kind: 'none' };

  const topScore = Math.max(...scored.map((s) => s.score));
  const top = scored
    .filter((s) => s.score === topScore)
    .map((s) => s.row)
    .sort(bySheetRowThenCode);

  const [first] = top;
  if (top.length === 1 && topScore >= FAQ_CONFIDENT_SCORE && first !== undefined) {
    return { kind: 'answer', row: first };
  }

  return {
    kind: 'picker',
    // Capped: a topic with forty tied rows would otherwise build a forty-button
    // keyboard, and past a handful a list has stopped being a choice.
    rows: top.slice(0, FAQ_MAX_PICKER_BUTTONS),
    lowConfidence: topScore < FAQ_CONFIDENT_SCORE,
  };
}
