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
import { saveDocumentAction } from "@/app/(app)/office/actions";
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
     * Write what changed, once the typing stops.
     *
     * Subscribed to the document rather than to the editor: an update that
     * arrives from anywhere - this keyboard today, somebody else's tomorrow -
     * is a change that has to be stored, and listening to the editor would miss
     * every one that did not come from these hands.
     */
    useEffect(() => {
        if (!editable) return;
        const onUpdate = (): void => {
            if (timer.current) clearTimeout(timer.current);
            setSaving("saving");
            timer.current = setTimeout(async () => {
                timer.current = null;
                const update = Y.encodeStateAsUpdate(doc);
                const answer = await saveDocumentAction(documentId, Array.from(update));
                setSaving(answer.error ? "failed" : "settled");
            }, SAVE_AFTER_MS);
        };
        doc.on("update", onUpdate);
        return () => {
            doc.off("update", onUpdate);
            if (timer.current) clearTimeout(timer.current);
        };
    }, [doc, documentId, editable]);

    /**
     * And once more on the way out.
     *
     * A tab closed inside the wait above would otherwise lose everything typed
     * since the last write. `keepalive` is what lets a request outlive the page
     * that started it, which a server action cannot promise - so this is a plain
     * fetch to the same endpoint the action reaches.
     */
    useEffect(() => {
        if (!editable) return;
        const flush = (): void => {
            if (!timer.current) return;
            clearTimeout(timer.current);
            timer.current = null;
            const update = Y.encodeStateAsUpdate(doc);
            navigator.sendBeacon?.(
                `/api/office/${encodeURIComponent(documentId)}/content`,
                new Blob([update as unknown as BlobPart], { type: "application/octet-stream" })
            );
        };
        window.addEventListener("pagehide", flush);
        return () => {
            flush();
            window.removeEventListener("pagehide", flush);
        };
    }, [doc, documentId, editable]);

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
