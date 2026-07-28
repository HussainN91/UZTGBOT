import { describe, expect, it } from 'vitest';
import {
  HeaderMismatchError,
  normaliseIdentifier,
  parseActive,
  parseFaqTab,
  parseRosterTab,
} from './parse.js';

const FAQ_HEADER = [
  'CODE',
  'CATEGORY',
  'BUTTON_TEXT',
  'KEYWORDS',
  'OFFICIAL_ANSWER',
  'LANGUAGE',
  'ACTIVE',
  'LAST_APPROVED_BY',
  'LAST_APPROVED_DATE',
];

const faqRow = (over: Partial<Record<string, string>> = {}): string[] => [
  over['CODE'] ?? 'SAL-001',
  over['CATEGORY'] ?? 'Salary and Payment',
  over['BUTTON_TEXT'] ?? 'Is salary gross or net?',
  over['KEYWORDS'] ?? 'gross,net,after tax',
  over['OFFICIAL_ANSWER'] ?? 'Salary offers are normally gross.',
  over['LANGUAGE'] ?? 'EN',
  over['ACTIVE'] ?? 'TRUE',
  over['LAST_APPROVED_BY'] ?? '',
  over['LAST_APPROVED_DATE'] ?? '',
];

describe('a renamed or missing column stops the whole sync', () => {
  /**
   * "Renaming a spreadsheet column silently breaks a feature" is on the concerns
   * list. Rejecting row by row would be wrong here: the structure changed, so
   * carrying on would write wrong values into every row.
   */
  it('refuses the FAQ tab when a required column is renamed', () => {
    const renamed = FAQ_HEADER.map((h) => (h === 'OFFICIAL_ANSWER' ? 'ANSWER' : h));
    expect(() => parseFaqTab([renamed, faqRow()])).toThrow(HeaderMismatchError);
  });

  it('names the missing column and says nothing was synced', () => {
    const renamed = FAQ_HEADER.map((h) => (h === 'CATEGORY' ? 'TOPIC' : h));
    expect(() => parseFaqTab([renamed, faqRow()])).toThrow(/CATEGORY[\s\S]*Nothing was synced/);
  });

  it('refuses an empty tab rather than treating it as zero rows', () => {
    expect(() => parseFaqTab([])).toThrow(HeaderMismatchError);
  });

  it('tolerates header case and surrounding spaces', () => {
    const messy = FAQ_HEADER.map((h) => ` ${h.toLowerCase()} `);
    expect(parseFaqTab([messy, faqRow()]).rows).toHaveLength(1);
  });

  it('ignores extra columns nobody asked about', () => {
    const extra = [...FAQ_HEADER, 'INTERNAL_NOTES'];
    expect(parseFaqTab([extra, [...faqRow(), 'ignore me']]).rows).toHaveLength(1);
  });
});

describe('a bad value rejects one row and reports it', () => {
  /**
   * The failure the plan singles out: one misspelled topic used to make that
   * answer permanently unreachable, with no error anywhere.
   */
  it('rejects a misspelled topic instead of storing an unreachable answer', () => {
    const result = parseFaqTab([FAQ_HEADER, faqRow({ CATEGORY: 'Salary and Payments' })]);
    expect(result.rows).toHaveLength(0);
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]?.reason).toMatch(/not a known topic/);
  });

  it('names the row number so it can actually be found in the sheet', () => {
    const result = parseFaqTab([FAQ_HEADER, faqRow(), faqRow({ CODE: 'X-1', CATEGORY: 'Nonsense' })]);
    // Header is row 1, first entry row 2, so the bad row is row 3.
    expect(result.rejections[0]?.row).toBe(3);
  });

  it('lists the valid topics so the fix is obvious', () => {
    const result = parseFaqTab([FAQ_HEADER, faqRow({ CATEGORY: 'Nonsense' })]);
    expect(result.rejections[0]?.reason).toMatch(/Living in Uzbekistan/);
  });

  it('keeps the good rows when one row is bad', () => {
    const result = parseFaqTab([
      FAQ_HEADER,
      faqRow({ CODE: 'SAL-001' }),
      faqRow({ CODE: 'SAL-002', CATEGORY: 'Typo Topic' }),
      faqRow({ CODE: 'SAL-003' }),
    ]);
    expect(result.rows.map((r) => r.code)).toEqual(['SAL-001', 'SAL-003']);
    expect(result.rejections).toHaveLength(1);
  });

  it('rejects a duplicate code rather than letting the later row overwrite the earlier', () => {
    const result = parseFaqTab([FAQ_HEADER, faqRow({ CODE: 'SAL-001' }), faqRow({ CODE: 'SAL-001' })]);
    expect(result.rows).toHaveLength(1);
    expect(result.rejections[0]?.reason).toMatch(/more than once/);
  });

  it('rejects an empty answer, which would show a teacher a blank reply', () => {
    const result = parseFaqTab([FAQ_HEADER, faqRow({ OFFICIAL_ANSWER: '' })]);
    expect(result.rejections[0]?.reason).toMatch(/empty OFFICIAL_ANSWER/);
  });

  it('skips a blank spacer line without calling it an error', () => {
    const result = parseFaqTab([FAQ_HEADER, faqRow(), ['', '', '', '', '', '', '', '', '']]);
    expect(result.rows).toHaveLength(1);
    expect(result.rejections).toHaveLength(0);
  });
});

