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

describe('the three columns that make a form an area', () => {
  const HEADER = ['TYPE', 'BUTTON_TEXT', 'URL', 'RESPONSES_TAB', 'ACTIVE', 'CATEGORY', 'PREPARE', 'EMAIL_COLUMN'];
  const row = (over: Record<string, string> = {}): string[] => [
    over['TYPE'] ?? 'REIMBURSE',
    over['BUTTON_TEXT'] ?? 'Reimbursement',
    over['URL'] ?? 'https://forms.gle/abc',
    over['RESPONSES_TAB'] ?? 'REIMBURSE_RESPONSES',
    over['ACTIVE'] ?? 'TRUE',
    over['CATEGORY'] ?? 'Travel and Arrival',
    over['PREPARE'] ?? 'Have your receipts ready as one PDF.',
    over['EMAIL_COLUMN'] ?? 'Email Address',
  ];

  it('reads all three', () => {
    const result = parseFormsTab([HEADER, row()]);
    expect(result.rows[0]?.category).toBe('Travel and Arrival');
    expect(result.rows[0]?.prepare).toBe('Have your receipts ready as one PDF.');
    expect(result.rows[0]?.emailColumn).toBe('Email Address');
  });

  it('treats all three as absent when blank', () => {
    const result = parseFormsTab([HEADER, row({ CATEGORY: '', PREPARE: '', EMAIL_COLUMN: '' })]);
    expect(result.rows[0]?.category).toBeNull();
    expect(result.rows[0]?.prepare).toBeNull();
    expect(result.rows[0]?.emailColumn).toBeNull();
  });

  /**
   * A sheet written before this feature must go on working untouched. The three
   * columns are optional in the same way RESPONSES_TAB already is.
   */
  it('does not require any of the three columns to exist at all', () => {
    const old = ['TYPE', 'BUTTON_TEXT', 'URL'];
    const result = parseFormsTab([old, ['DOC', 'Documents', 'https://forms.gle/abc']]);
    expect(result.rejections).toHaveLength(0);
    expect(result.rows[0]?.category).toBeNull();
  });

  /**
   * The rule that stops an area being silently unreachable. It is the same
   * failure a misspelled FAQ topic causes, and it is answered the same way:
   * reject the row with its number, name the real values, and let every other
   * row sync.
   */
  it('rejects a category this build does not have, and keeps the other rows', () => {
    const result = parseFormsTab([
      HEADER,
      row({ TYPE: 'GOOD' }),
      row({ TYPE: 'BAD', CATEGORY: 'Dentistry' }),
    ]);

    expect(result.rows.map((r) => r.type)).toEqual(['GOOD']);
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]?.reason).toContain('Dentistry');
    expect(result.rejections[0]?.reason).toContain('Travel and Arrival');
  });

  /**
   * The fourth optional column, added 6 August 2026. `HEADER` and `row()` are
   * deliberately left at eight columns and extended per-test, so every test
   * above goes on proving that a sheet written before this column existed still
   * parses without it.
   */
  it('reads the spreadsheet a form’s answers live in', () => {
    const header = [...HEADER, 'RESPONSES_SHEET_ID'];
    const result = parseFormsTab([header, [...row(), 'SHEET_ABC']]);
    expect(result.rows[0]?.responsesSheetId).toBe('SHEET_ABC');
  });

  /**
   * ⚠️ Blank must become null and not the empty string. `spreadsheetValuesUrl`
   * chooses the configured spreadsheet with `??`, which treats "" as a real
   * answer — so an empty cell surviving as "" would build a request against a
   * spreadsheet with no id rather than falling back to the main one.
   */
  it('treats a blank spreadsheet id as “the main one”', () => {
    const header = [...HEADER, 'RESPONSES_SHEET_ID'];
    const result = parseFormsTab([header, [...row(), '']]);
    expect(result.rows[0]?.responsesSheetId).toBeNull();
  });

  /** And a cell holding nothing but spaces is the same thing to a person. */
  it('treats a whitespace-only spreadsheet id as “the main one”', () => {
    const header = [...HEADER, 'RESPONSES_SHEET_ID'];
    const result = parseFormsTab([header, [...row(), '   ']]);
    expect(result.rows[0]?.responsesSheetId).toBeNull();
  });

  it('does not require the column to exist at all', () => {
    const result = parseFormsTab([HEADER, row()]);
    expect(result.rejections).toHaveLength(0);
    expect(result.rows[0]?.responsesSheetId).toBeNull();
  });
});

