/**
 * The list of mods an ARK server runs, and the order it runs them in.
 *
 * ARK loads mods in the order the list gives them and later ones override earlier
 * ones, so this is a sequence rather than a set: two mods that both change the
 * same creature behave differently depending on which is second, and "reorder" is
 * a real operation rather than a tidying-up. That is why nothing here sorts.
 *
 * The list itself is one environment variable the image hands to arkmanager, which
 * installs each id from the Workshop when the server starts. Polaris keeps that
 * variable as the truth and never edits arkmanager's own copy: two places holding
 * the same list is two places to disagree.
 *
 * Pure, so the screen and the action agree about what a mod id is.
 */

/** A Workshop id: all digits, and long enough not to be somebody's typo. */
const MOD_ID = /^\d{6,12}$/;

/** Enough for the heaviest modded server anybody sensibly runs, and a ceiling so
 *  one paste cannot turn a start into an hour of downloads. */
export const MAX_MODS = 40;

export function isModId(value: string): boolean {
    return MOD_ID.test(value.trim());
}

/**
 * The ids in a list, in order, without the ones that are not ids.
 *
 * The variable is edited by hand on plenty of servers, so it may hold spaces,
 * empty entries or a trailing comma; none of those are a mod.
 */
export function parseModIds(value: string | null | undefined): string[] {
    const ids: string[] = [];
    for (const entry of (value ?? "").split(",")) {
        const id = entry.trim();
        if (!MOD_ID.test(id) || ids.includes(id)) continue;
        ids.push(id);
    }
    return ids.slice(0, MAX_MODS);
}

/** The list as the image wants it: the numbers, comma separated, nothing else. */
export function formatModIds(ids: readonly string[]): string {
    return ids.join(",");
}

/** The list with one more mod at the end, which is where a new one loads last and
 *  so wins over everything before it - what somebody adding a mod expects. */
export function withMod(ids: readonly string[], id: string): string[] {
    const wanted = id.trim();
    if (!MOD_ID.test(wanted)) throw new Error("That is not a Steam Workshop id");
    if (ids.includes(wanted)) return [...ids];
    if (ids.length >= MAX_MODS) throw new Error(`A server can run ${MAX_MODS} mods at most`);
    return [...ids, wanted];
}

export function withoutMod(ids: readonly string[], id: string): string[] {
    return ids.filter((entry) => entry !== id.trim());
}

/**
 * The list with one mod moved a place earlier or later.
 *
 * `-1` earlier, `1` later. A mod at either end stays where it is rather than
 * wrapping around: a list that jumped from top to bottom under somebody's finger
 * would be a load order changed by accident.
 */
export function movedMod(ids: readonly string[], id: string, direction: -1 | 1): string[] {
    const at = ids.indexOf(id.trim());
    const to = at + direction;
    if (at === -1 || to < 0 || to >= ids.length) return [...ids];
    const moved = [...ids];
    const [taken] = moved.splice(at, 1);
    moved.splice(to, 0, taken as string);
    return moved;
}
