/**
 * Reading and writing notes.
 *
 * Every query here names a shelf, and a shelf is either a space or an account.
 * The private one - `spaceId: null` - is filtered by the account that asked,
 * without exception and without a permission to override it: there is no role
 * that reads another person's private notes, an instance administrator included.
 * That is not a policy applied on top of the data, it is the only way the data
 * is reached, so a future screen cannot forget it. A space's notes are reached
 * by the space, and whether this reader may open that space was settled in
 * `lib/notes/access.ts` before anything here ran.
 *
 * Notes nest, and the tree is assembled here rather than queried recursively.
 * One shelf is a few hundred rows at the outside, so a single read of the titles
 * costs less than the round trips a recursive walk would take, and the ordering
 * rules - pinned first, then most recently touched, applied among siblings
 * rather than globally - are one comparison instead of a query per level.
 *
 * **A nested note lives in its parent's folder.** Two ways of filing one thing
 * would let a note be in a folder and under a parent filed somewhere else, and
 * then there is no answer to where it is. So the folder follows the parent on
 * every write, and only a note at the top of its shelf is filed on its own.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";

/** A note as the list draws it: enough to choose one, not the whole text. */
export interface NoteSummary {
    readonly id: string;
    readonly title: string;
    /** The opening line, for telling two "Untitled" notes apart. */
    readonly excerpt: string;
    readonly pinned: boolean;
    readonly parentId: string | null;
    /** The folder it is filed in, or null for the top of its shelf. */
    readonly folderId: string | null;
    /** How far this sits from the top level, so the sidebar indents without
     *  having to rebuild the tree it was already given in order. */
    readonly depth: number;
    /** Whether anything sits under it, which decides the disclosure arrow. */
    readonly hasChildren: boolean;
    readonly updatedAt: string;
}

export interface NoteView {
    readonly id: string;
    readonly title: string;
    readonly body: string;
    readonly pinned: boolean;
    readonly parentId: string | null;
    readonly spaceId: string | null;
    readonly folderId: string | null;
    readonly updatedAt: string;
}

/** An archived note, as the archive lists it. No excerpt: the archive is read
 *  to find one thing and put it back, not to browse. */
export interface ArchivedNote {
    readonly id: string;
    readonly title: string;
    readonly updatedAt: string;
}

/** Which shelf a read is against. */
export interface Shelf {
    /** The account asking, which is what the private shelf is filtered by. */
    readonly userId: string;
    /** The space, or null for that account's own. */
    readonly spaceId: string | null;
}

/** Why a move was refused, in words the screen can show as they are. */
export type NoteMoveError =
    | "That note no longer exists"
    | "A note cannot go inside itself"
    | "That would nest notes too deeply"
    | "That folder is on a different notebook";

/** How much of a note the list shows underneath its title. */
const EXCERPT = 140;

interface Row {
    id: string;
    title: string;
    body: string;
    pinned: boolean;
    parentId: string | null;
    folderId: string | null;
    updatedAt: Date;
}

/** The clause that says "this shelf and no other". The private one carries the
 *  account; a space's does not, because a colleague's note on a shared shelf is
 *  the point of the shared shelf. */
function shelfWhere(shelf: Shelf) {
    return shelf.spaceId ? { spaceId: shelf.spaceId } : { spaceId: null, userId: shelf.userId };
}

/**
 * Every note on one shelf, in the order the sidebar draws them: depth-first from
 * the top level, siblings pinned-first and then most recently touched.
 *
 * A note whose parent is archived is drawn at the top level rather than
 * disappearing with it - archiving one note is not a statement about the notes
 * under it, and a child that vanished from both lists would be unreachable.
 */
export async function listNotes(shelf: Shelf): Promise<NoteSummary[]> {
    const rows = await prisma.note.findMany({
        where: { ...shelfWhere(shelf), archived: false },
        orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
        select: {
            id: true,
            title: true,
            body: true,
            pinned: true,
            parentId: true,
            folderId: true,
            updatedAt: true
        }
    });

    const present = new Set(rows.map((row) => row.id));
    const children = new Map<string | null, Row[]>();
    for (const row of rows) {
        // Already sorted by the query, so pushing in order keeps siblings sorted.
        const parent = row.parentId && present.has(row.parentId) ? row.parentId : null;
        const bucket = children.get(parent);
        if (bucket) bucket.push(row);
        else children.set(parent, [row]);
    }

    const ordered: NoteSummary[] = [];
    const walk = (parentId: string | null, depth: number) => {
        for (const row of children.get(parentId) ?? []) {
            const kids = children.get(row.id) ?? [];
            ordered.push({
                id: row.id,
                title: row.title,
                excerpt: excerptOf(row.body),
                pinned: row.pinned,
                // What the caller sees is where it is drawn, which is not the
                // stored column when the stored parent is archived.
                parentId,
                folderId: row.folderId,
                depth,
                hasChildren: kids.length > 0,
                updatedAt: row.updatedAt.toISOString()
            });
            walk(row.id, depth + 1);
        }
    };
    walk(null, 0);
    return ordered;
}

