"use client";

/**
 * An area files are dropped on that is also the way to choose them.
 *
 * A dashed box saying "drop here" with a separate "Attach" button beside it is
 * two controls for one thing, and the larger one did nothing when pressed. This
 * is a single button: pressing it - or Enter or Space on it - opens the picker,
 * and dropping on it hands the files over. What it shows is the caller's, kept
 * to inline content since it sits inside a button.
 */

import { cn } from "@polaris/ui";
import { useState, type ReactNode } from "react";

export function DropZone({
    onChoose,
    onFiles,
    disabled = false,
    label,
    className,
    activeClassName = "border-primary bg-primary/5 text-foreground",
    children
}: {
    /** Open the picker. */
    onChoose: () => void;
    /** What was dropped. */
    onFiles: (files: FileList) => void;
    disabled?: boolean;
    /** The accessible name, when the visible text alone does not say it. */
    label?: string;
    className?: string;
    /** The look while something is being dragged over it. */
    activeClassName?: string;
    children: ReactNode;
}) {
    const [over, setOver] = useState(false);
    return (
        <button
            type="button"
            // Not the native attribute: a disabled button receives no drop
            // events, so a file let go on it while an upload runs would not be
            // caught and the browser would open it in place of the page.
            aria-disabled={disabled || undefined}
            aria-label={label}
            onClick={() => {
                if (!disabled) onChoose();
            }}
            onDragOver={(event) => {
                event.preventDefault();
                if (!disabled) setOver(true);
            }}
            onDragLeave={(event) => {
                // Moving onto the zone's own icon or text leaves the zone as far
                // as the browser is concerned.
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                setOver(false);
            }}
            onDrop={(event) => {
                event.preventDefault();
                setOver(false);
                if (!disabled && event.dataTransfer.files.length > 0)
                    onFiles(event.dataTransfer.files);
            }}
            className={cn(
                "rounded-md border border-dashed border-border transition-colors hover:border-border-strong hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:cursor-not-allowed aria-disabled:opacity-60",
                className,
                over && activeClassName
            )}
        >
            {children}
        </button>
    );
}
