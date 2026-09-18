"use client";

/**
 * The shell every game's player table is drawn in.
 *
 * What a row says differs completely between games - Minecraft folds five lists
 * into one name, ARK has a Steam id and an allow list - but everything around the
 * rows is the same screen: a search box, a filter, a bordered scroller, a header,
 * an empty state that says which kind of empty it is, and per-row actions that are
 * icons rather than a wall of text buttons. That was written twice, and the second
 * copy came out subtly different: different padding, no search, an empty state
 * that could not tell "nobody is here" from "the server has not answered".
 *
 * So the chrome lives here and each game supplies its columns and its rows. It is
 * deliberately presentational: no fetching, no actions of its own, nothing that
 * knows what a player is. A game that needs a column nobody else has just declares
 * one.
 */

import { Search } from "lucide-react";
import type { ReactNode } from "react";
import { Button, Input, Select, cn } from "@polaris/ui";

export interface PlayersTableColumn {
    readonly label: string;
    /** Extra classes, for the columns that are detail and fold away on a phone. */
    readonly className?: string;
}

export interface PlayersFilter {
    readonly value: string;
    readonly label: string;
}

export function PlayersTable({
    columns,
    rows,
    isEmpty,
    empty,
    search,
    onSearch,
    searchPlaceholder = "Search players",
    filter,
    filters,
    onFilter,
    toolbar,
    minWidth = "40rem"
}: {
    readonly columns: readonly PlayersTableColumn[];
    /** The `<tr>` rows themselves. The caller owns what a row is. */
    readonly rows: ReactNode;
    readonly isEmpty: boolean;
    /** What to say when there are none - which is never one sentence: a server
     *  that has not answered and a server nobody is on are different empties. */
    readonly empty: ReactNode;
    readonly search?: string;
    readonly onSearch?: (value: string) => void;
    readonly searchPlaceholder?: string;
    readonly filter?: string;
    readonly filters?: readonly PlayersFilter[];
    readonly onFilter?: (value: string) => void;
    /** Anything else that belongs beside the search box - a switch, a button. */
    readonly toolbar?: ReactNode;
    readonly minWidth?: string;
}) {
    const hasToolbar = onSearch !== undefined || (filters && filters.length > 0) || toolbar !== undefined;

    return (
        <div className="flex flex-col gap-2">
            {hasToolbar && (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    {onSearch && (
                        <div className="relative flex-1">
                            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                className="pl-9"
                                placeholder={searchPlaceholder}
                                aria-label="Search players"
                                value={search ?? ""}
                                onChange={(event) => onSearch(event.target.value)}
                            />
                        </div>
                    )}
                    {filters && filters.length > 0 && onFilter && (
                        <Select
                            className="sm:w-44"
                            aria-label="Filter players"
                            value={filter ?? filters[0]?.value ?? ""}
                            onValueChange={onFilter}
                            options={filters.map((entry) => ({ value: entry.value, label: entry.label }))}
                        />
                    )}
                    {toolbar}
                </div>
            )}

            <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm" style={{ minWidth }}>
                    <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                        <tr>
                            {columns.map((column) => (
                                <th key={column.label} className={cn("px-3 py-2 font-medium", column.className)}>
                                    {column.label}
                                </th>
                            ))}
                            {/* The actions column carries no heading: it is icons, and
                                a word above them would be the widest thing in it. */}
                            <th className="px-3 py-2" />
                        </tr>
                    </thead>
                    <tbody>
                        {isEmpty ? (
                            <tr>
                                <td
                                    colSpan={columns.length + 1}
                                    className="px-3 py-8 text-center text-muted-foreground"
                                >
                                    {empty}
                                </td>
                            </tr>
                        ) : (
                            rows
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

/**
 * One verb on a row.
 *
 * An icon rather than a label because these repeat down every row, and six words
 * per row is a table nobody can scan. The name still exists twice - as the
 * accessible label and as the tooltip - so it is reachable by a screen reader and
 * by anybody who hovers, which is the whole bargain an icon button makes.
 */
export function PlayerIconAction({
    label,
    icon,
    onClick,
    disabled,
    danger
}: {
    label: string;
    icon: ReactNode;
    onClick: () => void;
    disabled?: boolean;
    danger?: boolean;
}) {
    return (
        <Button
            size="icon"
            variant="ghost"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            title={label}
            className={danger ? "text-danger hover:text-danger" : undefined}
        >
            {icon}
        </Button>
    );
}
