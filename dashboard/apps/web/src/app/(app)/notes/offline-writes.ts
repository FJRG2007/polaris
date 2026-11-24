"use client";

/**
 * Notes' kind of offline write: a note's title and text, kept on this device
 * until the server takes it (`lib/offline/app-writes`).
 *
 * Only the newest text of a note waits - each save replaces the one before it
 * that had not gone yet. It carries the note's version the device last saw, so
 * an edit made elsewhere in the meantime is never overwritten: the server keeps
 * both, the device's text as a note of its own beside the other, and the screen
 * says so (`saveNoteTextAction`).
 */

import * as actions from "./actions";
import { noteRequestFailure } from "@/lib/reachability";
import { newClientKey, type QueueSendResult } from "@/lib/offline/outbox";
import {
    appWrites,
    keepOnUnload,
    readAck,
    registerWriteKind,
    replaceWrite,
    writeAck,
    writesFor,
    type AppWrite
} from "@/lib/offline/app-writes";

export const NOTE_TEXT = "note.text";

/** The reason a write is refused when the server would not overwrite and the
 *  reader cannot add a note there to keep both. */
export const NOTE_CONFLICT = "conflict";

export interface NoteTextPayload {
    readonly noteId: string;
    readonly title: string;
    readonly body: string;
    /** The note's `updatedAt` as the device last saw it; null overwrites. */
    readonly base: string | null;
}

/** What a sent write answered: the note's new version, or the copy kept beside it. */
export type NoteTextSent = { readonly updatedAt: string } | { readonly copyId: string };

const COPY_PREFIX = "copy:";

export function readNoteSent(sent: string): NoteTextSent {
    return sent.startsWith(COPY_PREFIX) ? { copyId: sent.slice(COPY_PREFIX.length) } : { updatedAt: sent };
}

const ackKey = (noteId: string): string => `note:${noteId}`;

/** The later of two versions. A device's own earlier write moved the note on
 *  past the version its screen was drawn at, and is not a conflict. */
export function newestVersion(a: string, b: string | null): string {
    return b && Date.parse(b) > Date.parse(a) ? b : a;
}

async function deliverNoteText(entry: Pick<AppWrite, "key" | "payload">): Promise<QueueSendResult> {
    const payload = entry.payload as NoteTextPayload;
    const base = payload.base === null ? null : newestVersion(payload.base, await readAck(ackKey(payload.noteId)));
    try {
        const result = await actions.saveNoteTextAction({
            noteId: payload.noteId,
            title: payload.title,
            body: payload.body,
            baseUpdatedAt: base,
            copyId: entry.key
        });
        if (result.updatedAt) {
            writeAck(ackKey(payload.noteId), result.updatedAt);
            return { sent: result.updatedAt };
        }
        if (result.copyId) return { sent: `${COPY_PREFIX}${result.copyId}` };
        if (result.conflict) return { refused: NOTE_CONFLICT };
        return { refused: result.error ?? "" };
    } catch (caught) {
        noteRequestFailure(caught);
        return "unreachable";
    }
}

registerWriteKind(NOTE_TEXT, deliverNoteText);

/**
 * Save a note's text: kept here first, then sent. Answers the entry's key, or
 * the server's answer when this device keeps nothing (no local store) and it was
 * sent at once instead.
 */
export async function saveNoteText(payload: NoteTextPayload): Promise<{ queued: string } | { now: QueueSendResult }> {
    const key = newClientKey();
    const kept = await replaceWrite({ key, kind: NOTE_TEXT, target: payload.noteId, payload });
    if (!kept) return { now: await deliverNoteText({ key, payload }) };
    appWrites.flush();
    return { queued: key };
}

/** The newest waiting or failed save of a note, if any. */
export async function waitingNoteText(noteId: string): Promise<AppWrite | null> {
    const entries = await writesFor(NOTE_TEXT, noteId);
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

/**
 * Keep the note's unsaved text if the page goes away inside the pause before a
 * save (`keepOnUnload`). `read` answers what the editor holds unsaved, or null.
 */
export function keepNoteTextOnUnload(read: () => NoteTextPayload | null): () => void {
    return keepOnUnload(() => {
        const payload = read();
        return payload && { key: newClientKey(), kind: NOTE_TEXT, target: payload.noteId, payload };
    });
}
