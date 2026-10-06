"use client";

/**
 * A task on the calendar: its round status mark, and the card beside it when
 * it is pressed.
 *
 * The mark is Tasks' own (`StatusIcon`), so a task reads the same on the grid
 * as on its board - a dashed ring not started, a filling one under way, a tick
 * done, a cross closed - and pressing it ticks the task off or back, as on a
 * Tasks row. A calendar's task (a Google task, a CalDAV VTODO) is marked
 * completed in its own calendar, which its provider is sent; a Tasks task goes
 * through Tasks.
 *
 * The card is the event card's, for a task: what it is, when it is due and
 * where it lives, and what Google's own does with one - edit it, copy it, take
 * it out, or download it. A Tasks task is opened in Tasks, which is where its
 * people, history and fields are.
 */

import { formatDay } from "./time";
import { useCalendarT } from "./i18n";
import { AnchoredPanel, ColorDot } from "./ui";
import { Button, StatusIcon } from "@polaris/ui";
import type { CalendarSummary, TaskItemView } from "../lib/wire";
import { CalendarClock, Copy, Download, ExternalLink, Pencil, Trash2 } from "lucide-react";

/** The round mark, as a button when the task can be ticked from here. */
export function TaskMark({
    task,
    color,
    size = 14,
    onToggle
}: {
    task: TaskItemView;
    /** What the mark is drawn in where the task has no status colour of its own. */
    color: string;
    size?: number;
    onToggle?: (task: TaskItemView) => void;
}) {
    const t = useCalendarT();
    const icon = <StatusIcon color={task.statusColor ?? color} type={task.statusType} size={size} />;
    if (!onToggle || !task.editable) return icon;
    const label = task.done ? t("todo.markNotDone") : t("todo.markDone");
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            // Its own press: not the grid's click that opens the card, and not
            // the start of a drag.
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onToggle(task);
            }}
            className="inline-flex shrink-0 items-center justify-center rounded-full transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
            {icon}
        </button>
    );
}

function dueOf(task: TaskItemView, locale: string, zone: string): string {
    if (!task.due) return "";
    if (task.allDay)
        return formatDay(
            new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date(task.due)),
            locale,
            { dateStyle: "full" }
        );
    return new Intl.DateTimeFormat(locale, {
        dateStyle: "full",
        timeStyle: "short",
        timeZone: zone
    }).format(new Date(task.due));
}

export function TaskCard({
    task,
    calendar,
    anchor,
    zone,
    locale,
    onClose,
    onToggle,
    onEdit,
    onDuplicate,
    onDelete
}: {
    task: TaskItemView;
    calendar: CalendarSummary | undefined;
    anchor: DOMRect | null;
    zone: string;
    locale: string;
    onClose: () => void;
    onToggle: (task: TaskItemView) => void;
    onEdit: () => void;
    onDuplicate: () => void;
    onDelete: () => void;
}) {
    const t = useCalendarT();
    const fromCalendar = task.source === "calendar";
    const status = task.statusName || t(`todo.statusType.${task.statusType}`);
    const where = fromCalendar ? calendar?.name : task.listName;
    return (
        <AnchoredPanel open onOpenChange={(open) => !open && onClose()} anchor={anchor} title={task.title}>
            <div className="flex flex-col gap-3 pr-1">
                <div className="flex items-start gap-2">
                    <span className="mt-0.5">
                        <TaskMark
                            task={task}
                            color={calendar?.color ?? "#64748b"}
                            size={18}
                            onToggle={onToggle}
                        />
                    </span>
                    <div className="min-w-0 flex-1">
                        <p
                            className={
                                task.done
                                    ? "break-words text-[0.9375rem] font-medium text-muted-foreground line-through"
                                    : "break-words text-[0.9375rem] font-medium"
                            }
                        >
                            {task.reference ? (
                                <span className="mr-1 text-muted-foreground">{task.reference}</span>
                            ) : null}
                            {task.title}
                        </p>
                        <p className="text-xs text-muted-foreground">{status}</p>
                        {task.due ? (
                            <p className="flex items-start gap-1.5 text-xs text-muted-foreground tabular-nums">
                                <CalendarClock aria-hidden className="mt-px size-3.5" />
                                {dueOf(task, locale, zone)}
                            </p>
                        ) : null}
                    </div>
                </div>
                {where ? (
                    <p className="flex min-w-0 items-center gap-1.5 text-xs text-foreground-subtle">
                        {calendar ? <ColorDot color={calendar.color} className="size-2" /> : null}
                        <span className="truncate" title={where}>
                            {where}
                        </span>
                    </p>
                ) : null}
                <div className="flex items-center gap-1 border-t border-border pt-2">
                    <Button size="sm" variant="secondary" onClick={onEdit}>
                        {fromCalendar ? <Pencil /> : <ExternalLink />}
                        {fromCalendar
                            ? task.editable
                                ? t("popover.edit")
                                : t("popover.open")
                            : t("todo.openInTasks")}
                    </Button>
                    {fromCalendar ? (
                        <span className="ml-auto flex items-center gap-1">
                            {task.editable ? (
                                <Button
                                    size="icon-sm"
                                    variant="ghost"
                                    aria-label={t("editor.duplicate")}
                                    title={t("editor.duplicate")}
                                    onClick={onDuplicate}
                                >
                                    <Copy />
                                </Button>
                            ) : null}
                            <Button asChild size="icon-sm" variant="ghost">
                                <a
                                    href={`/api/calendar/export/event/${task.id}`}
                                    download
                                    aria-label={t("editor.export")}
                                    title={t("editor.export")}
                                >
                                    <Download />
                                </a>
                            </Button>
                            {task.editable ? (
                                <Button
                                    size="icon-sm"
                                    variant="ghost"
                                    aria-label={t("todo.delete")}
                                    title={t("todo.delete")}
                                    onClick={onDelete}
                                >
                                    <Trash2 />
                                </Button>
                            ) : null}
                        </span>
                    ) : null}
                </div>
            </div>
        </AnchoredPanel>
    );
}
