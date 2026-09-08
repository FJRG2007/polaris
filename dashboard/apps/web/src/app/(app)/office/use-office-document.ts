"use client";

/**
 * The document behind whichever editor is open, and the wire under it.
 *
 * All five editors need exactly the same four things and none of them is about
 * documents, spreadsheets or drawings: a `Y.Doc` opened from what was stored,
 * a debounced send of what changed, everybody else's changes applied as they
 * arrive, and one last send as the tab closes. Written once here because four
 * copies is four places for the echo suppression to be subtly different, and the
 * symptom of getting that wrong is a caret that jumps while somebody is typing.
 *
 * What travels is the change rather than the document - a Yjs update, a few
 * dozen bytes for a paragraph however long the thing is - and the server folds
 * it into what it holds. Two updates applied in either order give the same
 * result, so a frame that never arrives is repaired by the next one and one that
 * arrives twice does nothing: no acknowledgement, no ordering, no replay.
 *
 * One route both stores and broadcasts, so there is one way an update can enter
 * a document. A second entrance would be a second access check to keep in step.
 */

import * as Y from "yjs";
import { useEffect, useMemo, useRef, useState } from "react";

/** What the corner says about whether the work is safe. Three rather than two:
 *  "saved" and "saving" leave nowhere to put a failure. */
export type OfficeSaving = "settled" | "saving" | "failed";

/**
 * How long the editor waits after the last change before it sends.
 *
 * Long enough that a sentence is one request rather than forty, short enough
 * that the other side is not watching a paragraph appear a minute late.
 */
const SEND_AFTER_MS = 600;

/** What an update applied from the wire is tagged with, so the sender knows not
 *  to send it straight back out. */
export const REMOTE = Symbol.for("polaris.office.remote");

export function useOfficeDocument({
    documentId,
    content,
    editable
}: {
    documentId: string;
    /** The stored update, as a plain array - a server component cannot hand
     *  bytes across the boundary. */
    content: number[] | null;
    editable: boolean;
}): { doc: Y.Doc; saving: OfficeSaving } {
    // Built once, from what was stored. A new Y.Doc per render would throw the
    // document away between keystrokes.
    const doc = useMemo(() => {
        const made = new Y.Doc();
        if (content && content.length > 0) Y.applyUpdate(made, Uint8Array.from(content));
        return made;
    }, [content]);

    const [saving, setSaving] = useState<OfficeSaving>("settled");
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** What has been changed and not yet sent, merged into one update. */
    const unsent = useRef<Uint8Array[]>([]);

    /**
     * Which tab this is.
     *
     * Not which account: one person with the same thing open on a laptop and a
     * phone is two editors, and each has to hear the other. It is only ever used
     * to keep a tab from being handed its own changes back, so a made-up one
     * costs its owner an echo and nobody else anything.
     */
    const origin = useMemo(() => Math.random().toString(36).slice(2), []);

    // Held in a ref so the effects below do not have to be rebuilt - and torn
    // down mid-edit - every time the saving state changes.
    const send = useRef(async (): Promise<void> => undefined);
    send.current = async (): Promise<void> => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        const pending = unsent.current;
        if (pending.length === 0) return;
        unsent.current = [];
        const merged = Y.mergeUpdates(pending);
        try {
            const answer = await fetch(
                `/api/office/${encodeURIComponent(documentId)}/content?origin=${origin}`,
                { method: "POST", body: merged as unknown as BodyInit }
            );
            if (!answer.ok) throw new Error(String(answer.status));
            setSaving("settled");
        } catch {
            // Put it back, so the next change sends it again rather than losing
            // it. What is on screen is still right either way.
            unsent.current = [merged, ...unsent.current];
            setSaving("failed");
        }
    };

    /**
     * Send what changed, once the changing stops.
     *
     * Subscribed to the document rather than to the editor: a change is a change
     * wherever it came from, and listening to one editor would miss every change
     * a different part of the screen made. Anything that arrived from the wire is
     * skipped - it has already been stored by whoever sent it, and echoing it
     * back would be every tab writing every keystroke.
     */
    useEffect(() => {
        if (!editable) return;
        const onUpdate = (update: Uint8Array, source: unknown): void => {
            if (source === REMOTE) return;
            unsent.current.push(update);
            if (timer.current) clearTimeout(timer.current);
            setSaving("saving");
            timer.current = setTimeout(() => void send.current(), SEND_AFTER_MS);
        };
        doc.on("update", onUpdate);
        return () => {
            doc.off("update", onUpdate);
            if (timer.current) clearTimeout(timer.current);
        };
    }, [doc, editable]);

    /**
     * Everybody else's changes.
     *
     * One connection per open document, and the connection IS the access check:
     * it is opened for this document and refuses anything else. Frames are
     * applied with a source of their own so the sender above knows not to send
     * them back out.
     *
     * Opened even for somebody who cannot edit - a reader watching a document
     * being written should see it being written.
     */
    useEffect(() => {
        const source = new EventSource(
            `/api/office/${encodeURIComponent(documentId)}/stream?origin=${origin}`
        );
        source.onmessage = (event) => {
            let frame: { kind?: string; update?: string };
            try {
                frame = JSON.parse(event.data) as { kind?: string; update?: string };
            } catch {
                return;
            }
            if (frame.kind !== "update" || !frame.update) return;
            const bytes = Uint8Array.from(atob(frame.update), (one) => one.charCodeAt(0));
            Y.applyUpdate(doc, bytes, REMOTE);
        };
        return () => source.close();
    }, [doc, documentId, origin]);

    /**
     * And once more on the way out.
     *
     * A tab closed inside the wait above would otherwise lose everything done
     * since the last send. `sendBeacon` is what lets a request outlive the page
     * that started it, which a fetch cannot promise.
     */
    useEffect(() => {
        if (!editable) return;
        const leave = (): void => {
            const pending = unsent.current;
            if (pending.length === 0) return;
            unsent.current = [];
            navigator.sendBeacon?.(
                `/api/office/${encodeURIComponent(documentId)}/content?origin=${origin}`,
                new Blob([Y.mergeUpdates(pending) as unknown as BlobPart], {
                    type: "application/octet-stream"
                })
            );
        };
        window.addEventListener("pagehide", leave);
        return () => {
            leave();
            window.removeEventListener("pagehide", leave);
        };
    }, [documentId, editable, origin]);

    return { doc, saving };
}
