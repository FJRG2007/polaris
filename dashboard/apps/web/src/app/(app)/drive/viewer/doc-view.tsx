"use client";

/**
 * Word documents, read and now edited.
 *
 * Rendered to styled HTML with mammoth for the reading view, which is what
 * anybody opening a `.docx` in a file browser wants: fast, and no editor to
 * load.
 *
 * **The read-only note that used to be here is out of date and the reason is
 * worth keeping.** It said no open-source round-trip writes a `.docx` back
 * without losing the original styling, which was true. `@polaris/docx` patches
 * paragraphs into the original package rather than rebuilding one, so a document
 * saved through it keeps its styles, numbering and headers - including the parts
 * nothing here understands. So there is an Edit now, and it opens GenOffice's
 * own editor over the same file.
 */

import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@polaris/ui";
import { WordEditor } from "./word-editor";
import type { WordEditorControl } from "./word-editor";
import { EditorActions } from "./editor-actions";
import { Loading, ViewerError } from "./status";
import type { ViewerTarget } from "./types";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function DocView({
    src,
    target,
    readOnly = false,
    onSaved
}: {
    src: string;
    target?: ViewerTarget;
    readOnly?: boolean;
    onSaved?: (name: string) => void;
}) {
    const [html, setHtml] = useState<string | null>(null);
    const [error, setError] = useState(false);
    const [editing, setEditing] = useState(false);
    /** Whether the editor has changes the file does not, which is what lights up
     *  Save. The editor answers the question rather than announcing it, so this
     *  arrives from `WordEditor`'s own polling of it. */
    const [dirty, setDirty] = useState(false);
    /** Bumped by a save, so the reading view re-reads the file it just wrote
     *  instead of showing what was there before. */
    const [revision, setRevision] = useState(0);
    /** How the toolbar asks the editor for the document. */
    const control = useRef<WordEditorControl | null>(null);
    const theme =
        typeof document !== "undefined" &&
        document.documentElement.getAttribute("data-theme") === "dark"
            ? ("dark" as const)
            : ("light" as const);

    useEffect(() => {
        let alive = true;
        setHtml(null);
        setError(false);
        void (async () => {
            try {
                const [mammoth, response] = await Promise.all([
                    import("mammoth"),
                    // No cache, because this same address is re-read after a
                    // save and the browser would hand back the old document.
                    fetch(src, { cache: "no-store" })
                ]);
                const arrayBuffer = await response.arrayBuffer();
                if (!alive) return;
                const result = await mammoth.convertToHtml({ arrayBuffer });
                if (alive) setHtml(result.value);
            } catch {
                if (alive) setError(true);
            }
        })();
        return () => {
            alive = false;
        };
    }, [src, revision]);

    if (error) return <ViewerError>This document could not be rendered.</ViewerError>;
    if (html === null) return <Loading />;

    const editable = !readOnly && Boolean(target);

    return (
        <div className="flex max-h-[80vh] flex-col">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                {editing && target ? (
                    <>
                        <span className="text-xs font-medium text-muted-foreground">Editing</span>
                        <div className="ml-auto flex items-center gap-2">
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                    setEditing(false);
                                    setDirty(false);
                                }}
                            >
                                Cancel
                            </Button>
                            {/* The same toolbar every other editor in Drive
                                saves through. A second save path would be a
                                second set of rules about when a file may be
                                overwritten. */}
                            <EditorActions
                                target={target}
                                dirty={dirty}
                                exportAs={async () => {
                                    // Thrown rather than an empty document: the
                                    // toolbar turns this into "Could not prepare
                                    // this file", which is the truth, and it
                                    // does not overwrite anything.
                                    const bytes = await control.current?.bytes();
                                    if (!bytes) throw new Error("no bytes");
                                    return new Blob([bytes as BlobPart], { type: DOCX });
                                }}
                                onSaved={(name) => {
                                    setEditing(false);
                                    setDirty(false);
                                    setRevision((n) => n + 1);
                                    onSaved?.(name);
                                }}
                            />
                        </div>
                    </>
                ) : (
                    <>
                        <span className="text-xs text-muted-foreground">Word document</span>
                        {editable ? (
                            <Button
                                size="sm"
                                variant="ghost"
                                className="ml-auto"
                                onClick={() => setEditing(true)}
                            >
                                <Pencil className="size-4" />
                                Edit
                            </Button>
                        ) : null}
                    </>
                )}
            </div>

            {editing && target ? (
                <div className="min-h-0 flex-1 overflow-hidden">
                    <WordEditor
                        src={src}
                        name={target.name}
                        theme={theme}
                        control={control}
                        onDirty={setDirty}
                    />
                </div>
            ) : (
                <div className="mx-auto max-w-3xl overflow-auto p-6">
            <style>{`
                .doc-preview { line-height: 1.6; }
                .doc-preview h1 { font-size: 1.5rem; font-weight: 600; margin: 1rem 0 0.5rem; }
                .doc-preview h2 { font-size: 1.25rem; font-weight: 600; margin: 1rem 0 0.5rem; }
                .doc-preview p { margin: 0.5rem 0; }
                .doc-preview ul, .doc-preview ol { margin: 0.5rem 0 0.5rem 1.5rem; }
                .doc-preview table { border-collapse: collapse; margin: 0.5rem 0; }
                .doc-preview td, .doc-preview th { border: 1px solid hsl(var(--border)); padding: 4px 8px; }
                .doc-preview a { color: hsl(var(--primary)); text-decoration: underline; }
            `}</style>
                    <div
                        className="doc-preview text-sm"
                        dangerouslySetInnerHTML={{ __html: html }}
                    />
                </div>
            )}
        </div>
    );
}
