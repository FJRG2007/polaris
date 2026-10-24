"use client";

/**
 * Small controlled checkbox with a custom check glyph. Native under the hood so
 * it stays keyboard- and form-accessible, posts under its `name` like any box,
 * and works controlled or not; `indeterminate` draws a partial dash for a header
 * "select all" box. The one checkbox the application draws.
 */

import { cn } from "../lib/cn";
import { Check, Minus } from "lucide-react";
import {
    forwardRef,
    useEffect,
    useImperativeHandle,
    useRef,
    type InputHTMLAttributes
} from "react";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
    /** Render a dash instead of a tick, for a partial (some-selected) state. */
    indeterminate?: boolean;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
    ({ className, checked, indeterminate, ...props }, ref) => {
        // The dash is drawn for the eye; the input's own `indeterminate` is what a
        // screen reader announces as "mixed", and it exists only as a property,
        // never an attribute, so it is set on the element after each render.
        const input = useRef<HTMLInputElement>(null);
        useImperativeHandle(ref, () => input.current as HTMLInputElement);
        useEffect(() => {
            if (input.current) input.current.indeterminate = Boolean(indeterminate);
        }, [indeterminate]);
        return (
            <span
                className={cn(
                    // The real input is transparent and sits on top of this box, and
                    // an outline on an invisible element is invisible - which left
                    // the only control in the application with no focus indicator at
                    // all. The drawn box wears the ring on the input's behalf.
                    "relative inline-flex size-4 shrink-0 items-center justify-center rounded border border-border-strong bg-field text-primary-foreground transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
                    // Drawn from the input's own state rather than the props, so a
                    // box a form owns (`defaultChecked`, posted by name) ticks too.
                    "has-[:checked]:border-primary has-[:checked]:bg-primary has-[:indeterminate]:border-primary has-[:indeterminate]:bg-primary",
                    // A locked box still reads as checked, just not as yours to change.
                    props.disabled ? "opacity-60" : null,
                    className
                )}
            >
                <input
                    ref={input}
                    type="checkbox"
                    checked={checked}
                    className="peer absolute inset-0 m-0 cursor-pointer opacity-0 disabled:cursor-default"
                    {...props}
                />
                <Check
                    aria-hidden="true"
                    className="pointer-events-none hidden size-3 peer-checked:block peer-indeterminate:!hidden"
                />
                <Minus
                    aria-hidden="true"
                    className="pointer-events-none hidden size-3 peer-indeterminate:block"
                />
            </span>
        );
    }
);
Checkbox.displayName = "Checkbox";
