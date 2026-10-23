/**
 * "Filter settings": which cards of a settings page match what was typed, and
 * so which sections still have something to show.
 *
 * A card is found by the words on it in the reader's language (its title and
 * its one-line description, as drawn) and by the keywords its page declares for
 * it in English and Spanish, so "cabeceras" finds Security headers on an English
 * screen and "headers" finds it on a Spanish one. Pure, so the matching is
 * asserted without a browser.
 */

/** What a page declares about one card: the section it sits in, and the extra
 *  words it is found by. */
export interface SettingsIndexEntry {
    readonly section: string;
    readonly keywords: { readonly en: readonly string[]; readonly es: readonly string[] };
}

/** Every card of a page, by its entry id. */
export type SettingsIndex = Readonly<Record<string, SettingsIndexEntry>>;

/** The words a mounted card shows, as it registered them. */
export interface MountedCard {
    readonly entry: string;
    readonly text: string;
}

/** Lowercase, without accents, with runs of spacing folded: "Cabeceras  de
 *  SEGURIDAD" and "cabeceras de seguridad" are the same search. */
export function foldText(text: string): string {
    return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Whether every word of the query appears somewhere in the haystack. */
export function matchesQuery(haystack: string, query: string): boolean {
    const words = foldText(query).split(" ").filter(Boolean);
    if (words.length === 0) return true;
    const folded = foldText(haystack);
    return words.every((word) => folded.includes(word));
}

/** What a filter leaves on the page: the cards that match and the sections
 *  holding at least one of them. With nothing typed, everything mounted. */
export function filterSettings(
    index: SettingsIndex,
    mounted: readonly MountedCard[],
    query: string
): { cards: Set<string>; sections: Set<string> } {
    const cards = new Set<string>();
    const sections = new Set<string>();
    for (const card of mounted) {
        const declared = index[card.entry];
        if (!declared) continue;
        const haystack = [card.text, ...declared.keywords.en, ...declared.keywords.es].join(" ");
        if (!matchesQuery(haystack, query)) continue;
        cards.add(card.entry);
        sections.add(declared.section);
    }
    return { cards, sections };
}
