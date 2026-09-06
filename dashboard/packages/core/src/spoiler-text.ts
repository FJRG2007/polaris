/**
 * `||like this||`, in a line of writing.
 *
 * The syntax every client of this kind uses, so somebody who has typed it
 * before types it here and it works. Kept out of the Markdown parser on
 * purpose: a mark in the schema would have to be added to the editor, the
 * serializer and the renderer together, and it would leave every message
 * already sent - where somebody typed the bars because they expected them to
 * mean this - reading as bars. Splitting the text at the moment it is drawn
 * covers both.
 *
 * Pure, so the rule about what counts is one thing rather than a regular
 * expression written twice.
 */

/** One run of a line: the words, and whether they arrived covered. */
export interface SpoilerPart {
    readonly text: string;
    readonly covered: boolean;
}

/**
 * Nothing across a line break and nothing empty.
 *
 * `||` on its own, or a pair with nothing between them, is somebody drawing a
 * table or writing about the operator - and covering a blank is a button over
 * nothing. Non-greedy, so `||a|| and ||b||` is two covers rather than one
 * swallowing the words between them.
 */
const SPOILER = /\|\|([^\n|][^\n]*?)\|\|/g;

/** A line, split into what is covered and what is not. One part, uncovered, for
 *  the ordinary case - which is nearly every line ever written. */
export function splitSpoilers(text: string): SpoilerPart[] {
    if (!text.includes("||")) return [{ text, covered: false }];
    const parts: SpoilerPart[] = [];
    let at = 0;
    for (const match of text.matchAll(SPOILER)) {
        const start = match.index ?? 0;
        if (start > at) parts.push({ text: text.slice(at, start), covered: false });
        parts.push({ text: match[1] ?? "", covered: true });
        at = start + match[0].length;
    }
    if (at === 0) return [{ text, covered: false }];
    if (at < text.length) parts.push({ text: text.slice(at), covered: false });
    return parts;
}

/** Whether a line has anything covered in it, without building the parts. For
 *  the places that only need to know - a notification preview, a quote. */
export function hasSpoiler(text: string): boolean {
    return splitSpoilers(text).some((part) => part.covered);
}

/** The same line with the bars taken out and nothing covered, for the places a
 *  cover cannot exist: a browser notification, the one-line preview under a
 *  conversation, the subject of an email. Those are read where there is nothing
 *  to press, so a cover there would be a permanent blank. */
export function withoutSpoilers(text: string): string {
    return splitSpoilers(text)
        .map((part) => part.text)
        .join("");
}