describe('finding the email column in a form responses tab', () => {
  /**
   * Google heads each column with the question as it was typed, so there is no
   * fixed name to require. Exactly one heading may contain "email".
   */
  it('finds the column however the question was worded', () => {
    expect(findEmailColumn('T', ['Timestamp', 'Recruitment email', 'Passport'], null)).toBe(1);
    expect(findEmailColumn('T', ['Timestamp', 'Your Email Address'], null)).toBe(1);
    expect(findEmailColumn('T', ['E-MAIL'], null)).toBe(0);
  });

  it('refuses when two questions mention email rather than guessing between them', () => {
    expect(() =>
      findEmailColumn('VISA_RESPONSES', ['Your email', "Supervisor's email"], null),
    ).toThrow(EmailColumnError);
  });

  /**
   * The advice in this message changed on 3 August 2026 and the change is the
   * point of it. It used to end *"Only one may … Reword the others."* — the only
   * advice available before `EMAIL_COLUMN` existed, and now the harmful one:
   * following it means rewording "School contact email or telephone number"
   * until it no longer contains the word "email", which damages a question that
   * is asking exactly the right thing.
   *
   * What the test protected before is kept — the message names the tab and lists
   * the offending headings, so somebody can act on it without opening the
   * spreadsheet twice — and the new advice is now protected alongside it.
   */
  it('names the tab, both clashing headings, and the setting that resolves them', () => {
    try {
      findEmailColumn('VISA_RESPONSES', ['Your email', "Supervisor's email"], null);
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/VISA_RESPONSES/);
      expect(message).toMatch(/Your email/);
      expect(message).toMatch(/Supervisor's email/);
      expect(message).toMatch(/EMAIL_COLUMN/);
      expect(message).toMatch(/Nothing was filed/);
      // The advice that would damage a correct question is gone for good.
      expect(message).not.toMatch(/Reword/);
    }
  });

  it('says filing under the wrong person is the reason, not tidiness', () => {
    try {
      findEmailColumn('T', ['Your email', 'Manager email'], null);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toMatch(/worse than not filing them/);
    }
  });

  it('refuses when no question mentions email', () => {
    expect(() => findEmailColumn('VISA_RESPONSES', ['Timestamp', 'Passport'], null)).toThrow(
      EmailColumnError,
    );
  });

  it('tells the operator how to fix an absent column', () => {
    try {
      findEmailColumn('VISA_RESPONSES', ['Timestamp'], null);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toMatch(/RESPONSES_TAB/);
      expect((err as Error).message).toMatch(/must contain/);
    }
  });
});

