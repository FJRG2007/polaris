"use client";

/**
 * The calendar: the header, the sidebar and the grid, and everything done from
 * them.
 *
 * The URL is the state (`/calendar/<view>/<date>`, `/calendar/e/<id>`), and
 * every read paints from the last answer kept for it before asking again - the
 * calendars, the settings and each window of days separately - so paging back
 * to a week already seen draws it at once. Only the region still waiting shows
 * a placeholder.
 *
 * Drags, resizes, hiding, recolouring and reordering happen on screen first and
 * are put back, with a note saying why, if the server refuses them.
 *
 * Right-click (or a long press, or the menu key) on the grid opens its menu
 * (`grid-menu.tsx`); what it offers is carried out by the same functions a
 * click, a drag or a key uses here.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    AlarmClock,
    CalendarCheck,
    ChevronLeft,
    ChevronRight,
    Keyboard,
    Loader2,
    Menu,
    MoreVertical,
    Plus,
    Printer,
    RefreshCw,
    Settings,
    Trash2,
    X
} from "lucide-react";
import {
    Button,
    cn,
    Dialog,
    DialogContent,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    EmptyState,
    SegmentedControl,
    Select,
    Skeleton,
    useToast
} from "@polaris/ui";
import * as time from "./time";
import { useCalendarT } from "./i18n";
import * as model from "./editor-model";
import { calendarSlots } from "./slots";
import { MiniMonth } from "./mini-month";
import type { PartStat } from "../engine";
import { TodoEditor } from "./todo-editor";
import { TaskCard } from "./task-card";
import * as taskActions from "../actions/tasks";
import { useScopeChoice } from "./scope-dialog";
import type { GridTarget } from "./grid-target";
import * as trashActions from "../actions/trash";
import { hostUi } from "@polaris/app-host/client";
import * as eventActions from "../actions/events";
import { ShortcutsDialog } from "./shortcuts-dialog";
import * as calendarActions from "../actions/calendars";
import { Sidebar, type SidebarActions } from "./sidebar";
import { EventCard, NewEventCard } from "./event-popover";
import { AnchoredPanel, useCardColor, useNow } from "./ui";
import * as preferenceActions from "../actions/preferences";
import { CalendarSearch, type SearchResult } from "./search";
import { AddCalendarMenu } from "./accounts/add-calendar-menu";
import { EventEditor, type EditorTarget } from "./event-editor";
import { useShortcuts, type ShortcutAction } from "./shortcuts";
import type { GridChange, GridMoment, GridRange } from "./grid-view";
import { DARK_SURFACE, gridEvents, type GridItem } from "./grid-events";
import { cacheKey, dropCached, unwrap, useCachedRead } from "./cached-read";
import { GridMenu, type GridMenuActions, type MenuTarget } from "./grid-menu";
import { CalendarDialog, type CalendarDialogTarget } from "./calendar-dialog";
import { NewTaskDialog, useTaskLists, type CreatedTask } from "./new-task-dialog";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CalendarSummary, OccurrenceView, RangeView, TaskItemView } from "../lib/wire";
import {
    DEFAULT_PREFERENCES,
    VIEWS,
    newEventMinutes,
    type CalendarPreferences,
    type CalendarViewName
} from "../lib/preferences";

const GridView = lazy(() => import("./grid-view"));

/** How often the window on screen is read again while the tab is in view. */
const REFRESH_MS = 120_000;

/** A press that opens the menu also ends a long-press selection; a selection
 *  reported this soon after the menu opened is that one, not a new one. */
const MENU_SETTLE_MS = 700;

/** The event copied last. Kept for the tab's life, so it survives moving
 *  between the calendar and its settings. */
let copiedEvent: OccurrenceView | null = null;

type Selected = { readonly id: string; readonly item: GridItem } | null;

type Popover =
    | {
          readonly kind: "event";
          readonly occurrence: OccurrenceView;
          readonly anchor: DOMRect | null;
      }
    | {
          readonly kind: "task";
          readonly task: TaskItemView;
          readonly anchor: DOMRect | null;
      }
    | {
          readonly kind: "new";
          readonly start: GridMoment;
          readonly end: GridMoment;
          readonly anchor: DOMRect | null;
          readonly summary: string;
          readonly calendarId: string;
      }
    | null;

async function readRange(
    span: { from: Date; to: Date },
    zone: string,
    signal: AbortSignal,
    failed: string
): Promise<RangeView> {
    const query = new URLSearchParams({
        from: span.from.toISOString(),
        to: span.to.toISOString(),
        zone,
        tasks: "1"
    });
    const response = await fetch(`/api/calendar/range?${query}`, { cache: "no-store", signal });
    if (!response.ok) throw new Error(failed);
    return (await response.json()) as RangeView;
}

/** The occurrence moved by what a drag did, for the optimistic draw. */
function shifted(
    occurrence: OccurrenceView,
    startDeltaMs: number,
    endDeltaMs: number
): OccurrenceView {
    const days = (ms: number) => Math.round(ms / 86_400_000);
    return {
        ...occurrence,
        start: new Date(new Date(occurrence.start).getTime() + startDeltaMs).toISOString(),
        end: new Date(new Date(occurrence.end).getTime() + endDeltaMs).toISOString(),
        startDate: occurrence.startDate
            ? time.addDays(occurrence.startDate, days(startDeltaMs))
            : null,
        endDate: occurrence.endDate ? time.addDays(occurrence.endDate, days(endDeltaMs)) : null
    };
}

function sameOccurrence(a: OccurrenceView, b: OccurrenceView): boolean {
    return a.objectId === b.objectId && a.recurrenceKey === b.recurrenceKey;
}

/** Where new events go: the chosen calendar if it still takes events, else the
 *  first of one's own that does. */
export function defaultCalendarId(
    calendars: readonly CalendarSummary[],
    preferences: CalendarPreferences
): string {
    const takes = (calendar: CalendarSummary) =>
        calendar.writable && calendar.components.includes("VEVENT");
    const chosen = calendars.find(
        (calendar) => calendar.id === preferences.defaultCalendarId && takes(calendar)
    );
    if (chosen) return chosen.id;
    const sorted = [...calendars].sort((a, b) => a.position - b.position);
    return (
        (
            sorted.find(
                (calendar) => calendar.reach === "owner" && takes(calendar) && !calendar.hidden
            ) ?? sorted.find(takes)
        )?.id ?? ""
    );
}

