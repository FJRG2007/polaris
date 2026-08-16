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
 */

import { cn } from "../lib/cn";
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
    value: T;
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

    return (
        <div
            role="radiogroup"
            aria-label={ariaLabel}
            // `min-w-0` and the truncation below are what keep a set of long
            // labels inside a narrow column: without them the track keeps its
            // natural width and runs off the side of whatever holds it.
            className={cn(
                "inline-flex min-w-0 max-w-full items-center gap-0.5 rounded-md bg-muted p-0.5",
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
                        // Its own label when there is nothing more to say: a
                        // narrow column truncates, and a truncated option that
                        // cannot be hovered for the rest of it is a guess.
                        title={
                            option.title ??
                            (typeof option.label === "string" ? option.label : undefined)
                        }
                        disabled={option.disabled}
                        // Only the chosen option is in the tab order: one stop for
                        // the group, then the arrow keys choose within it.
                        tabIndex={active ? 0 : -1}
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
                            "min-w-0 flex-1 truncate rounded font-medium transition-colors duration-fast disabled:pointer-events-none disabled:opacity-50",
                            size === "sm" ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-[13px]",
                            active
                                ? "border border-border-strong bg-card-hover text-foreground"
                                : "border border-transparent text-muted-foreground hover:text-foreground"
                        )}
                    >
                        {option.label}
                    </button>
                );
            })}
        </div>
    );
}
