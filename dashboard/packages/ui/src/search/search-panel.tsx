"use client";

/**
 * The search panel's inside - the field on top, results grouped under small
 * headings, the key hints along the bottom - and every row it draws. One
 * component for every Polaris search: the dashboard's command palette, the
 * public site's docs search, the desktop app's search window and the browser
 * extension's search over a page. What goes in the list is the caller's.
 *
 * No Radix here: `SearchPalette` puts this in the dashboard's dialog, and
 * `SearchSheet` draws the same box for a surface that has no dialog to use (a
 * page's shadow root, a window of its own).
 */

import { cn } from "../lib/cn";
import { Search, X } from "lucide-react";
import { useUiStrings } from "../lib/ui-strings";
import { highlightRanges } from "./search-match";
import { Input, type InputProps } from "../components/input";
import { DIALOG_OVERLAY, DIALOG_SURFACE, PHONE_CLASSES } from "../components/dialog-surface";
import type { KeyboardEvent, MouseEvent, ReactNode, Ref } from "react";

/** The palette's box on top of a dialog's: wider, edge to edge inside, and the whole screen on a phone. */
export const SEARCH_BOX = "max-w-xl overflow-hidden p-0 max-sm:flex max-sm:flex-col";

/** The phone's close, which has no Escape key and no corner X. */
export const SEARCH_CLOSE =
    "-me-1 flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground sm:hidden";

export interface SearchPanelProps {
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
    /** The phone's close button, after everything in the field's row. */
    closeButton?: ReactNode;
    children: ReactNode;
}

/** The field, the listbox and the hints, without the box they sit in. */
export function SearchPanel({
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
    closeButton,
    children
}: SearchPanelProps) {
    return (
        <>
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
                {closeButton}
            </div>
            {toolbar}
            <div
                ref={listRef}
                id={listId}
                role="listbox"
                aria-label={listLabel}
                className="max-h-[min(60vh,26rem)] overflow-y-auto overscroll-contain p-2 max-sm:max-h-none max-sm:min-h-0 max-sm:flex-1"
            >
                {children}
            </div>
            {footer ? (
                <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2 text-xs text-muted-foreground">
                    {footer}
                </div>
            ) : null}
        </>
    );
}

/**
 * The palette's box where there is no dialog to put it in: the same place on
 * the screen (centred both ways), the same size, border, radius and shadow as
 * `SearchPalette`'s, and the whole screen on a phone. `dim` is the dashboard's
 * shade behind it; a window of its own over other programs leaves it off. A
 * press outside the box, or the phone's close, calls `onClose`.
 */
export function SearchSheet({
    title,
    onClose,
    dim = true,
    ...panel
}: SearchPanelProps & { title: string; onClose: () => void; dim?: boolean }) {
    const close = useUiStrings().close;
    const outside = (event: MouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) onClose();
    };
    return (
        <>
            <div
                className={cn(DIALOG_OVERLAY, !dim && "bg-transparent backdrop-blur-none")}
                onMouseDown={outside}
                data-search-backdrop=""
            />
            <div
                role="dialog"
                aria-modal="true"
                aria-label={title}
                className={cn(DIALOG_SURFACE, SEARCH_BOX, PHONE_CLASSES.full)}
            >
                <SearchPanel
                    {...panel}
                    closeButton={
                        <button type="button" className={SEARCH_CLOSE} aria-label={close} onClick={onClose}>
                            <X className="size-5" />
                        </button>
                    }
                />
            </div>
        </>
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
        "flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-start transition-colors",
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

/** A row's inside: its icon, its name with what matched marked, and a quieter context line. */
export function SearchItem({
    icon,
    label,
    context,
    terms = [],
    trail
}: {
    icon: ReactNode;
    label: string;
    context?: string;
    terms?: readonly string[];
    /** After the text: a hint or an action. */
    trail?: ReactNode;
}) {
    return (
        <>
            {icon}
            <span className="min-w-0 flex-1">
                <span className="block truncate text-sm" title={label}>
                    <SearchHighlight text={label} terms={terms} />
                </span>
                {context ? (
                    <span className="block truncate text-xs text-muted-foreground" title={context}>
                        {context}
                    </span>
                ) : null}
            </span>
            {trail}
        </>
    );
}

/** The list's sentence when it has no rows to show: nothing matched, or something failed. */
export function SearchMessage({ tone = "muted", children }: { tone?: "muted" | "danger"; children: ReactNode }) {
    return (
        <p
            className={cn(
                "px-2 py-10 text-center text-sm",
                tone === "danger" ? "text-danger" : "text-muted-foreground"
            )}
        >
            {children}
        </p>
    );
}

/** Three placeholder rows while the first results are on their way. */
export function SearchSkeleton() {
    return (
        <div aria-hidden="true" className="space-y-1 p-1">
            {[0, 1, 2].map((row) => (
                <div key={row} className="flex items-center gap-3 rounded-md px-2 py-2">
                    <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-muted" />
                    <span
                        className="h-3 flex-1 animate-pulse rounded bg-muted"
                        style={{ maxWidth: `${70 - row * 12}%` }}
                    />
                </div>
            ))}
        </div>
    );
}
