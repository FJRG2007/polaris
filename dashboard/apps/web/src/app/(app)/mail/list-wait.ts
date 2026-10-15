import { LIST_NOT_LOADED } from "./use-mail-list";

/**
 * What an empty list is waiting on, decided apart from the screen so the rule
 * that ends the skeleton can be held to its cases.
 *
 * "Still fetching" holds only while something is still on its way: a mailbox
 * feeding the list has not finished its first pass yet, or the server still
 * says there is more to bring down and the last reach for it did not fail.
 * Once both have answered, an empty list is an empty list.
 */
export interface ListWaitInput {
    /** A search, a tab or a filter: those may come back empty out of a full folder. */
    readonly narrowed: boolean;
    /** Rows on screen, first page and older together. */
    readonly shown: number;
    /** The folders feeding the list, with the server's own count. */
    readonly feeding: readonly { readonly accountId: string; readonly total: number }[];
    readonly accounts: readonly { readonly id: string; readonly lastSyncAt: unknown }[];
    /** The server's word that the folder holds mail this list does not have. */
    readonly cursor: string;
    /** The last reach for older mail failed. */
    readonly olderFailed: boolean;
    /** The list itself could not be loaded. */
    readonly listFailed: string | null;
}

export interface ListWait {
    /** Why there is nothing to draw, when it is a failure. */
    readonly failed: string | null;
    /** Rows are on their way: the skeleton under "fetching". */
    readonly fetching: boolean;
}

export function listWait(input: ListWaitInput): ListWait {
    const empty = input.shown === 0;
    const serverHolds = input.feeding.some((folder) => folder.total > 0);
    const firstPass = input.accounts.some(
        (account) =>
            account.lastSyncAt === null &&
            input.feeding.some((folder) => folder.accountId === account.id)
    );
    const waitingOnServer = firstPass || (input.cursor !== "" && !input.olderFailed);
    return {
        failed: input.listFailed ?? (input.olderFailed && empty ? LIST_NOT_LOADED : null),
        fetching: !input.narrowed && empty && serverHolds && waitingOnServer
    };
}

/**
 * The cursor after a reach for older mail. The same cursor back with nothing
 * new is the same question answered the same way: the marker would never fire
 * again for it, so it is the end of this list until the next refresh.
 */
export function nextCursor(asked: string, answered: string, fresh: number): string {
    return fresh === 0 && answered === asked ? "" : answered;
}
