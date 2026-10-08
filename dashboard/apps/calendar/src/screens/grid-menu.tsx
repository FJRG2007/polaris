"use client";

/**
 * The grid's context menu: right-click (a long press on a touch screen, the
 * menu key or Shift+F10 on a focused day or event) on a day, a time, the
 * all-day row or an event.
 *
 * On a day or a time: a new event or all-day event there, a task due there,
 * pasting a copied event there, and going to that day. A range selected first
 * and then right-clicked is the range the new event takes. On an event: open,
 * edit, duplicate, copy, move to another calendar, colour, answer the
 * invitation, download, delete.
 *
 * The wrapper also gives the grid its keyboard: the arrows step between days,
 * Enter starts an event on the focused day, and Ctrl/Cmd+C and +V copy the
 * focused event and paste onto the focused day.
 *
 * Nothing about events is decided here: the screen resolves what was pressed
 * (`resolve`) and carries out what was chosen (`actions`), the same way it does
 * for a click, so a menu choice and a click can never drift apart.
 */

import {
    CalendarDays,
    CalendarPlus,
    ClipboardPaste,
    Copy,
    CopyPlus,
    Download,
    FolderInput,
    ListTodo,
    Loader2,
    Palette,
    Pencil,
    Plus,
    SquareArrowOutUpRight,
    Trash2,
    UserCheck
} from "lucide-react";
import {
    cn,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuSeparator,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger,
    ShortcutHint,
    shortcutPressed
} from "@polaris/ui";
import * as time from "./time";
import { ColorDot } from "./ui";
import { useCalendarT } from "./i18n";
import { isTyping } from "./shortcuts";
import type { PartStat } from "../engine";
import { EVENT_COLORS } from "./editor-model";
import type { GridItem } from "./grid-events";
import type { GridMoment, GridRange } from "./grid-view";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { CalendarSummary, OccurrenceView, TaskItemView } from "../lib/wire";
import { KEYBOARD_CELLS, targetFromElements, withAncestors, type GridTarget } from "./grid-target";

/** What a menu was opened on, resolved by the screen. */
export type MenuTarget =
    | {
          readonly kind: "event";
          readonly id: string;
          readonly occurrence: OccurrenceView;
          readonly rect: DOMRect;
      }
    | {
          readonly kind: "task";
          readonly id: string;
          readonly task: TaskItemView;
          /** The day it is due, in the display zone. */
          readonly day: string | null;
          readonly rect: DOMRect;
      }
    | {
          readonly kind: "slot";
          /** Where a new event there starts and ends - a slot, a day, or the
           *  whole range that was selected first. */
          readonly range: GridRange;
          /** The day pressed, for "go to this day" and an all-day event. */
          readonly day: string;
          /** The range was selected before the menu was opened on it. */
          readonly selected: boolean;
          /** What the label at the top of the menu says. */
          readonly when: string;
          readonly point: DOMRect;
      };

export interface GridMenuActions {
    readonly newEvent: (range: GridRange, anchor: DOMRect) => void;
    readonly newAllDay: (day: string, anchor: DOMRect) => void;
    readonly newTask: (at: GridMoment) => void;
    readonly paste: (at: GridMoment) => void;
    readonly goToDay: (day: string) => void;
    readonly openItem: (item: GridItem, id: string, anchor: DOMRect) => void;
    readonly edit: (occurrence: OccurrenceView) => void;
    readonly duplicate: (occurrence: OccurrenceView) => void;
    readonly copy: (occurrence: OccurrenceView) => void;
    readonly move: (occurrence: OccurrenceView, calendarId: string) => void;
    readonly color: (occurrence: OccurrenceView, color: string | null) => void;
    readonly respond: (occurrence: OccurrenceView, partstat: PartStat) => void;
    readonly remove: (occurrence: OccurrenceView) => void;
}

