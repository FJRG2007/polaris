/**
 * The notes screen as this device has it: what the server sent, with the
 * writes still kept here laid over it (`offline-writes`) - a note made offline
 * is in the tree, one moved is where it was moved to, one deleted is gone, and
 * each of them carries whether it is still waiting or was not taken.
 *
 * Pure, so the overlay is tested without a browser or a server.
 */

import type { ShelfData } from "./note-tree";
import type { AppWrite } from "@/lib/offline/app-writes";
import type { NoteSummary, NoteView } from "@/lib/notes/note-service";

export const NOTE_TEXT = "note.text";
export const NOTE_CREATE = "note.create";
export const NOTE_MOVE = "note.move";
export const NOTE_DELETE = "note.delete";

/** What a create is sent with: the action's own input, plus the id it is made with. */
export interface NoteCreatePayload {
    readonly id: string;
    readonly title: string;
    readonly body: string;
    readonly spaceId?: string | null;
    readonly folderId?: string | null;
    readonly parentId?: string | null;
    readonly templateId?: string;
}

export interface NoteMovePayload {
    readonly noteId: string;
    readonly parentId: string | null;
    readonly spaceId: string | null;
    readonly folderId: string | null;
}

/** A row of the tree, with what this device still holds for it. */
export type TreeNote = NoteSummary & {
    /** A write for it is waiting for Polaris, or Polaris did not take one. */
    readonly offline?: "pending" | "failed";
    /** Made here and not sent: the server does not have it yet. */
    readonly unsent?: boolean;
};

/** Whether a write is shown as waiting. A note's text is always kept before it
 *  is sent, so it only counts once it has failed to reach Polaris. */
function shownState(entry: AppWrite): "pending" | "failed" | null {
    if (entry.state === "failed") return "failed";
    if (entry.kind === NOTE_TEXT) return entry.attempts > 0 ? "pending" : null;
    return "pending";
}

const shelfOf = (shelf: ShelfData): string | null => shelf.space?.id ?? null;

/** The shelves with every kept write laid over them, oldest first. */
export function withNoteWrites(shelves: readonly ShelfData[], entries: readonly AppWrite[]): ShelfData[] {
    if (entries.length === 0) return [...shelves];
    const notes = new Map<string | null, TreeNote[]>(shelves.map((shelf) => [shelfOf(shelf), [...shelf.notes]]));
    const states = new Map<string, "pending" | "failed">();
    const unsent = new Set<string>();

    const find = (noteId: string): { shelf: string | null; at: number } | null => {
        for (const [shelf, list] of notes) {
            const at = list.findIndex((note) => note.id === noteId);
            if (at >= 0) return { shelf, at };
        }
        return null;
    };
    const take = (noteId: string): TreeNote | null => {
        const found = find(noteId);
        return found ? notes.get(found.shelf)!.splice(found.at, 1)[0]! : null;
    };
    /** Newest first, after the pinned ones, as the server orders a shelf. */
    const put = (shelf: string | null, note: TreeNote): void => {
        const list = notes.get(shelf);
        if (!list) return;
        const at = list.findIndex((other) => !other.pinned);
        list.splice(at < 0 ? list.length : at, 0, note);
    };

    for (const entry of entries) {
        const state = shownState(entry);
        if (state && states.get(entry.target) !== "failed") states.set(entry.target, state);
        if (entry.kind === NOTE_CREATE) {
            const made = entry.payload as NoteCreatePayload;
            if (find(made.id)) continue;
            unsent.add(made.id);
            put(made.spaceId ?? null, {
                id: made.id,
                title: made.title,
                excerpt: "",
                pinned: false,
                parentId: made.parentId ?? null,
                folderId: made.folderId ?? null,
                depth: 0,
                hasChildren: false,
                updatedAt: entry.createdAt
            });
        } else if (entry.kind === NOTE_MOVE) {
            const move = entry.payload as NoteMovePayload;
            const note = take(move.noteId);
            if (note) put(move.spaceId, { ...note, parentId: move.parentId, folderId: move.folderId });
        } else if (entry.kind === NOTE_DELETE) {
            // One Polaris refused is drawn again, with why, until it is retried.
            if (entry.state === "pending") take(entry.target);
        } else if (entry.kind === NOTE_TEXT) {
            const found = find(entry.target);
            const title = (entry.payload as { title?: unknown }).title;
            if (found && typeof title === "string") {
                const list = notes.get(found.shelf)!;
                list[found.at] = { ...list[found.at]!, title };
            }
        }
    }

    return shelves.map((shelf) => {
        const list = notes.get(shelfOf(shelf)) ?? [];
        const present = new Set(list.map((note) => note.id));
        // A note whose parent is not on the shelf any more sits at the top, as
        // the server draws it; one under a note moved away follows the server too.
        const placed = list.map((note) =>
            note.parentId && !present.has(note.parentId) ? { ...note, parentId: null } : note
        );
        const parents = new Set(placed.map((note) => note.parentId));
        return {
            ...shelf,
            notes: placed.map((note): TreeNote => {
                const state = states.get(note.id);
                return {
                    ...note,
                    hasChildren: parents.has(note.id),
                    ...(state ? { offline: state } : {}),
                    ...(unsent.has(note.id) ? { unsent: true } : {})
                };
            })
        };
    });
}

/**
 * A note made on this device, drawn from what it was made with: one still
 * waiting to be sent, or one sent while this page was open (`made`), until the
 * page has it from the server.
 */
export function localNote(
    entries: readonly AppWrite[],
    made: ReadonlyMap<string, AppWrite>,
    noteId: string | null
): NoteView | null {
    if (!noteId) return null;
    const entry = entries.find((one) => one.kind === NOTE_CREATE && one.target === noteId) ?? made.get(noteId);
    if (!entry) return null;
    const note = entry.payload as NoteCreatePayload;
    return {
        id: note.id,
        title: note.title,
        body: note.body,
        pinned: false,
        parentId: note.parentId ?? null,
        spaceId: note.spaceId ?? null,
        folderId: note.folderId ?? null,
        updatedAt: entry.createdAt
    };
}

/** Whether a delete of this note is waiting on this device. */
export function deletedHere(entries: readonly AppWrite[], noteId: string | null): boolean {
    return (
        noteId !== null &&
        entries.some((entry) => entry.kind === NOTE_DELETE && entry.target === noteId && entry.state === "pending")
    );
}

/** The write that holds this note up and was not taken: its create, move or
 *  delete. Its text has a banner of its own. */
export function failedPlacement(entries: readonly AppWrite[], noteId: string | null): AppWrite | null {
    if (!noteId) return null;
    return (
        entries.find(
            (entry) => entry.target === noteId && entry.kind !== NOTE_TEXT && entry.state === "failed"
        ) ?? null
    );
}
