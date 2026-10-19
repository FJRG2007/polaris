"use client";

/**
 * The list a "/" opens, drawn once for every composer that has one.
 *
 * The rich-text editor drives it from a TipTap suggestion and Polar drives it
 * from a plain textarea, so the keys live with each caller and this only draws:
 * the rows, which one is highlighted, the reason a row cannot be picked, and the
 * ids a field points at with `aria-activedescendant`.
 */

import { cn } from "@polaris/ui";
import type { ComponentType } from "react";
import { POPUP_CLASS, POPUP_ITEM_CLASS } from "./suggestion";

export interface SuggestionListItem {
    readonly key: string;
    readonly label: string;
    /** A line beside the label; for a disabled row, why it cannot be picked. */
    readonly detail?: string;
    readonly icon: ComponentType<{ className?: string }>;
    readonly disabled?: boolean;
}

/** The id of one row, for the field's `aria-activedescendant`. */
export function suggestionOptionId(listId: string, index: number): string {
    return `${listId}-${index}`;
}

/** The first row that can be picked, or -1. */
export function firstPickable(items: readonly SuggestionListItem[]): number {
    return items.findIndex((item) => !item.disabled);
}

/** One step through the pickable rows, wrapping at either end. */
export function stepPickable(
    items: readonly SuggestionListItem[],
    current: number,
    step: 1 | -1
): number {
    const count = items.length;
    for (let offset = 1; offset <= count; offset++) {
        const index = (((current + step * offset) % count) + count) % count;
        if (!items[index]?.disabled) return index;
    }
    return current;
}

export function SuggestionList({
    id,
    label,
    items,
    active,
    onPick,
    onHover,
    className
}: {
    id: string;
    label?: string;
    items: readonly SuggestionListItem[];
    active: number;
    onPick: (index: number) => void;
    onHover: (index: number) => void;
    className?: string;
}) {
    if (items.length === 0) return null;
    return (
        <ul id={id} role="listbox" aria-label={label} className={cn(POPUP_CLASS, className)}>
            {items.map((item, index) => (
                <li key={item.key} role="presentation">
                    <button
                        type="button"
                        id={suggestionOptionId(id, index)}
                        role="option"
                        tabIndex={-1}
                        aria-selected={index === active}
                        aria-disabled={item.disabled || undefined}
                        title={item.detail ? `${item.label}: ${item.detail}` : item.label}
                        // Mouse down rather than click, so the field keeps the
                        // focus and the caret it had.
                        onMouseDown={(event) => {
                            event.preventDefault();
                            if (!item.disabled) onPick(index);
                        }}
                        onMouseEnter={() => {
                            if (!item.disabled) onHover(index);
                        }}
                        className={cn(
                            POPUP_ITEM_CLASS,
                            index === active ? "bg-option-hover" : "hover:bg-option-hover/60",
                            item.disabled && "cursor-not-allowed opacity-50 hover:bg-transparent"
                        )}
                    >
                        <item.icon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="shrink-0 truncate">{item.label}</span>
                        {item.detail ? (
                            <span className="min-w-0 truncate text-xs text-muted-foreground">
                                {item.detail}
                            </span>
                        ) : null}
                    </button>
                </li>
            ))}
        </ul>
    );
}
