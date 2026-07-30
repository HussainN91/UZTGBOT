/**
 * Who an announcement goes to.
 *
 * Two audiences and no more: everybody, or one province. Pure — the *shape* is
 * decided here and the *name* is resolved against the database by the store,
 * because canonicalising a region is something `knownRegions` already does for
 * `/region` and `/staff_add`, and a second canonicalisation is how a province
 * ends up stored two ways.
 *
 * The stored form is what sits in `announcements.audience`, which the schema
 * already defaults to `'all'`. Anything this module renders must parse back, or
 * an announcement written today cannot be read tomorrow.
 */

export type Audience =
  | { readonly kind: 'all' }
  | { readonly kind: 'region'; readonly region: string };

const REGION_PREFIX = 'region:';

/**
 * Read an audience, or refuse.
 *
 * `null` rather than a fallback to `all`, and the reason is the whole of why
 * this is a separate function with its own tests: a misread audience is a
 * message sent to the wrong people, and there is no recalling 1,800 messages.
 * `everyone` looks like `all` to a person and is refused, because the command
 * can then say what the two audiences are instead of guessing which was meant.
 */
export function parseAudience(raw: string): Audience | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  if (trimmed.toLowerCase() === 'all') return { kind: 'all' };

  if (trimmed.toLowerCase().startsWith(REGION_PREFIX)) {
    const region = trimmed.slice(REGION_PREFIX.length).trim();
    if (region === '') return null;
    // The stored form separates on a colon, so a name containing one would not
    // survive the round trip. No Uzbek province has one.
    if (region.includes(':')) return null;
    return { kind: 'region', region };
  }

  return null;
}

/** The form written to `announcements.audience`. Must parse back unchanged. */
export function renderAudience(audience: Audience): string {
  return audience.kind === 'all' ? 'all' : `${REGION_PREFIX}${audience.region}`;
}

/**
 * The sentence shown to whoever is about to send.
 *
 * Read immediately before a broadcast, so it says who will actually receive it
 * rather than repeating a stored keyword. "all" is a value; "every teacher who
 * can use the bot" is a statement somebody can disagree with — and the words
 * "can use" are doing real work, because a revoked teacher and a teacher whose
 * roster row went are both excluded and neither is obvious from "all".
 */
export function describeAudience(audience: Audience): string {
  return audience.kind === 'all'
    ? 'every teacher who can use the bot'
    : `every teacher in ${audience.region} who can use the bot`;
}