/** What has been put away, on every shelf this account can reach, most recently
 *  touched first. */
export async function listArchivedNotes(userId: string, spaceIds: readonly string[]): Promise<ArchivedNote[]> {
    const rows = await prisma.note.findMany({
        where: {
            archived: true,
            OR: [{ spaceId: null, userId }, { spaceId: { in: [...spaceIds] } }]
        },
        orderBy: { updatedAt: "desc" },
        select: { id: true, title: true, updatedAt: true }
    });
    return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }));
}

/** One note, by id. The caller has already been allowed to open it. */
export async function getNote(noteId: string): Promise<NoteView | null> {
    const note = await prisma.note.findFirst({
        where: { id: noteId, archived: false },
        select: {
            id: true,
            title: true,
            body: true,
            pinned: true,
            parentId: true,
            spaceId: true,
            folderId: true,
            updatedAt: true
        }
    });
    if (!note) return null;
    return { ...note, updatedAt: note.updatedAt.toISOString() };
}

/**
 * Write a new note.
 *
 * A parent that is not on this shelf, or that is already as deep as notes go, is
 * dropped rather than refused: the note is what somebody asked for and the
 * placement is a detail they can correct, so it lands at the top of the shelf
 * instead of the write failing with nothing written. A parent that does hold is
 * also what decides the folder, since a nested note lives where its parent does.
 */
export async function createNote(
    userId: string,
    input: core.NoteCreateInput & { spaceId?: string | null; folderId?: string | null }
): Promise<string> {
    const shelf: Shelf = { userId, spaceId: input.spaceId ?? null };
    const parent = input.parentId ? await placeableUnder(shelf, input.parentId) : null;
    const note = await prisma.note.create({
        data: {
            userId,
            title: input.title,
            body: input.body,
            spaceId: shelf.spaceId,
            parentId: parent?.id ?? null,
            folderId: parent ? parent.folderId : (input.folderId ?? null)
        },
        select: { id: true }
    });
    return note.id;
}

/** Writes only what was sent. The caller has already been allowed to write it. */
export async function updateNote(input: core.NoteUpdateInput): Promise<boolean> {
    const changed = await prisma.note.updateMany({
        where: { id: input.noteId },
        data: {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.body !== undefined ? { body: input.body } : {}),
            ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
            ...(input.archived !== undefined ? { archived: input.archived } : {})
        }
    });
    return changed.count > 0;
}

/**
 * Move a note: to another parent, another folder, another shelf, or out to the
 * top of one.
 *
 * The refusals are the ones the shape of the request cannot catch. A note put
 * inside its own subtree would be cut off from the tree entirely; one pushed
 * past the depth limit would take everything under it along; and a folder on
 * another shelf is not a place this note can be. All of them are measured
 * against what is stored, in one read, so a second tab cannot make the answer
 * wrong between the check and the write.
 *
 * The subtree comes along. A note is moved with everything under it because the
 * text under a heading goes where the heading goes - and unlike a delete, which
 * frees them, nobody loses anything by that.
 */
export async function moveNote(
    userId: string,
    input: core.NoteMoveInput
): Promise<NoteMoveError | null> {
    const note = await prisma.note.findUnique({
        where: { id: input.noteId },
        select: { spaceId: true }
    });
    if (!note) return "That note no longer exists";

    if (input.folderId) {
        const folder = await prisma.noteFolder.findUnique({
            where: { id: input.folderId },
            select: { spaceId: true }
        });
        if (!folder) return "That note no longer exists";
        if ((folder.spaceId ?? null) !== (input.spaceId ?? null)) {
            return "That folder is on a different notebook";
        }
    }

    // The shelf the note is leaving decides the tree the cycle and depth rules
    // are measured in; a note moving between shelves is leaving that tree behind
    // and can only land at the top of the new one.
    const rows = await prisma.note.findMany({
        where: shelfWhere({ userId, spaceId: note.spaceId }),
        select: { id: true, parentId: true, folderId: true }
    });
    const parents = new Map(rows.map((row) => [row.id, row.parentId]));
    if (!parents.has(input.noteId)) return "That note no longer exists";
    if (input.parentId === input.noteId) return "A note cannot go inside itself";

    let folderId = input.folderId;
    if (input.parentId !== null) {
        const parent = rows.find((row) => row.id === input.parentId);
        if (!parent) return "That note no longer exists";
        if ((note.spaceId ?? null) !== (input.spaceId ?? null)) {
            // Its parent is on the shelf it is leaving, so keeping it would file
            // the note under something the new shelf cannot see.
            return "That note no longer exists";
        }
        for (let at: string | null = input.parentId; at !== null; at = parents.get(at) ?? null) {
            if (at === input.noteId) return "A note cannot go inside itself";
        }
        const depth = depthOf(input.parentId, parents) + 1;
        if (depth + heightOf(input.noteId, rows) >= core.NOTE_MAX_DEPTH) {
            return "That would nest notes too deeply";
        }
        // A nested note lives where its parent does, whatever the caller sent.
        folderId = parent.folderId;
    }

    const branch = subtreeOf(input.noteId, rows);
    await prisma.$transaction([
        prisma.note.update({
            where: { id: input.noteId },
            data: { parentId: input.parentId, spaceId: input.spaceId, folderId }
        }),
        // Everything under it follows, onto the shelf and into the folder it is
        // now filed in - which is the same one, because that is what nesting
        // means here.
        prisma.note.updateMany({
            where: { id: { in: branch.filter((id) => id !== input.noteId) } },
            data: { spaceId: input.spaceId, folderId }
        })
    ]);
    return null;
}

