/**
 * Searching a game's catalogue of things.
 *
 * Every game panel that hands somebody an item ends up with the same problem: a
 * grid of a thousand pictures nobody scrolls, a search box, and an operator who
 * types "dimaond". The ranking below is what turns that into an answer, and it is
 * here rather than in one game's module because Minecraft and ARK both need it and
 * neither should be the other's dependency. It is in this package rather than
 * offered by the dashboard's server host because it runs in the browser, on
 * every keystroke of an item picker, where that host does not exist.
 *
 * The entries are whatever a catalogue holds, as long as it can say what a thing
 * is called and what words find it.
 */

import { searchItems, type SearchField } from "./search-text.js";

export interface SearchableItem {
    /** What the caller sends to the game. Only used here to break ties. */
    readonly id: string;
    readonly label: string;
    /** Lowercase words, so "diamond sword" and "diamond_sword" both match. */
    readonly search: string;
    /**
     * How far down to put it among equally good matches. Zero unless a catalogue
     * says otherwise.
     *
     * What it is actually for: an entry nobody has a picture of draws as an empty
     * box, and a grid whose first rows are empty boxes looks broken even when
     * every one of them is a real thing. So a catalogue can push those behind the
     * ones that draw, without either of them being a better answer to the query.
     */
    readonly rank?: number;
    /**
     * Where the entry came from, when the catalogue is more than one source.
     *
     * Minecraft's is vanilla plus whatever the server's mods add, and a tile is
     * 40 pixels of texture: two mods' versions of the same thing are otherwise
     * indistinguishable. Absent for an entry that came from the game itself,
     * which is the ordinary case and needs no caption.
     */
    readonly from?: string;
}

/**
 * Where a catalogue entry is read: what it is called first, then its search
 * words, then its id. The label is the title, so it is the one a typo such as
 * "dimaond" is forgiven in.
 */
const CATALOG_FIELDS: readonly SearchField<SearchableItem>[] = [
    { text: (item) => item.label, weight: 3 },
    { text: (item) => item.search, weight: 2 },
    { text: (item) => item.id, weight: 1 }
];

/**
 * The entries matching what somebody typed, best first.
 *
 * "Best" is where the match starts: an operator typing "diamond" wants the
 * diamond before the diamond-encrusted everything else, and a list that buries it
 * under `block_of_diamond` is one they scroll past their own answer in. So the
 * entry called exactly that comes first, then the ones a word of whose name
 * starts with it, then the rest - and among equals, the ones that draw a picture
 * before the empty boxes, then by name.
 *
 * A typo is forgiven only when nothing matched as typed, so "diamond sw" - which
 * names one item exactly - is answered precisely, and "dimaond" still finds it.
 */
export function searchCatalog<T extends SearchableItem>(
    items: readonly T[],
    query: string,
    limit: number
): T[] {
    return searchItems<T>(items, query, CATALOG_FIELDS, {
        limit,
        tieBreak: (left, right) =>
            (left.rank ?? 0) - (right.rank ?? 0) || left.label.localeCompare(right.label)
    });
}
