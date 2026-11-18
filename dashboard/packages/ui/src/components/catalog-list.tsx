"use client";

/**
 * The "add an integration" flow's two lists, as Home Assistant draws them and
 * Places' Connect a device first did: a catalogue of makes with their marks,
 * found by typing, and - once one is picked - the ways in it offers, as cards to
 * weigh up. Shared so connecting an AI provider and connecting a lock read as
 * the same step, and so neither screen keeps its own look-alike.
 *
 * Neither list knows what it lists: the screen hands over the rows already
 * matched and the mark already drawn, which is what keeps matching (and its
 * memo) where the data is.
 */

import { cn } from "../lib/cn";
import { memo, type ReactNode } from "react";
import { Check, ChevronRight } from "lucide-react";

/** One row of a catalogue. */
export interface CatalogEntry {
    key: string;
    logo: ReactNode;
    title: string;
    /** Lines under the title, each truncated with its full text on hover. */
    lines?: readonly string[];
    /** Short tags at the end of the row: "Key", "Sign-in". */
    tags?: readonly string[];
}

/** One row, memoized: typing re-filters the list, and a row whose entry did not
 *  change is not drawn again. */
const CatalogRow = memo(function CatalogRow({ entry, onPick }: { entry: CatalogEntry; onPick: (key: string) => void }) {
    return (
        <li>
            <button
                type="button"
                onClick={() => onPick(entry.key)}
                className="flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-2 text-start transition-colors duration-fast hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
            >
                <span className="flex size-6 w-8 shrink-0 items-center justify-center">{entry.logo}</span>
                <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium" title={entry.title}>
                        {entry.title}
                    </span>
                    {(entry.lines ?? []).map((line, index) => (
                        <span key={index} className="truncate text-[0.6875rem] text-foreground-subtle" title={line}>
                            {line}
                        </span>
                    ))}
                </span>
                {entry.tags && entry.tags.length > 0 ? (
                    <span className="flex min-w-0 shrink flex-wrap justify-end gap-1">
                        {entry.tags.map((tag) => (
                            <span
                                key={tag}
                                className="truncate rounded bg-muted px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground"
                            >
                                {tag}
                            </span>
                        ))}
                    </span>
                ) : null}
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
        </li>
    );
});

/** The catalogue: the entries given, in the order given, scrolling on its own. */
export function CatalogList({
    entries,
    onPick,
    label,
    empty,
    footer,
    className
}: {
    entries: readonly CatalogEntry[];
    onPick: (key: string) => void;
    label: string;
    /** Said where nothing matched; omitted while something is still loading. */
    empty?: ReactNode;
    /** Drawn after the rows, inside the scroll: a loading region, "Show more". */
    footer?: ReactNode;
    className?: string;
}) {
    return (
        <div className={cn("-mx-1 flex min-h-0 flex-col overflow-y-auto overscroll-contain px-1", className)}>
            {entries.length === 0 && empty ? (
                <p className="px-1 py-6 text-center text-sm text-muted-foreground">{empty}</p>
            ) : (
                <ul aria-label={label} className="flex flex-col">
                    {entries.map((entry) => (
                        <CatalogRow key={entry.key} entry={entry} onPick={onPick} />
                    ))}
                </ul>
            )}
            {footer}
        </div>
    );
}

/** The make that was picked, above its ways in, with a way back to the list. */
export function CatalogPicked({
    logo,
    title,
    lines,
    action
}: {
    logo: ReactNode;
    title: string;
    lines?: readonly string[];
    action?: ReactNode;
}) {
    return (
        <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2">
            <span className="flex size-6 w-8 shrink-0 items-center justify-center">{logo}</span>
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium" title={title}>
                    {title}
                </span>
                {(lines ?? []).map((line, index) => (
                    <span key={index} className="truncate text-[0.6875rem] text-foreground-subtle" title={line}>
                        {line}
                    </span>
                ))}
            </span>
            {action}
        </div>
    );
}

/** One way in, as a card: pressed when it is the one chosen. */
export function ChoiceCard({
    selected,
    onSelect,
    logo,
    title,
    badges,
    summary
}: {
    selected: boolean;
    onSelect: () => void;
    logo?: ReactNode;
    title: ReactNode;
    badges?: ReactNode;
    summary?: ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onSelect}
            aria-pressed={selected}
            className={cn(
                "flex min-w-0 items-start gap-2 rounded-lg border px-3 py-2 text-start transition-colors duration-fast",
                selected ? "border-accent bg-accent/10" : "border-border bg-card hover:border-border-strong"
            )}
        >
            <Check className={cn("mt-0.5 size-4 shrink-0", selected ? "text-accent" : "text-transparent")} />
            {logo ? <span className="mt-0.5 flex size-4 w-6 shrink-0 items-center justify-center">{logo}</span> : null}
            <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
                    {title}
                    {badges}
                </span>
                {summary ? <span className="text-[0.6875rem] text-muted-foreground">{summary}</span> : null}
            </span>
        </button>
    );
}

/** Case and accents folded away, so "cancion" finds "Canción". Pure. */
export function foldSearch(text: string): string {
    return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}
