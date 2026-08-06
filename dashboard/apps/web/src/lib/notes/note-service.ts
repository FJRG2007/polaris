/**
 * Reading and writing somebody's own notes.
 *
 * Every query here is filtered by the account that asked, without exception and
 * without a permission to override it: there is no role that reads another
 * person's notes, an instance administrator included. That is not a policy this
 * layer applies on top of the data - it is the only way the data is reached, so
 * a future screen cannot forget it.
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
    readonly updatedAt: string;
}

export interface NoteView {
    readonly id: string;
    readonly title: string;
    readonly body: string;
    readonly pinned: boolean;
    readonly updatedAt: string;
}

/** How much of a note the list shows underneath its title. */
const EXCERPT = 140;

export async function listNotes(userId: string): Promise<NoteSummary[]> {
    const notes = await prisma.note.findMany({
        where: { userId, archived: false },
        // Pinned first, then whatever was touched last, which between them are
        // the only two orders anybody looks for their own notes in.
        orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
        select: { id: true, title: true, body: true, pinned: true, updatedAt: true }
    });
    return notes.map((note) => ({
        id: note.id,
        title: note.title,
        excerpt: excerptOf(note.body),
        pinned: note.pinned,
        updatedAt: note.updatedAt.toISOString()
    }));
}

export async function getNote(userId: string, noteId: string): Promise<NoteView | null> {
    const note = await prisma.note.findFirst({
        where: { id: noteId, userId, archived: false },
        select: { id: true, title: true, body: true, pinned: true, updatedAt: true }
    });
    if (!note) return null;
    return { ...note, updatedAt: note.updatedAt.toISOString() };
}

export async function createNote(userId: string, input: core.NoteCreateInput): Promise<string> {
    const note = await prisma.note.create({
        data: { userId, title: input.title, body: input.body },
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

export async function deleteNote(userId: string, noteId: string): Promise<boolean> {
    const removed = await prisma.note.deleteMany({ where: { id: noteId, userId } });
    return removed.count > 0;
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
