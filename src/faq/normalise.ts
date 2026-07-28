/**
 * The one definition of "the same text" in this system.
 *
 * Both sides of every FAQ comparison run through this. In the Apps Script
 * version the teacher's query was normalised but stored keywords were only
 * lowercased, so any keyword containing punctuation was compared against a token
 * stream that could never contain it: `e-visa` was permanently unmatchable and
 * nothing anywhere reported it. Splitting normalisation across two places is
 * what caused that, so there is exactly one place now.
 *
 * Unicode-aware: Uzbek and Russian answers are already promised in the menu, and
 * a Latin-only character class would strip Cyrillic entirely — turning every
 * translated keyword into an empty string.
 */
const PUNCTUATION = /[^\p{L}\p{N}\s]+/gu;

export function normaliseText(value: string): string {
  return value.toLowerCase().replace(PUNCTUATION, ' ').replace(/\s+/g, ' ').trim();
}

/** The words a query or a keyword phrase is made of, in order. */
export function tokenize(value: string): string[] {
  const normalised = normaliseText(value);
  return normalised === '' ? [] : normalised.split(' ');
}
