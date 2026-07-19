"use client";

/**
 * A small on/off switch. Accessible (role="switch" + aria-checked) and keyboard-
 * operable as a button. Controlled: the parent owns the boolean and gets the next
 * value from onChange.
 */

import { cn } from "../lib/cn.js";

export function Switch({
    checked,
    onChange,
    disabled,
    "aria-label": ariaLabel
}: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
    "aria-label"?: string;
}) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={ariaLabel}
            disabled={disabled}
            onClick={() => onChange(!checked)}
            className={cn(
                "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
                checked ? "bg-primary" : "bg-muted"
            )}
        >
            <span
                className={cn(
                    "inline-block size-4 rounded-full bg-white shadow transition-transform",
                    checked ? "translate-x-[1.125rem]" : "translate-x-0.5"
                )}
            />
        </button>
    );
}
