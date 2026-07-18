"use client";

/**
 * Small controlled checkbox with a custom check glyph. Native under the hood so
 * it stays keyboard- and form-accessible; the visual box tracks the checked (or
 * indeterminate) state driven by props rather than the :checked pseudo-class, so
 * a header "select all" box can show a partial dash. Used for multi-select rows
 * and the share/request option grids.
 */

import { Check, Minus } from "lucide-react";
import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../lib/cn.js";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
    /** Render a dash instead of a tick, for a partial (some-selected) state. */
    indeterminate?: boolean;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
    ({ className, checked, indeterminate, ...props }, ref) => {
        const active = Boolean(checked) || Boolean(indeterminate);
        return (
            <span
                className={cn(
                    "relative inline-flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
                    active ? "border-primary bg-primary text-primary-foreground" : "border-input bg-surface",
                    className
                )}
            >
                <input
                    ref={ref}
                    type="checkbox"
                    checked={checked}
                    className="absolute inset-0 cursor-pointer opacity-0"
                    {...props}
                />
                {indeterminate ? (
                    <Minus className="pointer-events-none size-3" />
                ) : active ? (
                    <Check className="pointer-events-none size-3" />
                ) : null}
            </span>
        );
    }
);
Checkbox.displayName = "Checkbox";
