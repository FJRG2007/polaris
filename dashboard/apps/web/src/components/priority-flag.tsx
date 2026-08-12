"use client";

/**
 * A task's priority, as the mark every screen shows it with.
 *
 * One definition because it is read as a symbol rather than looked up: somebody
 * scanning the board learns that a red flag is urgent, and a card on the Overview
 * that drew the same fact as a coloured dot made them learn it twice. The colours
 * are the Tasks app's own, so the two agree by construction.
 *
 * Lives here rather than beside the board's pickers so the Overview can show it
 * without pulling a route's worth of menus and search fields in with it.
 */

import { cn } from "@polaris/ui";
import { Flag } from "lucide-react";
import { TASK_PRIORITY_COLORS, TASK_PRIORITY_LABELS, type TaskPriority } from "@polaris/core";

/** Nothing at all for a task nobody prioritised: an outline flag in a column of
 *  filled ones reads as a priority of its own, and there is none. */
export function PriorityFlag({ priority, className }: { priority: TaskPriority; className?: string }) {
    if (priority === "none") return null;
    return (
        <Flag
            className={cn("size-3.5 shrink-0", className)}
            // Filled, so urgency reads at a glance down a column of rows rather
            // than only when somebody stops to look at the outline.
            fill={TASK_PRIORITY_COLORS[priority]}
            style={{ color: TASK_PRIORITY_COLORS[priority] }}
            aria-label={TASK_PRIORITY_LABELS[priority]}
        />
    );
}
