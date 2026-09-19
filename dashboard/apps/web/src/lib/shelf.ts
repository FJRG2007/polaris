/**
 * The shelf of the header switch, as one string both ends agree on.
 *
 * `personal`, or an organization's id - the value `ShelfScopeProvider` hands
 * the client and the value a notification row stores. Pure, so the browser and
 * the server import the same rule rather than each writing it out.
 *
 * What a badge counts has to be what opening the app shows. Every app lists one
 * shelf at a time, so a count taken across all of them is a number the app then
 * refuses to explain: Mail said three were waiting, and opening Mail showed an
 * empty inbox because the three were in a company mailbox on another shelf.
 */

/** The account's own shelf. */
export const PERSONAL_SHELF = "personal";

/** The shelf an organization id (or none) is on. */
export function shelfKey(orgId: string | null): string {
    return orgId ?? PERSONAL_SHELF;
}

/**
 * Whether a notification belongs on the shelf that is open.
 *
 * The rule, in one place: a row about the account itself - stored with no
 * shelf, which is also every row written before shelves were recorded - is
 * shown on every shelf; a row about work on a shelf is shown on that shelf only.
 */
export function onShelf(stored: string | null, open: string): boolean {
    return stored === null || stored === open;
}

/** The same rule, as a filter on the notification table. */
export function shelfFilter(open: string): { OR: [{ shelf: null }, { shelf: string }] } {
    return { OR: [{ shelf: null }, { shelf: open }] };
}
