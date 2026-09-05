/**
 * The vocabulary of what somebody can do with a saved item, and how each reads.
 *
 * Its own file because both sides need it and only one of them may import the
 * other: the screen that draws an item's history runs in a browser, and the
 * module that writes that history reaches the database. Putting the words beside
 * the writer would drag Prisma into the client bundle.
 */

/** The uses worth recording, and the only words the log accepts. */
export const ITEM_USES = ["reveal", "copy", "totp", "share"] as const;

export type ItemUse = (typeof ITEM_USES)[number];

/** How each reads on screen, from the point of view of somebody looking at their
 *  own item's history. */
export const ITEM_USE_LABELS: Record<ItemUse, string> = {
    reveal: "Showed the password",
    copy: "Copied the password",
    totp: "Took the six digits",
    share: "Made a share link"
};

/** One line of an item's history, ready to render. */
export interface ItemUseEntry {
    id: string;
    /** ISO 8601; the screen formats it with the reader's own preferences. */
    at: string;
    use: ItemUse;
    /** Who did it, already resolved to a name. */
    actor: string;
    /** Whether it was this account, so the screen can say "you". */
    isSelf: boolean;
}
