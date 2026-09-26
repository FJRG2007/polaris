"use client";

/**
 * Top-left application switcher. Polaris is a platform of apps, and this is how
 * you move between them - drawn the way Google's launcher is: a grid of icons
 * with the name under each, and no description. A description under every app
 * made the list a page to read; an icon and a name is a thing to recognise.
 *
 * The top row is the apps somebody reaches for - pinned first, then recent or
 * suggested ones - and every other app follows it once. Which apps go where is
 * the caller's decision (it knows what was pinned and where the reader has
 * been); this only draws it, and offers the star that pins one.
 *
 * Locked apps stay visible but badged so the platform's scope is legible even in
 * the limited edition; clicking one routes to its unlock explainer.
 */

import { cn } from "../lib/cn";
import type { ElementType } from "react";
import { ChevronDown, Lock, Star, type LucideIcon } from "lucide-react";
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
}

export function AppSwitcher({
    apps,
    currentAppId,
    currentApp,
    linkAs: Anchor = "a",
    alert = false,
    featured,
    featuredLabel = "Favorites",
    pinned = [],
    onTogglePin
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
    /** The ids for the top row, in order. Absent, every app is drawn in one grid
     *  in the order given. */
    featured?: readonly string[];
    /** What the top row is called: "Favorites" once something is pinned, and
     *  whatever the caller fills it with until then. */
    featuredLabel?: string;
    /** The ids pinned to the top row, which is what the star says. */
    pinned?: readonly string[];
    /** Pin or unpin one app. Absent, no star is drawn. */
    onTogglePin?: (appId: string) => void;
}) {
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
    const pinnedIds = new Set(pinned);
    const byId = new Map(apps.map((app) => [app.id, app]));
    const top = (featured ?? []).flatMap((id) => byId.get(id) ?? []);
    const rest = apps.filter((app) => !top.includes(app));
    const sections = [
        { label: featuredLabel, apps: top },
        { label: top.length > 0 ? "More apps" : "Polaris apps", apps: rest }
    ].filter((section) => section.apps.length > 0);
    return (
        <DropdownMenu>
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
            <DropdownMenuContent
                align="start"
                className="max-h-[min(34rem,var(--radix-dropdown-menu-content-available-height))] w-[19.5rem] overflow-y-auto p-2"
            >
                {sections.map((section, index) => (
                    <div
                        key={section.label}
                        className={cn(index > 0 && "mt-2 border-t border-border pt-2")}
                    >
                        {sections.length > 1 ? (
                            <DropdownMenuLabel className="px-1 pb-1 pt-0.5 text-[0.6875rem] font-medium uppercase tracking-wider text-foreground-subtle">
                                {section.label}
                            </DropdownMenuLabel>
                        ) : null}
                        <div className="grid grid-cols-3 gap-1">
                            {section.apps.map((app) => (
                                <AppTile
                                    key={app.id}
                                    app={app}
                                    active={app.id === currentAppId}
                                    pinned={pinnedIds.has(app.id)}
                                    onTogglePin={onTogglePin}
                                    Anchor={Anchor}
                                />
                            ))}
                        </div>
                    </div>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/**
 * One app: the icon, the name under it, and what is waiting inside it.
 *
 * The star is a menu item of its own laid over the tile's corner rather than a
 * button inside the link, which a menu item cannot hold - so the arrow keys land
 * on it right after its app, and choosing it keeps the menu open. Shown on hover
 * or focus, and always on an app that is pinned, so what is pinned is never a
 * secret.
 */
function AppTile({
    app,
    active,
    pinned,
    onTogglePin,
    Anchor
}: {
    app: PolarisApp;
    active: boolean;
    pinned: boolean;
    onTogglePin?: (appId: string) => void;
    Anchor: ElementType;
}) {
    const Icon = app.icon;
    const pinLabel = pinned
        ? `Remove ${app.label} from favorites`
        : `Add ${app.label} to favorites`;
    return (
        <div className="group/tile relative">
            <DropdownMenuItem asChild disabled={app.locked}>
                <Anchor
                    href={app.href}
                    aria-current={active ? "page" : undefined}
                    title={app.description ? `${app.label} - ${app.description}` : app.label}
                    className={cn(
                        "flex w-full flex-col items-center gap-1.5 rounded-lg px-1 pb-2 pt-3 text-center",
                        active && "bg-primary/10 focus:bg-primary/15",
                        app.locked && "opacity-60"
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
                            : "opacity-0 focus:opacity-100 group-hover/tile:opacity-100"
                    )}
                >
                    <Star className={cn("!size-3.5", pinned && "fill-current")} />
                </DropdownMenuItem>
            ) : null}
        </div>
    );
}
