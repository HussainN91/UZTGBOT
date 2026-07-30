import { describe, expect, it } from 'vitest';
import {
  EmailColumnError,
  HeaderMismatchError,
  findEmailColumn,
  normaliseIdentifier,
  parseActive,
  parseFaqTab,
  parseFormsTab,
  parseResponsesTab,
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

describe('forms parsing', () => {
  const FORMS_HEADER = ['TYPE', 'BUTTON_TEXT', 'URL', 'RESPONSES_TAB', 'ACTIVE'];
  const FORM = 'https://docs.google.com/forms/d/e/1FAIpQL/viewform';

  const formRow = (over: Partial<Record<string, string>> = {}): string[] => [
    over['TYPE'] ?? 'PASSPORT',
    over['BUTTON_TEXT'] ?? '🛂 Passport copy',
    over['URL'] ?? FORM,
    over['RESPONSES_TAB'] ?? 'PASSPORT_RESPONSES',
    over['ACTIVE'] ?? 'TRUE',
  ];

  it('reads a well-formed row', () => {
    const result = parseFormsTab([FORMS_HEADER, formRow()]);
    expect(result.rejections).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      type: 'PASSPORT',
      buttonText: '🛂 Passport copy',
      url: FORM,
      responsesTab: 'PASSPORT_RESPONSES',
      active: true,
    });
  });

  it('records the spreadsheet row so the order staff arranged is the order teachers see', () => {
    const result = parseFormsTab([FORMS_HEADER, formRow(), formRow({ TYPE: 'VISA' })]);
    expect(result.rows.map((r) => r.sheetRow)).toEqual([2, 3]);
  });

  /**
   * D39. A form whose responses nobody has linked yet must still reach teachers
   * — they can submit, the bot simply cannot read the answers back. Rejecting
   * the row would mean a form cannot be published until the plumbing is done.
   */
  it('accepts a row with no responses tab rather than withholding the form', () => {
    const result = parseFormsTab([FORMS_HEADER, formRow({ RESPONSES_TAB: '' })]);
    expect(result.rejections).toEqual([]);
    expect(result.rows[0]?.responsesTab).toBeNull();
  });

  it('does not require the RESPONSES_TAB column to exist at all', () => {
    const result = parseFormsTab([
      ['TYPE', 'BUTTON_TEXT', 'URL'],
      ['PASSPORT', 'Passport copy', FORM],
    ]);
    expect(result.rows[0]?.responsesTab).toBeNull();
  });

  it('requires the URL column to exist', () => {
    expect(() => parseFormsTab([['TYPE', 'BUTTON_TEXT'], ['PASSPORT', 'Passport']])).toThrow(
      HeaderMismatchError,
    );
  });

  it('rejects a duplicate type rather than letting the later row overwrite the earlier', () => {
    const result = parseFormsTab([FORMS_HEADER, formRow(), formRow({ BUTTON_TEXT: 'Different' })]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.buttonText).toBe('🛂 Passport copy');
    expect(result.rejections[0]?.reason).toMatch(/more than once/);
  });

  it('rejects a row whose button would go nowhere', () => {
    const result = parseFormsTab([FORMS_HEADER, formRow({ URL: '' })]);
    expect(result.rows).toEqual([]);
    expect(result.rejections[0]?.reason).toMatch(/empty URL/);
  });

  it('skips a blank spacer line without calling it an error', () => {
    const result = parseFormsTab([FORMS_HEADER, ['', '', '', '', ''], formRow()]);
    expect(result.rejections).toEqual([]);
    expect(result.rows).toHaveLength(1);
  });

  it('treats blank ACTIVE as active so adding the column cannot switch every form off', () => {
    const result = parseFormsTab([FORMS_HEADER, formRow({ ACTIVE: '' })]);
    expect(result.rows[0]?.active).toBe(true);
  });

  it('reads FALSE as inactive so a half-ready form cannot reach a teacher', () => {
    const result = parseFormsTab([FORMS_HEADER, formRow({ ACTIVE: 'FALSE' })]);
    expect(result.rows[0]?.active).toBe(false);
  });

  /**
   * The whole forms list is ONE message carrying every button. Telegram refuses
   * a message containing a malformed button URL, so one bad cell would take the
   * list away from every teacher rather than just its own row.
   */
  describe('a URL that would break the list for everybody is rejected here', () => {
    it('rejects something that is not a web address at all', () => {
      const result = parseFormsTab([FORMS_HEADER, formRow({ URL: 'ask Dilnoza for the link' })]);
      expect(result.rows).toEqual([]);
      expect(result.rejections[0]?.reason).toMatch(/not a web address/);
    });

    it('rejects plain http rather than sending 1,800 teachers to it', () => {
      const result = parseFormsTab([FORMS_HEADER, formRow({ URL: 'http://forms.example.uz/visa' })]);
      expect(result.rows).toEqual([]);
      expect(result.rejections[0]?.reason).toMatch(/https/);
    });

    it('says the consequence, because the fix belongs to whoever owns the sheet', () => {
      const result = parseFormsTab([FORMS_HEADER, formRow({ URL: 'not a url' })]);
      expect(result.rejections[0]?.reason).toMatch(/No form buttons would be shown/);
    });

    it('does not restrict the host, so MoPSE can move off Google without a developer', () => {
      const result = parseFormsTab([FORMS_HEADER, formRow({ URL: 'https://forms.example.uz/visa' })]);
      expect(result.rejections).toEqual([]);
      expect(result.rows).toHaveLength(1);
    });
  });

  /**
   * TYPE travels inside a button's payload, where `encodeCallback` throws on a
   * value it cannot carry. Thrown at render time it would break the list far
   * from the sheet that caused it, so it is caught here and reported by row.
   */
  describe('a TYPE that cannot travel in a button is rejected here, not thrown later', () => {
    it('rejects a type containing the field separator', () => {
      const result = parseFormsTab([FORMS_HEADER, formRow({ TYPE: 'DOC:PASSPORT' })]);
      expect(result.rows).toEqual([]);
      expect(result.rejections[0]?.reason).toMatch(/separates the fields/);
    });

    it('rejects a type too long for a 64-byte payload', () => {
      const result = parseFormsTab([FORMS_HEADER, formRow({ TYPE: 'P'.repeat(70) })]);
      expect(result.rows).toEqual([]);
      expect(result.rejections[0]?.reason).toMatch(/too long/);
    });

    it('counts bytes rather than characters, because Telegram does', () => {
      // Cyrillic is two bytes a letter in UTF-8, so 40 letters is 80 bytes.
      const result = parseFormsTab([FORMS_HEADER, formRow({ TYPE: 'Ж'.repeat(40) })]);
      expect(result.rows).toEqual([]);
      expect(result.rejections[0]?.reason).toMatch(/too long/);
    });

    it('suggests what a usable type looks like', () => {
      const result = parseFormsTab([FORMS_HEADER, formRow({ TYPE: 'A:B' })]);
      expect(result.rejections[0]?.reason).toMatch(/PASSPORT/);
    });

    it('names the row number so it can be found in the sheet', () => {
      const result = parseFormsTab([FORMS_HEADER, formRow(), formRow({ TYPE: 'BAD:TYPE' })]);
      expect(result.rejections[0]?.row).toBe(3);
    });
  });

  it('keeps the good rows when one row is bad', () => {
    const result = parseFormsTab([
      FORMS_HEADER,
      formRow(),
      formRow({ TYPE: 'VISA', URL: 'nonsense' }),
      formRow({ TYPE: 'CONTRACT' }),
    ]);
    expect(result.rows.map((r) => r.type)).toEqual(['PASSPORT', 'CONTRACT']);
    expect(result.rejections).toHaveLength(1);
  });
});

