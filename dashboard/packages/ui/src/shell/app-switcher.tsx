"use client";

/**
 * Top-left application switcher. Polaris is a platform of apps, and this is how
 * you move between them - drawn the way Google's launcher is: one grid of icons
 * with the name under each, no headings and no description. A description under
 * every app made the list a page to read; an icon and a name is a thing to
 * recognise, and one grid is one place to look.
 *
 * It has to stay that with thirty apps as much as with three, so it borrows what
 * the launchers built for many apps do:
 *
 * - The first screenful, then a More button that opens the rest in the same
 *   grid, as Google's does.
 * - A field at the top, as in Microsoft 365's launcher and Spotlight: typing
 *   narrows every app - shown or behind More - to the ones that match, ranked,
 *   and enter opens the first.
 * - The grid arranged by dragging, as in Google's launcher, or from the keyboard
 *   with Alt and an arrow. That is the whole of it: what somebody wants first,
 *   they drag first. There is no star - a second way to say "put this first"
 *   beside dragging it there was two controls for one wish.
 * - The arrow keys walk the grid as a grid: left and right along it, up and down
 *   a row; tab walks the tiles.
 *
 * Which order the apps come in is the caller's decision (it knows what was
 * arranged and used); this only draws it.
 *
 * Locked apps stay visible but badged so the platform's scope is legible even in
 * the limited edition; clicking one routes to its unlock explainer.
 *
 * The words it adds of its own come in through `strings`, in English unless the
 * caller translates them: this package draws, the app decides the language.
 */

import { cn } from "../lib/cn";
import { MenuSearch } from "../components/menu-search";
import { ChevronDown, Lock, type LucideIcon } from "lucide-react";
import { searchItems, type SearchField } from "@polaris/core/search-text";
import {
    useLayoutEffect,
    useRef,
    useState,
    type DragEvent,
    type ElementType,
    type KeyboardEvent,
    type ReactNode
} from "react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "../components/dropdown-menu";

export interface PolarisApp {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    readonly icon: LucideIcon;
    readonly href: string;
    /** A locked app is shown but not yet available (future app or needs unlock). */
    readonly locked?: boolean;
    /** Something is waiting inside this app, written short enough for a pill -
     *  a count, or "9+". The switcher only draws it; what counts as waiting is
     *  the app's business. */
    readonly badge?: string;
    /** More words the search finds this app by - its name in another language,
     *  its category. Never drawn. */
    readonly keywords?: readonly string[];
}

/** The switcher's own words. Everything else it draws is the caller's data. */
export interface AppSwitcherStrings {
    /** The search field's placeholder and name. */
    readonly search: string;
    /** What the grid says when nothing matches. */
    readonly noMatch: (query: string) => string;
    /** Said to a screen reader after an app is moved with the keyboard. */
    readonly moved: (appLabel: string, position: number, total: number) => string;
    /** The button under the first screenful that opens the rest. */
    readonly more: string;
}

const ENGLISH: AppSwitcherStrings = {
    search: "Search apps",
    noMatch: (query) => `No app matches ${query}`,
    moved: (appLabel, position, total) => `${appLabel} moved to position ${position} of ${total}`,
    more: "More"
};

/** Tiles per row. The arrow keys move by it, so it is the grid's one number. */
const COLUMNS = 3;

/** How many apps are drawn before More: four rows, about what the menu shows on
 *  a laptop without scrolling. */
const FIRST_SCREEN = COLUMNS * 4;

/** What a search reads of an app: the name first, then the words the caller
 *  added, then the description - which only ever ranks, never fuzzes. */
const SEARCH_FIELDS: readonly SearchField<PolarisApp>[] = [
    { text: (app) => app.label, weight: 3 },
    { text: (app) => app.keywords, weight: 2 },
    { text: (app) => app.description }
];

