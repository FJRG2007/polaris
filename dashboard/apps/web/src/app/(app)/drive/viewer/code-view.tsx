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
 *
 * Ctrl+F finds, reading or editing. A settings file is where this earns itself:
 * the line somebody opened the file for is one of three hundred, and every
 * editor they have ever used answers that press.
 */

import { useMemo, useState } from "react";
import { Button } from "@polaris/ui";
import { Pencil, Search } from "lucide-react";
import { FindBar } from "./find-bar";
import { findMatches, stepMatch } from "./find-in-file";
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
    const [finding, setFinding] = useState(false);
    const [query, setQuery] = useState("");
    const [at, setAt] = useState(0);
    const language = languageForFile(target.name);

    if (error) return <ViewerError>This file could not be read.</ViewerError>;
    if (!file) return <Loading />;

    const blocked = readOnlyReason(file);
    const editable = !readOnly && !blocked;
    const code = editing ? draft : file.text;
    // Recomputed as the text changes, so a find stays true while somebody edits
    // rather than boxing where the words used to be.
    const matches = useMemo(() => findMatches(code, query), [code, query]);
    const on = matches.length === 0 ? 0 : Math.min(at, matches.length - 1);

    function find(open: boolean) {
        setFinding(open);
        if (!open) setQuery("");
    }

    /** A copy keeps the draft open; overwriting the original makes it the baseline. */
    function afterSave(name: string) {
        if (name === target.name) {
            setText(draft);
            setEditing(false);
        }
        onSaved?.(name);
    }

    return (
        <div
            className="flex max-h-[80vh] flex-col bg-surface"
            onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
                    // Taken from the browser's own find, which searches the page
                    // around this file rather than the file - and a viewer that
                    // scrolls in a box is exactly where that goes wrong.
                    event.preventDefault();
                    find(true);
                } else if (event.key === "Escape" && finding) {
                    find(false);
                }
            }}
        >
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
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => find(!finding)}
                                aria-label="Find in this file"
                                title="Find in this file (Ctrl+F)"
                            >
                                <Search className="size-4" />
                            </Button>
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
            {finding ? (
                <FindBar
                    query={query}
                    onQuery={(value) => {
                        setQuery(value);
                        setAt(0);
                    }}
                    total={matches.length}
                    current={on}
                    onStep={(by) => setAt(stepMatch(on, matches.length, by))}
                    onClose={() => find(false)}
                />
            ) : null}
            <CodeSurface
                code={code}
                language={language?.id ?? null}
                ariaLabel={`${target.name} contents`}
                onChange={editing ? setDraft : undefined}
                matches={matches}
                currentMatch={on}
            />
        </div>
    );
}
