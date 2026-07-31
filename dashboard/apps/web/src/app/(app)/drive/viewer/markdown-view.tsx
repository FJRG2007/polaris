"use client";

/**
 * Markdown viewer: sanitized rendered ("pretty") or raw source, plus inline
 * editing that writes back through the shared save actions. The rendering rules
 * live in ./markdown-render, the copy affordances in ./markdown-content.
 */

import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { Button, cn } from "@polaris/ui";
import { EditorActions } from "./editor-actions";
import { MarkdownContent } from "./markdown-content";
import { renderMarkdown } from "./markdown-render";
import { Loading, ViewerError } from "./status";
import { readOnlyReason, useTextFile } from "./text-file";
import type { ViewerTarget } from "./types";

/**
 * Tailwind styling for rendered Markdown (no typography plugin needed). The last
 * three lines dress the copy affordances: the button sits over the block and
 * fades in on hover or when it takes focus, and inline code reads as clickable.
 */
const MARKDOWN_PROSE = cn(
    "max-w-none space-y-3 p-6 text-sm leading-relaxed",
    "[&_h1]:mt-2 [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:mt-2 [&_h2]:text-xl [&_h2]:font-semibold",
    "[&_h3]:text-lg [&_h3]:font-semibold [&_h4]:font-semibold",
    "[&_p]:leading-relaxed [&_a]:text-primary [&_a]:underline",
    "[&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-0.5",
    "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs",
    "[&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
    "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
    "[&_hr]:my-4 [&_hr]:border-border [&_img]:max-w-full [&_img]:rounded",
    "[&_table]:w-full [&_table]:text-left [&_th]:border-b [&_th]:border-border [&_th]:p-2 [&_td]:border-b [&_td]:border-border [&_td]:p-2",
    "[&_.code-block]:relative [&_.copy-host]:opacity-0 [&_.code-block:hover_.copy-host]:opacity-100",
    "[&_.copy-host:focus-within]:opacity-100",
    "[&_.copy-inline]:cursor-pointer [&_.copy-inline:hover]:bg-primary/20"
);

export function MarkdownView({
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
    const [mode, setMode] = useState<"pretty" | "raw">("pretty");
    const [html, setHtml] = useState("");
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");

    const text = file?.text ?? null;

    useEffect(() => {
        if (text === null || editing || mode !== "pretty") return;
        let alive = true;
        void renderMarkdown(text).then((rendered) => {
            if (alive) setHtml(rendered);
        });
        return () => {
            alive = false;
        };
    }, [text, editing, mode]);

    if (error) return <ViewerError>This file could not be read.</ViewerError>;
    if (!file) return <Loading />;

    // Same guard as the plain-text editor: a truncated read, a lossy/non-UTF-8
    // decode, or binary content stays read-only so a save can never corrupt or
    // truncate the file. Viewing (pretty/raw) still works either way.
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
                                exportAs={async () => new Blob([draft], { type: "text/markdown" })}
                                onSaved={afterSave}
                            />
                        </div>
                    </>
                ) : (
                    <>
                        <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
                            <button
                                type="button"
                                onClick={() => setMode("pretty")}
                                className={cn(
                                    "rounded px-2 py-1 text-xs transition-colors hover:bg-muted",
                                    mode === "pretty"
                                        ? "bg-muted font-medium"
                                        : "text-muted-foreground"
                                )}
                            >
                                Pretty
                            </button>
                            <button
                                type="button"
                                onClick={() => setMode("raw")}
                                className={cn(
                                    "rounded px-2 py-1 text-xs transition-colors hover:bg-muted",
                                    mode === "raw"
                                        ? "bg-muted font-medium"
                                        : "text-muted-foreground"
                                )}
                            >
                                Raw
                            </button>
                        </div>
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
                        ) : readOnly ? null : (
                            <span className="ml-auto text-xs text-muted-foreground">{blocked}</span>
                        )}
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
                ) : mode === "raw" ? (
                    <pre className="overflow-auto p-4 text-xs leading-relaxed">{file.text}</pre>
                ) : (
                    <MarkdownContent html={html} className={MARKDOWN_PROSE} />
                )}
            </div>
        </div>
    );
}
