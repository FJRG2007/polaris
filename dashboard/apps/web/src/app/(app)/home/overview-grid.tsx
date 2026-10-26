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
 * for the numbers once it is on screen - the quick cards in one request and the
 * slow ones in another, so a monitoring read never holds a task count back (see
 * `request-groups`). A card whose data has not landed shows the shape of its own
 * contents, so the page does not move under the reader when it does.
 */

import { firstName } from "@polaris/core";
import { sizeLabel, widgetDescription, widgetLabel } from "./widget-names";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { WidgetCard } from "./widget-card";
import { ShortcutPicker } from "./shortcut-picker";
import { CustomizeDialog, type CustomizeRow } from "./customize-dialog";
import { saveOverviewPreferencesAction } from "./actions";
import { packOverviewSpans } from "@/lib/overview/pack";
import { useShelfScope } from "@/components/shelf-scope";
import { clearRecentPlaces } from "@/lib/overview/recent-places";
import { overviewRequestGroups } from "@/lib/overview/request-groups";
import { emptyOverviewCards, writeEmptyCardsCookie } from "@/lib/overview/empty-cards";
import { ActivityWidget, SessionsWidget } from "./widgets/account";
import { CalendarWidget } from "./widgets/calendar";
import { DnsBlockerWidget } from "./widgets/dns-blocker";
import {
    AppWidgetCatalog,
    AppWidgetItem,
    appWidgetKindOf,
    useAppWidgetLive,
    useAppWidgets
} from "./app-widgets";
import type { AppWidgetKind } from "@/lib/overview/app-widgets";
import type { OverviewData } from "@/lib/overview/overview-service";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { overviewSize, overviewWidget } from "@/lib/overview/catalog";
import { AppsWidget, NotificationsWidget, RecentWidget, ShortcutsWidget } from "./widgets/personal";
import {
    AlarmsWidget,
    GamesWidget,
    ServicesWidget,
    StorageWidget,
    TasksWidget,
    UsageWidget
} from "./widgets/infrastructure";
import {
    ArrowDown,
    ArrowUp,
    Blocks,
    EyeOff,
    GripVertical,
    LayoutGrid,
    MoreVertical,
    RefreshCw,
    Settings2,
    Trash2
} from "lucide-react";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    cn
} from "@polaris/ui";
import {
    appCardKey,
    moveOverviewCard,
    orderOverviewCards,
    overviewArranged,
    rankOverviewLayout,
    resolveOverviewLayout,
    OVERVIEW_WIDGET_SIZES,
    type AppWidgetPreference,
    type OverviewCardKey,
    type OverviewPreferences,
    type OverviewShortcut,
    type OverviewWidgetId,
    type OverviewWidgetPreference,
    type OverviewWidgetSize,
    MAX_OVERVIEW_SHORTCUTS
} from "@polaris/core";

/** Everything about the grid one save writes. */
interface Arrangement {
    widgets: OverviewWidgetPreference[];
    shortcuts: OverviewShortcut[];
    greeting: boolean;
    arranged: boolean;
    /** Both kinds of card in one order; undefined until somebody arranges them
     *  (see `orderOverviewCards`). */
    order: OverviewCardKey[] | undefined;
}

/** One card on the grid: one of the Overview's own, or one an app added. */
type GridCard =
    | { key: OverviewWidgetId; widget: OverviewWidgetPreference; app?: undefined }
    | { key: `app:${string}`; widget?: undefined; app: AppWidgetPreference; kind: AppWidgetKind };

function cardHidden(card: GridCard): boolean {
    return card.app ? card.app.hidden : card.widget.hidden;
}

/** The widths a card can be drawn at. An app's card can take any of them. */
function cardSizes(card: GridCard): readonly OverviewWidgetSize[] {
    return card.app ? OVERVIEW_WIDGET_SIZES : overviewWidget(card.key).sizes;
}

/** The width a card is drawn at before the grid fits it to the row. */
function drawnSize(card: GridCard): OverviewWidgetSize {
    return card.app ? card.app.size : overviewSize(card.key, card.widget.size);
}

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

/** How often the game servers' card is read again while the page is in front. */
const GAMES_REFRESH_MS = 60_000;

/** How long changes are collected before they are saved, so moving a card three
 *  places is one write rather than three. */
const SAVE_DEBOUNCE_MS = 600;

