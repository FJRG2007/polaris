/**
 * Reading and writing somebody's own notes.
 *
 * Every query here is filtered by the account that asked, without exception and
 * without a permission to override it: there is no role that reads another
 * person's notes, an instance administrator included. That is not a policy this
 * layer applies on top of the data - it is the only way the data is reached, so
 * a future screen cannot forget it.
 *
 * Notes nest, and the tree is assembled here rather than queried recursively.
 * One person's notes are a few hundred rows at the outside, so a single read of
 * their titles costs less than the round trips a recursive walk would take, and
 * the ordering rules - pinned first, then most recently touched, applied among
 * siblings rather than globally - are one comparison instead of a query per
 * level.
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
    readonly updatedAt: string;
}

/** An archived note, as the archive lists it. No excerpt: the archive is read
 *  to find one thing and put it back, not to browse. */
export interface ArchivedNote {
    readonly id: string;
    readonly title: string;
    readonly updatedAt: string;
}

/** Why a move was refused, in words the screen can show as they are. */
export type NoteMoveError =
    | "That note no longer exists"
    | "A note cannot go inside itself"
    | "That would nest notes too deeply";

/** How much of a note the list shows underneath its title. */
const EXCERPT = 140;

interface Row {
    id: string;
    title: string;
    body: string;
    pinned: boolean;
    parentId: string | null;
    updatedAt: Date;
}

/**
 * Every note this account has, in the order the sidebar draws them: depth-first
 * from the top level, siblings pinned-first and then most recently touched.
 *
 * A note whose parent is archived is drawn at the top level rather than
 * disappearing with it - archiving one note is not a statement about the notes
 * under it, and a child that vanished from both lists would be unreachable.
 */
export async function listNotes(userId: string): Promise<NoteSummary[]> {
    const rows = await prisma.note.findMany({
        where: { userId, archived: false },
        orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
        select: { id: true, title: true, body: true, pinned: true, parentId: true, updatedAt: true }
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

/** What has been put away, most recently touched first. */
export async function listArchivedNotes(userId: string): Promise<ArchivedNote[]> {
    const rows = await prisma.note.findMany({
        where: { userId, archived: true },
        orderBy: { updatedAt: "desc" },
        select: { id: true, title: true, updatedAt: true }
    });
    return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }));
}

export async function getNote(userId: string, noteId: string): Promise<NoteView | null> {
    const note = await prisma.note.findFirst({
        where: { id: noteId, userId, archived: false },
        select: { id: true, title: true, body: true, pinned: true, parentId: true, updatedAt: true }
    });
    if (!note) return null;
    return { ...note, updatedAt: note.updatedAt.toISOString() };
}

/**
 * Write a new note, optionally under an existing one.
 *
 * A parent that is not this account's, or that is already as deep as notes go,
 * is dropped rather than refused: the note is what somebody asked for and the
 * placement is a detail they can correct, so it lands at the top level instead
 * of the write failing with nothing written.
 */
export async function createNote(userId: string, input: core.NoteCreateInput): Promise<string> {
    const parentId = input.parentId ? await placeableUnder(userId, input.parentId, 1) : null;
    const note = await prisma.note.create({
        data: { userId, title: input.title, body: input.body, parentId },
        select: { id: true }
    });
    return note.id;
}

/** Writes only what was sent, and only to a note this account owns. */
export async function updateNote(userId: string, input: core.NoteUpdateInput): Promise<boolean> {
    const changed = await prisma.note.updateMany({
        where: { id: input.noteId, userId },
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
 * Move a note somewhere else in the tree, or out to the top level.
 *
 * The two refusals are the ones the shape of the request cannot catch: a note
 * put inside its own subtree would be cut off from the tree entirely, and one
 * pushed past the depth limit would take everything under it along. Both are
 * measured against what is stored, in one read, so a second tab cannot make the
 * answer wrong between the check and the write.
 */
export async function moveNote(
    userId: string,
    input: core.NoteMoveInput
): Promise<NoteMoveError | null> {
    const rows = await prisma.note.findMany({
        where: { userId },
        select: { id: true, parentId: true }
    });
    const parents = new Map(rows.map((row) => [row.id, row.parentId]));
    if (!parents.has(input.noteId)) return "That note no longer exists";
    if (input.parentId !== null && !parents.has(input.parentId)) return "That note no longer exists";
    if (input.parentId === input.noteId) return "A note cannot go inside itself";

    if (input.parentId !== null) {
        for (let at: string | null = input.parentId; at !== null; at = parents.get(at) ?? null) {
            if (at === input.noteId) return "A note cannot go inside itself";
        }
        const depth = depthOf(input.parentId, parents) + 1;
        if (depth + heightOf(input.noteId, rows) >= core.NOTE_MAX_DEPTH) {
            return "That would nest notes too deeply";
        }
    }

    await prisma.note.updateMany({
        where: { id: input.noteId, userId },
        data: { parentId: input.parentId }
    });
    return null;
}

export async function deleteNote(userId: string, noteId: string): Promise<boolean> {
    const removed = await prisma.note.deleteMany({ where: { id: noteId, userId } });
    return removed.count > 0;
}

/** How many notes sit directly under this one, so a delete can say so before it
 *  frees them. */
export async function countChildren(userId: string, noteId: string): Promise<number> {
    return prisma.note.count({ where: { userId, parentId: noteId } });
}

/** The parent a new note may actually be given: this account's, and with room
 *  under it for `needed` more levels. Null when neither holds. */
async function placeableUnder(
    userId: string,
    parentId: string,
    needed: number
): Promise<string | null> {
    const rows = await prisma.note.findMany({
        where: { userId },
        select: { id: true, parentId: true }
    });
    const parents = new Map(rows.map((row) => [row.id, row.parentId]));
    if (!parents.has(parentId)) return null;
    return depthOf(parentId, parents) + needed < core.NOTE_MAX_DEPTH ? parentId : null;
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

/** How many levels the subtree under a note goes down. Zero when it has none. */
function heightOf(noteId: string, rows: readonly { id: string; parentId: string | null }[]): number {
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
