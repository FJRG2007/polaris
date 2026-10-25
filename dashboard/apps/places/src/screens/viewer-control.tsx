"use client";

import { Button, cn } from "@polaris/ui";

/** One control over a live picture. Icon-only per the repeated-action rule, so
 *  it carries both the name and the tooltip rather than a visible label.
 *  `active` is for a control that is on while it is held on, like talking. */
export function ViewerControl({
    label,
    onClick,
    disabled,
    active,
    children
}: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    active?: boolean;
    children: React.ReactNode;
}) {
    return (
        <Button
            variant="ghost"
            size="icon"
            aria-label={label}
            aria-pressed={active}
            title={label}
            disabled={disabled}
            className={cn(
                "text-white/80 hover:bg-white/15 hover:text-white disabled:opacity-40",
                active && "bg-red-600/90 text-white hover:bg-red-600"
            )}
            onClick={onClick}
        >
            {children}
        </Button>
    );
}
