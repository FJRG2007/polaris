"use client";

/**
 * The search panel's frame, shared by the dashboard's command palette and the
 * public site's docs search so both look and answer the keyboard the same way:
 * the field on top, results grouped under small headings, and the key hints
 * along the bottom. What goes in the list is the caller's.
 */

import { cn } from "../lib/cn";
import { Search } from "lucide-react";
import { highlightRanges } from "./search-match";
import { Input, type InputProps } from "../components/input";
import { Dialog, DialogContent, DialogTitle } from "../components/dialog";
import {
    forwardRef,
    type ButtonHTMLAttributes,
    type KeyboardEvent,
    type ReactNode,
    type Ref
} from "react";

/** The button that opens the panel: an icon, a label, and the shortcut that does the same. */
export const SearchTrigger = forwardRef<
    HTMLButtonElement,
    ButtonHTMLAttributes<HTMLButtonElement> & { label: string; hint?: string }
>(({ label, hint, className, ...props }, ref) => (
    <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        {...props}
        className={cn(
            "flex h-9 items-center gap-2 rounded-md border border-border bg-surface px-3 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
            className
        )}
    >
        <Search className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-left text-sm" data-search-label="">
            {label}
        </span>
        {hint ? (
            <kbd
                className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[0.625rem] leading-none"
                data-search-hint=""
            >
                {hint}
            </kbd>
        ) : null}
    </button>
));
SearchTrigger.displayName = "SearchTrigger";

export interface SearchPaletteProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** What the panel is, for a screen reader; never drawn. */
    title: string;
    query: string;
    onQueryChange: (query: string) => void;
    onFieldKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
    placeholder: string;
    /** The field's own name when it differs from the placeholder. */
    fieldLabel?: string;
    fieldRef?: Ref<HTMLInputElement>;
    /** Extra field attributes the caller needs (enterKeyHint and the like). */
    fieldProps?: Omit<InputProps, "value" | "onChange" | "onKeyDown" | "placeholder">;
    /** The id of the row the arrow keys are on, read out through the field. */
    activeId?: string;
    listId: string;
    listLabel: string;
    listRef?: Ref<HTMLDivElement>;
    /** Before the field, after the magnifier: a scope chip. */
    lead?: ReactNode;
    /** Over the field, inside its box: a typed answer's ghost. */
    overlay?: ReactNode;
    /** After the field: a spinner while something loads. */
    trail?: ReactNode;
    /** Between the field and the list: filters. */
    toolbar?: ReactNode;
    /** The key hints along the bottom. */
    footer?: ReactNode;
    children: ReactNode;
}

/** The panel itself: a dialog with the field, the listbox and the hints. */
export function SearchPalette({
    open,
    onOpenChange,
    title,
    query,
    onQueryChange,
    onFieldKeyDown,
    placeholder,
    fieldLabel,
    fieldRef,
    fieldProps,
    activeId,
    listId,
    listLabel,
    listRef,
    lead,
    overlay,
    trail,
    toolbar,
    footer,
    children
}: SearchPaletteProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent showClose={false} className="max-w-xl overflow-hidden p-0">
                <DialogTitle className="sr-only">{title}</DialogTitle>
                <div className="flex items-center gap-2 border-b border-border px-3">
                    <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    {lead}
                    <div className="relative flex min-w-0 flex-1 items-center">
                        <Input
                            autoFocus
                            ref={fieldRef}
                            type="search"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            {...fieldProps}
                            value={query}
                            onChange={(event) => onQueryChange(event.target.value)}
                            onKeyDown={onFieldKeyDown}
                            placeholder={placeholder}
                            aria-label={fieldLabel ?? placeholder}
                            // The arrow keys move a highlight through the list
                            // while the caret stays here, so the field has to be
                            // the thing that says which row is current: without
                            // it a screen reader hears nothing move.
                            role="combobox"
                            aria-expanded
                            aria-autocomplete="list"
                            aria-activedescendant={activeId}
                            aria-controls={listId}
                            bare
                            className="h-12"
                        />
                        {overlay}
                    </div>
                    {trail}
                </div>
                {toolbar}
                <div
                    ref={listRef}
                    id={listId}
                    role="listbox"
                    aria-label={listLabel}
                    className="max-h-[min(60vh,26rem)] overflow-y-auto overscroll-contain p-2"
                >
                    {children}
                </div>
                {footer ? (
                    <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-xs text-muted-foreground">
                        {footer}
                    </div>
                ) : null}
            </DialogContent>
        </Dialog>
    );
}

/** One group of results under its small heading, with an optional action at the end of it. */
export function SearchGroup({
    label,
    action,
    children
}: {
    label: string;
    action?: ReactNode;
    children: ReactNode;
}) {
    return (
        <div role="group" aria-label={label} className="mb-1 last:mb-0">
            <div className="flex items-center justify-between gap-2 px-2 py-1">
                {/* The name is on the group, so announcing the heading again would only repeat it. */}
                <p
                    aria-hidden="true"
                    className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
                >
                    {label}
                </p>
                {action}
            </div>
            {children}
        </div>
    );
}

/** The highlight a row wears when the arrow keys or the pointer are on it. */
export function searchOptionClass(selected: boolean): string {
    return cn(
        "flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-left transition-colors",
        selected ? "bg-option-hover" : "hover:bg-option-hover/60"
    );
}

/** A result row: the same height, padding and highlight whatever it draws inside. */
export function SearchOption({
    id,
    selected,
    label,
    onSelect,
    onHover,
    children
}: {
    id: string;
    selected: boolean;
    label: string;
    onSelect: () => void;
    onHover: () => void;
    children: ReactNode;
}) {
    return (
        <div
            id={id}
            role="option"
            aria-selected={selected}
            aria-label={label}
            data-active={selected}
            onMouseMove={onHover}
            onClick={onSelect}
            className={searchOptionClass(selected)}
        >
            {children}
        </div>
    );
}

/** Text with the stretches that matched the query marked. */
export function SearchHighlight({ text, terms }: { text: string; terms: readonly string[] }) {
    const ranges = highlightRanges(text, terms);
    if (!ranges.length) return <>{text}</>;
    const parts: ReactNode[] = [];
    let at = 0;
    for (const [start, end] of ranges) {
        if (start > at) parts.push(text.slice(at, start));
        parts.push(
            <mark key={start} className="rounded-sm bg-primary/20 text-foreground">
                {text.slice(start, end)}
            </mark>
        );
        at = end;
    }
    if (at < text.length) parts.push(text.slice(at));
    return <>{parts}</>;
}
