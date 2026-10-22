"use client";

import { cn } from "@polaris/ui";
import { MoreHorizontal } from "lucide-react";

/**
 * The "..." that stands in for the history under a message, in the composer and
 * in the reader alike. Icon-only, so the words are its label and its tooltip.
 */
export function TrimmedPill({
    label,
    expanded,
    onToggle,
    className
}: {
    label: string;
    /** Whether the history is on screen, for a pill that also folds it back. */
    expanded?: boolean;
    onToggle: () => void;
    className?: string;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            aria-expanded={expanded ?? false}
            onClick={onToggle}
            className={cn(
                "relative inline-flex h-4 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
                "after:absolute after:-inset-x-2 after:-inset-y-3.5 after:content-['']",
                "hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                className
            )}
        >
            <MoreHorizontal className="size-4 shrink-0" aria-hidden />
        </button>
    );
}
