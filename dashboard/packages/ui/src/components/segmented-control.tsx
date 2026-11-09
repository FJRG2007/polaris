"use client";

/**
 * A row of mutually exclusive choices, for the two-to-four options that would be
 * a select if there were more of them and radio buttons if they were not about
 * changing what is on screen right now.
 *
 * It existed five times before this, hand-written in Deploy, volumes, hosts,
 * integrations and task conversations, and each copy marked the chosen option by
 * putting a shadow under it. A shadow is how something floats above the page,
 * which a segment does not - so the selected one is a raised surface with an edge
 * instead, and the track is the recess it sits in.
 *
 * Arrow keys move between the options and Home/End reach the ends, which is what
 * the pattern is expected to do and what none of the five copies did.
 *
 * More options than the width holds scroll sideways rather than shrink. It is
 * also the tab strip of most detail screens - a UPS has eight - and options that
 * shared out a phone's width came out as "O...", "E...", "P..." side by side:
 * nothing on the row could be read. See dashboard/docs/design.md, "Tab strips".
 */

import { cn } from "../lib/cn";
import { ScrollRow } from "./scroll-row";
import type { ReactNode } from "react";

export interface SegmentedOption<T extends string> {
    value: T;
    label: ReactNode;
    /** Kept for the choice that needs saying more than its label can. */
    title?: string;
    disabled?: boolean;
}

export function SegmentedControl<T extends string>({
    value,
    onValueChange,
    options,
    size = "md",
    className,
    "aria-label": ariaLabel
}: {
    /** Null when none of the options is the current one: nothing reads as chosen. */
    value: T | null;
    onValueChange: (value: T) => void;
    options: readonly SegmentedOption<T>[];
    size?: "sm" | "md";
    className?: string;
    "aria-label"?: string;
}) {
    const move = (from: number, delta: number) => {
        const count = options.length;
        for (let step = 1; step <= count; step += 1) {
            const option = options[(((from + delta * step) % count) + count) % count];
            if (option && !option.disabled) {
                onValueChange(option.value);
                return;
            }
        }
    };

    const anyActive = options.some((option) => option.value === value);

    return (
        <ScrollRow
            role="radiogroup"
            aria-label={ariaLabel}
            // `min-w-0 max-w-full` keep the track inside a narrow column; what
            // does not fit then scrolls (ScrollRow: wheel, faded ends, the
            // chosen option kept in view) instead of running off the side.
            className={cn(
                "no-scrollbar inline-flex min-w-0 max-w-full items-center gap-0.5 rounded-md bg-muted p-0.5",
                className
            )}
        >
            {options.map((option, index) => {
                const active = option.value === value;
                return (
                    <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        title={option.title}
                        disabled={option.disabled}
                        // Only the chosen option is in the tab order: one stop for
                        // the group, then the arrow keys choose within it.
                        tabIndex={active || (!anyActive && index === 0) ? 0 : -1}
                        onClick={() => onValueChange(option.value)}
                        onKeyDown={(event) => {
                            if (event.key === "ArrowRight" || event.key === "ArrowDown")
                                move(index, 1);
                            else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
                                move(index, -1);
                            else if (event.key === "Home") move(-1, 1);
                            else if (event.key === "End") move(0, -1);
                            else return;
                            event.preventDefault();
                        }}
                        className={cn(
                            // `basis-auto`, not the `flex-1` default of zero: with
                            // a basis of zero every option is given the same width
                            // whatever it says, so a set like "Data" and "SQL" is
                            // sized for the shorter one and the longer one comes
                            // out as "D..." - by half a pixel, which is the worst
                            // kind of wrong. Options size to their labels and share
                            // what is left over.
                            //
                            // `shrink-0 whitespace-nowrap`: an option never gets
                            // narrower than its label - the track scrolls instead.
                            "flex-1 shrink-0 basis-auto whitespace-nowrap rounded font-medium transition-colors duration-fast disabled:pointer-events-none disabled:opacity-50",
                            size === "sm" ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-[0.8125rem]",
                            active
                                ? "border border-border-strong bg-card-hover text-foreground"
                                : "border border-transparent text-muted-foreground hover:text-foreground"
                        )}
                    >
                        {option.label}
                    </button>
                );
            })}
        </ScrollRow>
    );
}
