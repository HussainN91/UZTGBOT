import { describe, expect, it } from 'vitest';
import { describeAudience, parseAudience, renderAudience } from './audience.js';

describe('parseAudience', () => {
  it('reads the two audiences there are', () => {
    expect(parseAudience('all')).toEqual({ kind: 'all' });
    expect(parseAudience('region:Bukhara')).toEqual({ kind: 'region', region: 'Bukhara' });
  });

  it('is forgiving about spacing and case in the keyword, and never about the region', () => {
    /**
     * `all` is a word this module owns, so it can be typed however somebody
     * types it. The region is a value the *database* owns, and normalising its
     * spelling here would put a second canonicalisation beside the one
     * `knownRegions` already performs — which is how a region ends up stored
     * two ways. This keeps what was typed and hands it on.
     */
    expect(parseAudience('  ALL ')).toEqual({ kind: 'all' });
    expect(parseAudience('Region: Bukhara')).toEqual({ kind: 'region', region: 'Bukhara' });
    expect(parseAudience('region:bukhara')).toEqual({ kind: 'region', region: 'bukhara' });
  });

  it('refuses anything it does not recognise rather than guessing', () => {
    // A misread audience is a message sent to the wrong people, and there is no
    // recalling 1,800 messages. `everyone` looks like `all` and is refused.
    for (const raw of ['', '   ', 'everyone', 'region', 'region:', 'region:   ', 'all teachers']) {
      expect(parseAudience(raw)).toBeNull();
    }
  });

  it('refuses a region containing the separator, which cannot round-trip', () => {
    // The stored form is `region:<name>`, so a name with a colon in it would
    // parse back as something else. No Uzbek region has one; a value that
    // does is a paste accident.
    expect(parseAudience('region:Bukhara:2')).toBeNull();
  });
});

describe('renderAudience', () => {
  it('round-trips through the stored form', () => {
    for (const audience of [
      { kind: 'all' } as const,
      { kind: 'region', region: 'Bukhara' } as const,
    ]) {
      expect(parseAudience(renderAudience(audience))).toEqual(audience);
    }
  });

  it('stores what the database column already holds for everything sent so far', () => {
    // `announcements.audience` defaults to 'all' in the schema. The stored form
    // has to be that string, or every existing default is unparseable.
    expect(renderAudience({ kind: 'all' })).toBe('all');
  });
});

describe('describeAudience', () => {
  it('says who will receive it in words somebody about to send can check', () => {
    // This is read immediately before 1,800 messages go out. "all" is a stored
    // value; "every teacher who can use the bot" is a sentence somebody can
    // disagree with.
    expect(describeAudience({ kind: 'all' })).toContain('every teacher');
    expect(describeAudience({ kind: 'region', region: 'Bukhara' })).toContain('Bukhara');
  });
});
