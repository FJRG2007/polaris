"use client";

/**
 * Notes' kinds of offline write: a note's title and text, kept on this device
 * until the server takes it (`lib/offline/app-writes`), and a note made, moved,
 * renamed, pinned, archived or deleted while Polaris could not be reached
 * (tried at once otherwise).
 *
 * Only the newest text of a note waits - each save replaces the one before it
 * that had not gone yet. It carries the note's version the device last saw, so
 * an edit made elsewhere in the meantime is never overwritten: the server keeps
 * both, the device's text as a note of its own beside the other, and the screen
 * says so (`saveNoteTextAction`).
 */

import * as actions from "./actions";
import { useEffect, useState } from "react";
import { actionFailureText } from "@/lib/run-action";
import { keptTemplate } from "./offline-templates";
import { tryNow, UNANSWERED, undelivered } from "@/lib/offline/try-now";
import { newClientKey, type QueueSendResult } from "@/lib/offline/outbox";
import {
    appWrites,
    keepOnUnload,
    offlineStore,
    readAck,
    registerWriteKind,
    replaceWrite,
    writeAck,
    writesFor,
    type AppWrite
} from "@/lib/offline/app-writes";

import { NOTE_CREATE, NOTE_DELETE, NOTE_MOVE, NOTE_TEXT, NOTE_UPDATE } from "./offline-tree";

export { NOTE_CREATE, NOTE_DELETE, NOTE_MOVE, NOTE_TEXT, NOTE_UPDATE };

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

/** A note's text is sent by any page. It is held only when a newer build
 *  answered: then the page loaded after the reload sends it. */
type NoteTextAnswer = QueueSendResult;

async function deliverNoteText(entry: Pick<AppWrite, "key" | "payload">): Promise<NoteTextAnswer> {
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
        return undelivered(caught);
    }
}

registerWriteKind(NOTE_TEXT, deliverNoteText);

/**
 * Save a note's text: kept here first, then sent. Answers the entry's key, or
 * the server's answer when this device keeps nothing (no local store) and it was
 * sent at once instead.
 */
