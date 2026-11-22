"use client";

/**
 * Find in a terminal's output: the scrollback as well as the screen, every match
 * highlighted and the current one marked, with next/previous and a case toggle.
 *
 * Drawn inside the terminal panel rather than as a floating layer, so it is
 * there in full screen too (the browser shows only the fullscreen element's own
 * tree). Enter goes to the next match, Shift+Enter to the previous one, Escape
 * closes and hands the keyboard back to the terminal.
 */

import { Button, Input } from "@polaris/ui";
import { useEffect, useRef, useState } from "react";
import type { ISearchOptions } from "@xterm/addon-search";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { CaseSensitive, ChevronDown, ChevronUp, X } from "lucide-react";

/** How many matches are highlighted at most; past it the count says so. */
export const FIND_HIGHLIGHT_LIMIT = 1000;

/** What the bar needs of xterm's search addon, so a test can stand in for it. */
export interface TerminalSearch {
    findNext(term: string, options?: ISearchOptions): boolean;
    findPrevious(term: string, options?: ISearchOptions): boolean;
    clearDecorations(): void;
    onDidChangeResults(listener: (results: { resultIndex: number; resultCount: number }) => void): {
        dispose(): void;
    };
}

/** Matches drawn in the terminal's dark theme: every one, then the current one. */
const DECORATIONS: ISearchOptions["decorations"] = {
    matchBackground: "#4b3f13",
    matchBorder: "#a68a1f",
    matchOverviewRuler: "#a68a1f",
    activeMatchBackground: "#b45309",
    activeMatchBorder: "#fbbf24",
    activeMatchColorOverviewRuler: "#fbbf24"
};

export function TerminalFindBar({
    search,
    onClose
}: {
    /** Null until the terminal has loaded. */
    search: TerminalSearch | null;
    onClose: () => void;
}) {
    const t = useTranslations("common");
    const [query, setQuery] = useState("");
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [results, setResults] = useState<{ resultIndex: number; resultCount: number } | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, []);

    useEffect(() => {
        if (!search) return;
        const subscription = search.onDidChangeResults(setResults);
        return () => {
            subscription.dispose();
            search.clearDecorations();
        };
    }, [search]);

    const options = (incremental: boolean): ISearchOptions => ({
        caseSensitive,
        incremental,
        decorations: DECORATIONS
    });

    // Typing searches as it goes, from where the current match is, so the
    // highlight grows with the word instead of jumping to the next line.
    useEffect(() => {
        if (!search) return;
        if (!query) {
            search.clearDecorations();
            setResults(null);
            return;
        }
        search.findNext(query, options(true));
        // eslint-disable-next-line react-hooks/exhaustive-deps -- options is
        // rebuilt from caseSensitive, which is listed.
    }, [search, query, caseSensitive]);

    const step = (backwards: boolean): void => {
        if (!search || !query) return;
        if (backwards) search.findPrevious(query, options(false));
        else search.findNext(query, options(false));
    };

    const count = !query || !results
        ? ""
        : results.resultCount === 0
          ? t("terminal.find.none")
          : results.resultIndex < 0
            ? t("terminal.find.tooMany", { limit: FIND_HIGHLIGHT_LIMIT })
            : t("terminal.find.count", { current: results.resultIndex + 1, total: results.resultCount });
    const none = Boolean(query) && results?.resultCount === 0;

    return (
        <div
            role="search"
            aria-label={t("terminal.find.label")}
            className="flex min-w-0 items-center gap-1 rounded-md border border-border bg-muted/40 p-1"
        >
            <Input
                ref={inputRef}
                value={query}
                aria-label={t("terminal.find.label")}
                aria-invalid={none || undefined}
                placeholder={t("terminal.find.placeholder")}
                className="h-7 min-w-0 flex-1 text-xs"
                spellCheck={false}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        step(event.shiftKey);
                    } else if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        onClose();
                    }
                }}
            />
            <span
                className={`min-w-0 shrink truncate px-1 text-[0.6875rem] tabular-nums ${none ? "text-danger" : "text-muted-foreground"}`}
                aria-live="polite"
                title={count}
            >
                {count}
            </span>
            <Button
                size="icon-xs"
                variant="ghost"
                aria-pressed={caseSensitive}
                aria-label={t("terminal.find.matchCase")}
                title={t("terminal.find.matchCase")}
                className={caseSensitive ? "bg-accent text-foreground" : undefined}
                onClick={() => setCaseSensitive((current) => !current)}
            >
                <CaseSensitive />
            </Button>
            <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t("terminal.find.previous")}
                title={t("terminal.find.previous")}
                disabled={!query || none}
                onClick={() => step(true)}
            >
                <ChevronUp />
            </Button>
            <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t("terminal.find.next")}
                title={t("terminal.find.next")}
                disabled={!query || none}
                onClick={() => step(false)}
            >
                <ChevronDown />
            </Button>
            <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t("terminal.find.close")}
                title={t("terminal.find.close")}
                onClick={onClose}
            >
                <X />
            </Button>
        </div>
    );
}
