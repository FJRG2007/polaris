/**
 * Handing writing back.
 *
 * A note, a folder, or a whole notebook, as a zip of Markdown files arranged the
 * way a vault is on disk. It is the mirror of the import and it exists for the
 * same reason the body is stored as Markdown in the first place: what somebody
 * wrote is theirs, and a place they cannot get it out of is a place they should
 * not have put it.
 *
 * The layout is decided by `@polaris/core/notes-export`, which is pure and
 * tested. What is here is which rows to read - and that is the half with the
 * teeth in it, because an export is the one operation that reads everything at
 * once, so a scope that is one row too wide is a scope that hands somebody a
 * notebook they were never on.
 */

import * as access from "./access";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";

/** What is being taken out. A space of null is the private shelf, which is the
 *  same thing everywhere else in notes. */
export type ExportScope =
    | { kind: "note"; id: string }
    | { kind: "folder"; id: string }
    | { kind: "space"; id: string | null };

export interface Archive {
    /** What the browser will call the download. */
    readonly name: string;
    readonly bytes: Uint8Array;
    readonly notes: number;
}

const SELECT = {
    id: true,
    title: true,
    body: true,
    frontmatter: true,
    folderId: true,
    parentId: true
} as const;

/**
 * Read a scope out and pack it.
 *
 * Every branch checks its own access first and then reads only what that check
 * covered - never the other way round, which is how a listing that was allowed
 * for one row ends up returning the shelf it sits on.
 */
export async function exportArchive(actor: access.NoteActor, scope: ExportScope): Promise<Archive> {
    const { notes, folders, name } = await gather(actor, scope);
    const files = core.layOutExport(notes, folders);

    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    for (const file of files) zip.file(file.path, file.text);
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    return { name: `${core.fileNameFor(name)}.zip`, bytes, notes: files.length };
}

async function gather(
    actor: access.NoteActor,
    scope: ExportScope
): Promise<{ notes: core.ExportableNote[]; folders: core.ExportableFolder[]; name: string }> {
    if (scope.kind === "note") {
        const note = await access.requireNote(actor, scope.id, "guest");
        // The subtree, because the notes under one are part of it: exporting a
        // page and leaving its pages behind is not exporting the page.
        const shelf = await notesOnShelf(actor, note.spaceId);
        const wanted = subtreeOf(scope.id, shelf);
        const root = wanted.find((entry) => entry.id === scope.id);
        return {
            // Re-rooted: what comes out is this note at the top of the archive,
            // not a tree of empty folders leading down to it.
            notes: wanted.map((entry) =>
                entry.id === scope.id ? { ...entry, parentId: null, folderId: null } : entry
            ),
            folders: [],
            name: root?.title ?? "Note"
        };
    }

    if (scope.kind === "folder") {
        const folder = await access.requireFolder(actor, scope.id, "guest");
        const [shelfFolders, shelfNotes] = await Promise.all([
            foldersOnShelf(actor, folder.spaceId),
            notesOnShelf(actor, folder.spaceId)
        ]);
        const branch = core.folderBranch(shelfFolders, scope.id);
        const kept = shelfFolders
            .filter((entry) => branch.has(entry.id))
            // The folder being exported is the root of the archive rather than a
            // directory inside one named after its parent.
            .map((entry) => (entry.id === scope.id ? { ...entry, parentId: null } : entry));
        const name = shelfFolders.find((entry) => entry.id === scope.id)?.name ?? "Folder";
        return {
            notes: shelfNotes.filter((note) => note.folderId !== null && branch.has(note.folderId)),
            folders: kept,
            name
        };
    }

    // A whole shelf. The private one is the caller's own by definition; a
    // notebook has to be one they may read.
    if (scope.id) await access.requireSpace(actor, scope.id, "guest");
    const [folders, notes] = await Promise.all([
        foldersOnShelf(actor, scope.id),
        notesOnShelf(actor, scope.id)
    ]);
    const name = scope.id
        ? ((await prisma.noteSpace.findUnique({ where: { id: scope.id }, select: { name: true } }))?.name ??
          "Notebook")
        : "My notes";
    return { notes, folders, name };
}

/** Every note on one shelf. The private shelf is filtered by the account asking,
 *  without exception - the same clause every other read of it uses. */
async function notesOnShelf(
    actor: access.NoteActor,
    spaceId: string | null
): Promise<core.ExportableNote[]> {
    return prisma.note.findMany({
        where: spaceId
            ? { spaceId, archived: false }
            : { spaceId: null, userId: actor.id, archived: false },
        orderBy: [{ title: "asc" }],
        select: SELECT
    });
}

async function foldersOnShelf(
    actor: access.NoteActor,
    spaceId: string | null
): Promise<core.ExportableFolder[]> {
    return prisma.noteFolder.findMany({
        where: spaceId ? { spaceId, archived: false } : { spaceId: null, ownerId: actor.id, archived: false },
        orderBy: [{ order: "asc" }, { name: "asc" }],
        select: { id: true, name: true, parentId: true }
    });
}

/** A note and everything under it. */
function subtreeOf(noteId: string, notes: readonly core.ExportableNote[]): core.ExportableNote[] {
    const children = new Map<string, core.ExportableNote[]>();
    for (const note of notes) {
        if (!note.parentId) continue;
        const bucket = children.get(note.parentId) ?? [];
        bucket.push(note);
        children.set(note.parentId, bucket);
    }
    const root = notes.find((note) => note.id === noteId);
    if (!root) return [];
    const found: core.ExportableNote[] = [];
    const stack = [root];
    while (stack.length > 0) {
        const at = stack.pop()!;
        if (found.some((entry) => entry.id === at.id)) continue;
        found.push(at);
        for (const child of children.get(at.id) ?? []) stack.push(child);
    }
    return found;
}
