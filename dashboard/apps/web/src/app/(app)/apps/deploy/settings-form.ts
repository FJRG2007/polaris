/**
 * The pure half of the service Settings tab: whether a card holds a change worth
 * saving, and which section the reader is looking at. Apart from the components
 * so both can be asserted without a browser.
 */

/** A value as a card compares it: strings trimmed, since surrounding spaces are
 *  not an edit and the save trims them anyway. */
function normalized(value: unknown): unknown {
    if (typeof value === "string") return value.trim();
    if (Array.isArray(value)) return value.map(normalized);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, entry]) => [key, normalized(entry)])
        );
    }
    return value;
}

/**
 * Whether two states of a card hold the same values. Dirty means different, not
 * touched: a field typed into and put back is not a change, and Save stays off.
 */
export function sameSettings(a: unknown, b: unknown): boolean {
    return JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));
}

/** Copy only the named fields of `from` over `onto`: what one card saves when its
 *  neighbours share the same server write but have edits of their own pending. */
export function withFields<T extends object, K extends keyof T>(
    onto: T,
    from: T,
    keys: readonly K[]
): T {
    const next = { ...onto };
    for (const key of keys) next[key] = from[key];
    return next;
}

/** One section's position in the scroller, top edge relative to its content. */
export interface SectionTop {
    readonly id: string;
    readonly top: number;
}

/**
 * The section the navigator marks as current. The last one whose top has passed
 * the reading line (a little below the scroller's top edge) wins; at the very
 * bottom the last section wins even when it is too short to reach the line,
 * otherwise a short Danger zone could never be marked.
 */
export function activeSection(
    sections: readonly SectionTop[],
    scrollTop: number,
    viewport: number,
    scrollHeight: number,
    line = 96
): string | null {
    if (sections.length === 0) return null;
    if (scrollTop + viewport >= scrollHeight - 2) return sections[sections.length - 1]!.id;
    let current = sections[0]!.id;
    for (const section of sections) {
        if (section.top <= scrollTop + line) current = section.id;
    }
    return current;
}
