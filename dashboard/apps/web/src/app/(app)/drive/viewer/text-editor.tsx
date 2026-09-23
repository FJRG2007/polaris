"use client";

/**
 * Notepad-style viewer/editor for any file without a richer viewer. Reads the
 * first 500 KB, shows it verbatim, and writes edits back through the shared save
 * actions. Binary content or a truncated read stays read-only so a save can
 * never corrupt or truncate the file.
 *
 * Ctrl+F finds, the same as in the code viewer next door. Reading, the hits are
 * boxed in the text; editing, each step selects the match in the box itself - a
 * browser already scrolls to a selection and paints it, and a highlight drawn
 * over a textarea would only be a second one to keep in step.
 */

import { Button } from "@polaris/ui";
import { FindBar } from "./find-bar";
import type { ViewerTarget } from "./types";
import { Pencil, Search } from "lucide-react";
import { Loading, ViewerError } from "./status";
import { EditorActions } from "./editor-actions";
import { readOnlyReason, useTextFile } from "./text-file";
import { useEffect, useMemo, useRef, useState } from "react";
import { findMatches, markedParts, stepMatch } from "./find-in-file";

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
    const [finding, setFinding] = useState(false);
    const [query, setQuery] = useState("");
    const [at, setAt] = useState(0);
    const box = useRef<HTMLTextAreaElement>(null);

    const text = editing ? draft : (file?.text ?? "");
    // Recomputed as the text changes, so a find stays true while somebody edits
    // rather than boxing where the words used to be.
    const matches = useMemo(() => findMatches(text, query), [text, query]);

    if (error) return <ViewerError>This file could not be read.</ViewerError>;
    if (!file) return <Loading />;

    const blocked = readOnlyReason(file);
    const editable = !readOnly && !blocked;
    const on = matches.length === 0 ? 0 : Math.min(at, matches.length - 1);

    function find(open: boolean) {
        setFinding(open);
        if (!open) setQuery("");
    }

    /** Step, and put the match where it can be seen: selected in the box while
     *  editing, and scrolled to by the mark itself while reading. */
    function step(by: 1 | -1) {
        const next = stepMatch(on, matches.length, by);
        setAt(next);
        const match = matches[next];
        if (!match || !editing) return;
        const area = box.current;
        if (!area) return;
        area.focus();
        area.setSelectionRange(match.start, match.end);
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
            className="flex max-h-[80vh] flex-col"
            onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
                    // Taken from the browser's own find, which searches the page
                    // around this file rather than the file - and a viewer that
                    // scrolls inside a box is exactly where that goes wrong.
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
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => find(!finding)}
                                aria-label="Find in this file"
                                title="Find in this file (Ctrl+F)"
                            >
                                <Search className="size-4" />
                            </Button>
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
                        <div className="ml-auto flex items-center gap-2">
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
                    onStep={step}
                    onClose={() => find(false)}
                />
            ) : null}
            <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
                {editing ? (
                    <textarea
                        ref={box}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        spellCheck={false}
                        className="h-full min-h-[50vh] w-full resize-none border-0 bg-transparent p-4 font-mono text-xs leading-relaxed outline-none"
                    />
                ) : (
                    // Sideways only, and never contained. The box around it is
                    // what scrolls down; this only has a long line to reach. A
                    // `pre` that could scroll both ways and kept its scrolling to
                    // itself took every turn of the wheel over the text and had
                    // nowhere to spend it - so the text did not move unless the
                    // scrollbar was dragged.
                    <pre className="overflow-x-auto p-4 text-xs leading-relaxed">
                        {matches.length === 0
                            ? file.text
                            : markedParts(file.text, matches, on).map((part, index) =>
                                  part.hit ? (
                                      <Hit key={index} current={part.current} text={part.text} />
                                  ) : (
                                      <span key={index}>{part.text}</span>
                                  )
                              )}
                    </pre>
                )}
            </div>
        </div>
    );
}

/** One hit in the read view. The one being stepped through scrolls itself into
 *  the middle rather than waiting to be looked for. */
function Hit({ current, text }: { current: boolean; text: string }) {
    const mark = useRef<HTMLElement>(null);
    useEffect(() => {
        if (current) mark.current?.scrollIntoView({ block: "center", inline: "nearest" });
    }, [current]);

    return (
        <mark
            ref={mark}
            className={`rounded-sm text-foreground ${current ? "bg-primary/60" : "bg-primary/25"}`}
        >
            {text}
        </mark>
    );
}
