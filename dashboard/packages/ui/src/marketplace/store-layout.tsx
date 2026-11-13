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

/** The search box and sort above the category buttons. */
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
    sort: S;
    onSortChange: (sort: S) => void;
    sorts: readonly StoreFilterOption<S>[];
    category: C;
    onCategoryChange: (category: C) => void;
    /** Every category button, "All" first. */
    categories: readonly StoreFilterOption<C>[];
    words: { search: string; sortLabel: string; categories: string };
}) {
    return (
        <div className="flex min-w-0 flex-col gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <div className="relative min-w-0 flex-1 basis-60 sm:max-w-md">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={query}
                        onChange={(event) => onQueryChange(event.target.value)}
                        placeholder={words.search}
                        aria-label={words.search}
                        className="pl-8"
                    />
                </div>
                <Select
                    value={sort}
                    onValueChange={(value) => onSortChange(value as S)}
                    aria-label={words.sortLabel}
                    className="w-44"
                    options={sorts.map((entry) => ({ value: entry.value, label: entry.label }))}
                />
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
 * A titled run of cards. `featured` is the wider three-column row the store
 * opens with; a shelf fits four on a wide screen.
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
        <section className="flex min-w-0 flex-col gap-3" aria-label={label}>
            <h2 className="text-sm font-medium text-muted-foreground">{label}</h2>
            <div
                className={
                    featured
                        ? "grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
                        : "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
                }
            >
                {children}
            </div>
        </section>
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