describe('FAQ values are normalised once, here, rather than on every query', () => {
  it('resolves the display label to the topic code that travels in buttons', () => {
    const result = parseFaqTab([FAQ_HEADER, faqRow({ CATEGORY: 'Living in Uzbekistan' })]);
    expect(result.rows[0]?.topicCode).toBe('LIVING');
  });

  it('splits and lowercases keywords, dropping empties from trailing commas', () => {
    const result = parseFaqTab([FAQ_HEADER, faqRow({ KEYWORDS: 'Gross, NET ,,after tax,' })]);
    expect(result.rows[0]?.keywords).toEqual(['gross', 'net', 'after tax']);
  });

  it('records the spreadsheet row so listings have a stable order', () => {
    // The sheet had an implicit order that pagination relied on. SQL without an
    // ORDER BY returns rows arbitrarily, so paging a topic could repeat and skip
    // answers between taps. Ordering by code instead would reorder the bank
    // against the content owner's intent — they arrange the sheet deliberately.
    const result = parseFaqTab([FAQ_HEADER, faqRow({ CODE: 'A-1' }), faqRow({ CODE: 'A-2' })]);
    expect(result.rows.map((r) => r.sheetRow)).toEqual([2, 3]);
  });

  it('keeps the sheet row of surviving entries when a row above them is rejected', () => {
    const result = parseFaqTab([
      FAQ_HEADER,
      faqRow({ CODE: 'A-1', CATEGORY: 'Nonsense Topic' }),
      faqRow({ CODE: 'A-2' }),
    ]);
    expect(result.rows[0]?.sheetRow).toBe(3);
  });

  it('normalises keyword punctuation the same way a query is normalised', () => {
    // The scorer strips punctuation from what a teacher types, so a stored
    // keyword that keeps its hyphen is compared against a token stream that can
    // never contain it. Every keyword with - / ' or ? was silently dead.
    const result = parseFaqTab([FAQ_HEADER, faqRow({ KEYWORDS: "e-visa, teacher's contract, work/permit" })]);
    expect(result.rows[0]?.keywords).toEqual(['e visa', 'teacher s contract', 'work permit']);
  });

  it('defaults a blank language to EN', () => {
    expect(parseFaqTab([FAQ_HEADER, faqRow({ LANGUAGE: '' })]).rows[0]?.language).toBe('EN');
  });
});

describe('ACTIVE accepts what an operator will actually type', () => {
  it.each(['TRUE', 'true', 'Yes', 'Y', '1', ''])('treats %j as active', (value) => {
    expect(parseActive(value)).toBe(true);
  });

  it.each(['FALSE', 'false', 'No', 'N', '0'])('treats %j as inactive', (value) => {
    expect(parseActive(value)).toBe(false);
  });

  it('treats blank as active so adding the column cannot switch every row off', () => {
    expect(parseActive('')).toBe(true);
  });
});

describe('roster parsing', () => {
  const ROSTER_HEADER = ['IDENTIFIER', 'NAME', 'REGION'];

  it('normalises the identifier so a pasted trailing space cannot block sign-in', () => {
    const result = parseRosterTab([ROSTER_HEADER, [' A.Karimov@Example.com ', 'A. Karimov', 'Tashkent']]);
    expect(result.rows[0]?.identifier).toBe('a.karimov@example.com');
  });

  it('rejects a duplicate identifier — two teachers cannot share one identity', () => {
    const result = parseRosterTab([
      ROSTER_HEADER,
      ['a@example.com', 'First', 'Tashkent'],
      ['A@EXAMPLE.COM', 'Second', 'Samarkand'],
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rejections[0]?.reason).toMatch(/more than once/);
  });

  it('rejects a row nobody could ever sign in with', () => {
    const result = parseRosterTab([ROSTER_HEADER, ['', 'No Identifier', 'Tashkent']]);
    expect(result.rejections[0]?.reason).toMatch(/nobody could sign in/);
  });

  it('accepts a missing region as unknown rather than rejecting the teacher', () => {
    const result = parseRosterTab([ROSTER_HEADER, ['a@example.com', 'A Teacher', '']]);
    expect(result.rows[0]?.region).toBeNull();
  });

  it('tolerates a short row where trailing cells are simply absent', () => {
    // The Sheets API stops a row early rather than padding it.
    const result = parseRosterTab([ROSTER_HEADER, ['a@example.com', 'A Teacher']]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.region).toBeNull();
  });

  it('requires the identifier column to exist', () => {
    expect(() => parseRosterTab([['EMAIL', 'NAME'], ['a@example.com', 'A']])).toThrow(HeaderMismatchError);
  });
});

describe('normaliseIdentifier', () => {
  it('is idempotent', () => {
    const once = normaliseIdentifier('  Foo@Bar.COM ');
    expect(normaliseIdentifier(once)).toBe(once);
  });
});
