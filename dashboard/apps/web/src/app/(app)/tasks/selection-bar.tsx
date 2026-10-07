"use client";

/**
 * The bar a selection brings up, floating over the bottom of the screen.
 *
 * Floating rather than in the flow of the page: a strip that appeared above the
 * board pushed every card down by its own height the moment the first one was
 * ctrl-clicked, so the second click landed on a different card. Over the page,
 * nothing under the pointer moves, and it stays in reach however far down a long
 * list the selection was made.
 *
 * It rises in when something is selected and drops away when nothing is, and it
 * keeps showing the count it had while it leaves rather than flashing "0".
 */

import { X } from "lucide-react";
import { cn } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { forwardRef, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

/** Longer than the leaving animation (`duration-fast`), so it has finished
 *  before the bar is taken off the page. */
const LEAVE_MS = 200;

export function SelectionBar({
    count,
    total,
    onSelectAll,
    onClear,
    children
}: {
    count: number;
    /** How many tasks the screen is showing, for "select all of them". */
    total: number;
    onSelectAll: () => void;
    onClear: () => void;
    /** The verbs, which are the screen's to decide. */
    children: ReactNode;
}) {
    const t = useTranslations("tasksViews");
    const [present, setPresent] = useState(count > 0);
    const shown = useRef(count);
    if (count > 0) shown.current = count;

    useEffect(() => {
        if (count > 0) {
            setPresent(true);
            return;
        }
        const timer = window.setTimeout(() => setPresent(false), LEAVE_MS);
        return () => window.clearTimeout(timer);
    }, [count]);

    if (!present) return null;
    const open = count > 0;

    return (
        <div className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom,0px)_+_1rem)] z-40 flex justify-center px-4">
            <div
                role="toolbar"
                aria-label={t("bulk.toolbar")}
                data-state={open ? "open" : "closed"}
                className={cn(
                    "flex min-w-0 max-w-full flex-wrap items-center justify-center gap-1 rounded-xl border border-border-strong bg-elevated p-1.5 text-foreground shadow-popover",
                    // Two rows on a phone - the count, then the verbs - rather than
                    // one row that scrolls sideways and hides the last verb, which
                    // is Delete.
                    "sm:flex-nowrap",
                    "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-2",
                    "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-bottom-2 data-[state=closed]:duration-fast data-[state=closed]:fill-mode-forwards",
                    open && "pointer-events-auto"
                )}
            >
                <button
                    type="button"
                    aria-label={t("bulk.clear")}
                    title={t("bulk.clearKey")}
                    onClick={onClear}
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast hover:bg-card-hover hover:text-foreground active:bg-muted"
                >
                    <X className="size-4" />
                </button>
                <span
                    aria-live="polite"
                    className="shrink-0 whitespace-nowrap px-1 text-[0.8125rem] font-medium tabular-nums"
                >
                    {t("bulk.selected", { count: shown.current })}
                </span>
                {open && count < total && (
                    <button
                        type="button"
                        onClick={onSelectAll}
                        className="shrink-0 whitespace-nowrap rounded-md px-1.5 py-1 text-xs text-muted-foreground underline-offset-4 transition-colors duration-fast hover:bg-card-hover hover:text-foreground hover:underline"
                    >
                        {t("bulk.selectAll", { count: total })}
                    </button>
                )}
                <span aria-hidden className="mx-1 hidden h-5 w-px shrink-0 bg-border sm:block" />
                {/* Where a phone breaks the bar: the verbs start a row of their own. */}
                <span aria-hidden className="basis-full sm:hidden" />
                {children}
            </div>
        </div>
    );
}

/**
 * One verb on the bar: an icon that always shows, and its word beside it where
 * there is room for one. On a phone it is the icon alone, named for a screen
 * reader and on hover.
 */
export const BarButton = forwardRef<
    HTMLButtonElement,
    ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: ReactNode; danger?: boolean }
>(({ label, icon, danger = false, className, ...props }, ref) => (
    // A ref, because a verb that opens a picker is that picker's trigger, and a
    // menu is placed against the element its trigger hands it.
    <button
        ref={ref}
        type="button"
        aria-label={label}
        title={label}
        {...props}
        className={cn(
            "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[0.8125rem] transition-colors duration-fast disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-card-hover [&_svg]:size-4",
            danger
                ? "text-danger hover:bg-danger-soft active:bg-danger-soft"
                : "text-muted-foreground hover:bg-card-hover hover:text-foreground active:bg-muted data-[state=open]:text-foreground",
            className
        )}
    >
        {icon}
        <span className="hidden sm:inline">{label}</span>
    </button>
));
BarButton.displayName = "BarButton";
