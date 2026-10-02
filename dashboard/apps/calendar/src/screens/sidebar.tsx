"use client";

/**
 * The calendar's sidebar: a month to jump with, every calendar the reader
 * reaches - their own, the ones shared with them, the ones linked from outside
 * (by account) and the subscriptions - each with its colour, a box to show or
 * hide it, drag to reorder and a menu of what can be done with it; the world
 * clock; and the tasks that have no date yet, which can be dragged onto the
 * grid to give them one.
 */

import {
    AlertTriangle,
    ArrowDown,
    ArrowUp,
    BellOff,
    CalendarPlus,
    ChevronDown,
    Download,
    EyeOff,
    ListTodo,
    LogOut,
    MoreHorizontal,
    Palette,
    Pencil,
    Plus,
    Settings2,
    Share2,
    Trash2,
    Users
} from "lucide-react";
import Link from "next/link";
import {
    Button,
    cn,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
    Skeleton
} from "@polaris/ui";
import * as time from "./time";
import { useCalendarT } from "./i18n";
import { calendarSlots } from "./slots";
import { MiniMonth } from "./mini-month";
import { AddCalendarMenu } from "./accounts/add-calendar-menu";
import { CALENDAR_COLORS } from "../lib/schemas";
import { ownsSettings } from "./calendar-dialog";
import { ColorDot, GroupHeading, useNow } from "./ui";
import type { CalendarPreferences } from "../lib/preferences";
import type { CalendarSummary, TaskItemView } from "../lib/wire";
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";

export type SectionKey = "mine" | "shared" | "linked" | "subscriptions" | "rooms";

export interface CalendarGroups {
    readonly mine: CalendarSummary[];
    readonly shared: CalendarSummary[];
    /** By the account they come from. */
    readonly linked: { readonly label: string; readonly calendars: CalendarSummary[] }[];
    readonly subscriptions: CalendarSummary[];
    readonly rooms: CalendarSummary[];
}

/** The sidebar's sections. Pure. */
export function groupCalendars(calendars: readonly CalendarSummary[]): CalendarGroups {
    const sorted = [...calendars].sort(
        (a, b) => a.position - b.position || a.name.localeCompare(b.name)
    );
    const linked = new Map<string, CalendarSummary[]>();
    const groups = {
        mine: [] as CalendarSummary[],
        shared: [] as CalendarSummary[],
        subscriptions: [] as CalendarSummary[],
        rooms: [] as CalendarSummary[]
    };
    for (const calendar of sorted) {
        if (calendar.kind === "resource") groups.rooms.push(calendar);
        else if (calendar.source?.kind === "ics") groups.subscriptions.push(calendar);
        else if (calendar.source)
            linked.set(calendar.source.label, [
                ...(linked.get(calendar.source.label) ?? []),
                calendar
            ]);
        else if (calendar.reach === "owner") groups.mine.push(calendar);
        else groups.shared.push(calendar);
    }
    return {
        ...groups,
        linked: [...linked.entries()].map(([label, list]) => ({ label, calendars: list }))
    };
}

/** The whole order with one calendar moved before another (or to the end). */
export function reordered(
    calendars: readonly CalendarSummary[],
    moving: string,
    before: string | null
): string[] {
    const ids = [...calendars]
        .sort((a, b) => a.position - b.position)
        .map((calendar) => calendar.id);
    const without = ids.filter((id) => id !== moving);
    const index = before === null ? without.length : without.indexOf(before);
    without.splice(index < 0 ? without.length : index, 0, moving);
    return without;
}

