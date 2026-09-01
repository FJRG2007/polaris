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
 *
 * Two functions rather than one, and the split is about the caret. Capitalizing
 * cannot change the length of a string, so it can be applied on every keystroke
 * and the caret stays where the person left it; trimming and collapsing runs of
 * whitespace both can, so a field doing that as somebody types would jump the
 * caret backwards in the middle of a double space. So the letters are fixed while
 * they type and the spacing is tidied when they leave the field - and the server
 * does both again, because a form is a courtesy.
 */

/** Uppercase the first letter of each word, changing nothing else - the length
 *  of the string included, which is what makes it safe on every keystroke. */
export function capitalizeWords(value: string): string {
    return value.replace(
        /(^|[\s'-])(\p{L})/gu,
        (_match, boundary: string, letter: string) => boundary + letter.toUpperCase()
    );
}

/** Trim, collapse runs of whitespace, and uppercase the first letter of each word. */
export function normalizePersonName(value: string): string {
    return capitalizeWords(value.trim().replace(/\s+/g, " "));
}
