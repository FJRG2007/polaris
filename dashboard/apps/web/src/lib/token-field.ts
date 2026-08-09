/**
 * A field that holds a list rather than a value.
 *
 * Extensions, addresses, the accounts allowed into a drop point: all of them are
 * typed into one box, separated by whatever the person reached for - a comma, a
 * space, both. Two things are needed of such a field and they belong together,
 * because they have to agree on where one entry ends: the list it submits, and
 * the entry the caret is currently inside, which is the one a picker under it is
 * answering about.
 */

/** What ends one entry and starts the next. */
export const TOKEN_SEPARATOR = /[\s,]/;

/**
 * The entries a field holds, cleaned up the way they are stored.
 *
 * @param value - The raw field.
 * @param stripLeading - A prefix that is decoration rather than part of the
 *   entry: the dot on ".png", the "@" on "@alice".
 */
export function tokenList(value: string, stripLeading: RegExp): string[] {
    const parts = value
        .split(/[\s,]+/)
        .map((token) => token.trim().replace(stripLeading, "").toLowerCase())
        .filter(Boolean);
    return Array.from(new Set(parts));
}

/** One entry of a field, and where it sits. */
export interface FieldToken {
    readonly start: number;
    readonly end: number;
    readonly value: string;
}

/**
 * The entry the caret is inside.
 *
 * @param text - The whole field.
 * @param caret - Where the caret is.
 * @param multiple - Whether the field holds a list at all. A field that holds
 *   one account has no separators, so the entry is everything in it - including
 *   the spaces of somebody typing a full name.
 */
export function tokenAt(text: string, caret: number, multiple: boolean): FieldToken {
    if (!multiple) return { start: 0, end: text.length, value: text };
    const at = Math.max(0, Math.min(caret, text.length));
    let start = at;
    while (start > 0 && !TOKEN_SEPARATOR.test(text.charAt(start - 1))) start -= 1;
    let end = at;
    while (end < text.length && !TOKEN_SEPARATOR.test(text.charAt(end))) end += 1;
    return { start, end, value: text.slice(start, end) };
}
