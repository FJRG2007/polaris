/**
 * The pure half of the folding permission lists (`PermissionSections`): filing
 * entries under their area, and narrowing the areas to what a search names.
 *
 * Kept apart from the component so the matching rules - label or key, case and
 * accents ignored, an area with nothing left hidden - are asserted without a
 * renderer.
 */

/** One entry in a section: its key (a permission id) and its name on screen. */
export interface SectionItem {
    readonly id: string;
    readonly label: string;
}

export interface Section<T extends SectionItem> {
    readonly id: string;
    readonly label: string;
    readonly items: readonly T[];
}

/** Entries filed under their area, areas and entries kept in first-seen order. */
export function groupByArea<T>(items: readonly T[], areaOf: (item: T) => string): [string, T[]][] {
    const grouped = new Map<string, T[]>();
    for (const item of items) {
        const area = areaOf(item);
        const bucket = grouped.get(area);
        if (bucket) bucket.push(item);
        else grouped.set(area, [item]);
    }
    return [...grouped];
}

/** How many of `items` are in `held`. */
export function heldCount<Id extends string>(
    held: ReadonlySet<Id>,
    items: readonly { readonly id: Id }[]
): number {
    return items.filter((item) => held.has(item.id)).length;
}

/** Whether `held` has some of `items` but not all - where a decision was made,
 *  since all or none says itself in a count. */
export function partlyHeld<Id extends string>(
    held: ReadonlySet<Id>,
    items: readonly { readonly id: Id }[]
): boolean {
    const count = heldCount(held, items);
    return count > 0 && count < items.length;
}

/** Lower case with the accents taken off, so "edicion" finds "Edición". */
export function foldText(text: string): string {
    return text
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase();
}

/**
 * The sections with only the entries that pass `keep` and match `query` - on the
 * entry's label, its key, or the section's own name, which brings the whole area.
 * A section with nothing left is dropped. With no query and no `keep`, the input
 * comes back as it is.
 */
export function filterSections<T extends SectionItem>(
    sections: readonly Section<T>[],
    query: string,
    keep?: (item: T) => boolean
): Section<T>[] {
    const needle = foldText(query.trim());
    if (!needle && !keep) return [...sections];
    const result: Section<T>[] = [];
    for (const section of sections) {
        const sectionMatches = needle !== "" && foldText(section.label).includes(needle);
        const items = section.items.filter(
            (item) =>
                (!keep || keep(item)) &&
                (!needle ||
                    sectionMatches ||
                    foldText(item.label).includes(needle) ||
                    foldText(item.id).includes(needle))
        );
        if (items.length > 0) result.push({ ...section, items });
    }
    return result;
}

/** Which sections are open: the reader's own choice where they made one, the
 *  caller's default where they did not. */
export function openSections(
    ids: readonly string[],
    chosen: Readonly<Record<string, boolean>>,
    startOpen: (id: string) => boolean
): Set<string> {
    return new Set(ids.filter((id) => chosen[id] ?? startOpen(id)));
}

/** A stored choice map read back, anything that is not one discarded. */
export function parseChosen(raw: string | null): Record<string, boolean> {
    if (!raw) return {};
    try {
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== "object" || Array.isArray(value)) return {};
        const chosen: Record<string, boolean> = {};
        for (const [key, open] of Object.entries(value)) {
            if (typeof open === "boolean") chosen[key] = open;
        }
        return chosen;
    } catch {
        return {};
    }
}
