"use client";

/**
 * Small controlled checkbox with a custom check glyph. Native under the hood so
 * it stays keyboard- and form-accessible; the visual box tracks the checked (or
 * indeterminate) state driven by props rather than the :checked pseudo-class, so
 * a header "select all" box can show a partial dash. Used for multi-select rows
 * and the share/request option grids.
 */

import { cn } from "../lib/cn";
import { Check, Minus } from "lucide-react";
import { forwardRef, type InputHTMLAttributes } from "react";

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
                    // The real input is transparent and sits on top of this box, and
                    // an outline on an invisible element is invisible - which left
                    // the only control in the application with no focus indicator at
                    // all. The drawn box wears the ring on the input's behalf.
                    "relative inline-flex size-4 shrink-0 items-center justify-center rounded border transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
                    active ? "border-primary bg-primary text-primary-foreground" : "border-border-strong bg-field",
                    // A locked box still reads as checked, just not as yours to change.
                    props.disabled ? "opacity-60" : null,
                    className
                )}
            >
                <input
                    ref={ref}
                    type="checkbox"
                    checked={checked}
                    className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-default"
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
