"use client";

/**
 * Viewer and editor for source files: the same read-cap, read-only guards and
 * save actions as the plain-text editor, with syntax highlighting and a line
 * gutter on top.
 *
 * Editing keeps the highlighting: a transparent textarea sits exactly on top of
 * the painted code, both stacked in one grid cell so they share their metrics
 * and the caret lands where the character is. The grammar is loaded once, up
 * front, which is what lets the paint keep up with typing.
 */

import { useState } from "react";
import { Button } from "@polaris/ui";
import { Pencil } from "lucide-react";
import type { ViewerTarget } from "./types";
import { Loading, ViewerError } from "./status";
import { EditorActions } from "./editor-actions";
import { CopyButton } from "@/components/copy-button";
import { languageForFile } from "@/lib/code-language";
import { CodeSurface } from "@/components/code-surface";
import { readOnlyReason, useTextFile } from "./text-file";

export function CodeView({
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
    const language = languageForFile(target.name);

    if (error) return <ViewerError>This file could not be read.</ViewerError>;
    if (!file) return <Loading />;

    const blocked = readOnlyReason(file);
    const editable = !readOnly && !blocked;
    const code = editing ? draft : file.text;

    /** A copy keeps the draft open; overwriting the original makes it the baseline. */
    function afterSave(name: string) {
        if (name === target.name) {
            setText(draft);
            setEditing(false);
        }
        onSaved?.(name);
    }

    return (
        <div className="flex max-h-[80vh] flex-col bg-surface">
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
                            {blocked ?? language?.label ?? "Code"}
                        </span>
                        <div className="ml-auto flex items-center gap-3">
                            {/* Nothing to copy honestly from a binary file, and a
                                truncated one would hand over half of itself. */}
                            {blocked === null ? (
                                <CopyButton value={file.text} label="file contents" />
                            ) : null}
                            {editable ? (
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => {
                                        setDraft(file.text);
                                        setEditing(true);
                                    }}
                                >
                                    <Pencil className="size-4" />
                                    Edit
                                </Button>
                            ) : null}
                        </div>
                    </>
                )}
            </div>
            <CodeSurface
                code={code}
                language={language?.id ?? null}
                ariaLabel={`${target.name} contents`}
                onChange={editing ? setDraft : undefined}
            />
        </div>
    );
}
