/**
 * A small icon-only button for a row's own actions (rename, rotate, remove),
 * named for screen readers and on hover by the same label.
 */

import { cn } from "@polaris/ui";
import type { ReactNode } from "react";

export function IconAction({
    label,
    onClick,
    disabled,
    danger,
    className,
    children
}: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    danger?: boolean;
    className?: string;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={onClick}
            className={cn(
                "rounded p-1 text-muted-foreground transition-colors disabled:opacity-50",
                danger ? "hover:text-danger" : "hover:text-foreground",
                className
            )}
        >
            {children}
        </button>
    );
}
