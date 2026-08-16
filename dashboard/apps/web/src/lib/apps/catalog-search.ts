/**
 * Searching a game's catalogue of things.
 *
 * Every game panel that hands somebody an item ends up with the same problem: a
 * grid of a thousand pictures nobody scrolls, a search box, and an operator who
 * types "dimaond". The ranking below is what turns that into an answer, and it is
 * here rather than in one game's module because Minecraft and ARK both need it and
 * neither should be the other's dependency.
 *
 * The entries are whatever a catalogue holds, as long as it can say what a thing
 * is called and what words find it.
 */

import Fuse from "fuse.js";

export interface SearchableItem {
    /** What the caller sends to the game. Only used here to break ties. */
    readonly id: string;
    readonly label: string;
    /** Lowercase words, so "diamond sword" and "diamond_sword" both match. */
    readonly search: string;
}

/**
 * How far a fuzzy match may stray. Low enough that a query naming nothing still
 * finds nothing - an operator typing "beacon" into a catalogue without one wants
 * to be told so, not handed five things that share four letters with it.
 */
const FUZZY_THRESHOLD = 0.3;

/**
 * The fuzzy index for one catalogue, built once.
 *
 * Keyed on the array itself rather than rebuilt per keystroke: a catalogue is
 * thousands of entries and is fetched once per tab, so the index outlives every
 * search run against it. Weak, so a catalogue that is replaced is not kept alive
 * by its own index.
 */
const fuzzyIndexes = new WeakMap<readonly SearchableItem[], Fuse<SearchableItem>>();

function fuzzyIndex<T extends SearchableItem>(items: readonly T[]): Fuse<T> {
    let index = fuzzyIndexes.get(items);
    if (!index) {
        index = new Fuse(items, {
            keys: ["label", "search", "id"],
            threshold: FUZZY_THRESHOLD,
            // The word somebody wants is rarely the first one in the id, so where
            // in the string it matched must not decide whether it matched at all.
            ignoreLocation: true
        });
        fuzzyIndexes.set(items, index);
    }
    return index as Fuse<T>;
}

/**
 * The entries matching what somebody typed, best first.
 *
 * "Best" is where the match starts: an operator typing "diamond" wants the
 * diamond before the diamond-encrusted everything else, and a list that buries it
 * under `block_of_diamond` is one they scroll past their own answer in. So what
 * literally contains the query is ranked first and by exactly that rule.
 *
 * A typo contains nothing, though, and "dimaond" is the query that made this a
 * search box rather than a filter. So a query that matched nothing literally is
 * asked of a fuzzy index instead of coming back empty.
 *
 * Only then. Fuzzy hits appended to a literal answer would mean "diamond sw" -
 * which names one item exactly - dragging in every other diamond behind it, and
 * an operator who typed enough to be precise should be answered precisely.
 */
export function searchCatalog<T extends SearchableItem>(items: readonly T[], query: string, limit: number): T[] {
    const needle = query.trim().toLowerCase().replace(/[\s_]+/g, " ");
    if (needle.length === 0) return items.slice(0, limit);
    const scored: { item: T; score: number }[] = [];
    for (const item of items) {
        const haystack = item.search.replace(/_/g, " ");
        const at = haystack.indexOf(needle);
        if (at === -1) continue;
        // Exact, then starts-with, then a word boundary, then anywhere.
        const score = item.label.toLowerCase() === needle ? 0 : at === 0 ? 1 : haystack[at - 1] === " " ? 2 : 3;
        scored.push({ item, score });
    }
    scored.sort((left, right) => left.score - right.score || left.item.label.localeCompare(right.item.label));
    if (scored.length > 0) return scored.slice(0, limit).map((entry) => entry.item);
    return fuzzyIndex(items)
        .search(needle, { limit })
        .map((hit) => hit.item);
}
