"use client";

/**
 * The Overview grid: the cards, their arrangement, and everything that changes
 * it.
 *
 * The arrangement arrives with the page and is applied immediately on every
 * change - moving, resizing, hiding and pinning all take effect in the grid
 * before the server has been told, and are put back if it refuses. Nobody should
 * have to wait on a round trip to find out where they moved a card to.
 *
 * The figures are the other way round: the grid draws its frames first and asks
 * for the numbers once it is on screen, in one request covering every card that
 * needs one. A card whose data has not landed shows the shape of its own
 * contents, so the page does not move under the reader when it does.
 */

import { WidgetCard } from "./widget-card";
import { ShortcutPicker } from "./shortcut-picker";
import { CustomizeDialog } from "./customize-dialog";
import { saveOverviewPreferencesAction } from "./actions";
import { clearRecentPlaces } from "@/lib/overview/recent-places";
import { ActivityWidget, SessionsWidget } from "./widgets/account";
import type { OverviewData } from "@/lib/overview/overview-service";
import { overviewSize, overviewWidget } from "@/lib/overview/catalog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emptyCards, relevanceOrder, rememberEmptyCards } from "@/lib/overview/relevance";
import { AppsWidget, NotificationsWidget, RecentWidget, ShortcutsWidget } from "./widgets/personal";
import { AlarmsWidget, GamesWidget, ServicesWidget, StorageWidget, TasksWidget, UsageWidget } from "./widgets/infrastructure";
import { ArrowDown, ArrowUp, EyeOff, GripVertical, LayoutGrid, MoreVertical, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, cn } from "@polaris/ui";
import {
    resolveOverviewLayout,
    type OverviewPreferences,
    type OverviewShortcut,
    type OverviewWidgetId,
    type OverviewWidgetPreference,
    type OverviewWidgetSize,
    MAX_OVERVIEW_SHORTCUTS
} from "@polaris/core";

export interface OverviewApp {
    id: string;
    label: string;
    description: string;
    href: string;
}

/** How long fetched figures are reused when the page is opened again. Long
 *  enough that stepping into a service and back does not re-run a monitoring
 *  read, short enough that the landing screen is never stale for long. */
const DATA_TTL_MS = 30_000;

/** How long changes are collected before they are saved, so moving a card three
 *  places is one write rather than three. */
const SAVE_DEBOUNCE_MS = 600;

// Held outside the component so returning to the Overview paints the figures the
// last visit already fetched.
let dataCache: { at: number; key: string; data: OverviewData } | null = null;

/**
 * How wide each stored size is drawn. The columns themselves, and the clamp that
 * keeps a span inside the columns that exist at this width, are in globals.css:
 * the grid measures itself with a container query, because the shell's sidebar
 * sits between the viewport and the width the grid actually has.
 */
const SPAN: Record<OverviewWidgetSize, string> = {
    sm: "overview-card",
    md: "overview-card overview-card-md",
    lg: "overview-card overview-card-lg"
};

/** "Good morning" and the rest, by the reader's own clock. */
function greetingFor(date: Date): string {
    const hour = date.getHours();
    if (hour < 6) return "Good night";
    if (hour < 12) return "Good morning";
    if (hour < 19) return "Good afternoon";
    return "Good evening";
}

