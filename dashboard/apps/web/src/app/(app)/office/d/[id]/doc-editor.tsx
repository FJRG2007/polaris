"use client";

/**
 * A document, being written.
 *
 * **The editor writes into a CRDT, not into a string.** ProseMirror's state is
 * bound to a Yjs document through `ySyncPlugin`, so what is stored is a merged
 * update rather than a snapshot of one person's screen. Nothing about this file
 * is about collaboration yet - there is one person here and no wire - and that
 * is exactly why it is built this way now: retrofitting a CRDT under an editor
 * that has been saving strings means migrating every document that exists.
 *
 * Undo comes from Yjs rather than from ProseMirror (`yUndoPlugin`), which is the
 * one thing that has to change with it. Under a CRDT, ProseMirror's own history
 * would undo somebody else's typing as happily as your own.
 *
 * **What travels is a change, not the document.** Every edit is sent as the Yjs
 * update it produced - a few dozen bytes for a paragraph, whatever the length of
 * the document - and the server folds it into what it holds. That is also what
 * makes two people at once correct rather than usually correct: with whole
 * documents, whoever saves second overwrites whoever saved first.
 *
 * The same route both stores and broadcasts, so there is one way an update can
 * enter a document. A second entrance is a second access check to keep in step,
 * and the one that gets forgotten is the one somebody finds.
 *
 * The schema is the one Polaris already writes everything else with - the same
 * headings, lists, links, code blocks and task lists as a task comment - so a
 * paragraph looks the same wherever it was typed. What is different is the
 * setting: a document is read at a page width, at a size somebody reads for ten
 * minutes rather than glances at.
 */

import * as Y from "yjs";
import { cn } from "@polaris/ui";
import { Loader2 } from "lucide-react";
import { Extension } from "@tiptap/core";
import { OFFICE_FIELD } from "@/lib/office/content";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { baseExtensions } from "@/components/rich-text/schema";
import { redo, undo, ySyncPlugin, yUndoPlugin } from "y-prosemirror";

/** How long the editor waits after the last keystroke before it writes.
 *
 *  Long enough that a sentence is one write rather than forty, short enough that
 *  nobody who closes a tab in a hurry loses a thought. */
const SAVE_AFTER_MS = 800;

/** What an update applied from the wire is tagged with, so the sender knows not
 *  to send it straight back out. Any value would do as long as it is one
 *  object; a symbol says it is a marker rather than data. */
const REMOTE = Symbol.for("polaris.office.remote");

/** What the saving indicator says, which is deliberately three states rather
 *  than two: "saved" and "saving" leave nowhere to put a failure. */
type Saving = "settled" | "saving" | "failed";