describe('finding the email column in a form responses tab', () => {
  /**
   * Google heads each column with the question as it was typed, so there is no
   * fixed name to require. Exactly one heading may contain "email".
   */
  it('finds the column however the question was worded', () => {
    expect(findEmailColumn('T', ['Timestamp', 'Recruitment email', 'Passport'])).toBe(1);
    expect(findEmailColumn('T', ['Timestamp', 'Your Email Address'])).toBe(1);
    expect(findEmailColumn('T', ['E-MAIL'])).toBe(0);
  });

  it('refuses when two questions mention email rather than guessing between them', () => {
    expect(() => findEmailColumn('VISA_RESPONSES', ['Your email', "Supervisor's email"])).toThrow(
      EmailColumnError,
    );
  });

  it('names both clashing headings so the form can be corrected', () => {
    try {
      findEmailColumn('VISA_RESPONSES', ['Your email', "Supervisor's email"]);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toMatch(/Your email/);
      expect((err as Error).message).toMatch(/Supervisor's email/);
      expect((err as Error).message).toMatch(/Nothing was filed/);
    }
  });

  it('says filing under the wrong person is the reason, not tidiness', () => {
    try {
      findEmailColumn('T', ['Your email', 'Manager email']);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toMatch(/worse than not filing them/);
    }
  });

  it('refuses when no question mentions email', () => {
    expect(() => findEmailColumn('VISA_RESPONSES', ['Timestamp', 'Passport'])).toThrow(
      EmailColumnError,
    );
  });

  it('tells the operator how to fix an absent column', () => {
    try {
      findEmailColumn('VISA_RESPONSES', ['Timestamp']);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toMatch(/RESPONSES_TAB/);
      expect((err as Error).message).toMatch(/must contain/);
    }
  });
});

describe('reading form submissions', () => {
  const HEADER = ['Timestamp', 'Your email address', 'Passport number'];

  it('reads a submission and normalises the address the roster will be matched on', () => {
    const result = parseResponsesTab('T', [
      HEADER,
      ['31/07/2026 14:02:11', ' A.Karimov@Example.com ', 'AA1234567'],
    ]);
    expect(result.rejections).toEqual([]);
    expect(result.rows[0]).toEqual({
      sheetRow: 2,
      email: 'a.karimov@example.com',
      submittedAt: '31/07/2026 14:02:11',
    });
  });

  /**
   * The row number is the idempotency key, so it must be the number a person
   * reading the spreadsheet would count — not an index into the array.
   */
  it('numbers rows as the spreadsheet does', () => {
    const result = parseResponsesTab('T', [
      HEADER,
      ['t', 'a@example.com', 'x'],
      ['t', 'b@example.com', 'y'],
    ]);
    expect(result.rows.map((r) => r.sheetRow)).toEqual([2, 3]);
  });

  /**
   * Unlike every other parser here. Corrected documents and second pages are
   * normal, and each submission is its own row and its own case.
   */
  it('does NOT reject the same teacher submitting twice', () => {
    const result = parseResponsesTab('T', [
      HEADER,
      ['t', 'a@example.com', 'first'],
      ['t', 'a@example.com', 'corrected'],
    ]);
    expect(result.rejections).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.sheetRow)).toEqual([2, 3]);
  });

  it('rejects a submission with no address, naming its row', () => {
    const result = parseResponsesTab('T', [HEADER, ['t', '', 'AA1']]);
    expect(result.rows).toEqual([]);
    expect(result.rejections[0]?.row).toBe(2);
    expect(result.rejections[0]?.reason).toMatch(/cannot be matched/);
  });

  it('keeps the good submissions when one has no address', () => {
    const result = parseResponsesTab('T', [
      HEADER,
      ['t', 'a@example.com', 'x'],
      ['t', '', 'y'],
      ['t', 'c@example.com', 'z'],
    ]);
    expect(result.rows.map((r) => r.email)).toEqual(['a@example.com', 'c@example.com']);
    expect(result.rejections).toHaveLength(1);
  });

  it('skips a wholly blank row without calling it an error', () => {
    const result = parseResponsesTab('T', [HEADER, ['', '', ''], ['t', 'a@example.com', 'x']]);
    expect(result.rejections).toEqual([]);
    expect(result.rows).toHaveLength(1);
  });

  it('copes with a tab that has no Timestamp column', () => {
    const result = parseResponsesTab('T', [['Your email'], ['a@example.com']]);
    expect(result.rows[0]?.submittedAt).toBeNull();
  });

  it('tolerates a short row where trailing cells are simply absent', () => {
    const result = parseResponsesTab('T', [HEADER, ['t', 'a@example.com']]);
    expect(result.rows).toHaveLength(1);
  });

  /**
   * The whole tab, not one row. A tab whose email column cannot be identified
   * has no row that can be filed, and filing none of them is the right answer.
   */
  it('refuses the whole tab when the email column is ambiguous', () => {
    expect(() =>
      parseResponsesTab('VISA_RESPONSES', [
        ['Your email', "Supervisor's email"],
        ['a@example.com', 'b@example.com'],
      ]),
    ).toThrow(EmailColumnError);
  });
});
