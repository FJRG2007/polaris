"use client";

/**
 * Top-left application switcher. Polaris is a platform of apps (Drive today;
 * Docker, Kubernetes, servers, VMs, and home automation later), and this is how
 * you move between them - the same pattern as a network appliance console.
 * Locked apps stay visible but badged so the platform's scope is legible even in
 * the limited edition; clicking one routes to its unlock explainer.
 */

import { cn } from "../lib/cn";
import { Check, ChevronDown, Lock, type LucideIcon } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
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
}

export function AppSwitcher({
    apps,
    currentAppId,
    currentApp
}: {
    apps: readonly PolarisApp[];
    currentAppId: string;
    /** The active section when it is not one of the listed apps (personal
     *  account pages, for one), so the trigger names where the user actually is
     *  instead of falling back to the first app. */
    currentApp?: PolarisApp;
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
    return (
        <DropdownMenu>
            {/* On a phone the bar also carries the page's own controls, so the
                trigger keeps its glyph and drops the app name and the chevron. */}
            <DropdownMenuTrigger className="flex shrink-0 items-center gap-2 rounded-md px-1.5 py-1.5 text-sm font-medium transition-colors hover:bg-muted sm:px-2">
                <span className="grid size-6 shrink-0 place-items-center rounded bg-primary/15 text-primary">
                    <CurrentIcon className="size-4" />
                </span>
                <span className="sr-only sm:not-sr-only">{current.label}</span>
                <ChevronDown className="hidden size-4 text-muted-foreground sm:block" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[16rem]">
                <DropdownMenuLabel>Polaris apps</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {apps.map((app) => {
                    const Icon = app.icon;
                    const active = app.id === currentAppId;
                    return (
                        <DropdownMenuItem key={app.id} asChild disabled={app.locked}>
                            <a
                                href={app.href}
                                className={cn("w-full", app.locked && "opacity-60")}
                                aria-current={active ? "page" : undefined}
                            >
                                <Icon className="size-4 text-muted-foreground" />
                                <span className="flex-1">
                                    <span className="block">{app.label}</span>
                                    {app.description ? (
                                        <span className="block text-xs text-muted-foreground">
                                            {app.description}
                                        </span>
                                    ) : null}
                                </span>
                                {app.locked ? (
                                    <Lock className="size-3.5 text-muted-foreground" />
                                ) : active ? (
                                    <Check className="size-4 text-primary" />
                                ) : null}
                            </a>
                        </DropdownMenuItem>
                    );
                })}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