export function DocEditor({
    documentId,
    content,
    editable
}: {
    documentId: string;
    /** The stored update, as a plain array - a server component cannot hand
     *  bytes across the boundary. */
    content: number[] | null;
    editable: boolean;
}) {
    // Built once, from what was stored. A new Y.Doc per render would throw away
    // the document between keystrokes.
    const doc = useMemo(() => {
        const made = new Y.Doc();
        if (content && content.length > 0) Y.applyUpdate(made, Uint8Array.from(content));
        return made;
    }, [content]);

    const [saving, setSaving] = useState<Saving>("settled");
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    /**
     * Which tab this is.
     *
     * Not which account: one person with the document open on a laptop and a
     * phone is two editors, and each has to hear the other. It is only ever used
     * to keep a tab from being handed its own keystrokes back, so a made-up one
     * costs its owner an echo and nobody else anything.
     */
    const origin = useMemo(() => Math.random().toString(36).slice(2), []);
    /** What has been typed and not yet sent, merged into one update. */
    const unsent = useRef<Uint8Array[]>([]);

    const collaboration = useMemo(
        () =>
            Extension.create({
                name: "officeCollaboration",
                addProseMirrorPlugins() {
                    return [ySyncPlugin(doc.getXmlFragment(OFFICE_FIELD)), yUndoPlugin()];
                },
                // Yjs owns the history, so the editor's own keys have to reach
                // it instead. Left to ProseMirror they would undo whatever
                // arrived last, including somebody else's sentence.
                addKeyboardShortcuts() {
                    return {
                        "Mod-z": () => undo(this.editor.state),
                        "Mod-y": () => redo(this.editor.state),
                        "Mod-Shift-z": () => redo(this.editor.state)
                    };
                }
            }),
        [doc]
    );

    const editor = useEditor(
        {
            editable,
            // Next renders this on the server too, and a CRDT bound to a DOM
            // that does not exist is an error nobody can read.
            immediatelyRender: false,
            extensions: [
                ...baseExtensions(editable ? "Write something" : ""),
                collaboration
            ],
            editorProps: {
                attributes: {
                    class: cn(
                        "outline-none",
                        // A document's own setting: wider than a comment, larger
                        // than a note, and with the space between paragraphs
                        // somebody reading for ten minutes needs.
                        "text-[15px] leading-7 [&>*+*]:mt-4",
                        "[&_h1]:mt-8 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight",
                        "[&_h2]:mt-6 [&_h2]:text-xl [&_h2]:font-semibold",
                        "[&_h3]:mt-5 [&_h3]:text-base [&_h3]:font-semibold",
                        "[&_a]:text-primary [&_a]:underline",
                        "[&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1",
                        "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground",
                        "[&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:text-[13px]"
                    )
                }
            }
        },
        [collaboration, editable]
    );

    /**
     * Send what changed, once the typing stops.
     *
     * Subscribed to the document rather than to the editor: a change that
     * arrives from anywhere - this keyboard, or the wire - is a change, and
     * listening to the editor would miss every one that did not come from these
     * hands. Anything that arrived from the wire is skipped here, though: it has
     * already been stored by whoever sent it, and echoing it back would be every
     * tab writing every keystroke.
     */
    useEffect(() => {
        if (!editable) return;
        const onUpdate = (update: Uint8Array, source: unknown): void => {
            // `source` is what applied it. Ours is undefined; a frame from the
            // stream names itself, and neither needs sending back.
            if (source === REMOTE) return;
            unsent.current.push(update);
            if (timer.current) clearTimeout(timer.current);
            setSaving("saving");
            timer.current = setTimeout(() => void flush(), SAVE_AFTER_MS);
        };
        doc.on("update", onUpdate);
        return () => {
            doc.off("update", onUpdate);
            if (timer.current) clearTimeout(timer.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [doc, documentId, editable]);

    /** Everything typed since the last write, as one update. */
    const flush = async (): Promise<void> => {
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
            // Put it back, so the next keystroke sends it again rather than
            // losing it. The document on screen is still right either way.
            unsent.current = [merged, ...unsent.current];
            setSaving("failed");
        }
    };

    /**
     * Everybody else's typing.
     *
     * One connection per open document, and the connection IS the access check -
     * it is opened for this document and refuses anything else. Frames are
     * applied with a source of their own so the sender above knows not to send
     * them back out.
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
     * A tab closed inside the wait above would otherwise lose everything typed
     * since the last send. `sendBeacon` is what lets a request outlive the page
     * that started it.
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

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto">
                {/* The page. A measure rather than the full width of the window:
                    a line of eighty characters is what anybody can read, and a
                    document set edge to edge on a wide screen is one nobody
                    finishes. */}
                <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-8">
                    {editor ? (
                        <EditorContent editor={editor} />
                    ) : (
                        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
                            <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                            Opening
                        </p>
                    )}
                </div>
            </div>
            {editable ? <SavingNote state={saving} /> : null}
        </div>
    );
}

/** What the corner says about whether the work is safe. Quiet when it is: a
 *  permanent "saved" is a label nobody reads, and the one that matters is the
 *  one that says it did not. */
function SavingNote({ state }: { state: Saving }) {
    if (state === "settled") return null;
    return (
        <p
            role="status"
            className={cn(
                "shrink-0 border-t border-border px-4 py-1.5 text-[12px]",
                state === "failed" ? "text-danger" : "text-muted-foreground"
            )}
        >
            {state === "saving"
                ? "Saving"
                : "That did not save. Your work is still on screen - check your connection."}
        </p>
    );
}