export interface SidebarActions {
    readonly onToggle: (calendar: CalendarSummary) => void;
    readonly onReorder: (ids: string[]) => void;
    readonly onEdit: (calendar: CalendarSummary, focus?: "reminders") => void;
    readonly onColor: (calendar: CalendarSummary, color: string) => void;
    readonly onPatch: (
        calendar: CalendarSummary,
        patch: { alarmsMuted?: boolean; transparent?: boolean }
    ) => void;
    readonly onRemove: (calendar: CalendarSummary) => void;
    readonly onShare: (calendar: CalendarSummary) => void;
    readonly onPublish: (calendar: CalendarSummary) => void;
    readonly onNew: (withTasks: boolean) => void;
    /** Subscribe by address, or a holiday calendar: the add dialog on that tab. */
    readonly onAddFrom: (tab: "subscribe" | "holidays") => void;
    readonly onPickDay: (day: string) => void;
    readonly onToggleSection: (section: string) => void;
    readonly onScheduleTask: (task: TaskItemView, day: string) => void;
}

export function Sidebar({
    calendars,
    calendarsError,
    onRetry,
    preferences,
    anchor,
    today,
    shown,
    firstDay,
    locale,
    zone,
    tasks,
    actions
}: {
    calendars: readonly CalendarSummary[] | null;
    calendarsError: string | null;
    onRetry: () => void;
    preferences: CalendarPreferences;
    anchor: string;
    today: string;
    shown: time.DayWindow;
    firstDay: number;
    locale: string;
    zone: string;
    tasks: {
        readonly items: readonly TaskItemView[] | null;
        readonly error: string | null;
        readonly load: () => void;
    };
    actions: SidebarActions;
}) {
    const t = useCalendarT();
    const groups = useMemo(() => (calendars ? groupCalendars(calendars) : null), [calendars]);
    const collapsed = new Set(preferences.collapsed);
    const BookingPages = calendarSlots.BookingPagesSection;
    const Proposals = calendarSlots.ProposalsSection;

    const section = (key: string, title: string, list: readonly CalendarSummary[]) =>
        list.length === 0 ? null : (
            <Section
                key={key}
                id={key}
                title={title}
                collapsed={collapsed.has(key)}
                onToggle={() => actions.onToggleSection(key)}
            >
                <CalendarList calendars={list} all={calendars ?? []} actions={actions} />
            </Section>
        );

    return (
        <div className="flex flex-col gap-4 p-3">
            <MiniMonth
                value={anchor}
                today={today}
                firstDay={firstDay}
                locale={locale}
                highlight={shown}
                onPick={actions.onPickDay}
            />

            <div className="flex items-center gap-2">
                <AddCalendarMenu
                    onCreate={actions.onNew}
                    onAddFrom={calendarSlots.AddCalendars ? actions.onAddFrom : null}
                >
                    <Button size="sm" variant="outline" className="w-full justify-start">
                        <Plus />
                        <span className="min-w-0 flex-1 truncate text-left">{t("sidebar.add")}</span>
                        <ChevronDown className="text-foreground-subtle" />
                    </Button>
                </AddCalendarMenu>
            </div>

            {calendarsError && !calendars ? (
                <div role="alert" className="flex flex-col items-start gap-2 text-xs">
                    <p className="text-muted-foreground">{t("sidebar.loadFailed")}</p>
                    <Button size="xs" variant="outline" onClick={onRetry}>
                        {t("screen.retry")}
                    </Button>
                </div>
            ) : !groups ? (
                <div className="flex flex-col gap-2" aria-hidden>
                    {[0, 1, 2, 3].map((index) => (
                        <Skeleton key={index} className="h-5 w-full" />
                    ))}
                </div>
            ) : (
                <nav aria-label={t("sidebar.calendars")} className="flex flex-col gap-3">
                    {section("mine", t("sidebar.mine"), groups.mine)}
                    {groups.mine.length === 0 ? (
                        <p className="text-xs text-muted-foreground">{t("sidebar.noneYet")}</p>
                    ) : null}
                    {section("shared", t("sidebar.shared"), groups.shared)}
                    {groups.linked.map((group) =>
                        section(
                            `linked:${group.label}`.slice(0, 40),
                            t("sidebar.linked", { account: group.label }),
                            group.calendars
                        )
                    )}
                    {section("subscriptions", t("sidebar.subscriptions"), groups.subscriptions)}
                    {section("rooms", t("sidebar.rooms"), groups.rooms)}
                </nav>
            )}

            {BookingPages ? <BookingPages zone={zone} /> : null}
            {Proposals ? <Proposals zone={zone} /> : null}

            {preferences.worldClock.length > 0 ? (
                <Section
                    id="clock"
                    title={t("sidebar.worldClock")}
                    collapsed={collapsed.has("clock")}
                    onToggle={() => actions.onToggleSection("clock")}
                >
                    <WorldClock zones={preferences.worldClock} locale={locale} hour12={undefined} />
                </Section>
            ) : null}

            {preferences.showTasks ? (
                <Section
                    id="tasks"
                    title={t("sidebar.unscheduled")}
                    collapsed={collapsed.has("tasks")}
                    onToggle={() => actions.onToggleSection("tasks")}
                >
                    <UnscheduledTasks
                        tasks={tasks}
                        anchor={anchor}
                        locale={locale}
                        onSchedule={actions.onScheduleTask}
                    />
                </Section>
            ) : null}
        </div>
    );
}

