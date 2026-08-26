"use client";

/**
 * Searching the text of the open document. pdf.js already carries the find
 * controller and does the extraction, the match counting and the scrolling; this
 * is the bar that asks it and reads back what it found.
 */

import { Button, Input, cn } from "@polaris/ui";
import type { PDFSlick } from "@pdfslick/react";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { FindState } from "pdfjs-dist/web/pdf_viewer.mjs";
import { matchSummary, type FindStatus } from "./pdf-controls";

function statusOf(state: number): FindStatus {
    if (state === FindState.PENDING) return "pending";
    if (state === FindState.NOT_FOUND) return "not-found";
    if (state === FindState.WRAPPED) return "wrapped";
    return "found";
}

export function PdfSearch({ pdfSlick, onClose }: { pdfSlick: PDFSlick | null; onClose: () => void }) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState("");
    const [status, setStatus] = useState<FindStatus>("idle");
    const [matches, setMatches] = useState({ current: 0, total: 0 });
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [entireWord, setEntireWord] = useState(false);
    const [highlightAll, setHighlightAll] = useState(true);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    useEffect(() => {
        if (!pdfSlick) return;
        const onCount = (event: unknown) => {
            const count = (event as { matchesCount?: { current: number; total: number } })
                .matchesCount;
            if (count) setMatches(count);
        };
        const onState = (event: unknown) => {
            const detail = event as {
                state: number;
                matchesCount?: { current: number; total: number };
            };
            setStatus(statusOf(detail.state));
            if (detail.matchesCount) setMatches(detail.matchesCount);
        };
        pdfSlick.on("updatefindmatchescount", onCount);
        pdfSlick.on("updatefindcontrolstate", onState);
        return () => {
            pdfSlick.off("updatefindmatchescount", onCount);
            pdfSlick.off("updatefindcontrolstate", onState);
        };
    }, [pdfSlick]);

    // Closing the bar drops the highlights with it: leaving a document painted
    // with matches for a query nobody can see any more is the worse state.
    useEffect(() => {
        return () => {
            pdfSlick?.dispatch("findbarclose", {});
        };
    }, [pdfSlick]);

    function find(type: string, findPrevious = false) {
        if (!pdfSlick) return;
        if (!query) {
            setStatus("idle");
            setMatches({ current: 0, total: 0 });
        }
        pdfSlick.dispatch("find", {
            type,
            query,
            caseSensitive,
            entireWord,
            highlightAll,
            findPrevious,
            matchDiacritics: false
        });
    }

    // Every option is part of the query, so changing one re-runs it rather than
    // waiting for the next keystroke to notice.
    useEffect(() => {
        find("");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query, caseSensitive, entireWord, highlightAll]);

    const summary = matchSummary(status, matches.current, matches.total);
    const stepping = status !== "idle" && matches.total > 0;

    return (
        <form
            className="flex items-center gap-2 border-b border-border px-3 py-2"
            onSubmit={(event) => {
                event.preventDefault();
                find("again");
            }}
        >
            <Input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Escape") onClose();
                }}
                placeholder="Find in document"
                spellCheck={false}
                className="h-8 w-56"
                aria-label="Find in document"
            />
            <span
                aria-live="polite"
                className="min-w-20 text-xs tabular-nums text-muted-foreground"
            >
                {summary}
            </span>
            <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                disabled={!stepping}
                onClick={() => find("again", true)}
                aria-label="Previous match"
                title="Previous match"
            >
                <ChevronUp className="size-4" />
            </Button>
            <Button
                type="submit"
                size="icon-sm"
                variant="ghost"
                disabled={!stepping}
                aria-label="Next match"
                title="Next match"
            >
                <ChevronDown className="size-4" />
            </Button>
            <div className="ml-auto flex items-center gap-1">
                <Toggle
                    pressed={highlightAll}
                    onPressedChange={setHighlightAll}
                    label="Highlight all"
                >
                    All
                </Toggle>
                <Toggle
                    pressed={caseSensitive}
                    onPressedChange={setCaseSensitive}
                    label="Match case"
                >
                    Aa
                </Toggle>
                <Toggle pressed={entireWord} onPressedChange={setEntireWord} label="Whole words">
                    Ab|
                </Toggle>
                <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    onClick={onClose}
                    aria-label="Close search"
                    title="Close search"
                >
                    <X className="size-4" />
                </Button>
            </div>
        </form>
    );
}

function Toggle({
    pressed,
    onPressedChange,
    label,
    children
}: {
    pressed: boolean;
    onPressedChange: (pressed: boolean) => void;
    label: string;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            aria-pressed={pressed}
            title={label}
            aria-label={label}
            onClick={() => onPressedChange(!pressed)}
            className={cn(
                "rounded px-2 py-1 text-xs transition-colors hover:bg-card-hover",
                pressed ? "bg-muted font-medium text-foreground" : "text-muted-foreground"
            )}
        >
            {children}
        </button>
    );
}
