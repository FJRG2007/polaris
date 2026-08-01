/**
 * Writing a person's name down the same way wherever it was typed.
 *
 * A phone keyboard capitalizes sentences, not words, so a name typed on one
 * arrives as "juan perez"; a physical keyboard ignores the hint entirely and
 * whatever was typed is what gets stored. Both are the same problem and this is
 * the one answer to it, used on the form and again on the server.
 *
 * Only the first letter of each word is touched. Lowercasing the rest would turn
 * McDonald into Mcdonald and O'Brien into O'brien, which is worse than the problem
 * being fixed - somebody who capitalized their own name deliberately is right.
 */

/** Trim, collapse runs of whitespace, and uppercase the first letter of each word. */
export function normalizePersonName(value: string): string {
    return value
        .trim()
        .replace(/\s+/g, " ")
        .replace(/(^|[\s'-])(\p{L})/gu, (_match, boundary: string, letter: string) => boundary + letter.toUpperCase());
}
