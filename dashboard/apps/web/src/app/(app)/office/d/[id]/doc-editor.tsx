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
 * What travels, how it is sent and how everybody else's changes arrive is
 * `use-office-document`, which every editor here shares.
 *
 * The schema is the one Polaris already writes everything else with - the same
 * headings, lists, links, code blocks and task lists as a task comment - so a
 * paragraph looks the same wherever it was typed. What is different is the
 * setting: a document is read at a page width, at a size somebody reads for ten
 * minutes rather than glances at.
 */

import { cn } from "@polaris/ui";
import { Loader2 } from "lucide-react";
import { Extension } from "@tiptap/core";
import { OFFICE_FIELD } from "@/lib/office/content";
import { useOfficeDocument, type OfficeSaving } from "@/app/(app)/office/use-office-document";
import { EditorContent, useEditor } from "@tiptap/react";
import { useMemo } from "react";
import { baseExtensions } from "@/components/rich-text/schema";
import { redo, undo, ySyncPlugin, yUndoPlugin } from "y-prosemirror";

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
    // The document and the wire under it. Shared with every other editor here:
    // none of that is about documents - see `use-office-document`.
    const { doc, saving } = useOfficeDocument({ documentId, content, editable });

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
            extensions: [...baseExtensions(editable ? "Write something" : ""), collaboration],
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

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
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
function SavingNote({ state }: { state: OfficeSaving }) {
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
