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
import { useMemo, useState, type ReactNode } from "react";
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
    /** A second, muted line of text at the row's right end - a language's name
     *  in the reader's language, say. Searched too when it is plain text. */
    hint?: ReactNode;
}

export interface SearchableSelectProps {
    value: string;
    onValueChange: (value: string) => void;
    options: SearchableSelectOption[];
    /** The search box's own words, which double as its accessible name. */
    searchPlaceholder: string;
    /** What the menu says when nothing is left after typing. */
    emptyText: string;
    /**
     * The most options drawn at once. A list of thousands - everybody on a busy
     * server - is typed down rather than scrolled, and drawing every row of it
     * on each keystroke is what makes the field lag. The rest are still found
     * by typing; `moreText` says how many are not drawn.
     */
    limit?: number;
    /** The line under a cut list, given how many options it left out. */
    moreText?: (hidden: number) => string;
    /**
     * Lets what was typed be chosen even when no option is it - a player who is
     * not online, say - given the words of the row that offers it.
     */
    typedText?: (typed: string) => string;
    placeholder?: string;
    disabled?: boolean;
    /** Class for the trigger. */
    className?: string;
    /** Class for the menu. */
    contentClassName?: string;
    /** What the trigger shows for the chosen option, when its row would be too
     *  wide there (a flag and a calling code instead of a country's name). */
    renderValue?: (option: SearchableSelectOption) => ReactNode;
    id?: string;
    "aria-label"?: string;
}

/** The text an option is found by. */
function searchTextOf(option: SearchableSelectOption): string {
    const label = typeof option.label === "string" ? option.label : "";
    const hint = typeof option.hint === "string" ? option.hint : "";
    return [label, hint, option.keywords ?? "", option.value].join(" ");
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
    limit,
    moreText,
    typedText,
    placeholder,
    disabled,
    className,
    contentClassName,
    renderValue,
    id,
    "aria-label": ariaLabel
}: SearchableSelectProps) {
    const [query, setQuery] = useState("");
    const selected = options.find((option) => option.value === value);
    const found = useMemo(() => filterSearchableOptions(options, query), [options, query]);
    const shown = limit !== undefined ? found.slice(0, limit) : found;
    const hidden = found.length - shown.length;
    const typed = query.trim();
    const offerTyped =
        typedText !== undefined &&
        typed.length > 0 &&
        !options.some((option) => option.value.toLowerCase() === typed.toLowerCase());

    return (
        // An old search is not what somebody reopening the menu is looking for.
        <DropdownMenu onOpenChange={(open) => (open ? setQuery("") : undefined)}>
            <DropdownMenuTrigger
                id={id}
                disabled={disabled}
                aria-label={ariaLabel}
                className={cn(
                    // An icon that only keeps the menu's rows aligned
                    // (`data-icon-placeholder`) has nothing to say on the trigger.
                    "group flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-border bg-field px-2.5 text-start text-[0.8125rem] transition-colors duration-fast hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:border-border-strong [&_[data-icon-placeholder]]:hidden",
                    className
                )}
            >
                <span className="flex min-w-0 items-center gap-2">
                    {selected && renderValue ? (
                        renderValue(selected)
                    ) : selected ? (
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
                {shown.length === 0 && !offerTyped ? (
                    <p className="px-2 py-3 text-[0.75rem] text-muted-foreground">{emptyText}</p>
                ) : (
                    shown.map((option) => (
                        <DropdownMenuItem
                            key={option.value}
                            disabled={option.disabled}
                            onSelect={() => onValueChange(option.value)}
                            className="pe-8"
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
                            {option.hint != null && (
                                <span
                                    className="min-w-0 max-w-[50%] shrink truncate text-end text-[0.75rem] text-muted-foreground"
                                    title={
                                        typeof option.hint === "string" ? option.hint : undefined
                                    }
                                >
                                    {option.hint}
                                </span>
                            )}
                            {option.value === value && (
                                <Check className="absolute end-2 text-primary" />
                            )}
                        </DropdownMenuItem>
                    ))
                )}
                {offerTyped && (
                    <DropdownMenuItem onSelect={() => onValueChange(typed)}>
                        <span className="min-w-0 flex-1 truncate" title={typedText(typed)}>
                            {typedText(typed)}
                        </span>
                    </DropdownMenuItem>
                )}
                {hidden > 0 && moreText && (
                    <p className="px-2 py-2 text-[0.75rem] text-muted-foreground">
                        {moreText(hidden)}
                    </p>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
