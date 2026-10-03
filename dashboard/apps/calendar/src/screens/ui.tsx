"use client";

/** Small pieces the calendar's screens share. */

import { linkify } from "./editor-model";
import { hexOfHslChannels } from "./ui-color";
import { cn, Dialog, DialogFloating, DialogTitle } from "@polaris/ui";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

/** A calendar's or an event's colour, as a dot. */
export function ColorDot({ color, className }: { color: string; className?: string }) {
    return (
        <span
            aria-hidden
            className={cn("inline-block size-2.5 shrink-0 rounded-full", className)}
            style={{ backgroundColor: color }}
        />
    );
}

function readCard(fallback: string): string {
    try {
        const channels = getComputedStyle(document.documentElement).getPropertyValue("--card");
        return hexOfHslChannels(channels) ?? fallback;
    } catch {
        return fallback;
    }
}

/**
 * The card colour of the theme on screen, as hex, for colours that are mixed
 * toward the page (a faded event). Read again when the theme changes - a class
 * on the document, or the machine turning light or dark under "system".
 */
export function useCardColor(fallback: string): string {
    const [card, setCard] = useState(fallback);
    useEffect(() => {
        const update = () => setCard(readCard(fallback));
        update();
        const observer = new MutationObserver(update);
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["class", "style", "data-theme"]
        });
        const scheme = window.matchMedia?.("(prefers-color-scheme: light)");
        scheme?.addEventListener?.("change", update);
        return () => {
            observer.disconnect();
            scheme?.removeEventListener?.("change", update);
        };
    }, [fallback]);
    return card;
}

/** The current instant, moved on every `intervalMs`. */
export function useNow(intervalMs: number): Date {
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), intervalMs);
        return () => clearInterval(timer);
    }, [intervalMs]);
    return now;
}

/** Plain text with its web links clickable. */
export function Linkified({ text, className }: { text: string; className?: string }) {
    return (
        <p className={cn("whitespace-pre-wrap break-words", className)}>
            {linkify(text).map((part, index) =>
                part.href ? (
                    <a
                        key={index}
                        href={part.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-foreground underline underline-offset-2 hover:text-muted-foreground"
                    >
                        {part.text}
                    </a>
                ) : (
                    <span key={index}>{part.text}</span>
                )
            )}
        </p>
    );
}

/** Where a panel opened beside something is drawn, kept inside the window. */
function placement(anchor: DOMRect | null, width: number): CSSProperties {
    if (typeof window === "undefined")
        return { left: 16, right: 16, top: 80, maxHeight: "calc(100vh - 96px)" };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    // A phone has no room beside anything: the panel sits along the bottom.
    if (viewport.width < 640) return { left: 8, right: 8, bottom: 8, maxHeight: "80vh" };
    // Opened from no particular place (the header's New event): its own width,
    // centred under the header, rather than a bar across the whole screen.
    if (!anchor)
        return {
            left: Math.max(8, (viewport.width - width) / 2),
            width,
            top: 80,
            maxHeight: "calc(100vh - 96px)"
        };
    const left = Math.max(8, Math.min(anchor.left, viewport.width - width - 8));
    const below = viewport.height - anchor.bottom;
    if (below >= 280 || below >= anchor.top)
        return { left, width, top: anchor.bottom + 6, maxHeight: below - 14 };
    return { left, width, bottom: viewport.height - anchor.top + 6, maxHeight: anchor.top - 14 };
}

/**
 * A panel opened beside what was pressed: an event's card, the date picker.
 * Not modal, so the page stays live; Escape or a press elsewhere closes it.
 */
export function AnchoredPanel({
    open,
    onOpenChange,
    anchor,
    title,
    width = 320,
    className,
    children
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    anchor: DOMRect | null;
    /** Read by screen readers; the panel draws its own heading. */
    title: string;
    width?: number;
    className?: string;
    children: ReactNode;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
            <DialogFloating
                style={placement(anchor, width)}
                className={cn("p-3", className)}
                aria-describedby={undefined}
            >
                <DialogTitle className="sr-only">{title}</DialogTitle>
                {children}
            </DialogFloating>
        </Dialog>
    );
}

/** A labelled row of a form: the label above on a phone, beside from `sm`. */
export function FieldRow({
    label,
    htmlFor,
    hint,
    error,
    children,
    className
}: {
    label: ReactNode;
    htmlFor?: string;
    hint?: ReactNode;
    error?: string | null;
    children: ReactNode;
    className?: string;
}) {
    return (
        <div className={cn("flex flex-col gap-1", className)}>
            <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
                {label}
            </label>
            {children}
            {error ? (
                <p role="alert" className="text-xs text-danger">
                    {error}
                </p>
            ) : hint ? (
                <p className="text-xs text-foreground-subtle">{hint}</p>
            ) : null}
        </div>
    );
}

/** A group heading inside a panel. */
export function GroupHeading({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <h3
            className={cn(
                "text-[11px] font-medium uppercase tracking-wider text-foreground-subtle",
                className
            )}
        >
            {children}
        </h3>
    );
}

/** A pressed-or-not choice drawn as a small toggle button. */
export function ToggleChip({
    pressed,
    onPressedChange,
    children,
    label,
    disabled
}: {
    pressed: boolean;
    onPressedChange: (pressed: boolean) => void;
    children: ReactNode;
    label?: string;
    disabled?: boolean;
}) {
    return (
        <button
            type="button"
            aria-pressed={pressed}
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={() => onPressedChange(!pressed)}
            className={cn(
                "inline-flex h-7 min-w-7 items-center justify-center rounded-md border px-2 text-xs tabular-nums transition-colors duration-fast disabled:opacity-50",
                pressed
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-field text-muted-foreground hover:border-border-strong hover:text-foreground"
            )}
        >
            {children}
        </button>
    );
}