export async function deleteNote(noteId: string): Promise<boolean> {
    const removed = await prisma.note.deleteMany({ where: { id: noteId } });
    return removed.count > 0;
}

/** How many notes sit directly under this one, so a delete can say so before it
 *  frees them. */
export async function countChildren(noteId: string): Promise<number> {
    return prisma.note.count({ where: { parentId: noteId } });
}

/** The parent a new note may actually be given: on this shelf, and with room
 *  under it for one more level. Null when neither holds. */
async function placeableUnder(
    shelf: Shelf,
    parentId: string
): Promise<{ id: string; folderId: string | null } | null> {
    const rows = await prisma.note.findMany({
        where: shelfWhere(shelf),
        select: { id: true, parentId: true, folderId: true }
    });
    const parent = rows.find((row) => row.id === parentId);
    if (!parent) return null;
    const parents = new Map(rows.map((row) => [row.id, row.parentId]));
    if (depthOf(parentId, parents) + 1 >= core.NOTE_MAX_DEPTH) return null;
    return { id: parent.id, folderId: parent.folderId };
}

/** How far a note sits from the top level. Zero at the top. */
function depthOf(noteId: string, parents: ReadonlyMap<string, string | null>): number {
    let depth = 0;
    for (let at = parents.get(noteId) ?? null; at !== null; at = parents.get(at) ?? null) {
        depth += 1;
        // A cycle cannot be written through this module, but a hand-edited
        // database is not this function's problem to crash on.
        if (depth > core.NOTE_MAX_DEPTH) break;
    }
    return depth;
}

/** Every note in the subtree under one, itself included. */
function subtreeOf(noteId: string, rows: readonly { id: string; parentId: string | null }[]): string[] {
    const children = new Map<string, string[]>();
    for (const row of rows) {
        if (!row.parentId) continue;
        const bucket = children.get(row.parentId);
        if (bucket) bucket.push(row.id);
        else children.set(row.parentId, [row.id]);
    }
    const found: string[] = [];
    const stack = [noteId];
    while (stack.length > 0) {
        const at = stack.pop()!;
        if (found.includes(at)) continue;
        found.push(at);
        for (const child of children.get(at) ?? []) stack.push(child);
    }
    return found;
}

/** How many levels the subtree under a note goes down. Zero when it has none. */
function heightOf(
    noteId: string,
    rows: readonly { id: string; parentId: string | null }[]
): number {
    const children = new Map<string, string[]>();
    for (const row of rows) {
        if (!row.parentId) continue;
        const bucket = children.get(row.parentId);
        if (bucket) bucket.push(row.id);
        else children.set(row.parentId, [row.id]);
    }
    const measure = (id: string, seen: number): number => {
        if (seen > core.NOTE_MAX_DEPTH) return seen;
        const kids = children.get(id) ?? [];
        return kids.reduce((deepest, kid) => Math.max(deepest, measure(kid, seen + 1)), seen);
    };
    return measure(noteId, 0);
}

/**
 * The first line of a note as plain text.
 *
 * Read off the Markdown rather than through the parser: this runs once per note
 * on every listing, and what it needs is a hint, not a document. The markers it
 * strips are the ones that would otherwise be most of a short excerpt.
 */
function excerptOf(body: string): string {
    const line = body
        .split("\n")
        .map((entry) => entry.replace(/^\s*(#{1,6}|[-*+]|\d+\.|>)\s*/, "").trim())
        .find((entry) => entry.length > 0);
    if (!line) return "";
    const plain = line
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_`~]/g, "")
        // What the editor escaped on the way in. Left alone, a note that opens
        // with a "#" is listed as "\#".
        .replace(/\\([\\`*_[\]#>+\-.])/g, "$1")
        .trim();
    return plain.length > EXCERPT ? `${plain.slice(0, EXCERPT)}...` : plain;
}
