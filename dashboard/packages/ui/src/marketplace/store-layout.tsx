"use client";

/**
 * The store's page around its cards: the search, sort and category bar, the
 * titled sections the cards sit in, the line shown when nothing matches, and
 * the overflow menu a card keeps its secondary actions in.
 *
 * Drawn by the dashboard's marketplace and by the public site's, so the two
 * are the same page. Everything here is presentational: what is listed, how it
 * is filtered and what an entry does are the caller's.
 */

import type { ReactNode } from "react";
import { Input } from "../components/input";
import { Select } from "../components/select";
import { Button } from "../components/button";
import { Skeleton } from "../components/skeleton";
import { cn } from "../lib/cn";
import { PREVIEW_HEIGHT } from "./store-card";
import { MoreHorizontal, Search } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "../components/dropdown-menu";

/** One category button: `value` is the caller's id, `label` what it reads. */
export interface StoreFilterOption<T extends string> {
    readonly value: T;
    readonly label: string;
}

/** The search box and sort above the category buttons; a list with one order passes no sort. */
export function StoreFilters<S extends string, C extends string>({
    query,
    onQueryChange,
    sort,
    onSortChange,
    sorts,
    category,
    onCategoryChange,
    categories,
    words
}: {
    query: string;
    onQueryChange: (query: string) => void;
    sort?: S;
    onSortChange?: (sort: S) => void;
    sorts?: readonly StoreFilterOption<S>[];
    category: C;
    onCategoryChange: (category: C) => void;
    /** Every category button, "All" first. */
    categories: readonly StoreFilterOption<C>[];
    words: { search: string; sortLabel?: string; categories: string };
}) {
    return (
        <div className="flex min-w-0 flex-col gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <div className="relative min-w-0 flex-1 basis-60 sm:max-w-md">
                    <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={query}
                        onChange={(event) => onQueryChange(event.target.value)}
                        placeholder={words.search}
                        aria-label={words.search}
                        className="ps-8"
                    />
                </div>
                {sorts && sort !== undefined ? (
                    <Select
                        value={sort}
                        onValueChange={(value) => onSortChange?.(value as S)}
                        aria-label={words.sortLabel}
                        className="w-44"
                        options={sorts.map((entry) => ({ value: entry.value, label: entry.label }))}
                    />
                ) : null}
            </div>
            <div
                role="group"
                aria-label={words.categories}
                className="flex min-w-0 flex-wrap gap-1.5"
            >
                {categories.map((entry) => (
                    <Button
                        key={entry.value || "all"}
                        size="sm"
                        variant={category === entry.value ? "primary" : "secondary"}
                        aria-pressed={category === entry.value}
                        onClick={() => onCategoryChange(entry.value)}
                    >
                        {entry.label}
                    </Button>
                ))}
            </div>
        </div>
    );
}

/**
 * How many cards a row holds, by the width the grid itself has - not the
 * viewport's - so a card is the same size wherever the store is drawn: the
 * dashboard beside its sidebar, a narrower account page, or the public site's
 * capped column. A shelf adds a column once each card keeps about 17.5rem; the
 * featured row once each keeps about 20rem, and stops at three.
 */
export const STORE_GRID = {
    shelf: "grid grid-cols-1 gap-4 [@container(min-width:36rem)]:grid-cols-2 [@container(min-width:54rem)]:grid-cols-3 [@container(min-width:73rem)]:grid-cols-4",
    featured: "grid grid-cols-1 gap-4 [@container(min-width:41rem)]:grid-cols-2 [@container(min-width:62rem)]:grid-cols-3"
} as const;

/**
 * A titled run of cards. `featured` is the wider three-column row the store
 * opens with; a shelf fits four on a wide one.
 */
export function StoreSection({
    label,
    featured = false,
    children
}: {
    label: string;
    featured?: boolean;
    children: ReactNode;
}) {
    return (
        <section className="flex min-w-0 flex-col gap-3 [container-type:inline-size]" aria-label={label}>
            <h2 className="text-sm font-medium text-muted-foreground">{label}</h2>
            <div className={featured ? STORE_GRID.featured : STORE_GRID.shelf}>{children}</div>
        </section>
    );
}

/**
 * Cards still loading, in the cards' own shape - the 16:10 preview, the mark
 * and name, two lines of summary and the footer - so nothing moves once they
 * arrive. Grid items, drawn inside a `StoreSection`.
 */
export function StoreCardSkeletons({ count = 3 }: { count?: number }) {
    return (
        <>
            {Array.from({ length: count }, (_, index) => (
                <div
                    key={index}
                    aria-hidden
                    data-store-skeleton
                    className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card"
                >
                    <div className="[container-type:inline-size]">
                        <Skeleton className={cn("w-full rounded-none", PREVIEW_HEIGHT)} />
                    </div>
                    <div className="flex min-w-0 flex-col gap-3 p-4">
                        <div className="flex min-w-0 items-center gap-3">
                            <Skeleton className="size-10 shrink-0 rounded-md" />
                            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                                <Skeleton className="h-4 w-2/3" />
                                <Skeleton className="h-3 w-1/3" />
                            </div>
                        </div>
                        <Skeleton className="h-3 w-full" />
                        <Skeleton className="h-3 w-4/5" />
                        <Skeleton className="h-8 w-24" />
                    </div>
                </div>
            ))}
        </>
    );
}

/** What the store says when the search and category leave nothing. */
export function StoreNoMatch({ children }: { children: ReactNode }) {
    return <p className="py-10 text-center text-sm text-muted-foreground">{children}</p>;
}

export interface OverflowEntry {
    readonly key: string;
    readonly label: string;
    readonly onSelect: () => void;
    readonly danger?: boolean;
    readonly disabled?: boolean;
    /** Why an entry is disabled, drawn under its label so it is read with it. */
    readonly hint?: string;
}

/**
 * Everything a card offers besides its leading action. Rendered only when it
 * has something in it, so a reader who may do nothing more sees no empty menu.
 */
export function OverflowMenu({ label, entries }: { label: string; entries: OverflowEntry[] }) {
    if (entries.length === 0) return null;
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" aria-label={label} title={label}>
                    <MoreHorizontal className="size-4" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                {entries.map((entry) => (
                    <DropdownMenuItem
                        key={entry.key}
                        onSelect={entry.onSelect}
                        disabled={entry.disabled}
                        variant={entry.danger ? "danger" : "default"}
                    >
                        {entry.hint ? (
                            <span className="flex min-w-0 flex-col">
                                <span>{entry.label}</span>
                                <span className="text-xs text-muted-foreground">{entry.hint}</span>
                            </span>
                        ) : (
                            entry.label
                        )}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
