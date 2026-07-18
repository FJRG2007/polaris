"use client";

/**
 * Top-left application switcher. Polaris is a platform of apps (Drive today;
 * Docker, Kubernetes, servers, VMs, and home automation later), and this is how
 * you move between them - the same pattern as a network appliance console.
 * Locked apps stay visible but badged so the platform's scope is legible even in
 * the limited edition; clicking one routes to its unlock explainer.
 */

import { Check, ChevronDown, Lock, type LucideIcon } from "lucide-react";
import { cn } from "../lib/cn.js";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from "../components/dropdown-menu.js";

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
    currentAppId
}: {
    apps: readonly PolarisApp[];
    currentAppId: string;
}) {
    const current = apps.find((app) => app.id === currentAppId) ?? apps[0];
    if (!current) return null;
    const CurrentIcon = current.icon;
    return (
        <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="grid size-6 place-items-center rounded bg-primary/15 text-primary">
                    <CurrentIcon className="size-4" />
                </span>
                <span>{current.label}</span>
                <ChevronDown className="size-4 text-muted-foreground" />
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
