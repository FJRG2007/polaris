/**
 * Bringing a vault of Markdown in.
 *
 * The decisions are all in `@polaris/core/notes-import`, which is pure and
 * tested: what the folders will be, what each note is called, what its
 * frontmatter was, and which of its links point at something else in the same
 * import. What is here is the writing, in three passes.
 *
 * 1. The folders, shallowest first, so a child always has its parent's id.
 * 2. The notes, with ids minted here so a few thousand of them cost a handful of
 *    statements instead of one round trip each.
 * 3. The links, once every note has an id - `[[Another note]]` cannot become an
 *    address until the thing it names exists.
 *
 * Nothing is written outside the shelf the caller was allowed to write to, and
 * the destination folder is checked before any of it: an import is thousands of
 * rows, and one that landed in the wrong notebook is not undone by a button.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { randomUUID } from "node:crypto";

/** What an import did, for the screen that reports it. */
export interface ImportResult {
    readonly notes: number;
    readonly folders: number;
    /** Links between imported notes that now work as Polaris references. */
    readonly links: number;
    readonly skipped: readonly core.SkippedFile[];
}

/** How many rows go in one statement. Large enough that a real vault is a few
 *  statements, small enough that one of them is not a query the database has to
 *  be talked into accepting. */
const CHUNK = 200;

function chunked<T>(rows: readonly T[]): T[][] {
    const out: T[][] = [];
    for (let at = 0; at < rows.length; at += CHUNK) out.push(rows.slice(at, at + CHUNK));
    return out;
}

/**
 * Read a set of files onto a shelf.
 *
 * `files` is whatever the caller unpacked - a handful of `.md` files, or every
 * entry of a zipped vault. Their paths are what the folder tree is built from
 * and what the links are resolved against, so they must be the paths inside the
 * vault rather than the ones on the uploader's disk.
 */
export async function importVault(
    ownerId: string,
    input: core.NoteImportInput,
    files: readonly core.ImportFile[]
): Promise<ImportResult> {
    const plan = core.planImport(files, {
        keepFolders: input.keepFolders,
        maxFiles: core.NOTE_IMPORT_MAX_FILES
    });
    if (plan.notes.length === 0) {
        return { notes: 0, folders: 0, links: 0, skipped: plan.skipped };
    }

    // 1. The folders. `plan.folders` is parents-first, so the parent's id is
    //    always already in the map by the time a child needs it.
    const folderIds = new Map<string, string>();
    const folderRows = plan.folders.map((path) => {
        const id = randomUUID();
        folderIds.set(path, id);
        const cut = path.lastIndexOf("/");
        return {
            id,
            ownerId,
            spaceId: input.spaceId,
            parentId: cut === -1 ? input.folderId : (folderIds.get(path.slice(0, cut)) ?? input.folderId),
            name: path.slice(cut + 1),
            order: core.ORDER_STEP
        };
    });

    // 2. The notes.
    const noteIds = new Map<string, string>();
    const noteRows = plan.notes.map((note) => {
        const id = randomUUID();
        noteIds.set(note.path, id);
        return {
            id,
            userId: ownerId,
            spaceId: input.spaceId,
            folderId: note.folder ? (folderIds.get(note.folder) ?? input.folderId) : input.folderId,
            title: note.title,
            body: note.body,
            frontmatter: note.frontmatter
        };
    });

    await prisma.$transaction([
        ...chunked(folderRows).map((rows) => prisma.noteFolder.createMany({ data: rows })),
        ...chunked(noteRows).map((rows) => prisma.note.createMany({ data: rows }))
    ]);

    // 3. The links, now that every one of them names something with an id.
    const index = core.linkIndex(plan.notes);
    const resolve = (target: string) => {
        const path = index.get(target);
        return path ? (noteIds.get(path) ?? null) : null;
    };
    const rewritten = plan.notes
        .map((note) => ({ id: noteIds.get(note.path)!, body: core.rewriteWikilinks(note.body, resolve) }))
        .filter((row, at) => row.body !== plan.notes[at]!.body);

    if (rewritten.length > 0) {
        // One statement each, and only for the notes that actually changed: a
        // vault where nothing links to anything writes nothing here at all.
        for (const chunk of chunked(rewritten)) {
            await prisma.$transaction(
                chunk.map((row) => prisma.note.update({ where: { id: row.id }, data: { body: row.body } }))
            );
        }
    }

    return {
        notes: noteRows.length,
        folders: folderRows.length,
        links: rewritten.length,
        skipped: plan.skipped
    };
}
