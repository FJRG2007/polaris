"use client";

/**
 * Notepad-style viewer/editor for any file without a richer viewer. Reads the
 * first 500 KB, shows it verbatim, and writes edits back through the shared save
 * actions. Binary content or a truncated read stays read-only so a save can
 * never corrupt or truncate the file.
 */

import { useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@polaris/ui";
import { EditorActions } from "./editor-actions";
import { Loading, ViewerError } from "./status";
import { readOnlyReason, useTextFile } from "./text-file";
import type { ViewerTarget } from "./types";

export function PlainTextEditor({
    src,
    target,
    readOnly = false,
    onSaved
}: {
    src: string;
    target: ViewerTarget;
    readOnly?: boolean;
    onSaved?: (name: string) => void;
}) {
    const { file, error, setText } = useTextFile(src);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");

    if (error) return <ViewerError>This file could not be read.</ViewerError>;
    if (!file) return <Loading />;

    const blocked = readOnlyReason(file);
    const editable = !readOnly && !blocked;

    /** A copy keeps the draft open; overwriting the original makes it the baseline. */
    function afterSave(name: string) {
        if (name === target.name) {
            setText(draft);
            setEditing(false);
        }
        onSaved?.(name);
    }

    return (
        <div className="flex max-h-[80vh] flex-col">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                {editing ? (
                    <>
                        <span className="text-xs font-medium text-muted-foreground">Editing</span>
                        <div className="ml-auto flex items-center gap-2">
                            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                                Cancel
                            </Button>
                            <EditorActions
                                target={target}
                                dirty={draft !== file.text}
                                exportAs={async () => new Blob([draft], { type: "text/plain" })}
                                onSaved={afterSave}
                            />
                        </div>
                    </>
                ) : (
                    <>
                        <span className="text-xs font-medium text-muted-foreground">
                            {blocked ?? "Plain text"}
                        </span>
                        {editable ? (
                            <Button
                                size="sm"
                                variant="ghost"
                                className="ml-auto"
                                onClick={() => {
                                    setDraft(file.text);
                                    setEditing(true);
                                }}
                            >
                                <Pencil className="size-4" />
                                Edit
                            </Button>
                        ) : null}
                    </>
                )}
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
                {editing ? (
                    <textarea
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        spellCheck={false}
                        className="h-full min-h-[50vh] w-full resize-none border-0 bg-transparent p-4 font-mono text-xs leading-relaxed outline-none"
                    />
                ) : (
                    <pre className="overflow-auto p-4 text-xs leading-relaxed">{file.text}</pre>
                )}
            </div>
        </div>
    );
}