function Section({
    id,
    title,
    collapsed,
    onToggle,
    children
}: {
    id: string;
    title: string;
    collapsed: boolean;
    onToggle: () => void;
    children: ReactNode;
}) {
    const bodyId = `calendar-section-${id.replace(/[^a-z0-9-]/gi, "-")}`;
    return (
        <section className="flex flex-col gap-1">
            <button
                type="button"
                aria-expanded={!collapsed}
                aria-controls={bodyId}
                onClick={onToggle}
                className="flex items-center gap-1 rounded text-left"
            >
                <ChevronDown
                    aria-hidden
                    className={cn(
                        "size-3.5 text-foreground-subtle transition-transform duration-fast",
                        collapsed && "-rotate-90"
                    )}
                />
                <GroupHeading className="min-w-0 flex-1 truncate">{title}</GroupHeading>
            </button>
            {collapsed ? null : <div id={bodyId}>{children}</div>}
        </section>
    );
}

function CalendarList({
    calendars,
    all,
    actions
}: {
    calendars: readonly CalendarSummary[];
    all: readonly CalendarSummary[];
    actions: SidebarActions;
}) {
    const [dragging, setDragging] = useState<string | null>(null);
    const [over, setOver] = useState<string | null>(null);
    const sameList = (id: string | null) =>
        id !== null && calendars.some((calendar) => calendar.id === id);

    const onDrop = (event: DragEvent, before: string | null) => {
        event.preventDefault();
        const moving = dragging ?? event.dataTransfer.getData("text/x-polaris-calendar");
        setDragging(null);
        setOver(null);
        if (!moving || !sameList(moving) || moving === before) return;
        actions.onReorder(reordered(all, moving, before));
    };

    return (
        <ul
            className="flex flex-col"
            onDragOver={(event) => sameList(dragging) && event.preventDefault()}
            onDrop={(event) => onDrop(event, null)}
        >
            {calendars.map((calendar, index) => (
                <CalendarRow
                    key={calendar.id}
                    calendar={calendar}
                    actions={actions}
                    dropBefore={over === calendar.id && dragging !== calendar.id}
                    onMove={(direction) => {
                        const neighbour = calendars[index + direction];
                        if (!neighbour) return;
                        const before =
                            direction === -1 ? neighbour.id : (calendars[index + 2]?.id ?? null);
                        actions.onReorder(
                            before === null
                                ? reordered(all, calendar.id, nextAfter(all, neighbour.id))
                                : reordered(all, calendar.id, before)
                        );
                    }}
                    first={index === 0}
                    last={index === calendars.length - 1}
                    drag={{
                        onDragStart: (event) => {
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("text/x-polaris-calendar", calendar.id);
                            setDragging(calendar.id);
                        },
                        onDragEnd: () => {
                            setDragging(null);
                            setOver(null);
                        },
                        onDragOver: (event) => {
                            if (!sameList(dragging)) return;
                            event.preventDefault();
                            event.stopPropagation();
                            setOver(calendar.id);
                        },
                        onDrop: (event) => {
                            event.stopPropagation();
                            onDrop(event, calendar.id);
                        }
                    }}
                />
            ))}
        </ul>
    );
}

