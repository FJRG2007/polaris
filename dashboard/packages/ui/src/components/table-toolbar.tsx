"use client";

/**
 * The parts every list toolbar in Polaris is made of: a search field with its
 * icon inside, and a column heading that sorts by its own column. Lifted out of
 * the containers list so the next table sorts and searches the same way rather
 * than by a third look-alike.
 */

import { cn } from "../lib/cn";
import { Input, type InputProps } from "./input";
import { forwardRef, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Search } from "lucide-react";

export type SortDirection = "asc" | "desc";

/** A search box with the magnifier drawn inside it. `className` sizes the
 *  wrapper, so a toolbar can let it grow while the filters keep their width. */
export const SearchField = forwardRef<HTMLInputElement, InputProps & { wrapperClassName?: string }>(
    function SearchField({ className, wrapperClassName, ...props }, ref) {
        return (
            <div className={cn("relative min-w-0", wrapperClassName)}>
                <Search
                    className="pointer-events-none absolute start-2.5 top-1/2 size-4 shrink-0 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                />
                <Input
                    ref={ref}
                    type="search"
                    spellCheck={false}
                    autoComplete="off"
                    {...props}
                    className={cn("ps-8", className)}
                />
            </div>
        );
    }
);

/**
 * A column heading that sorts by its own column.
 *
 * The whole heading is the control rather than an icon beside it: the target is
 * the width of the column, which is what makes this usable on a phone and with a
 * pointer somebody is not aiming carefully. `aria-sort` is what carries the same
 * fact to a screen reader, where the arrow is not there to be seen.
 */
export function SortHeader<O extends string>({
    label,
    order,
    sort,
    onSort,
    className
}: {
    label: ReactNode;
    order: O;
    sort: { order: O; direction: SortDirection };
    onSort: (order: O) => void;
    className?: string;
}) {
    const active = sort.order === order;
    const Arrow = sort.direction === "asc" ? ArrowUp : ArrowDown;
    return (
        <th
            scope="col"
            className={cn("px-0 py-0 font-medium", className)}
            aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
        >
            <button
                type="button"
                onClick={() => onSort(order)}
                className={cn(
                    "flex w-full items-center gap-1 whitespace-nowrap px-3 py-2 text-start transition-colors hover:text-foreground",
                    active && "text-foreground"
                )}
            >
                {label}
                {active ? <Arrow className="size-3 shrink-0" aria-hidden="true" /> : null}
            </button>
        </th>
    );
}

/** The next sort after a heading is pressed: the same column flips, a new one
 *  starts in the direction it reads best in. Pure. */
export function nextSort<O extends string>(
    current: { order: O; direction: SortDirection },
    order: O,
    initial: SortDirection = "asc"
): { order: O; direction: SortDirection } {
    if (current.order === order) return { order, direction: current.direction === "asc" ? "desc" : "asc" };
    return { order, direction: initial };
}
