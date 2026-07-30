import { describe, expect, it } from 'vitest';
import { toCsv } from './csv.js';

const HEADERS = ['reference', 'region'] as const;

/** The bytes before the first field, stripped when a test is about content. */
const BOM = '﻿';
const body = (csv: string): string => csv.slice(BOM.length);

describe('toCsv', () => {
  it('writes a header row and one row per record', () => {
    const csv = body(toCsv(HEADERS, [{ reference: 'VISA-2026-00001', region: 'Bukhara' }]));
    expect(csv).toBe('reference,region\r\nVISA-2026-00001,Bukhara\r\n');
  });

  it('writes the header row even when there is nothing to report', () => {
    // A file with no header is a file somebody cannot tell apart from a broken
    // export. Whether an empty result should be a file at all is the command's
    // decision, not this function's.
    expect(body(toCsv(HEADERS, []))).toBe('reference,region\r\n');
  });

  it('quotes a value containing a comma, a quote or a newline', () => {
    const csv = body(toCsv(HEADERS, [{ reference: 'a,b', region: 'say "hi"' }]));
    expect(csv).toContain('"a,b","say ""hi"""');
  });

  it('keeps a value with an embedded newline in one field', () => {
    const csv = body(toCsv(HEADERS, [{ reference: 'a\nb', region: 'x' }]));
    expect(csv).toBe('reference,region\r\n"a\nb",x\r\n');
  });

  it('writes an empty cell for null and undefined, and never the word', () => {
    // "null" in a spreadsheet cell is a region called null. An empty cell is
    // the honest rendering of a value that is not there.
    const csv = body(toCsv(HEADERS, [{ reference: 'X', region: null }]));
    expect(csv).toBe('reference,region\r\nX,\r\n');
    expect(csv).not.toContain('null');
  });

  it('renders a date in Tashkent, not in the server’s zone', () => {
    // Every timestamp anybody in this project reads is Tashkent. A report that
    // is five hours out is one somebody plans a week from.
    const csv = body(toCsv(['when'] as const, [{ when: new Date('2026-07-30T20:30:00Z') }]));
    expect(csv).toContain('2026-07-31 01:30');
  });

  describe('the formula guard', () => {
    /**
     * A cell beginning `=`, `+`, `-`, `@`, a tab or a carriage return is
     * executed as a formula by Excel and by LibreOffice when the file is opened.
     * D43 keeps teachers' words out of the export, but region names, staff names
     * and case references are all still text somebody typed, and the file is
     * opened by whoever asked for it on a ministry laptop.
     */
    it.each(['=cmd()', '+1', '-1', '@SUM(A1)', '\tx', '\rx'])(
      'neutralises a cell beginning %j',
      (dangerous) => {
        const csv = body(toCsv(HEADERS, [{ reference: dangerous, region: 'x' }]));
        expect(csv).toMatch(/^reference,region\r\n["']/);
        expect(csv).not.toMatch(/\r\n[=+\-@\t\r]/);
      },
    );

    it('leaves an ordinary value alone', () => {
      const csv = body(toCsv(HEADERS, [{ reference: 'VISA-2026-00001', region: 'Bukhara' }]));
      expect(csv).not.toContain("'");
    });
  });

  it('starts with a UTF-8 byte order mark', () => {
    // Without it, Excel on Windows reads a UTF-8 file as the system codepage and
    // every non-ASCII name in the report becomes rubbish. The person opening
    // this file is on Windows.
    expect(toCsv(HEADERS, [])).toMatch(/^﻿/);
  });
});
