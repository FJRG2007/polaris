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
import { Pencil } from "lucide-react";
import { Button, cn } from "@polaris/ui";
import { CopyButton } from "@/components/copy-button";
import { useHighlighter } from "@/lib/code-highlight";
import { languageForFile } from "@/lib/code-language";
import { EditorActions } from "./editor-actions";
import { Loading, ViewerError } from "./status";
import { readOnlyReason, useTextFile } from "./text-file";
import type { ViewerTarget } from "./types";

/** Metrics both layers of the editor must agree on, to the pixel. */
const CODE_LAYER = "col-start-1 row-start-1 whitespace-pre p-4 font-mono text-xs leading-relaxed";

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
    const highlight = useHighlighter(language?.id ?? null);

    if (error) return <ViewerError>This file could not be read.</ViewerError>;
    if (!file) return <Loading />;

    const blocked = readOnlyReason(file);
    const editable = !readOnly && !blocked;
    const code = editing ? draft : file.text;
    const painted = language && highlight ? highlight(code, language.id) : null;
    const lines = code.split("\n").length;

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
            <div className="min-h-0 flex-1 overflow-auto">
                <div className="flex min-h-full w-fit min-w-full">
                    <LineNumbers count={lines} />
                    <div className="grid flex-1">
                        {/* The trailing newline gives the last line a box of its own,
                            so the caret at the end of the file stays visible. */}
                        <pre className={CODE_LAYER} aria-hidden={editing}>
                            {painted === null ? (
                                <code>{`${code}\n`}</code>
                            ) : (
                                <code dangerouslySetInnerHTML={{ __html: `${painted}\n` }} />
                            )}
                        </pre>
                        {editing ? (
                            <textarea
                                value={draft}
                                onChange={(event) => setDraft(event.target.value)}
                                wrap="off"
                                spellCheck={false}
                                aria-label={`${target.name} contents`}
                                className={cn(
                                    CODE_LAYER,
                                    "resize-none overflow-hidden border-0 bg-transparent text-transparent caret-foreground outline-none"
                                )}
                            />
                        ) : null}
                    </div>
                </div>
            </div>
        </div>
    );
}

/** The gutter. Sticky, so the numbers stay put when a long line scrolls sideways. */
function LineNumbers({ count }: { count: number }) {
    const numbers: string[] = [];
    for (let line = 1; line <= count; line++) numbers.push(String(line));

    return (
        <pre
            aria-hidden
            className="sticky left-0 select-none border-r border-border bg-surface py-4 pl-4 pr-3 text-right font-mono text-xs leading-relaxed text-muted-foreground"
        >
            {numbers.join("\n")}
        </pre>
    );
}
