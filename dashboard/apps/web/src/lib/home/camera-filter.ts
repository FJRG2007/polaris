/**
 * Narrowing a list of cameras down to the ones being looked for.
 *
 * A house of four cameras needs none of this and a house of thirty needs all of
 * it. The two questions people actually arrive with are "where is the one by the
 * garage" and "show me everything outside", so the list answers both: a name to
 * type and an area to pick.
 *
 * Typed against more than the name on purpose. Somebody who set a camera up an
 * hour ago is as likely to remember its address as its name, and somebody
 * looking for the one in the garden may have called it "Back door" and put it in
 * an area called "Garden" - matching only the name would show them nothing and
 * teach them the search is broken.
 *
 * Pure, so the ordering and the edge cases are tests rather than something to
 * confirm by squinting at a list.
 */

/** The few fields the filtering reads. Structural, so any camera shape fits. */
export interface FilterableCamera {
    readonly name: string;
    readonly zone: string;
    readonly address: string;
}

/** What the area picker offers, for a list of cameras. */
export interface ZoneChoice {
    /** The area's name, or "" for the cameras that are in none. */
    readonly zone: string;
    readonly count: number;
}

/** Everything an area picker needs: the areas in use, alphabetically, with the
 *  unassigned ones last - they are a residue rather than a place, and sorting
 *  them into the middle under an empty name reads as a bug. */
export function zonesOf(cameras: readonly FilterableCamera[]): readonly ZoneChoice[] {
    const counts = new Map<string, number>();
    for (const camera of cameras) {
        const zone = camera.zone.trim();
        counts.set(zone, (counts.get(zone) ?? 0) + 1);
    }
    return [...counts.entries()]
        .map(([zone, count]) => ({ zone, count }))
        .sort((left, right) => {
            if (left.zone === "") return 1;
            if (right.zone === "") return -1;
            return left.zone.localeCompare(right.zone, undefined, { sensitivity: "base" });
        });
}

/** Whether one camera survives what was typed. Every word has to match
 *  something, so a second word narrows rather than widens - which is what
 *  somebody typing "garden door" means by it. */
function matches(camera: FilterableCamera, words: readonly string[]): boolean {
    if (words.length === 0) return true;
    const haystack = [camera.name, camera.zone, camera.address].map((value) =>
        value.trim().toLowerCase()
    );
    return words.every((word) => haystack.some((value) => value.includes(word)));
}

/**
 * The cameras still worth showing.
 *
 * `zone` is an exact area name, or null for all of them. It is exact rather than
 * matched, because it comes from a picker built out of the areas that exist - a
 * fuzzy match there would let "Out" mean both "Outside" and "Outbuilding" with
 * no way to say which.
 */
export function filterCameras<T extends FilterableCamera>(
    cameras: readonly T[],
    filter: { query?: string; zone?: string | null } = {}
): readonly T[] {
    const words = (filter.query ?? "")
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
    const zone = filter.zone;
    return cameras.filter((camera) => {
        if (zone !== null && zone !== undefined && camera.zone.trim() !== zone) return false;
        return matches(camera, words);
    });
}
