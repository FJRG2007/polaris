/**
 * Reading SNBT - Minecraft's own notation, close to JSON and not JSON.
 *
 * `data get entity ...` answers in it: unquoted keys, type suffixes on numbers
 * (`64b`, `0s`, `123.4d`), single-quoted strings, and compounds nested
 * arbitrarily deep. That nesting is why everything here walks the text rather
 * than matching it - an enchanted book carries an `id` inside its own components,
 * and a pattern looking for `id` finds that one as readily as the item's.
 *
 * Kept apart from what reads any particular reply, because more than one does:
 * an inventory and a position are the same notation asked two questions.
 */

/**
 * The substring from `open` to its matching bracket, quotes respected.
 *
 * Null when the reply was cut off before it closed, which is the only honest
 * answer: half a compound is not a shorter compound.
 */
export function readBalanced(text: string, open: number): string | null {
    const closing = text[open] === "[" ? "]" : "}";
    let depth = 0;
    let quote: string | null = null;
    for (let index = open; index < text.length; index += 1) {
        const character = text[index] as string;
        if (quote) {
            if (character === "\\") index += 1;
            else if (character === quote) quote = null;
            continue;
        }
        if (character === '"' || character === "'") quote = character;
        else if (character === "[" || character === "{") depth += 1;
        else if (character === "]" || character === "}") {
            depth -= 1;
            if (depth === 0) return character === closing ? text.slice(open, index + 1) : null;
        }
    }
    return null;
}

/** The comma-separated members of a compound or list body, ignoring the commas
 *  inside nested ones and inside strings. */
export function splitTopLevel(body: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let start = 0;
    for (let index = 0; index < body.length; index += 1) {
        const character = body[index] as string;
        if (quote) {
            if (character === "\\") index += 1;
            else if (character === quote) quote = null;
            continue;
        }
        if (character === '"' || character === "'") quote = character;
        else if (character === "[" || character === "{") depth += 1;
        else if (character === "]" || character === "}") depth -= 1;
        else if (character === "," && depth === 0) {
            parts.push(body.slice(start, index));
            start = index + 1;
        }
    }
    const last = body.slice(start).trim();
    if (last.length > 0) parts.push(last);
    return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** The colon separating a field's key from its value, skipping the ones inside a
 *  nested compound or a quoted string. */
export function topLevelColon(field: string): number {
    let depth = 0;
    let quote: string | null = null;
    for (let index = 0; index < field.length; index += 1) {
        const character = field[index] as string;
        if (quote) {
            if (character === "\\") index += 1;
            else if (character === quote) quote = null;
            continue;
        }
        if (character === '"' || character === "'") quote = character;
        else if (character === "[" || character === "{") depth += 1;
        else if (character === "]" || character === "}") depth -= 1;
        else if (character === ":" && depth === 0) return index;
    }
    return -1;
}

/**
 * What the server wrapped its answer in: `<name> has the following entity data:`.
 *
 * Vanilla, Paper and Spigot all say it, for entities, blocks and storage alike.
 */
const DATA_PREAMBLE = /has the following [a-z ]*data:\s*/i;

/**
 * The value out of a `data get` reply, without the sentence around it.
 *
 * The reply does not arrive alone. What comes back from the container is the
 * command's output and its diagnostics together, so a line the client printed
 * first - a connection warning, a timestamped log line - sits in front of the
 * answer. A reader that took the first bracket in all of that would take
 * `[WARN]` and report a full bag as empty, which is worse than failing: it is a
 * confident wrong answer about whether somebody is carrying something.
 *
 * Anchoring on the sentence the server itself writes is what makes the value
 * findable no matter what was printed before it.
 */
export function dataReplyValue(output: string): string {
    const match = DATA_PREAMBLE.exec(output);
    return match ? output.slice(match.index + match[0].length) : output;
}

/**
 * Whether the server answered the question at all.
 *
 * The difference between "the bag is empty" and "that was not an answer" is
 * invisible once both have been read into no items, and they are not the same
 * thing to say to somebody checking whether a player is carrying something. This
 * is what lets a reader tell them apart before it reports either.
 */
export function isDataReply(output: string): boolean {
    return DATA_PREAMBLE.test(output);
}

/**
 * The first balanced span in `text` that a reader accepts.
 *
 * Every opening bracket is tried in turn rather than only the first, because the
 * first one may belong to something that was never the answer - and a span that
 * parses to nothing is indistinguishable, to the reader, from an answer that was
 * genuinely empty. Whoever knows what a real answer looks like decides, by
 * returning null for one that is not.
 */
export function readFirstAccepted<T>(
    text: string,
    bracket: "[" | "{",
    read: (span: string) => T | null
): T | null {
    for (let index = text.indexOf(bracket); index !== -1; index = text.indexOf(bracket, index + 1)) {
        const span = readBalanced(text, index);
        if (span === null) continue;
        const value = read(span);
        if (value !== null) return value;
    }
    return null;
}

/** A string with its quotes and escapes taken off, or the bare token unchanged. */
export function unquote(value: string): string {
    const trimmed = value.trim();
    const quote = trimmed[0];
    if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
        return trimmed.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    return trimmed;
}

/** A whole number, which carries its type as a suffix (`64b`, `12s`, `3L`). */
export function readInt(value: string | undefined): number | null {
    if (value === undefined) return null;
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
}

/** A number that may have a fraction, and the same trailing type letter (`64.5d`,
 *  `1.0f`). `parseFloat` stops at the letter, which is exactly what is wanted. */
export function readFloat(value: string | undefined): number | null {
    if (value === undefined) return null;
    const parsed = Number.parseFloat(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
}
