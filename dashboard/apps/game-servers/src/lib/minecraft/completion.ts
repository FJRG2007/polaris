/**
 * Offering the variables as they are typed, the way a code editor completes a
 * name: `{` opens the list, `{call.` narrows it to the call's, and choosing one
 * writes the rest of it and the closing brace.
 *
 * Pure, so the field can ask it on every keystroke and a test can pin it.
 */

/** A variable the field may offer: what to show, and what to write. */
export interface Completable {
    readonly label: string;
    /** As it is written, braces and all: `{call.count}`. */
    readonly text: string;
}

/** The unfinished `{name` the caret is at the end of: where it starts and what
 *  has been typed of the name so far. */
export interface CompletionSpot {
    readonly from: number;
    readonly query: string;
}

/**
 * The variable being typed at `caret`, or null when the caret is not inside
 * one. Only `{` followed by the start of a name counts: a fallback after `|`, a
 * closed variable and plain text are not completed.
 */
export function completionSpot(text: string, caret: number): CompletionSpot | null {
    const before = text.slice(0, caret);
    const open = before.lastIndexOf("{");
    if (open < 0) return null;
    const typed = before.slice(open + 1);
    if (!/^\s*[A-Za-z]?[\w.]*$/.test(typed)) return null;
    return { from: open, query: typed.trim().toLowerCase() };
}

/**
 * What to offer for what has been typed, best first: names that start with it,
 * then names and labels that contain it. Everything, in its own order, for a
 * bare `{`.
 */
export function completionsFor<T extends Completable>(query: string, options: readonly T[]): T[] {
    const name = (option: T) => option.text.replace(/^\{|\}$/g, "").toLowerCase();
    if (!query) return [...options];
    const starts = options.filter((option) => name(option).startsWith(query));
    const contains = options.filter(
        (option) =>
            !starts.includes(option) &&
            (name(option).includes(query) || option.label.toLowerCase().includes(query))
    );
    return [...starts, ...contains];
}

/**
 * The text with the chosen variable written over what was typed of it, and
 * where the caret goes: after the closing brace. A brace already standing
 * after the caret is used rather than doubled.
 */
export function acceptCompletion(
    text: string,
    caret: number,
    spot: CompletionSpot,
    option: Completable
): { text: string; caret: number } {
    const after = text.slice(caret);
    const rest = after.startsWith("}") ? after.slice(1) : after;
    const next = `${text.slice(0, spot.from)}${option.text}${rest}`;
    return { text: next, caret: spot.from + option.text.length };
}