export function OverviewGrid({
    name,
    isAdmin,
    preferences,
    available,
    layout,
    apps
}: {
    name: string;
    isAdmin: boolean;
    /** As stored, so cards this account cannot currently see are kept rather than
     *  written away the next time anything is saved. */
    preferences: OverviewPreferences;
    available: readonly OverviewWidgetId[];
    /** The stored arrangement, already resolved against the catalogue and this
     *  account's permissions. */
    layout: OverviewWidgetPreference[];
    apps: OverviewApp[];
}) {
    const [widgets, setWidgets] = useState(layout);
    const [shortcuts, setShortcuts] = useState<OverviewShortcut[]>(preferences.shortcuts);
    const [greeting, setGreeting] = useState(preferences.greeting);
    const [data, setData] = useState<OverviewData | undefined>(undefined);
    const [customizing, setCustomizing] = useState(false);
    const [picking, setPicking] = useState(false);
    // The card being dragged, and the one it is currently over. Dragging is the
    // gesture most people reach for; it is not the only one, because it does not
    // exist for a keyboard and does not fire on a touch screen - the same moves
    // are on every card's own menu and in the customize panel.
    const [dragged, setDragged] = useState<OverviewWidgetId | null>(null);
    const [over, setOver] = useState<OverviewWidgetId | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const [nonce, setNonce] = useState(0);
    // Bumped when the visit history is thrown away, so the card that reads it out
    // of storage draws itself again.
    const [historyNonce, setHistoryNonce] = useState(0);
    // The greeting is the reader's local time of day, which the server does not
    // know: rendering it during SSR would hydrate into a different sentence.
    const [hello, setHello] = useState<string | null>(null);

    // What the server last accepted, to put back if it refuses the next change.
    const accepted = useRef<{ widgets: OverviewWidgetPreference[]; shortcuts: OverviewShortcut[]; greeting: boolean }>({
        widgets: layout,
        shortcuts: preferences.shortcuts,
        greeting: preferences.greeting
    });
    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => setHello(greetingFor(new Date())), []);

    /** Cards this reader has arranged themselves. Everything else is ours to
     *  order, and stops being so the moment they touch it. */
    const arranged = useMemo(
        () => new Set(preferences.widgets.map((widget) => widget.id)),
        [preferences.widgets]
    );

    // Once, before the figures are asked for, so the grid is in its final order
    // by the time it is read rather than rearranging itself under the reader.
    // What it ranks on is what the last visit saw (see relevance).
    useEffect(() => {
        setWidgets((held) => relevanceOrder(held, arranged));
    }, [arranged]);

    // And what THIS visit saw, for the next one.
    useEffect(() => {
        if (!data) return;
        rememberEmptyCards(emptyCards(data, { shortcuts: shortcuts.length, apps: apps.length }));
    }, [data, shortcuts.length, apps.length]);

    /** Cards this account holds but cannot currently see. Carried through every
     *  save untouched, so losing access to an app for a week does not silently
     *  delete how its card was arranged. */
    const unseen = useMemo(
        () => preferences.widgets.filter((widget) => !available.includes(widget.id)),
        [preferences.widgets, available]
    );

    const persist = useCallback(
        (next: { widgets: OverviewWidgetPreference[]; shortcuts: OverviewShortcut[]; greeting: boolean }) => {
            setWidgets(next.widgets);
            setShortcuts(next.shortcuts);
            setGreeting(next.greeting);
            setFailure(null);
            if (saveTimer.current) clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(() => {
                const previous = accepted.current;
                void saveOverviewPreferencesAction({
                    widgets: [...next.widgets, ...unseen],
                    shortcuts: next.shortcuts,
                    greeting: next.greeting
                })
                    .then((result) => {
                        if (!result.error) {
                            accepted.current = next;
                            return;
                        }
                        setWidgets(previous.widgets);
                        setShortcuts(previous.shortcuts);
                        setGreeting(previous.greeting);
                        setFailure(result.error);
                    })
                    .catch(() => {
                        setWidgets(previous.widgets);
                        setShortcuts(previous.shortcuts);
                        setGreeting(previous.greeting);
                        setFailure("That change could not be saved. Check your connection and try again.");
                    });
            }, SAVE_DEBOUNCE_MS);
        },
        [unseen]
    );

    const current = () => ({ widgets, shortcuts, greeting });

    function reorder(from: number, to: number): void {
        if (from < 0 || to < 0 || from === to || from >= widgets.length || to >= widgets.length) return;
        const next = [...widgets];
        const [held] = next.splice(from, 1);
        next.splice(to, 0, held!);
        persist({ ...current(), widgets: next });
    }

    function move(id: OverviewWidgetId, direction: -1 | 1): void {
        const index = widgets.findIndex((widget) => widget.id === id);
        reorder(index, index + direction);
    }

    /** Drop one card where another one is. Both are named rather than counted,
     *  since the grid draws only the cards that are on and their positions in the
     *  stored list are not the positions on screen. */
    function moveOnto(id: OverviewWidgetId, target: OverviewWidgetId): void {
        if (id === target) return;
        reorder(
            widgets.findIndex((widget) => widget.id === id),
            widgets.findIndex((widget) => widget.id === target)
        );
    }

    function toggle(id: OverviewWidgetId, visible: boolean): void {
        persist({
            ...current(),
            widgets: widgets.map((widget) => (widget.id === id ? { ...widget, hidden: !visible } : widget))
        });
    }

    function resize(id: OverviewWidgetId, size: OverviewWidgetSize): void {
        persist({
            ...current(),
            widgets: widgets.map((widget) => (widget.id === id ? { ...widget, size } : widget))
        });
    }

    function pin(shortcut: OverviewShortcut): void {
        if (shortcuts.length >= MAX_OVERVIEW_SHORTCUTS || shortcuts.some((held) => held.href === shortcut.href)) return;
        persist({ ...current(), shortcuts: [...shortcuts, shortcut] });
    }

    function unpin(href: string): void {
        persist({ ...current(), shortcuts: shortcuts.filter((shortcut) => shortcut.href !== href) });
    }

    function reset(): void {
        persist({ widgets: resolveOverviewLayout({ ...preferences, widgets: [] }, available), shortcuts, greeting: true });
    }

    // One request for every card that needs the server, re-run when the set of
    // those cards changes rather than on every rearrangement.
    const wanted = useMemo(
        () =>
            widgets
                .filter((widget) => !widget.hidden && !overviewWidget(widget.id).local)
                .map((widget) => widget.id)
                .sort(),
        [widgets]
    );
    const key = wanted.join(",");

    useEffect(() => {
        if (!key) {
            setData({});
            return;
        }
        if (nonce === 0 && dataCache && dataCache.key === key && Date.now() - dataCache.at < DATA_TTL_MS) {
            setData(dataCache.data);
            return;
        }
        const controller = new AbortController();
        setData(undefined);
        void fetch(`/api/overview?widgets=${encodeURIComponent(key)}`, {
            cache: "no-store",
            signal: controller.signal
        })
            .then((response) => (response.ok ? response.json() : Promise.reject(new Error("read failed"))))
            .then((body: OverviewData) => {
                dataCache = { at: Date.now(), key, data: body };
                setData(body);
            })
            .catch((caught: unknown) => {
                if (caught instanceof DOMException && caught.name === "AbortError") return;
                // Every card then says it could not be read, which is the truth.
                setData({});
            });
        return () => controller.abort();
    }, [key, nonce]);

    function refresh(): void {
        dataCache = null;
        setNonce((value) => value + 1);
    }

    const visible = widgets.filter((widget) => !widget.hidden);

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <h1 className="text-lg font-semibold tracking-tight">
                        {greeting ? (hello ? `${hello}, ${name.split(" ")[0]}` : `Welcome back, ${name.split(" ")[0]}`) : "Overview"}
                    </h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                        What is running, what needs you, and the places you go most.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={refresh}
                        title="Refresh the figures"
                        aria-label="Refresh the figures"
                        className="grid size-9 place-items-center rounded-md border border-input bg-surface text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <RefreshCw className={cn("size-4", data === undefined && "animate-spin")} aria-hidden="true" />
                    </button>
                    <Button variant="outline" size="sm" onClick={() => setCustomizing(true)}>
                        <Settings2 className="size-4" aria-hidden="true" />
                        Customize
                    </Button>
                </div>
            </div>

            {failure ? (
                <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                    {failure}
                </p>
            ) : null}

            {visible.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-16 text-center">
                    <LayoutGrid className="size-6 text-muted-foreground" aria-hidden="true" />
                    <p className="text-sm text-muted-foreground">Every card is turned off.</p>
                    <Button variant="outline" size="sm" onClick={() => setCustomizing(true)}>
                        Choose what to show
                    </Button>
                </div>
            ) : (
                <div className="overview-grid">
                    {visible.map((widget, index) => {
                        const entry = overviewWidget(widget.id);
                        return (
                            <div
                                key={widget.id}
                                data-widget={widget.id}
                                className={cn(
                                    "min-w-0 rounded-lg transition-opacity",
                                    SPAN[overviewSize(widget.id, widget.size)],
                                    dragged === widget.id && "opacity-40",
                                    over === widget.id && dragged !== widget.id && "ring-2 ring-primary"
                                )}
                                onDragOver={(event) => {
                                    if (!dragged) return;
                                    // Without this the drop never happens: the
                                    // default for a dragover is "not a target".
                                    event.preventDefault();
                                    event.dataTransfer.dropEffect = "move";
                                    setOver(widget.id);
                                }}
                                onDragLeave={() => setOver((held) => (held === widget.id ? null : held))}
                                onDrop={(event) => {
                                    event.preventDefault();
                                    if (dragged) moveOnto(dragged, widget.id);
                                    setDragged(null);
                                    setOver(null);
                                }}
                            >
                                <WidgetCard
                                    title={entry.label}
                                    icon={entry.icon}
                                    href={entry.href}
                                    grip={
                                        <WidgetGrip
                                            label={entry.label}
                                            onStart={() => setDragged(widget.id)}
                                            onEnd={() => {
                                                setDragged(null);
                                                setOver(null);
                                            }}
                                        />
                                    }
                                    menu={
                                        <WidgetMenu
                                            label={entry.label}
                                            sizes={entry.sizes}
                                            size={overviewSize(widget.id, widget.size)}
                                            first={index === 0}
                                            last={index === visible.length - 1}
                                            onMove={(direction) => move(widget.id, direction)}
                                            onResize={(size) => resize(widget.id, size)}
                                            onHide={() => toggle(widget.id, false)}
                                            onClear={
                                                widget.id === "recent"
                                                    ? () => {
                                                          clearRecentPlaces();
                                                          setHistoryNonce((value) => value + 1);
                                                      }
                                                    : undefined
                                            }
                                        />
                                    }
                                >
                                    <WidgetBody
                                        id={widget.id}
                                        data={data}
                                        apps={apps}
                                        shortcuts={shortcuts}
                                        historyNonce={historyNonce}
                                        onAdd={() => setPicking(true)}
                                        onRemove={unpin}
                                    />
                                </WidgetCard>
                            </div>
                        );
                    })}
                </div>
            )}

            <CustomizeDialog
                open={customizing}
                onOpenChange={setCustomizing}
                layout={widgets}
                greeting={greeting}
                onMove={move}
                onMoveOnto={moveOnto}
                onToggle={toggle}
                onResize={resize}
                onGreetingChange={(value) => persist({ ...current(), greeting: value })}
                onReset={reset}
            />
            <ShortcutPicker
                open={picking}
                onOpenChange={setPicking}
                isAdmin={isAdmin}
                appIds={apps.map((app) => app.id)}
                pinned={shortcuts}
                onPick={pin}
            />
        </div>
    );
}

