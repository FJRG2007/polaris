/**
 * What a place can be, and what one looks like on screen.
 *
 * Split from the service because a dialog needs the list of kinds and a screen
 * needs the shape of a place, and the service imports the database - a client
 * component that reaches for either would drag Prisma into the browser bundle,
 * which is a build failure with a stack trace that names none of this.
 *
 * Pure and client-safe.
 */

/** The kinds, which are only ever a label and an icon. Nothing behaves
 *  differently - they are here because "Warehouse" and "Mum's" read better with
 *  the right symbol beside them. */
export const PLACE_KINDS = ["house", "office", "site", "other"] as const;

export type PlaceKind = (typeof PLACE_KINDS)[number];

export const PLACE_KIND_LABELS: Readonly<Record<PlaceKind, string>> = {
    house: "Home",
    office: "Office",
    site: "Site",
    other: "Somewhere else"
};

/** A place as a screen sees it. */
export interface PlaceView {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    readonly address: string;
    /** How many cameras are in it, for the switcher and the list. */
    readonly cameras: number;
}
