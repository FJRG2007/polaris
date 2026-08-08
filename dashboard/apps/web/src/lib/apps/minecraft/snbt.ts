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