// Held outside the component so returning to the Overview paints the figures the
// last visit already fetched. One entry per request sent, keyed by the shelf and
// the cards it asked for.
const dataCache = new Map<string, { at: number; data: OverviewData }>();

/**
 * How wide each stored size is drawn before the grid has been measured - the
 * first paint, and any browser without a container query. The columns themselves
 * and the clamp that keeps a span inside the ones that exist are in globals.css,
 * because the shell's sidebar sits between the viewport and the width the grid
 * actually has and only the grid can see it.
 */
const SPAN: Record<OverviewWidgetSize, string> = {
    sm: "overview-card",
    md: "overview-card overview-card-md",
    lg: "overview-card overview-card-lg",
    xl: "overview-card overview-card-xl"
};

/** The same widths as columns, for the arithmetic that fits a row to the grid. */
const COLUMNS: Record<OverviewWidgetSize, number> = { sm: 1, md: 2, lg: 3, xl: 4 };

/** The part of the day a greeting is for, by the reader's own clock - the
 *  same four `greetingFor` in @polaris/core names in English. */
type DayPeriod = "night" | "morning" | "afternoon" | "evening";

function dayPeriod(date: Date): DayPeriod {
    const hour = date.getHours();
    if (hour < 6) return "night";
    if (hour < 12) return "morning";
    if (hour < 19) return "afternoon";
    return "evening";
}