/** What one card draws. Separated so the grid above stays about arrangement. */
function WidgetBody({
    id,
    data,
    apps,
    shortcuts,
    historyNonce,
    onAdd,
    onRemove
}: {
    id: OverviewWidgetId;
    data: OverviewData | undefined;
    apps: OverviewApp[];
    shortcuts: OverviewShortcut[];
    historyNonce: number;
    onAdd: () => void;
    onRemove: (href: string) => void;
}) {
    switch (id) {
        case "shortcuts":
            return <ShortcutsWidget shortcuts={shortcuts} onAdd={onAdd} onRemove={onRemove} />;
        case "recent":
            return <RecentWidget key={historyNonce} />;
        case "notifications":
            return <NotificationsWidget />;
        case "apps":
            return <AppsWidget apps={apps} />;
        case "services":
            return <ServicesWidget data={data === undefined ? undefined : (data.services ?? null)} />;
        case "usage":
            return <UsageWidget data={data === undefined ? undefined : (data.usage ?? null)} />;
        case "alarms":
            return <AlarmsWidget data={data === undefined ? undefined : (data.alarms ?? null)} />;
        case "storage":
            return <StorageWidget data={data === undefined ? undefined : (data.storage ?? null)} />;
        case "tasks":
            return <TasksWidget data={data === undefined ? undefined : (data.tasks ?? null)} />;
        case "sessions":
            return <SessionsWidget data={data === undefined ? undefined : (data.sessions ?? null)} />;
        case "activity":
            return <ActivityWidget data={data === undefined ? undefined : (data.activity ?? null)} />;
        case "games":
            return <GamesWidget data={data === undefined ? undefined : (data.games ?? null)} />;
    }
}