export interface GridMenuProps {
    readonly children: ReactNode;
    /** What a press stands for; null leaves the browser's own menu. `held` is the
     *  range that was highlighted when the press began. */
    readonly resolve: (
        target: GridTarget,
        point: DOMRect,
        held: GridRange | null
    ) => MenuTarget | null;
    /** The range highlighted right now, read when a right press begins - before
     *  the press closes whatever card was holding it. */
    readonly heldRange: () => GridRange | null;
    readonly onOpenChange: (open: boolean, target: MenuTarget | null) => void;
    readonly calendars: readonly CalendarSummary[];
    /** The event copied last, if any. */
    readonly clipboard: OccurrenceView | null;
    /** Tasks lists: undefined while being read, null when tasks cannot be made. */
    readonly taskLists: readonly unknown[] | null | undefined;
    /** Whether "go to this day" would change anything. */
    readonly showsOnlyDay: (day: string) => boolean;
    readonly actions: GridMenuActions;
}

/** A point for a menu opened from the keyboard: just inside the element. */
function pointOf(element: Element): { x: number; y: number } {
    const rect = element.getBoundingClientRect();
    return {
        x: Math.round(rect.left + Math.min(16, rect.width / 2)),
        y: Math.round(rect.top + Math.min(16, rect.height / 2))
    };
}

/** The day a step of the arrows lands on, or null for a key that is not one. */
function stepped(day: string, key: string, timeColumns: boolean): string | null {
    if (key === "ArrowLeft") return time.addDays(day, -1);
    if (key === "ArrowRight") return time.addDays(day, 1);
    // A time grid's columns are side by side; up and down scroll its hours.
    if (timeColumns) return null;
    if (key === "ArrowUp") return time.addDays(day, -7);
    if (key === "ArrowDown") return time.addDays(day, 7);
    return null;
}

/**
 * Whether what the choice opened (the new-event card, an event's card, an
 * editor) already holds the focus.
 *
 * A menu that closes hands the focus back to where it was before it opened -
 * the day pressed. A panel opened by the choice has taken it by then, and the
 * new-event card is not modal: focus leaving it reads as the reader moving on,
 * and it closed the instant it opened. So the menu leaves the focus where the
 * panel put it, and hands it back only when nothing took it.
 */
function focusTakenByPanel(): boolean {
    const active = typeof document === "undefined" ? null : document.activeElement;
    return active instanceof Element && active.closest('[role="dialog"]') !== null;
}

/** Whether a key press asks for the context menu: the menu key, or Shift+F10 by
 *  default (the shared table's `calendar.grid.menu`). */
function asksForMenu(event: KeyboardEvent<HTMLDivElement>): boolean {
    return shortcutPressed(event, "calendar.grid.menu");
}