export function OverviewGrid({
    name,
    isAdmin,
    preferences,
    available,
    layout,
    apps,
    gate,
    appKinds = [],
    knownEmpty = []
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
    /** What narrows the screens offered for pinning, the way the rail is
     *  narrowed (see `SectionGate`). */
    gate: { held: string[]; installed: string[] };
    /** The cards the installed apps offer (see `app-widgets`). */
    appKinds?: readonly AppWidgetKind[];
    /** The cards found empty on the last visit, so the first paint is already in
     *  the order the figures will settle it into (see `empty-cards`). */
    knownEmpty?: readonly OverviewWidgetId[];
}) {
    // The stored order. What is drawn is this with the empty cards sunk below the
    // rest (`displayed`), unless the reader arranged the grid themselves.
    const [widgets, setWidgets] = useState(layout);
    const [arranged, setArranged] = useState(() => overviewArranged(preferences));
    const [placed, setPlaced] = useState<ReadonlySet<OverviewWidgetId>>(
        () => new Set(preferences.widgets.map((widget) => widget.id))
    );
    // Decided once per visit: from the last visit's answer and what the page
    // already knows, then once more when the figures land - never again while the
    // page is open, so a card does not jump under somebody reading it.
    const [empty, setEmpty] = useState<ReadonlySet<OverviewWidgetId>>(() => {
        const known = new Set<OverviewWidgetId>(
            knownEmpty.filter((id) => id !== "shortcuts" && id !== "apps")
        );
        if (preferences.shortcuts.length === 0) known.add("shortcuts");
        if (apps.length === 0) known.add("apps");
        return known;
    });
    const settled = useRef(false);
    const appState = useAppWidgets(preferences.appWidgets);
    const live = useAppWidgetLive(appState, appKinds);
    const [order, setOrder] = useState<OverviewCardKey[] | undefined>(preferences.order);
    const [shortcuts, setShortcuts] = useState<OverviewShortcut[]>(preferences.shortcuts);
    const [greeting, setGreeting] = useState(preferences.greeting);
    const [data, setData] = useState<OverviewData>({});
    // The cards whose figures are still on their way. Null before the first ask,
    // which is every card.
    const [pending, setPending] = useState<ReadonlySet<string> | null>(null);
    const [customizing, setCustomizing] = useState(false);
    const [picking, setPicking] = useState(false);
    // The card being dragged, and the one it is currently over. Dragging is the
    // gesture most people reach for; it is not the only one, because it does not
    // exist for a keyboard and does not fire on a touch screen - the same moves
    // are on every card's own menu and in the customize panel.
    const [dragged, setDragged] = useState<OverviewCardKey | null>(null);
    const [over, setOver] = useState<OverviewCardKey | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const [nonce, setNonce] = useState(0);
    // Bumped when the visit history is thrown away, so the card that reads it out
    // of storage draws itself again.
    const [historyNonce, setHistoryNonce] = useState(0);
    // The greeting is the reader's local time of day, which the server does not
    // know: rendering it during SSR would hydrate into a different sentence.
    const [hello, setHello] = useState<DayPeriod | null>(null);
    const t = useTranslations("home");
    // Columns the grid has right now. 0 until it has been measured, which is the
    // server render and the first paint.
    const [columns, setColumns] = useState(0);

    // What the server last accepted, to put back if it refuses the next change.
    const accepted = useRef<Arrangement>({
        widgets: layout,
        shortcuts: preferences.shortcuts,
        greeting: preferences.greeting,
        arranged,
        order: preferences.order
    });
    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const gridRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => setHello(dayPeriod(new Date())), []);

    /** Cards this account holds but cannot currently see. Carried through every
     *  save untouched, so losing access to an app for a week does not silently
     *  delete how its card was arranged. */
    const unseen = useMemo(
        () => preferences.widgets.filter((widget) => !available.includes(widget.id)),
        [preferences.widgets, available]
    );
    /** The same for the order: the cards above, and app cards whose app does not
     *  offer them right now. */
    const unseenKeys = useMemo(
        (): OverviewCardKey[] => [
            ...unseen.map((widget) => widget.id),
            ...appState.cards
                .filter((card) => !appWidgetKindOf(card, appKinds))
                .map((card) => appCardKey(card.id))
        ],
        [unseen, appState.cards, appKinds]
    );

    const persist = useCallback(
        (next: Arrangement) => {
            setWidgets(next.widgets);
            setShortcuts(next.shortcuts);
            setGreeting(next.greeting);
            setArranged(next.arranged);
            setOrder(next.order);
            setFailure(null);
            if (saveTimer.current) clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(() => {
                const previous = accepted.current;
                const restore = (): void => {
                    setWidgets(previous.widgets);
                    setShortcuts(previous.shortcuts);
                    setGreeting(previous.greeting);
                    setArranged(previous.arranged);
                    setOrder(previous.order);
                };
                void saveOverviewPreferencesAction({
                    widgets: [...next.widgets, ...unseen],
                    shortcuts: next.shortcuts,
                    greeting: next.greeting,
                    arranged: next.arranged,
                    // Cards not drawn right now keep a place in the order, like
                    // their arrangement above.
                    ...(next.order ? { order: [...next.order, ...unseenKeys] } : {})
                })
                    .then((result) => {
                        if (!result.error) {
                            accepted.current = next;
                            setPlaced(new Set(next.widgets.map((widget) => widget.id)));
                            return;
                        }
                        restore();
                        setFailure(result.error);
                    })
                    .catch(() => {
                        restore();
                        setFailure(t("errors.changeNotSaved"));
                    });
            }, SAVE_DEBOUNCE_MS);
        },
        [unseen, unseenKeys, t]
    );

    const current = (): Arrangement => ({ widgets, shortcuts, greeting, arranged, order });

    const displayed = useMemo(
        () => rankOverviewLayout(widgets, { arranged, placed, empty }),
        [widgets, arranged, placed, empty]
    );

    /** Every card on the grid, both kinds, hidden ones included, in one order. */
    const cards = useMemo((): GridCard[] => {
        const byKey = new Map<OverviewCardKey, GridCard>();
        for (const widget of displayed) byKey.set(widget.id, { key: widget.id, widget });
        const apps: OverviewCardKey[] = [];
        for (const app of appState.cards) {
            const kind = appWidgetKindOf(app, appKinds);
            if (!kind) continue;
            const key = appCardKey(app.id);
            byKey.set(key, { key, app, kind });
            apps.push(key);
        }
        return orderOverviewCards(
            displayed.map((widget) => widget.id),
            apps,
            order
        ).flatMap((key) => byKey.get(key) ?? []);
    }, [displayed, appState.cards, appKinds, order]);

    /** Moving a card is the reader taking the order over: from here on it is
     *  theirs, starting from the order they were looking at. The Overview's own
     *  cards keep the same order in their own list, which is what a tab opened
     *  before the shared order existed reads. */
    function arrange(keys: OverviewCardKey[]): void {
        const byId = new Map(widgets.map((widget) => [widget.id as OverviewCardKey, widget]));
        persist({
            ...current(),
            widgets: keys.flatMap((key) => byId.get(key) ?? []),
            order: keys,
            arranged: true
        });
    }

    function move(key: OverviewCardKey, direction: -1 | 1): void {
        const keys = cards.map((card) => card.key);
        const target = keys[keys.indexOf(key) + direction];
        if (keys.includes(key) && target) arrange(moveOverviewCard(keys, key, target));
    }

    /** Drop one card where another one is. Both are named rather than counted,
     *  since the grid draws only the cards that are on and their positions in the
     *  stored lists are not the positions on screen. Either may be an app's. */
    function moveOnto(key: OverviewCardKey, target: OverviewCardKey): void {
        const keys = cards.map((card) => card.key);
        if (key === target || !keys.includes(key) || !keys.includes(target)) return;
        arrange(moveOverviewCard(keys, key, target));
    }

    /** The app card a key names, when it is one. */
    function appOf(key: OverviewCardKey): AppWidgetPreference | undefined {
        return cards.find((card) => card.key === key)?.app;
    }

    function toggle(key: OverviewCardKey, visible: boolean): void {
        const app = appOf(key);
        if (app) return appState.hide(app.id, !visible);
        persist({
            ...current(),
            widgets: widgets.map((widget) =>
                widget.id === key ? { ...widget, hidden: !visible } : widget
            )
        });
    }

    function resize(key: OverviewCardKey, size: OverviewWidgetSize): void {
        const app = appOf(key);
        if (app) return appState.resize(app.id, size);
        persist({
            ...current(),
            widgets: widgets.map((widget) => (widget.id === key ? { ...widget, size } : widget))
        });
    }

    function pin(shortcut: OverviewShortcut): void {
        if (
            shortcuts.length >= MAX_OVERVIEW_SHORTCUTS ||
            shortcuts.some((held) => held.href === shortcut.href)
        )
            return;
        persist({ ...current(), shortcuts: [...shortcuts, shortcut] });
    }

    function unpin(href: string): void {
        persist({
            ...current(),
            shortcuts: shortcuts.filter((shortcut) => shortcut.href !== href)
        });
    }

    function reset(): void {
        persist({
            widgets: resolveOverviewLayout({ ...preferences, widgets: [] }, available),
            shortcuts,
            greeting: true,
            arranged: false,
            // Every card back where it ships, the apps' after the Overview's own.
            order: []
        });
    }

    // The requests for every card that needs the server, re-run when the set of
    // those cards changes rather than on every rearrangement.
    const wanted = useMemo(
        () =>
            widgets
                .filter((widget) => !widget.hidden && !overviewWidget(widget.id).local)
                .map((widget) => widget.id)
                .sort(),
        [widgets]
    );
    const asked = wanted.join(",");
    // The shelf is part of what is being asked for, and part of what is kept:
    // these cards are the organization's servers, its tasks and its storage on
    // one shelf and somebody's own on another. Without it the switch left every
    // card showing the shelf that was open before - and the kept copy was
    // written over by whichever shelf asked last.
    const on = useShelfScope();
    const key = `${on}|${asked}`;

    useEffect(() => {
        if (!asked) {
            setData({});
            setPending(new Set());
            return;
        }
        const controller = new AbortController();
        const kept: OverviewData = {};
        const waiting = new Set<string>();
        const sends: string[][] = [];
        for (const group of overviewRequestGroups(asked.split(","))) {
            const held = dataCache.get(`${on}|${group.join(",")}`);
            if (nonce === 0 && held && Date.now() - held.at < DATA_TTL_MS) {
                Object.assign(kept, held.data);
            } else {
                sends.push(group);
                for (const id of group) waiting.add(id);
            }
        }
        setData(kept);
        setPending(waiting);
        const landed = (group: readonly string[], body: OverviewData): void => {
            setData((previous) => ({ ...previous, ...body }));
            setPending((previous) => {
                const next = new Set(previous);
                for (const id of group) next.delete(id);
                return next;
            });
        };
        for (const group of sends) {
            const groupKey = `${on}|${group.join(",")}`;
            void fetch(`/api/overview?widgets=${encodeURIComponent(group.join(","))}`, {
                cache: "no-store",
                signal: controller.signal
            })
                .then((response) =>
                    response.ok ? response.json() : Promise.reject(new Error("read failed"))
                )
                .then((body: OverviewData) => {
                    dataCache.set(groupKey, { at: Date.now(), data: body });
                    landed(group, body);
                })
                .catch((caught: unknown) => {
                    if (caught instanceof DOMException && caught.name === "AbortError") return;
                    // Every card in the request then says it could not be read,
                    // which is the truth; the other request's cards are unaffected.
                    landed(group, Object.fromEntries(group.map((id) => [id, null])));
                });
        }
        return () => controller.abort();
    }, [key, asked, on, nonce]);

    // The game servers' player counts are the one figure on the Overview that
    // moves minute to minute. Only that card is read again, once a minute while
    // the page is in front - the pace the activity sweep takes its readings at,
    // so asking more often could only return the same number.
    const watchingGames = wanted.includes("games");
    useEffect(() => {
        if (!watchingGames) return;
        const controller = new AbortController();
        const timer = window.setInterval(() => {
            if (document.visibilityState !== "visible") return;
            void fetch("/api/overview?widgets=games", {
                cache: "no-store",
                signal: controller.signal
            })
                .then((response) => (response.ok ? response.json() : null))
                .then((body: OverviewData | null) => {
                    if (!body?.games) return;
                    const games = body.games;
                    setData((previous) => ({ ...previous, games }));
                    for (const [held, entry] of dataCache) {
                        if (held.startsWith(`${on}|`) && "games" in entry.data)
                            dataCache.set(held, { at: entry.at, data: { ...entry.data, games } });
                    }
                })
                .catch(() => {
                    // What is on screen stays; the next minute asks again.
                });
        }, GAMES_REFRESH_MS);
        return () => {
            window.clearInterval(timer);
            controller.abort();
        };
    }, [watchingGames, on]);

    // The first time every card's figures are in, settle which ones are empty -
    // once, so later reads never move a card - and remember it for the next
    // visit's first paint. A card not on the grid keeps what was known of it.
    useEffect(() => {
        if (settled.current || pending === null || pending.size > 0) return;
        settled.current = true;
        const next = emptyOverviewCards(data, { shortcuts: shortcuts.length, apps: apps.length });
        for (const id of empty) {
            if (!wanted.includes(id) && id !== "shortcuts" && id !== "apps") next.add(id);
        }
        writeEmptyCardsCookie(next);
        const same = next.size === empty.size && [...next].every((id) => empty.has(id));
        if (!same) setEmpty(next);
    }, [pending, data, shortcuts.length, apps.length, empty, wanted]);

    function refresh(): void {
        dataCache.clear();
        setNonce((value) => value + 1);
    }

    const visible = useMemo(() => cards.filter((card) => !cardHidden(card)), [cards]);

    // How many columns the grid ended up with. Read off the tracks the browser
    // worked out rather than worked out again here: the grid sizes itself against
    // the space the shell leaves it, and counting what it settled on is the only
    // way to be certain of agreeing with it.
    useEffect(() => {
        const element = gridRef.current;
        if (!element || typeof ResizeObserver === "undefined") return;
        const measure = (): void => {
            const tracks = window.getComputedStyle(element).gridTemplateColumns;
            const count =
                tracks && tracks !== "none" ? tracks.split(" ").filter(Boolean).length : 0;
            setColumns((held) => (held === count ? held : count));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [visible.length]);

    /**
     * The width each card is actually drawn at.
     *
     * A stored width is what its reader asked for, and the widths in a row rarely
     * add up to the columns there are - so the cards are fitted to the row, inside
     * the sizes each one is legible at. Null until the grid has been measured, and
     * then the stylesheet's own widths are what is drawn.
     */
    const spans = useMemo(() => {
        if (columns <= 0) return null;
        return packOverviewSpans(
            visible.map((card) => {
                const sizes = cardSizes(card);
                return {
                    preferred: COLUMNS[drawnSize(card)],
                    min: COLUMNS[sizes[0] ?? "sm"],
                    max: COLUMNS[sizes[sizes.length - 1] ?? "xl"]
                };
            }),
            columns
        );
    }, [visible, columns]);

    /** Every card as the Customize panel lists it, in the grid's order. */
    const rows = cards.map((card): CustomizeRow =>
        card.app
            ? {
                  key: card.key,
                  label: card.kind.label,
                  description: card.kind.hint,
                  icon: Blocks,
                  sizes: OVERVIEW_WIDGET_SIZES,
                  size: card.app.size,
                  hidden: card.app.hidden
              }
            : {
                  key: card.key,
                  label: widgetLabel(t, card.key, overviewWidget(card.key).label),
                  description: widgetDescription(t, card.key, overviewWidget(card.key).description),
                  icon: overviewWidget(card.key).icon,
                  sizes: overviewWidget(card.key).sizes,
                  size: card.widget.size,
                  hidden: card.widget.hidden
              }
    );

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                        {greeting
                            ? hello
                                ? t("greeting", { period: hello, name: firstName(name) })
                                : t("welcomeBack", { name: firstName(name) })
                            : t("title")}
                    </h1>
                    <p className="mt-1 text-sm text-muted-foreground">{t("intro")}</p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={refresh}
                        title={t("refresh")}
                        aria-label={t("refresh")}
                        className="grid size-9 place-items-center rounded-md border border-border bg-surface text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <RefreshCw
                            className={cn(
                                "size-4",
                                (pending === null || pending.size > 0) && "animate-spin"
                            )}
                            aria-hidden="true"
                        />
                    </button>
                    <Button variant="outline" size="sm" onClick={() => setCustomizing(true)}>
                        <Settings2 className="size-4" aria-hidden="true" />
                        {t("customize.open")}
                    </Button>
                </div>
            </div>

            {failure ? (
                <p
                    role="alert"
                    className="rounded-md border border-danger-edge bg-danger-soft px-3 py-2 text-sm text-danger-ink"
                >
                    {failure}
                </p>
            ) : null}

            {visible.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border py-16 text-center">
                    <LayoutGrid className="size-6 text-muted-foreground" aria-hidden="true" />
                    <p className="text-sm text-muted-foreground">{t("allOff")}</p>
                    <Button variant="outline" size="sm" onClick={() => setCustomizing(true)}>
                        {t("chooseWhat")}
                    </Button>
                </div>
            ) : (
                <div ref={gridRef} className="overview-grid">
                    {visible.map((card, index) => {
                        const entry = card.app ? null : overviewWidget(card.key);
                        const label = card.app
                            ? card.kind.label
                            : widgetLabel(t, card.key, entry!.label);
                        const size = drawnSize(card);
                        const grip = (
                            <WidgetGrip
                                label={label}
                                onStart={() => setDragged(card.key)}
                                onEnd={() => {
                                    setDragged(null);
                                    setOver(null);
                                }}
                            />
                        );
                        const menu = (
                            <WidgetMenu
                                label={label}
                                sizes={cardSizes(card)}
                                size={size}
                                first={index === 0}
                                last={index === visible.length - 1}
                                onMove={(direction) => move(card.key, direction)}
                                onResize={(next) => resize(card.key, next)}
                                onHide={() => toggle(card.key, false)}
                                onConfigure={
                                    card.app ? () => live.configure(card.app, card.kind) : undefined
                                }
                                onRemove={card.app ? () => appState.remove(card.app.id) : undefined}
                                onClear={
                                    card.key === "recent"
                                        ? () => {
                                              clearRecentPlaces();
                                              setHistoryNonce((value) => value + 1);
                                          }
                                        : undefined
                                }
                            />
                        );
                        return (
                            <div
                                key={card.key}
                                data-widget={card.key}
                                style={spans ? { gridColumn: `span ${spans[index]}` } : undefined}
                                className={cn(
                                    "min-w-0 rounded-lg transition-opacity",
                                    SPAN[size],
                                    dragged === card.key && "opacity-40",
                                    over === card.key &&
                                        dragged !== card.key &&
                                        "ring-2 ring-primary"
                                )}
                                onDragOver={(event) => {
                                    if (!dragged) return;
                                    // Without this the drop never happens: the
                                    // default for a dragover is "not a target".
                                    event.preventDefault();
                                    event.dataTransfer.dropEffect = "move";
                                    setOver(card.key);
                                }}
                                onDragLeave={() =>
                                    setOver((held) => (held === card.key ? null : held))
                                }
                                onDrop={(event) => {
                                    event.preventDefault();
                                    if (dragged) moveOnto(dragged, card.key);
                                    setDragged(null);
                                    setOver(null);
                                }}
                            >
                                {card.app ? (
                                    <AppWidgetItem
                                        card={card.app}
                                        kind={card.kind}
                                        live={live}
                                        grip={grip}
                                        menu={menu}
                                    />
                                ) : (
                                    <WidgetCard
                                        title={label}
                                        icon={entry!.icon}
                                        href={entry!.href}
                                        grip={grip}
                                        menu={menu}
                                    >
                                        <WidgetBody
                                            id={card.key}
                                            data={
                                                pending === null || pending.has(card.key)
                                                    ? undefined
                                                    : data
                                            }
                                            apps={apps}
                                            shortcuts={shortcuts}
                                            historyNonce={historyNonce}
                                            onAdd={() => setPicking(true)}
                                            onRemove={unpin}
                                        />
                                    </WidgetCard>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
            {live.setupDialog}

            <CustomizeDialog
                open={customizing}
                onOpenChange={setCustomizing}
                layout={rows}
                greeting={greeting}
                onMove={move}
                onMoveOnto={moveOnto}
                onToggle={toggle}
                onResize={resize}
                onGreetingChange={(value) => persist({ ...current(), greeting: value })}
                onReset={reset}
                extra={<AppWidgetCatalog kinds={appKinds} state={appState} />}
            />
            <ShortcutPicker
                open={picking}
                onOpenChange={setPicking}
                isAdmin={isAdmin}
                appIds={apps.map((app) => app.id)}
                gate={gate}
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
            return (
                <ServicesWidget data={data === undefined ? undefined : (data.services ?? null)} />
            );
        case "usage":
            return <UsageWidget data={data === undefined ? undefined : (data.usage ?? null)} />;
        case "alarms":
            return <AlarmsWidget data={data === undefined ? undefined : (data.alarms ?? null)} />;
        case "storage":
            return <StorageWidget data={data === undefined ? undefined : (data.storage ?? null)} />;
        case "tasks":
            return <TasksWidget data={data === undefined ? undefined : (data.tasks ?? null)} />;
        case "sessions":
            return (
                <SessionsWidget data={data === undefined ? undefined : (data.sessions ?? null)} />
            );
        case "activity":
            return (
                <ActivityWidget data={data === undefined ? undefined : (data.activity ?? null)} />
            );
        case "games":
            return <GamesWidget data={data === undefined ? undefined : (data.games ?? null)} />;
        case "calendar":
            return (
                <CalendarWidget data={data === undefined ? undefined : (data.calendar ?? null)} />
            );
        case "dnsBlocker":
            return (
                <DnsBlockerWidget
                    data={data === undefined ? undefined : (data.dnsBlocker ?? null)}
                />
            );
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
function WidgetGrip({
    label,
    onStart,
    onEnd
}: {
    label: string;
    onStart: () => void;
    onEnd: () => void;
}) {
    const t = useTranslations("home");
    return (
        <span
            draggable
            title={t("card.drag", { name: label })}
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
    onClear,
    onConfigure,
    onRemove
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
    /** An app's card: choosing what it watches. */
    onConfigure?: () => void;
    /** An app's card: taking it off the Overview, with what it watches. */
    onRemove?: () => void;
}) {
    const t = useTranslations("home");
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    title={t("card.arrange", { name: label })}
                    aria-label={t("card.arrange", { name: label })}
                    className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <MoreVertical className="size-4" aria-hidden="true" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
                {onConfigure ? (
                    <>
                        <DropdownMenuItem onSelect={onConfigure}>
                            <Settings2 className="size-4" aria-hidden="true" />
                            {t("appCards.change")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                    </>
                ) : null}
                <DropdownMenuItem disabled={first} onSelect={() => onMove(-1)}>
                    <ArrowUp className="size-4" aria-hidden="true" />
                    {t("card.moveUp")}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={last} onSelect={() => onMove(1)}>
                    <ArrowDown className="size-4" aria-hidden="true" />
                    {t("card.moveDown")}
                </DropdownMenuItem>
                {sizes.length > 1 ? (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>{t("card.width")}</DropdownMenuLabel>
                        {sizes.map((option) => (
                            <DropdownMenuItem
                                key={option}
                                onSelect={() => onResize(option)}
                                className={cn(option === size && "text-primary")}
                            >
                                {sizeLabel(t, option)}
                            </DropdownMenuItem>
                        ))}
                    </>
                ) : null}
                <DropdownMenuSeparator />
                {onClear ? (
                    <DropdownMenuItem variant="danger" onSelect={onClear}>
                        <Trash2 className="size-4" aria-hidden="true" />
                        {t("card.clearHistory")}
                    </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem onSelect={onHide}>
                    <EyeOff className="size-4" aria-hidden="true" />
                    {t("card.hide")}
                </DropdownMenuItem>
                {onRemove ? (
                    <DropdownMenuItem variant="danger" onSelect={onRemove}>
                        <Trash2 className="size-4" aria-hidden="true" />
                        {t("appCards.remove")}
                    </DropdownMenuItem>
                ) : null}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