/** The calendar after `id` in the whole order, or null at the end. */
function nextAfter(all: readonly CalendarSummary[], id: string): string | null {
    const ids = [...all].sort((a, b) => a.position - b.position).map((calendar) => calendar.id);
    return ids[ids.indexOf(id) + 1] ?? null;
}

function CalendarRow({
    calendar,
    actions,
    dropBefore,
    onMove,
    first,
    last,
    drag
}: {
    calendar: CalendarSummary;
    actions: SidebarActions;
    dropBefore: boolean;
    onMove: (direction: 1 | -1) => void;
    first: boolean;
    last: boolean;
    drag: {
        onDragStart: (event: DragEvent) => void;
        onDragEnd: () => void;
        onDragOver: (event: DragEvent) => void;
        onDrop: (event: DragEvent) => void;
    };
}) {
    const t = useCalendarT();
    const owner = ownsSettings(calendar);
    const ShareCalendar = calendarSlots.ShareCalendar;
    const PublishCalendar = calendarSlots.PublishCalendar;
    const failing = calendar.source !== null && calendar.source.status !== "ok";
    const visible = !calendar.hidden;

    return (
        <li
            draggable
            onDragStart={drag.onDragStart}
            onDragEnd={drag.onDragEnd}
            onDragOver={drag.onDragOver}
            onDrop={drag.onDrop}
            className={cn(
                "group flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 hover:bg-card-hover",
                dropBefore && "shadow-[inset_0_2px_0_hsl(var(--foreground))]"
            )}
        >
            <button
                type="button"
                role="checkbox"
                aria-checked={visible}
                aria-label={t(visible ? "sidebar.hide" : "sidebar.show", { name: calendar.name })}
                title={t(visible ? "sidebar.hide" : "sidebar.show", { name: calendar.name })}
                onClick={() => actions.onToggle(calendar)}
                className="flex size-4 shrink-0 items-center justify-center rounded border-2"
                style={{
                    borderColor: calendar.color,
                    backgroundColor: visible ? calendar.color : "transparent"
                }}
            />
            <span
                className={cn(
                    "min-w-0 flex-1 truncate text-[0.8125rem]",
                    !visible && "text-muted-foreground"
                )}
                title={
                    calendar.owner
                        ? t("sidebar.ownedBy", { name: calendar.name, owner: calendar.owner.name })
                        : calendar.name
                }
            >
                {calendar.name}
            </span>
            {calendar.components.includes("VTODO") ? (
                <ListTodo
                    aria-label={t("sidebar.holdsTasks")}
                    className="size-3.5 text-foreground-subtle"
                />
            ) : null}
            {calendar.alarmsMuted ? (
                <BellOff
                    aria-label={t("sidebar.muted")}
                    className="size-3.5 text-foreground-subtle"
                />
            ) : null}
            {calendar.transparent ? (
                <EyeOff
                    aria-label={t("sidebar.neverBusy")}
                    className="size-3.5 text-foreground-subtle"
                />
            ) : null}
            {calendar.shareCount > 0 ? (
                <Users
                    aria-label={t("sidebar.sharedCount", { count: calendar.shareCount })}
                    className="size-3.5 text-foreground-subtle"
                />
            ) : null}
            {failing ? (
                <Link
                    href="/calendar/settings/accounts"
                    aria-label={t("sidebar.syncProblem")}
                    title={t("sidebar.syncProblemFix")}
                    className="shrink-0 rounded"
                >
                    <AlertTriangle aria-hidden className="size-3.5 text-warning" />
                </Link>
            ) : null}
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        size="icon-xs"
                        variant="ghost"
                        className="md:opacity-0 md:focus-visible:opacity-100 md:group-hover:opacity-100 md:data-[state=open]:opacity-100"
                        aria-label={t("sidebar.menu", { name: calendar.name })}
                        title={t("sidebar.menu", { name: calendar.name })}
                    >
                        <MoreHorizontal />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => actions.onEdit(calendar)}>
                        <Pencil />
                        {owner ? t("sidebar.edit") : t("sidebar.editColor")}
                    </DropdownMenuItem>
                    <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                            <Palette />
                            {t("sidebar.color")}
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="min-w-0">
                            <div className="grid grid-cols-4 gap-1 p-1">
                                {CALENDAR_COLORS.map((color) => (
                                    <DropdownMenuItem
                                        key={color}
                                        className="justify-center p-1"
                                        aria-label={color}
                                        onSelect={() => actions.onColor(calendar, color)}
                                    >
                                        <ColorDot
                                            color={color}
                                            className={cn(
                                                "size-5",
                                                color === calendar.color &&
                                                    "ring-2 ring-foreground ring-offset-1 ring-offset-elevated"
                                            )}
                                        />
                                    </DropdownMenuItem>
                                ))}
                            </div>
                        </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    {owner ? (
                        <>
                            <DropdownMenuItem
                                onSelect={() => actions.onEdit(calendar, "reminders")}
                            >
                                <BellOff className="opacity-0" aria-hidden />
                                {t("sidebar.defaultReminders")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onSelect={() =>
                                    actions.onPatch(calendar, {
                                        alarmsMuted: !calendar.alarmsMuted
                                    })
                                }
                            >
                                <BellOff />
                                {calendar.alarmsMuted ? t("sidebar.unmute") : t("sidebar.mute")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onSelect={() =>
                                    actions.onPatch(calendar, {
                                        transparent: !calendar.transparent
                                    })
                                }
                            >
                                <EyeOff />
                                {calendar.transparent
                                    ? t("sidebar.countAsBusy")
                                    : t("sidebar.neverBusyAction")}
                            </DropdownMenuItem>
                        </>
                    ) : null}
                    {owner && ShareCalendar ? (
                        <DropdownMenuItem onSelect={() => actions.onShare(calendar)}>
                            <Share2 />
                            {t("sidebar.share")}
                        </DropdownMenuItem>
                    ) : null}
                    {owner && PublishCalendar ? (
                        <DropdownMenuItem onSelect={() => actions.onPublish(calendar)}>
                            <Share2 />
                            {t("sidebar.publish")}
                        </DropdownMenuItem>
                    ) : null}
                    {calendar.source ? (
                        <DropdownMenuItem asChild>
                            <Link href="/calendar/settings/accounts">
                                <Settings2 />
                                {t("sidebar.manageAccount")}
                            </Link>
                        </DropdownMenuItem>
                    ) : null}
                    {calendar.reach !== "freebusy" ? (
                        <DropdownMenuItem asChild>
                            <a href={`/api/calendar/export/${calendar.id}`} download>
                                <Download />
                                {t("sidebar.export")}
                            </a>
                        </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled={first} onSelect={() => onMove(-1)}>
                        <ArrowUp />
                        {t("sidebar.moveUp")}
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={last} onSelect={() => onMove(1)}>
                        <ArrowDown />
                        {t("sidebar.moveDown")}
                    </DropdownMenuItem>
                    {calendar.kind !== "resource" && calendar.kind !== "birthdays" ? (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                variant="danger"
                                onSelect={() => actions.onRemove(calendar)}
                            >
                                {calendar.reach === "owner" ? <Trash2 /> : <LogOut />}
                                {calendar.reach === "owner"
                                    ? t("sidebar.delete")
                                    : t("sidebar.leave")}
                            </DropdownMenuItem>
                        </>
                    ) : null}
                </DropdownMenuContent>
            </DropdownMenu>
        </li>
    );
}

function WorldClock({
    zones,
    locale,
    hour12
}: {
    zones: readonly string[];
    locale: string;
    hour12: boolean | undefined;
}) {
    const now = useNow(30_000);
    return (
        <ul className="flex flex-col gap-1">
            {zones.map((zone) => {
                let text = "";
                let day = "";
                try {
                    text = new Intl.DateTimeFormat(locale, {
                        hour: "numeric",
                        minute: "2-digit",
                        hour12,
                        timeZone: zone
                    }).format(now);
                    day = new Intl.DateTimeFormat(locale, {
                        weekday: "short",
                        timeZone: zone
                    }).format(now);
                } catch {
                    text = "-";
                }
                const city = zone.split("/").pop()?.replace(/_/g, " ") ?? zone;
                return (
                    <li
                        key={zone}
                        className="flex items-baseline gap-2 text-[0.8125rem]"
                        title={zone}
                    >
                        <span className="min-w-0 flex-1 truncate">{city}</span>
                        <span className="text-xs text-foreground-subtle">{day}</span>
                        <span className="tabular-nums">{text}</span>
                    </li>
                );
            })}
        </ul>
    );
}

function UnscheduledTasks({
    tasks,
    anchor,
    locale,
    onSchedule
}: {
    tasks: {
        readonly items: readonly TaskItemView[] | null;
        readonly error: string | null;
        readonly load: () => void;
    };
    anchor: string;
    locale: string;
    onSchedule: (task: TaskItemView, day: string) => void;
}) {
    const t = useCalendarT();
    const list = useRef<HTMLUListElement>(null);
    const { load } = tasks;

    useEffect(() => {
        load();
    }, [load]);

    // Dragging onto the grid is the grid's own external drop, loaded with it.
    useEffect(() => {
        const element = list.current;
        if (!element || !tasks.items?.length) return;
        let draggable: { destroy: () => void } | null = null;
        let cancelled = false;
        void import("@fullcalendar/interaction").then(({ Draggable }) => {
            if (cancelled) return;
            draggable = new Draggable(element, {
                itemSelector: "[data-task-id]",
                eventData: (item) => ({
                    title: item.getAttribute("data-task-title") ?? "",
                    duration: "00:30",
                    create: true,
                    extendedProps: { taskId: item.getAttribute("data-task-id") }
                })
            });
        });
        return () => {
            cancelled = true;
            draggable?.destroy();
        };
    }, [tasks.items]);

    if (tasks.error && !tasks.items) {
        return (
            <div role="alert" className="flex flex-col items-start gap-1 text-xs">
                <p className="text-muted-foreground">{t("sidebar.tasksFailed")}</p>
                <Button size="xs" variant="outline" onClick={load}>
                    {t("screen.retry")}
                </Button>
            </div>
        );
    }
    if (!tasks.items) {
        return (
            <div className="flex flex-col gap-1.5" aria-hidden>
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-4/5" />
            </div>
        );
    }
    if (tasks.items.length === 0)
        return <p className="text-xs text-muted-foreground">{t("sidebar.noUnscheduled")}</p>;
    const dayText = time.formatDay(anchor, locale, { day: "numeric", month: "short" });
    return (
        <>
            <p className="mb-1 text-xs text-foreground-subtle">{t("sidebar.dragHint")}</p>
            <ul ref={list} className="flex flex-col">
                {tasks.items.map((task) => (
                    <li
                        key={task.id}
                        data-task-id={task.id}
                        data-task-title={task.title}
                        className="group flex min-w-0 cursor-grab items-center gap-2 rounded-md px-1 py-1 hover:bg-card-hover"
                    >
                        <ListTodo aria-hidden className="size-4 text-foreground-subtle" />
                        <Link
                            href={`/tasks/t/${task.id}`}
                            className="min-w-0 flex-1 truncate text-[0.8125rem] hover:underline"
                            title={task.listName ? `${task.title} - ${task.listName}` : task.title}
                        >
                            {task.reference ? (
                                <span className="mr-1 text-xs text-foreground-subtle tabular-nums">
                                    {task.reference}
                                </span>
                            ) : null}
                            {task.title}
                        </Link>
                        <Button
                            size="icon-xs"
                            variant="ghost"
                            className="md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                            aria-label={t("sidebar.scheduleOn", {
                                title: task.title,
                                day: dayText
                            })}
                            title={t("sidebar.scheduleOn", { title: task.title, day: dayText })}
                            onClick={() => onSchedule(task, anchor)}
                        >
                            <CalendarPlus />
                        </Button>
                    </li>
                ))}
            </ul>
        </>
    );
}
