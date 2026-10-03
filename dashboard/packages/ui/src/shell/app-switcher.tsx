"use client";

/**
 * Top-left application switcher. Polaris is a platform of apps, and this is how
 * you move between them - drawn the way Google's launcher is: a grid of icons
 * with the name under each, and no description. A description under every app
 * made the list a page to read; an icon and a name is a thing to recognise.
 *
 * It has to stay that with thirty apps as much as with three, so it borrows what
 * the launchers built for many apps do:
 *
 * - A field at the top, as in Microsoft 365's launcher and Spotlight: typing
 *   narrows every app to the ones that match, ranked, and enter opens the first.
 * - Sections the caller decides - favorites, recent, then a shelf per category
 *   (Launchpad's folders, an app store's categories) - so a long list reads as
 *   several short ones.
 * - Favorites arranged by dragging, as in Google's launcher, or from the
 *   keyboard with Alt and an arrow.
 * - The arrow keys walk the grid as a grid: left and right along it, up and down
 *   a row, across the headings; tab reaches the star beside each app.
 *
 * Which apps go where is the caller's decision (it knows what was pinned and
 * where the reader has been); this only draws it.
 *
 * Locked apps stay visible but badged so the platform's scope is legible even in
 * the limited edition; clicking one routes to its unlock explainer.
 *
 * The words it adds of its own come in through `strings`, in English unless the
 * caller translates them: this package draws, the app decides the language.
 */

import { cn } from "../lib/cn";
import { MenuSearch } from "../components/menu-search";
import { ChevronDown, Lock, Star, type LucideIcon } from "lucide-react";
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
    DropdownMenuLabel,
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

/** One block of the grid, drawn under its heading when there is more than one. */
export interface AppSwitcherSection {
    readonly key: string;
    readonly label: string;
    readonly ids: readonly string[];
    /** Whether its apps can be dragged into a new order - the favorites. */
    readonly arrangeable?: boolean;
}

/** The switcher's own words. Everything else it draws is the caller's data. */
export interface AppSwitcherStrings {
    /** The search field's placeholder and name. */
    readonly search: string;
    /** What the grid says when nothing matches. */
    readonly noMatch: (query: string) => string;
    /** The star's name for an app not yet pinned, and for one that is. */
    readonly pin: (appLabel: string) => string;
    readonly unpin: (appLabel: string) => string;
    /** Said to a screen reader after a favorite is moved with the keyboard. */
    readonly moved: (appLabel: string, position: number, total: number) => string;
}

const ENGLISH: AppSwitcherStrings = {
    search: "Search apps",
    noMatch: (query) => `No app matches ${query}`,
    pin: (appLabel) => `Add ${appLabel} to favorites`,
    unpin: (appLabel) => `Remove ${appLabel} from favorites`,
    moved: (appLabel, position, total) => `${appLabel} moved to position ${position} of ${total}`
};

/** Tiles per row. The arrow keys move by it, so it is the grid's one number. */
const COLUMNS = 3;

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
const STAR = "data-launcher-star";

