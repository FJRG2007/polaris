"use client";

/**
 * Office's kind of offline write: a document's changes, kept on this device
 * until the server takes them (`lib/offline/app-writes`).
 *
 * A change is a Yjs update. Applied twice it does nothing, and applied in any
 * order beside somebody else's it gives the same document, so a change written
 * offline never needs a conflict copy: it is folded in when it arrives, and one
 * sent again after a lost answer is harmless. What waits for one document is
 * kept as a single update - each new change is merged into what is still
 * waiting - so a day of offline typing is one request, not thousands.
 *
 * Nothing here loads Yjs: the sender runs from every screen, and the merge is
 * handed in by the editor, which has it already.
 */

import { noteRequestFailure } from "@/lib/reachability";
import { newClientKey, type QueueSendResult } from "@/lib/offline/outbox";
import { appWrites, keepOnUnload, registerWriteKind, replaceWrite, writesFor, type AppWrite } from "@/lib/offline/app-writes";

export const OFFICE_UPDATE = "office.update";

export interface OfficeUpdatePayload {
    readonly documentId: string;
    /** The merged Yjs update, base64. */
    readonly update: string;
    /** The tab that made it, so that tab is not handed it back. */
    readonly origin: string;
}

export function toBase64(bytes: Uint8Array): string {
    let text = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
        text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(text);
}

export function fromBase64(text: string): Uint8Array {
    return Uint8Array.from(atob(text), (one) => one.charCodeAt(0));
}

/** What the content route's answer means for a waiting change. */
export function readContentAnswer(status: number): QueueSendResult {
    if (status >= 200 && status < 300) return { sent: "" };
    // The edge with Polaris behind it down, or Polaris busy: try again later.
    if (status === 408 || status === 429 || status >= 500) return "unreachable";
    // Not allowed to edit any more, the document gone, a change too large.
    return { refused: String(status) };
}

async function deliverOfficeUpdate(entry: Pick<AppWrite, "payload">): Promise<QueueSendResult> {
    const payload = entry.payload as OfficeUpdatePayload;
    try {
        const answer = await fetch(
            `/api/office/${encodeURIComponent(payload.documentId)}/content?origin=${encodeURIComponent(payload.origin)}`,
            { method: "POST", body: fromBase64(payload.update) as unknown as BodyInit }
        );
        return readContentAnswer(answer.status);
    } catch (caught) {
        noteRequestFailure(caught);
        return "unreachable";
    }
}

registerWriteKind(OFFICE_UPDATE, deliverOfficeUpdate, { additive: true });

/** Merges run one at a time per document, in this tab and across tabs: two
 *  merging the same waiting change at once would each drop the other's. */
let chain: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(documentId: string, run: () => Promise<T>): Promise<T> {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (locks) return locks.request(`polaris-offline-office:${documentId}`, run);
    const next = chain.then(run, run);
    chain = next.catch(() => undefined);
    return next;
}

/**
 * Keep a document's change on this device, merged into whatever of it is still
 * waiting, then send. Answers false when this device keeps nothing (no local
 * store, a link visitor with no account here): the caller sends it at once.
 */
export function keepOfficeUpdate(
    payload: { documentId: string; update: Uint8Array; origin: string },
    merge: (updates: Uint8Array[]) => Uint8Array
): Promise<boolean> {
    return oneAtATime(payload.documentId, async () => {
        const waiting = (await writesFor(OFFICE_UPDATE, payload.documentId)).filter(
            (entry) => entry.state === "pending"
        );
        const updates = [
            ...waiting.map((entry) => fromBase64((entry.payload as OfficeUpdatePayload).update)),
            payload.update
        ];
        const kept = await replaceWrite({
            key: newClientKey(),
            kind: OFFICE_UPDATE,
            target: payload.documentId,
            payload: {
                documentId: payload.documentId,
                update: toBase64(updates.length === 1 ? payload.update : merge(updates)),
                origin: payload.origin
            } satisfies OfficeUpdatePayload
        });
        if (kept) appWrites.flush();
        return kept;
    });
}

/** The changes to a document still on this device, waiting or refused. */
export function waitingOfficeUpdates(documentId: string): Promise<AppWrite[]> {
    return writesFor(OFFICE_UPDATE, documentId);
}

/** Keep the changes the editor has not sent if the page goes away first.
 *  `read` answers them merged, or null when nothing is unsent. */
export function keepOfficeUpdateOnUnload(
    read: () => { documentId: string; update: Uint8Array; origin: string } | null
): () => void {
    return keepOnUnload(() => {
        const unsent = read();
        if (!unsent) return null;
        const payload: OfficeUpdatePayload = { ...unsent, update: toBase64(unsent.update) };
        return { key: newClientKey(), kind: OFFICE_UPDATE, target: unsent.documentId, payload };
    });
}
