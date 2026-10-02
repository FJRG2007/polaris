/**
 * One cell as a spreadsheet will read it once pasted.
 *
 * A value that starts like a formula is put behind an apostrophe, which a
 * spreadsheet reads as "this is text" and does not show: a row somebody else
 * wrote must not get to run `=HYPERLINK(...)` or `=WEBSERVICE(...)` on the
 * reader's machine because they copied it. A tab or a line break inside a value
 * would start a new cell or row, so they become spaces.
 */
export function spreadsheetSafe(text: string): string {
    const flat = text.replace(/[\t\r\n]+/g, " ");
    return /^[=+\-@]/.test(flat) ? `'${flat}` : flat;
}
