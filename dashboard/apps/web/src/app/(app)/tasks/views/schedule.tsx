"use client";

/**
 * The two time-shaped views: Calendar and Gantt.
 *
 * Both answer "when", and both refuse to guess. A task with no dates is not
 * drawn on either - it is counted in a line underneath instead, because a chart
 * that invents a position for undated work is a chart that lies about the plan.
 */

import { cn } from "@polaris/ui";
import * as core from "@polaris/core";
import { useMemo, useState } from "react";
import type { ViewProps } from "./shared";
import { PriorityFlag, StatusIcon } from "../pickers";
import { commandsFor, TaskMenu } from "./task-actions";
import { toFacts, type TaskRow } from "@/lib/tasks/facts";
import { useDisplayFormat } from "@/components/display-format";
import { ChevronLeft, ChevronRight, Diamond } from "lucide-react";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export function CalendarView(props: ViewProps) {
    const { rows, canEdit, onOpen, onQuickCreate } = props;
    const format = useDisplayFormat();
    const [monthOffset, setMonthOffset] = useState(0);

    const { days, label, undated } = useMemo(() => {
        const now = new Date();
        const anchor = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
        const first = core.startOfWeek(anchor);
        const monthEnd = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
        const cells: Date[] = [];
        for (let cursor = first; cursor <= core.addDays(core.startOfWeek(monthEnd), 6); cursor = core.addDays(cursor, 1)) {
            cells.push(cursor);
        }
        return {
            days: cells,
            label: `${anchor.toLocaleString("en", { month: "long" })} ${anchor.getFullYear()}`,
            undated: rows.filter((task) => !task.dueDate && !task.startDate)
        };
    }, [monthOffset, rows]);

    const onDay = (day: Date) =>
        rows.filter((task) => {
            const due = task.dueDate ?? task.startDate;
            return due !== null && core.isSameDay(new Date(due), day);
        });

    const today = new Date();
    const month = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1).getMonth();

    return (
        <div className="flex flex-col gap-3">
            <header className="flex items-center gap-2">
                <button
                    type="button"
                    aria-label="Previous month"
                    onClick={() => setMonthOffset(monthOffset - 1)}
                    className="rounded-md border border-border p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <ChevronLeft className="size-4" />
                </button>
                <h3 className="min-w-40 text-sm font-medium">{label}</h3>
                <button
                    type="button"
                    aria-label="Next month"
                    onClick={() => setMonthOffset(monthOffset + 1)}
                    className="rounded-md border border-border p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <ChevronRight className="size-4" />
                </button>
                {monthOffset !== 0 && (
                    <button
                        type="button"
                        onClick={() => setMonthOffset(0)}
                        className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        Today
                    </button>
                )}
            </header>

            <div className="overflow-x-auto">
                <div className="grid min-w-[44rem] grid-cols-7 gap-px rounded-lg border border-border bg-border">
                    {WEEKDAYS.map((weekday) => (
                        <div key={weekday} className="bg-muted/40 px-2 py-1 text-center text-[11px] text-muted-foreground">
                            {weekday}
                        </div>
                    ))}
                    {days.map((day) => {
                        const tasks = onDay(day);
                        const outside = day.getMonth() !== month;
                        return (
                            <div
                                key={day.toISOString()}
                                className={cn("min-h-24 bg-card p-1.5", outside && "bg-muted/20")}
                                onDoubleClick={() => {
                                    // The prefix tells the screen this key is a date, not a group id.
                                    if (canEdit) onQuickCreate(`date:${day.toISOString()}`, "New task");
                                }}
                            >
                                <div className="mb-1 flex items-center justify-between">
                                    <span
                                        className={cn(
                                            "text-[11px]",
                                            core.isSameDay(day, today)
                                                ? "rounded bg-primary px-1.5 font-medium text-primary-foreground"
                                                : "text-muted-foreground"
                                        )}
                                    >
                                        {day.getDate()}
                                    </span>
                                </div>
                                <ul className="flex flex-col gap-1">
                                    {tasks.slice(0, 4).map((task) => (
                                        <TaskMenu key={task.id} commands={commandsFor(props, task)}>
                                            <li>
                                                <button
                                                    type="button"
                                                    onClick={() => onOpen(task.id)}
                                                    title={task.name}
                                                    className="flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[11px] transition-colors hover:bg-muted"
                                                >
                                                    <StatusIcon
                                                        color={task.statusColor}
                                                        type={task.statusType}
                                                        size={12}
                                                    />
                                                    <span className="truncate">{task.name}</span>
                                                </button>
                                            </li>
                                        </TaskMenu>
                                    ))}
                                    {tasks.length > 4 && (
                                        <li className="px-1 text-[10px] text-muted-foreground">
                                            +{tasks.length - 4} more
                                        </li>
                                    )}
                                </ul>
                            </div>
                        );
                    })}
                </div>
            </div>

            {undated.length > 0 && (
                <p className="text-xs text-muted-foreground">
                    {undated.length} {undated.length === 1 ? "task has" : "tasks have"} no dates and are not shown here.
                    Open one and give it a due date to schedule it.
                </p>
            )}
            {canEdit && <p className="text-[11px] text-muted-foreground">Double-click a day to add a task on it.</p>}
            <span className="sr-only">{format.date(today.toISOString())}</span>
        </div>
    );
}

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
        const window = core.ganttRange(dated, now);
        return {
            bars: core.ganttBars(dated, window),
            range: window,
            scheduled: rows.filter((task) => task.startDate || task.dueDate),
            undated: rows.length - dated.length
        };
        // The window depends only on the rows; recomputing it per render would
        // make the chart jitter as the clock ticks.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows]);

    const span = range.to.getTime() - range.from.getTime();
    const todayPercent = ((now.getTime() - range.from.getTime()) / span) * 100;

    // A tick a week, which is as dense as a label can get without overlapping.
    const ticks: Date[] = [];
    for (let cursor = core.startOfWeek(range.from); cursor <= range.to; cursor = core.addDays(cursor, 7)) {
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
