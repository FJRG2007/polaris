"use client";

/**
 * Markdown viewer: sanitized rendered ("pretty") or raw source, plus inline
 * editing that writes back through the shared save actions.
 */

import { useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { Button, cn } from "@polaris/ui";
import { EditorActions } from "./editor-actions";
import { Loading, ViewerError } from "./status";
import { readOnlyReason, useTextFile } from "./text-file";
import type { ViewerTarget } from "./types";

// Register the link-hardening hook once (module-scoped): every anchor opens in a
// new tab and cannot reach back into the opener.
let purifyHooked = false;

/**
 * Render Markdown to sanitized HTML. Parsing (marked) and sanitizing (DOMPurify)
 * are dynamically imported so they never touch the main bundle. The sanitizer is
 * deliberately strict: style/link/iframe/script/form/object and inline `style`
 * attributes are stripped, so a document can never inject CSS, exfiltrate, or run
 * script - only formatting, links, and images survive. All same-origin.
 */
async function renderMarkdown(markdown: string): Promise<string> {
    const [{ marked }, purifyModule] = await Promise.all([import("marked"), import("dompurify")]);
    const DOMPurify = purifyModule.default;
    if (!purifyHooked) {
        DOMPurify.addHook("afterSanitizeAttributes", (node) => {
            if (node.tagName === "A") {
                node.setAttribute("target", "_blank");
                node.setAttribute("rel", "noopener noreferrer nofollow");
            }
        });
        purifyHooked = true;
    }
    const dirty = marked.parse(markdown, { async: false, gfm: true }) as string;
    return DOMPurify.sanitize(dirty, {
        FORBID_TAGS: [
            "style",
            "link",
            "iframe",
            "script",
            "form",
            "input",
            "button",
            "meta",
            "base",
            "object",
            "embed"
        ],
        FORBID_ATTR: ["style", "srcset", "onerror", "onload"],
        ADD_ATTR: ["target", "rel"]
    });
}

/** Tailwind styling for rendered Markdown (no typography plugin needed). */
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
    "[&_table]:w-full [&_table]:text-left [&_th]:border-b [&_th]:border-border [&_th]:p-2 [&_td]:border-b [&_td]:border-border [&_td]:p-2"
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
                    <div className={MARKDOWN_PROSE} dangerouslySetInnerHTML={{ __html: html }} />
                )}
            </div>
        </div>
    );
}
