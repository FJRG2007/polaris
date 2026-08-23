"use client";

/**
 * The task's name, at the top of the panel that reads one and of the dialog that
 * creates one.
 *
 * A textarea rather than an input, because a name is a sentence and a phone is
 * three hundred and sixty pixels wide. An input scrolls its own text sideways,
 * so on a phone the half of the name that does not fit is simply not on the
 * screen and nothing says it is missing - which is the one line in this dialog
 * nobody can afford to lose. This wraps and grows instead.
 *
 * Enter still finishes rather than starting a second line: it is what people
 * press here, and a name spread over two paragraphs is not a name.
 */

import { cn } from "@polaris/ui";
import { forwardRef, useCallback, useEffect, useRef, type ComponentPropsWithoutRef } from "react";

type Props = Omit<ComponentPropsWithoutRef<"textarea">, "rows"> & {
    /** What Enter does here: leave the field, or create the task. */
    onEnter?: (element: HTMLTextAreaElement) => void;
};

export const TaskNameField = forwardRef<HTMLTextAreaElement, Props>(function TaskNameField(
    { className, onEnter, onChange, onKeyDown, ...props },
    forwarded
) {
    const own = useRef<HTMLTextAreaElement | null>(null);

    /** Back to one line first: without it the box only ever grows, and a name
     *  that was cut down keeps the height of the one it replaced. */
    const fit = useCallback(() => {
        const element = own.current;
        if (!element) return;
        element.style.height = "auto";
        element.style.height = `${element.scrollHeight}px`;
    }, []);

    useEffect(fit, [fit, props.value, props.defaultValue]);

    return (
        <textarea
            {...props}
            ref={(element) => {
                own.current = element;
                if (typeof forwarded === "function") forwarded(element);
                else if (forwarded) forwarded.current = element;
            }}
            rows={1}
            onChange={(event) => {
                fit();
                onChange?.(event);
            }}
            onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    onEnter?.(event.currentTarget);
                }
                onKeyDown?.(event);
            }}
            // `shrink-0` is load-bearing: hiding the overflow drops a flex item's
            // automatic minimum size to zero, so inside the panel's scrolling
            // column the box was crushed to nothing and the name vanished.
            className={cn(
                "w-full shrink-0 resize-none overflow-hidden bg-transparent text-xl font-semibold leading-tight outline-none",
                className
            )}
        />
    );
});