/**
 * The handle a card is dragged by.
 *
 * Deliberately not a button. There is nothing here for a keyboard to press - the
 * same two moves are on the card's own menu and in the customize panel, which is
 * where anybody not using a mouse arranges the grid - and a focusable control
 * that does nothing when it is pressed is worse than no control at all.
 */
function WidgetGrip({ label, onStart, onEnd }: { label: string; onStart: () => void; onEnd: () => void }) {
    return (
        <span
            draggable
            title={`Drag to move ${label}`}
            aria-hidden="true"
            onDragStart={(event) => {
                // Firefox starts no drag at all unless something is on the
                // transfer, and the drag image defaults to the handle - a 24px
                // smudge - unless it is told to use the card.
                event.dataTransfer.setData("text/plain", label);
                event.dataTransfer.effectAllowed = "move";
                const card = event.currentTarget.closest("[data-widget]");
                if (card instanceof HTMLElement) event.dataTransfer.setDragImage(card, 24, 24);
                onStart();
            }}
            onDragEnd={onEnd}
            className="grid size-6 shrink-0 cursor-grab place-items-center rounded text-muted-foreground/50 transition-colors hover:text-foreground active:cursor-grabbing"
        >
            <GripVertical className="size-4" aria-hidden="true" />
        </span>
    );
}