export async function saveNoteText(payload: NoteTextPayload): Promise<{ queued: string } | { now: NoteTextAnswer }> {
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
// ---------------------------------------------------------------------------
// A note made, moved, changed or deleted
// ---------------------------------------------------------------------------

type PlaceKind = typeof NOTE_CREATE | typeof NOTE_MOVE | typeof NOTE_UPDATE | typeof NOTE_DELETE;

const PLACE_KINDS: readonly PlaceKind[] = [NOTE_CREATE, NOTE_MOVE, NOTE_UPDATE, NOTE_DELETE];
const NOTE_KINDS: readonly string[] = [...PLACE_KINDS, NOTE_TEXT];

/** Every note write: what the tree is drawn over, and what a new one waits behind. */
export const isNoteWrite = (entry: AppWrite): boolean => NOTE_KINDS.includes(entry.kind);

// Looked up when called, not when this module loads.
const place: Record<PlaceKind, (payload: Record<string, unknown>) => Promise<{ id?: string; error?: string; }>> = {
    [NOTE_CREATE]: (payload) => actions.createNoteAction(payload),
    [NOTE_MOVE]: (payload) => actions.moveNoteAction(payload),
    [NOTE_UPDATE]: (payload) => actions.updateNoteAction(payload),
    [NOTE_DELETE]: (payload) => actions.deleteNoteAction(String(payload.noteId))
};

async function deliverPlace(entry: Pick<AppWrite, "kind" | "target" | "payload">): Promise<QueueSendResult> {
    try {
        const result = await place[entry.kind as PlaceKind](entry.payload as Record<string, unknown>);
        return result.error ? { refused: result.error } : { sent: result.id ?? entry.target };
    } catch (caught) {
        return undelivered(caught);
    }
}

for (const kind of PLACE_KINDS) registerWriteKind(kind, deliverPlace);

async function noteWrites(): Promise<AppWrite[]> {
    return (await appWrites.readAll())
        .filter(isNoteWrite)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Keep a write in line behind what is already waiting for the same note. Sent
 * in that order, so the server always has the note before it hears what
 * happened to it next.
 *
 * - A move or a change (title, pin, archive) right behind one of its own kind
 *   folds into it, the newest value winning; every value is absolute, so the
 *   one it replaced being sent as well changes nothing. Neither is folded into
 *   a create: one already on its way would be sent without it.
 * - A delete drops what was waiting for the note - it would only be deleted
 *   with it - its create included, and is kept itself even for a note the
 *   server never heard of: that create may already be on its way, and a
 *   delete of a note that is not there is answered as done.
 */
async function keepPlace(kind: PlaceKind, target: string, payload: Record<string, unknown>): Promise<boolean> {
    const run = async (): Promise<boolean> => {
        const mine = (await noteWrites()).filter((entry) => entry.target === target);
        if (kind === NOTE_DELETE) for (const entry of mine) await offlineStore.forget("writes", entry.key);
        const last = kind === NOTE_DELETE ? undefined : mine.filter((entry) => entry.state === "pending").at(-1);
        const folds = (kind === NOTE_MOVE || kind === NOTE_UPDATE) && last?.kind === kind;
        const change = folds && last ? { ...(last.payload as Record<string, unknown>), ...payload } : payload;
        const kept = await appWrites.enqueue({ key: newClientKey(), kind, target, payload: change });
        if (kept && folds && last) await offlineStore.forget("writes", last.key);
        return kept;
    };
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    const owner = offlineStore.owner();
    return locks && owner ? locks.request(`polaris-note-writes:${owner}`, run) : run();
}

/** What a note write answered: the action's own answer, or that it was kept on
 *  this device to be sent later (`queued`), with no error. */
export type NoteWriteResult = { id?: string; error?: string; queued?: true; };

/**
 * Make, move, change or delete a note now, or keep the write for when Polaris answers.
 * Answers what the action answered when it was sent, `{ queued: true }` when it
 * was kept, and null when it failed otherwise (`onFailure` was told).
 *
 * A note made here is made with its id, so a retry after a lost answer finds it
 * already there instead of making a second one.
 */
export async function writeNote(
    kind: PlaceKind,
    payload: Record<string, unknown>,
    onFailure: (message: string) => void
): Promise<NoteWriteResult | null> {
    const input = kind === NOTE_CREATE && typeof payload.id !== "string" ? { ...payload, id: newClientKey() } : payload;
    const target = kind === NOTE_CREATE ? (input.id as string) : String(input.noteId);
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    // Behind anything still waiting for this note, or for the note it goes
    // under, so the server has those before it reads this.
    const named = new Set([target, ...(typeof input.parentId === "string" ? [input.parentId] : [])]);
    const behind = (await noteWrites()).some((entry) => named.has(entry.target));

    if (!offline && !behind) {
        const answer = await tryNow(() => place[kind](input), onFailure);
        if (answer !== UNANSWERED) return answer;
    }
    // Made from a template: drawn from the copy this device keeps until the
    // server, which applies the template itself, has it.
    const start =
        kind === NOTE_CREATE && typeof input.templateId === "string" ? await keptTemplate(input.templateId) : null;
    if (await keepPlace(kind, target, start ? { ...input, ...start } : input)) {
        appWrites.flush();
        return kind === NOTE_CREATE ? { id: target, queued: true } : { queued: true };
    }
    // Nowhere to keep it (no account on this device, storage refused).
    onFailure(actionFailureText());
    return null;
}

/** Notes made here whose create was sent while this page was open: still drawn
 *  from the device until the page has them from the server. */
const madeHere = new Map<string, AppWrite>();

/** The note writes kept on this device, oldest first, kept current. `onSent`
 *  hears every one the server took, so the screen can fetch what it now has. */
export function useNoteWrites(onSent?: (entry: AppWrite) => void): {
    readonly entries: readonly AppWrite[];
    readonly made: ReadonlyMap<string, AppWrite>;
} {
    const [entries, setEntries] = useState<readonly AppWrite[]>([]);
    const [made, setMade] = useState<ReadonlyMap<string, AppWrite>>(() => new Map(madeHere));
    useEffect(() => {
        let live = true;
        const reload = () =>
            void noteWrites().then(
                (kept) => live && setEntries(kept),
                () => undefined
            );
        reload();
        const unsubscribe = appWrites.subscribe((event) => {
            if (event && !isNoteWrite(event.entry)) return;
            if (event && "sent" in event) {
                if (event.entry.kind === NOTE_CREATE) {
                    madeHere.set(event.entry.target, event.entry);
                    setMade(new Map(madeHere));
                }
                onSent?.(event.entry);
            }
            reload();
        });
        return () => {
            live = false;
            unsubscribe();
        };
        // `onSent` is read when an event arrives; a new closure each render
        // must not resubscribe.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return { entries, made };
}
