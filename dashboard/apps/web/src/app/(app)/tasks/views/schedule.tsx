"use client";

/**
 * The Gantt view: work as bars across a timeline.
 *
 * It answers "when", and refuses to guess. A task with no dates is not drawn -
 * it is counted in a line underneath instead, because a chart that invents a
 * position for undated work is a chart that lies about the plan.
 *
 * The calendar, the other time-shaped view, lives beside this one in calendar.tsx.
 */

import { useMemo } from "react";
import { cn } from "@polaris/ui";
import * as core from "@polaris/core";
import { Diamond } from "lucide-react";
import type { ViewProps } from "./shared";
import { PriorityFlag, StatusIcon } from "../pickers";
import { commandsFor, TaskMenu } from "./task-actions";
import { toFacts, type TaskRow } from "@/lib/tasks/facts";
import { useDisplayFormat } from "@/components/display-format";

// ---------------------------------------------------------------------------
// Gantt
// ---------------------------------------------------------------------------

export function GanttView(props: ViewProps) {
    const { rows, onOpen } = props;
    const format = useDisplayFormat();
    const now = new Date();

    const { bars, range, scheduled, undated } = useMemo(() => {
        const facts = rows.map(toFacts);
        const dated = facts.filter((task) => task.startDate || task.dueDate);
        const window = core.ganttRange(dated, now, format.weekStartsOn);
        return {
            bars: core.ganttBars(dated, window),
            range: window,
            scheduled: rows.filter((task) => task.startDate || task.dueDate),
            undated: rows.length - dated.length
        };
        // The window depends only on the rows; recomputing it per render would
        // make the chart jitter as the clock ticks.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows, format.weekStartsOn]);

    const span = range.to.getTime() - range.from.getTime();
    const todayPercent = ((now.getTime() - range.from.getTime()) / span) * 100;

    // A tick a week, which is as dense as a label can get without overlapping.
    const ticks: Date[] = [];
    for (
        let cursor = core.startOfWeek(range.from, format.weekStartsOn);
        cursor <= range.to;
        cursor = core.addDays(cursor, 7)
    ) {
        ticks.push(cursor);
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="overflow-x-auto rounded-lg border border-border">
                <div className="min-w-[48rem]">
                    <div className="relative flex border-b border-border bg-muted/40 text-[11px] text-muted-foreground">
                        <div className="w-56 shrink-0 px-3 py-1.5">Task</div>
                        <div className="relative flex-1 py-1.5">
                            {ticks.map((tick) => (
                                <span
                                    key={tick.toISOString()}
                                    className="absolute -translate-x-1/2 whitespace-nowrap"
                                    style={{ left: `${((tick.getTime() - range.from.getTime()) / span) * 100}%` }}
                                >
                                    {format.date(tick.toISOString())}
                                </span>
                            ))}
                        </div>
                    </div>

                    <ul className="relative">
                        {todayPercent >= 0 && todayPercent <= 100 && (
                            <span
                                aria-hidden
                                className="pointer-events-none absolute bottom-0 top-0 z-10 w-px bg-primary/60"
                                style={{ left: `calc(14rem + (100% - 14rem) * ${todayPercent / 100})` }}
                            />
                        )}
                        {scheduled.map((task) => {
                            const bar = bars.find((entry) => entry.taskId === task.id);
                            if (!bar) return null;
                            return (
                                <TaskMenu key={task.id} commands={commandsFor(props, task)}>
                                <li className="flex items-center border-b border-border last:border-0">
                                    <button
                                        type="button"
                                        onClick={() => onOpen(task.id)}
                                        className="flex w-56 shrink-0 items-center gap-2 px-3 py-2 text-left"
                                    >
                                        <StatusIcon color={task.statusColor} type={task.statusType} size={14} />
                                        <span className="truncate text-xs">{task.name}</span>
                                        <PriorityFlag priority={task.priority} />
                                    </button>
                                    <div className="relative h-9 flex-1">
                                        <button
                                            type="button"
                                            onClick={() => onOpen(task.id)}
                                            title={`${task.name}: ${format.date(bar.start.toISOString())} to ${format.date(bar.end.toISOString())}`}
                                            className={cn(
                                                "absolute top-1/2 flex h-5 -translate-y-1/2 items-center gap-1 rounded px-1.5 text-[10px] text-white transition-opacity hover:opacity-90",
                                                task.blocked && "ring-1 ring-amber-500"
                                            )}
                                            style={{
                                                left: `${bar.offsetPercent}%`,
                                                width: `${bar.widthPercent}%`,
                                                backgroundColor: task.statusColor
                                            }}
                                        >
                                            {task.milestone && <Diamond className="size-3 shrink-0" />}
                                            <span className="truncate">{task.reference}</span>
                                        </button>
                                    </div>
                                </li>
                                </TaskMenu>
                            );
                        })}
                        {scheduled.length === 0 && (
                            <li className="px-4 py-10 text-center text-sm text-muted-foreground">
                                Nothing is scheduled. Give a task a start or due date and it appears here.
                            </li>
                        )}
                    </ul>
                </div>
            </div>

            {undated > 0 && (
                <p className="text-xs text-muted-foreground">
                    {undated} {undated === 1 ? "task is" : "tasks are"} undated and not on the timeline.
                </p>
            )}
        </div>
    );
}

/** Both views need the same "is this row worth drawing" answer. */
export function isScheduled(task: TaskRow): boolean {
    return task.startDate !== null || task.dueDate !== null;
}
