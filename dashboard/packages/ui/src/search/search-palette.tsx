"use client";

/**
 * The search panel in the dashboard's dialog, shared by the dashboard's command
 * palette and the public site's docs search. Its inside (`search-panel`) is the
 * same component the desktop app's search window and the extension's search
 * over a page draw, so all four look and answer the keyboard the same way.
 */

import { cn } from "../lib/cn";
import { Search, X } from "lucide-react";
import { useUiStrings } from "../lib/ui-strings";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { SEARCH_BOX, SEARCH_CLOSE, SearchPanel, type SearchPanelProps } from "./search-panel";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "../components/dialog";

export {
    SearchGroup,
    SearchHighlight,
    SearchItem,
    SearchMessage,
    SearchOption,
    SearchPanel,
    SearchSheet,
    SearchSkeleton,
    searchOptionClass
} from "./search-panel";

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
            "flex h-9 shrink-0 items-center gap-2 rounded-md border border-border bg-surface px-3 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
            className
        )}
    >
        <Search className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-start text-sm" data-search-label="">
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

export interface SearchPaletteProps extends Omit<SearchPanelProps, "closeButton"> {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** What the panel is, for a screen reader; never drawn. */
    title: string;
}

/** The panel itself: a dialog with the field, the listbox and the hints. */
export function SearchPalette({ open, onOpenChange, title, ...panel }: SearchPaletteProps) {
    const close = useUiStrings().close;
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                showClose={false}
                // A list to search: the whole screen on a phone, as "new message" is in Discord and WhatsApp.
                phone="full"
                className={SEARCH_BOX}
            >
                <DialogTitle className="sr-only">{title}</DialogTitle>
                <SearchPanel
                    {...panel}
                    closeButton={
                        // A phone has no Escape key, and the corner X is off.
                        <DialogClose className={SEARCH_CLOSE} aria-label={close}>
                            <X className="size-5" />
                        </DialogClose>
                    }
                />
            </DialogContent>
        </Dialog>
    );
}