/** A value made safe inside a double-quoted attribute selector. */
function quoted(value: string): string {
    return value.replace(/["\\]/g, "\\$&");
}

const TILE = "data-launcher-tile";
const MORE = "data-launcher-more";

export function AppSwitcher({
    apps,
    currentAppId,
    currentApp,
    linkAs: Anchor = "a",
    alert = false,
    order,
    onArrange,
    firstScreen = FIRST_SCREEN,
    open,
    onOpenChange,
    footer,
    below,
    strings = ENGLISH
}: {
    apps: readonly PolarisApp[];
    currentAppId: string;
    /** The active section when it is not one of the listed apps (personal
     *  account pages, for one), so the trigger names where the user actually is
     *  instead of falling back to the first app. */
    currentApp?: PolarisApp;
    /**
     * What draws a link here. A plain anchor by default, because this package
     * knows nothing about the router above it - and a plain anchor is a full
     * page load, which throws away everything the browser was holding.
     *
     * That is not a performance note. A call runs in the page: switching apps
     * with an anchor tore the whole tree down and hung up on whoever was on the
     * other end, so somebody could stay in a call as long as they stayed in
     * Chat and not one screen further. The app passes its router's link.
     */
    linkAs?: ElementType;
    /**
     * Whether anything in the menu is waiting, for a mark on the trigger itself.
     *
     * Passed rather than derived from the badges, because on a phone the trigger
     * is all there is: the label is hidden and the menu is shut, so a badge that
     * only exists inside it is a badge nobody sees until they go looking - which
     * is the state this was added to fix.
     */
    alert?: boolean;
    /** The ids of the grid, in order. Absent, every app is drawn in the order
     *  given. An app the order does not name is not drawn until searched. */
    order?: readonly string[];
    /** The grid's whole new order, after a drag or a keyboard move. Only called
     *  when the order actually changed. Absent, the grid cannot be arranged. */
    onArrange?: (ids: string[]) => void;
    /** How many apps are drawn before More. */
    firstScreen?: number;
    /** Open state, for a caller that opens the menu from somewhere else. */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** Options of the caller's own under the grid (menu items). */
    footer?: ReactNode;
    /** What the caller lists between the grid and the options - what each app
     *  has waiting, for one. Menu items, walked by the arrow keys like the rest;
     *  put away while a search narrows the grid, which is a question about apps. */
    below?: ReactNode;
    /** The switcher's own words, in the reader's language. English by default. */
    strings?: AppSwitcherStrings;
}) {
    const [query, setQuery] = useState("");
    const [ownOpen, setOwnOpen] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const [dragOrder, setDragOrder] = useState<string[] | null>(null);
    const [said, setSaid] = useState("");
    const dragging = useRef<string | null>(null);
    const dropped = useRef(false);
    const refocus = useRef<string | null>(null);
    const surface = useRef<HTMLDivElement>(null);
    const isOpen = open ?? ownOpen;

    // An app moved from the keyboard is a node React moved, and moving a node
    // drops its focus; put it back on the same app. The first app More reveals
    // takes the focus the same way.
    useLayoutEffect(() => {
        const id = refocus.current;
        if (!id) return;
        refocus.current = null;
        surface.current?.querySelector<HTMLElement>(`[${TILE}="${quoted(id)}"]`)?.focus();
    });

    const current = currentApp ?? apps.find((app) => app.id === currentAppId) ?? apps[0];
    if (!current) return null;
    const CurrentIcon = current.icon;
    // An account whose role opens no app has nothing to switch to. It still needs
    // to be told where it is, but a menu that opens onto an empty list is a
    // control that does nothing - so it becomes a plain label instead.
    if (apps.length === 0) {
        return (
            <span className="flex shrink-0 items-center gap-2 px-1.5 py-1.5 text-sm font-medium sm:px-2">
                <span className="grid size-6 shrink-0 place-items-center rounded bg-primary/15 text-primary">
                    <CurrentIcon className="size-4" />
                </span>
                <span className="sr-only sm:not-sr-only">{current.label}</span>
            </span>
        );
    }

    // A finger does not get the field focused: that raises the on-screen
    // keyboard over the grid it opened the menu to look at. Read on every render
    // so the menu opened from elsewhere (the rail's More apps) is held to it too.
    const focusSearch =
        typeof window === "undefined" || !window.matchMedia?.("(pointer: coarse)").matches;

    function setOpen(next: boolean) {
        if (!next) {
            setQuery("");
            setDragOrder(null);
            setExpanded(false);
            setSaid("");
        }
        setOwnOpen(next);
        onOpenChange?.(next);
    }

    const byId = new Map(apps.map((app) => [app.id, app]));
    const searching = query.trim().length > 0;
    const arrangeable = Boolean(onArrange) && !searching;
    // Only ids that name an app: an order kept from before an app went away
    // must not count towards the screenful or the positions said aloud.
    const ordered = (order ?? apps.map((app) => app.id)).filter((id) => byId.has(id));
    const full = dragOrder ?? ordered;
    const hidden = !searching && !expanded && full.length > firstScreen;
    const drawn: PolarisApp[] = searching
        ? searchItems(apps, query, SEARCH_FIELDS)
        : (hidden ? full.slice(0, firstScreen) : full).flatMap((id) => byId.get(id) ?? []);

    function arrange(ids: string[]) {
        if (!onArrange) return;
        if (ids.length === ordered.length && ids.every((id, at) => id === ordered[at])) return;
        onArrange(ids);
    }

    /** Move an app with the keyboard, keep it focused, and say where it went. */
    function nudge(id: string, by: number) {
        const ids = [...ordered];
        const from = ids.indexOf(id);
        const to = Math.max(0, Math.min(ids.length - 1, from + by));
        if (from < 0 || to === from) return;
        ids.splice(from, 1);
        ids.splice(to, 0, id);
        // Moved past the first screenful: open the rest so it stays in sight.
        if (to >= firstScreen) setExpanded(true);
        refocus.current = id;
        setSaid(strings.moved(byId.get(id)?.label ?? id, to + 1, ids.length));
        arrange(ids);
    }

    function showMore() {
        const first = full[firstScreen];
        setExpanded(true);
        if (first) refocus.current = first;
    }

    function onDragStart(event: DragEvent<HTMLElement>, id: string) {
        dragging.current = id;
        dropped.current = false;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-polaris-app", id);
        setDragOrder([...ordered]);
    }

    // The grid makes room as the tile passes over the others, the way Google's
    // does, so where it will land is what is on screen rather than a guess.
    function onDragOver(event: DragEvent<HTMLElement>, overId: string) {
        const id = dragging.current;
        if (!id || !dragOrder) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (id === overId) return;
        const ids = dragOrder.filter((other) => other !== id);
        ids.splice(dragOrder.indexOf(overId), 0, id);
        setDragOrder(ids);
    }

    function onDrop(event: DragEvent<HTMLElement>) {
        if (!dragging.current || !dragOrder) return;
        event.preventDefault();
        dropped.current = true;
        arrange(dragOrder);
    }

    // Escape, or a release outside the grid, puts everything back.
    function onDragEnd() {
        dragging.current = null;
        if (!dropped.current) setDragOrder(null);
        else window.setTimeout(() => setDragOrder(null), 0);
    }

    function onKeyDownCapture(event: KeyboardEvent<HTMLDivElement>) {
        const target = event.target as HTMLElement;
        const root = event.currentTarget;
        const isTile = target.hasAttribute(TILE);

        // More sits between the grid and the options under it: up goes back to
        // the last row, down on to the options.
        if (target.hasAttribute(MORE)) {
            const next =
                event.key === "ArrowUp"
                    ? gridStep(root, drawn, drawn[drawn.length - 1]?.id ?? "", "End")
                    : event.key === "ArrowDown"
                      ? firstBelowItem(root)
                      : undefined;
            if (next === undefined) return;
            event.preventDefault();
            event.stopPropagation();
            if (next instanceof HTMLElement) next.focus();
            return;
        }
        if (!isTile) return;

        // Tab walks every tile in reading order - a menu refuses tab otherwise.
        if (event.key === "Tab") {
            const stops = [
                ...root.querySelectorAll<HTMLElement>(`[${TILE}]:not([data-disabled])`)
            ].filter((stop) => stop === target || getComputedStyle(stop).display !== "none");
            const at = stops.indexOf(target);
            const next = stops[at + (event.shiftKey ? -1 : 1)];
            event.preventDefault();
            event.stopPropagation();
            if (next) next.focus();
            else if (event.shiftKey) root.querySelector<HTMLElement>("input")?.focus();
            else belowGrid(root)?.focus();
            return;
        }

        const id = target.getAttribute(TILE) ?? "";
        if (event.altKey && arrangeable) {
            const by =
                event.key === "ArrowLeft"
                    ? -1
                    : event.key === "ArrowRight"
                      ? 1
                      : event.key === "ArrowUp"
                        ? -COLUMNS
                        : event.key === "ArrowDown"
                          ? COLUMNS
                          : 0;
            if (by === 0) return;
            event.preventDefault();
            event.stopPropagation();
            nudge(id, by);
            return;
        }

        const next = gridStep(root, drawn, id, event.key);
        if (next === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        if (next === "search") root.querySelector<HTMLElement>("input")?.focus();
        else if (next === "below") belowGrid(root)?.focus();
        else next?.focus();
    }

    return (
        <DropdownMenu open={isOpen} onOpenChange={setOpen}>
            {/* On a phone the bar also carries the page's own controls, so the
                trigger keeps its glyph and drops the app name and the chevron. */}
            <DropdownMenuTrigger className="flex shrink-0 items-center gap-2 rounded-md px-1.5 py-1.5 text-sm font-medium transition-colors hover:bg-muted sm:px-2">
                <span className="relative grid size-6 shrink-0 place-items-center rounded bg-primary/15 text-primary">
                    <CurrentIcon className="size-4" />
                    {alert ? (
                        <span
                            aria-hidden="true"
                            className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary ring-2 ring-surface"
                        />
                    ) : null}
                </span>
                <span className="sr-only sm:not-sr-only">{current.label}</span>
                <ChevronDown className="hidden size-4 text-muted-foreground sm:block" />
            </DropdownMenuTrigger>
            {/* Height, width and scrolling come from the menu itself, which keeps
                inside what is left of the screen - see DropdownMenuContent. */}
            <DropdownMenuContent
                ref={surface}
                align="start"
                className="w-[19.5rem] p-2 pt-0"
                onKeyDownCapture={onKeyDownCapture}
            >
                {/* Stays at the top while the grid scrolls under it, so a long
                    list is never more than a word away from the app wanted. */}
                <div className="sticky top-0 z-10 -mx-2 bg-elevated px-2 pb-2 pt-2">
                    <MenuSearch
                        value={query}
                        onChange={setQuery}
                        placeholder={strings.search}
                        focusOnOpen={focusSearch}
                        className="px-1"
                    />
                </div>
                {searching && drawn.length === 0 ? (
                    <p className="px-2 py-6 text-center text-xs text-muted-foreground [overflow-wrap:anywhere]">
                        {strings.noMatch(query.trim())}
                    </p>
                ) : null}
                <div data-launcher-grid="" className="grid grid-cols-3 gap-1">
                    {drawn.map((app) => (
                        <AppTile
                            key={app.id}
                            app={app}
                            active={app.id === currentAppId}
                            Anchor={Anchor}
                            drag={
                                arrangeable
                                    ? {
                                          start: (event) => onDragStart(event, app.id),
                                          over: (event) => onDragOver(event, app.id),
                                          drop: onDrop,
                                          end: onDragEnd,
                                          lifted: dragOrder !== null && dragging.current === app.id
                                      }
                                    : undefined
                            }
                        />
                    ))}
                </div>
                {hidden ? (
                    <DropdownMenuItem
                        {...{ [MORE]: "" }}
                        onSelect={(event) => {
                            event.preventDefault();
                            showMore();
                        }}
                        className="mt-1 justify-center gap-1 text-xs font-medium text-muted-foreground"
                    >
                        {strings.more}
                        <ChevronDown className="!size-3.5" aria-hidden="true" />
                    </DropdownMenuItem>
                ) : null}
                {below && !searching ? <div data-launcher-below="">{below}</div> : null}
                {footer ? (
                    <div
                        data-launcher-footer=""
                        className="mt-2 flex flex-wrap items-center justify-end gap-1 border-t border-border pt-2"
                    >
                        {footer}
                    </div>
                ) : null}
                <div aria-live="polite" className="sr-only">
                    {said}
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** The first option under the grid that can take focus, if there is one. */
function firstFooterItem(root: HTMLElement) {
    return root.querySelector<HTMLElement>(
        "[data-launcher-footer] [role=menuitem]:not([data-disabled])"
    );
}

/** The first item of what the caller lists under the grid, else the first
 *  option. */
function firstBelowItem(root: HTMLElement) {
    return (
        root.querySelector<HTMLElement>(
            "[data-launcher-below] [role=menuitem]:not([data-disabled])"
        ) ?? firstFooterItem(root)
    );
}

/** What comes after the last row: More while there is more, else what is listed
 *  under the grid, else the options. */
function belowGrid(root: HTMLElement) {
    return root.querySelector<HTMLElement>(`[${MORE}]`) ?? firstBelowItem(root);
}

/**
 * Where an arrow key goes from one tile: along the grid for left and right, a
 * row for up and down, and to the ends for Home and End. Up from the top row
 * is the search field, and down from the last row is what is under the grid.
 * `null` is "nowhere further"; `undefined` is "not a key this answers".
 */
function gridStep(
    root: HTMLElement,
    drawn: readonly PolarisApp[],
    id: string,
    pressed: string
): HTMLElement | "search" | "below" | null | undefined {
    const reachable = (app: PolarisApp | undefined) => {
        const node = app ? root.querySelector<HTMLElement>(`[${TILE}="${quoted(app.id)}"]`) : null;
        return node && !node.hasAttribute("data-disabled") ? node : null;
    };
    const at = drawn.findIndex((app) => app.id === id);
    if (at < 0) return undefined;

    const walk = (from: number, by: number): HTMLElement | null => {
        for (let index = from + by; index >= 0 && index < drawn.length; index += by) {
            const node = reachable(drawn[index]);
            if (node) return node;
        }
        return null;
    };
    if (pressed === "ArrowLeft") return walk(at, -1);
    if (pressed === "ArrowRight") return walk(at, 1);
    if (pressed === "Home") return walk(-1, 1);
    if (pressed === "End") return walk(drawn.length, -1);
    if (pressed !== "ArrowUp" && pressed !== "ArrowDown") return undefined;

    const column = at % COLUMNS;
    const row = Math.floor(at / COLUMNS);
    const rows = Math.ceil(drawn.length / COLUMNS);
    const pick = (targetRow: number) => {
        const start = targetRow * COLUMNS;
        const end = Math.min(start + COLUMNS, drawn.length) - 1;
        return reachable(drawn[Math.min(start + column, end)]);
    };
    if (pressed === "ArrowDown") return row + 1 < rows ? pick(row + 1) : "below";
    return row > 0 ? pick(row - 1) : "search";
}

/**
 * One app: the icon, the name under it, and what is waiting inside it. Dragged
 * to arrange; a finger arranges from the menu's own option instead.
 */
function AppTile({
    app,
    active,
    Anchor,
    drag
}: {
    app: PolarisApp;
    active: boolean;
    Anchor: ElementType;
    drag?: {
        start: (event: DragEvent<HTMLElement>) => void;
        over: (event: DragEvent<HTMLElement>) => void;
        drop: (event: DragEvent<HTMLElement>) => void;
        end: () => void;
        lifted: boolean;
    };
}) {
    const Icon = app.icon;
    return (
        <div
            className={cn("group/tile relative min-w-0", drag?.lifted && "opacity-40")}
            onDragStart={drag?.start}
            onDragOver={drag?.over}
            onDrop={drag?.drop}
            onDragEnd={drag?.end}
            data-launcher-drag={drag ? "" : undefined}
        >
            <DropdownMenuItem asChild disabled={app.locked}>
                <Anchor
                    href={app.href}
                    draggable={drag ? true : false}
                    {...{ [TILE]: app.id }}
                    aria-current={active ? "page" : undefined}
                    aria-keyshortcuts={
                        drag ? "Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown" : undefined
                    }
                    title={app.description ? `${app.label} - ${app.description}` : app.label}
                    className={cn(
                        "flex w-full min-w-0 flex-col items-center gap-1.5 rounded-lg px-1 pb-1.5 pt-2.5 text-center",
                        active && "bg-primary/10 focus:bg-primary/15",
                        app.locked && "opacity-60",
                        drag && "cursor-grab active:cursor-grabbing"
                    )}
                >
                    <span className="relative grid size-10 shrink-0 place-items-center rounded-xl bg-primary/15 text-primary">
                        <Icon className="!size-5" />
                        {app.badge ? (
                            <span className="absolute -right-2 -top-1.5 min-w-4 rounded-full bg-primary px-1 text-center text-[0.625rem] font-medium leading-4 text-primary-foreground ring-2 ring-elevated">
                                {app.badge}
                            </span>
                        ) : null}
                        {app.locked ? (
                            <Lock className="absolute -bottom-1 -right-1 !size-3.5 rounded-full bg-elevated p-0.5 text-muted-foreground" />
                        ) : null}
                    </span>
                    <span
                        className={cn("w-full truncate text-xs leading-4", active && "font-medium")}
                    >
                        {app.label}
                    </span>
                </Anchor>
            </DropdownMenuItem>
        </div>
    );
}