describe('finding the teacher’s email column', () => {
  /**
   * MoPSE's four live forms, as their response sheets actually read on
   * 3 August 2026. Every one has more than one heading containing "email", so
   * every one of them filed nothing at all.
   *
   * Two causes and both are normal. Google's "Collect email addresses" adds an
   * `Email Address` column, and each form also asks for the address as a
   * question. Holiday and Medical then ask for a school contact email and an
   * emergency contact email, which are the right questions to ask.
   *
   * The trailing space on the emergency heading is real. It is kept because a
   * fixture tidied up is a fixture that stops matching the thing it stands for.
   */
  const HOLIDAY = [
    'Timestamp',
    'Email Address',
    'Full name as shown on your Passport',
    'Email address',
    'Emergency email / phone number while on leave ',
    'School contact email or telephone number',
  ];
  const MEDICAL = [
    'Timestamp',
    'Email Address',
    'Full name as shown on your passport',
    'Email address',
    'School contact email or telephone number',
  ];
  const ACCOMMODATION = ['Timestamp', 'Email Address', 'Full Name', 'Email Address'];
  const REIMBURSEMENT = ['Timestamp', 'Email Address', 'Full Name', 'Email Address'];

  it('refuses each of the four real forms when no column is named', () => {
    for (const header of [HOLIDAY, MEDICAL, ACCOMMODATION, REIMBURSEMENT]) {
      expect(() => findEmailColumn('TAB', header, null)).toThrow(EmailColumnError);
    }
  });

  it('finds the named column in each of the four', () => {
    expect(findEmailColumn('TAB', HOLIDAY, 'Email address')).toBe(3);
    expect(findEmailColumn('TAB', MEDICAL, 'Email address')).toBe(3);
    // Both candidates read `Email Address` exactly, so the first is the answer
    // and naming it is the only way to say which was meant.
    expect(findEmailColumn('TAB', ACCOMMODATION, 'Email Address')).toBe(1);
    expect(findEmailColumn('TAB', REIMBURSEMENT, 'Email Address')).toBe(1);
  });

  it('still finds a single unnamed column, so no existing sheet changes meaning', () => {
    expect(findEmailColumn('TAB', ['Timestamp', 'Your email'], null)).toBe(1);
  });

  it('matches a named heading after trimming, and infers nothing else', () => {
    expect(findEmailColumn('TAB', ['Timestamp', '  Email address  '], 'Email address')).toBe(1);
    // Not a substring match: naming a column means naming it.
    expect(() => findEmailColumn('TAB', ['Timestamp', 'Email address'], 'Email')).toThrow(
      EmailColumnError,
    );
  });

  /**
   * The message is the whole value of this branch. A named column that is not
   * there must say what it looked for and what it found, or somebody is left
   * comparing a spreadsheet against a silence.
   */
  it('names the column it wanted and lists the ones that exist', () => {
    try {
      findEmailColumn('LEAVE_RESPONSES', ['Timestamp', 'Email address'], 'E-mail');
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('E-mail');
      expect(message).toContain('Email address');
      expect(message).toContain('LEAVE_RESPONSES');
    }
  });

  /**
   * MoPSE's Accommodation and Reimbursement sheets, verbatim on 6 August 2026.
   * B and D are the SAME STRING — Google's "Collect email addresses" adds B, and
   * the form asks the question again as D. No heading can pick between them, and
   * D is the one the teacher typed.
   */
  const DUPLICATE = ['Timestamp', 'Email Address', 'Full Name', 'Email Address'];

  it('resolves a column letter when two headings are identical', () => {
    expect(findEmailColumn('TAB', DUPLICATE, 'D')).toBe(3);
    expect(findEmailColumn('TAB', DUPLICATE, 'B')).toBe(1);
    expect(findEmailColumn('TAB', DUPLICATE, 'A')).toBe(0);
  });

  it('accepts a lowercase letter and surrounding space', () => {
    expect(findEmailColumn('TAB', DUPLICATE, ' d ')).toBe(3);
  });

  it('resolves a two-letter column', () => {
    const wide = Array.from({ length: 30 }, (_, i) => `Q${i}`);
    // AA is the 27th column, index 26.
    expect(findEmailColumn('TAB', wide, 'AA')).toBe(26);
  });

  /**
   * A heading always wins. Naming a real column can never be overridden by a
   * coincidence of spelling, which is what makes the letter form safe to add.
   */
  it('prefers a real heading over reading the same text as a letter', () => {
    expect(findEmailColumn('TAB', ['Timestamp', 'D', 'Email Address'], 'D')).toBe(1);
  });

  it('refuses a letter past the end of the header, naming the width', () => {
    try {
      findEmailColumn('ACCOM_RESPONSES', DUPLICATE, 'Z');
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('Z');
      expect(message).toContain('ACCOM_RESPONSES');
      expect(message).toContain('4');
    }
  });

  /**
   * Not a letter and not a heading is the ordinary mistake, and the message must
   * not start talking about columns the operator never mentioned.
   */
  it('still reports an unmatched heading as an unmatched heading', () => {
    try {
      findEmailColumn('TAB', DUPLICATE, 'E-mail');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('E-mail');
      expect((err as Error).message).toContain('EMAIL_COLUMN');
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
