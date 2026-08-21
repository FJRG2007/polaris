"use client";

/**
 * A task's priority, as the mark every screen shows it with.
 *
 * Three bars, and how many of them are solid IS the priority: one for low, two
 * for medium, three for high. That is the whole reason this replaced a coloured
 * flag. A flag carries its meaning only in its colour, so it says nothing at all
 * to somebody who cannot tell red from amber, it says nothing in a screenshot
 * printed in grey, and it makes "how urgent" a thing you look up rather than a
 * thing you see. Bars are read the way signal strength is read, without being
 * taught.
 *
 * Urgent is deliberately not four bars. It is a different mark - a filled square
 * with a warning in it - because urgent is not "high, but more": it is the one
 * that interrupts what somebody is already doing, and a scale it sits on top of
 * would let it blend into the row above.
 *
 * And no priority is drawn rather than left blank. The flag rendered nothing,
 * which put an empty space in the column where every other row has a mark - and
 * an empty space reads as "not loaded yet" as readily as "nobody has said". Three
 * faint dashes say the question was asked and the answer is none.
 *
 * The shapes follow Linear's, by way of the Circle template (MIT, ln-dev7), for
 * the ordinary reason: this vocabulary is the one people arrive already knowing.
 *
 * One definition, because it is read as a symbol rather than looked up. It lives
 * here rather than beside the board's pickers so the Overview can show it without
 * pulling a route's worth of menus and search fields in with it.
 */

import { cn } from "@polaris/ui";
import { TASK_PRIORITY_COLORS, TASK_PRIORITY_LABELS, type TaskPriority } from "@polaris/core";

/** How many of the three bars are solid. The rest are drawn faint rather than
 *  left out, so the mark keeps one width and a column of them lines up. */
const SOLID: Record<Exclude<TaskPriority, "urgent" | "none">, number> = {
    high: 3,
    normal: 2,
    low: 1
};

/** The bars, left to right and shortest first. */
const BARS = [
    { x: 1.5, y: 8, height: 6 },
    { x: 6.5, y: 5, height: 9 },
    { x: 11.5, y: 2, height: 12 }
];

export function PriorityMark({
    priority,
    className
}: {
    priority: TaskPriority;
    className?: string;
}) {
    const label = TASK_PRIORITY_LABELS[priority];
    const color = TASK_PRIORITY_COLORS[priority];
    const shared = cn("size-3.5 shrink-0", className);

    if (priority === "urgent") {
        return (
            <svg
                viewBox="0 0 16 16"
                fill={color}
                className={shared}
                role="img"
                aria-label={label}
                focusable="false"
            >
                <path d="M3 1C1.91067 1 1 1.91067 1 3V13C1 14.0893 1.91067 15 3 15H13C14.0893 15 15 14.0893 15 13V3C15 1.91067 14.0893 1 13 1H3ZM7 4L9 4L8.75391 8.99836H7.25L7 4ZM9 11C9 11.5523 8.55228 12 8 12C7.44772 12 7 11.5523 7 11C7 10.4477 7.44772 10 8 10C8.55228 10 9 10.4477 9 11Z" />
            </svg>
        );
    }

    if (priority === "none") {
        return (
            <svg
                viewBox="0 0 16 16"
                fill="currentColor"
                className={cn(shared, "text-foreground-subtle")}
                role="img"
                aria-label={label}
                focusable="false"
            >
                {BARS.map((bar) => (
                    <rect key={bar.x} x={bar.x} y={7.25} width="3" height="1.5" rx="0.5" />
                ))}
            </svg>
        );
    }

    const solid = SOLID[priority];
    return (
        <svg
            viewBox="0 0 16 16"
            fill={color}
            className={shared}
            role="img"
            aria-label={label}
            focusable="false"
        >
            {BARS.map((bar, index) => (
                <rect
                    key={bar.x}
                    x={bar.x}
                    y={bar.y}
                    width="3"
                    height={bar.height}
                    rx="1"
                    // Faint rather than absent: the unfilled bars are what make
                    // the filled ones countable at a glance.
                    fillOpacity={index < solid ? 1 : 0.25}
                />
            ))}
        </svg>
    );
}