export function GridMenu(props: GridMenuProps) {
    const t = useCalendarT();
    const wrapper = useRef<HTMLDivElement>(null);
    const [target, setTarget] = useState<MenuTarget | null>(null);
    const propsRef = useRef(props);
    propsRef.current = props;
    /** The element a keyboard asked about, standing in for the point. */
    const fromKeyboard = useRef<Element | null>(null);
    /** The highlighted range when the right press began. */
    const heldAtPress = useRef<GridRange | null>(null);

    // Native listeners, in the capture phase: a press with nothing under it has
    // to be stopped before the menu's own handler sees it, so the browser's
    // menu opens instead of an empty one.
    useEffect(() => {
        const element = wrapper.current;
        if (!element) return;
        const onPointerDown = (event: PointerEvent) => {
            heldAtPress.current = event.button === 2 ? propsRef.current.heldRange() : null;
            if (event.pointerType === "mouse") return;
            // A long press opens the menu from Radix's own timer, with no
            // contextmenu event to read, so what is under the finger is settled
            // now. Nothing of the grid under it: the press never reaches the
            // menu, and the page scrolls and selects as it would anyway.
            const found = targetFromElements(
                typeof document.elementsFromPoint === "function"
                    ? document.elementsFromPoint(event.clientX, event.clientY)
                    : event.target instanceof Element
                      ? withAncestors(event.target)
                      : []
            );
            const resolved = found
                ? propsRef.current.resolve(
                      found,
                      new DOMRect(event.clientX, event.clientY, 0, 0),
                      propsRef.current.heldRange()
                  )
                : null;
            if (!resolved) {
                event.stopPropagation();
                return;
            }
            setTarget(resolved);
        };
        const onContextMenu = (event: MouseEvent) => {
            const keyboard = fromKeyboard.current;
            fromKeyboard.current = null;
            const elements = keyboard
                ? withAncestors(keyboard)
                : typeof document.elementsFromPoint === "function"
                  ? document.elementsFromPoint(event.clientX, event.clientY)
                  : event.target instanceof Element
                    ? withAncestors(event.target)
                    : [];
            const found = targetFromElements(elements);
            // A long press starts the same selection a drag does; the menu that
            // opens on it is what was asked for, not that selection.
            const held = heldAtPress.current ?? (keyboard ? null : propsRef.current.heldRange());
            heldAtPress.current = null;
            const resolved = found
                ? propsRef.current.resolve(
                      found,
                      new DOMRect(event.clientX, event.clientY, 0, 0),
                      held
                  )
                : null;
            if (!resolved) {
                event.stopPropagation();
                return;
            }
            setTarget(resolved);
        };
        element.addEventListener("pointerdown", onPointerDown, true);
        element.addEventListener("contextmenu", onContextMenu, true);
        return () => {
            element.removeEventListener("pointerdown", onPointerDown, true);
            element.removeEventListener("contextmenu", onContextMenu, true);
        };
    }, []);

    /** Open the menu on an element, as a right-click on it would. */
    const openOn = (element: Element) => {
        fromKeyboard.current = element;
        const { x, y } = pointOf(element);
        element.dispatchEvent(
            new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                clientX: x,
                clientY: y
            })
        );
    };

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.defaultPrevented || isTyping(event.target)) return;
        const focused = event.target instanceof Element ? event.target : null;
        if (!focused) return;
        const item = focused.closest("[data-event-id]");
        const cell = item ? null : focused.closest(KEYBOARD_CELLS);
        const subject = item ?? cell;
        if (!subject) return;
        if (asksForMenu(event)) {
            event.preventDefault();
            openOn(subject);
            return;
        }
        const mod = event.ctrlKey || event.metaKey;
        const resolvedHere = () => {
            const found = targetFromElements(withAncestors(subject));
            if (!found) return null;
            const rect = subject.getBoundingClientRect();
            return propsRef.current.resolve(found, rect, null);
        };
        if (item && shortcutPressed(event, "calendar.copy")) {
            const resolved = resolvedHere();
            if (resolved?.kind !== "event" || resolved.occurrence.busyOnly) return;
            event.preventDefault();
            propsRef.current.actions.copy(resolved.occurrence);
            return;
        }
        if (cell && shortcutPressed(event, "calendar.paste")) {
            const resolved = resolvedHere();
            if (resolved?.kind !== "slot" || !propsRef.current.clipboard) return;
            event.preventDefault();
            propsRef.current.actions.paste(resolved.range.start);
            return;
        }
        if (!cell || mod || event.altKey) return;
        if (event.key === "Enter" || event.key === " ") {
            const resolved = resolvedHere();
            if (resolved?.kind !== "slot") return;
            event.preventDefault();
            propsRef.current.actions.newEvent(resolved.range, cell.getBoundingClientRect());
            return;
        }
        const day = cell.getAttribute("data-date");
        const timeColumns = cell.matches(".fc-timegrid-col");
        const next = day ? stepped(day, event.key, timeColumns) : null;
        if (!next) return;
        const kind = timeColumns ? ".fc-timegrid-col" : ".fc-daygrid-day";
        const container = cell.closest(".fc-timegrid-cols, .fc-daygrid-body, .fc-multimonth");
        const destination = (container ?? wrapper.current)?.querySelector<HTMLElement>(
            `${kind}[data-date="${next}"]`
        );
        if (!destination) return;
        event.preventDefault();
        (cell as HTMLElement).tabIndex = -1;
        destination.tabIndex = 0;
        destination.focus();
    };

    return (
        <ContextMenu
            onOpenChange={(open) => {
                const current = open ? target : null;
                if (!open) setTarget(null);
                propsRef.current.onOpenChange(open, current);
            }}
        >
            <ContextMenuTrigger asChild>
                <div ref={wrapper} className="h-full min-h-0" onKeyDown={onKeyDown}>
                    {props.children}
                </div>
            </ContextMenuTrigger>
            <ContextMenuContent
                className="w-60"
                aria-label={t("gridMenu.label")}
                onCloseAutoFocus={(event) => {
                    if (focusTakenByPanel()) event.preventDefault();
                }}
            >
                {target ? <MenuBody target={target} {...props} /> : null}
            </ContextMenuContent>
        </ContextMenu>
    );
}

