/**
 * Finding a run of text inside a file somebody has open.
 *
 * Pure, and apart from the viewer, because the awkward parts of a find are all
 * decisions rather than drawing: an empty query matches nothing rather than
 * everything, a query in lower case finds the same word in capitals, and a file
 * with fifty thousand hits must not turn into fifty thousand painted boxes.
 *
 * Positions are offsets into the text rather than line and column. The viewer
 * paints one string and scrolls to one element, and a line number would have to
 * be turned back into an offset by both.
 */

/** One hit, as a half-open range over the text. */
export interface Match {
    readonly start: number;
    readonly end: number;
}

/**
 * The most hits a search reports.
 *
 * Past this the answer stops being useful - nobody steps through two thousand
 * matches - and every one of them is a box painted under the text. The count the
 * bar shows says so, rather than pretending the file has no more.
 */
export const MOST_MATCHES = 2000;

/**
 * Every place `query` appears in `text`, left to right and never overlapping.
 *
 * Matching is plain text, not a pattern: what somebody types into a find bar over
 * a config file is a key or a value, and the one person who meant `.*` meant it
 * literally. Case is ignored unless asked for, which is what a reader expects
 * from a find in a file they are only reading.
 */
export function findMatches(text: string, query: string, caseSensitive = false): Match[] {
    if (query === "") return [];
    const hay = caseSensitive ? text : text.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
    const found: Match[] = [];
    let at = hay.indexOf(needle);
    while (at !== -1 && found.length < MOST_MATCHES) {
        found.push({ start: at, end: at + needle.length });
        at = hay.indexOf(needle, at + needle.length);
    }
    return found;
}

/** A piece of the text as it is drawn: plain, a hit, or the hit somebody is on. */
export interface Part {
    readonly text: string;
    readonly hit: boolean;
    /** The one the bar is stepping through, which is painted differently and is
     *  what gets scrolled to. */
    readonly current: boolean;
}

/**
 * The text split around its hits, ready to render.
 *
 * Every piece of the text comes back, in order, so what is drawn from these is
 * the file itself - a split that dropped anything would be a viewer quietly
 * showing something other than what is in the file.
 */
export function markedParts(text: string, matches: readonly Match[], current: number): Part[] {
    if (matches.length === 0) return [{ text, hit: false, current: false }];
    const parts: Part[] = [];
    let at = 0;
    for (const [index, match] of matches.entries()) {
        if (match.start > at) parts.push({ text: text.slice(at, match.start), hit: false, current: false });
        parts.push({
            text: text.slice(match.start, match.end),
            hit: true,
            current: index === current
        });
        at = match.end;
    }
    if (at < text.length) parts.push({ text: text.slice(at), hit: false, current: false });
    return parts;
}

/** Where the next step lands, wrapping at both ends: a find that stops at the
 *  last hit is one somebody has to close and open again. */
export function stepMatch(current: number, total: number, by: 1 | -1): number {
    if (total === 0) return 0;
    return (current + by + total) % total;
}
