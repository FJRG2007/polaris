/**
 * The shapes a name clash travels in between the server and the Drive screen.
 * Types only, so the client can import them without pulling server code.
 */

/** What to do with one arrival whose name is taken. */
export type ConflictChoice = "replace" | "keepBoth" | "merge" | "skip";

/**
 * Why "Replace" (or "Merge") is not on offer for a clash: no write access to
 * the item there, it is behind a lock, one is a file and the other a folder,
 * or a folder being moved or copied (which keeps both rather than merging).
 */
export type ReplaceBlocked = "permission" | "locked" | "kind" | "merge";

/** One clash, as the person deciding it needs to see it. */
export interface ClashView {
    /** The path the arrival asked for, relative to the folder it was sent to. */
    readonly path: string;
    readonly incomingKind: "file" | "dir";
    /** The name already there, in its own spelling ("Report.pdf" for "report.pdf"). */
    readonly existingName: string;
    readonly existingKind: "file" | "dir";
    /** Whether "Replace" (a file) or "Merge" (a folder) may be offered. */
    readonly canReplace: boolean;
    readonly replaceBlocked: ReplaceBlocked | null;
    /** Whether a replaced file goes to the bin (true) or is gone for good. */
    readonly recoverable: boolean;
}

/** The body of a 409 from the upload route, and of a conflict from a move or copy. */
export interface NameConflictAnswer {
    readonly error: "name_conflict";
    readonly clash: ClashView;
}

/** How many arrivals one clash check takes; a larger folder upload is asked in pieces. */
export const MAX_CLASH_ENTRIES = 2000;
