"use client";

/**
 * A select whose options can be typed down to the one somebody is after.
 *
 * The same props as `Select`, plus the two sentences a search box needs. Meant
 * for lists long enough that scrolling is the slow part - every Minecraft
 * release, every build of a mod loader - where people arrive knowing the
 * value ("1.21.4") rather than where it sits.
 *
 * Built on the menu primitives rather than Radix's listbox: a text field inside
 * the listbox loses its focus to the list the moment it opens and every key is
 * read as a jump to an option, which the menu's own search field already
 * settles (see `MenuSearch`). The menu is portalled and kept on screen, so a
 * dialog or a card that clips its overflow cannot cut it off.
 */

import { cn } from "../lib/cn";
import { useMemo, useState } from "react";
import type { SelectOption } from "./select";
import { Check, ChevronDown } from "lucide-react";
import { MenuSearch, menuSearchMatches } from "./menu-search";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "./dropdown-menu";

export interface SearchableSelectOption extends SelectOption {
    /** What typing matches besides the label, or instead of a label that is not
     *  plain text. */
    keywords?: string;
}

export interface SearchableSelectProps {
    value: string;
    onValueChange: (value: string) => void;
    options: SearchableSelectOption[];
    /** The search box's own words, which double as its accessible name. */
    searchPlaceholder: string;
    /** What the menu says when nothing is left after typing. */
    emptyText: string;
    placeholder?: string;
    disabled?: boolean;
    /** Class for the trigger. */
    className?: string;
    /** Class for the menu. */
    contentClassName?: string;
    id?: string;
    "aria-label"?: string;
}

/** The text an option is found by. */
function searchTextOf(option: SearchableSelectOption): string {
    const label = typeof option.label === "string" ? option.label : "";
    return [label, option.keywords ?? "", option.value].join(" ");
}

/** The options left after typing, in the order they were given. */
export function filterSearchableOptions(
    options: readonly SearchableSelectOption[],
    query: string
): SearchableSelectOption[] {
    return options.filter((option) => menuSearchMatches(searchTextOf(option), query));
}

export function SearchableSelect({
    value,
    onValueChange,
    options,
    searchPlaceholder,
    emptyText,
    placeholder,
    disabled,
    className,
    contentClassName,
    id,
    "aria-label": ariaLabel
}: SearchableSelectProps) {
    const [query, setQuery] = useState("");
    const selected = options.find((option) => option.value === value);
    const shown = useMemo(() => filterSearchableOptions(options, query), [options, query]);

    return (
        // An old search is not what somebody reopening the menu is looking for.
        <DropdownMenu onOpenChange={(open) => (open ? setQuery("") : undefined)}>
            <DropdownMenuTrigger
                id={id}
                disabled={disabled}
                aria-label={ariaLabel}
                className={cn(
                    "group flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-border bg-field px-2.5 text-left text-[0.8125rem] transition-colors duration-fast hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:border-border-strong",
                    className
                )}
            >
                <span className="flex min-w-0 items-center gap-2">
                    {selected ? (
                        <>
                            {selected.icon != null && (
                                <span className="flex shrink-0 items-center">{selected.icon}</span>
                            )}
                            <span
                                className="truncate"
                                title={
                                    typeof selected.label === "string" ? selected.label : undefined
                                }
                            >
                                {selected.label}
                            </span>
                        </>
                    ) : (
                        <span className="truncate text-foreground-subtle">
                            {placeholder ?? value}
                        </span>
                    )}
                </span>
                <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align="start"
                className={cn(
                    "max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] min-w-[--radix-dropdown-menu-trigger-width]",
                    contentClassName
                )}
            >
                {/* Pinned above the list, so the box is still there to correct a
                    search after scrolling down what it found. */}
                <MenuSearch
                    value={query}
                    onChange={setQuery}
                    placeholder={searchPlaceholder}
                    className="sticky -top-1 z-10 -mx-1 -mt-1 bg-elevated px-3 pt-2"
                />
                {shown.length === 0 ? (
                    <p className="px-2 py-3 text-[0.75rem] text-muted-foreground">{emptyText}</p>
                ) : (
                    shown.map((option) => (
                        <DropdownMenuItem
                            key={option.value}
                            disabled={option.disabled}
                            onSelect={() => onValueChange(option.value)}
                            className="pr-8"
                        >
                            {option.icon != null && (
                                <span className="flex shrink-0 items-center">{option.icon}</span>
                            )}
                            {/* A long label is cut to the menu's width; the whole of
                                it is still there on hover. */}
                            <span
                                className="min-w-0 flex-1 truncate"
                                title={typeof option.label === "string" ? option.label : undefined}
                            >
                                {option.label}
                            </span>
                            {option.value === value && (
                                <Check className="absolute right-2 text-primary" />
                            )}
                        </DropdownMenuItem>
                    ))
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