function MenuBody({
    target,
    calendars,
    clipboard,
    taskLists,
    showsOnlyDay,
    actions
}: GridMenuProps & { target: MenuTarget }) {
    const t = useCalendarT();
    if (target.kind === "slot") {
        const start = target.range.start;
        return (
            <>
                <ContextMenuLabel title={target.when} className="first-letter:uppercase">
                    {target.when}
                </ContextMenuLabel>
                <ContextMenuItem onSelect={() => actions.newEvent(target.range, target.point)}>
                    <Plus className="size-4" />
                    {target.selected ? t("gridMenu.newInRange") : t("gridMenu.newEvent")}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => actions.newAllDay(target.day, target.point)}>
                    <CalendarPlus className="size-4" />
                    {t("gridMenu.newAllDay")}
                </ContextMenuItem>
                {taskLists === null ? null : (
                    <ContextMenuItem
                        disabled={taskLists === undefined}
                        onSelect={() => actions.newTask(start)}
                    >
                        {taskLists === undefined ? (
                            <Loader2 className="size-4 animate-spin" aria-hidden />
                        ) : (
                            <ListTodo className="size-4" />
                        )}
                        {t("gridMenu.newTask")}
                    </ContextMenuItem>
                )}
                {clipboard ? (
                    <ContextMenuItem onSelect={() => actions.paste(start)}>
                        <ClipboardPaste className="size-4" />
                        <span className="min-w-0 truncate" title={clipboard.summary}>
                            {t("gridMenu.paste", {
                                title: clipboard.summary || t("screen.untitled")
                            })}
                        </span>
                        <ShortcutHint id="calendar.paste" />
                    </ContextMenuItem>
                ) : null}
                {showsOnlyDay(target.day) ? null : (
                    <>
                        <ContextMenuSeparator />
                        <ContextMenuItem onSelect={() => actions.goToDay(target.day)}>
                            <CalendarDays className="size-4" />
                            {t("gridMenu.goToDay")}
                        </ContextMenuItem>
                    </>
                )}
            </>
        );
    }
    if (target.kind === "task") {
        const task = target.task;
        return (
            <>
                <ContextMenuLabel title={task.title}>{task.title}</ContextMenuLabel>
                <ContextMenuItem
                    onSelect={() =>
                        actions.openItem({ kind: "task", task }, target.id, target.rect)
                    }
                >
                    <SquareArrowOutUpRight className="size-4" />
                    {t("gridMenu.openTask")}
                </ContextMenuItem>
                {target.day && !showsOnlyDay(target.day) ? (
                    <ContextMenuItem onSelect={() => actions.goToDay(target.day!)}>
                        <CalendarDays className="size-4" />
                        {t("gridMenu.goToDay")}
                    </ContextMenuItem>
                ) : null}
            </>
        );
    }
    const occurrence = target.occurrence;
    const title = occurrence.busyOnly
        ? t("screen.busy")
        : occurrence.summary || t("screen.untitled");
    const others = calendars.filter(
        (calendar) =>
            calendar.writable &&
            calendar.components.includes("VEVENT") &&
            calendar.id !== occurrence.calendarId
    );
    const own = calendars.find((calendar) => calendar.id === occurrence.calendarId);
    return (
        <>
            <ContextMenuLabel title={title}>{title}</ContextMenuLabel>
            <ContextMenuItem
                onSelect={() =>
                    actions.openItem({ kind: "event", occurrence }, target.id, target.rect)
                }
            >
                <SquareArrowOutUpRight className="size-4" />
                {t("gridMenu.open")}
            </ContextMenuItem>
            {occurrence.editable ? (
                <>
                    <ContextMenuItem onSelect={() => actions.edit(occurrence)}>
                        <Pencil className="size-4" />
                        {t("gridMenu.edit")}
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => actions.duplicate(occurrence)}>
                        <CopyPlus className="size-4" />
                        {t("gridMenu.duplicate")}
                    </ContextMenuItem>
                </>
            ) : null}
            {occurrence.busyOnly ? null : (
                <ContextMenuItem onSelect={() => actions.copy(occurrence)}>
                    <Copy className="size-4" />
                    {t("gridMenu.copy")}
                    <ShortcutHint id="calendar.copy" />
                </ContextMenuItem>
            )}
            {occurrence.editable ? (
                <>
                    <ContextMenuSeparator />
                    <ContextMenuSub>
                        <ContextMenuSubTrigger disabled={others.length === 0}>
                            <FolderInput className="size-4" />
                            {t("gridMenu.move")}
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent className="w-56">
                            {occurrence.recurring ? (
                                <ContextMenuLabel>{t("gridMenu.wholeSeries")}</ContextMenuLabel>
                            ) : null}
                            {others.map((calendar) => (
                                <ContextMenuItem
                                    key={calendar.id}
                                    onSelect={() => actions.move(occurrence, calendar.id)}
                                >
                                    <ColorDot color={calendar.color} />
                                    <span className="min-w-0 truncate" title={calendar.name}>
                                        {calendar.name}
                                    </span>
                                </ContextMenuItem>
                            ))}
                        </ContextMenuSubContent>
                    </ContextMenuSub>
                    <ContextMenuSub>
                        <ContextMenuSubTrigger>
                            <Palette className="size-4" />
                            {t("gridMenu.color")}
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent className="min-w-0">
                            {occurrence.recurring ? (
                                <ContextMenuLabel>{t("gridMenu.wholeSeries")}</ContextMenuLabel>
                            ) : null}
                            <div className="grid grid-cols-5 gap-1 p-1">
                                {EVENT_COLORS.map((color) => (
                                    <ContextMenuItem
                                        key={color}
                                        className="justify-center p-1"
                                        aria-label={t("gridMenu.colorOption", { color })}
                                        title={t("gridMenu.colorOption", { color })}
                                        onSelect={() => actions.color(occurrence, color)}
                                    >
                                        <ColorDot
                                            color={color}
                                            className={cn(
                                                "size-5",
                                                occurrence.color === color &&
                                                    "ring-2 ring-foreground ring-offset-1 ring-offset-elevated"
                                            )}
                                        />
                                    </ContextMenuItem>
                                ))}
                            </div>
                            <ContextMenuItem
                                disabled={occurrence.color === null}
                                onSelect={() => actions.color(occurrence, null)}
                            >
                                <ColorDot color={own?.color ?? "#7f7f7f"} />
                                {t("editor.calendarColor")}
                            </ContextMenuItem>
                        </ContextMenuSubContent>
                    </ContextMenuSub>
                </>
            ) : null}
            {occurrence.myPartstat !== null && !occurrence.busyOnly ? (
                <ContextMenuSub>
                    <ContextMenuSubTrigger>
                        <UserCheck className="size-4" />
                        {t("gridMenu.respond")}
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent className="w-48">
                        {occurrence.recurring ? (
                            <ContextMenuLabel>{t("respond.thisOne")}</ContextMenuLabel>
                        ) : null}
                        {(["ACCEPTED", "TENTATIVE", "DECLINED"] as const).map((partstat) => (
                            <ContextMenuItem
                                key={partstat}
                                aria-checked={occurrence.myPartstat === partstat}
                                role="menuitemcheckbox"
                                onSelect={() => actions.respond(occurrence, partstat)}
                            >
                                <span
                                    aria-hidden
                                    className={cn(
                                        "size-1.5 rounded-full",
                                        occurrence.myPartstat === partstat
                                            ? "bg-foreground"
                                            : "bg-transparent"
                                    )}
                                />
                                {t(`gridMenu.answers.${partstat}`)}
                            </ContextMenuItem>
                        ))}
                    </ContextMenuSubContent>
                </ContextMenuSub>
            ) : null}
            {occurrence.busyOnly ? null : (
                <ContextMenuItem asChild>
                    <a href={`/api/calendar/export/event/${occurrence.objectId}`} download>
                        <Download className="size-4" />
                        {t("gridMenu.download")}
                    </a>
                </ContextMenuItem>
            )}
            {occurrence.editable ? (
                <>
                    <ContextMenuSeparator />
                    <ContextMenuItem variant="danger" onSelect={() => actions.remove(occurrence)}>
                        <Trash2 className="size-4" />
                        {t("gridMenu.delete")}
                    </ContextMenuItem>
                </>
            ) : null}
        </>
    );
}