export function AppSwitcher({
    apps,
    currentAppId,
    currentApp,
    linkAs: Anchor = "a",
    alert = false,
    sections,
    pinned = [],
    onTogglePin,
    onArrange,
    open,
    onOpenChange,
    footer,
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
    /** The blocks of the grid, in order. Absent, every app is drawn in one grid
     *  in the order given. An app no section names is not drawn until searched. */
    sections?: readonly AppSwitcherSection[];
    /** The ids pinned to the favorites, which is what the star says. */
    pinned?: readonly string[];
    /** Pin or unpin one app. Absent, no star is drawn. */
    onTogglePin?: (appId: string) => void;
    /** The new order of an arrangeable section, after a drag or a keyboard move.
     *  Only called when the order actually changed. */
    onArrange?: (ids: string[]) => void;
    /** Open state, for a caller that opens the menu from somewhere else. */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** Options of the caller's own under the grid (menu items). */
    footer?: ReactNode;
    /** The switcher's own words, in the reader's language. English by default. */
    strings?: AppSwitcherStrings;
}) {
    const [query, setQuery] = useState("");
    const [ownOpen, setOwnOpen] = useState(false);
    const [dragOrder, setDragOrder] = useState<{ key: string; ids: string[] } | null>(null);
    const [said, setSaid] = useState("");
    const dragging = useRef<string | null>(null);
    const dropped = useRef(false);
    const refocus = useRef<string | null>(null);
    const surface = useRef<HTMLDivElement>(null);
    const isOpen = open ?? ownOpen;

    // A favorite moved from the keyboard is a node React moved, and moving a
    // node drops its focus; put it back on the same app.
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
            setSaid("");
        }
        setOwnOpen(next);
        onOpenChange?.(next);
    }

    const pinnedIds = new Set(pinned);
    const byId = new Map(apps.map((app) => [app.id, app]));
    const searching = query.trim().length > 0;
    const drawn: { key: string; label: string; apps: PolarisApp[]; arrangeable: boolean }[] =
        searching
            ? [
                  {
                      key: "results",
                      label: "",
                      apps: searchItems(apps, query, SEARCH_FIELDS),
                      arrangeable: false
                  }
              ]
            : (sections ?? [{ key: "all", label: "", ids: apps.map((app) => app.id) }])
                  .map((section) => {
                      const ids =
                          dragOrder && dragOrder.key === section.key ? dragOrder.ids : section.ids;
                      return {
                          key: section.key,
                          label: section.label,
                          apps: ids.flatMap((id) => byId.get(id) ?? []),
                          arrangeable: Boolean(section.arrangeable && onArrange)
                      };
                  })
                  .filter((section) => section.apps.length > 0);

    function arrange(key: string, ids: string[]) {
        const section = sections?.find((candidate) => candidate.key === key);
        if (!section || !onArrange) return;
        if (ids.length === section.ids.length && ids.every((id, at) => id === section.ids[at]))
            return;
        onArrange(ids);
    }

    /** Move a favorite with the keyboard, keep it focused, and say where it went. */
    function nudge(key: string, id: string, by: number) {
        const section = drawn.find((candidate) => candidate.key === key);
        if (!section) return;
        const ids = section.apps.map((app) => app.id);
        const from = ids.indexOf(id);
        const to = Math.max(0, Math.min(ids.length - 1, from + by));
        if (from < 0 || to === from) return;
        ids.splice(from, 1);
        ids.splice(to, 0, id);
        refocus.current = id;
        setSaid(strings.moved(byId.get(id)?.label ?? id, to + 1, ids.length));
        arrange(key, ids);
    }

    function onDragStart(event: DragEvent<HTMLElement>, key: string, id: string) {
        dragging.current = id;
        dropped.current = false;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-polaris-app", id);
        const section = drawn.find((candidate) => candidate.key === key);
        setDragOrder({ key, ids: section ? section.apps.map((app) => app.id) : [] });
    }

    // The grid makes room as the tile passes over the others, the way Google's
    // does, so where it will land is what is on screen rather than a guess.
    function onDragOver(event: DragEvent<HTMLElement>, key: string, overId: string) {
        const id = dragging.current;
        if (!id || !dragOrder || dragOrder.key !== key) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (id === overId) return;
        const ids = dragOrder.ids.filter((other) => other !== id);
        ids.splice(dragOrder.ids.indexOf(overId), 0, id);
        setDragOrder({ key, ids });
    }

    function onDrop(event: DragEvent<HTMLElement>, key: string) {
        if (!dragging.current || !dragOrder || dragOrder.key !== key) return;
        event.preventDefault();
        dropped.current = true;
        arrange(key, dragOrder.ids);
    }

    // Escape, or a release outside the favorites, puts everything back.
    function onDragEnd() {
        dragging.current = null;
        if (!dropped.current) setDragOrder(null);
        else window.setTimeout(() => setDragOrder(null), 0);
    }

    function onKeyDownCapture(event: KeyboardEvent<HTMLDivElement>) {
        const target = event.target as HTMLElement;
        const root = event.currentTarget;
        const isTile = target.hasAttribute(TILE);
        const isStar = target.hasAttribute(STAR);
        if (!isTile && !isStar) return;

        // Tab walks every tile and every star in reading order, which is the one
        // way a keyboard reaches the stars - a menu refuses tab otherwise.
        if (event.key === "Tab") {
            const stops = [
                ...root.querySelectorAll<HTMLElement>(`[${TILE}]:not([data-disabled]), [${STAR}]`)
            ].filter((stop) => stop === target || getComputedStyle(stop).display !== "none");
            const at = stops.indexOf(target);
            const next = stops[at + (event.shiftKey ? -1 : 1)];
            event.preventDefault();
            event.stopPropagation();
            if (next) next.focus();
            else if (event.shiftKey) root.querySelector<HTMLElement>("input")?.focus();
            else firstFooterItem(root)?.focus();
            return;
        }
        if (!isTile) return;

        const id = target.getAttribute(TILE) ?? "";
        const key = target.getAttribute("data-launcher-section") ?? "";
        const section = drawn.find((candidate) => candidate.key === key);
        if (!section) return;

        if (event.altKey && section.arrangeable) {
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
            nudge(key, id, by);
            return;
        }

        const next = gridStep(root, drawn, key, id, event.key);
        if (next === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        if (next === "search") root.querySelector<HTMLElement>("input")?.focus();
        else if (next === "footer") firstFooterItem(root)?.focus();
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
                {searching && drawn[0]?.apps.length === 0 ? (
                    <p className="px-2 py-6 text-center text-xs text-muted-foreground [overflow-wrap:anywhere]">
                        {strings.noMatch(query.trim())}
                    </p>
                ) : null}
                {drawn.map((section, index) => (
                    <div
                        key={section.key}
                        role="group"
                        aria-label={section.label || undefined}
                        className={cn(index > 0 && "mt-2 border-t border-border pt-2")}
                    >
                        {drawn.length > 1 && section.label ? (
                            <DropdownMenuLabel className="px-1 pb-1 pt-0.5 text-[0.6875rem] font-medium uppercase tracking-wider text-foreground-subtle">
                                {section.label}
                            </DropdownMenuLabel>
                        ) : null}
                        <div className="grid grid-cols-3 gap-1">
                            {section.apps.map((app) => (
                                <AppTile
                                    key={app.id}
                                    app={app}
                                    section={section.key}
                                    active={app.id === currentAppId}
                                    pinned={pinnedIds.has(app.id)}
                                    onTogglePin={onTogglePin}
                                    Anchor={Anchor}
                                    strings={strings}
                                    drag={
                                        section.arrangeable
                                            ? {
                                                  start: (event) =>
                                                      onDragStart(event, section.key, app.id),
                                                  over: (event) =>
                                                      onDragOver(event, section.key, app.id),
                                                  drop: (event) => onDrop(event, section.key),
                                                  end: onDragEnd,
                                                  lifted:
                                                      dragOrder !== null &&
                                                      dragging.current === app.id
                                              }
                                            : undefined
                                    }
                                />
                            ))}
                        </div>
                    </div>
                ))}
                {footer ? (
                    <div
                        data-launcher-footer=""
                        className="mt-2 flex flex-col gap-0.5 border-t border-border pt-2"
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

/**
 * Where an arrow key goes from one tile: along the grid for left and right,
 * a row for up and down - into the section above or below at the same column
 * when the row runs out - and to the ends for Home and End. Up from the top row
 * is the search field, and down from the last row is the footer. `null` is
 * "nowhere further"; `undefined` is "not a key this answers".
 */
function gridStep(
    root: HTMLElement,
    drawn: readonly { key: string; apps: readonly PolarisApp[] }[],
    key: string,
    id: string,
    pressed: string
): HTMLElement | "search" | "footer" | null | undefined {
    const find = (sectionKey: string, appId: string) =>
        root.querySelector<HTMLElement>(
            `[${TILE}="${quoted(appId)}"][data-launcher-section="${quoted(sectionKey)}"]`
        );
    const flat = drawn.flatMap((section) =>
        section.apps.map((app) => ({ section: section.key, id: app.id }))
    );
    const reachable = (entry: { section: string; id: string } | undefined) => {
        const node = entry ? find(entry.section, entry.id) : null;
        return node && !node.hasAttribute("data-disabled") ? node : null;
    };
    const at = flat.findIndex((entry) => entry.section === key && entry.id === id);
    if (at < 0) return undefined;

    const walk = (from: number, by: number): HTMLElement | null => {
        for (let index = from + by; index >= 0 && index < flat.length; index += by) {
            const node = reachable(flat[index]);
            if (node) return node;
        }
        return null;
    };
    if (pressed === "ArrowLeft") return walk(at, -1);
    if (pressed === "ArrowRight") return walk(at, 1);
    if (pressed === "Home") return walk(-1, 1);
    if (pressed === "End") return walk(flat.length, -1);
    if (pressed !== "ArrowUp" && pressed !== "ArrowDown") return undefined;

    const sectionAt = drawn.findIndex((section) => section.key === key);
    const section = drawn[sectionAt]!;
    const index = section.apps.findIndex((app) => app.id === id);
    const column = index % COLUMNS;
    const row = Math.floor(index / COLUMNS);
    const rows = Math.ceil(section.apps.length / COLUMNS);
    const pick = (target: (typeof drawn)[number], targetRow: number) => {
        const start = targetRow * COLUMNS;
        const end = Math.min(start + COLUMNS, target.apps.length) - 1;
        const app = target.apps[Math.min(start + column, end)];
        return app ? reachable({ section: target.key, id: app.id }) : null;
    };
    if (pressed === "ArrowDown") {
        if (row + 1 < rows) return pick(section, row + 1);
        const below = drawn[sectionAt + 1];
        return below ? pick(below, 0) : "footer";
    }
    if (row > 0) return pick(section, row - 1);
    const above = drawn[sectionAt - 1];
    return above ? pick(above, Math.ceil(above.apps.length / COLUMNS) - 1) : "search";
}

/**
 * One app: the icon, the name under it, and what is waiting inside it.
 *
 * The star is a menu item of its own laid over the tile's corner rather than a
 * button inside the link, which a menu item cannot hold - so tab lands on it
 * right after its app, and choosing it keeps the menu open. Shown on hover or
 * focus, and always on an app that is pinned, so what is pinned is never a
 * secret. Not drawn for a finger, which has no hover to reveal it with and
 * would only pin things by accident: favorites are arranged from the menu's own
 * option on a phone.
 */
function AppTile({
    app,
    section,
    active,
    pinned,
    onTogglePin,
    Anchor,
    strings,
    drag
}: {
    app: PolarisApp;
    section: string;
    active: boolean;
    pinned: boolean;
    onTogglePin?: (appId: string) => void;
    Anchor: ElementType;
    strings: AppSwitcherStrings;
    drag?: {
        start: (event: DragEvent<HTMLElement>) => void;
        over: (event: DragEvent<HTMLElement>) => void;
        drop: (event: DragEvent<HTMLElement>) => void;
        end: () => void;
        lifted: boolean;
    };
}) {
    const Icon = app.icon;
    const pinLabel = pinned ? strings.unpin(app.label) : strings.pin(app.label);
    return (
        <div
            className={cn("group/tile relative", drag?.lifted && "opacity-40")}
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
                    {...{ [TILE]: app.id, "data-launcher-section": section }}
                    aria-current={active ? "page" : undefined}
                    aria-keyshortcuts={
                        drag ? "Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown" : undefined
                    }
                    title={app.description ? `${app.label} - ${app.description}` : app.label}
                    className={cn(
                        "flex w-full flex-col items-center gap-1.5 rounded-lg px-1 pb-1.5 pt-2.5 text-center",
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
            {onTogglePin && !app.locked ? (
                <DropdownMenuItem
                    {...{ [STAR]: app.id }}
                    aria-label={pinLabel}
                    title={pinLabel}
                    onSelect={(event) => {
                        event.preventDefault();
                        onTogglePin(app.id);
                    }}
                    className={cn(
                        "absolute right-0.5 top-0.5 size-6 justify-center rounded-md p-0 text-foreground-subtle hover:text-foreground focus:text-foreground",
                        pinned
                            ? "text-primary opacity-100"
                            : "opacity-0 focus:opacity-100 group-hover/tile:opacity-100 [@media(hover:none)]:hidden"
                    )}
                >
                    <Star className={cn("!size-3.5", pinned && "fill-current")} />
                </DropdownMenuItem>
            ) : null}
        </div>
    );
}