export function CalendarScreen({ path }: { path: string[] }) {
    const t = useCalendarT();
    const toast = useToast();
    const router = useRouter();
    const locale = hostUi.i18nProvider.useLocale();
    const format = hostUi.displayFormat.useDisplayFormat();
    const [confirm, confirmElement] = hostUi.confirmDialog.useConfirm();
    const [askScope, scopeElement] = useScopeChoice();
    const route = useMemo(() => time.parseCalendarPath(path), [path]);

    const preferencesRead = useCachedRead<CalendarPreferences>(
        cacheKey("preferences"),
        async () =>
            (await unwrap(() => preferenceActions.loadPreferencesAction(), t("screen.failed")))
                .preferences
    );
    const calendarsRead = useCachedRead<CalendarSummary[]>(
        cacheKey("calendars"),
        async () =>
            (await unwrap(() => calendarActions.listCalendarsAction(), t("screen.failed")))
                .calendars
    );
    const preferences = preferencesRead.data ?? DEFAULT_PREFERENCES;
    const calendars = calendarsRead.data;
    const zone = time.displayZone(preferences.timezone, format.preferences.timeZone);
    const firstDay = preferences.firstDay ?? format.weekStartsOn;
    const hour12 = format.preferences.clock === "12h";
    const now = useNow(60_000);
    const today = time.todayIn(zone, now);
    const surface = useCardColor(DARK_SURFACE);
    /** Bumped by "Today", so a time grid scrolls back to the red line. */
    const [nowSignal, setNowSignal] = useState(0);

    const [view, setView] = useState<CalendarViewName>(route.view ?? DEFAULT_PREFERENCES.view);
    const [anchor, setAnchor] = useState<string>(route.date ?? today);
    const viewChosen = useRef(route.view !== null);
    const [selected, setSelected] = useState<Selected>(null);
    const [popover, setPopover] = useState<Popover>(null);
    const [editor, setEditor] = useState<EditorTarget | null>(
        route.objectId ? { kind: "open", objectId: route.objectId, recurrenceKey: null } : null
    );
    const [todoId, setTodoId] = useState<string | null>(null);
    const [calendarDialog, setCalendarDialog] = useState<CalendarDialogTarget | null>(null);
    const [shareFor, setShareFor] = useState<{
        calendar: CalendarSummary;
        kind: "share" | "publish";
    } | null>(null);
    const [addOpen, setAddOpen] = useState(false);
    const [drawer, setDrawer] = useState(false);
    const [helpOpen, setHelpOpen] = useState(false);
    const [picker, setPicker] = useState<DOMRect | null>(null);
    const [searchSignal, setSearchSignal] = useState(0);
    const [creating, setCreating] = useState(false);
    const [tasks, setTasks] = useState<{ items: TaskItemView[] | null; error: string | null }>({
        items: null,
        error: null
    });
    const undo = useRef<{ run: () => Promise<void> } | null>(null);
    /** The range highlighted on the grid: a selection while its card is open,
     *  or what the menu was opened on. */
    const [selection, setSelection] = useState<GridRange | null>(null);
    const selectionRef = useRef<GridRange | null>(null);
    selectionRef.current = selection;
    const [menuOpen, setMenuOpen] = useState(false);
    const menuOpenedAt = useRef(0);
    /** Tasks lists are read the first time a menu could offer one. */
    const [menuUsed, setMenuUsed] = useState(false);
    const taskLists = useTaskLists(menuUsed);
    const [clipboard, setClipboard] = useState<OccurrenceView | null>(copiedEvent);
    const [taskAt, setTaskAt] = useState<GridMoment | null>(null);
    const [addTab, setAddTab] = useState<"subscribe" | "holidays">("subscribe");

    // The view the calendar was left on, once the settings have arrived - unless
    // the address named one.
    useEffect(() => {
        if (!viewChosen.current && preferencesRead.data) {
            viewChosen.current = true;
            setView(preferencesRead.data.view);
        }
    }, [preferencesRead.data]);

    const span = useMemo(
        () => time.viewWindow(view, anchor, firstDay, preferences.customDays),
        [view, anchor, firstDay, preferences.customDays]
    );
    const instants = useMemo(() => time.windowInstants(span, zone), [span, zone]);
    const rangeKey = cacheKey(
        "range",
        zone,
        instants.from.toISOString(),
        instants.to.toISOString()
    );
    const rangeRead = useCachedRead<RangeView>(rangeKey, (signal) =>
        readRange(instants, zone, signal, t("grid.loadFailed"))
    );
    const { refresh: refreshRange, replace: replaceRange } = rangeRead;

    // The address follows the view; an opened event keeps its own until closed.
    useEffect(() => {
        if (editor?.kind === "open" && window.location.pathname === time.eventPath(editor.objectId))
            return;
        const next = time.calendarPath(view, anchor);
        if (window.location.pathname !== next)
            window.history.replaceState(window.history.state, "", next);
    }, [view, anchor, editor]);

    // A highlighted range lasts while its new-event card or the menu is open.
    useEffect(() => {
        if (popover?.kind !== "new" && !menuOpen) setSelection(null);
    }, [popover, menuOpen]);

    // Read again when the tab comes back, and now and then while it is seen.
    useEffect(() => {
        const onVisible = () => {
            if (document.visibilityState === "visible") refreshRange();
        };
        const timer = setInterval(
            () => document.visibilityState === "visible" && refreshRange(),
            REFRESH_MS
        );
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [refreshRange]);

    const calendarsById = useMemo(
        () => new Map((calendars ?? []).map((calendar) => [calendar.id, calendar])),
        [calendars]
    );
    const events = useMemo(
        () =>
            gridEvents(rangeRead.data, {
                zone,
                locale,
                now,
                showDeclined: preferences.showDeclined,
                showTasks: preferences.showTasks,
                dimPast: preferences.dimPast,
                surface,
                calendars: calendarsById,
                t
            }),
        [
            rangeRead.data,
            zone,
            locale,
            now,
            preferences.showDeclined,
            preferences.showTasks,
            preferences.dimPast,
            surface,
            calendarsById,
            t
        ]
    );

    const failed = (title: string, caught: unknown) =>
        toast.show({
            key: `calendar-${title}`,
            title,
            body: caught instanceof Error ? caught.message : undefined
        });

    /** Everything that changes events makes every kept window stale. */
    const eventsChanged = useCallback(() => {
        dropCached("range");
        refreshRange();
    }, [refreshRange]);

    const savePreferences = useCallback(
        async (patch: Partial<CalendarPreferences>) => {
            const current = preferencesRead.data;
            if (!current) return;
            const changed = (Object.keys(patch) as (keyof CalendarPreferences)[]).some(
                (key) => JSON.stringify(patch[key]) !== JSON.stringify(current[key])
            );
            if (!changed) return;
            preferencesRead.replace({ ...current, ...patch });
            try {
                const answer = await unwrap(
                    () => preferenceActions.savePreferencesAction(patch),
                    t("screen.failed")
                );
                preferencesRead.replace(answer.preferences);
            } catch (caught) {
                preferencesRead.replace(current);
                failed(t("settingsPage.saveFailed"), caught);
            }
        },
        // `failed` only raises a note.
        [preferencesRead.data, preferencesRead.replace, t]
    );

    const chooseView = (next: CalendarViewName) => {
        viewChosen.current = true;
        setView(next);
        void savePreferences({ view: next });
    };
    const goToday = () => {
        setAnchor(today);
        setNowSignal((value) => value + 1);
    };
    const step = (direction: 1 | -1) =>
        setAnchor((current) => time.stepAnchor(view, current, direction, preferences.customDays));

    // --- Calendars -----------------------------------------------------------

    const changeCalendars = async (
        next: CalendarSummary[],
        call: () => Promise<{ ok: boolean }>,
        failure: string
    ) => {
        const previous = calendarsRead.data;
        if (!previous) return;
        calendarsRead.replace(next);
        try {
            await unwrap(
                call as () => Promise<{ ok: true } | { ok: false; error: string }>,
                t("screen.failed")
            );
        } catch (caught) {
            calendarsRead.replace(previous);
            failed(failure, caught);
        }
    };

    const loadTasks = useCallback(() => {
        unwrap(() => taskActions.unscheduledTasksAction(), t("screen.failed"))
            .then((answer) => setTasks({ items: answer.tasks, error: null }))
            .catch((caught: unknown) =>
                setTasks((previous) => ({
                    items: previous.items,
                    error: caught instanceof Error ? caught.message : String(caught)
                }))
            );
    }, [t]);

    const scheduleTask = async (taskId: string, at: GridMoment) => {
        const previous = tasks.items;
        setTasks((current) => ({
            ...current,
            items: current.items?.filter((task) => task.id !== taskId) ?? null
        }));
        try {
            await unwrap(
                () =>
                    taskActions.scheduleTaskAction({
                        taskId,
                        due: { at: at.at.toISOString(), timed: !at.allDay }
                    }),
                t("screen.failed")
            );
            toast.show({ key: "calendar-task-scheduled", title: t("tasksPanel.scheduled") });
            eventsChanged();
        } catch (caught) {
            setTasks((current) => ({ ...current, items: previous }));
            failed(t("tasksPanel.scheduleFailed"), caught);
        }
    };

    const removeCalendar = async (calendar: CalendarSummary) => {
        const previous = calendarsRead.data ?? [];
        const own = calendar.reach === "owner";
        const ok = await confirm({
            title: own
                ? t("sidebar.deleteTitle", { name: calendar.name })
                : t("sidebar.leaveTitle", { name: calendar.name }),
            description: own ? t("sidebar.deleteBody") : t("sidebar.leaveBody"),
            confirmLabel: own ? t("sidebar.delete") : t("sidebar.leave"),
            danger: true
        });
        if (!ok) return;
        calendarsRead.replace(previous.filter((entry) => entry.id !== calendar.id));
        const restore = async () => {
            calendarsRead.replace(previous);
            if (own)
                await unwrap(
                    () =>
                        trashActions.restoreTrashAction({
                            kind: "calendar",
                            id: calendar.id,
                            zone
                        }),
                    t("screen.failed")
                );
            calendarsRead.refresh();
            eventsChanged();
        };
        if (own) {
            try {
                await unwrap(
                    () => calendarActions.trashCalendarAction(calendar.id),
                    t("screen.failed")
                );
                eventsChanged();
            } catch (caught) {
                calendarsRead.replace(previous);
                failed(t("sidebar.deleteFailed"), caught);
                return;
            }
        } else {
            // Leaving cannot be taken back once done, so it waits out the note:
            // Undo in that time and nothing was ever sent.
            const timer = setTimeout(() => {
                unwrap(() => calendarActions.leaveCalendarAction(calendar.id), t("screen.failed"))
                    .then(() => eventsChanged())
                    .catch((caught: unknown) => {
                        calendarsRead.replace(previous);
                        failed(t("sidebar.leaveFailed"), caught);
                    });
            }, 8000);
            undo.current = {
                run: async () => {
                    clearTimeout(timer);
                    calendarsRead.replace(previous);
                }
            };
            toast.show({
                key: `calendar-removed-${calendar.id}`,
                title: t("sidebar.left", { name: calendar.name }),
                life: 8000,
                actions: [{ label: t("screen.undo"), run: async () => await runUndo() }]
            });
            return;
        }
        undo.current = { run: restore };
        toast.show({
            key: `calendar-removed-${calendar.id}`,
            title: t("sidebar.deleted", { name: calendar.name }),
            life: 8000,
            actions: [{ label: t("screen.undo"), run: async () => await runUndo() }]
        });
    };

    const runUndo = async (): Promise<string | null> => {
        const pending = undo.current;
        if (!pending) return null;
        undo.current = null;
        try {
            await pending.run();
            return null;
        } catch (caught) {
            return caught instanceof Error ? caught.message : t("screen.failed");
        }
    };

    const sidebarActions: SidebarActions = {
        onToggle: (calendar) => {
            const list = calendarsRead.data ?? [];
            void changeCalendars(
                list.map((entry) =>
                    entry.id === calendar.id ? { ...entry, hidden: !entry.hidden } : entry
                ),
                () => calendarActions.setDisplayAction(calendar.id, { hidden: !calendar.hidden }),
                t("sidebar.toggleFailed")
            );
        },
        onReorder: (ids) => {
            const list = calendarsRead.data ?? [];
            void changeCalendars(
                list.map((entry) => ({ ...entry, position: ids.indexOf(entry.id) })),
                () => calendarActions.reorderCalendarsAction(ids),
                t("sidebar.reorderFailed")
            );
        },
        onEdit: (calendar, focus) => setCalendarDialog({ kind: "edit", calendar, focus }),
        onColor: (calendar, color) => {
            const list = calendarsRead.data ?? [];
            if (calendar.color === color) return;
            void changeCalendars(
                list.map((entry) => (entry.id === calendar.id ? { ...entry, color } : entry)),
                () => calendarActions.setDisplayAction(calendar.id, { color }),
                t("sidebar.colorFailed")
            );
        },
        onPatch: (calendar, patch) => {
            const list = calendarsRead.data ?? [];
            void changeCalendars(
                list.map((entry) => (entry.id === calendar.id ? { ...entry, ...patch } : entry)),
                () => calendarActions.updateCalendarAction(calendar.id, patch),
                t("sidebar.patchFailed")
            );
        },
        onRemove: (calendar) => void removeCalendar(calendar),
        onShare: (calendar) => setShareFor({ calendar, kind: "share" }),
        onPublish: (calendar) => setShareFor({ calendar, kind: "publish" }),
        onNew: (withTasks) => setCalendarDialog({ kind: "new", withTasks }),
        onAddFrom: (tab) => {
            setAddTab(tab);
            setAddOpen(true);
            setDrawer(false);
        },
        onPickDay: (day) => {
            setAnchor(day);
            setDrawer(false);
        },
        onToggleSection: (section) => {
            const collapsed = preferences.collapsed.includes(section)
                ? preferences.collapsed.filter((entry) => entry !== section)
                : [...preferences.collapsed, section].slice(-20);
            void savePreferences({ collapsed });
        },
        onScheduleTask: (task, day) =>
            void scheduleTask(task.id, { at: time.dayStart(day, zone), day, allDay: true })
    };

    // --- Events --------------------------------------------------------------

    const openItem = (item: GridItem, id: string, anchorRect: DOMRect | null) => {
        setSelected({ id, item });
        if (item.kind === "task") {
            if (preferences.skipPopover) openTask(item.task);
            else setPopover({ kind: "task", task: item.task, anchor: anchorRect });
            return;
        }
        const occurrence = item.occurrence;
        if (preferences.skipPopover && !occurrence.busyOnly) openEditor(occurrence);
        else setPopover({ kind: "event", occurrence, anchor: anchorRect });
    };

    /** A task's own editor: the calendar's form for a calendar's task, Tasks for
     *  a Tasks task. */
    const openTask = (task: TaskItemView) => {
        setPopover(null);
        if (task.source === "tasks") router.push(`/tasks/t/${task.id}`);
        else setTodoId(task.id);
    };

    /** Tick a task off, or back, from its mark - drawn at once, put back if the
     *  change does not land. */
    const toggleTask = async (task: TaskItemView) => {
        const previous = rangeRead.data;
        const done = !task.done;
        const flipped = (entry: TaskItemView): TaskItemView =>
            entry.source === task.source && entry.id === task.id
                ? {
                      ...entry,
                      done,
                      statusType: done ? "done" : "open",
                      // A Tasks status is the space's to name; which one Tasks
                      // picks is read back with the window.
                      statusColor: entry.source === "tasks" ? null : entry.statusColor,
                      statusName: entry.source === "tasks" ? null : entry.statusName
                  }
                : entry;
        if (previous) replaceRange({ ...previous, tasks: previous.tasks.map(flipped) });
        setPopover((current) =>
            current?.kind === "task" ? { ...current, task: flipped(current.task) } : current
        );
        try {
            await unwrap(
                () =>
                    taskActions.setTaskDoneAction({ source: task.source, id: task.id, done, zone }),
                t("screen.failed")
            );
            eventsChanged();
        } catch (caught) {
            if (previous) replaceRange(previous);
            setPopover((current) =>
                current?.kind === "task" && current.task.id === task.id
                    ? { ...current, task }
                    : current
            );
            failed(t("todo.doneFailed"), caught);
        }
    };

    const duplicateTask = async (task: TaskItemView) => {
        setPopover(null);
        try {
            const answer = await unwrap(
                () => eventActions.duplicateEventAction({ objectId: task.id, zone }),
                t("screen.failed")
            );
            eventsChanged();
            setTodoId(answer.objectId);
        } catch (caught) {
            failed(t("todo.duplicateFailed"), caught);
        }
    };

    const deleteTask = async (task: TaskItemView) => {
        if (!task.editable || task.source !== "calendar") return;
        if (
            !(await confirm({
                title: t("todo.deleteTitle"),
                description: t("todo.deleteBody", { title: task.title || t("screen.untitled") }),
                confirmLabel: t("screen.delete"),
                danger: true
            }))
        )
            return;
        setPopover(null);
        const previous = rangeRead.data;
        if (previous)
            replaceRange({
                ...previous,
                tasks: previous.tasks.filter(
                    (entry) => !(entry.source === "calendar" && entry.id === task.id)
                )
            });
        try {
            await unwrap(
                () =>
                    eventActions.deleteEventAction({
                        objectId: task.id,
                        recurrenceKey: null,
                        scope: "all",
                        zone
                    }),
                t("screen.failed")
            );
            undo.current = {
                run: async () => {
                    await unwrap(
                        () => trashActions.restoreTrashAction({ kind: "event", id: task.id, zone }),
                        t("screen.failed")
                    );
                    eventsChanged();
                }
            };
            toast.show({
                key: "calendar-deleted-task",
                title: t("todo.deleted"),
                life: 8000,
                actions: [{ label: t("screen.undo"), run: async () => await runUndo() }]
            });
            setSelected(null);
            eventsChanged();
        } catch (caught) {
            if (previous) replaceRange(previous);
            failed(t("todo.deleteFailed"), caught);
        }
    };

    const openEditor = (occurrence: OccurrenceView) => {
        setPopover(null);
        setEditor({
            kind: "open",
            objectId: occurrence.objectId,
            recurrenceKey: occurrence.recurring ? occurrence.recurrenceKey : null
        });
    };

    const newFormFor = (
        start: GridMoment,
        end: GridMoment,
        summary: string,
        calendarId: string
    ) => {
        const calendar = calendars?.find((entry) => entry.id === calendarId) ?? null;
        return model.newForm({
            calendarId,
            zone,
            allDay: start.allDay,
            start: start.allDay ? start.day : start.at,
            end: end.allDay ? end.day : end.at,
            summary,
            alarms: model.defaultAlarmMinutes(start.allDay, calendar, preferences)
        });
    };

    // `/calendar/new/<when>`: the Time area's meeting planner handing over a
    // time. Opened once, when the calendars and settings it needs are here.
    const newAtOpened = useRef(false);
    useEffect(() => {
        const at = route.newAt;
        if (!at || newAtOpened.current || !calendars || !preferencesRead.data) return;
        newAtOpened.current = true;
        const finish = new Date(at.getTime() + newEventMinutes(preferences) * 60_000);
        setAnchor(time.todayIn(zone, at));
        setEditor({
            kind: "new",
            form: newFormFor(
                { at, day: time.todayIn(zone, at), allDay: false },
                { at: finish, day: time.todayIn(zone, finish), allDay: false },
                "",
                defaultCalendarId(calendars, preferences)
            )
        });
        // Reading `newFormFor` and the settings at the moment the data lands is
        // the point; later changes must not open a second editor.
    }, [route.newAt, calendars, preferencesRead.data]);

    const startCreate = (start: GridMoment, end: GridMoment, anchorRect: DOMRect | null) => {
        const calendarId = defaultCalendarId(calendars ?? [], preferences);
        // A click on a slot selects one slot; a new event takes the usual length.
        const minimal =
            !start.allDay &&
            end.at.getTime() - start.at.getTime() <= preferences.slotMinutes * 60_000;
        const finish = minimal
            ? { ...end, at: new Date(start.at.getTime() + newEventMinutes(preferences) * 60_000) }
            : end;
        if (preferences.skipPopover) {
            setEditor({ kind: "new", form: newFormFor(start, finish, "", calendarId) });
            return;
        }
        // The grid shows the time the card is about while it is open.
        setSelection({ start, end: finish });
        setPopover({
            kind: "new",
            start,
            end: finish,
            anchor: anchorRect,
            summary: "",
            calendarId
        });
    };

    const createFromCard = async () => {
        if (popover?.kind !== "new" || creating) return;
        const form = newFormFor(popover.start, popover.end, popover.summary, popover.calendarId);
        const check = model.checkForm(form);
        if (!check.input) {
            setEditor({ kind: "new", form });
            setPopover(null);
            return;
        }
        setCreating(true);
        const previous = rangeRead.data;
        try {
            await unwrap(
                () =>
                    eventActions.saveEventAction({
                        objectId: null,
                        recurrenceKey: null,
                        scope: "all",
                        version: null,
                        zone,
                        event: model.inputOf(form)
                    }),
                t("screen.failed")
            );
            setPopover(null);
            toast.show({ key: "calendar-created-event", title: t("editor.created") });
            eventsChanged();
        } catch (caught) {
            if (previous) replaceRange(previous);
            failed(t("editor.saveFailed"), caught);
        } finally {
            setCreating(false);
        }
    };

    const deleteOccurrence = async (occurrence: OccurrenceView) => {
        if (!occurrence.editable) return;
        let scope: "this" | "following" | "all" = "all";
        if (occurrence.recurring) {
            const answer = await askScope({ action: "delete" });
            if (!answer) return;
            scope = answer;
        } else if (
            !(await confirm({
                title: t("editor.deleteTitle"),
                description: t("editor.deleteBody", {
                    title: occurrence.summary || t("screen.untitled")
                }),
                confirmLabel: t("screen.delete"),
                danger: true
            }))
        ) {
            return;
        }
        setPopover(null);
        const previous = rangeRead.data;
        if (previous)
            replaceRange({
                ...previous,
                occurrences: previous.occurrences.filter((entry) =>
                    scope === "this"
                        ? !sameOccurrence(entry, occurrence)
                        : entry.objectId !== occurrence.objectId ||
                          (scope === "following" && entry.start < occurrence.start)
                )
            });
        try {
            await unwrap(
                () =>
                    eventActions.deleteEventAction({
                        objectId: occurrence.objectId,
                        recurrenceKey: occurrence.recurring ? occurrence.recurrenceKey : null,
                        scope,
                        zone
                    }),
                t("screen.failed")
            );
            if (scope === "all") {
                undo.current = {
                    run: async () => {
                        await unwrap(
                            () =>
                                trashActions.restoreTrashAction({
                                    kind: "event",
                                    id: occurrence.objectId,
                                    zone
                                }),
                            t("screen.failed")
                        );
                        eventsChanged();
                    }
                };
                toast.show({
                    key: "calendar-deleted-event",
                    title: t("editor.deleted"),
                    life: 8000,
                    actions: [{ label: t("screen.undo"), run: async () => await runUndo() }]
                });
            } else {
                toast.show({ key: "calendar-deleted-event", title: t("editor.deleted") });
            }
            setSelected(null);
            eventsChanged();
        } catch (caught) {
            if (previous) replaceRange(previous);
            failed(t("editor.deleteFailed"), caught);
        }
    };

    const duplicateOccurrence = async (occurrence: OccurrenceView) => {
        setPopover(null);
        try {
            const answer = await unwrap(
                () => eventActions.duplicateEventAction({ objectId: occurrence.objectId, zone }),
                t("screen.failed")
            );
            eventsChanged();
            setEditor({ kind: "open", objectId: answer.objectId, recurrenceKey: null });
        } catch (caught) {
            failed(t("editor.duplicateFailed"), caught);
        }
    };

    const applyChange = async (change: GridChange) => {
        if (
            change.item.kind !== "event" ||
            (change.startDeltaMs === 0 && change.endDeltaMs === 0)
        ) {
            change.revert();
            return;
        }
        const occurrence = change.item.occurrence;
        let scope: "this" | "following" | "all" = "all";
        if (occurrence.recurring) {
            const answer = await askScope({ action: "move" });
            if (!answer) {
                change.revert();
                return;
            }
            scope = answer;
        }
        const previous = rangeRead.data;
        if (previous)
            replaceRange({
                ...previous,
                occurrences: previous.occurrences.map((entry) =>
                    sameOccurrence(entry, occurrence)
                        ? shifted(entry, change.startDeltaMs, change.endDeltaMs)
                        : entry
                )
            });
        const shift = (startDeltaMs: number, endDeltaMs: number, recurrenceKey: string | null) =>
            unwrap(
                () =>
                    eventActions.shiftEventAction({
                        objectId: occurrence.objectId,
                        recurrenceKey,
                        startDeltaMs,
                        endDeltaMs,
                        scope,
                        version: null,
                        zone
                    }),
                t("screen.failed")
            );
        try {
            await shift(
                change.startDeltaMs,
                change.endDeltaMs,
                occurrence.recurring ? occurrence.recurrenceKey : null
            );
            undo.current = {
                // The occurrence's own key is unchanged by a move: it names the original start.
                run: async () => {
                    await shift(
                        -change.startDeltaMs,
                        -change.endDeltaMs,
                        occurrence.recurring ? occurrence.recurrenceKey : null
                    );
                    eventsChanged();
                }
            };
            toast.show({
                key: "calendar-moved",
                title: t("grid.moved"),
                actions: [{ label: t("screen.undo"), run: async () => await runUndo() }]
            });
            eventsChanged();
        } catch (caught) {
            if (previous) replaceRange(previous);
            change.revert();
            failed(t("grid.moveFailed"), caught);
        }
    };

    /** Where a new event on a day starts when nobody said a time: the next
     *  hour today, nine o'clock on any other day. */
    const defaultStart = (day: string): GridMoment => {
        const wall = time.wallOf(now, zone);
        const hour = day === today ? Math.min(23, Number(wall.slice(11, 13)) + 1) : 9;
        const at = time.gridInstant(
            new Date(`${day}T${String(hour).padStart(2, "0")}:00:00Z`),
            zone
        );
        return { at, day, allDay: false };
    };

    const createNow = () => {
        const start = defaultStart(anchor);
        startCreate(
            start,
            {
                at: new Date(start.at.getTime() + newEventMinutes(preferences) * 60_000),
                day: anchor,
                allDay: false
            },
            null
        );
    };

    // --- The grid's menu -----------------------------------------------------

    /** A whole day, as a range of the grid. */
    const dayRange = (day: string): GridRange => ({
        start: { at: time.dayStart(day, zone), day, allDay: true },
        end: {
            at: time.dayStart(time.addDays(day, 1), zone),
            day: time.addDays(day, 1),
            allDay: true
        }
    });

    /** What a range reads as at the top of the menu. */
    const rangeLabel = (range: GridRange): string => {
        if (range.start.allDay) {
            const last = time.addDays(range.end.day, -1);
            return last > range.start.day
                ? new Intl.DateTimeFormat(locale, {
                      dateStyle: "medium",
                      timeZone: "UTC"
                  }).formatRange(time.dayDate(range.start.day), time.dayDate(last))
                : time.formatDay(range.start.day, locale, { dateStyle: "full" });
        }
        const slot =
            range.end.at.getTime() - range.start.at.getTime() <= preferences.slotMinutes * 60_000;
        return slot
            ? time.formatInstant(range.start.at, locale, zone, {
                  dateStyle: "full",
                  timeStyle: "short"
              })
            : new Intl.DateTimeFormat(locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone: zone
              }).formatRange(range.start.at, range.end.at);
    };

    /** What a press on the grid stands for, for its menu. */
    const resolveTarget = (
        target: GridTarget,
        point: DOMRect,
        held: GridRange | null
    ): MenuTarget | null => {
        if (target.kind === "item") {
            const found = events.find((event) => event.id === target.id);
            const item = (found?.extendedProps as { item?: GridItem } | undefined)?.item;
            if (!item) return null;
            if (item.kind === "task") {
                const day = item.task.due ? time.wallOf(item.task.due, zone).slice(0, 10) : null;
                return { kind: "task", id: target.id, task: item.task, day, rect: point };
            }
            return { kind: "event", id: target.id, occurrence: item.occurrence, rect: point };
        }
        const pressed: GridRange = target.allDay
            ? dayRange(target.day)
            : (() => {
                  const start = target.time
                      ? {
                            at: time.gridInstant(
                                new Date(`${target.day}T${target.time}:00Z`),
                                zone
                            ),
                            day: target.day,
                            allDay: false
                        }
                      : defaultStart(target.day);
                  return {
                      start,
                      end: {
                          at: new Date(start.at.getTime() + preferences.slotMinutes * 60_000),
                          day: target.day,
                          allDay: false
                      }
                  };
              })();
        // A range selected first, and pressed inside, is what the menu is about.
        const inside =
            held !== null &&
            held.start.allDay === pressed.start.allDay &&
            pressed.start.at.getTime() >= held.start.at.getTime() &&
            pressed.start.at.getTime() < held.end.at.getTime();
        const range = inside ? held : pressed;
        return {
            kind: "slot",
            range,
            day: target.day,
            selected: inside,
            when: rangeLabel(range),
            point
        };
    };

    /** Write a copied occurrence at a moment: the same length, the same kind. */
    const pasteAt = async (at: GridMoment) => {
        const source = clipboard;
        if (!source) return;
        let start: { date: string } | { dateTime: string; tzid: string };
        let end: { date: string } | { dateTime: string; tzid: string };
        if (source.allDay && source.startDate) {
            const days = Math.max(
                1,
                time.daysBetween(
                    source.startDate,
                    source.endDate ?? time.addDays(source.startDate, 1)
                )
            );
            start = { date: at.day };
            end = { date: time.addDays(at.day, days) };
        } else {
            // A day without a time keeps the copied event's time of day.
            const clock = at.allDay ? time.wallOf(source.start, zone).slice(11, 16) : null;
            const startAt = clock
                ? time.gridInstant(new Date(`${at.day}T${clock}:00Z`), zone)
                : at.at;
            const length = new Date(source.end).getTime() - new Date(source.start).getTime();
            start = { dateTime: time.wallOf(startAt, zone).slice(0, 19), tzid: zone };
            end = {
                dateTime: time
                    .wallOf(new Date(startAt.getTime() + Math.max(length, 60_000)), zone)
                    .slice(0, 19),
                tzid: zone
            };
        }
        const own = calendarsById.get(source.calendarId);
        const calendarId =
            own && own.writable && own.components.includes("VEVENT") && !own.hidden
                ? own.id
                : defaultCalendarId(calendars ?? [], preferences);
        if (!calendarId) {
            failed(t("gridMenu.pasteFailed"), new Error(t("popover.noWritable")));
            return;
        }
        try {
            const answer = await unwrap(
                () =>
                    eventActions.pasteEventAction({
                        objectId: source.objectId,
                        recurrenceKey: source.recurring ? source.recurrenceKey : null,
                        calendarId,
                        start,
                        end,
                        zone
                    }),
                t("screen.failed")
            );
            undo.current = {
                run: async () => {
                    await unwrap(
                        () =>
                            eventActions.deleteEventAction({
                                objectId: answer.objectId,
                                recurrenceKey: null,
                                scope: "all",
                                zone
                            }),
                        t("screen.failed")
                    );
                    eventsChanged();
                }
            };
            toast.show({
                key: "calendar-pasted",
                title: t("gridMenu.pasted"),
                actions: [{ label: t("screen.undo"), run: async () => await runUndo() }]
            });
            eventsChanged();
        } catch (caught) {
            failed(t("gridMenu.pasteFailed"), caught);
        }
    };

    const copyOccurrence = (occurrence: OccurrenceView) => {
        copiedEvent = occurrence;
        setClipboard(occurrence);
        toast.show({ key: "calendar-copied", title: t("gridMenu.copied") });
    };

    /** Change what the grid shows of one event at once, put back on failure. */
    const changeShown = async (
        objectId: string,
        change: (occurrence: OccurrenceView) => OccurrenceView,
        call: () => Promise<{ ok: boolean }>,
        failure: string,
        only?: OccurrenceView
    ) => {
        const previous = rangeRead.data;
        if (previous)
            replaceRange({
                ...previous,
                occurrences: previous.occurrences.map((entry) =>
                    entry.objectId === objectId && (!only || sameOccurrence(entry, only))
                        ? change(entry)
                        : entry
                )
            });
        try {
            await unwrap(
                call as () => Promise<{ ok: true } | { ok: false; error: string }>,
                t("screen.failed")
            );
            eventsChanged();
            return true;
        } catch (caught) {
            if (previous) replaceRange(previous);
            failed(failure, caught);
            return false;
        }
    };

    const moveOccurrence = async (occurrence: OccurrenceView, calendarId: string) => {
        const target = calendarsById.get(calendarId);
        const moved = await changeShown(
            occurrence.objectId,
            (entry) => ({ ...entry, calendarId }),
            () => eventActions.moveEventAction({ objectId: occurrence.objectId, calendarId, zone }),
            t("grid.moveFailed")
        );
        if (!moved) return;
        undo.current = {
            run: async () => {
                await unwrap(
                    () =>
                        eventActions.moveEventAction({
                            objectId: occurrence.objectId,
                            calendarId: occurrence.calendarId,
                            zone
                        }),
                    t("screen.failed")
                );
                eventsChanged();
            }
        };
        toast.show({
            key: "calendar-moved-to",
            title: t("gridMenu.movedTo", { name: target?.name ?? "" }),
            actions: [{ label: t("screen.undo"), run: async () => await runUndo() }]
        });
    };

    const colorOccurrence = (occurrence: OccurrenceView, color: string | null) => {
        if (occurrence.color === color) return;
        void changeShown(
            occurrence.objectId,
            (entry) => ({ ...entry, color }),
            () => eventActions.setEventColorAction({ objectId: occurrence.objectId, color, zone }),
            t("sidebar.colorFailed")
        );
    };

    const respondTo = (occurrence: OccurrenceView, partstat: PartStat) => {
        if (occurrence.myPartstat === partstat) return;
        void changeShown(
            occurrence.objectId,
            (entry) => ({ ...entry, myPartstat: partstat }),
            () =>
                eventActions.respondToEventAction({
                    objectId: occurrence.objectId,
                    recurrenceKey: occurrence.recurring ? occurrence.recurrenceKey : null,
                    partstat,
                    zone
                }),
            t("respond.failed"),
            occurrence.recurring ? occurrence : undefined
        );
    };

    const menuActions: GridMenuActions = {
        newEvent: (range, anchorRect) => startCreate(range.start, range.end, anchorRect),
        newAllDay: (day, anchorRect) => {
            const range = dayRange(day);
            startCreate(range.start, range.end, anchorRect);
        },
        newTask: (at) => setTaskAt(at),
        paste: (at) => void pasteAt(at),
        goToDay: (day) => {
            setAnchor(day);
            chooseView("day");
        },
        openItem: (item, id, anchorRect) => openItem(item, id, anchorRect),
        edit: (occurrence) => openEditor(occurrence),
        duplicate: (occurrence) => void duplicateOccurrence(occurrence),
        copy: copyOccurrence,
        move: (occurrence, calendarId) => void moveOccurrence(occurrence, calendarId),
        color: colorOccurrence,
        respond: respondTo,
        remove: (occurrence) => void deleteOccurrence(occurrence)
    };

    // Ctrl/Cmd+C on the selected event, when no text is selected to copy instead.
    const copyRef = useRef({ selected, copyOccurrence });
    copyRef.current = { selected, copyOccurrence };
    useEffect(() => {
        const listener = (event: KeyboardEvent) => {
            if (!(event.ctrlKey || event.metaKey) || event.altKey || event.defaultPrevented) return;
            if (event.key.toLowerCase() !== "c") return;
            const { selected, copyOccurrence } = copyRef.current;
            const item = selected?.item;
            if (item?.kind !== "event" || item.occurrence.busyOnly) return;
            const target = event.target as HTMLElement | null;
            if (target?.closest?.("input, textarea, [contenteditable='true'], [role='dialog']"))
                return;
            if (window.getSelection()?.toString()) return;
            event.preventDefault();
            copyOccurrence(item.occurrence);
        };
        document.addEventListener("keydown", listener);
        return () => document.removeEventListener("keydown", listener);
    }, []);

    const openSearchResult = (result: SearchResult) => {
        if (result.day && (result.day < span.start || result.day >= span.end))
            setAnchor(result.day);
        setEditor({ kind: "open", objectId: result.objectId, recurrenceKey: result.recurrenceKey });
    };

    useShortcuts(preferences.keyboardShortcuts, (action: ShortcutAction) => {
        switch (action.kind) {
            case "previous":
                step(-1);
                return true;
            case "next":
                step(1);
                return true;
            case "today":
                goToday();
                return true;
            case "goTo":
                setPicker(
                    document.getElementById("calendar-heading")?.getBoundingClientRect() ?? null
                );
                return true;
            case "view":
                chooseView(action.view);
                return true;
            case "create":
                createNow();
                return true;
            case "open":
                if (selected?.item.kind === "event") openEditor(selected.item.occurrence);
                else if (selected?.item.kind === "task") openItem(selected.item, selected.id, null);
                return selected !== null;
            case "delete":
                if (selected?.item.kind !== "event") return false;
                void deleteOccurrence(selected.item.occurrence);
                return true;
            case "undo":
                if (!undo.current) return false;
                void runUndo();
                return true;
            case "search":
                setSearchSignal((value) => value + 1);
                return true;
            case "refresh":
                calendarsRead.refresh();
                eventsChanged();
                return true;
            case "settings":
                router.push("/calendar/settings");
                return true;
            case "addCalendar":
                setCalendarDialog({ kind: "new", withTasks: false });
                return true;
            case "help":
                setHelpOpen(true);
                return true;
            case "close":
                if (selected) {
                    setSelected(null);
                    return true;
                }
                return false;
        }
    });

    const label = time.windowLabel(view, anchor, span, locale);
    const todayShown = time.showsToday(view, anchor, span, today);
    const viewOptions = VIEWS.map((entry) => ({
        value: entry,
        label: t(`views.${entry}`, { count: preferences.customDays })
    }));
    const colorOf = useCallback(
        (calendarId: string, own: string | null) =>
            own ?? calendarsById.get(calendarId)?.color ?? "#7f7f7f",
        [calendarsById]
    );
    const businessHours = useMemo(
        () =>
            Object.entries(preferences.workingHours).flatMap(([day, spans]) =>
                (spans ?? []).map((span) => ({
                    daysOfWeek: [Number(day)],
                    startTime: span.from,
                    endTime: span.to
                }))
            ),
        [preferences.workingHours]
    );
    const ShareCalendar = calendarSlots.ShareCalendar;
    const PublishCalendar = calendarSlots.PublishCalendar;
    const AddCalendars = calendarSlots.AddCalendars;
    const newCard = popover?.kind === "new" ? popover : null;

    /** A task was made from the calendar: say so with a way to it, or go there. */
    const taskCreated = (created: CreatedTask, open: boolean) => {
        setPopover(null);
        eventsChanged();
        if (open) {
            router.push(`/tasks/t/${created.taskId}`);
            return;
        }
        toast.show({
            key: "calendar-task-created",
            title: t("newTask.created", { reference: created.reference }),
            actions: [
                {
                    label: t("newTask.open"),
                    run: async () => {
                        router.push(`/tasks/t/${created.taskId}`);
                        return null;
                    }
                }
            ]
        });
    };

    /** A new booking page for what the card picked: its title, its day and,
     *  when a time was picked within one day, those hours. */
    const bookingFor = (card: NonNullable<typeof newCard>): string => {
        const query = new URLSearchParams();
        if (card.summary.trim()) query.set("title", card.summary.trim());
        query.set("day", card.start.day);
        if (!card.start.allDay) {
            const from = time.wallOf(card.start.at, zone);
            const to = time.wallOf(card.end.at, zone);
            if (from.slice(0, 10) === to.slice(0, 10)) {
                query.set("from", time.timeOfWall(from));
                query.set("to", time.timeOfWall(to));
            }
        }
        return `/calendar/booking/new?${query.toString()}`;
    };

    const sidebar = (
        <Sidebar
            calendars={calendars}
            calendarsError={calendarsRead.error}
            onRetry={calendarsRead.refresh}
            preferences={preferences}
            anchor={anchor}
            today={today}
            shown={span}
            firstDay={firstDay}
            locale={locale}
            zone={zone}
            tasks={{ items: tasks.items, error: tasks.error, load: loadTasks }}
            actions={sidebarActions}
        />
    );

    return (
        <div data-cal-ready className="flex h-full min-h-0 flex-col">
            <header className="flex flex-wrap items-center gap-1.5 border-b border-border bg-surface px-3 py-2 sm:gap-2">
                {/* Wide enough for the range it names: on a phone the controls
                    wrap below it rather than squeezing it out of sight. */}
                <div className="flex min-w-0 flex-1 basis-60 items-center gap-1">
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        className="lg:hidden"
                        aria-label={t("header.calendars")}
                        title={t("header.calendars")}
                        onClick={() => setDrawer(true)}
                    >
                        <Menu />
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        aria-label={t("header.today")}
                        aria-disabled={todayShown || undefined}
                        title={
                            todayShown
                                ? t("header.todayShown")
                                : t("header.todayHint", {
                                      day: time.formatDay(today, locale, { dateStyle: "full" })
                                  })
                        }
                        className={todayShown ? "opacity-50" : undefined}
                        onClick={() => {
                            if (!todayShown) goToday();
                        }}
                    >
                        <CalendarCheck className="sm:hidden" />
                        <span className="hidden sm:inline">{t("header.today")}</span>
                    </Button>
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("header.previous")}
                        title={t("header.previous")}
                        onClick={() => step(-1)}
                    >
                        <ChevronLeft />
                    </Button>
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("header.next")}
                        title={t("header.next")}
                        onClick={() => step(1)}
                    >
                        <ChevronRight />
                    </Button>
                    <h1 className="min-w-0 truncate text-[17px] font-semibold tracking-tight first-letter:uppercase tabular-nums">
                        <button
                            id="calendar-heading"
                            type="button"
                            className="max-w-full truncate rounded px-1 text-left"
                            aria-label={t("header.goTo", { label })}
                            title={t("header.goTo", { label })}
                            onClick={(event) =>
                                setPicker(event.currentTarget.getBoundingClientRect())
                            }
                        >
                            {label}
                        </button>
                    </h1>
                    {rangeRead.loading ? (
                        <Loader2
                            aria-label={t("grid.loading")}
                            className="size-4 animate-spin text-foreground-subtle"
                        />
                    ) : null}
                </div>
                <div className="flex items-center gap-1.5">
                    <CalendarSearch
                        occurrences={rangeRead.data?.occurrences ?? []}
                        colorOf={colorOf}
                        zone={zone}
                        locale={locale}
                        focusSignal={searchSignal}
                        onOpen={openSearchResult}
                    />
                    <SegmentedControl
                        className="hidden xl:flex"
                        size="sm"
                        aria-label={t("header.view")}
                        value={view}
                        onValueChange={chooseView}
                        options={viewOptions}
                    />
                    <Select
                        className="h-7 w-28 xl:hidden"
                        aria-label={t("header.view")}
                        value={view}
                        onValueChange={(next) => chooseView(next as CalendarViewName)}
                        options={viewOptions}
                    />
                    <Button
                        size="sm"
                        aria-label={t("header.newEvent")}
                        title={t("header.newEvent")}
                        onClick={createNow}
                    >
                        <Plus />
                        <span className="hidden sm:inline">{t("header.newEvent")}</span>
                    </Button>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                size="icon-sm"
                                variant="ghost"
                                aria-label={t("header.more")}
                                title={t("header.more")}
                            >
                                <MoreVertical />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem
                                onSelect={() => {
                                    calendarsRead.refresh();
                                    eventsChanged();
                                }}
                            >
                                <RefreshCw />
                                {t("header.refresh")}
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                                <Link href={`/calendar/print?view=${view}&date=${anchor}`}>
                                    <Printer />
                                    {t("header.print")}
                                </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                                <Link href="/calendar/trash">
                                    <Trash2 />
                                    {t("header.trash")}
                                </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => setHelpOpen(true)}>
                                <Keyboard />
                                {t("header.shortcuts")}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                    <Button asChild size="icon-sm" variant="ghost">
                        <Link
                            href="/calendar/time"
                            aria-label={t("header.time")}
                            title={t("header.time")}
                        >
                            <AlarmClock />
                        </Link>
                    </Button>
                    <Button asChild size="icon-sm" variant="ghost">
                        <Link
                            href="/calendar/settings"
                            aria-label={t("header.settings")}
                            title={t("header.settings")}
                        >
                            <Settings />
                        </Link>
                    </Button>
                </div>
            </header>

            <div className="flex min-h-0 flex-1">
                <aside
                    aria-label={t("header.calendars")}
                    className="hidden w-64 shrink-0 overflow-y-auto overscroll-contain border-r border-border bg-surface lg:block"
                >
                    {sidebar}
                </aside>
                <main className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-card">
                    {rangeRead.error ? (
                        <div
                            role="alert"
                            className="flex items-center gap-2 border-b border-border bg-warning-soft px-3 py-1.5 text-xs text-warning-ink"
                        >
                            <span className="min-w-0 flex-1">{t("grid.loadFailed")}</span>
                            <Button size="xs" variant="outline" onClick={refreshRange}>
                                {t("screen.retry")}
                            </Button>
                        </div>
                    ) : rangeRead.stale ? (
                        <p
                            role="status"
                            className="border-b border-border px-3 py-1 text-xs text-muted-foreground"
                        >
                            {t("grid.stale")}
                        </p>
                    ) : null}
                    {rangeRead.data && rangeRead.data.unreadable > 0 ? (
                        <p
                            role="status"
                            className="border-b border-border px-3 py-1 text-xs text-muted-foreground"
                        >
                            {t("grid.unreadable", { count: rangeRead.data.unreadable })}
                        </p>
                    ) : null}
                    {rangeRead.data?.truncated ? (
                        <p
                            role="status"
                            className="border-b border-border px-3 py-1 text-xs text-muted-foreground"
                        >
                            {t("grid.truncated")}
                        </p>
                    ) : null}
                    {calendars &&
                    calendars.length > 0 &&
                    preferencesRead.data &&
                    !preferences.dismissedHints.includes("link-accounts") &&
                    !calendars.some((calendar) => calendar.source !== null) ? (
                        <div
                            role="note"
                            className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-1.5 text-xs"
                        >
                            <span className="min-w-0 flex-1 text-muted-foreground">
                                {t("linkHint.text")}
                            </span>
                            <AddCalendarMenu
                                align="end"
                                onCreate={(withTasks) =>
                                    setCalendarDialog({ kind: "new", withTasks })
                                }
                                onAddFrom={AddCalendars ? sidebarActions.onAddFrom : null}
                            >
                                <Button size="xs" variant="outline">
                                    <Plus />
                                    {t("sidebar.add")}
                                </Button>
                            </AddCalendarMenu>
                            <Button
                                size="icon-xs"
                                variant="ghost"
                                aria-label={t("linkHint.dismiss")}
                                title={t("linkHint.dismiss")}
                                onClick={() =>
                                    void savePreferences({
                                        dismissedHints: [
                                            ...preferences.dismissedHints,
                                            "link-accounts"
                                        ]
                                    })
                                }
                            >
                                <X />
                            </Button>
                        </div>
                    ) : null}
                    {calendars && calendars.length === 0 ? (
                        <EmptyState
                            className="m-4"
                            title={t("grid.noCalendars")}
                            description={t("grid.noCalendarsHint")}
                            action={
                                <div className="flex flex-wrap justify-center gap-2">
                                    <Button
                                        size="sm"
                                        onClick={() =>
                                            setCalendarDialog({ kind: "new", withTasks: false })
                                        }
                                    >
                                        <Plus />
                                        {t("sidebar.newCalendar")}
                                    </Button>
                                    <AddCalendarMenu
                                        onCreate={(withTasks) =>
                                            setCalendarDialog({ kind: "new", withTasks })
                                        }
                                        onAddFrom={AddCalendars ? sidebarActions.onAddFrom : null}
                                    >
                                        <Button size="sm" variant="outline">
                                            {t("sidebar.add")}
                                        </Button>
                                    </AddCalendarMenu>
                                </div>
                            }
                        />
                    ) : (
                        <div className="min-h-0 flex-1">
                            <GridMenu
                                resolve={resolveTarget}
                                heldRange={() => selectionRef.current}
                                onOpenChange={(open, target) => {
                                    setMenuOpen(open);
                                    if (!open) return;
                                    menuOpenedAt.current = Date.now();
                                    setMenuUsed(true);
                                    // What the menu is about stays highlighted while it is open.
                                    setSelection(target?.kind === "slot" ? target.range : null);
                                    // A card open on something else is done with.
                                    setPopover(null);
                                }}
                                calendars={calendars ?? []}
                                clipboard={clipboard}
                                taskLists={taskLists.lists}
                                showsOnlyDay={(day) => view === "day" && anchor === day}
                                actions={menuActions}
                            >
                                <Suspense fallback={<GridSkeleton />}>
                                    <GridView
                                        view={view}
                                        anchor={anchor}
                                        customDays={preferences.customDays}
                                        zone={zone}
                                        secondaryZone={preferences.secondaryTimezone}
                                        locale={locale}
                                        hour12={hour12}
                                        firstDay={firstDay}
                                        showWeekends={preferences.showWeekends}
                                        showWeekNumbers={preferences.showWeekNumbers}
                                        now={now}
                                        dimPast={preferences.dimPast}
                                        scrollToNowSignal={nowSignal}
                                        slotMinutes={preferences.slotMinutes}
                                        dayStart={preferences.dayStart}
                                        eventLimit={preferences.eventLimit}
                                        businessHours={businessHours}
                                        events={events}
                                        selectedId={selected?.id ?? null}
                                        selection={selection}
                                        words={{
                                            allDay: t("grid.allDay"),
                                            noEvents: t("grid.noEvents"),
                                            week: t("grid.week"),
                                            more: (count) => t("grid.more", { count }),
                                            secondaryZone: t("grid.secondaryZone", {
                                                zone: preferences.secondaryTimezone ?? ""
                                            }),
                                            day: (day) =>
                                                time.formatDay(day, locale, { dateStyle: "full" })
                                        }}
                                        onSelectRange={(range, anchorRect) => {
                                            if (
                                                menuOpen ||
                                                Date.now() - menuOpenedAt.current < MENU_SETTLE_MS
                                            )
                                                return false;
                                            startCreate(range.start, range.end, anchorRect);
                                            return true;
                                        }}
                                        onItemClick={(item, id, anchorRect) =>
                                            openItem(item, id, anchorRect)
                                        }
                                        onTaskToggle={(task) => void toggleTask(task)}
                                        onItemFocus={(id) => {
                                            const found = events.find((event) => event.id === id);
                                            if (found)
                                                setSelected({
                                                    id,
                                                    item: (
                                                        found.extendedProps as { item: GridItem }
                                                    ).item
                                                });
                                        }}
                                        onChange={(change) => void applyChange(change)}
                                        onTaskDrop={(taskId, at) => void scheduleTask(taskId, at)}
                                        onOpenDay={(day, next) => {
                                            setAnchor(day);
                                            chooseView(next);
                                        }}
                                    />
                                </Suspense>
                            </GridMenu>
                        </div>
                    )}
                </main>
            </div>

            <Dialog open={drawer} onOpenChange={setDrawer}>
                <DialogContent
                    aria-describedby={undefined}
                    className="left-0 top-0 h-[100dvh] max-h-none w-full max-w-none translate-x-0 translate-y-0 rounded-none p-0 sm:w-80"
                >
                    <DialogTitle className="border-b border-border px-4 py-3 pr-14">
                        {t("header.calendars")}
                    </DialogTitle>
                    {sidebar}
                </DialogContent>
            </Dialog>

            {picker ? (
                <AnchoredPanel
                    open
                    onOpenChange={(open) => !open && setPicker(null)}
                    anchor={picker}
                    title={t("header.goToTitle")}
                    width={272}
                >
                    <MiniMonth
                        value={anchor}
                        today={today}
                        firstDay={firstDay}
                        locale={locale}
                        highlight={span}
                        autoFocus
                        onPick={(day) => {
                            setAnchor(day);
                            setPicker(null);
                        }}
                    />
                </AnchoredPanel>
            ) : null}

            {popover?.kind === "task" ? (
                <TaskCard
                    task={popover.task}
                    calendar={
                        popover.task.calendarId
                            ? calendarsById.get(popover.task.calendarId)
                            : undefined
                    }
                    anchor={popover.anchor}
                    zone={zone}
                    locale={locale}
                    onClose={() => setPopover(null)}
                    onToggle={(task) => void toggleTask(task)}
                    onEdit={() => openTask(popover.task)}
                    onDuplicate={() => void duplicateTask(popover.task)}
                    onDelete={() => void deleteTask(popover.task)}
                />
            ) : null}
            {popover?.kind === "event" ? (
                <EventCard
                    occurrence={popover.occurrence}
                    calendar={calendarsById.get(popover.occurrence.calendarId)}
                    anchor={popover.anchor}
                    zone={zone}
                    locale={locale}
                    onClose={() => setPopover(null)}
                    onEdit={() => openEditor(popover.occurrence)}
                    onDelete={() => void deleteOccurrence(popover.occurrence)}
                    onDuplicate={() => void duplicateOccurrence(popover.occurrence)}
                    onChanged={eventsChanged}
                />
            ) : null}
            {newCard ? (
                <NewEventCard
                    anchor={newCard.anchor}
                    start={newCard.start}
                    zone={zone}
                    locale={locale}
                    when={
                        newCard.start.allDay
                            ? new Intl.DateTimeFormat(locale, {
                                  dateStyle: "medium",
                                  timeZone: "UTC"
                              }).formatRange(
                                  time.dayDate(newCard.start.day),
                                  time.dayDate(
                                      time.addDays(newCard.end.day, -1) < newCard.start.day
                                          ? newCard.start.day
                                          : time.addDays(newCard.end.day, -1)
                                  )
                              )
                            : new Intl.DateTimeFormat(locale, {
                                  dateStyle: "medium",
                                  timeStyle: "short",
                                  timeZone: zone
                              }).formatRange(newCard.start.at, newCard.end.at)
                    }
                    calendars={calendars ?? []}
                    calendarId={newCard.calendarId}
                    onCalendar={(calendarId) => setPopover({ ...newCard, calendarId })}
                    summary={newCard.summary}
                    onSummary={(summary) => setPopover({ ...newCard, summary })}
                    busy={creating}
                    onSave={() => void createFromCard()}
                    onMore={() => {
                        setEditor({
                            kind: "new",
                            form: newFormFor(
                                newCard.start,
                                newCard.end,
                                newCard.summary,
                                newCard.calendarId
                            )
                        });
                        setPopover(null);
                    }}
                    onTaskCreated={taskCreated}
                    onBooking={() => {
                        router.push(bookingFor(newCard));
                        setPopover(null);
                    }}
                    onClose={() => setPopover(null)}
                />
            ) : null}

            <EventEditor
                target={editor}
                onClose={() => {
                    setEditor(null);
                    if (route.objectId)
                        window.history.replaceState(
                            window.history.state,
                            "",
                            time.calendarPath(view, anchor)
                        );
                }}
                calendars={calendars ?? []}
                zone={zone}
                preferences={preferences}
                onChanged={eventsChanged}
                onOpen={(objectId) => setEditor({ kind: "open", objectId, recurrenceKey: null })}
            />
            <TodoEditor
                objectId={todoId}
                zone={zone}
                onClose={() => setTodoId(null)}
                onChanged={eventsChanged}
            />
            {calendarDialog ? (
                <CalendarDialog
                    target={calendarDialog}
                    calendars={calendars ?? []}
                    onClose={() => setCalendarDialog(null)}
                    onSaved={(calendar) => {
                        const list = calendarsRead.data ?? [];
                        calendarsRead.replace(
                            list.some((entry) => entry.id === calendar.id)
                                ? list.map((entry) => (entry.id === calendar.id ? calendar : entry))
                                : [...list, calendar]
                        );
                        calendarsRead.refresh();
                        eventsChanged();
                    }}
                />
            ) : null}
            {shareFor && ShareCalendar && shareFor.kind === "share" ? (
                <ShareCalendar
                    calendar={shareFor.calendar}
                    open
                    onOpenChange={(open) => !open && setShareFor(null)}
                    onChanged={calendarsRead.refresh}
                />
            ) : null}
            {shareFor && PublishCalendar && shareFor.kind === "publish" ? (
                <PublishCalendar
                    calendar={shareFor.calendar}
                    open
                    onOpenChange={(open) => !open && setShareFor(null)}
                    onChanged={calendarsRead.refresh}
                />
            ) : null}
            {AddCalendars ? (
                <AddCalendars
                    open={addOpen}
                    tab={addTab}
                    onOpenChange={setAddOpen}
                    onChanged={() => {
                        calendarsRead.refresh();
                        eventsChanged();
                    }}
                />
            ) : null}
            <NewTaskDialog
                at={taskAt}
                zone={zone}
                locale={locale}
                onClose={() => setTaskAt(null)}
                onCreated={(created) => taskCreated(created, false)}
            />
            <ShortcutsDialog
                open={helpOpen}
                onOpenChange={setHelpOpen}
                enabled={preferences.keyboardShortcuts}
            />
            {confirmElement}
            {scopeElement}
        </div>
    );
}

function GridSkeleton() {
    return (
        <div className="flex h-full flex-col gap-px p-3" aria-hidden>
            <Skeleton className="h-6 w-full" />
            <div className="grid flex-1 grid-cols-7 gap-px pt-2">
                {Array.from({ length: 7 }, (_, index) => (
                    <Skeleton key={index} className={cn("h-full rounded-none opacity-60")} />
                ))}
            </div>
        </div>
    );
}