const SIZE_LABELS: Record<OverviewWidgetSize, string> = { sm: "Narrow", md: "Medium", lg: "Wide" };

/** Arranging one card from the card itself: the gestures somebody reaches for
 *  while looking at it, without opening the panel. */
function WidgetMenu({
    label,
    sizes,
    size,
    first,
    last,
    onMove,
    onResize,
    onHide,
    onClear
}: {
    label: string;
    sizes: readonly OverviewWidgetSize[];
    size: OverviewWidgetSize;
    first: boolean;
    last: boolean;
    onMove: (direction: -1 | 1) => void;
    onResize: (size: OverviewWidgetSize) => void;
    onHide: () => void;
    /** Only for the cards that hold something of the reader's to throw away. */
    onClear?: () => void;
}) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    title={`Arrange ${label}`}
                    aria-label={`Arrange ${label}`}
                    className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <MoreVertical className="size-4" aria-hidden="true" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem disabled={first} onSelect={() => onMove(-1)}>
                    <ArrowUp className="size-4" aria-hidden="true" />
                    Move up
                </DropdownMenuItem>
                <DropdownMenuItem disabled={last} onSelect={() => onMove(1)}>
                    <ArrowDown className="size-4" aria-hidden="true" />
                    Move down
                </DropdownMenuItem>
                {sizes.length > 1 ? (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>Width</DropdownMenuLabel>
                        {sizes.map((option) => (
                            <DropdownMenuItem
                                key={option}
                                onSelect={() => onResize(option)}
                                className={cn(option === size && "text-primary")}
                            >
                                {SIZE_LABELS[option]}
                            </DropdownMenuItem>
                        ))}
                    </>
                ) : null}
                <DropdownMenuSeparator />
                {onClear ? (
                    <DropdownMenuItem onSelect={onClear}>
                        <Trash2 className="size-4" aria-hidden="true" />
                        Clear history
                    </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem onSelect={onHide}>
                    <EyeOff className="size-4" aria-hidden="true" />
                    Hide card
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
